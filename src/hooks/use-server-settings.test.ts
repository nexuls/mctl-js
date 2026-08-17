/**
 * Tests for the Server Settings edit buffer — the pure half of
 * `use-server-settings.ts` (the hook itself needs a renderer and a core context,
 * and is exercised by the tab's rendered test and by running the app).
 *
 * The mapping's one genuinely tricky field is Java: `mctl.json` writes either a
 * resolved major (a number), an explicit `{pinned}`, or nothing at all, and a
 * form has to express all three with a checkbox and a text box without ever
 * turning "resolved 21" into "pinned 21" behind the user's back.
 */

import { describe, expect, test } from "bun:test";
import type { Server } from "../types/server.ts";
import { serverToDraft, validateServerDraft } from "./use-server-settings.ts";

/** A server view model, as `discover.ts` builds one. */
function server(overrides: Partial<Server> = {}): Server {
	return {
		id: "survival",
		name: "Survival",
		kind: "paper",
		minecraftVersion: "1.21.4",
		memory: "2G",
		runtime: "tmux",
		network: "direct",
		path: "/tmp/servers/survival",
		state: "stopped",
		available: true,
		...overrides,
	};
}

describe("serverToDraft", () => {
	test("carries the editable fields across", () => {
		const draft = serverToDraft(server({ name: "My World", memory: "6G" }));
		expect(draft.name).toBe("My World");
		expect(draft.memory).toBe("6G");
		expect(draft.runtime).toBe("tmux");
		expect(draft.network).toBe("direct");
	});

	test("an explicit pin ticks the box and fills the field", () => {
		const draft = serverToDraft(server({ java: { pinned: 17 } }));
		expect(draft.javaPinned).toBe(true);
		expect(draft.javaMajor).toBe("17");
	});

	test("a resolved major pre-fills the field but does NOT tick the box", () => {
		// The distinction is the whole point: this server resolves its Java from the
		// version's requirement, and ticking the box here would silently pin it to
		// whatever it happens to resolve to today.
		const draft = serverToDraft(server({ java: 21 }));
		expect(draft.javaPinned).toBe(false);
		expect(draft.javaMajor).toBe("21");
	});

	test("no Java field at all leaves the box unticked and the field empty", () => {
		const draft = serverToDraft(server({ java: undefined }));
		expect(draft.javaPinned).toBe(false);
		expect(draft.javaMajor).toBe("");
	});
});

describe("validateServerDraft", () => {
	const draft = (patch: Partial<ReturnType<typeof serverToDraft>>) => ({
		...serverToDraft(server()),
		...patch,
	});

	test("a clean draft has no issues", () => {
		expect(validateServerDraft(draft({}))).toEqual({});
	});

	test("name and memory are required", () => {
		expect(validateServerDraft(draft({ name: "  " })).name).toBe("required");
		expect(validateServerDraft(draft({ memory: "" })).memory).toBe("required");
	});

	test("memory must look like a heap size", () => {
		expect(validateServerDraft(draft({ memory: "4G" }))).toEqual({});
		expect(validateServerDraft(draft({ memory: "2048M" }))).toEqual({});
		expect(validateServerDraft(draft({ memory: "lots" })).memory).toBeDefined();
	});

	test("a pinned Java major must be a number, and only while pinned", () => {
		expect(
			validateServerDraft(draft({ javaPinned: true, javaMajor: "21" })),
		).toEqual({});
		expect(
			validateServerDraft(draft({ javaPinned: true, javaMajor: "" })).javaMajor,
		).toBeDefined();
		expect(
			validateServerDraft(draft({ javaPinned: false, javaMajor: "" }))
				.javaMajor,
		).toBeUndefined();
	});
});
