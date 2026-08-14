/**
 * `mctl versions <kind>` — list the versions a server kind can install, the CLI
 * peer of the TUI's version picker.
 *
 * Thin bridge to core (AGENTS.md § 3): it resolves the kind through the same
 * registry and calls the same `core/server/versions.ts` functions the create
 * form's hook does, so "which versions exist" and "what counts as a snapshot"
 * have one answer across both front-ends rather than two that drift.
 *
 * Like the picker, it shows **releases only** unless asked otherwise — Mojang's
 * manifest alone is ~900 entries of which ~120 are releases.
 */

import {
	availableChannels,
	CHANNEL_LABELS,
	DEFAULT_CHANNELS,
	filterVersions,
	listMinecraftVersions,
	VERSION_CHANNELS,
	type VersionChannel,
} from "../../core/server/versions.ts";
import { ArgError, parseArgs } from "../args.ts";
import { cliContext, reportError } from "../context.ts";
import { renderTable, toJson, wantsJson } from "../format.ts";

const HELP = `mctl versions — list the versions a server kind can install

Usage:
  mctl versions <kind> [--channel <name>]... [--all] [--json]

Flags:
  --channel <name>  also show this channel (release|snapshot|beta|alpha|other);
                    repeatable. Default: releases only.
  --all             show every channel
  --json            machine-readable output (the raw view models)
  -h, --help        show this help

Kinds are the server providers this build ships; run \`mctl versions\` with no
kind to list them.`;

/**
 * Run `mctl versions`.
 * @param argv arguments after `versions`.
 * @returns process exit code.
 */
export async function runVersions(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(HELP);
		return 0;
	}

	try {
		const args = parseArgs(argv, {
			valued: ["channel"],
			boolean: ["all", "json"],
			aliases: { c: "channel" },
		});
		const context = await cliContext();
		const kind = args.positionals[0];

		// No kind is not an error: the useful answer is what kinds exist, which is
		// exactly what someone who typed the command without one is looking for.
		if (kind === undefined) {
			const kinds = context.providers.servers();
			console.log(
				wantsJson(argv)
					? toJson(
							kinds.map((p) => ({
								id: p.id,
								displayName: p.displayName,
								description: p.description,
							})),
						)
					: renderTable(
							["KIND", "NAME", "DESCRIPTION"],
							kinds.map((p) => [p.id, p.displayName, p.description]),
						),
			);
			return 0;
		}

		const all = await listMinecraftVersions(context.providers, kind);
		const channels = args.flags.get("all")
			? availableChannels(all)
			: resolveChannels(argv);
		const versions = filterVersions(all, channels);

		if (wantsJson(argv)) {
			console.log(toJson(versions));
			return 0;
		}
		console.log(
			renderTable(
				["VERSION", "CHANNEL", "PUBLISHED"],
				versions.map((v) => [
					v.id,
					v.type,
					v.releaseTime?.slice(0, 10) ?? "unknown",
				]),
			),
		);
		const hidden = all.length - versions.length;
		if (hidden > 0) {
			console.log(
				`\n${hidden} hidden — add --all, or --channel <name> for one of: ${availableChannels(
					all,
				)
					.filter((c) => !channels.includes(c))
					.join(", ")}`,
			);
		}
		return 0;
	} catch (err) {
		return reportError(err);
	}
}

/**
 * The channels to show: the defaults plus every `--channel` given.
 *
 * Read straight from `argv` rather than from the parsed flags because the flag
 * is **repeatable** and {@link parseArgs} keeps one value per name — a
 * deliberately small parser, and this is the only command that needs more.
 *
 * @throws {ArgError} on a channel name that is not one of the known ones, so a
 * typo prints a usage error instead of silently filtering everything away.
 */
function resolveChannels(argv: string[]): VersionChannel[] {
	const chosen = new Set<VersionChannel>(DEFAULT_CHANNELS);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		let value: string | undefined;
		if (arg === "--channel" || arg === "-c") value = argv[++i];
		else if (arg.startsWith("--channel=")) value = arg.slice(10);
		else continue;

		if (value === undefined) throw new ArgError("--channel needs a value");
		if (!isChannel(value)) {
			throw new ArgError(
				`unknown channel "${value}" (known: ${VERSION_CHANNELS.join(", ")})`,
			);
		}
		chosen.add(value);
	}
	return VERSION_CHANNELS.filter((c) => chosen.has(c));
}

/** Narrow a user-supplied string to a {@link VersionChannel}. */
function isChannel(value: string): value is VersionChannel {
	return value in CHANNEL_LABELS;
}
