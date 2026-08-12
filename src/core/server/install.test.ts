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
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathExists } from "../../lib/fs.ts";
import type { InstallStrategy } from "../../types/install.ts";
import { executeInstall, InstallerFailedError } from "./install.ts";

/** A tiny jar-shaped payload; nothing here ever opens it as a zip. */
const INSTALLER_BYTES = "PK pretend installer";

const server = Bun.serve({
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/installer.jar") return new Response(INSTALLER_BYTES);
		if (url.pathname === "/server.jar") return new Response("a server jar");
		return new Response("not found", { status: 404 });
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
