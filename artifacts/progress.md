# MCTL — Progress

Baseline state for the next session. What's done, what's half-done and where it stopped, what to pick
up next. Updated at the end of every session that changes code or decisions.

_Last updated: 2026-07-31 (ProgressBar style/variation set)_

---

## Done

- Repo scaffolded from `create-tui`: Bun + `@opentui/core` + `@opentui/react` + React 19.
- `opentui` skill available and vendored under `.claude/skills/opentui/`.
- Planning artifacts written for the TypeScript/OpenTUI stack (plan/architecture/memory/AGENTS).
- **Phase 1 foundation groundwork (this session):**
  - Deps added: `zod` (4.x), `eventemitter3`, `pino` (+ `pino-pretty` dev). `typecheck` script added.
  - `src/lib/paths.ts` — XDG + `$ROOT` resolution. Config/cache/state path helpers (known before
    config loads) + `rootPaths(root, overrides)` for data dirs. **All path building goes through here.**
  - `src/lib/fs.ts` — `writeFileAtomic`/`writeJsonAtomic` (temp + `rename`), `readJsonIfExists`,
    `pathExists`, `ensureDir`, `appendLine` (for `events.jsonl`). Atomic writes support `mode` (0600).
  - `src/lib/logger.ts` — Pino to `~/.local/state/mctl/logs/mctl.log` (NOT stdout — OpenTUI owns the
    terminal). Redacts token/secret/password/*key keys. `log(mod)` for tagged child loggers.
  - `src/types/config.ts` — Zod schemas (source of truth) for `config.json` + `secrets.json`;
    `CONFIG_VERSION = 1`. Composite sections use `.prefault({})` (see memory).
  - `src/core/config/index.ts` — `configExists` (first-run = `config.json` absent), `loadConfig`,
    `loadSecrets` (+ `MCTL_*` env overrides), `writeConfig`, `writeSecrets` (0600, mode verified),
    `resolveRootPaths`, `ensureDirTree`. Typed `ConfigNotFoundError` / `ConfigValidationError`.
  - `src/index.tsx` — argv dispatch: no args → `app/App.tsx renderApp()`; `mctl <cmd>` →
    `cli/router.ts runCli()` (lazy imports keep the paths independent).
  - `src/app/App.tsx` — minimal OpenTUI shell (`renderApp()` owns renderer creation; quit on q/Esc).
  - `src/cli/router.ts` — `help`/`version` real; other commands are honest "not implemented (Phase N)"
    stubs. No fake functionality.
  - Verified: `tsc --noEmit` clean; CLI dispatch paths exercised; a runtime smoke test round-tripped
    config write/reload, first-run detection, 0600 secrets + env override, and the full dir tree.

- **Theming — light/dark schemes (this session):**
  - `Theme.colors`/`ThemeFile.colors` is now a `ThemeColorScheme` = `{ default }` **or** `{ dark, light }`.
    Removed `appearance` from `Theme`/`ThemeSummary`/`ThemeFile`. `resolveColors(scheme, mode)` added.
  - Built-ins `github` + `nord` ship both light and dark palettes. Terminal theme is a `{ default }`.
  - Current mode from `terminalAppearance(palette)` (exported); `use-theme` exposes `colors` (resolved
    flat) + `appearance` (current mode) on the context. `App.tsx` reads `useTheme().colors`.
  - Verified: `tsc --noEmit` clean; headless smoke (both builtins differ light vs dark; terminal default
    resolves identically both modes; appearance light/dark from bg luminance).

- **Theming system (earlier this session):**
  - `src/types/theme.ts` — Zod `ThemeFile`/`ThemeColors` (11 semantic roles, hex-only) + `Theme`,
    `ThemeSummary`, neutral `TerminalPalette` types.
  - `src/core/theme/` — `builtin.ts` (GitHub Dark + Nord, `FALLBACK_THEME`), `terminal.ts`
    (`themeFromTerminalColors`, pure, no OpenTUI import; `TERMINAL_THEME_ID`), `registry.ts`
    (`ThemeRegistry`: built-ins + `~/.config/mctl/themes/*.json`; `load/get/has/list/isDynamic`;
    reserved-id + invalid-file skipping).
  - `config.theme` field (default `"terminal"`) added to `types/config.ts`; read at startup.
  - `src/hooks/use-terminal-colors.ts` — implemented: adapts `renderer.getPalette()` + `theme_mode`/
    `palette` events into `TerminalPalette`; 5s poll fallback that self-cancels on first live event.
  - `src/hooks/use-theme.tsx` — `ThemeProvider` + `useTheme()`; resolves active id (terminal=live,
    else registry, fallback chain). `App.tsx` themed; `t` cycles themes, persists to `config.theme`.
  - `src/lib/fs.ts` — added `readDirIfExists(dir, ext?)`. Dep added: `@types/react@19` (dev).
  - Verified: `tsc --noEmit` clean; headless smoke test (registry list/get, custom+reserved+broken
    files, terminal mapping + null fallbacks, config default/override); TUI mounts and renders themed.

- **Component library — shared UI kit (this session):**
  - `src/components/` now holds the full primitive set, all pure-UI (no I/O), theme-driven
    via `useTheme().colors`, and controlled (value + onChange + `focused`):
    - `support.ts` — `Variant`/`SemanticColor` types, `variantColor`/`onAccent`, `clamp`,
      `optionsFitAsTabs` (the tabs-vs-dropdown width heuristic).
    - `Label.tsx`, `Kbd.tsx` (1-row filled keycap), `Hint.tsx` (row of `[key] label`).
    - `Button.tsx` — variants (primary/secondary/success/warning/error/info/neutral) ×
      kinds (solid/outline/ghost); outline fills on `focused`; Enter/Space when focused.
    - `ProgressBar.tsx` — determinate block bar, `showPercent`.
    - `Breadcrumb.tsx`, `Tabs.tsx` (page tabs, underline marker, ←/→ when focused).
    - `Form.tsx` — `FormField`/`Field` (the rounded frame: **label on top border via
      `title`, hint on bottom border via `bottomTitle`, accent border when focused**),
      `FormGroup`, `Input`, `TextArea`, `Select` (**adaptive: `<tab-select>` when options
      fit, scrollable `<select>` dropdown when not**), `Toggle` (segmented), `Checkbox`,
      `RadioGroup`/`Radio`.
    - `Dialog.tsx` — modal overlay (absolute backdrop with `opacity` + centred box, Esc/
      backdrop-click closes).
    - `index.ts` — barrel for all of the above (+ re-exports MinecraftHead).
    - `Gallery.tsx` — living showcase of every component with a Tab focus ring; mounted in
      `App.tsx` (replaced the MinecraftHead placeholder demo).
  - Verified: `tsc --noEmit` clean; `bun run src/index.tsx` mounts and renders the gallery
    (breadcrumb/tabs/buttons/form frames all draw; terminal theme active).
  - **Mouse focus (this session):** every focusable control gained an `onFocused?: () => void` prop,
    fired on mouse-down so a click moves the page's focus ring to it (`Button`, `Tabs`, `Input`,
    `TextArea`, `Select`, `Toggle`, `Checkbox`, `RadioGroup`). Form controls forward it to `FormField`,
    which owns the `onMouseDown` on its frame (clicks bubble). `Button` fires `onFocused` then `onClick`.
    Gallery wires each ring member's `onFocused → setFocus(id)`. `tsc --noEmit` clean. See `memory.md`
    § Component library for the convention.

- **First-run setup wizard + `mctl init` (this session):**
  - `src/lib/format.ts` — `formatBytes` (binary units). `src/lib/fs.ts` — `diskFree(path)` →
    `{free,total}` via `statfs`, walking up to the nearest existing ancestor (root may not exist yet).
  - `src/hooks/use-focus-ring.ts` — reusable `useFocusRing(ids)`: tracks the focused id, Tab/Shift-Tab
    (and `backtab`) cycle; `isFocused`/`setFocus`/`next`/`prev`. The one focus primitive pages reuse
    (wizard now, Dashboard later). `src/hooks/use-disk-free.ts` — debounced hook over `diskFree`.
  - `src/app/setup/` — the wizard flow:
    - `types.ts` — `SetupDraft` (flat view model), `StepProps`, `STEP_TITLES`, `initialDraft()`.
    - `use-setup.ts` — `draftToConfig()` (pure map, reused by Review preview) + `commitSetup()` +
      `useSetup()` hook (`commit`/`committing`/`error`). Commit = `writeConfig` → `writeSecrets({})` →
      `ensureDirTree`. **The wizard's ONLY I/O goes through this hook** (pages stay UI-free).
    - `Welcome.tsx` (branded splash, `ascii-font font="block"` hero + preview panel), `Stepper.tsx`
      (left progress rail ○/●/✔), `WizardFooter.tsx` (Hint + Back/Continue, buttons own their Enter),
      `StepScaffold.tsx` (title/desc/fields/footer layout).
    - `steps/` — DataRoot (path + live free-space + permanence warning), Paths (optional
      servers/backups overrides, ring adapts to toggles), Defaults (mc/kind/memory/runtime/eula),
      Backup (enable + provider + compression), Network (direct only + pointer to Network page),
      Review (summary panel + Create, shows commit error inline).
    - `SetupWizard.tsx` — container: welcome→6 steps, owns draft + step index + stage keys (Enter
      begins, Esc backs/quits). `index.ts` barrel.
  - `src/app/App.tsx` — split into `App({firstRun})` router + `Dashboard` placeholder; first run
    (config absent, decided in `renderApp`) routes to `<SetupWizard onComplete>` which flips to the
    dashboard in-place. Dropped the MinecraftHead demo grid from the shell.
  - `src/cli/commands/init.ts` + router dispatch — `mctl init` (flags mirror the wizard;
    `--force`/`--json`/`--help`; unknown flag → exit 1; refuses to clobber existing config). Lazy-
    imported so the CLI stays cheap.
  - `src/lib/logger.ts` — pino destination flipped to **`sync: true`** (was async): a fast-failing
    CLI command's `process.exit` was tearing down the async sonic-boom stream before its fd opened
    ("sonic boom is not ready yet"). Sync file writes remove the race (tiny volume, never render path).
  - Verified: `tsc --noEmit` clean; `mctl init` round-trip in a sandbox HOME (config written, secrets
    0600, full dir tree, re-run refused, bad flag → exit 1, `--help`/`--json`); TUI under a pty renders
    the Welcome screen and Enter→step-1 with no runtime errors.

- **Phase 1 completion — registry, session, events, CLI, router (this session):**
  - `src/types/server.ts` — `MctlJson` (`z.looseObject`, future-key safe), `ServerRegistryFile`/
    `ServerRegistryEntry`, `RuntimeSession`, `ServerState` enum, `JavaPin`, and the `Server` view model
    (plain TS interface — `state`/`available` are derived, not stored).
  - `src/types/events.ts` — `MctlEvent` envelope (`{v,id,ts,instance,type,payload}`; `type` open string
    for forward-compat) + `EventType` reference object.
  - `src/core/session/session-manager.ts` — `probe(id)` (pid liveness via `kill(pid,0)`, reaps dead/
    invalid/corrupt descriptors) + `reapStaleLocks()` (sweeps `runtime/*.lock` with dead owner pid).
  - `src/core/registry/server-registry.ts` — `loadRegistry(serversDir)` (read/verify `servers.json`,
    fold in `servers_dir` drop-ins, persist additions atomically, mark unavailable never delete) +
    `addServer`/`removeServer` + `mctlJsonPath`.
  - `src/core/server/discover.ts` — **the shared read path**: `listServers`/`getServer` → `Server[]`
    view models (registry + `mctl.json` + probe). Read-only; `ServerManager` mutations are Phase 2.
  - `src/core/events/` — `bus.ts` (`EventBus`), `instance.ts` (`INSTANCE_ID`), `log.ts`
    (`publish` = append+emit-local; `startTail` re-emits remote lines, skips self), `watch.ts`
    (directory watchers → local `ConfigChanged`/`RegistryChanged`/`ServerStateChanged`), `index.ts`
    (`startEventSystem() → {bus, stop}`).
  - `src/lib/http.ts` — ETag/conditional-GET cache under `~/.cache/mctl/api/`; `fetchText`/`fetchJson`
    (returns `unknown`), TTL fast-path, stale-on-failure, `HttpError`.
  - `src/cli/` — real `list` and `status` (+ `format.ts` table/`--json`), wired in `router.ts`
    (removed from the PLANNED stubs). First-run steers to `mctl init`.
  - **TUI router** — `app/routes.ts` (`NAV`, digits 1–6), `hooks/use-router.tsx` (`RouterProvider`/
    `useRouter`, back-stack), `app/Router.tsx` (shell: top bar + `NavRail` + page host + `Hint`;
    owns global keyboard), `app/NavRail.tsx`, and pages `Dashboard`/`Servers`/`Server`/`Settings` (real)
    + `Jobs`/`Backups`/`Network` (`Placeholder`). Data hooks `use-servers`/`use-config`/
    `use-recent-events`/`use-event-bus`. `App.tsx` now: `renderApp` reaps stale locks + starts the event
    system + injects the bus (`EventBusProvider`), and routes to `<AppRouter/>` post-setup.
  - Verified: `tsc --noEmit` clean; CLI e2e in a sandbox HOME (first-run steer→init, empty list,
    drop-in auto-discovery folded into `servers.json`, `list`/`status`/`--json`); headless smoke (8/8:
    probe alive/dead + reap, unavailable server, stale-vs-live lock reaping, local-publish-once +
    foreign-event-tailed); TUI mounts under a pty (router + Servers nav + quit, no stderr) and the
    first-run wizard still mounts with no config.

- **Box border clipping fix (this session):**
  - `src/components/box-clip-patch.ts` — `installBoxClipPatch()` works around an upstream
    `@opentui/core` 0.4.5 bug where the native `bufferDrawBox` ignores the scissor stack, so bordered
    boxes inside a `<scrollbox>` painted their borders over the top bar / nav rail / hint strip when
    scrolled. Partially-clipped boxes now render through a scratch buffer blitted with
    `drawFrameBuffer` (which respects the scissor); fully-visible boxes keep the native fast path.
    Installed first thing in `renderApp()` (`src/app/App.tsx`).
  - `src/components/box-clip-patch.test.ts` — **first tests in the repo** (`bun test`, script added to
    `package.json`): unclipped boxes render byte-identically (glyphs *and* colours, via `captureSpans`)
    before vs after patching across 10 border/title/background configs; bordered boxes in a scrollbox
    paint nothing outside the viewport at 5 scroll offsets. Verified the second test fails without the
    patch (not vacuous).
  - Verified: `tsc --noEmit` clean; `bun test` 2/2; real app under a pty at 14×80 — Settings scrolled
    with the mouse wheel leaks a stray `│` into the hint strip without the patch, clean with it.

- **NavRail redesign — horizontal tab bar (this session):**
  - `src/app/NavRail.tsx` rewritten to match a user-supplied reference: a row of tabs where the active
    route is a filled primary pill (on-accent bold ink) and the rest are muted text with a faint hover
    wash; digit shortcuts stay as a DIM prefix. Local `NavTab` component owns hover state (a `Button`
    can't do a two-ink chip with a muted resting look). Dividers (`|`) and the inline `MCTL` label are
    gone; the row still scrolls horizontally on narrow terminals.
  - The underline is a **second row of per-tab `<text>` segments** (accent only under the active tab,
    plain elsewhere) rather than a bottom border, which can only be one colour. `tabWidth(item)` sizes
    both the tab and its segment, and segments are `flexShrink={0}`; see `memory.md` for the alignment
    traps. A `flexGrow` + `overflow="hidden"` tail carries the plain rule to the right edge, its run
    length computed from `useTerminalDimensions().width` minus the cells the tabs consume.
  - `src/app/Router.tsx` — the shell frame now carries the screen name on its **top border**
    (`title`, right-aligned, via the existing `titleFor(route)`) and `bottomTitle=" mctl "`, replacing
    the commented-out top-bar block (deleted, along with the then-unused `TextAttributes` import).
  - Verified: `bunx tsc --noEmit` clean; app rendered under a pty at 100×24 and 60×14 and the frames
    replayed — active pill emits a real background SGR, rule and border titles draw, tabs scroll rather
    than wrap when narrow.

- **Phase 1 tail — Settings, key gating, log rotation, watcher fix (this session):**
  - `src/hooks/use-input-capture.tsx` — `InputCaptureProvider` + `useCaptureKeys(active)` +
    `useKeysCaptured()` / `useIsCapturing()`. A counted capture; `isCaptured` is a getter because a
    `useKeyboard` handler closes over its render. Mounted inside `RouterProvider` in `Router.tsx`.
  - `src/app/Router.tsx` — `Esc` handled first (always live), then all character shortcuts
    (digits/`q`/`t`) return early while captured. The hint strip swaps to typing hints. The
    `TODO(phase-1)` is resolved and removed.
  - `src/app/Settings/use-settings.ts` — `SettingsDraft` + `configToDraft`/`draftToConfig` (merge, not
    replace) / `validateDraft` (pure) + the `useSettings` hook (buffered edits, dirty tracking that a
    background `ConfigChanged` can't clobber, `writeConfig` → `ensureDirTree`).
  - `src/app/Settings/index.tsx` — rewritten as the editable form: read-only `root`/`configVersion`,
    servers/backups override toggles + path fields, server defaults, backup policy, network profile,
    theme picker (applies instantly), Revert/Save + **Ctrl+S**, inline validation and save errors.
  - `src/core/events/log.ts` — `trimEventLog()` (>512 KB ⇒ keep the last ~128 KB of whole lines,
    atomic rewrite), called from `startEventSystem()` and opportunistically in the tail's drain; the
    tail's shrink branch now resumes at the new end instead of replaying history.
  - **Watcher fix (real defect):** Bun's `fs.watch` reports a rename under the *source* name only, so
    our atomic writes never matched `config.json` / `servers.json` and **the hard-state watchers never
    fired at all**. `lib/fs.writeFileAtomic` now names its temp file `.<target>.<pid>-<rand>.tmp`
    (`tempNameFor`) and `core/events/watch.ts` resolves it back (`targetOfTempName`).
  - `src/components/Form.tsx` — `FormField` no longer paints the literal `undefined` on its bottom
    border when a field has no hint.
  - Tests added (now 22, 4 files): `core/events/watch.test.ts` (the watcher regression + a negative
    case), `core/events/log.test.ts` (rotation keeps whole lines / tail doesn't replay / self-events
    emit once), `app/Settings/use-settings.test.ts` (draft mapping, merge-not-replace, validation).
  - Verified: `bunx tsc --noEmit` clean; `bun test` 22/22; CLI e2e in a sandbox HOME (first-run steer →
    `init --json` → drop-in discovery → `list` / `status --json` / `help`); TUI under a pty at 120×40
    and 60×20 — Settings renders, Tab reaches the fields, typing `6`/`q` edits instead of navigating or
    quitting, Ctrl+S writes `config.json` (schedule/retention and the extra network profile preserved)
    and the header flips to "saved" via the watcher's `ConfigChanged`.

- **Theme reactivity fix (this session):**
  - `src/hooks/use-theme.tsx` — new `subscribeThemeId` prop (mirror of `onThemeChange`): a bridge for
    theme ids changed outside the provider. Its effect updates local state only, never re-persists.
  - `src/app/App.tsx` — `themeIdSubscriber(bus)` built once in `renderApp()` and passed in: on
    `ConfigChanged` it re-reads `config.theme` and applies it. `persistThemeId` rewritten to serialize
    and coalesce writes (one in-flight write, latest id wins, skip when unchanged) — otherwise a rapid
    `t` cycle's out-of-order write feeds back through the bridge and snaps the theme backwards.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 22/22; pty run in a sandbox HOME — an external
    atomic `terminal`→`nord` edit repaints in Nord, and the same run with the fix stashed produces zero
    new output (non-vacuous). Rapid `t` cycling lands correctly with no snap-back.
  - **Known gap:** the theme *catalogue* (`ThemeRegistry`) is still loaded once at startup — adding or
    editing `~/.config/mctl/themes/*.json` needs a restart.

- **Settings regrouped into tabs with a pinned action bar (this session):**
  - `src/app/Router.tsx` — added `OWN_SCROLL` (a `ReadonlySet<RouteId>`, currently `{settings}`):
    those routes render in a plain padded box instead of the shell's `<scrollbox>`, so a page can
    pin its own chrome and own its scrolling. Every other route is unchanged.
  - `src/app/Settings/index.tsx` — restructured to `PageHeader → Tabs → scrollbox(panel) → action
    bar`. Five groups (`GroupId`): Locations / Defaults / Backups / Network / Appearance; the panel
    is `key={group}` so a tab switch resets scroll. Focus ring is now per-group via
    `ringIds(group, draft)` with the tab bar first (←/→ switch groups). `GROUP_OF_ISSUE` flags a
    group's tab with `" !"` when one of its fields fails validation, so a hidden invalid field can't
    silently disable Save. Section headings dropped (the tab names the group); the config-file path
    moved into Locations as a read-only row. Revert/Save are 1-row `size="small" kind="ghost"`
    buttons in the bottom bar.
  - `src/components/Tabs.tsx` — **restyled to `NavRail`'s design** (2026-07-31): 2-row scrollbox,
    `|` separators, filled-pill active tab with hover wash, per-tab rule segments with `╸`/`╺` caps
    and a counted-out tail to the right edge. Focus still shows as underline weight (`━`/`─`), now
    with the accent blending toward the rule when unfocused. Details in `memory.md`.
    Type-checks clean; **not yet driven in a pty since the restyle** — worth a visual pass on
    Settings at a narrow width (the bar scrolls horizontally rather than wrapping).
  - Verified: `bunx tsc --noEmit` clean; `bun test` 22/22; driven under a pty in a sandbox HOME at
    100×30 and 100×24 — tabs render and ←/→ switch groups, the panel scrolls while the tab bar and
    action bar stay pinned, the focus underline thickens/thins with the ring, emptying *Memory*
    flags `Defaults !` from another tab, toggling EULA + Ctrl+S writes `eula: true` and the header
    flips to "saved", and Dashboard (the scrollbox path) still renders.

- **Toast notifications (this session):**
  - `src/components/Toast.tsx` — pure UI: `ToastCard` (variant-tinted bordered card: icon or
    spinner, bold title, wrapped description, optional action chip with a keycap, optional
    time-to-live meter) and `ToastViewport` (an absolutely-positioned, **content-sized** stack for
    one of six screen anchors). `wrapText` wraps by hand and marks truncation with `…` — terminal
    text does not reflow. Exported from the components barrel.
  - `src/hooks/use-toast.tsx` — `ToastProvider` + `useToast()`. API: `show` (message or options
    object), `info`/`success`/`warning`/`error`/`loading`, `update`, `dismiss`, `dismissAll`, and
    `promise(work, {loading, success, error})`. Per-toast options: `description`, `variant`, `icon`,
    `duration` (0/∞ = sticky; errors and warnings default longer), `delay`, `position`,
    `dismissible`, `progress`, `loading`, `action {label, key, onAction}`, `width`, `onDismiss(reason)`,
    and `id` (re-raising a live id updates it in place). Provider defaults: `position`, `duration`,
    `maxVisible`, `width`, `margin`, `dismissible`, `progress`. Hovering a card pauses its countdown;
    overflow queues rather than evicting; an action key stands down while an input capture is held.
  - `src/app/App.tsx` — `InputCaptureProvider` moved up here from `Router.tsx` (so the wizard is
    covered too) and `ToastProvider` mounted below it, wrapping `<App/>` at the root.
  - `src/app/Settings/` — `save` now resolves the failure message (`string | null`) instead of a
    boolean, and the page's `commit()` toasts "Settings saved" (with the config path) or "Settings
    not saved" with the error and an `r` Retry action.
  - Tests (34 total, 6 files): `components/Toast.test.ts` (wrapping/truncation edge cases) and
    `hooks/use-toast.test.tsx` — the provider mounted in `createTestRenderer` + `createRoot`,
    asserting on real frames: TTL expiry, delay, sticky, queueing past `maxVisible`, description,
    dismissal reasons, and `mockInput.pressKey` driving an action key.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 34/34; a rendered-frame preview of three stacked
    toasts (spinner, wrapped description + action, progress meter) at two positions; and the real
    app under a pty in a sandbox HOME — toggling a Settings field and pressing Ctrl+S wrote
    `config.json` and painted the "Settings saved / Written to …" toast, no errors.

- **ProgressBar styles & variations (this session):**
  - `src/components/ProgressBar.tsx` rewritten around a glyph table: eight track styles
    (`blocks | smooth | shaded | line | smooth-line | dots | segments | ascii`, `PROGRESS_STYLES`;
    `smooth-line` steps the thin rule in halves via `╸`), `value` + `max`
    (default `1`, so old fraction callers are unchanged), `readout` (`none|percent|fraction`) with a
    `format` override and `readoutFirst`, a `label` caption, `brackets`, `tintTrack`, `bold`, `thick`
    (a second `▄` row), colour `thresholds` (a bar that goes success→warning→error as it fills), and
    an `indeterminate` sweep that self-animates at 12 fps unless the caller supplies `frame`.
    `showPercent` stays as a deprecated alias. Layout maths is exported and pure: `fillGlyphs`,
    `indeterminateGlyphs`, `thresholdVariant`.
  - `src/components/index.ts` — the new types and helpers are re-exported from the barrel.
  - `src/components/ProgressBar.test.ts` — 13 new tests (47 total, 7 files): runs always total the
    track width for every style/fraction/frame, sub-cell steps for `smooth` and `smooth-line` (with
    the whole-cell `line` rounding the same fractions up as the contrast), the started/unfinished
    rounding rules, clamping, the sweep bouncing rather than wrapping, and threshold selection.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 46/46; every style rendered through
    `createTestRenderer` and read back from `captureCharFrame()` (the preview script was temporary and
    is deleted). No existing caller changed — Toast's TTL meter still passes `value`/`width`/`variant`.

## In progress

- **⚠ `src/app/test.tsx` is a TEMPORARY toast harness and `App.tsx` currently mounts it instead of
  `<AppRouter />`.** It is a grid of chips raising every toast shape (variants, sticky, delayed,
  promise, wrapping, six anchors, burst/queue, update-in-place, dismiss all) for eyeballing.
  **Before committing: delete `app/test.tsx`, restore `return <AppRouter />;` in `App.tsx`, and drop
  its import.**
- Nothing else mid-implementation. All the above compiles, tests, and runs.

## Next up (Phase 2)

1. `ServerProvider` + `InstallStrategy`; Vanilla and Paper (directJar) against recorded fixtures.
2. Java resolution + Adoptium download (`lib/http.ts` gets its first real use), manual-pin prompt.
3. Foreground runtime; console and log streaming.
4. Create / delete / edit servers — the mutating `ServerManager` alongside the read-only
   `core/server/discover.ts`, in both front-ends.

## Demo / scratch

- **`components/MinecraftHead.tsx`** — Renders a Minecraft head into an 8×4-cell FrameBuffer via
  half-block glyphs. A FrameBuffer showcase, not dashboard code; **no longer mounted anywhere** (App now
  routes wizard-or-`Dashboard` placeholder) but still exported from the barrel. Technique in `memory.md`.
- **`Gallery.tsx` no longer exists** — the component showcase was removed; verify the UI kit by running
  the wizard (it exercises Input/Select/Toggle/Checkbox/RadioGroup/Button/Hint/FormField in anger).

## Notes for the next agent

- **Do not scaffold empty phase-2+ folders** (providers, backups, network). Build per roadmap phase.
- **Statelessness is non-negotiable:** never cache an authoritative server set; recompute from disk +
  `runtime/<id>.json` probes. Cross-instance sync = `fs.watch` + `events.jsonl` tail, no IPC/daemon.
- **JSON/JSONL only** — no TOML anywhere. `mctl.json`, `config.json`, `secrets.json`, `events.jsonl`.
- Pages live in `src/app/`, not `src/pages/`. CLI in `src/cli/`.
- Registry + statelessness invariants live in `architecture.md` — read before touching discovery/session.
- Verify with `bunx tsc --noEmit` (or `bun run typecheck`), `bun test`, and `bun run dev`. Tests must
  live **inside `src/`** (a file outside it resolves a different copy of `@opentui/core`). Registry and
  session still have no unit tests — prime candidates when Phase 2 touches them.
- **Path discipline:** never build an MCTL path by hand — call a `lib/paths.ts` helper. Never read/write
  a shared JSON file directly — go through `lib/fs.ts` (atomic) and validate with Zod.
- Config service already exposes everything the wizard/`init` need: `writeConfig`, `writeSecrets`,
  `ensureDirTree`, `resolveRootPaths`. Don't re-implement writing in the front-end.
