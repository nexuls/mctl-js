/**
 * The OpenTUI (React) application shell — the root of the interactive TUI.
 *
 * This is a **page-layer** component: it renders view models and calls hooks. It
 * must never touch the filesystem, spawn processes, or call `Bun.*` I/O directly
 * (AGENTS.md § 3). It reads colours from {@link useTheme}; the theme catalogue is
 * loaded from disk by `renderApp()` (core call) and injected via `ThemeProvider`.
 *
 * `renderApp()` owns renderer creation, core wiring, and mounting so
 * `src/index.tsx` stays a thin argv dispatcher and the CLI path never imports
 * OpenTUI.
 */

import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { loadConfig, writeConfig } from "../core/config/index.ts";
import { ThemeRegistry } from "../core/theme/registry.ts";
import { log } from "../lib/logger.ts";
import { ThemeProvider, useTheme } from "../hooks/use-theme.tsx";
import { queryTerminalPalette } from "../hooks/use-terminal-colors.ts";

const logger = log("app");

/** Root component. Themed shell; `t` cycles themes, `q`/`Esc` quits. */
function App() {
	const renderer = useRenderer();
	const { theme, setThemeId, themes } = useTheme();

	useKeyboard((key) => {
		if (key.name === "escape" || key.name === "q") renderer.destroy();
		// Cycle themes as a live demonstration of the registry + provider.
		if (key.name === "t") {
			const idx = themes.findIndex((t) => t.id === theme.id);
			const next = themes[(idx + 1) % themes.length];
			if (next) setThemeId(next.id);
		}
	});

	const c = theme.colors;

	// The dynamic "terminal" theme mirrors the host terminal's own background.
	// Painting its *derived* hex lags the terminal by one palette-query cycle
	// (mode-2031 event or the 1s poll): during a live terminal theme switch the
	// app keeps drawing the old hex, which no longer matches the terminal's new
	// default background, so the terminal renders it opaque for a beat before the
	// palette lands and transparency returns. Painting "transparent" for the
	// terminal theme sidesteps the race entirely — the terminal's real background
	// shows through instantly and never flashes. Static themes keep their own
	// opaque background hex.
	const pageBackground = theme.source === "terminal" ? "transparent" : c.background;

	return (
		<box
			flexGrow={1}
			flexDirection="column"
			padding={1}
			backgroundColor={pageBackground}
		>
			<box justifyContent="flex-start" alignItems="flex-end">
				<ascii-font font="tiny" text="mctl" color={c.primary} />
				<text fg={c.muted} attributes={TextAttributes.DIM}>
					{" "}
					minecraft server control
				</text>
			</box>
			<box
				flexGrow={1}
				flexDirection="column"
				justifyContent="center"
				alignItems="center"
				gap={1}
			>
				<text fg={c.foreground}>Dashboard coming online.</text>
				<text fg={c.muted}>
					theme: <span fg={c.secondary}>{theme.name}</span> · appearance:{" "}
					<span fg={c.secondary}>{theme.appearance}</span>
				</text>
				<text fg={c.muted}>
					press <span fg={c.info}>t</span> to cycle · <span fg={c.info}>q</span>{" "}
					to quit
				</text>
			</box>
		</box>
	);
}

/**
 * Create the terminal renderer, wire core services, and mount the app. Resolves
 * when the renderer is up; the process then stays alive under OpenTUI's control
 * until the user quits.
 */
export async function renderApp(): Promise<void> {
	// Load the theme catalogue (built-ins + `~/.config/mctl/themes/*.json`) and
	// the persisted theme id before the first paint. Front-end → core service:
	// the React tree never touches disk itself.
	const registry = await new ThemeRegistry().load();
	const initialThemeId = await loadThemeId();

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

	// Query the host palette BEFORE the first paint so the terminal-default theme
	// renders in real colours from frame one — no flash from a placeholder theme.
	// Null (non-TTY / slow terminal) just means the live query in the hook fills
	// it in shortly; the empty-terminal theme covers the gap.
	const initialPalette = await queryTerminalPalette(renderer);

	createRoot(renderer).render(
		<ThemeProvider
			registry={registry}
			initialThemeId={initialThemeId}
			initialPalette={initialPalette}
			onThemeChange={persistThemeId}
		>
			<App />
		</ThemeProvider>,
	);

	renderer.keyInput.on("keypress", (key) => {
		if (key.ctrl && key.name === "`") {
			renderer.console.toggle();
		}
	});
}

/**
 * Read the persisted theme id from `config.json`. Before first-run setup there
 * is no config, so we default to `"terminal"` (the host palette) — the app must
 * be themeable before the wizard exists.
 */
async function loadThemeId(): Promise<string> {
	try {
		return (await loadConfig()).theme;
	} catch {
		// ConfigNotFoundError (first run) or a malformed file: fall back rather than
		// block the UI on a theme preference.
		return "terminal";
	}
}

/**
 * Persist a theme selection into `config.json`. Best-effort: when there is no
 * config yet (first run) the choice simply isn't saved, which is correct — the
 * wizard writes config, and Settings persists thereafter. Never blocks the UI.
 */
function persistThemeId(id: string): void {
	loadConfig()
		.then((config) => writeConfig({ ...config, theme: id }))
		.catch((err) => {
			logger.debug({ err: String(err) }, "theme not persisted (no config yet)");
		});
}
