/**
 * Tests for the cross-instance event log: rotation (`trimEventLog`) and the
 * tail's behaviour around it.
 *
 * Every test points `XDG_STATE_HOME` at a fresh temp dir — `lib/paths.ts` reads
 * the environment at call time, so this redirects `events.jsonl` without any
 * mocking.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventsLogFile } from "../../lib/paths.ts";
import { EventBus } from "./bus.ts";
import { INSTANCE_ID } from "./instance.ts";
import { publish, startTail, trimEventLog } from "./log.ts";

let sandbox: string;
let previousState: string | undefined;

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "mctl-events-"));
	previousState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = sandbox;
	await mkdir(join(sandbox, "mctl"), { recursive: true });
});

afterEach(async () => {
	if (previousState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = previousState;
	await rm(sandbox, { recursive: true, force: true });
});

/** Write `count` synthetic event lines, each tagged with its index. */
async function seed(count: number, instance = "other-instance"): Promise<void> {
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		out.push(
			JSON.stringify({
				v: 1,
				id: `id-${i}`,
				ts: new Date().toISOString(),
				instance,
				type: "ServerStateChanged",
				payload: { id: `server-${i}`, filler: "x".repeat(200) },
			}),
		);
	}
	await writeFile(eventsLogFile(), `${out.join("\n")}\n`);
}

describe("trimEventLog", () => {
	test("leaves a log under the cap untouched", async () => {
		await seed(5);
		const before = await readFile(eventsLogFile(), "utf8");
		expect(await trimEventLog(64 * 1024, 16 * 1024)).toBe(false);
		expect(await readFile(eventsLogFile(), "utf8")).toBe(before);
	});

	test("rotates an oversized log down to a whole-line tail", async () => {
		await seed(400); // ~90 KB of 200-byte payloads
		const before = await readFile(eventsLogFile(), "utf8");
		expect(await trimEventLog(8 * 1024, 4 * 1024)).toBe(true);

		const after = await readFile(eventsLogFile(), "utf8");
		expect(after.length).toBeLessThan(before.length);
		expect(after.length).toBeLessThanOrEqual(4 * 1024);
		// Every surviving line must be a complete, parseable event — a rotation that
		// cut mid-line would poison the next instance's tail.
		for (const line of after.split("\n").filter((l) => l !== "")) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		// The tail is kept, not the head.
		expect(before.endsWith(after)).toBe(true);
	});

	test("is a no-op when the log does not exist", async () => {
		expect(await trimEventLog(1, 1)).toBe(false);
	});
});

describe("startTail", () => {
	test("emits another instance's appended events, not its own", async () => {
		const bus = new EventBus();
		const seen: string[] = [];
		bus.subscribe((event) => seen.push(`${event.instance}:${event.type}`));
		const stop = await startTail(bus);
		try {
			// Our own publish emits locally exactly once and must not be re-emitted
			// when the tail reads the line back.
			await publish(bus, "ConfigChanged");
			await writeFile(
				eventsLogFile(),
				`${JSON.stringify({
					v: 1,
					id: "remote-1",
					ts: new Date().toISOString(),
					instance: "another-instance",
					type: "RegistryChanged",
				})}\n`,
				{ flag: "a" },
			);
			await Bun.sleep(1300); // one poll tick, in case fs.watch misses it
		} finally {
			stop();
		}

		expect(seen.filter((s) => s.startsWith(INSTANCE_ID)).length).toBe(1);
		expect(seen).toContain("another-instance:RegistryChanged");
	});

	test("does not replay history after a rotation", async () => {
		await seed(400);
		const bus = new EventBus();
		const seen: string[] = [];
		bus.subscribe((event) => seen.push(event.id));
		// Start the tail at the current end, then rotate underneath it: the file
		// shrinks, and the tail must resume at the new end rather than re-emit the
		// surviving lines as if they were new.
		const stop = await startTail(bus);
		try {
			await trimEventLog(8 * 1024, 4 * 1024);
			await Bun.sleep(1300);
		} finally {
			stop();
		}
		expect(seen).toEqual([]);
	});
});
