# MCTL — Progress

Baseline state for the next session. What's done, what's half-done and where it stopped, what to pick
up next. Updated at the end of every session that changes code or decisions.

_Last updated: 2026-08-03 (negative/terminal-relative dimensions; Dashboard/Servers merge; Phase 2)_

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
    `use-event-bus`. `App.tsx` now: `renderApp` reaps stale locks + starts the event
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

- **`Select` width measurement fixed (this session):**
  - `src/components/Form.tsx` — the adaptive `Select` never measured itself: the `ref` it watched was
    attached only in the *tabs* branch, which the initial `w = 0` never selects, so a flex-sized
    (`width="100%"`/`"auto"`) Select was permanently a dropdown. It also listened for the wrong thing
    via a stray `console.log` (swallowed under OpenTUI).
  - Added module-local `useBoxWidth(ref)` (documented: `"resize"` is the *renderable's* event;
    `"resized"` is the root's) and rewrote `Select` to render **one** `FormField` — ref always
    attached — branching only on the child control. While unmeasured it falls back to a numeric
    `width` prop, so fixed-width fields pick the right layout on frame one.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 47/47; rendered through `createTestRenderer` at
    outer widths 60 and 30 — 60 ⇒ tabs, 30 ⇒ dropdown, for both a fixed-width and a flex-sized field.
    Non-vacuous: with the fix stashed, the flex-sized field at width 60 still rendered as a dropdown.

- **`ScrollBox` wrapper + shell scroll acceleration (this session):**
  - `src/components/ScrollBox.tsx` (+ barrel export) — a pass-through wrapper around the
    `<scrollbox>` intrinsic: every prop and the `ref` are forwarded untouched, and it adds one prop,
    `enableAccel`, which supplies a stable `MacOSScrollAccel`. **Every `<scrollbox>` in `src/` was
    replaced by it** — `Router.tsx`, `NavRail.tsx`, `Settings/index.tsx`, `components/Tabs.tsx`, and
    both in `setup/SetupWizard.tsx`. Nothing renders the intrinsic directly any more.
  - **Acceleration is enabled only on the shell page host** in `src/app/Router.tsx`; the tab strips,
    the Settings panel and the wizard stay linear (see `memory.md` § Scroll acceleration for why).
  - `src/components/ScrollBox.test.tsx` — 3 tests (50 total, 8 files): props/children/`ref` reach the
    real `ScrollBoxRenderable`, the default is `LinearScrollAccel` vs `MacOSScrollAccel` with
    `enableAccel`, and a 30-notch synthetic wheel burst travels 30 rows linear vs ~175 accelerated.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 50/50; driven under a pty at 100×30 in two sandbox
    HOMEs — the first-run wizard's welcome renders, and with a config the NavRail bar, Servers, and
    Settings (its `Tabs` strip + scrolling panel) all draw with no errors.

- **Icon sets — Nerd / Unicode / ASCII (this session):**
  - `src/types/icons.ts` — `IconSet` (`nerd | unicode | ascii`), `ICON_SETS`, the `IconName` union
    (~40 semantic names: status, server state, selection controls, stepper, chrome, arrows, rules,
    domain), `IconMap`.
  - `src/core/icons/` — `catalogue.ts` (`ICONS`, the exhaustive `IconName × IconSet` glyph table;
    `SPINNERS`; memoized `iconsFor` / `spinnerFor`), `detect.ts` (`resolveIconSet(mode, env)` —
    pure over an env record; `detectIconSet`, `hasNerdFont`, `hasUtf8Locale`, `parseIconSet`;
    `MCTL_ICONS` override), `index.ts` barrel. Nerd glyphs are `\u{…}` escapes with their upstream
    Font Awesome names in comments, so the table is readable without a patched font.
  - `src/types/config.ts` — `IconMode` (`auto | nerd | ascii`) + `config.icons` (default `"auto"`),
    sitting beside `theme`. `core/config/index.ts` — `MCTL_ICONS`/`MCTL_NERD_FONT` added to
    `RESERVED_ENV` so they are settings, not secrets.
  - `src/hooks/use-icons.tsx` — `IconProvider` + `useIcons()`, mirroring `use-theme`'s
    `onModeChange` / `subscribeMode` prop pair. `useIcons()` returns the auto-detected set instead
    of throwing when no provider is mounted (see `memory.md` for why it diverges from `useTheme`).
  - `src/app/App.tsx` — `IconProvider` mounted beside `ThemeProvider`; `loadThemeId` →
    `loadAppearance()`, `themeIdSubscriber` → generic `configSubscriber(bus, select)`, and
    `persistThemeId` → **`persistAppearance(patch)`: one shared write queue for theme + icons**
    (each is a read-modify-write of the whole config, so separate queues would clobber).
  - `src/app/Settings/` — Appearance group gains an Icons `RadioGroup` (auto/nerd/ascii), a hint
    naming the *resolved* set, a live glyph preview row, and an honest note about panel borders in
    ascii mode. `save(themeId, iconMode)` now carries both live provider-owned values.
  - Call sites converted off hardcoded glyphs: `Toast` (variant icons → `TOAST_ICON_NAMES`, close,
    spinner, `wrapText` ellipsis param), `use-toast` (spinner frames from the set), `Form`
    (Checkbox/RadioGroup/Radio markers, option-description separator), `Hint`, `Tabs` + `NavRail`
    (the rule/cap glyphs — `BORDER_CHARS` deleted from both), `Stepper`, `Welcome` (feature icons
    are `IconName`s now), `WizardFooter`, `DefaultsStep`, `ReviewStep`, `SetupWizard`, `Router`,
    `Dashboard`, `Servers` (+ `cell()` takes the ellipsis), `Server`, and `shared.tsx`
    (new `serverStateIcon(state)` beside `serverStateColor`).
  - Tests (76 total, 9 files): `core/icons/detect.test.ts` — 26 tests over locale/font heuristics,
    override precedence, and catalogue invariants (every set defines every name; ASCII is 7-bit;
    every glyph is single-cell bar the two documented exceptions; nothing is East-Asian Wide;
    `iconsFor` is memoized). `Settings/use-settings.test.ts` updated for the new `save` arity plus
    a case proving the icon mode comes from the argument, not a stale config.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 76/76; the real app driven under a pty at
    110×30 in a sandbox HOME at all three sets — `unicode` draws `━╸╺` rules / `▸ survival` /
    `○ stopped` / `1 … 6 · Enter`, `ascii` draws `==-==` rules / `> survival` / `. stopped` /
    `1 ... 6 | Enter` / `^/v move`, and `nerd` emits the PUA codepoints. `mctl init` writes
    `"icons": "auto"`.
  - **Not verified:** the Settings Appearance picker itself was never driven to completion under a
    pty — the scripted run hung and was killed, so `config.icons` was still `"auto"` afterwards.
    The wiring type-checks and the persist path is shared with the theme picker, but *picking a
    mode in the UI and seeing it written* is unconfirmed. Do this first next session.

- **Phase 2 — server lifecycle (this session):** all four roadmap bullets landed.
  - **Types:** `types/install.ts` (`InstallStrategy` — `directJar` today, tagged for Phase 3;
    `LaunchSpec`; `VersionInfo`/`LoaderVersion`/`InstallRequest`), `types/java.ts`
    (`JavaRequirement`, `JavaInstallation`, `LTS_MAJORS = [25,21,17,11,8]`), `types/provider.ts`
    (`ServerProvider`, `RuntimeProvider`, `LaunchContext`). `MctlJson.kind` **relaxed to a free
    string** (the registry is the authority); `ServerKind` enum grew `paper` and now bounds only the
    settings/wizard picker. New event types: `ServerCreated/Deleted/Edited`, `JobProgress`,
    `JobFinished`, `JavaInstalled`.
  - **`core/registry/provider-registry.ts`** — `ProviderRegistry` (instance, not singleton) +
    typed `UnknownProviderError`. **`providers/index.ts`** `createProviderRegistry()` is the single
    wiring point, called by both front-ends.
  - **Providers:** `providers/server/vanilla.ts` (Mojang manifest → per-version package JSON; sha1;
    no server jar before 1.2.5) and `providers/server/paper.ts` (**`fill.papermc.io/v3`** — not
    `api.papermc.io`; sha256; the only Phase-2 kind declaring a real Java *range*).
  - **`lib/shell.ts`** (`run`, `which`) and **`lib/download.ts`** (streaming download → sibling temp
    file, sha256+sha1 hashed in one pass, `rename` only after the digest matches, throttled progress).
  - **`core/java/`** — `detect.ts` (probes every candidate with
    `java -XshowSettings:properties -version`; managed/`$JAVA_HOME`/`$PATH`/system; memoized incl.
    failures), `adoptium.ts` (Temurin resolve + download + `tar --strip-components=1` into
    `$ROOT/java/temurin-<major>`), `java-manager.ts` (`resolveJava`, plus the **pure, exported**
    policy `chooseInstalled`/`preferredMajor`).
  - **`core/jobs/`** — `JobScheduler`: `run(spec, work)` → `{job, result}`, `list`/`active`/`cancel`,
    `JobContext.step/progress/signal`. Progress local-bus only; `JobFinished` published.
  - **`core/server/install.ts`** (`executeInstall` + `writeEulaAcceptance`) and
    **`core/server/manager.ts`** (`ServerManager`: staged create, merge-not-replace edit, guarded
    delete; `idFromName`; typed `ServerOperationError`).
  - **`core/session/lock.ts`** — `withServerLock` via atomic `open(…, "wx")`, stale-owner reclaim.
  - **`providers/runtime/foreground.ts`** + **`core/runtime/index.ts`** — spawn with `cwd` = server
    dir, capture to `~/.local/state/mctl/console/<id>.log`, descriptor write, three-tier stop
    (console `stop` → SIGTERM → SIGKILL), cross-instance `logs`/`stop`/`status`,
    `SessionNotOwnedError` for foreign `exec`. `RuntimeManager` owns provider+Java resolution, the
    lock, `heapArgs`, and `restart`.
  - **`core/context.ts`** — `createContext(providers, bus)`, the shared object graph.
  - **CLI:** `cli/args.ts` (flag parser), `cli/context.ts`, and commands `create`, `edit`, `delete`,
    `start`, `stop`, `restart`, `logs`, `exec`, `java list|install`. Router rewired; only
    `backup`/`restore` remain honest Phase-4 stubs.
  - **TUI:** `hooks/use-mctl.tsx` (the mutating-core bridge, rebuilt on `ConfigChanged`),
    `hooks/use-jobs.ts`, `hooks/use-console.ts`; pages `app/ServerCreate/` (form + live job progress)
    and `app/Console/` (auto-scrolling output + command input); `app/Server/` gained a
    focus-ringed action bar (Start/Stop/Restart/Console/Remove) and a delete confirmation `Dialog`;
    `app/Jobs/` is now real; the server list gained `n` (new) and `c` (console) — that list now lives
    on the Dashboard, see the entry above. Routes `create`/`console` added (not in `NAV`); `console`
    joined `OWN_SCROLL`.
  - Tests (**127 total, 13 files**, +51): `core/java/java-manager.test.ts` (selection policy incl.
    the LTS ceiling), `cli/args.test.ts` (incl. the `--java 21` / `--no-java` regression),
    `core/session/lock.test.ts` (exclusion, stale reclaim, release-on-throw),
    `core/server/manager.test.ts` (19 cases: create/edit/delete end-to-end against a temp `$HOME`
    with a stub provider over `file://` — no network).
  - **Verified for real, not just typed:** `bunx tsc --noEmit` clean; `bun test` 127/127.
    In a sandbox `$HOME`: `mctl create --kind paper --mc 1.21.4` downloaded and sha256-verified the
    51 MB Paper jar, wrote `mctl.json` + `eula.txt`, and registered the location; `mctl start`
    booted Paper to `Done (16.955s)`; `mctl logs -n` tailed it; `mctl exec` **from a second
    instance** correctly refused with `SessionNotOwnedError`; `mctl stop` **from a second instance**
    stopped it gracefully in 7.4 s; `mctl java install 21` fetched, verified and extracted Temurin
    21.0.12. Guards checked: duplicate id, `--files` without `--yes` (exit 2), unknown flag (exit 2),
    `exec` on a stopped server, idempotent `stop`. Under a pty at 120×44: the create form filled and
    submitted, painted `Resolving · paper 1.21.4` / `Writing configuration` with a progress bar,
    toasted `Created tui-made`, and navigated to the detail page; **Start** (keyboard) launched it on
    the *managed* Java 21, the Console page streamed live output, and **Stop** brought it down.

- **Drag-selection made opt-in (2026-08-03).** `src/components/selection-opt-in.ts` →
  `installSelectionOptIn()`, called in `renderApp()` next to `installBoxClipPatch()`. Replaces the
  blanket `renderer.startSelection = () => {}`, which had disabled selection everywhere including
  where it was wanted. Now `<text selectable>` (the console log lines) selects and everything else
  ignores drag. Verified at runtime against the real catalogue: `text` → `false` by default, `true`
  with the prop, `false` with `selectable={false}`; `box`/`input` unaffected. `bunx tsc --noEmit` clean.

- **Dashboard absorbed the Servers screen (this session, user request).**
  - `src/app/Dashboard/index.tsx` rewritten: summary tiles → column header → server rows, with the
    **selected row expanding in place** (name/loader/java/memory/network/path + pid/port/startedAt when
    running, and an `Enter/c/n` hint). Keeps the old list's keyboard (↑/↓ or j/k, Enter open, `c`
    console, `n` new). The Recent Activity feed is gone.
  - **Deleted:** `src/app/Servers/` and `src/hooks/use-recent-events.ts` (its only consumer).
  - `app/routes.ts` — `servers` removed from `RouteId` and `NAV`; digits renumbered **1–5**.
    `app/Router.tsx` — page switch + import dropped, hint strip now `1 … 5`. `app/NavRail.tsx` —
    `server`/`console`/`create` all light the **Dashboard** tab. `navigate("servers")` →
    `navigate("dashboard")` in `app/Server/` and `app/ServerCreate/`.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 127/127 (no test referenced the Servers page);
    driven under a pty at 110×40 in a sandbox `$HOME` with two discovered servers — the rail shows the
    five renumbered tabs, the table renders, `j` moves the caret and the expansion follows it, `2`
    reaches Jobs and `1` returns to the Dashboard.

- **Terminal-relative dimensions — negative width/height (2026-08-03, user request).**
  - `src/components/negative-dimension-patch.ts` → `installNegativeDimensionPatch()`, installed in
    `renderApp()` beside the other two patches. A negative `width`/`height` on any JSX element now
    means `terminal size - n` (`<box width={-4}>` = terminal width minus 4), clamped at 0 and
    **re-resolved on every terminal resize**. Two seams: the React component catalogue (upstream's
    constructor `validateOptions` *throws* on a negative before any prototype method runs) and the
    `Renderable.prototype` `width`/`height` accessors (the reconciler applies prop updates as plain
    assignments). Tracked renderables are dropped on `"destroyed"` or when set to a non-negative.
  - `src/components/selection-opt-in.ts` — now wraps `getComponentCatalogue()` instead of
    `baseComponents`, so the two catalogue patches compose in either order instead of the second
    `extend()` silently replacing the first. **This is a rule for any future catalogue patch.**
  - `src/components/negative-dimension-patch.test.tsx` — 7 tests (134 total, 14 files) mounting real
    JSX through `createRoot` + `createTestRenderer`: construction, prop-update assignment, resize
    tracking in both directions, opting back out, the positive/`auto`/`%` control, the clamp, and an
    unmounted renderable leaving the sweep. Installs both catalogue patches together, so it also
    guards their composition.
  - Verified: `bunx tsc --noEmit` clean; `bun test` 134/134; **non-vacuous** — with the install
    commented out 6 of the 7 fail (the untouched-dimensions control still passes, as it should).
    A runtime check through the real reconciler confirmed both patches at once
    (`width={-4}` → 36 at a 40-cell terminal, `<text>` non-selectable, `<text selectable>` selectable).
    The real app driven under a pty at 100×30 in a sandbox `$HOME` renders the rail, tiles and table
    with no stderr.

## In progress

- Nothing mid-implementation. All the above compiles, tests, and runs.

## Next up (Phase 3)

1. Fabric and Quilt (`loaderJar`); Forge and NeoForge (`installer` → `argFile`/`script`) — the
   `InstallStrategy`/`LaunchSpec` unions are tagged and `executeInstall` has an exhaustiveness guard,
   so each is additive.
2. Purpur, Velocity (both `directJar` — cheap once the loaders are in).
3. **tmux runtime** (detached, re-attachable). This is what removes the foreground runtime's two
   limitations: servers dying with the TUI, and `exec` only working from the owning process. It also
   unblocks the `TODO(phase-3)` in `core/session/session-manager.ts` (confirm the tmux session /
   docker container exists, not just the pid).
4. Staged installs with **resume** (the staging dir is already per-uuid; nothing resumes yet).

## Demo / scratch

- **`components/MinecraftHead.tsx`** — Renders a Minecraft head into an 8×4-cell FrameBuffer via
  half-block glyphs. A FrameBuffer showcase, not dashboard code; **no longer mounted anywhere** (App now
  routes wizard-or-`Dashboard` placeholder) but still exported from the barrel. Technique in `memory.md`.
- **`Gallery.tsx` no longer exists** — the component showcase was removed; verify the UI kit by running
  the wizard (it exercises Input/Select/Toggle/Checkbox/RadioGroup/Button/Hint/FormField in anger).

## Known gaps / carried forward

- **The Settings → Appearance icon picker still has not been driven to completion under a pty**
  (carried from last session; the scripted run hung and was killed). The wiring type-checks and
  shares the theme picker's persist path, but *picking a mode in the UI and seeing `config.icons`
  written* remains unconfirmed.
- **The theme *catalogue* is still loaded once at startup** — adding or editing
  `~/.config/mctl/themes/*.json` needs a restart.
- **`mctl create` has no version picker in either front-end.** Both take a free-text version and fall
  back to the kind's newest release. Listing versions is a network round-trip per kind and would make
  the form unusable offline; revisit if users ask.
- **The TUI create form does not offer a Java pin.** If nothing installed satisfies the requirement it
  downloads a JDK inside the create job, which can be a ~200 MB step with only a progress bar to show
  for it. The CLI has `--java <major>` / `--no-java`; the form does not.
- **A `{pinned}` Java that is not installed is fetched silently** during create/start. That is the
  right default, but there is no "ask first" prompt in the TUI (the `autoInstall: false` path exists
  in `resolveJava` and is unused by the UI).
- **`ServerProvider` implementations are not tested against recorded fixtures yet.** AGENTS.md asks
  for this; the manager tests use a stub provider instead, and Vanilla/Paper were verified live.
  Recording the three Paper endpoints and the two Mojang hops is the obvious next test.

## Notes for the next agent

- **Do not scaffold empty phase-3+ folders** (backups, network). Build per roadmap phase.
- **Statelessness is non-negotiable:** never cache an authoritative server set; recompute from disk +
  `runtime/<id>.json` probes. Cross-instance sync = `fs.watch` + `events.jsonl` tail, no IPC/daemon.
- **JSON/JSONL only** — no TOML anywhere. `mctl.json`, `config.json`, `secrets.json`, `events.jsonl`.
- Pages live in `src/app/`, not `src/pages/`. CLI in `src/cli/`.
- Registry + statelessness invariants live in `architecture.md` — read before touching discovery/session.
- Verify with `bunx tsc --noEmit` (or `bun run typecheck`), `bun test`, and `bun run dev`. Tests must
  live **inside `src/`** (a file outside it resolves a different copy of `@opentui/core`). The
  location registry itself still has no direct unit test, though `core/server/manager.test.ts` now
  exercises it end to end.
- **Isolating state in a test is just XDG env vars** — `lib/paths` reads them on every call, so
  pointing `XDG_STATE_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` at a temp dir in `beforeEach` isolates
  the whole tree (see `core/server/manager.test.ts`, `core/session/lock.test.ts`).
- **Driving the TUI under a pty:** prefix with `stty rows N cols M`; `script` ignores `COLUMNS`/`LINES`
  and inherits the parent's size, silently hiding anything below the fold.
- **Adding a provider is one file plus one line** in `providers/index.ts`. Nothing in `core/` changes.
  `executeInstall`'s exhaustiveness guard will fail the build until the new strategy has a case.
- **Path discipline:** never build an MCTL path by hand — call a `lib/paths.ts` helper. Never read/write
  a shared JSON file directly — go through `lib/fs.ts` (atomic) and validate with Zod.
- Config service already exposes everything the wizard/`init` need: `writeConfig`, `writeSecrets`,
  `ensureDirTree`, `resolveRootPaths`. Don't re-implement writing in the front-end.
