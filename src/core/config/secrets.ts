/**
 * Managing `secrets.json` — the credentials the network providers and the
 * Cloudflare DNS client run on.
 *
 * Core service, UI-free. It sits beside `core/config/index.ts` (which owns
 * loading and the atomic `0600` write) and adds the two operations a front-end
 * needs: set one key, remove one key. Until this existed a token could only be
 * put there by **hand-editing the file**, which is why a configured DNS block
 * published nothing and a pre-defined tunnel could not authenticate — the
 * feature was reachable only by someone who had read the source.
 *
 * **Nothing here ever returns, logs or prints a secret's value.** The one shape
 * a front-end may show is {@link SecretSummary}: which keys exist, which
 * provider each belongs to, and where it came from. A value that has never been
 * displayed cannot be shoulder-surfed out of a terminal, screenshared, or left
 * in a scrollback buffer.
 */

import { secretsFile } from "../../lib/paths.ts";
import type { Secrets } from "../../types/config.ts";
import { loadSecrets, writeSecrets } from "./index.ts";

/**
 * The credentials MCTL itself looks for, so both front-ends offer the same list
 * instead of each keeping its own copy. A key not in this table still works —
 * it is a plain `Record<string, string>` — this is what the UI *offers*.
 */
export const KNOWN_SECRETS: readonly KnownSecret[] = [
	{
		key: "CLOUDFLARE_TOKEN",
		label: "Cloudflare API token",
		purpose:
			"publishes a profile's DNS records; needs Zone:Read + DNS:Edit on the zone",
	},
	{
		key: "CLOUDFLARED_TOKEN",
		label: "Cloudflare tunnel token",
		purpose:
			"runs a pre-defined tunnel created in the Zero Trust dashboard, which has no local credentials file",
	},
	{
		key: "NGROK_TOKEN",
		label: "ngrok authtoken",
		purpose: "authenticates the ngrok agent",
	},
	{
		key: "PLAYIT_SECRET",
		label: "playit.gg agent secret",
		purpose: "runs the playit agent against your account",
	},
] as const;

/** One credential MCTL knows how to use. */
export interface KnownSecret {
	/** The `secrets.json` key. */
	key: string;
	/** Short human name for a form label. */
	label: string;
	/** What it is for — the sentence a user needs to decide whether to set it. */
	purpose: string;
}

/** Thrown when a secret cannot be set. User-facing message. */
export class SecretError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecretError";
	}
}

/**
 * Secret keys are UPPER_SNAKE by convention, and that convention is load-bearing
 * rather than cosmetic: `scopedSecrets` in `core/network/` hands a provider only
 * the keys prefixed with its own upper-cased id, so a lower-case key would
 * silently never reach the agent that needs it.
 */
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** Why `key` is not a usable secret name, or `undefined` when it is. */
export function secretKeyIssue(key: string): string | undefined {
	if (key.trim() === "") return "required";
	if (!KEY_RE.test(key)) return "UPPER_SNAKE_CASE, e.g. CLOUDFLARE_TOKEN";
	return undefined;
}

/** One secret, described without its value. */
export interface SecretSummary {
	/** The key, e.g. `CLOUDFLARE_TOKEN`. */
	key: string;
	/**
	 * What will be handed it, derived from the key's prefix — the same rule
	 * `scopedSecrets` applies. `undefined` for a key nothing claims, which is
	 * worth showing: a `CLOUDFARE_TOKEN` typo would otherwise look set.
	 */
	provider?: string;
	/** Length of the value, so a truncated paste is visible without showing it. */
	length: number;
	/**
	 * True when the value comes from a `MCTL_*` environment variable rather than
	 * the file. Env wins at load time, so a stale file value would otherwise look
	 * like the one in use.
	 */
	fromEnv: boolean;
}

/**
 * Every secret that would be visible to MCTL right now, values omitted.
 *
 * @param consumers ids used to attribute a key to whatever will read it, by the
 *   same upper-cased prefix rule `scopedSecrets` applies (`ngrok` claims
 *   `NGROK_*`). The caller passes the network provider ids plus `cloudflare` for
 *   the DNS client, so core/config needs to know about neither.
 */
export async function listSecrets(
	consumers: readonly string[] = [],
): Promise<SecretSummary[]> {
	const merged = await loadSecrets();
	return Object.entries(merged)
		.map(([key, value]) => ({
			key,
			provider: consumers.find((id) => key.startsWith(`${id.toUpperCase()}_`)),
			length: value.length,
			fromEnv: process.env[`MCTL_${key}`] === value,
		}))
		.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Set one secret and rewrite `secrets.json` (atomically, `0600`, mode verified
 * by `writeSecrets`).
 *
 * Reads the **file** rather than the merged view before writing: `loadSecrets`
 * folds in `MCTL_*` environment overrides, and persisting those would copy a
 * value the user deliberately kept in their environment into a file on disk.
 *
 * @throws {SecretError} for an unusable key or an empty value.
 */
export async function setSecret(key: string, value: string): Promise<void> {
	const issue = secretKeyIssue(key);
	if (issue) throw new SecretError(`invalid secret name "${key}": ${issue}`);
	if (value.trim() === "") {
		throw new SecretError(
			`refusing to store an empty ${key} — use \`mctl secret unset ${key}\` to remove it`,
		);
	}
	const stored = await storedSecrets();
	await writeSecrets({ ...stored, [key]: value });
}

/**
 * Remove one secret.
 *
 * @returns whether the key was actually there. An absent key is not an error —
 *   the caller asked for it to be gone, and it is.
 */
export async function unsetSecret(key: string): Promise<boolean> {
	const stored = await storedSecrets();
	if (!(key in stored)) return false;
	const next = { ...stored };
	delete next[key];
	await writeSecrets(next);
	return true;
}

/**
 * The secrets **as stored in the file**, without environment overrides.
 *
 * Read directly rather than through `loadSecrets` for the reason above; an
 * absent or unreadable file is an empty set, because the first `set` on a fresh
 * machine has nothing to merge with.
 */
async function storedSecrets(): Promise<Secrets> {
	const file = Bun.file(secretsFile());
	if (!(await file.exists())) return {};
	try {
		return (await file.json()) as Secrets;
	} catch {
		throw new SecretError(
			`${secretsFile()} is not valid JSON — fix or remove it before setting a secret`,
		);
	}
}
