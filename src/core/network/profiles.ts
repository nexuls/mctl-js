/**
 * Network profile CRUD — the write side of `config.network.profiles`, whose
 * read side is `NetworkManager.profiles()`.
 *
 * Core service, UI-free and argv-free. Both front-ends call it: the Settings
 * page's Network group and `mctl network profile`. Until this module existed a
 * profile could be *read* everywhere and *created* nowhere — the only way to add
 * a `cf-tunnel` was to hand-edit `config.json`, which is precisely the kind of
 * knowledge a tool is supposed to remove.
 *
 * **The transforms are pure and the write is one line on top of them.** A page
 * holding an edit buffer needs the "what would the config become" half without
 * touching disk (that is how the Settings draft stays buffered until Save),
 * while the CLI wants the whole read-modify-write in one call. Keeping them
 * separate is also what makes the rules testable without a `$HOME`.
 *
 * **Two names are protected, for different reasons.** `direct` is the floor
 * every failure lands on (`NetworkManager.#fallback`), and the profile named by
 * `network.defaultProfile` is what new servers are given — deleting either
 * leaves a config whose own invariants are broken. Everything else may go; a
 * *server* still naming a deleted profile is not an error, it degrades to
 * `direct` with a stated reason, which is the documented behaviour.
 */

import { writeConfig } from "../config/index.ts";
import {
	CloudflareDnsConfig,
	type Config,
	type NetworkProfile,
} from "../../types/config.ts";

/** The profile every fallback lands on; it may never be deleted. */
export const DIRECT_PROFILE = "direct";

/** Thrown when a profile edit is not valid. User-facing message. */
export class ProfileError extends Error {
	constructor(
		readonly profile: string | undefined,
		message: string,
	) {
		super(message);
		this.name = "ProfileError";
	}
}

/**
 * What a profile write may set. Every field is optional so a partial edit
 * (`--provider ngrok` alone) keeps the rest of the profile intact.
 */
export interface ProfileInput {
	/** Network provider id the profile selects. */
	provider?: string;
	/**
	 * Provider-specific options, **replacing** whatever was there. Replacement
	 * rather than merge because there is no way to express "remove this key" in a
	 * merge, and an option that cannot be removed is a profile that cannot be
	 * fixed without hand-editing the file.
	 */
	options?: Record<string, unknown>;
	/** Cloudflare DNS automation; `null` removes it. */
	dns?: unknown | null;
}

/**
 * Profile names double as the value stored in a server's `mctl.json`, so they
 * are restricted rather than free-form: lowercase letters, digits and hyphens,
 * starting with a letter or digit. The same shape as a server id, for the same
 * reason — it is typed on a command line.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Why `name` is not a usable profile name, or `undefined` when it is.
 *
 * Returns a message rather than throwing because the Settings form calls it on
 * every keystroke to decide whether Save is live.
 */
export function profileNameIssue(name: string): string | undefined {
	if (name.trim() === "") return "required";
	if (!NAME_RE.test(name)) {
		return "lowercase letters, digits and hyphens only";
	}
	return undefined;
}

/**
 * Validate a `dns` value against the schema, turning a Zod failure into a
 * one-line, user-facing message.
 *
 * The schema is the authority (AGENTS.md § "Zod at every boundary"); this only
 * decides how the failure is *reported*, since both front-ends want a sentence
 * rather than a Zod issue tree.
 */
function parseDns(value: unknown, profile: string): NetworkProfile["dns"] {
	const result = CloudflareDnsConfig.safeParse(value);
	if (result.success) return result.data;
	const first = result.error.issues[0];
	throw new ProfileError(
		profile,
		`invalid dns settings: ${first ? `${first.path.join(".") || "dns"} — ${first.message}` : "does not match the schema"}`,
	);
}

/**
 * The config that results from creating or updating `name`. Pure.
 *
 * @throws {ProfileError} for an invalid name, an empty provider, or DNS settings
 *   the schema rejects.
 */
export function withProfile(
	config: Config,
	name: string,
	input: ProfileInput,
): Config {
	const issue = profileNameIssue(name);
	if (issue)
		throw new ProfileError(name, `invalid profile name "${name}": ${issue}`);

	const current = config.network.profiles[name];
	const provider = (
		input.provider ??
		current?.provider ??
		DIRECT_PROFILE
	).trim();
	if (provider === "") {
		throw new ProfileError(name, "a profile must name a provider");
	}

	const next: NetworkProfile = {
		provider,
		// An empty option map is written as an absent key, so a profile that needs
		// no options keeps a clean, readable `config.json`.
		options:
			input.options !== undefined
				? Object.keys(input.options).length > 0
					? input.options
					: undefined
				: current?.options,
		dns:
			input.dns === undefined
				? current?.dns
				: input.dns === null
					? undefined
					: parseDns(input.dns, name),
	};

	return {
		...config,
		network: {
			...config.network,
			profiles: { ...config.network.profiles, [name]: next },
		},
	};
}

/**
 * The config that results from deleting `name`. Pure.
 *
 * @throws {ProfileError} when the profile does not exist, is `direct`, or is the
 *   configured default. Change the default first — the alternative is a config
 *   whose `defaultProfile` names nothing.
 */
export function withoutProfile(config: Config, name: string): Config {
	if (!config.network.profiles[name]) {
		throw new ProfileError(name, `no such network profile: ${name}`);
	}
	if (name === DIRECT_PROFILE) {
		throw new ProfileError(
			name,
			"the `direct` profile cannot be removed — it is the fallback every other profile degrades to",
		);
	}
	if (name === config.network.defaultProfile) {
		throw new ProfileError(
			name,
			`"${name}" is the default profile for new servers; make another profile the default first`,
		);
	}
	const profiles = { ...config.network.profiles };
	delete profiles[name];
	return { ...config, network: { ...config.network, profiles } };
}

/**
 * The config that results from making `name` the default for new servers. Pure.
 *
 * @throws {ProfileError} when no such profile is defined — a default naming a
 *   profile that does not exist is the one state the picker cannot recover from.
 */
export function withDefaultProfile(config: Config, name: string): Config {
	if (!config.network.profiles[name]) {
		throw new ProfileError(name, `no such network profile: ${name}`);
	}
	return { ...config, network: { ...config.network, defaultProfile: name } };
}

/**
 * Create or update a profile and write `config.json`.
 *
 * The config-directory watcher publishes `ConfigChanged` for the atomic rename
 * on its own, so every other instance re-reads without this having to announce
 * anything.
 *
 * @returns the config as written (Zod-validated, defaults filled).
 */
export async function saveProfile(
	config: Config,
	name: string,
	input: ProfileInput,
): Promise<Config> {
	return writeConfig(withProfile(config, name, input));
}

/** Delete a profile and write `config.json`. @see withoutProfile */
export async function deleteProfile(
	config: Config,
	name: string,
): Promise<Config> {
	return writeConfig(withoutProfile(config, name));
}

/** Make a profile the default for new servers and write `config.json`. */
export async function setDefaultProfile(
	config: Config,
	name: string,
): Promise<Config> {
	return writeConfig(withDefaultProfile(config, name));
}

/**
 * Parse provider options written as `key=value` pairs.
 *
 * Shared by both front-ends — `--option tunnel=mc` on the command line and the
 * Settings form's single Options field — so `timeoutSeconds=30` means the same
 * number in both. That is the "no domain logic in one front-end the other lacks"
 * rule applied to a format.
 *
 * Values are read as JSON when they parse as one (`true`, `30`, `["--x"]`) and
 * as a plain string otherwise, because every provider option is one of those
 * shapes and quoting `mc.example.com` on a command line to get a string would be
 * a trap. Pairs are separated by commas or newlines; a value may contain `=`
 * (only the first splits).
 *
 * @throws {ProfileError} for an entry with no `=`, which is always a typo.
 */
export function parseOptions(text: string): Record<string, unknown> {
	const options: Record<string, unknown> = {};
	for (const entry of text.split(/[,\n]/)) {
		const trimmed = entry.trim();
		if (trimmed === "") continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) {
			throw new ProfileError(
				undefined,
				`option "${trimmed}" is not a key=value pair`,
			);
		}
		const key = trimmed.slice(0, eq).trim();
		const raw = trimmed.slice(eq + 1).trim();
		options[key] = jsonOrString(raw);
	}
	return options;
}

/** `"true"` → `true`, `"30"` → `30`, `"mc.example.com"` → itself. */
function jsonOrString(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/**
 * Render an option map back as `key=value` pairs — the inverse of
 * {@link parseOptions}, so a profile can be loaded into a text field, left
 * untouched, and written back unchanged.
 */
export function formatOptions(
	options: Readonly<Record<string, unknown>> | undefined,
): string {
	if (!options) return "";
	return Object.entries(options)
		.map(([key, value]) => {
			// A string is printed bare so the common case reads as plain text; it is
			// re-parsed as a string because it is not valid JSON on its own. Anything
			// else round-trips through JSON.
			const rendered =
				typeof value === "string" && jsonOrString(value) === value
					? value
					: JSON.stringify(value);
			return `${key}=${rendered}`;
		})
		.join(", ");
}
