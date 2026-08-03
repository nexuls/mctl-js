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
import { startEventSystem, type EventBus } from "../core/events/index.ts";
import { EventType } from "../types/events.ts";
import type { Config, IconMode } from "../types/config.ts";
import { reapStaleLocks } from "../core/session/session-manager.ts";
import { log } from "../lib/logger.ts";
import { ThemeProvider } from "../hooks/use-theme.tsx";
import { IconProvider } from "../hooks/use-icons.tsx";
import { EventBusProvider } from "../hooks/use-event-bus.tsx";
import { InputCaptureProvider } from "../hooks/use-input-capture.tsx";
import { ToastProvider } from "../hooks/use-toast.tsx";
import { MctlProvider } from "../hooks/use-mctl.tsx";
import { createProviderRegistry } from "../providers/index.ts";
import { queryTerminalPalette } from "../hooks/use-terminal-colors.ts";
import { installBoxClipPatch } from "../components/box-clip-patch.ts";
import { installSelectionOptIn } from "../components/selection-opt-in.ts";
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

  // Drag-selection is opt-in: OpenTUI's text renderables are `selectable` by
  // default and start a selection on left mouse-down, which fights with our
  // click-to-navigate UI. This flips the default off, so only elements that pass
  // `selectable` explicitly (the console log lines) can be selected. Must run
  // before the first render — it re-registers the component catalogue.
  installSelectionOptIn();

  // Load the theme catalogue (built-ins + `~/.config/mctl/themes/*.json`) and
  // the persisted theme id before the first paint. Front-end → core service:
  // the React tree never touches disk itself.
  const registry = await new ThemeRegistry().load();
  const appearance = await loadAppearance();

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

  // Stop the event system when the renderer shuts down (Ctrl+C / quit), so
  // watchers and the tail don't outlive the UI.
  renderer.on("destroy", () => void events.stop());

  // Query the host palette BEFORE the first paint so the terminal-default theme
  // renders in real colours from frame one — no flash from a placeholder theme.
  // Null (non-TTY / slow terminal) just means the live query in the hook fills
  // it in shortly; the empty-terminal theme covers the gap.
  const initialPalette = await queryTerminalPalette(renderer);

  // Bridge `ConfigChanged` (another instance changing the theme or icon set, or
  // a hand-edit of config.json) back into the appearance providers, which sit
  // above the bus provider and do no I/O of their own. Built once each so their
  // identities are stable across renders — the providers use them as effect
  // dependencies.
  const subscribeThemeId = configSubscriber(events.bus, (c) => c.theme);
  const subscribeIconMode = configSubscriber(events.bus, (c) => c.icons);

  // The concrete providers this build ships. Built once here at the front-end
  // edge and injected, so nothing under `core/` or `hooks/` ever imports one
  // (AGENTS.md § 3: core knows provider *interfaces* only).
  const providers = createProviderRegistry();

  createRoot(renderer).render(
    <ThemeProvider
      registry={registry}
      initialThemeId={appearance.theme}
      initialPalette={initialPalette}
      onThemeChange={(theme) => persistAppearance({ theme })}
      subscribeThemeId={subscribeThemeId}
    >
      {/* Icons are the other half of "appearance", so the provider sits beside
          the theme's — above everything, since the component kit itself
          (Toast, Form, Tabs, Hint) reads glyphs from it. */}
      <IconProvider
        initialMode={appearance.icons}
        onModeChange={(icons) => persistAppearance({ icons })}
        subscribeMode={subscribeIconMode}
      >
        <EventBusProvider bus={events.bus}>
          {/* Above the app so both the wizard and the router's pages can hold the
              capture, and so toasts (below it) can stand their action keys down
              while a text field is being typed into. */}
          <InputCaptureProvider>
            <ToastProvider>
              {/* The mutating core services. Below the bus (it rebuilds on
                  ConfigChanged) and below the toast layer, so a page can raise
                  a toast about a create it just started. */}
              <MctlProvider providers={providers}>
                <App firstRun={firstRun} />
              </MctlProvider>
            </ToastProvider>
          </InputCaptureProvider>
        </EventBusProvider>
      </IconProvider>
    </ThemeProvider>,
  );
}

/** The persisted appearance preferences, read once before the first paint. */
interface Appearance {
  /** Active theme id (`config.theme`). */
  theme: string;
  /** Active icon mode (`config.icons`). */
  icons: IconMode;
}

/**
 * Read the persisted appearance from `config.json`. Before first-run setup
 * there is no config, so this falls back to `"terminal"` (the host palette) and
 * `"auto"` (detected glyphs) — the app must be themeable and drawable before
 * the wizard that writes config exists.
 */
async function loadAppearance(): Promise<Appearance> {
  try {
    const config = await loadConfig();
    return { theme: config.theme, icons: config.icons };
  } catch {
    // ConfigNotFoundError (first run) or a malformed file: fall back rather than
    // block the UI on a display preference.
    return { theme: "terminal", icons: "auto" };
  }
}

/**
 * Build a `ConfigChanged` → provider bridge. The watcher event carries no
 * payload, so the new value is re-read from disk through the config service
 * (the UI layer never reads it itself).
 *
 * @param select Pulls the value of interest out of the reloaded config.
 * @returns a subscribe function to hand to a provider; call it **once** and keep
 * the result, as providers treat it as a stable effect dependency.
 */
function configSubscriber<T>(
  bus: EventBus,
  select: (config: Config) => T,
): (apply: (value: T) => void) => () => void {
  return (apply) =>
    bus.subscribe((event) => {
      if (event.type !== EventType.ConfigChanged) return;
      loadConfig()
        .then((config) => apply(select(config)))
        .catch((err) => {
          // A transient unreadable/half-written config: keep the current
          // appearance rather than flashing a fallback. The next change re-reads.
          logger.debug({ err: String(err) }, "appearance not re-read on change");
        });
    });
}

/**
 * Persist an appearance change (theme id, icon mode, or both) into
 * `config.json`. Best-effort: when there is no config yet (first run) the choice
 * simply isn't saved, which is correct — the wizard writes config, and Settings
 * persists thereafter. Never blocks the UI.
 *
 * Writes are **serialized and coalesced**, and theme and icons deliberately
 * share the one queue. Two reasons:
 *
 * 1. Cycling themes with `t` fires faster than a read-modify-write round-trip
 *    completes, so overlapping writes could land out of order — and with the
 *    `ConfigChanged` bridge feeding the file back into the UI, a stale winner
 *    visibly snaps the theme back.
 * 2. Each write is a read-modify-write of the *whole* config, so a theme write
 *    and an icon write racing on separate queues would clobber one another. One
 *    queue makes that impossible.
 */
function persistAppearance(patch: Partial<Appearance>): void {
  pendingAppearance = { ...pendingAppearance, ...patch };
  if (appearanceWrite) return;
  appearanceWrite = (async () => {
    try {
      while (pendingAppearance !== undefined) {
        const next = pendingAppearance;
        pendingAppearance = undefined;
        const config = await loadConfig();
        const merged = { ...config, ...next };
        // Skip a no-op write: it would fire `ConfigChanged` in every instance
        // for nothing.
        if (merged.theme !== config.theme || merged.icons !== config.icons) {
          await writeConfig(merged);
        }
      }
    } catch (err) {
      pendingAppearance = undefined;
      logger.debug(
        { err: String(err) },
        "appearance not persisted (no config yet)",
      );
    } finally {
      appearanceWrite = undefined;
    }
  })();
}

/** The appearance patch waiting to be written (see {@link persistAppearance}). */
let pendingAppearance: Partial<Appearance> | undefined;
/** The in-flight appearance write, if any — guarantees one writer at a time. */
let appearanceWrite: Promise<void> | undefined;
