/**
 * Tests for secret management, against a **real** `secrets.json` in a temp
 * config home — the file's mode is half the point, and a mocked filesystem
 * cannot check it.
 *
 * `lib/paths` resolves XDG on every call, so pointing `XDG_CONFIG_HOME` at a
 * temp directory is what keeps this out of the developer's real `~/.config`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { secretsFile } from "../../lib/paths.ts";
import {
	SecretError,
	listSecrets,
	secretKeyIssue,
	setSecret,
	unsetSecret,
} from "./secrets.ts";

let configHome: string;
let original: string | undefined;

beforeEach(async () => {
	original = process.env.XDG_CONFIG_HOME;
	configHome = await mkdtemp(join(tmpdir(), "mctl-secrets-"));
	process.env.XDG_CONFIG_HOME = configHome;
	await mkdir(dirname(secretsFile()), { recursive: true });
});

afterEach(async () => {
	if (original === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = original;
	delete process.env.MCTL_NGROK_TOKEN;
	await rm(configHome, { recursive: true, force: true });
});

describe("secretKeyIssue", () => {
	test("accepts the UPPER_SNAKE convention the prefix rule depends on", () => {
		expect(secretKeyIssue("CLOUDFLARE_TOKEN")).toBeUndefined();
		expect(secretKeyIssue("NGROK_TOKEN")).toBeUndefined();
	});

	test("rejects anything `scopedSecrets` would never match", () => {
		// A lower-case key would be stored happily and then never reach the agent
		// that needs it, which is the worst kind of working-looking failure.
		expect(secretKeyIssue("cloudflare_token")).toBeDefined();
		expect(secretKeyIssue("")).toBe("required");
		expect(secretKeyIssue("CLOUDFLARE TOKEN")).toBeDefined();
	});
});

describe("setSecret", () => {
	test("writes the file 0600 and keeps the other keys", async () => {
		await setSecret("CLOUDFLARE_TOKEN", "token-a");
		await setSecret("NGROK_TOKEN", "token-b");

		const stored = await Bun.file(secretsFile()).json();
		expect(stored).toEqual({
			CLOUDFLARE_TOKEN: "token-a",
			NGROK_TOKEN: "token-b",
		});
		expect((await stat(secretsFile())).mode & 0o777).toBe(0o600);
	});

	test("refuses a bad key and an empty value", async () => {
		expect(setSecret("nope", "x")).rejects.toBeInstanceOf(SecretError);
		expect(setSecret("NGROK_TOKEN", "   ")).rejects.toBeInstanceOf(SecretError);
	});

	test("does not persist an environment override into the file", async () => {
		// `loadSecrets` merges `MCTL_*` over the file. Writing that merged view back
		// would copy a value the user deliberately kept in their environment onto
		// disk — and leave it there after the variable is gone.
		await setSecret("CLOUDFLARE_TOKEN", "from-file");
		process.env.MCTL_NGROK_TOKEN = "from-env";
		await setSecret("PLAYIT_SECRET", "also-file");

		expect(await Bun.file(secretsFile()).json()).toEqual({
			CLOUDFLARE_TOKEN: "from-file",
			PLAYIT_SECRET: "also-file",
		});
	});

	test("reports an unreadable file rather than overwriting it", async () => {
		await writeFile(secretsFile(), "{not json", { mode: 0o600 });
		expect(setSecret("NGROK_TOKEN", "x")).rejects.toBeInstanceOf(SecretError);
	});
});

describe("unsetSecret", () => {
	test("removes a key and reports whether it was there", async () => {
		await setSecret("NGROK_TOKEN", "x");
		expect(await unsetSecret("NGROK_TOKEN")).toBe(true);
		expect(await unsetSecret("NGROK_TOKEN")).toBe(false);
		expect(await Bun.file(secretsFile()).json()).toEqual({});
	});
});

describe("listSecrets", () => {
	test("describes each secret without its value", async () => {
		await setSecret("NGROK_TOKEN", "abcdef");
		const [entry] = await listSecrets(["ngrok", "cloudflare"]);

		expect(entry?.key).toBe("NGROK_TOKEN");
		expect(entry?.provider).toBe("ngrok");
		expect(entry?.length).toBe(6);
		expect(entry?.fromEnv).toBe(false);
		// The value must not be reachable from what a front-end is handed.
		expect(JSON.stringify(entry)).not.toContain("abcdef");
	});

	test("marks a key that comes from the environment", async () => {
		process.env.MCTL_NGROK_TOKEN = "from-env";
		const [entry] = await listSecrets(["ngrok"]);
		expect(entry?.fromEnv).toBe(true);
	});

	test("leaves a key nothing claims unattributed", async () => {
		// A `CLOUDFARE_TOKEN` typo would otherwise look set and working.
		await setSecret("CLOUDFARE_TOKEN", "typo");
		const [entry] = await listSecrets(["cloudflare", "ngrok"]);
		expect(entry?.provider).toBeUndefined();
	});
});
