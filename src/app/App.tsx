/**
 * The OpenTUI (React) application shell — the root of the interactive TUI.
 *
 * This is a **page-layer** component: it renders view models and calls hooks. It
 * must never touch the filesystem, spawn processes, or call `Bun.*` I/O directly
 * (AGENTS.md § 3). Right now it is a minimal shell; Dashboard/Servers/Console and
 * the first-run wizard land as this phase progresses.
 *
 * `renderApp()` owns renderer creation and mounting so `src/index.tsx` stays a
 * thin argv dispatcher and the CLI path never imports OpenTUI.
 */

import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";

/** Root component. Quits on `q` or `Esc` until real navigation exists. */
function App() {
	const renderer = useRenderer();

	useKeyboard((key) => {
		if (key.name === "escape" || key.name === "q") renderer.destroy();
	});

	return (
		<box flexGrow={1} flexDirection="column" padding={1}>
			<box justifyContent="flex-start" alignItems="flex-end">
				<ascii-font font="tiny" text="mctl" />
				<text attributes={TextAttributes.DIM}> minecraft server control</text>
			</box>
			<box flexGrow={1} justifyContent="center" alignItems="center">
				<text attributes={TextAttributes.DIM}>
					Dashboard coming online — press q or Esc to quit.
				</text>
			</box>
		</box>
	);
}

/**
 * Create the terminal renderer and mount the app. Resolves when the renderer is
 * up; the process then stays alive under OpenTUI's control until the user quits.
 */
export async function renderApp(): Promise<void> {
	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		screenMode: "alternate-screen",
		clearOnShutdown: false,
		openConsoleOnError: true,
	});

	// Make everything non-selectable by default. OpenTUI text renderables are
	// individually `selectable` and begin a drag-selection on left mouse-down,
	// which highlights text and clashes with our click-to-navigate UI. Neutering
	// the renderer's selection entry point disables that globally while leaving
	// mouse clicks (onMouseDown handlers) fully intact.
	renderer.startSelection = () => {};

	createRoot(renderer).render(<App />);

	renderer.keyInput.on("keypress", (key) => {
		if (key.ctrl && key.name === "`") {
			renderer.console.toggle();
		}
	});
}
