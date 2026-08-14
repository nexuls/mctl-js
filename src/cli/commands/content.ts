/**
 * `mctl content` — list a server's installed mods, plugins and datapacks, and
 * park or restore one. The CLI peer of the TUI's Content tab.
 *
 * Thin CLI bridge to core (AGENTS.md § 3): it calls the same
 * `core/server/content.ts` functions the tab's hook does, so "what is installed"
 * and "what disabling means" have one answer across both front-ends rather than
 * two that drift. A transient instance, like every other command: read disk,
 * act, print, exit.
 *
 * An item is addressed by its **filename**, because that is what the user sees
 * in `mods/` and what a shell completes; the display name from a manifest is
 * accepted too when it is unambiguous.
 */

import { loadConfig, resolveRootPaths } from "../../core/config/index.ts";
import { getServer } from "../../core/server/discover.ts";
import { loadServerProperties } from "../../core/server/properties.ts";
import {
	readServerContent,
	setContentEnabled,
	type ContentItem,
} from "../../core/server/content.ts";
import { renderTable, toJson, wantsJson } from "../format.ts";
import { reportConfigError } from "./list.ts";

const HELP = `mctl content — what is installed on a server

Usage:
  mctl content <id> [--json]
  mctl content enable <id> <file>
  mctl content disable <id> <file>

Disabling renames a jar to <name>.jar.disabled, which every loader ignores.
Nothing is deleted, and the change takes effect at the server's next start.
Datapacks are listed but cannot be switched here — a world records which are
enabled, so use the in-game /datapack command.

Flags:
  --json       machine-readable output (the raw view models)
  -h, --help   show this help`;

/** Resolve `<id>` to a server view model plus the world its datapacks live in. */
async function loadTarget(id: string) {
	const serversDir = resolveRootPaths(await loadConfig()).serversDir;
	const server = await getServer(id, serversDir);
	if (!server) return undefined;
	// `server.properties` may be absent (a server that has never booted); its
	// default level name is Minecraft's own.
	const properties = await loadServerProperties(server.path).catch(
		() => undefined,
	);
	return { server, levelName: properties?.levelName ?? "world" };
}

/**
 * Find the one item `needle` names: an exact filename, the filename without its
 * `.disabled` suffix, or a display name. Ambiguity is refused rather than
 * guessed — the operation renames a file in the user's server directory.
 */
function findItem(
	items: ContentItem[],
	needle: string,
): { item?: ContentItem; ambiguous?: ContentItem[] } {
	const lower = needle.toLowerCase();
	// An exact filename wins outright. Without this, a directory holding both
	// `x.jar` and a stale `x.jar.disabled` would make *either* name ambiguous —
	// and the exact one is precisely how a user disambiguates.
	const exact = items.filter((item) => item.file.toLowerCase() === lower);
	if (exact.length === 1) return { item: exact[0] };

	const matches = items.filter(
		(item) =>
			item.file.toLowerCase() === lower ||
			item.file.toLowerCase() === `${lower}.disabled` ||
			item.key.toLowerCase().endsWith(`:${lower}`) ||
			item.name.toLowerCase() === lower,
	);
	if (matches.length === 1) return { item: matches[0] };
	if (matches.length > 1) return { ambiguous: matches };
	return {};
}

/**
 * Run `mctl content`.
 * @param argv arguments after `content`.
 * @returns process exit code (2 for a usage or lookup failure).
 */
export async function runContent(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(HELP);
		return 0;
	}

	const positionals = argv.filter((arg) => !arg.startsWith("-"));
	const action =
		positionals[0] === "enable" || positionals[0] === "disable"
			? positionals[0]
			: undefined;
	const id = action ? positionals[1] : positionals[0];
	const file = action ? positionals[2] : undefined;

	if (id === undefined) {
		console.error(
			"mctl: content needs a server id. Run `mctl content --help`.",
		);
		return 2;
	}
	if (action && file === undefined) {
		console.error(
			`mctl: ${action} needs a filename. Run \`mctl content <id>\`.`,
		);
		return 2;
	}

	let target: Awaited<ReturnType<typeof loadTarget>>;
	try {
		target = await loadTarget(id);
	} catch (err) {
		return reportConfigError(err);
	}
	if (!target) {
		console.error(`mctl: no server with id \`${id}\`. Run \`mctl list\`.`);
		return 2;
	}

	const listing = await readServerContent(target.server, target.levelName);

	if (!action) {
		if (wantsJson(argv)) {
			console.log(toJson(listing));
			return 0;
		}
		for (const section of listing.sections) {
			const heading = section.id.toUpperCase();
			if (!section.present) {
				console.log(`${heading}: no ${section.directory} directory\n`);
				continue;
			}
			if (section.items.length === 0) {
				console.log(`${heading}: ${section.directory} is empty\n`);
				continue;
			}
			console.log(`${heading} (${section.directory})`);
			console.log(
				renderTable(
					["", "NAME", "VERSION", "FROM", "FILE"],
					section.items.map((item) => [
						item.enabled ? "on" : "off",
						item.name,
						item.version ?? "-",
						item.loader ?? "-",
						item.file,
					]),
				),
			);
			console.log("");
		}
		return 0;
	}

	const items = listing.sections.flatMap((section) => section.items);
	const { item, ambiguous } = findItem(items, file ?? "");
	if (ambiguous) {
		console.error(
			`mctl: \`${file}\` matches ${ambiguous.length} items: ${ambiguous
				.map((match) => match.file)
				.join(", ")}. Use an exact filename.`,
		);
		return 2;
	}
	if (!item) {
		console.error(
			`mctl: no installed item named \`${file}\` on ${id}. Run \`mctl content ${id}\`.`,
		);
		return 2;
	}

	const enabled = action === "enable";
	if (item.enabled === enabled) {
		console.log(`${item.file} is already ${enabled ? "enabled" : "disabled"}.`);
		return 0;
	}

	try {
		const renamed = await setContentEnabled(target.server, item, enabled);
		console.log(
			`${enabled ? "Enabled" : "Disabled"} ${item.name} (now ${renamed}).`,
		);
		// Stated every time, because the file on disk changes immediately and the
		// server's behaviour does not: loaders read their directory once at boot.
		console.log(
			target.server.state === "running"
				? `${id} is running — restart it for this to take effect.`
				: "It takes effect the next time this server starts.",
		);
		return 0;
	} catch (err) {
		console.error(`mctl: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}
