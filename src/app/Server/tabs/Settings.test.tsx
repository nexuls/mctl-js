/**
 * The Server page's Settings tab, rendered.
 *
 * Every claim this tab makes is a claim about a frame: that the editable fields
 * arrive carrying the server's current values, that the identity a *user* cannot
 * change is shown but not offered as a field, and that the pinned-Java input
 * appears only for a server that actually pins one. None of those can be checked
 * without drawing them.
 *
 * There is no core context in a test renderer, so `useMctl()` yields `undefined`
 * and the network picker falls back to the server's own profile — which is
 * exactly the "profile not defined in this config" path, and worth having drawn
 * at least once.
 */

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ThemeRegistry } from "../../../core/theme/registry.ts";
import { IconProvider } from "../../../hooks/use-icons.tsx";
import { ThemeProvider } from "../../../hooks/use-theme.tsx";
import { ToastProvider } from "../../../hooks/use-toast.tsx";
import type { Server } from "../../../types/server.ts";
import { SettingsTab, serverSettingsRingIds } from "./Settings.tsx";

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

/** Mount the tab and return the frame as one string. */
async function mount(target = server(), width = 120): Promise<string> {
	const registry = await new ThemeRegistry().load();
	const harness = await createTestRenderer({ width, height: 44 });
	createRoot(harness.renderer).render(
		<ThemeProvider registry={registry} initialThemeId="github">
			{/* Pinned to `ascii` like every other rendered test here: `useIcons`
			    without a set resolves off the *runner's* environment, and a Nerd Font
			    checkbox is invisible in a captured frame. */}
			<IconProvider initialMode="ascii">
				<ToastProvider>
					<SettingsTab server={target} />
				</ToastProvider>
			</IconProvider>
		</ThemeProvider>,
	);
	harness.renderOnce();
	// The buffer is adopted in an effect, so the first frame is the empty form.
	await Bun.sleep(60);
	harness.renderOnce();
	return harness.captureCharFrame();
}

test("the editable fields arrive carrying the server's values", async () => {
	const frame = await mount(server({ name: "My World", memory: "6G" }));
	expect(frame).toContain("Name");
	expect(frame).toContain("My World");
	expect(frame).toContain("Memory");
	expect(frame).toContain("6G");
	expect(frame).toContain("Runtime");
	expect(frame).toContain("Network profile");
	expect(frame).toContain("Save");
	expect(frame).toContain("Revert");
});

test("identity and location are shown but not offered as fields", async () => {
	const frame = await mount();
	expect(frame).toContain("survival");
	expect(frame).toContain("paper");
	expect(frame).toContain("1.21.4");
	expect(frame).toContain("/tmp/servers/survival");
	// Changing either is an *update* — a new jar and a re-run installer — which
	// core does not have. A field here would be a form that breaks a server.
	expect(frame).not.toContain("Server kind");
	expect(frame).not.toContain("Minecraft version");
});

test("the Java major field appears only for a server that pins one", async () => {
	expect(await mount(server({ java: 21 }))).not.toContain("Java major");
	expect(await mount(server({ java: { pinned: 17 } }))).toContain("Java major");
});

test("a dirty form is what makes Save and Revert focusable", () => {
	// The container splices these into *its* ring, so the disabled flags here are
	// what stop Tab parking on a button that ignores Enter.
	const clean = serverSettingsRingIds({ dirty: false, javaPinned: false });
	const dirty = serverSettingsRingIds({ dirty: true, javaPinned: false });
	expect(clean).toContainEqual({ id: "set-save", disabled: true });
	expect(dirty).toContainEqual({ id: "set-save", disabled: false });
	expect(dirty).toContainEqual({ id: "set-revert", disabled: false });
	// The fields themselves are always in the ring, dirty or not.
	expect(clean).toContain("set-name");
});

test("the Java field joins the ring only while it is on screen", () => {
	// A conditional field is *omitted*, not disabled: a disabled member holds a
	// place for a control the user can see, and this one is not drawn at all.
	expect(
		serverSettingsRingIds({ dirty: false, javaPinned: false }),
	).not.toContain("set-javaMajor");
	expect(serverSettingsRingIds({ dirty: false, javaPinned: true })).toContain(
		"set-javaMajor",
	);
});
