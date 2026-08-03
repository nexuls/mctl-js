/**
 * JavaManager — turn "this server needs Java" into "launch it with *this*
 * executable", installing a JDK if that is the only way.
 *
 * Core service — no UI, no argv, no provider imports. It receives a
 * {@link JavaRequirement} (produced by a `ServerProvider`) and never asks a
 * provider anything itself.
 *
 * **Selection rule** (plan.md § Java Manager). Among the LTS majors MCTL knows
 * how to fetch — 21, 17, 11, 8 — pick the **highest** that satisfies
 * `min..=max`. When the requirement has no `max`, the ceiling is the newest LTS
 * in {@link LTS_MAJORS} rather than infinity: *unbounded* means "upstream stated
 * no upper bound", not "verified on whatever JDK ships next year".
 *
 * **Preference for what is already here.** An installed JDK inside the range is
 * always chosen over downloading one, even if a higher LTS would also fit —
 * a 200 MB download to move from a working Java 17 to Java 21 is not something
 * MCTL should do behind the user's back. Only when *nothing* installed fits does
 * it fetch, and only when the caller allows it.
 */

import { log } from "../../lib/logger.ts";
import type { JavaPin } from "../../types/server.ts";
import {
	LTS_MAJORS,
	type JavaInstallation,
	type JavaRequirement,
	type JavaResolution,
} from "../../types/java.ts";
import { installTemurin, type InstallJavaOptions } from "./adoptium.ts";
import { detectJavaInstallations } from "./detect.ts";

const logger = log("java");

/**
 * Thrown when no Java can be resolved. Carries what was searched for so a
 * front-end can offer the right next step: install a JDK, or pin one manually.
 */
export class JavaNotResolvedError extends Error {
	constructor(
		readonly requirement: JavaRequirement | undefined,
		readonly installed: number[],
		message: string,
	) {
		super(message);
		this.name = "JavaNotResolvedError";
	}
}

/** Where MCTL may install a JDK to, and stage its archive in. */
export interface JavaPaths {
	/** `$ROOT/java` — managed JDKs, one directory per `<vendor>-<major>`. */
	javaDir: string;
	/** `$ROOT/downloads` — where the archive is fetched before extraction. */
	downloadsDir: string;
}

/** Options for {@link resolveJava}. */
export interface ResolveJavaOptions extends InstallJavaOptions {
	/**
	 * Allow downloading a JDK when nothing installed satisfies the requirement.
	 * Default `true`. A UI that wants to *ask first* passes `false`, gets a
	 * {@link JavaNotResolvedError}, and can then call {@link installJava} itself.
	 */
	autoInstall?: boolean;
}

/**
 * The effective upper bound for a requirement.
 *
 * When upstream declares a `max`, that is the answer. When it does not, the
 * ceiling is the **newest LTS MCTL knows** rather than infinity: *unbounded*
 * means "upstream stated no upper bound", not "verified on whatever JDK your
 * distro shipped this month", and Minecraft has repeatedly broken on
 * freshly-released non-LTS JVMs. A machine holding only a newer non-LTS JDK
 * therefore gets an LTS fetched for it rather than a server that mysteriously
 * fails to boot (plan.md § Java Manager, "Selection").
 *
 * The one exception: a requirement whose `min` is already above the newest LTS
 * (a brand-new Minecraft release) raises the ceiling to `min`, since capping
 * below the floor would leave no valid version at all.
 */
function effectiveMax(requirement: JavaRequirement): number {
	if (requirement.max !== undefined) return requirement.max;
	return Math.max(LTS_MAJORS[0], requirement.min);
}

/** True when `major` falls inside the effective window. */
function satisfies(major: number, requirement: JavaRequirement): boolean {
	return major >= requirement.min && major <= effectiveMax(requirement);
}

/**
 * The major MCTL would install for a requirement: the highest LTS inside the
 * window, or — when no LTS fits at all (e.g. `min: 16, max: 16`) — the
 * requirement's own `recommended`/`min`, which is by definition inside it.
 *
 * Exported because both the resolver and the "install what I need" CLI path ask
 * this same question.
 */
export function preferredMajor(requirement: JavaRequirement): number {
	// LTS_MAJORS is newest-first, so the first match is the highest that fits.
	const lts = LTS_MAJORS.find((major) => satisfies(major, requirement));
	if (lts !== undefined) return lts;
	const fallback = requirement.recommended ?? requirement.min;
	logger.info(
		{ requirement, fallback },
		"no LTS satisfies the requirement; falling back to its own bound",
	);
	return fallback;
}

/**
 * Choose which of the *already installed* JDKs to use, or `undefined` when none
 * fits.
 *
 * Pure policy over a list — no disk, no network — which is what makes the
 * selection rules testable without a machine that happens to have four JDKs on
 * it. {@link resolveJava} is the I/O shell around this.
 *
 * @param installed candidates, **newest major first** (as `detect` returns them).
 * @param pin the server's recorded `java`. A bare number is a *preference*: keep
 *   using the same JVM across launches, so a server does not silently change JVM
 *   because a newer JDK appeared on the machine. (An explicit `{ pinned }` is
 *   authoritative and is handled by the caller before this is reached.)
 */
export function chooseInstalled(
	installed: JavaInstallation[],
	requirement: JavaRequirement,
	pin?: JavaPin,
): JavaInstallation | undefined {
	const usable = installed.filter((i) => satisfies(i.major, requirement));
	const preferred =
		typeof pin === "number" ? usable.find((i) => i.major === pin) : undefined;
	return preferred ?? usable[0];
}

/**
 * Resolve which Java to launch a server with.
 *
 * @param requirement what upstream declared, or `null`/`undefined` when it
 *   declared nothing. With no requirement and no `pin`, this throws — MCTL never
 *   guesses a Java version (plan.md § Java Manager, "Fallback": ask, then pin).
 * @param pin the server's `mctl.json` `java` field. An explicit `{ pinned }`
 *   **always wins** and is never re-derived; a bare number is a previously
 *   resolved major and is treated as a strong preference, not a lock.
 * @param paths where a JDK may be installed to.
 * @throws {JavaNotResolvedError} when nothing satisfies the requirement and
 *   installing is disallowed or impossible.
 */
export async function resolveJava(
	requirement: JavaRequirement | null | undefined,
	pin: JavaPin | undefined,
	paths: JavaPaths,
	options: ResolveJavaOptions = {},
): Promise<JavaResolution> {
	const installed = await detectJavaInstallations(paths.javaDir);
	const majors = installed.map((i) => i.major);

	// 1. An explicit user pin is authoritative — it exists precisely because the
	//    automatic answer was wrong or unavailable.
	if (pin !== undefined && typeof pin === "object") {
		const match = installed.find((i) => i.major === pin.pinned);
		if (match)
			return {
				installation: match,
				requirement: requirement ?? undefined,
				pinned: true,
			};
		if (options.autoInstall === false) {
			throw new JavaNotResolvedError(
				requirement ?? undefined,
				majors,
				`Java ${pin.pinned} is pinned for this server but is not installed`,
			);
		}
		logger.info({ pinned: pin.pinned }, "pinned Java not installed; fetching");
		return {
			installation: await installJava(pin.pinned, paths, options),
			requirement: requirement ?? undefined,
			pinned: true,
		};
	}

	// 2. No requirement and no pin: this is the "ask the user" case, and it is a
	//    hard stop rather than a guess.
	if (!requirement) {
		throw new JavaNotResolvedError(
			undefined,
			majors,
			"no upstream source declares a Java version for this server; pin one explicitly",
		);
	}

	// 3. Prefer what is already installed (see `chooseInstalled` for the rules).
	const chosen = chooseInstalled(installed, requirement, pin);
	if (chosen) return { installation: chosen, requirement, pinned: false };

	// 4. Nothing fits — fetch the highest LTS that does.
	const target = preferredMajor(requirement);
	if (options.autoInstall === false) {
		throw new JavaNotResolvedError(
			requirement,
			majors,
			`no installed Java satisfies ${describe(requirement)}; Java ${target} would be installed`,
		);
	}
	logger.info({ requirement, target }, "no suitable Java installed; fetching");
	return {
		installation: await installJava(target, paths, options),
		requirement,
		pinned: false,
	};
}

/**
 * Install a specific Java major from Adoptium and return it. Thin wrapper over
 * {@link installTemurin} so callers depend on the manager, not the vendor
 * module — swapping or adding a vendor later touches one file.
 */
export async function installJava(
	major: number,
	paths: JavaPaths,
	options: InstallJavaOptions = {},
): Promise<JavaInstallation> {
	return installTemurin(major, paths.javaDir, paths.downloadsDir, options);
}

/** Every Java MCTL can see, newest major first. Used by `mctl java list`. */
export async function listJava(javaDir?: string): Promise<JavaInstallation[]> {
	return detectJavaInstallations(javaDir);
}

/** Human-readable form of a requirement, for error messages. */
export function describe(requirement: JavaRequirement): string {
	if (requirement.max === undefined) return `Java ${requirement.min}+`;
	if (requirement.max === requirement.min) return `Java ${requirement.min}`;
	return `Java ${requirement.min}–${requirement.max}`;
}
