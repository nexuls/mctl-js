/**
 * Regression tests for the hard-state watchers.
 *
 * These exist because the watchers were silently dead: Bun's `fs.watch` reports
 * a rename under its **source** name, so an atomic write of `config.json` was
 * only ever seen as `.…tmp` and the name filter never matched. Multi-instance
 * sync depends on these events, and nothing else would have caught it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configFile,
	serversRegistryFile,
	runtimeFile,
	themesDir,
} from "../../lib/paths.ts";
import { writeJsonAtomic } from "../../lib/fs.ts";
import { EventBus } from "./bus.ts";
import { startWatchers } from "./watch.ts";

let sandbox: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "mctl-watch-"));
	for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"]) {
		saved[key] = process.env[key];
	}
	process.env.XDG_CONFIG_HOME = join(sandbox, "config");
	process.env.XDG_STATE_HOME = join(sandbox, "state");
});

afterEach(async () => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(sandbox, { recursive: true, force: true });
});

/** Collect event types seen while `body` runs, with the watchers attached. */
async function withWatchers(body: () => Promise<void>): Promise<string[]> {
	const bus = new EventBus();
	const seen: string[] = [];
	bus.subscribe((event) => seen.push(event.type));
	const stop = await startWatchers(bus);
	try {
		await body();
		await Bun.sleep(400); // watch latency + the 60 ms debounce
	} finally {
		stop();
	}
	return seen;
}

test("an atomic config.json write emits ConfigChanged", async () => {
	const seen = await withWatchers(async () => {
		await writeJsonAtomic(configFile(), { root: "/tmp/root" });
	});
	expect(seen).toContain("ConfigChanged");
});

test("an atomic servers.json write emits RegistryChanged", async () => {
	const seen = await withWatchers(async () => {
		await writeJsonAtomic(serversRegistryFile(), { version: 1, servers: [] });
	});
	expect(seen).toContain("RegistryChanged");
});

test("a runtime descriptor write emits ServerStateChanged for that server", async () => {
	const bus = new EventBus();
	const seen: { type: string; payload?: unknown }[] = [];
	bus.subscribe((event) =>
		seen.push({ type: event.type, payload: event.payload }),
	);
	const stop = await startWatchers(bus);
	try {
		await writeJsonAtomic(runtimeFile("survival"), {
			pid: 1,
			runtime: "foreground",
			startedAt: new Date().toISOString(),
		});
		await Bun.sleep(400);
	} finally {
		stop();
	}
	expect(seen).toContainEqual({
		type: "ServerStateChanged",
		payload: { id: "survival" },
	});
});

test("an unrelated file in a watched directory emits nothing", async () => {
	const seen = await withWatchers(async () => {
		await writeJsonAtomic(
			join(sandbox, "config", "mctl", "keybindings.json"),
			{},
		);
	});
	expect(seen).toEqual([]);
});

test("a custom theme file emits ThemesChanged with its name", async () => {
	// Closes the "editing a theme needs a restart" gap: the catalogue is a
	// projection of this directory, and nothing else tells an instance it moved.
	const bus = new EventBus();
	const seen: { type: string; payload?: unknown }[] = [];
	bus.subscribe((event) =>
		seen.push({ type: event.type, payload: event.payload }),
	);
	const stop = await startWatchers(bus);
	try {
		await writeJsonAtomic(join(themesDir(), "dracula.json"), {
			name: "Dracula",
			colors: { default: {} },
		});
		await Bun.sleep(400);
	} finally {
		stop();
	}
	expect(seen).toContainEqual({
		type: "ThemesChanged",
		payload: { file: "dracula.json" },
	});
});
