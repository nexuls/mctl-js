/**
 * Tests for the shared tunnel-agent machinery.
 *
 * These drive **real detached processes** rather than a mock, because everything
 * worth testing here is process mechanics: does a child that outlives its parent
 * get its output into a file MCTL can read, is the address scraped out of that
 * output, is a descriptor for a dead agent reaped rather than believed. A fake
 * spawn would test none of it.
 *
 * The stand-in agents are tiny shell scripts — one that announces an address and
 * then sleeps (a healthy tunnel), one that prints an error and exits (a tunnel
 * that fails to authenticate), and one that stays silent (a tunnel that hangs).
 *
 * `lib/paths` reads the XDG environment on every call, so each test points
 * `XDG_STATE_HOME` at a fresh temp directory rather than touching the real one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkFile, networkLogFile } from "../../lib/paths.ts";
import type { TunnelSession } from "../../types/network.ts";
import {
	readTunnel,
	startAgent,
	stopAgent,
	tailLog,
	TunnelStartError,
	writeTunnel,
	type AnnouncedAddress,
} from "./agent.ts";

let stateHome: string;
let scripts: string;
let originalStateHome: string | undefined;

/** Write an executable stand-in agent and return its path. */
async function script(name: string, body: string): Promise<string> {
	const path = join(scripts, name);
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
	return path;
}

/** The matcher a real provider supplies: pull `host:port` out of a line. */
function match(line: string): AnnouncedAddress | undefined {
	const hit = /url=tcp:\/\/([^\s:]+):(\d+)/.exec(line);
	return hit
		? { host: hit[1]!, port: Number.parseInt(hit[2]!, 10) }
		: undefined;
}

beforeEach(async () => {
	originalStateHome = process.env.XDG_STATE_HOME;
	stateHome = await mkdtemp(join(tmpdir(), "mctl-agent-state-"));
	scripts = await mkdtemp(join(tmpdir(), "mctl-agent-bin-"));
	process.env.XDG_STATE_HOME = stateHome;
});

afterEach(async () => {
	await stopAgent("survival").catch(() => {});
	if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = originalStateHome;
	await rm(stateHome, { recursive: true, force: true });
	await rm(scripts, { recursive: true, force: true });
});

/** A spec with the boilerplate filled in; each test overrides what it cares about. */
function spec(
	command: string,
	overrides: Partial<Parameters<typeof startAgent>[0]> = {},
) {
	return {
		serverId: "survival",
		provider: "faketunnel",
		profile: "test",
		localPort: 25565,
		command,
		args: [],
		match,
		timeoutMs: 5_000,
		...overrides,
	};
}

describe("startAgent", () => {
	test("scrapes the announced address and records a descriptor", async () => {
		const agent = await script(
			"good",
			'echo "lvl=info msg=\\"started tunnel\\" url=tcp://4.tcp.ngrok.io:19132"\nsleep 30',
		);
		const session = await startAgent(spec(agent));

		expect(session.endpoint.host).toBe("4.tcp.ngrok.io");
		expect(session.endpoint.port).toBe(19132);
		expect(session.endpoint.joinAddress).toBe("4.tcp.ngrok.io:19132");
		expect(session.endpoint.kind).toBe("tunnel");
		expect(session.pid).toBeGreaterThan(0);

		// The descriptor is what every other instance reads; it must be on disk
		// before `startAgent` returns, not after the caller does something else.
		const written = JSON.parse(
			await Bun.file(networkFile("survival")).text(),
		) as TunnelSession;
		expect(written.endpoint.joinAddress).toBe("4.tcp.ngrok.io:19132");
		expect(written.provider).toBe("faketunnel");
	});

	test("the agent outlives this process's hold on it", async () => {
		const agent = await script(
			"survivor",
			'echo "url=tcp://a.example:1"\nsleep 30',
		);
		const session = await startAgent(spec(agent));
		// Detached and unref'd: still running with nothing awaiting it.
		await Bun.sleep(300);
		expect(() => process.kill(session.pid!, 0)).not.toThrow();
	});

	test("an agent that dies without announcing fails and leaves no descriptor", async () => {
		const agent = await script(
			"failing",
			'echo "ERR authentication failed"\nexit 1',
		);
		await expect(startAgent(spec(agent))).rejects.toBeInstanceOf(
			TunnelStartError,
		);
		// The critical half: an agent MCTL has forgotten about could never be
		// stopped, so a failed start must not leave a record behind.
		expect(await Bun.file(networkFile("survival")).exists()).toBe(false);
		expect(await tailLog("survival")).toContain("authentication failed");
	});

	test("a silent agent is killed rather than left running", async () => {
		// The agent records its own pid so the test can prove it was reaped — the
		// descriptor is never written, so there is no other way to name it, and
		// "the start failed" would pass even if the process were still up.
		const pidFile = join(scripts, "silent.pid");
		const agent = await script("silent", `echo $$ > ${pidFile}\nsleep 30`);
		await expect(
			startAgent(spec(agent, { timeoutMs: 700 })),
		).rejects.toBeInstanceOf(TunnelStartError);

		expect(await Bun.file(networkFile("survival")).exists()).toBe(false);
		const pid = Number.parseInt(await Bun.file(pidFile).text(), 10);
		await Bun.sleep(300);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("a fallback address keeps a healthy but silent agent alive", async () => {
		// playit's case: the agent is fine, it just never prints the address.
		const agent = await script("quiet", "sleep 30");
		const session = await startAgent(
			spec(agent, {
				timeoutMs: 700,
				fallback: { host: "abc.craft.ply.gg", port: 25565 },
			}),
		);
		expect(session.endpoint.host).toBe("abc.craft.ply.gg");
		expect(() => process.kill(session.pid!, 0)).not.toThrow();
	});

	test("the capture is truncated so a previous failure is not read as this one's", async () => {
		await Bun.write(networkLogFile("survival"), "OLD FAILURE\n");
		const agent = await script(
			"fresh",
			'echo "url=tcp://b.example:2"\nsleep 30',
		);
		await startAgent(spec(agent));
		expect(await tailLog("survival")).not.toContain("OLD FAILURE");
	});
});

describe("readTunnel", () => {
	test("reaps a descriptor whose agent is gone", async () => {
		const agent = await script(
			"shortlived",
			'echo "url=tcp://c.example:3"\nsleep 30',
		);
		const session = await startAgent(spec(agent));
		process.kill(session.pid!, "SIGKILL");
		// Give the kernel a moment to actually reap it, or the liveness probe
		// legitimately still sees the process.
		await Bun.sleep(300);

		expect(await readTunnel("survival")).toBeUndefined();
		expect(await Bun.file(networkFile("survival")).exists()).toBe(false);
	});

	test("keeps a pid-less descriptor, which has nothing to reap", async () => {
		// `direct` and `tailscale` announce an address with no agent behind it. A
		// naive "no live pid ⇒ dead" rule would erase them on the next read.
		await writeTunnel("survival", {
			provider: "direct",
			profile: "direct",
			localPort: 25565,
			endpoint: {
				host: "192.168.1.4",
				port: 25565,
				joinAddress: "192.168.1.4:25565",
				kind: "direct",
				provider: "direct",
			},
			startedAt: new Date().toISOString(),
		});
		expect((await readTunnel("survival"))?.provider).toBe("direct");
	});

	test("discards an unreadable descriptor instead of believing it", async () => {
		await Bun.write(networkFile("survival"), "{ not json");
		expect(await readTunnel("survival")).toBeUndefined();
		expect(await Bun.file(networkFile("survival")).exists()).toBe(false);
	});
});

describe("stopAgent", () => {
	test("kills the agent and removes the descriptor", async () => {
		const agent = await script(
			"stoppable",
			'echo "url=tcp://d.example:4"\nsleep 30',
		);
		const session = await startAgent(spec(agent));
		await stopAgent("survival");
		await Bun.sleep(300);

		expect(await Bun.file(networkFile("survival")).exists()).toBe(false);
		expect(() => process.kill(session.pid!, 0)).toThrow();
	});

	test("is a no-op when nothing is recorded", async () => {
		await expect(stopAgent("survival")).resolves.toBeUndefined();
	});
});
