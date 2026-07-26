# MCTL — Cross-Session Memory

Decisions, gotchas, and user preferences that don't live in the code. Append-light, prune-heavy —
delete entries that stop being true. Newest-relevant first.

---

## Stack & direction

- **Stack is TypeScript + OpenTUI on Bun**, not Rust/Ratatui. The Rust plan's *architecture* (provider
  separation, filesystem-as-truth, event bus, jobs) carries over; the language and crate layout do not.
  UI is React-style via `@opentui/react`.
- Use the **`opentui` skill** before any TUI work. No Rust/Ratatui skill is in play.
- Dependencies today: `@opentui/core`, `@opentui/react`, `react` 19. Bun runtime; `bun run dev` only
  script so far. Codebase is still the starter template.

## Phase 1 implementation decisions (2026-07-25)

- **Zod is v4** (`zod@4.x`). In v4, `z.object(...).default({})` type-checks the argument against the
  schema's **output** type, so `.default({})` fails when nested fields have their own defaults. Use
  **`.prefault({})`** (input-side default) for composite sections instead — see
  `types/config.ts` (`defaults`/`backup`/`network`).
  - **How to apply:** for any object field whose sub-fields all have defaults, wrap with `.prefault({})`,
    not `.default({})`.
- **Config JSON key naming:** `servers_dir` and `backups_dir` stay **snake_case** because `plan.md`
  documents them verbatim as `config.servers_dir` / `config.backups_dir` (a published contract).
  Everything else in config is camelCase (`configVersion`, `defaultProfile`, …). Intentional exception,
  not drift.
- **Secrets + env override convention:** secret keys are **UPPER_SNAKE** (e.g. `CLOUDFLARE_TOKEN`); the
  env override is `MCTL_<KEY>` (`MCTL_CLOUDFLARE_TOKEN`). `loadSecrets()` overlays *all* `MCTL_*` env
  vars except a reserved set (`MCTL_LOG_LEVEL`). `secrets.json` is written `0600` and the mode is
  re-`stat`'d and enforced after writing.
- **Logger writes to a FILE, never stdout** (`~/.local/state/mctl/logs/mctl.log`) because OpenTUI owns
  the terminal in TUI mode — console output corrupts the render. Level via `MCTL_LOG_LEVEL`. Pino
  `redact` masks credential keys as defence-in-depth (real rule: don't pass secrets to the log at all).
- **argv dispatch uses lazy `import()`** in `src/index.tsx` so the CLI path never loads OpenTUI and the
  TUI path never loads the CLI router.
- **CLI stubs are honest:** unimplemented commands print "not implemented yet (Phase N)" and exit 1 —
  no silent no-ops. `help`/`version` are the only real commands so far.
- `renderApp()` in `app/App.tsx` owns renderer creation + mount; `index.tsx` stays a pure dispatcher.

## First-run wizard + `mctl init` (2026-07-25)

- **Focus is page-owned via `useFocusRing(ids)`** (`hooks/use-focus-ring.ts`) — OpenTUI has no global
  focus manager, so a page tracks the active control id and cycles it. **Tab / Shift-Tab** move the ring
  (handle both `name:"tab"`+`shift` *and* a distinct `name:"backtab"`); the hook exposes
  `isFocused/setFocus/next/prev`. Convention: pass `focused={ring.isFocused(id)}` + `onFocused={()=>ring.setFocus(id)}`
  to each control, and `<Input onSubmit={()=>ring.next()}>` so Enter advances fields. This is THE focus
  primitive for pages going forward (Dashboard/Settings reuse it). Ring `ids` may change between renders
  (conditional fields) — index is clamped, so a step whose ids depend on a toggle (`PathsStep`,
  `BackupStep`) just recomputes the array.
  - **How to apply:** buttons already own their Enter/Space (guarded by `focused`), so the ring needs no
    button-key logic — just give the focused Button `focused` + `onClick`.
- **Wizard = welcome splash + 6 steps** in `src/app/setup/` (`SetupWizard.tsx` container). Container owns
  the `SetupDraft` (a **flat view model**, NOT the config shape — paths carry explicit override toggles,
  optional fields are "" = use default), the step index, and stage keys (**Enter begins on welcome only;
  Esc quits from welcome, else steps back**). Steps are self-contained: each owns its ring + renders its
  fields + a `WizardFooter`. Container renders `<box key={step}>` so each step **remounts fresh** (ring
  resets to field 0).
- **The wizard's only I/O is `useSetup().commit`** (`app/setup/use-setup.ts`): `draftToConfig` (pure,
  also used by the Review step to preview) → `writeConfig` (Zod fills defaults + validates) →
  `writeSecrets({})` (empty 0600) → `ensureDirTree`. Pages never call `core/config` directly; only this
  hook does. `commit` carries the **current `themeId`** into config so a theme cycled during setup sticks.
- **App routing:** `renderApp()` decides `firstRun = !(await configExists())` once and passes it to
  `<App firstRun>`. `App` renders `<SetupWizard onComplete={()=>flip}>` until setup writes config, then
  the `Dashboard` placeholder — **in-place, no restart**. The old MinecraftHead demo grid is gone.
- **`mctl init` mirrors the wizard headlessly** (`cli/commands/init.ts`, lazy-imported from the router).
  Flags map 1:1 to draft fields; unset → schema defaults (so bare `mctl init` writes a full default
  config at `~/.mctl`). `--force` to overwrite, `--json`, `--help`; unknown flag → exit 1. Validation is
  the schema's job (bad kind/relative root → typed `ConfigValidationError`), not the parser's.
- **Logger flipped to `sync: true`** (`lib/logger.ts`): a fast-failing CLI command's `process.exit`
  (index.tsx:19) tore down the **async** sonic-boom stream before its fd opened → "sonic boom is not
  ready yet" stack dump on stderr. Sync file writes remove the race; volume is tiny and it's never the
  render path, so sync is fine. (Supersedes the earlier `sync:false`.)
- **`ascii-font` font names** are `tiny | block | shade | slick | huge | grid | pallet` (from
  `@opentui/core/lib/ascii.font.d.ts`). Welcome hero uses `font="block"` with a 2-colour gradient
  (`color={[primary, secondary]}`). `<ascii-font>` colours via `color`, not `fg` (already in gotchas).
- **`lib/fs.diskFree(path)`** walks up to the nearest existing ancestor before `statfs` (the chosen root
  usually doesn't exist yet) → `{free,total}` bytes; `undefined` on failure (never throws). `useDiskFree`
  hook debounces it 150ms. `lib/format.formatBytes` humanizes (binary units, "—" for non-finite).

## Phase 1 completion — registry, session, events, router (2026-07-26)

- **`core/server/discover.ts` is THE shared server read path** — `listServers(serversDir)` /
  `getServer(id, serversDir)` combine registry + each `mctl.json` + a live session probe into
  `Server` view models. Both the CLI (`list`/`status`) and the TUI (`useServers`/`useServer`) call
  it, so neither front-end holds logic the other lacks. **Read-only**; the mutating `ServerManager`
  (create/delete/edit + install strategies) is Phase 2. Re-derived from disk every call — no cache.
  - One bad server never breaks the list: unreadable/invalid `mctl.json` or missing path → a minimal
    `unavailable` view model (kind/mc/etc = "—"), not a throw.
- **`types/server.ts`:** `MctlJson` is a **`z.looseObject`** (unknown/future keys preserved so a
  server made by a newer MCTL survives a read round-trip). `RuntimeSession` (`runtime/<id>.json`) and
  the `servers.json` file schemas are strict `z.object`. `ServerState` = `running|stopped|unavailable|
  unknown`. The `Server` **view model is a plain TS interface** (derived), not Zod — `state`/`available`
  are computed, never stored.
- **Session probe (`core/session/session-manager.ts`):** liveness via `process.kill(pid, 0)` —
  no-throw or `EPERM` = alive, `ESRCH` = dead. `probe(id)` reaps dead/invalid/corrupt descriptors so a
  crashed server never lingers "running". `reapStaleLocks()` sweeps `runtime/*.lock` whose owner pid is
  dead (lock body is JSON `{pid}` or a bare int); called once in `renderApp()` before any read. tmux/
  docker session-existence check is a `TODO(phase-3)` — pid is the only signal today.
- **Event system (`core/events/`), 4 files + barrel:**
  - `EventBus` (EventEmitter3, single `"event"` channel, `emit`/`subscribe→unsub`/`clear`).
  - `INSTANCE_ID` = one `randomUUID()` per process (not persisted; identity is per-run).
  - `publish(bus, type, payload)` = **append to `events.jsonl` + emit locally**; the tail then skips
    lines whose `instance === INSTANCE_ID`, so an instance never double-processes its own events.
  - `startTail(bus)` records the current EOF and re-emits only *new remote* lines (no history replay);
    `fs.watch` for immediacy + a 1 s poll fallback; detects truncation by size shrink.
  - **Watchers watch DIRECTORIES, not files** (`configDir`/`stateDir`/`runtimeDir`) — atomic writes
    (`temp+rename`) change the inode, so a file-bound watch goes stale after the first write. They emit
    **local-only** `ConfigChanged`/`RegistryChanged`/`ServerStateChanged{id}` (not `publish` — the
    change was already made by whoever caused it). Debounced 60 ms per filename.
  - `startEventSystem()` → `{ bus, stop }`, wired in `renderApp()`; `EventBusProvider` injects the bus.
    Stopped on the renderer's `"destroy"` event.
  - **Wizard/`init` config writes need no explicit emit** — the config-dir watcher fires `ConfigChanged`
    automatically, so `useConfig`/`useServers` refresh. (Supersedes progress.md's earlier "wire a
    ConfigChanged emit into the wizard" note — the watcher covers it.)
  - `MctlEvent` envelope (`types/events.ts`): `{v,id,ts,instance,type,payload}`. `type` is an **open
    string** (forward-compat: an unknown event type from a newer instance must not break the tail);
    `EventType` is a reference object, not a closed union.
- **TUI Router (`src/app/`):** in-memory router (no URL). `hooks/use-router.tsx` = `RouterProvider` +
  `useRouter()` (route + params + `navigate`/`back`/`canBack`, with a back-stack). `app/routes.ts` =
  `RouteId` + `NAV` (dashboard/servers/jobs/backups/network/settings, digits 1–6; `server` detail is
  NOT in NAV — reached from Servers with a `serverId` param). `app/Router.tsx` = the shell (top bar +
  `NavRail` + page host + `Hint` strip) and owns the **global keyboard**: digit→route, `Esc`=back-else-
  quit, `q`=quit, `t`=cycle theme. `App.tsx` renders `<AppRouter/>` post-setup.
  - **Digit-nav is global and safe ONLY while no router-reachable page mounts a live text input**
    (typing a digit would navigate away). Phase-1 pages are read-only in that respect (Settings is a
    read-only config view for now). `TODO(phase-1)`: gate digit-nav while an input is focused when the
    editable Settings form lands.
  - Real pages: `Dashboard` (server-count tiles + recent-activity feed from `useRecentEvents`),
    `Servers` (live list, ↑/↓/j/k + Enter/click → detail), `Server` (read-only detail via `useServer`),
    `Settings` (read-only config). `Jobs`/`Backups`/`Network` = honest `Placeholder` (phase-noted).
  - Data hooks (`hooks/`): `use-servers` (`useServers`/`useServer`), `use-config`, `use-recent-events`,
    `use-event-bus` — all re-run the core read path on invalidating bus events, holding no authoritative
    state. `use-event-bus`/`use-router` are `.tsx` (they hold JSX providers).
- **`lib/http.ts` — ETag cache** (Phase-1 tail; first real use is Phase-2 downloads). One JSON file per
  URL under `~/.cache/mctl/api/<sha256(url)[:32]>.json` = `{url,etag,lastModified,fetchedAt,body}`.
  Within `ttlMs` (default 5 min) serves cache with **no** network call; else conditional GET
  (`If-None-Match`/`If-Modified-Since`), `304` refreshes the timestamp, `200` restores body+validators.
  Serves **stale on network failure**; throws `HttpError` only when nothing is cached. `fetchJson`
  returns `unknown` — caller Zod-validates.

## OpenTUI gotchas (added 2026-07-26)

- **Box border *sides* are `border={["top"|"right"|"bottom"|"left"]}`** — `border?: boolean |
  BorderSides[]`. There is **no** `borderTop`/`borderRight`/`borderBottom`/`borderLeft` prop (they
  fail typecheck). `borderColor` colours whichever sides are on.
- **`CliRenderer` extends EventEmitter and emits `"destroy"`** (`RendererEvents.DESTROY`). Use
  `renderer.on("destroy", …)` to tear down process-wide resources (we stop the event system there).
  Note `useQuit` does `renderer.destroy()` then `process.exit(0)`, so on an explicit quit the OS also
  reaps watchers regardless.

## Theming (2026-07-25)

- **Themes carry a light/dark *scheme*, not one flat palette + an `appearance` tag.** `Theme.colors`
  (and `ThemeFile.colors`) is a `ThemeColorScheme`: **either** `{ default: ThemeColors }` (mode-agnostic)
  **or** `{ dark, light }` (both variants). The old top-level `Theme.appearance`/`ThemeSummary.appearance`
  fields are **gone**. Built-ins `github` + `nord` now ship both variants (one id, renamed "GitHub"/"Nord").
  - **Current mode is a property of the *host*, not the theme.** It's derived from the terminal
    background luminance via `terminalAppearance(palette)` (exported from `core/theme/terminal.ts`,
    was the private `appearanceOf`). Even a static theme picks its light/dark variant from this — the
    terminal is the only signal of whether the user's environment is light or dark. Defaults to `dark`
    until the palette resolves.
  - **Resolution:** `resolveColors(scheme, mode)` in `types/theme.ts` collapses a scheme → flat
    `ThemeColors` (`default` ignores mode; a pair picks the match). `use-theme` does this and exposes
    **`colors` (resolved flat palette) + `appearance` (current mode)** on the context alongside `theme`.
    Components read `useTheme().colors.*`, NOT `theme.colors.*` (which is now a scheme). `App.tsx` updated.
  - **`terminal` theme is a `{ default }` scheme** — its live snapshot already reflects the current mode,
    so there's only ever one palette; `themeFromTerminalColors` lost its `mode` param.
  - `ThemeColorScheme` is a `z.union([{default}, {dark,light}])`; `"default" in scheme` narrows in TS.
- **Themes are a registry of *semantic colour roles*, not raw ANSI/component names.** Roles:
  `background, foreground, surface, border, muted, primary, secondary, success, warning, error, info`
  (Zod-defined in `types/theme.ts`, hex-only for custom files). UI colours by role via `useTheme()`.
- **Three theme sources:** built-ins (`github`, `nord`) in `core/theme/builtin.ts`; custom user files at
  `~/.config/mctl/themes/<id>.json` (id = filename, like server-id-from-dir); and the dynamic
  **`terminal`** theme built live from the host palette. `config.theme` (default `"terminal"`) stores the
  active id and is read at startup in `renderApp()`.
- **`terminal` is reserved + special.** The registry only *lists* it (no static colours); the UI layer
  (`hooks/use-theme`) substitutes the live palette. A custom file named `terminal.json` is ignored with a
  warning. `themeFromTerminalColors()` (pure, in `core/theme/terminal.ts`, no OpenTUI import) maps a
  neutral `TerminalPalette` → roles with a fallback chain so no role is ever undefined.
- **One bad custom theme file is skipped with a log warning, not fatal** — deliberate exception to
  "throw typed errors": a single malformed `themes/*.json` must not make the app unlaunchable; built-ins
  still resolve. (Contrast config.json, which *is* fatal.)
- **OpenTUI already implements terminal-colour querying** — `renderer.getPalette()` (OSC 10/11/4) and a
  `palette` change event. `use-terminal-colors.ts` is a React adapter: fetch on mount, subscribe to
  `palette`, dedupe by signature, expose a neutral `TerminalPalette`.
- **TWO load-bearing gotchas for LIVE terminal-theme changes** (both caused a "reverts to fallback /
  doesn't update on theme change" bug; the working reference is `~/projects/local-edge`):
  1. **We must enable DEC private mode 2031 ourselves** — `process.stdout.write("\x1b[?2031h")` on
     mount, `"\x1b[?2031l"` on cleanup. OpenTUI *reacts* to the terminal's colour-scheme-change
     notification but **never enables the mode**, so without this write no `palette`/`theme_mode` event
     ever fires on change. (Write to `process.stdout`, not `renderer.stdout` — the latter is private.)
  2. **The poll fallback MUST call `renderer.clearPaletteCache()` before `getPalette()`** — `getPalette`
     returns a cached result, so re-querying without clearing returns the *stale* palette forever.
  - Do NOT gate/stop the poll on `theme_mode` (an earlier version did — that was the bug). Poll
    continuously (~1s) with a cache-clear as the fallback; the `palette` event covers 2031-capable
    terminals instantly. Appearance is derived from background luminance in `terminal.ts` — no need to
    depend on `themeMode` at all.
  - **Do NOT call `renderer.setBackgroundColor()`** to theme the background. It emits OSC 11 to change
    the *actual terminal* bg, which races the terminal's own colour-scheme transition and **flashes a
    stale colour for a frame** on every change (this bit both `local-edge` and an earlier mctl version).
    Instead paint the background with a full-screen `backgroundColor` box at the app root (`App.tsx` root
    box, `flexGrow={1}`) — it draws into the render buffer and leaves the terminal's native bg alone.
    The flicker-free `rove` project works exactly this way (never touches terminal bg).
  - **Sandbox caveat:** a non-TTY pipe can't answer OSC queries and OpenTUI swallows `process.stdout`
    writes there, so live palette detection is **not verifiable headlessly** — only in a real TTY.
- **No-flash terminal theme (three parts, do not drop any):**
  1. **Pre-fetch before first paint:** `renderApp()` calls `queryTerminalPalette(renderer)` (exported from
     `use-terminal-colors`) and passes it to `<ThemeProvider initialPalette>` → `useTerminalColors(initial)`
     seeds state. OpenTUI has usually already detected the palette during `createCliRenderer`, so this
     returns from cache instantly on a real TTY (≤200ms timeout otherwise). Frame one is real colours.
  2. **`"terminal"` id NEVER falls back to a static theme.** `use-theme` resolves it to
     `terminalTheme ?? EMPTY_TERMINAL_THEME` (the empty-palette terminal theme), so an unresolved palette
     shows neutral terminal-defaults, not GitHub. A missing *named* theme also degrades to the terminal
     theme, not github. (`FALLBACK_THEME`/github is no longer referenced by the provider.)
  3. **Ignore transient all-null palettes.** `use-terminal-colors` guards every update with `hasColour()`
     — during a theme switch the terminal can briefly answer all-`null`; using it would flash empty for a
     frame. Skip it, hold the last-good palette.
- **Gotchas:**
  - `<ascii-font>` uses `color` (`ColorInput | ColorInput[]`), **not** `fg`. `<text>`/`<span>` use `fg`.
  - Added **`@types/react@19`** (devDep). The repo had no direct `react` imports before; hooks/context
    (`useState/useEffect/useMemo/useContext/createContext`, `React.ReactNode`) need it. JSX still comes
    from `@opentui/react` via `jsxImportSource`, so `@types/react` doesn't hijack JSX.
  - `lib/fs.ts` gained `readDirIfExists(dir, ext?)` → `[]` on ENOENT (absent `themes/` is normal).

## Key decisions (2026-07-25 — second design pass)

- **No in-memory authoritative state — "MCTL manages, does not hold."** The app caches nothing it
  treats as truth; server identity/config/run-state is re-derived from disk + live process probes every
  launch and every change.
  - **Why:** it is the enabling constraint for **multiple `mctl` instances running at once and staying
    in sync** — none owns the state, so they can't disagree.
  - **How to apply:** re-identify running servers by probing `~/.local/state/mctl/runtime/<id>.json`
    (pid/session liveness), never a cached "running set." Sync across instances via `fs.watch` on hard-
    state files **plus** an append-only `events.jsonl` that every instance tails and re-emits. No IPC,
    no daemon, no leader. Supervision (auto-restart/tunnel keepalive) is opportunistic behind a
    supervisor lock; a real daemon is deferred to Phase 5 on the same file substrate. Detached runtimes
    (tmux/docker) are the norm so servers outlive an instance. See [[architecture.md]] § Statelessness.
- **JSON / JSONL only — no TOML, no YAML.** `mctl.toml → mctl.json`, `config.toml → config.json`,
  `secrets.toml → secrets.json`. Cross-instance log is `events.jsonl`. Drop `@iarna/toml`; use native
  JSON + Zod at every boundary. (Earlier drafts said config was TOML — that is now wrong, ported.)
- **Pages moved into `src/app/`.** No top-level `src/pages/`. `app/` holds `App.tsx`, `Router.tsx`,
  `setup/` (wizard), and the page folders. CLI lives in `src/cli/`.
- **Two front-ends, one core: TUI *and* one-shot CLI.** `mctl` (no args) → OpenTUI; `mctl <cmd>` →
  scriptable one-shot with `--json`. Both call the same core services; `cli/commands/` is the CLI's
  bridge, mirroring hooks. Neither front-end holds logic the other lacks.
- **First-run setup wizard** (`app/setup/`) triggers when `config.json` is absent; writes defaults once.
  Headless equivalent is `mctl init` (same fields as flags → identical `config.json`).

## Key decisions (2026-07-25 — first pass, still current)

- **Server Location Registry.** `servers_dir` is only the *default parent* for new servers; each
  server's real path lives in `~/.local/state/mctl/servers.json` (`id → path`). Startup verifies each
  path (exists + `mctl.json`). Pointer index, never a data mirror; durable state, atomic writes; missing
  path ⇒ mark **unavailable**, never auto-delete; still scan `servers_dir` and fold in drop-ins.
- **Providers are dynamically registered modules** via a `ProviderRegistry` — the TS simplification over
  Rust crates.

## Conventions / preferences

- Artifacts are the project memory: `plan.md` (intent), `architecture.md` (structure), `memory.md`
  (this), `progress.md` (baseline). Read all four at session start; write `memory.md` + `progress.md`
  every session. See `AGENTS.md`.
- Precedence when artifacts disagree: `plan.md` > `architecture.md` > `progress.md`. Code beats all.
- User wants `plan.md` **rich and detailed** (the Rust plan was the depth benchmark), not blunt bullet
  lists — concrete interfaces, tables, diagrams.

## Component library (2026-07-25)

- **`src/components/` is the shared UI kit.** All components are **pure-UI, controlled, and
  theme-driven**: they read colour from `useTheme().colors` (never hardcode hex), take
  `value`/`checked` + `onChange` + `focused`, hold no domain state, and do no I/O. Import from the
  barrel `src/components/index.ts`.
- **Mouse focus convention — every focusable control takes `onFocused?: () => void`.** Fired on
  mouse-down so a click moves the *page's* focus ring to that control (the component still owns no
  focus state; the page maps `onFocused` → its `setFocus`). Present on `Button`, `Tabs`, `Input`,
  `TextArea`, `Select`, `Toggle`, `Checkbox`, `RadioGroup`. **How it's wired:** form controls forward
  `onFocused` to `FormField`, which puts `onMouseDown={onFocused}` on its frame box — OpenTUI mouse
  events **bubble** (they carry `stopPropagation`), so a click anywhere in the frame (border, label, or
  the inner control) reaches it, and the inner `onMouseDown` handlers (Toggle/Checkbox/RadioGroup) that
  fire `onChange` don't stop propagation, so both fire. `Button` fires `onFocused` *then* `onClick`
  (a click focuses **and** activates). Non-focusable clickables (`Breadcrumb` crumbs, lone `Radio`,
  `Dialog` backdrop) keep plain `onMouseDown` and get **no** `onFocused`. Gallery wires every ring
  member's `onFocused` to `setFocus(id)` — click-to-focus is the demo/verification. Interactive keyboard handling lives inside each control via
  `useKeyboard` **guarded by `focused`** — that guard is what stops every mounted control from
  reacting to one keypress (many `useKeyboard` handlers all fire globally).
- **Variant language:** `support.ts` defines `Variant` (primary/secondary/success/warning/error/
  info/neutral) → `variantColor(colors, v)`; `onAccent(colors)` returns `colors.background` as the
  ink to lay on a filled accent (reads on every built-in light/dark variant). Reuse these, don't
  re-pick roles per component.
- **The form-field frame** (`FormField`/`Field` in `Form.tsx`): a rounded `<box>` that puts the
  **label on the top border via `title`** and the **hint on the bottom border via `bottomTitle`**,
  and swaps `borderColor`/`titleColor` to `primary` on `focused` (`error` on `invalid`). This is why
  a text field is a tidy 3 rows — the label/hint sit *on* the border, not on interior rows. NOTE:
  `<box>` has **`titleColor` but no `bottomTitleColor`** — the bottom title can't be coloured
  independently.
- **Adaptive `Select`:** few/short options → OpenTUI `<tab-select>` (side-by-side); options that
  overflow the field width → scrollable `<select>` dropdown (with per-option descriptions). Decided
  by `optionsFitAsTabs(labels, innerWidth)` where `innerWidth = fieldWidth - 4` (2 border + 2 pad).
  Pass `width` to a `Select` both to size it and to set the cutoff.
- **OpenTUI input/textarea value-read gotchas:**
  - `<input onSubmit>` — OpenTUI merges `InputProps.onSubmit: (value)=>void` with the inherited
    `TextareaOptions.onSubmit: (SubmitEvent)=>void` into an **intersection**, so a `(value:string)`
    handler won't type-check. Pass a **zero-arg** handler (assignable to both) and read the value from
    a `useRef<InputRenderable>().current.value`.
  - `<textarea>` is uncontrolled: seed with `initialValue`, and its `onContentChange` event is
    **empty** — read the text back from `ref.current.plainText` (`useRef<TextareaRenderable>`).
- **`Dialog` modal pattern:** no window manager, so it's two absolute full-screen layers — a dimming
  backdrop `<box opacity={0.7}>` (own opacity so the page shows through; children would inherit it, so
  the dialog is a **separate sibling** at higher `zIndex`, full opacity) centred over it.
- Page **`Tabs`** (custom, mouse + ←/→) are distinct from the `<tab-select>` *form input* — don't
  conflate. Active-tab underline renders `"─"`, inactive renders **blank spaces** (not a
  background-coloured glyph) so it's theme-proof.

## OpenTUI gotchas

- **FrameBuffer has no `<frame-buffer>` JSX intrinsic** in `@opentui/react`. Create a
  `FrameBufferRenderable(renderer, {id, width, height})` imperatively in `useEffect` and attach it to a
  host `<box>` via its `ref` (`box.add(canvas)` / cleanup `box.remove(canvas)` + `canvas.destroy()`).
  React never renders children into that box, so there's no reconciler conflict. `useId()` for a unique
  buffer id when several exist. See `components/MinecraftHead.tsx`.
- **Square "pixels" in a cell grid:** a terminal cell is ~1 wide × 2 tall, so use the upper-half-block
  glyph `▀` — fg = top pixel colour, bg = bottom pixel colour → 2 stacked pixels/cell, each its own
  colour (lossless). An 8×8 image → 8-wide × 4-tall cells and renders square. (Quadrant blocks give 2×2
  sub-pixels/cell but only 2 colours per cell, so they lose colour — avoid unless width-constrained.)

## Gotchas / open questions

- Anything referencing `.toml`, Rust crates, `cargo`, `thiserror`, or a top-level `pages/` in an
  artifact is stale — port it on sight.
- **Supervision under statelessness is a real tension:** without a daemon, auto-restart/tunnel keepalive
  only runs while some instance is alive (opportunistic, lock-guarded). If the user wants always-on
  behaviour, that's the Phase-5 agent — flag it rather than silently assuming a daemon.
