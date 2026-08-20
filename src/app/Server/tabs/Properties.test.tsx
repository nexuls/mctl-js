/**
 * The Server page's Properties tab, rendered.
 *
 * The claims worth drawing are the ones that make "every field is editable"
 * true: that a screen's fields arrive carrying the values on disk rather than
 * MCTL's *interpretation* of them, that a key the catalogue has never heard of
 * still gets a field, and that a server with no `server.properties` yet still
 * gets a usable editor instead of an empty panel.
 *
 * Only the default screen is drawn: which screen is open is the tab's own state,
 * behind a control the harness cannot press. The other screens' fields reach the
 * page through the same generated path, and the ring builder — which *is*
 * per-screen — is covered directly below.
 *
 * The ring cases are plain function calls: the container splices those members
 * into its own ring, and the disabled flags are what stop Tab parking on a
 * button that ignores Enter.
 */

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ThemeRegistry } from "../../../core/theme/registry.ts";
import type { ServerInsight } from "../../../core/server/inspect.ts";
import { readProperties } from "../../../core/server/properties.ts";
import { IconProvider } from "../../../hooks/use-icons.tsx";
import { ThemeProvider } from "../../../hooks/use-theme.tsx";
import { ToastProvider } from "../../../hooks/use-toast.tsx";
import type { Server } from "../../../types/server.ts";
import {
	PropertiesTab,
	propertyFieldId,
	serverPropertiesRingIds,
} from "./Properties.tsx";

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

/**
 * An inspection carrying the given raw keys. `raw: undefined` is the server that
 * has never booted — Minecraft writes the file on its first run.
 */
function insight(raw?: Record<string, string>): ServerInsight {
	return {
		id: "survival",
		properties: raw ? readProperties(raw) : undefined,
		address: { port: 25565, bindIp: "", joinAddress: "localhost:25565" },
		content: {},
	};
}

/** Mount the tab's default screen and return the frame as one string. */
async function mount(
	raw: Record<string, string> | undefined,
	width = 120,
): Promise<string> {
	const registry = await new ThemeRegistry().load();
	const harness = await createTestRenderer({ width, height: 44 });
	// A stand-in for the container's ring: this tab only ever reads `isFocused`
	// and `focus` off it, and nothing here is focused.
	const focus = {
		focus: undefined,
		isFocused: () => false,
		setFocus: () => {},
		next: () => {},
		previous: () => {},
		index: 0,
	};
	createRoot(harness.renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			{/* Pinned to `ascii` like every other rendered test here: `useIcons`
			    without a set resolves off the *runner's* environment. */}
			<IconProvider initialMode="ascii">
				<ToastProvider>
					<PropertiesTab
						server={server()}
						insight={insight(raw)}
						focus={focus as never}
					/>
				</ToastProvider>
			</IconProvider>
		</ThemeProvider>,
	);
	harness.renderOnce();
	// The buffer is adopted in an effect, so the first frame has no fields — and
	// `FormGrid` picks its column count from a *measured* width, which is only
	// known once yoga has run over a frame that has them. Two settling passes,
	// or the grid is captured mid-reflow in its one-column fallback.
	await Bun.sleep(60);
	harness.renderOnce();
	await Bun.sleep(30);
	harness.renderOnce();
	return harness.captureCharFrame();
}

test("the General screen carries the values on disk, not MCTL's reading of them", async () => {
	// `readProperties` reports a hardcore server's difficulty as `hard` whatever
	// the key says, and strips `§` codes from the MOTD. An editor must not: Save
	// would write back a value the user never typed.
	const frame = await mount({
		hardcore: "true",
		difficulty: "peaceful",
		motd: "A §6Fancy§r Server",
		"server-port": "25570",
	});
	expect(frame).toContain("peaceful");
	expect(frame).toContain("25570");
	expect(frame).toContain("§6Fancy");
});

test("fields are labelled by their key, which is what the wiki calls them", async () => {
	const frame = await mount({});
	expect(frame).toContain("motd");
	expect(frame).toContain("server-port");
	expect(frame).toContain("max-players");
	expect(frame).toContain("white-list");
});

test("a server with no server.properties still gets a usable editor", async () => {
	const frame = await mount(undefined);
	expect(frame).toContain("No server.properties yet");
	// Minecraft's documented defaults, so the form is filled rather than blank.
	expect(frame).toContain("25565");
	expect(frame).toContain("A Minecraft Server");
});

test("the screen bar names every group, so no key is unreachable", async () => {
	const frame = await mount({});
	for (const label of [
		"General",
		"World",
		"Gameplay",
		"Players",
		"Network",
		"Performance",
		"Resource packs",
		"RCON",
	]) {
		expect(frame).toContain(label);
	}
});

test("an unknown key adds the Other screen, and only then", async () => {
	expect(await mount({})).not.toContain("Other");
	expect(await mount({ "some-mod:tick-rate": "3" })).toContain("Other");
});

test("nothing is changed until the user changes it", async () => {
	const frame = await mount({ pvp: "false" });
	// The footer is the tab's promise about the write, and it is the answer to
	// "will opening this screen rewrite my file?" — which is no.
	expect(frame).toContain("Nothing changed");
	expect(frame).toContain("Only keys you edit");
});

test("a dirty, valid buffer is what makes Save focusable", () => {
	const keys = ["motd", "pvp"];
	const clean = serverPropertiesRingIds({ keys, dirty: false, invalid: false });
	const dirty = serverPropertiesRingIds({ keys, dirty: true, invalid: false });
	const broken = serverPropertiesRingIds({ keys, dirty: true, invalid: true });
	expect(clean).toContainEqual({ id: "__props-save", disabled: true });
	expect(dirty).toContainEqual({ id: "__props-save", disabled: false });
	expect(dirty).toContainEqual({ id: "__props-revert", disabled: false });
	// A field that fails validation must not be committable, but Revert stays
	// live — it is how the user gets out of it.
	expect(broken).toContainEqual({ id: "__props-save", disabled: true });
	expect(broken).toContainEqual({ id: "__props-revert", disabled: false });
});

test("the ring is the bar, then the screen's fields, then the buttons", () => {
	// The order *is* the Tab order, and the fields are the members — unlike the
	// Content tab's fixed three stops, a screen switch legitimately renumbers
	// them, because switching screen is as deliberate an act as switching tab.
	expect(
		serverPropertiesRingIds({
			keys: ["motd", "pvp"],
			dirty: false,
			invalid: false,
		}),
	).toEqual([
		"__props-tabs",
		propertyFieldId("motd"),
		propertyFieldId("pvp"),
		{ id: "__props-revert", disabled: true },
		{ id: "__props-save", disabled: true },
	]);
});
