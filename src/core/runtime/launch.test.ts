/**
 * Tests for the launch-command builder — the translation every runtime shares.
 *
 * Pure input/output, so no renderer, no filesystem and no spawning: the point of
 * extracting `launchCommand` was that the argv a server is started with could be
 * asserted directly rather than inferred from a running JVM.
 */

import { describe, expect, test } from "bun:test";
import { launchCommand, launchInputs } from "./launch.ts";

const JAVA = "/opt/java/bin/java";
const HEAP = ["-Xms2G", "-Xmx2G"];

describe("launchCommand", () => {
	test("a jar launch puts nogui after the jar, and the heap before it", () => {
		expect(
			launchCommand({ kind: "jar", jar: "server.jar" }, JAVA, HEAP),
		).toEqual({
			command: JAVA,
			args: ["-Xms2G", "-Xmx2G", "-jar", "server.jar", "nogui"],
		});
	});

	test("explicit empty program args suppress nogui (a proxy has no console)", () => {
		const { args } = launchCommand(
			{ kind: "jar", jar: "velocity.jar", args: [] },
			JAVA,
			HEAP,
		);
		expect(args).toEqual(["-Xms2G", "-Xmx2G", "-jar", "velocity.jar"]);
		expect(args).not.toContain("nogui");
	});

	test("an argFile launch prefixes each file with @, after the heap", () => {
		// The order is the contract: JVM flags, then the argfile that carries the
		// module path and main class, then the program's own arguments.
		expect(
			launchCommand(
				{ kind: "argFile", files: ["libraries/forge/unix_args.txt"] },
				JAVA,
				HEAP,
			),
		).toEqual({
			command: JAVA,
			args: ["-Xms2G", "-Xmx2G", "@libraries/forge/unix_args.txt", "nogui"],
		});
	});

	test("a script launch runs the script and passes no heap flags", () => {
		// Forge's run.sh builds its own java command line and reads the heap from
		// user_jvm_args.txt, so passing them here would silently do nothing.
		expect(
			launchCommand(
				{ kind: "script", path: "run.sh", jvmArgsFile: "user_jvm_args.txt" },
				JAVA,
				HEAP,
			),
		).toEqual({ command: "sh", args: ["run.sh", "nogui"] });
	});
});

describe("launchInputs", () => {
	test("names every file the launch depends on, resolved against the server dir", () => {
		expect(launchInputs({ kind: "jar", jar: "server.jar" }, "/srv/mc")).toEqual(
			["/srv/mc/server.jar"],
		);
		expect(
			launchInputs(
				{ kind: "argFile", files: ["a/args.txt", "b/args.txt"] },
				"/srv/mc",
			),
		).toEqual(["/srv/mc/a/args.txt", "/srv/mc/b/args.txt"]);
		expect(launchInputs({ kind: "script", path: "run.sh" }, "/srv/mc")).toEqual(
			["/srv/mc/run.sh"],
		);
	});
});
