/**
 * Writing `server.properties` — the counterpart to `properties.ts`, kept
 * separate because the two have opposite jobs: the reader coerces and
 * interprets, and a writer that did either would hand the user back a file they
 * did not type.
 *
 * Core service — no UI, no provider imports.
 *
 * **A deliberate deviation from AGENTS.md § 3**, which says MCTL owns exactly
 * one file inside a server directory (`mctl.json`). It is recorded in
 * `memory.md`. The mitigation is that this module is a *surgical* editor, not a
 * serializer:
 *
 *  - It rewrites **only the lines whose key changed**. Every comment, every
 *    blank line, every key MCTL has never heard of and the file's own ordering
 *    survive untouched — including the `#Minecraft server properties` header
 *    and the timestamp under it.
 *  - Keys the user did not touch are **not written at all**, even when MCTL
 *    knows a default for them. Materialising 64 defaults into a file that had
 *    twelve lines would be a rewrite wearing an edit's clothes, and it would
 *    pin values that Minecraft is otherwise free to change between versions.
 *  - New keys are appended at the end, where a subsequent read finds them and a
 *    human reading the file can see what MCTL added.
 *  - The write is atomic (temp file + rename), so a crash mid-write leaves the
 *    previous file intact rather than a truncated one. A truncated
 *    `server.properties` is a server that boots on defaults — including
 *    `level-name=world`, which is how worlds get "lost".
 *
 * The escaping is Java's `Properties.store` rules, so the result is
 * byte-comparable with what Minecraft itself writes on its next save — see
 * `escapePropertyValue`.
 */

import { join } from "node:path";
import { readTextIfExists, writeFileAtomic } from "../../lib/fs.ts";
import {
	SERVER_PROPERTIES_FILE,
	separatorIndex,
	unescapeValue,
} from "./properties.ts";

/**
 * Escape one value the way `java.util.Properties#store` does.
 *
 * Java escapes `=`, `:`, `#` and `!` wherever they appear (not only in keys),
 * escapes a *leading* space, and replaces anything outside printable ASCII with
 * `\uXXXX` — which is why a vanilla file reads `level-type=minecraft\:normal`
 * and a coloured MOTD reads `§6`. Matching it exactly matters because the
 * reader in `properties.ts` is written against Java's output; a value escaped
 * some other plausible way would round-trip differently.
 *
 * @param key true to escape *every* space rather than only a leading one, which
 *   is what Java does for keys (a space is a legal separator, so an unescaped
 *   one would split the key).
 */
export function escapeProperty(value: string, key = false): string {
	let out = "";
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i] as string;
		const code = ch.charCodeAt(0);
		if (ch === " ") {
			out += key || i === 0 ? "\\ " : " ";
		} else if (ch === "\\") out += "\\\\";
		else if (ch === "\t") out += "\\t";
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\f") out += "\\f";
		else if (ch === "=" || ch === ":" || ch === "#" || ch === "!") {
			out += `\\${ch}`;
		} else if (code < 0x20 || code > 0x7e) {
			out += `\\u${code.toString(16).padStart(4, "0")}`;
		} else out += ch;
	}
	return out;
}

/** One rewritten entry, in the `key=value` form Minecraft writes. */
function entryLine(key: string, value: string): string {
	return `${escapeProperty(key, true)}=${escapeProperty(value)}`;
}

/** The header a file gets when MCTL creates it from nothing. */
function header(eol: string): string {
	// Minecraft's own first two lines, so a file MCTL created looks like a file
	// Minecraft created — it will rewrite this header itself on its first save.
	return `#Minecraft server properties${eol}#${new Date().toUTCString()}${eol}`;
}

/**
 * Apply `changes` to the text of a `.properties` document, preserving
 * everything the changes do not touch.
 *
 * Pure, and exported for testing: the preservation guarantees above are the
 * whole point of this module, and they are only worth anything if they are
 * pinned down.
 *
 * A key that appears more than once — which the reader resolves as "last one
 * wins" — has **every** occurrence rewritten, so the file cannot end up
 * disagreeing with itself about a value the user just set. Nothing is deleted.
 *
 * @param text the current file contents, or `""` when it does not exist.
 * @param changes key → new value, already validated by the caller.
 */
export function applyPropertyEdits(
	text: string,
	changes: Readonly<Record<string, string>>,
): string {
	const keys = Object.keys(changes);
	if (keys.length === 0) return text;

	// Follow the file rather than imposing a convention: a `server.properties`
	// written on Windows is CRLF throughout, and mixing the two would show up as
	// stray `^M` in every editor the user opens it in afterwards.
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines =
		text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r\n|\r|\n/);

	const written = new Set<string>();
	const out: string[] = [];

	for (let i = 0; i < lines.length; i += 1) {
		const source = [lines[i] ?? ""];
		// A line ending in an *odd* number of backslashes continues onto the next;
		// the whole run is one logical entry and is replaced (or kept) as a unit.
		let logical = source[0] as string;
		while (/(^|[^\\])(\\\\)*\\$/.test(logical) && i + 1 < lines.length) {
			const next = lines[++i] ?? "";
			source.push(next);
			logical = logical.slice(0, -1) + next.replace(/^\s+/, "");
		}

		const trimmed = logical.trim();
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) {
			out.push(...source);
			continue;
		}

		const separator = separatorIndex(trimmed);
		const key = unescapeValue(
			separator === -1 ? trimmed : trimmed.slice(0, separator),
		).trim();

		const replacement = changes[key];
		if (replacement === undefined) {
			out.push(...source);
			continue;
		}
		out.push(entryLine(key, replacement));
		written.add(key);
	}

	// Keys the file did not already carry, in the order the caller listed them —
	// which is the catalogue's order, so an appended block reads sensibly.
	const appended = keys
		.filter((key) => !written.has(key))
		.map((key) => entryLine(key, changes[key] as string));

	// Always newline-terminated, whether or not the input was: Java's own writer
	// ends the file that way, and a last entry without a terminator is one stray
	// append away from being merged into the line after it.
	const prefix = text === "" ? header(eol) : "";
	return `${prefix}${[...out, ...appended].join(eol)}${eol}`;
}

/**
 * Write the given key changes into `<dir>/server.properties`, creating the file
 * if the server has never booted.
 *
 * Only the keys in `changes` are touched; see the module comment for what is
 * guaranteed to survive. The caller is responsible for validation
 * (`validateProperty` in `properties-catalogue.ts`) — this function writes what
 * it is given, because a writer that silently corrected values would be a second
 * interpretation of the file competing with the reader's.
 *
 * Changes take effect at the server's **next start**: Minecraft reads
 * `server.properties` once during boot and rewrites it from memory when it
 * saves, so editing the file under a running server is not only ineffective, it
 * is liable to be overwritten. The caller warns about that; this function does
 * not refuse, because a user staging tomorrow's settings on a running server is
 * a legitimate thing to do.
 *
 * @throws if the directory is not writable, or the rename fails.
 */
export async function writeServerProperties(
	dir: string,
	changes: Readonly<Record<string, string>>,
): Promise<void> {
	if (Object.keys(changes).length === 0) return;
	const path = join(dir, SERVER_PROPERTIES_FILE);
	const current = (await readTextIfExists(path)) ?? "";
	await writeFileAtomic(path, applyPropertyEdits(current, changes));
}
