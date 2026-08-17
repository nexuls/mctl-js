/**
 * `mctl secret` — set, list and remove the credentials MCTL's networking runs
 * on: a Cloudflare API token for DNS, a tunnel token for a pre-defined
 * `cloudflared` tunnel, an ngrok authtoken, a playit agent secret.
 *
 * Thin CLI bridge to `core/config/secrets.ts` (AGENTS.md § 3), and the keyboard
 * peer of the Settings page's Secrets group.
 *
 * **A value is never printed.** `list` shows the keys, who claims them and how
 * long they are, and nothing else — the whole point of `secrets.json` being
 * `0600` is undone by a command that echoes a token into a scrollback buffer.
 * For the same reason `set` reads the value from **stdin** by default rather
 * than from argv, which is world-readable in `/proc` and lands in shell history.
 */

import {
	KNOWN_SECRETS,
	SecretError,
	listSecrets,
	setSecret,
	unsetSecret,
} from "../../core/config/secrets.ts";
import { secretsFile } from "../../lib/paths.ts";
import { createProviderRegistry } from "../../providers/index.ts";
import { ArgError, parseArgs, stringFlag } from "../args.ts";
import { reportError } from "../context.ts";
import { renderTable, toJson, wantsJson } from "../format.ts";

const HELP = `mctl secret — credentials for tunnels and DNS

Usage:
  mctl secret [list] [--json]     which secrets are set (never their values)
  mctl secret set <KEY>           read the value from stdin (recommended)
  mctl secret set <KEY> --value … read it from the command line
  mctl secret unset <KEY>         remove one

Keys MCTL looks for:
${KNOWN_SECRETS.map((secret) => `  ${secret.key.padEnd(20)} ${secret.purpose}`).join("\n")}

A provider is handed only the keys prefixed with its own id, so NGROK_* never
reaches cloudflared. Any MCTL_<KEY> environment variable overrides the file.

Values are written to ${secretsFile()} with mode 0600 and are never logged,
printed, or placed in an event payload.`;

/**
 * Run `mctl secret`.
 * @param argv arguments after `secret`.
 */
export async function runSecret(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(HELP);
		return 0;
	}

	const [subcommand, ...rest] = argv;
	try {
		if (
			subcommand === undefined ||
			subcommand === "list" ||
			subcommand === "--json"
		) {
			return await list(subcommand === "list" ? rest : argv);
		}
		if (subcommand === "set") return await set(rest);
		if (subcommand === "unset" || subcommand === "rm") return await unset(rest);
		throw new ArgError(`unknown secret subcommand \`${subcommand}\``);
	} catch (err) {
		return reportError(err);
	}
}

/** Which secrets exist, described without their values. */
async function list(argv: string[]): Promise<number> {
	parseArgs(argv, { boolean: ["json"] });
	// The registry is built directly: it needs no config, so `mctl secret` works
	// on a machine that has not been through `mctl init` yet.
	// Network providers claim their own prefix; `cloudflare` is added for the DNS
	// client, which is core's rather than a provider's.
	const consumers = [...createProviderRegistry().networkIds(), "cloudflare"];
	const secrets = await listSecrets(consumers);

	if (wantsJson(argv)) {
		console.log(toJson(secrets));
		return 0;
	}
	if (secrets.length === 0) {
		console.log(
			`No secrets set. ${secretsFile()} holds them; add one with \`mctl secret set CLOUDFLARE_TOKEN\`.`,
		);
		return 0;
	}
	console.log(
		renderTable(
			["KEY", "USED BY", "LENGTH", "SOURCE"],
			secrets.map((secret) => [
				secret.key,
				secret.provider ?? "—",
				String(secret.length),
				secret.fromEnv ? "environment" : "secrets.json",
			]),
		),
	);
	return 0;
}

/**
 * Store one secret.
 *
 * stdin is the default source on purpose: a token on the command line is visible
 * in `/proc` to every user on the machine and is written to shell history.
 * `--value` exists for the scripted case, where the caller has already decided.
 */
async function set(argv: string[]): Promise<number> {
	const args = parseArgs(argv, { valued: ["value"], boolean: ["json"] });
	const key = args.positionals[0];
	if (key === undefined) throw new ArgError("secret set needs a key");

	const flag = stringFlag(args, "value");
	const value = flag ?? (await readStdin());
	if (value.trim() === "") {
		throw new ArgError(
			`no value given — pipe it in (\`echo -n <token> | mctl secret set ${key}\`) or pass --value`,
		);
	}

	await setSecret(key, value.trim());
	console.log(
		wantsJson(argv)
			? toJson({ key, set: true })
			: `${key} stored in ${secretsFile()} (0600)`,
	);
	return 0;
}

/** Remove one secret. */
async function unset(argv: string[]): Promise<number> {
	const args = parseArgs(argv, { boolean: ["json"] });
	const key = args.positionals[0];
	if (key === undefined) throw new ArgError("secret unset needs a key");

	const removed = await unsetSecret(key);
	console.log(
		wantsJson(argv)
			? toJson({ key, removed })
			: removed
				? `${key} removed`
				: `${key} was not set`,
	);
	return 0;
}

/**
 * Read the whole of stdin.
 *
 * A trailing newline from `echo` is stripped by the caller's `trim()` — a token
 * with a newline welded to it fails authentication in a way that is very hard to
 * see, which is exactly the kind of thing this command exists to prevent.
 *
 * @throws {SecretError} when stdin is a terminal: there is no prompt here (the
 *   TUI's Settings page is the interactive path), and blocking on a tty that
 *   nobody is piping into looks like a hang.
 */
async function readStdin(): Promise<string> {
	if (Bun.stdin.stream === undefined || process.stdin.isTTY) {
		throw new SecretError(
			"no value on stdin — pipe one in (`echo -n <token> | mctl secret set KEY`), pass --value, or use the Settings page's Secrets group",
		);
	}
	return await Bun.stdin.text();
}
