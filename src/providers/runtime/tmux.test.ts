/**
 * Tests for the tmux runtime's pure helpers.
 *
 * The runtime itself is exercised end-to-end against a real tmux server (a
 * server is created, started, sent a console command from a second process, and
 * stopped), which is not something a unit test can stand in for. What *is* worth
 * pinning here is the string handling, because both halves of it have already
 * been wrong once: a launch line is handed to `/bin/sh`, and a session name is
 * handed to tmux's target parser.
 */

import { describe, expect, test } from "bun:test";
import { sessionName, shellQuote } from "./tmux.ts";

describe("shellQuote", () => {
	test("quotes a plain word", () => {
		expect(shellQuote("java")).toBe("'java'");
	});

	test("protects a path containing spaces", () => {
		// Unquoted, `/srv/My Servers/x` becomes two arguments and the JVM is pointed
		// at a path that does not exist.
		expect(shellQuote("/srv/My Servers/survival")).toBe(
			"'/srv/My Servers/survival'",
		);
	});

	test("prevents expansion of $, backticks and globs", () => {
		expect(shellQuote("/srv/$HOME/`whoami`/*")).toBe("'/srv/$HOME/`whoami`/*'");
	});

	test("escapes an embedded single quote", () => {
		// The one case the simple wrapper cannot handle by itself: close, escape,
		// reopen. A directory named after someone's name really does hit this.
		expect(shellQuote("/srv/mike's server")).toBe(`'/srv/mike'\\''s server'`);
	});

	test("a quoted launch line survives a round trip through sh", async () => {
		// The real proof: hand the quoted arguments to a shell and check that what
		// comes out the other side is what went in, one argument per line.
		const args = ["/opt/java bin/java", "-Xmx2G", "/srv/mike's server/x.jar"];
		const line = `printf '%s\\n' ${args.map(shellQuote).join(" ")}`;
		const proc = Bun.spawn(["sh", "-c", line], { stdout: "pipe" });
		const out = await new Response(proc.stdout).text();
		expect(out.trimEnd().split("\n")).toEqual(args);
	});
});

describe("sessionName", () => {
	test("prefixes so MCTL's sessions are recognisable in `tmux ls`", () => {
		expect(sessionName("survival")).toBe("mctl-survival");
	});

	test("replaces dots, which tmux reads as a target separator", () => {
		// `mctl-my.server` would address window `server` of session `mctl-my`.
		expect(sessionName("my.server")).toBe("mctl-my-server");
	});
});
