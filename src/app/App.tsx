/**
 * The OpenTUI (React) application shell — the root of the interactive TUI.
 *
 * This is a **page-layer** component: it renders view models and calls hooks. It
 * must never touch the filesystem, spawn processes, or call `Bun.*` I/O directly
 * (AGENTS.md § 3). It reads colours from {@link useTheme}; the theme catalogue is
 * loaded from disk by `renderApp()` (core call) and injected via `ThemeProvider`.
 *
 * `renderApp()` owns renderer creation, core wiring (theme registry, event
 * system, stale-lock reaping), and mounting so `src/index.tsx` stays a thin argv
 * dispatcher and the CLI path never imports OpenTUI.
 */

import { createCliRenderer } from "@opentui/core";
import { useState } from "react";
import { createRoot } from "@opentui/react";
import { configExists, loadConfig, writeConfig } from "../core/config/index.ts";
import { ThemeRegistry } from "../core/theme/registry.ts";
import { startEventSystem } from "../core/events/index.ts";
import { reapStaleLocks } from "../core/session/session-manager.ts";
import { log } from "../lib/logger.ts";
import { ThemeProvider } from "../hooks/use-theme.tsx";
import { EventBusProvider } from "../hooks/use-event-bus.tsx";
import { queryTerminalPalette } from "../hooks/use-terminal-colors.ts";
import { installBoxClipPatch } from "../components/box-clip-patch.ts";
import { SetupWizard } from "./setup/index.ts";
import { AppRouter } from "./Router.tsx";

const logger = log("app");

/** Props for {@link App}. */
interface AppProps {
  /** True when `config.json` is absent — route to the first-run wizard. */
  firstRun: boolean;
}

/**
 * Root component. On first run it shows the setup wizard; once setup has written
 * config (or on any later run) it shows the router-driven app. The wizard owns
 * its own keyboard; the router owns navigation, theme cycling, and quit.
 */
function App({ firstRun }: AppProps) {
  // Whether the first-run wizard still needs to run. Flipped false when the
  // wizard completes, so the app transitions into the dashboard in-place without
  // a restart.
  const [needsSetup, setNeedsSetup] = useState(firstRun);

  if (needsSetup) {
    return <SetupWizard onComplete={() => setNeedsSetup(false)} />;
  }
  return <AppRouter />;
}

/**
 * Create the terminal renderer, wire core services, and mount the app. Resolves
 * when the renderer is up; the process then stays alive under OpenTUI's control
 * until the user quits.
 */
export async function renderApp(): Promise<void> {
  // Upstream OpenTUI does not clip box borders against ancestor scissor rects, so
  // a bordered `<box>` inside a `<scrollbox>` paints its border over the chrome
  // around the scrollbox once scrolled. Install the fix before the first render.
  installBoxClipPatch();

  // Load the theme catalogue (built-ins + `~/.config/mctl/themes/*.json`) and
  // the persisted theme id before the first paint. Front-end → core service:
  // the React tree never touches disk itself.
  const registry = await new ThemeRegistry().load();
  const initialThemeId = await loadThemeId();

  // Reap stale locks (crashed instances' start/install/supervisor locks) once at
  // startup, before anything reads runtime state (architecture.md § Statelessness).
  await reapStaleLocks();

  // Start the event system: the in-process bus, the `events.jsonl` tail, and the
  // hard-state file watchers. The bus is injected into the tree so hooks react to
  // local and cross-instance state changes uniformly.
  const events = await startEventSystem();

  // First run = no config.json yet. Decided once here (front-end → core) and
  // handed to the tree, which routes to the setup wizard rather than the
  // dashboard until setup completes.
  const firstRun = !(await configExists());

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    clearOnShutdown: false,
    openConsoleOnError: true,
    enableMouseMovement: true,
  });

  // Make everything non-selectable by default. OpenTUI text renderables are
  // individually `selectable` and begin a drag-selection on left mouse-down,
  // which highlights text and clashes with our click-to-navigate UI. Neutering
  // the renderer's selection entry point disables that globally while leaving
  // mouse clicks (onMouseDown handlers) fully intact.
  renderer.startSelection = () => {};

  // Stop the event system when the renderer shuts down (Ctrl+C / quit), so
  // watchers and the tail don't outlive the UI.
  renderer.on("destroy", () => void events.stop());

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
      <EventBusProvider bus={events.bus}>
        <App firstRun={firstRun} />
      </EventBusProvider>
    </ThemeProvider>,
  );
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
