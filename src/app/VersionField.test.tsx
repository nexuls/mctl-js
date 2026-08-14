/**
 * `VersionField` — the version picker and its channel toggles, rendered.
 *
 * The field takes the fetched list as a *prop*, so every case here is exercised
 * without a network: an offline failure, a list still loading, and a configured
 * version that is no longer in the list are all just states of that prop. That
 * separation is the point of the hook/component split, and these tests are what
 * hold it — the claims below ("the value survives", "no toggle for a channel
 * that isn't there") are claims about a frame.
 */

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ThemeRegistry } from "../core/theme/registry.ts";
import { ThemeProvider } from "../hooks/use-theme.tsx";
import type { ServerVersionsState } from "../hooks/use-server-versions.ts";
import type { VersionChannel } from "../core/server/versions.ts";
import type { VersionInfo } from "../types/install.ts";
import { VersionField, versionFieldIds } from "./VersionField.tsx";

const ALL: VersionInfo[] = [
	{ id: "1.21.4", type: "release", releaseTime: "2024-12-03T10:12:57+00:00" },
	{ id: "24w46a", type: "snapshot" },
	{ id: "1.21.3", type: "release" },
	{ id: "b1.8.1", type: "beta" },
];

/** Build a state object the way the hook would, minus the fetching. */
function state(patch: Partial<ServerVersionsState> = {}): ServerVersionsState {
	const shown: ReadonlySet<VersionChannel> =
		patch.shown ?? new Set(["release"]);
	const all = patch.all ?? ALL;
	return {
		all,
		versions: patch.versions ?? all.filter((v) => shown.has(v.type)),
		channels: patch.channels ?? ["release", "snapshot", "beta"],
		shown,
		toggle: patch.toggle ?? (() => {}),
		loading: patch.loading ?? false,
		error: patch.error,
	};
}

/** Mount one field, focused on its select, and return the frame as lines. */
async function mount(
	versions: ServerVersionsState,
	value = "",
	focusedId = "mc",
	width: number | `${number}%` = "100%",
) {
	const registry = await new ThemeRegistry().load();
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 70,
		height: 14,
	});
	createRoot(renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			<VersionField
				state={versions}
				value={value}
				onChange={() => {}}
				focus={{ isFocused: (id) => id === focusedId, setFocus: () => {} }}
				width={width}
			/>
		</ThemeProvider>,
	);
	renderOnce();
	// React's commit reaches the renderer a frame later; one render is a blank tree.
	await Bun.sleep(50);
	renderOnce();
	return captureCharFrame().split("\n");
}

test("only the non-release channels get a toggle, and they start off", async () => {
	const frame = (await mount(state())).join("\n");
	expect(frame).toContain("Snapshots");
	expect(frame).toContain("Betas");
	// Releases are always shown, so offering to hide them would leave a picker
	// that can only install a snapshot.
	expect(frame).not.toContain("Releases");
});

test("a kind with one channel renders no toggle row at all", async () => {
	const only: VersionInfo[] = [{ id: "1.21.4", type: "release" }];
	const frame = (
		await mount(state({ all: only, versions: only, channels: ["release"] }))
	).join("\n");
	expect(frame).not.toContain("also show");
});

test("the hint counts what is shown against what exists", async () => {
	const frame = (await mount(state(), "1.21.4")).join("\n");
	expect(frame).toContain("2 of 4 versions");
});

test("the hint explains 'latest' while latest is what is selected", async () => {
	const frame = (await mount(state())).join("\n");
	expect(frame).toContain("newest release at create time");
});

test("an opted-in snapshot names its channel so it can't pass for a release", async () => {
	const shown = new Set<VersionChannel>(["release", "snapshot"]);
	// Narrow enough that the options cannot fit as tabs: the dropdown lists them
	// all, where the tab strip scrolls all but the selected one out of frame.
	const frame = (await mount(state({ shown }), "1.21.4", "mc", 30)).join("\n");
	expect(frame).toContain("24w46a (snapshot)");
	// A release is its bare id — the whole list would otherwise say "(release)".
	expect(frame).not.toContain("1.21.4 (release)");
});

test("a failed fetch says so instead of rendering an empty picker silently", async () => {
	const frame = (
		await mount(
			state({
				all: [],
				versions: [],
				channels: [],
				error: "getaddrinfo ENOTFOUND",
			}),
		)
	).join("\n");
	expect(frame).toContain("could not load versions");
	expect(frame).toContain("ENOTFOUND");
});

test("a value missing from the list is still the selected option", async () => {
	// The configured default outlived the list it came from — a hidden channel, a
	// failed fetch, or a version this kind stopped publishing. Dropping it would
	// silently rewrite the user's setting to whatever sorts first.
	const frame = (
		await mount(state({ all: [], versions: [], channels: [] }), "1.20.1")
	).join("\n");
	// Two options fit side by side, so this renders as tabs — where the option's
	// description has no room. The claim that matters is that the value is one of
	// the options at all.
	expect(frame).toContain("1.20.1");
	expect(frame).toContain("no versions published");
});

test("versionFieldIds contributes the select plus one id per toggle", () => {
	expect(versionFieldIds(state())).toEqual(["mc", "mc:snapshot", "mc:beta"]);
	expect(versionFieldIds(state(), "default")).toEqual([
		"default",
		"default:snapshot",
		"default:beta",
	]);
	expect(versionFieldIds(state({ channels: ["release"] }))).toEqual(["mc"]);
});
