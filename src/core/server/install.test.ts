/**
 * Tests for {@link executeInstall}, focused on the `installer` strategy — the
 * one that runs a *program* and then has to decide whether it worked.
 *
 * **No JVM and no network.** The "java" handed to the executor is a shell script
 * that writes whatever the test wants the installer to have produced. That is
 * enough because the executor's contract is exactly: spawn it in the install
 * directory, check the output, clean up, and report the launch spec. Downloads
 * are served by a local `Bun.serve`, so `file://`-style shortcuts are avoided and
 * the real fetch path is exercised.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathExists } from "../../lib/fs.ts";
import type { InstallStrategy } from "../../types/install.ts";
import { executeInstall, InstallerFailedError } from "./install.ts";

/** A tiny jar-shaped payload; nothing here ever opens it as a zip. */
const INSTALLER_BYTES = "PK pretend installer";

/** Bodies by path; `Range` is honoured so resume can be observed. */
const BODIES: Record<string, string> = {
	"/installer.jar": INSTALLER_BYTES,
	"/server.jar": "a server jar",
	"/other.jar": "a different jar",
};

/** Range headers the server was asked for, so a test can prove one was sent. */
const rangesSeen: string[] = [];

const server = Bun.serve({
	port: 0,
	fetch(request) {
		const body = BODIES[new URL(request.url).pathname];
		if (body === undefined) return new Response("not found", { status: 404 });
		const range = request.headers.get("range");
		if (!range) return new Response(body);
		rangesSeen.push(range);
		const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
		return new Response(body.slice(from), {
			status: 206,
			headers: {
				"content-range": `bytes ${from}-${body.length - 1}/${body.length}`,
			},
		});
	},
});
const base = `http://localhost:${server.port}`;

afterAll(() => server.stop(true));

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mctl-install-"));
});

/**
 * Write an executable stand-in for `java` that runs `script` instead.
 *
 * It is invoked as `java -jar <installer> <args…>` with the install directory as
 * its cwd, which is precisely what the real installers rely on — so a script
 * that creates files relative to `.` is a faithful stub.
 */
async function fakeJava(script: string): Promise<string> {
	const path = join(dir, "fake-java.sh");
	await Bun.write(path, `#!/bin/sh\n${script}\n`);
	await chmod(path, 0o755);
	return path;
}

describe("executeInstall — directJar / loaderJar", () => {
	test("downloads the artefact to its destination", async () => {
		const strategy: InstallStrategy = {
			kind: "loaderJar",
			url: `${base}/server.jar`,
			dest: "fabric-server-launch.jar",
		};
		const outcome = await executeInstall(strategy, dir);
		expect(await Bun.file(join(dir, "fabric-server-launch.jar")).text()).toBe(
			"a server jar",
		);
		// Nothing to record: the provider always knows how these launch.
		expect(outcome.launch).toBeUndefined();
	});
});

describe("executeInstall — resume", () => {
	test("continues a partial download instead of restarting it", async () => {
		// The scenario: a create failed after 6 of 12 bytes, its staging directory
		// was deleted, and the user runs the same create again.
		const resumeDir = join(dir, "partial");
		await mkdir(resumeDir, { recursive: true });
		const url = `${base}/server.jar`;
		const digest = createHash("sha256").update(url).digest("hex").slice(0, 16);
		await Bun.write(join(resumeDir, `.${digest}-server.jar.part`), "a serv");

		rangesSeen.length = 0;
		await executeInstall({ kind: "directJar", url, dest: "server.jar" }, dir, {
			resumeDir,
		});

		expect(rangesSeen).toEqual(["bytes=6-"]);
		expect(await Bun.file(join(dir, "server.jar")).text()).toBe("a server jar");
	});

	test("keys the partial file by URL, so two kinds' server.jar cannot collide", async () => {
		// Every kind installs something called `server.jar`. Keyed by destination
		// name alone, Purpur's install would resume from Paper's abandoned bytes and
		// fail its digest check for reasons nobody could diagnose.
		const resumeDir = join(dir, "partial2");
		await mkdir(resumeDir, { recursive: true });
		const other = `${base}/other.jar`;
		const otherDigest = createHash("sha256")
			.update(other)
			.digest("hex")
			.slice(0, 16);
		await Bun.write(
			join(resumeDir, `.${otherDigest}-server.jar.part`),
			"junk!!",
		);

		rangesSeen.length = 0;
		await executeInstall(
			{ kind: "directJar", url: `${base}/server.jar`, dest: "server.jar" },
			dir,
			{ resumeDir },
		);

		// It did not resume from the other artefact's partial…
		expect(rangesSeen).toEqual([]);
		expect(await Bun.file(join(dir, "server.jar")).text()).toBe("a server jar");
		// …and left that partial alone for its own install to continue.
		expect(
			await Bun.file(
				join(resumeDir, `.${otherDigest}-server.jar.part`),
			).exists(),
		).toBe(true);
	});
});

describe("executeInstall — installer", () => {
	const strategy = (
		overrides: Partial<Extract<InstallStrategy, { kind: "installer" }>> = {},
	): InstallStrategy => ({
		kind: "installer",
		url: `${base}/installer.jar`,
		dest: "forge-installer.jar",
		args: ["--installServer"],
		produces: { kind: "argFile", files: ["libraries/forge/unix_args.txt"] },
		cleanup: ["forge-installer.jar", "forge-installer.jar.log"],
		...overrides,
	});

	test("runs the installer and reports the launch spec it predicted", async () => {
		const javaPath = await fakeJava(
			"mkdir -p libraries/forge && echo '-jar shim.jar' > libraries/forge/unix_args.txt",
		);
		const outcome = await executeInstall(strategy(), dir, { javaPath });
		expect(outcome.launch).toEqual({
			kind: "argFile",
			files: ["libraries/forge/unix_args.txt"],
		});
	});

	test("deletes the installer jar and its log afterwards", async () => {
		const javaPath = await fakeJava(
			"mkdir -p libraries/forge && touch libraries/forge/unix_args.txt && touch forge-installer.jar.log",
		);
		await executeInstall(strategy(), dir, { javaPath });
		expect(await pathExists(join(dir, "forge-installer.jar"))).toBe(false);
		expect(await pathExists(join(dir, "forge-installer.jar.log"))).toBe(false);
	});

	test("passes the strategy's arguments through to the installer", async () => {
		// Quilt's install depends on `--install-dir=.`; a dropped argument would
		// bury the server one directory below its own mctl.json.
		const javaPath = await fakeJava('echo "$@" > args.txt && touch out.jar');
		await executeInstall(
			strategy({
				args: ["install", "server", "1.21.4", "--install-dir=."],
				produces: { kind: "jar", jar: "out.jar" },
			}),
			dir,
			{ javaPath },
		);
		expect((await Bun.file(join(dir, "args.txt")).text()).trim()).toBe(
			"-jar forge-installer.jar install server 1.21.4 --install-dir=.",
		);
	});

	test("falls back to the generated run.sh when the predicted argfile is absent", async () => {
		// The case this guards: upstream moves the argfile. The install is still
		// good, and run.sh is still a correct way to launch it.
		const javaPath = await fakeJava(
			"echo '#!/bin/sh' > run.sh && echo '# jvm args' > user_jvm_args.txt",
		);
		const outcome = await executeInstall(strategy(), dir, { javaPath });
		expect(outcome.launch).toEqual({
			kind: "script",
			path: "run.sh",
			jvmArgsFile: "user_jvm_args.txt",
		});
	});

	test("omits jvmArgsFile when the script does not read one", async () => {
		const javaPath = await fakeJava("echo '#!/bin/sh' > run.sh");
		const outcome = await executeInstall(strategy(), dir, { javaPath });
		expect(outcome.launch).toEqual({ kind: "script", path: "run.sh" });
	});

	test("fails when the installer produced nothing runnable", async () => {
		const javaPath = await fakeJava("true");
		await expect(executeInstall(strategy(), dir, { javaPath })).rejects.toThrow(
			InstallerFailedError,
		);
	});

	test("fails with the installer's own output when it exits non-zero", async () => {
		const javaPath = await fakeJava(
			"echo 'Downloading minecraft server failed, invalid checksum.' >&2; exit 1",
		);
		// A real failure mode, seen against Forge 1.21.4: the message is the only
		// thing that tells a user to simply try again, so it must survive.
		await expect(executeInstall(strategy(), dir, { javaPath })).rejects.toThrow(
			/invalid checksum/,
		);
	});

	test("refuses to run without a Java executable", async () => {
		await expect(executeInstall(strategy(), dir, {})).rejects.toThrow(
			/no Java executable/,
		);
	});
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true }).catch(() => {});
});
