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
  - **Wizard/`init`/Settings config writes need no explicit emit** — the config-dir watcher fires
    `ConfigChanged` automatically, so `useConfig`/`useServers` refresh. (True only since the
    2026-07-27 temp-name fix below; before it the watcher never fired at all.)
  - `MctlEvent` envelope (`types/events.ts`): `{v,id,ts,instance,type,payload}`. `type` is an **open
    string** (forward-compat: an unknown event type from a newer instance must not break the tail);
    `EventType` is a reference object, not a closed union.
- **TUI Router (`src/app/`):** in-memory router (no URL). `hooks/use-router.tsx` = `RouterProvider` +
  `useRouter()` (route + params + `navigate`/`back`/`canBack`, with a back-stack). `app/routes.ts` =
  `RouteId` + `NAV` (dashboard/servers/jobs/backups/network/settings, digits 1–6; `server` detail is
  NOT in NAV — reached from Servers with a `serverId` param). `app/Router.tsx` = the shell (top bar +
  `NavRail` + page host + `Hint` strip) and owns the **global keyboard**: digit→route, `Esc`=back-else-
  quit, `q`=quit, `t`=cycle theme. `App.tsx` renders `<AppRouter/>` post-setup.
  - **Digit-nav (plus `q`/`t`) is gated by the input capture** — see the 2026-07-27 entry above. The
    `TODO(phase-1)` in `Router.tsx` is resolved and gone.
  - Real pages: `Dashboard` (server-count tiles + recent-activity feed from `useRecentEvents`),
    `Servers` (live list, ↑/↓/j/k + Enter/click → detail), `Server` (read-only detail via `useServer`),
    `Settings` (**editable config form**). `Jobs`/`Backups`/`Network` = honest `Placeholder`.
  - **NavRail is a horizontal tab bar, not a left rail** (redesigned 2026-07-26 to a user-supplied
    reference): a 2-row scrollbox — tabs on row 1, the rule on row 2 — whose active tab is a **solid
    pill** (`backgroundColor: colors.primary`, ink `onAccent(colors)`, BOLD) and whose inactive tabs
    are `colors.muted`, lifting to `colors.foreground` on an `alpha(foreground, 0.12)` wash. The digit
    prefix is DIM off the pill and `mix(onAccent, primary, 0.55)` on it.
  - **The rule is per-tab `<text>` segments, NOT a `border={["bottom"]}`** — only the segment under the
    active tab is accented, and a border paints one colour for its whole side. Two rules keep the rows
    aligned: (1) `tabWidth(item)` is the single width source, set as an explicit `width` on **both** the
    tab box and its underline text; (2) every segment is `flexShrink={0}`. Without (2) yoga shrank the
    segments (their total + the tail exceeds the viewport) and the accent came out 9 cells under a
    13-cell tab. The rule reaches the right edge via a tail `<text>` **sized from
    `useTerminalDimensions().width`** minus the cells the tabs consume (a `<text>` can't stretch, so it
    must be counted out), inside a `flexGrow` + `overflow="hidden"` box. Deliberately an *over*estimate
    — the terminal width ignores the shell frame's inset, and surplus is clipped, whereas undershooting
    leaves a visible gap before the right border. Re-renders on SIGWINCH (verified by resizing a pty).
    - **Tabs are deliberately NOT `Button`s.** `Button` colours its label from its own variant matrix
      and only when `children` is a plain string, so a chip needing *two* inks (dim digit + label) with
      a *muted* resting look has no matching kind — the local `NavTab` owns its hover state instead.
    - The **screen name rides the shell's top border** (`title` + `titleAlignment="right"`, the
      reference's "Request" placement) and the brand rides `bottomTitle` — neither costs a row. The
      old commented-out top-bar block in `Router.tsx` is gone; `titleFor(route)` now feeds the title.
  - Data hooks (`hooks/`): `use-servers` (`useServers`/`useServer`), `use-config`, `use-recent-events`,
    `use-event-bus` — all re-run the core read path on invalidating bus events, holding no authoritative
    state. `use-event-bus`/`use-router` are `.tsx` (they hold JSX providers).
- **`lib/http.ts` — ETag cache** (Phase-1 tail; first real use is Phase-2 downloads). One JSON file per
  URL under `~/.cache/mctl/api/<sha256(url)[:32]>.json` = `{url,etag,lastModified,fetchedAt,body}`.
  Within `ttlMs` (default 5 min) serves cache with **no** network call; else conditional GET
  (`If-None-Match`/`If-Modified-Since`), `304` refreshes the timestamp, `200` restores body+validators.
  Serves **stale on network failure**; throws `HttpError` only when nothing is cached. `fetchJson`
  returns `unknown` — caller Zod-validates.

## Phase 1 tail — editable Settings, key capture, log rotation (2026-07-27)

- **Bun's `fs.watch` reports a rename under the SOURCE name only** — the destination
  never appears. Our atomic writes are temp+`rename`, so `config.json` / `servers.json`
  writes produced **no** matching watch event and the hard-state watchers were silently
  dead (the earlier note claiming "the config-dir watcher covers wizard/init writes" was
  wrong — it never fired). Verified on Bun 1.3.14.
  - **Fix:** `lib/fs.writeFileAtomic` now names its temp file after the target —
    `.<basename>.<pid>-<rand>.tmp` (`tempNameFor`) — and `core/events/watch.ts` maps it
    back with `targetOfTempName()` before filtering. Debouncing keys on the resolved
    target, so the temp-write and the rename coalesce into one event.
  - **How to apply:** never filter watch events by a bare filename again; go through
    `targetOfTempName(name) ?? name`. `src/core/events/watch.test.ts` is the regression
    guard (ConfigChanged / RegistryChanged / ServerStateChanged + a negative case).
- **Global character shortcuts are gated by an input capture**, not by page identity.
  `hooks/use-input-capture.tsx` = `InputCaptureProvider` (mounted inside `RouterProvider`,
  above `AppShell`) + `useCaptureKeys(active)` for pages + `useKeysCaptured()` for the
  shell. Capture is a **count**, and `isCaptured` is a **getter** — a `useKeyboard`
  handler closes over its render, so a boolean would go stale. `Esc` is deliberately
  exempt (it can't be part of what's being typed); digits/`q`/`t` stand down while a text
  field owns the ring. The hint strip swaps to typing hints via `useIsCapturing()`.
  - **How to apply:** any future page with a text input calls
    `useCaptureKeys(ring.focus !== undefined && TEXT_FIELDS.has(ring.focus))`.
- **Settings is the wizard's peer, not its clone.** `app/Settings/use-settings.ts` owns a
  flat `SettingsDraft` (no `root` — permanent) + `configToDraft`/`draftToConfig`/
  `validateDraft` (pure, unit-tested) and commits with `writeConfig` → `ensureDirTree`
  (a relocated `servers_dir` must exist immediately). `draftToConfig` is **merge, not
  replace**: it spreads the loaded config so `backup.schedule`/`retention`, named
  `network.profiles`, and future keys survive an edit. Edits are buffered; **Ctrl+S** or
  Save writes; the watcher's `ConfigChanged` then refreshes every instance.
  - The buffer follows the file while clean and is never clobbered while dirty — tracked
    by an `adopted` ref holding the last serialization taken off disk.
  - **Theme is NOT in the draft.** The theme provider owns it and persists on change, so
    the Settings theme picker applies instantly (like `t`); a save just carries the
    currently-active id.
- **`events.jsonl` rotation exists now** (`trimEventLog`, log.ts): >512 KB ⇒ rewrite the
  last ~128 KB of *whole* lines atomically. Called once in `startEventSystem()` before the
  tail records its offset, and opportunistically from the tail's drain. The tail's
  shrink branch now **resumes at the new end** (`offset = size`) instead of restarting at
  0 — restarting replayed the surviving history into the activity feed.
- **`FormField` painted the literal string `undefined` on its bottom border** when no
  `hint` was passed (`bottomTitle={` ${hint} `}`). Only showed up once a page used
  hint-less fields (Settings' checkboxes). Now conditional.

## Settings grouped into tabs + a pinned action bar (2026-07-31)

- **A page whose chrome must stay put cannot live inside the shell's scrollbox.** `Router.tsx` now
  keeps a set `OWN_SCROLL: ReadonlySet<RouteId>` (currently just `"settings"`): those routes are
  hosted in a plain `<box flexGrow={1} flexDirection="column" padding={1}>`, everything else keeps
  the scrollbox. The host is what gives such a page a **definite height**, which is what lets an
  inner `<scrollbox flexGrow={1}>` know when to scroll.
  - **How to apply:** any future page with pinned chrome (a toolbar, a console input row, a wizard
    footer) adds its route to `OWN_SCROLL` and puts a scrollbox around its *scrolling region only*.
    Don't nest a page-level scrollbox inside the shell's — the outer one has no definite height for
    the inner one to resolve against.
- **Settings is `PageHeader → Tabs → scrollbox(panel) → action bar`.** Groups are Locations /
  Defaults / Backups / Network / Appearance (`GroupId`, `GROUPS`). The panel is `key={group}` so
  switching tabs remounts it and scroll starts at the top.
  - The **focus ring is per-group**: `ringIds(group, draft)` = `[__tabs, …visible fields…, __revert,
    __save]`. `TABS_ID` is first, so the ring starts on the tab bar and ←/→ switch groups
    immediately. Conditional fields (path inputs, backup provider/compression) are still added by
    their toggle — `useFocusRing` clamps its index, so this stays safe.
  - **A validation issue on a hidden group would be invisible** (Save disabled for no visible
    reason), so `GROUP_OF_ISSUE` maps each validatable draft field to its group and the offending
    tab's label gets a trailing `" !"`. Add an entry whenever `validateDraft` learns a new field.
  - Section headings were **dropped** — the active tab already names the group; only the muted
    description line remains. The `Written to <config path>` footnote became a `ReadOnlyRow` in
    Locations rather than a page-bottom line (the action bar owns that row now).
  - Action-bar buttons are `size="small" kind="ghost"` (1 row, no border). **`size="small"` +
    `kind="outline"` is unusable**: its focused/hover recipe sets `fg: onAccent` with **no**
    background, so the label vanishes into the page. Small chips must be `ghost` (which does fill).
- **`Tabs` was restyled to `NavRail`'s language (2026-07-31, user request)** — one tab vocabulary in
  the app, not two. Same 2-row scrollbox: `|` separators, active tab a **solid pill**
  (`backgroundColor: primary`, ink `onAccent`, BOLD), inactive `muted` lifting to
  `alpha(foreground, 0.12)` on hover, and a per-tab rule row with `╸`/`╺` caps around the active
  segment plus a counted-out tail run to the right edge. `tabWidth(item) = 1 + 2*pad + label.length`
  is the single width source, set as an explicit `width` on **both** rows, every segment
  `flexShrink={0}` (see the NavRail entry above for why both are load-bearing).
  - **Keyboard focus is still the underline weight** (`━` focused, `─` not) *plus* the accent
    blending toward the rule when unfocused (`mix(primary, rule, 0.75)`). The pill is unchanged by
    focus, so "which tab is active" stays legible when the ring is elsewhere. A border or background
    would cost a row or fight the pill.
  - Tabs carry **no digit hint** (unlike NavRail) — page tabs have no digit shortcut.
  - Optional **`initials` prop** = NavRail's brand slot: a short accent caption before the first tab
    (rendered as `` `${initials} ` ``). Settings passes `"Settings"`.
  - Optional **`paddingX` prop** insets the *tabs row only* — the rule row is deliberately not inset,
    so it spans the page like a divider. **Pad with this prop, never with a wrapper box**: a wrapper's
    padding pushes the rule in too (Settings' wrapper lost its `paddingX={1}` for this).
  - `leadCells = paddingX + caption.length` is the one number tying it together: it is drawn as a
    plain rule run at the start of row 2 *and* subtracted from the tail. Miss either and the rows
    stop lining up.

## Toasts — component + provider (2026-07-31)

- **Two files, split on the pure-UI line.** `components/Toast.tsx` is rendering only (`ToastCard`,
  `ToastViewport`, `wrapText`, `TOAST_ICONS`, `SPINNER_FRAMES`); `hooks/use-toast.tsx` is the
  scheduler (`ToastProvider` + `useToast`). The card can be rendered with no timers running, which
  is what makes it testable.
- **`ToastProvider` is mounted at the ROOT in `App.tsx`, not in `Router.tsx`** — it renders its
  viewports as *siblings of `children`*, and a viewport is `position="absolute"` against its parent,
  so "parent" must be the screen. Mounting it at the root also gives the setup wizard toasts.
  - **`InputCaptureProvider` moved up to `App.tsx` too** (it was inside `RouterProvider`), so the
    toast layer sits *below* it and a toast's `action.key` can stand down while a text field is
    being typed into. `Router.tsx` still reads the capture through context — nothing else changed.
  - The ticker (`tick` state, 100 ms, only while a spinner/meter is on screen) re-renders the
    provider but **not** `{children}`: the children element reference is stable across the
    provider's own state updates, so React bails out of that subtree. Animation is not an app-wide
    re-render.
- **Viewports are content-sized, never full-screen.** A full-screen overlay would sit over the page
  and eat its mouse events (`Dialog` does exactly that *on purpose*). Centred positions set `left`
  **and** `right` and centre their children, since a content-sized box can't centre itself.
- **Overflow queues, it does not evict.** `visible` keeps `slice(0, maxVisible)` per position
  (oldest first) and a queued toast has **no countdown until it reaches the screen** — a burst of
  five toasts loses none. Slicing `-maxVisible` (newest-wins) was the first cut and is wrong here:
  an evicted toast would later reappear when the newer ones expired.
- **Countdowns live in a ref, not state** (`Map<id, {timer, expiresAt, remaining, paused}>`), and a
  `useEffect` reconciles them against the visible list. Keeping `expiresAt` in state would make the
  effect that starts the timer feed its own dependency and loop.
- `remove()` **dedupes by id** (`removed` ref): a countdown can fire in the same frame the user
  clicks the card, and `latest.current` only refreshes on the next render — without the guard
  `onDismiss` fires twice.
- **Terminal text does not reflow** — `wrapText(text, width, maxLines)` does it by hand and marks
  truncation with `…` rather than dropping words. Unit-tested in `components/Toast.test.ts`.
- **`useEffect(() => raise(toast), [])` silently breaks**: the arrow returns the toast *id*, which
  React takes as a cleanup function ("destroy is not a function"). Always brace the body.
- **`Settings.save` now resolves `string | null`** (the failure message) instead of a boolean — the
  toast needs the message itself, and `saveError` state is stale in the closure right after the
  await. Settings' `commit()` toasts success (with the config path) or failure (with a `r` Retry
  action).
- Rendering is verified for real, not just in state: `hooks/use-toast.test.tsx` mounts the provider
  in `createTestRenderer` + `createRoot` and asserts on `captureCharFrame()` — TTL expiry, delay,
  sticky, queueing, description, and `mockInput.pressKey` driving an action key. That combination
  (`@opentui/core/testing` + `@opentui/react`'s `createRoot`) works and is the pattern to reuse for
  any future component test that needs a live React tree.

## ProgressBar styles & variations (2026-07-31)

- **The glyph table is the whole visual vocabulary.** `PROGRESS_STYLES: Record<ProgressBarStyle,
  ProgressGlyphs>` in `components/ProgressBar.tsx` holds `{fill, empty, partials?}` for
  `blocks | smooth | shaded | line | smooth-line | dots | segments | ascii`. Adding a style = one row
  there; nothing else in the component branches on the style name.
- **Sub-cell precision is `partials`, and `n` partials mean `n + 1` steps per cell.** `smooth` carries
  the seven eighth-blocks `▏▎▍▌▋▊▉` (U+258F..U+2589) → eighths; `smooth-line` carries the single
  `╸` (U+2578 HEAVY LEFT) → halves, because that is the *only* sub-cell step the heavy rule `━` has
  in Unicode. Styles without `partials` round to whole cells.
  - Consequence for tests: the "an unfinished bar always leaves an empty cell" rule holds for
    whole-cell styles only; a sub-cell style can occupy every cell and still read as unfinished
    because its last glyph is a partial. Assert `!filled.endsWith(fill)` there instead.
- **Layout maths is exported and pure** — `fillGlyphs(fraction, width, glyphs)`,
  `indeterminateGlyphs(frame, width, glyphs)`, `thresholdVariant(fraction, base, thresholds)`. That is
  what makes the component testable without a renderer (`components/ProgressBar.test.ts`). The
  invariant every test leans on: **the runs always total the track width**, at every fraction and
  every frame — a short run would shift the layout around it.
- **Rounding is deliberately biased at both ends:** a non-zero fraction always inks ≥1 cell (a started
  download must not look idle) and a fraction < 1 never fills the last cell (only "done" looks done).
  This slightly changes what the toast TTL meter draws near its ends; that is intended.
- **`value` + `max` replaced the bare fraction**, with `max = 1` so every existing caller (Toast) is
  unaffected. `readout` = `none | percent | fraction`; `format` overrides it. `showPercent` is kept as
  a `@deprecated` alias for `readout="percent"` because Toast and the first callers were written
  against it — the destructure raises a TS *hint* (6385), not an error.
- **An indeterminate bar drives its own frame counter** (`setInterval` at 12 fps in the component)
  unless the caller passes `frame`. This is the one place a component in this kit owns a timer; it is
  UI-only animation, and the state lives on the bar so an animating bar never re-renders the page.
  Callers that already have a ticker (the toast provider) should pass `frame` instead, exactly like
  `ToastCard`'s `spinner` prop.
- **`thick` cannot mean a taller cell** — a terminal has no cell height — so it renders a second row
  of `▄` beneath the track in the same runs. With `brackets` on, that row starts with a leading space
  to stay aligned under the `[`.
- Verified by rendering all styles through `createTestRenderer` + `createRoot` and reading
  `captureCharFrame()`. **A preview script must `renderOnce()` → `await Bun.sleep(…)` → `renderOnce()`
  again**: one render returns a blank frame (React's commit hasn't reached the renderer yet). Also
  `console.log` is swallowed under OpenTUI — write the frame to a file with `Bun.write`.

## Measuring a renderable's width (2026-07-31)

- **A renderable's `width` is 0 until yoga lays it out**, which happens on the render loop's next
  frame — *after* React's effects. So an effect can only seed the value and then listen. The event a
  **child** renderable emits is **`"resize"`** (`Renderable.onResize`, fired from `updateFromLayout`
  only when the computed size actually changes). Do not confuse it with `"resized"` (emitted by the
  **root** renderable with `{width,height}`) or the `CliRenderer`'s `"resize"` (the terminal itself).
- **The ref must be attached on EVERY render path.** `Select` measured its `FormField` to decide
  tabs-vs-dropdown but passed `ref` only in the *tabs* branch — and the branch starts at `w = 0`
  (⇒ dropdown), so the ref was never attached, the listener never installed, and a flex-sized
  (`width="100%"`/`"auto"`) Select was **stuck as a dropdown forever**. Self-reinforcing: the width
  that would flip the branch is exactly the width that is never observed.
  - **Fix:** `useBoxWidth(ref)` in `components/Form.tsx` (module-local), and `Select` now renders
    **one** `FormField` with the ref always attached, branching only on its *child*.
  - **How to apply:** never gate the measured element behind the condition the measurement decides.
    Measure the stable wrapper, branch inside it.
- **Falling back to the `width` prop while unmeasured** (`measured || (typeof width === "number" ?
  width : 0)`) means a fixed-width Select picks its layout correctly on frame one and never flips.
  Only a flex-sized one starts as a dropdown and switches when the real width arrives.
- **`console.log` is swallowed under OpenTUI** — it is not a debugging channel here (and CLAUDE.md
  bans stdout writes outright). Use `lib/logger.ts` or write a captured frame to a file.

## Icon sets — Nerd / Unicode / ASCII (2026-08-03)

- **Icons are theming's twin, and are built the same way**: pure catalogue in `core/icons/`, React
  adapter in `hooks/use-icons.tsx`, one persisted key in `config.json` (`icons`). Components ask for
  a **semantic name** (`icons.success`, `icons.caret`, `icons.ruleLine`) and never a literal glyph —
  the same rule colour already follows. `core/icons/catalogue.ts` is the single glyph table; adding
  an icon = one row there.
- **Three rendering sets, three config modes, and they are NOT the same three.** `IconSet` =
  `nerd | unicode | ascii`; `config.icons` = `auto | nerd | ascii`. `unicode` is the middle tier
  `auto` lands on and is deliberately not offered as a mode — "the plain symbols every UTF-8
  terminal has" is what auto-detection should be trusted to decide. It is still reachable via
  `MCTL_ICONS=unicode` for debugging.
  - **Why not fall straight from `nerd` to `ascii`:** that would downgrade the majority of
    terminals (which draw `●`/`✔` fine without a patched font) and would have visibly regressed
    the app's existing look for everyone on the default.
- **There is no way to ask a terminal whether its font has Nerd Font glyphs.** So `auto` requires
  **positive evidence** — `TERM_PROGRAM`/`TERM` naming ghostty, WezTerm, or kitty (all three ship
  Nerd Font coverage by default), or an explicit `MCTL_NERD_FONT` — and otherwise picks `unicode`.
  A missing glyph is tofu or, worse, a two-cell replacement that shifts the layout.
  - Only an **explicit** non-UTF-8 locale (`C`, `POSIX`, `iso88591`) downgrades to `ascii`. An
    entirely unset `LANG` is treated as capable — routine in containers whose terminal is fine.
  - An explicit `nerd` mode is honoured even in a `C` locale: the user asserting "my font has these
    glyphs" beats any heuristic, and overriding them would make the setting useless to exactly the
    people who need it.
- **Every glyph must be one cell wide**, in every set. East-Asian *Wide* characters are barred
  outright (`☕` U+2615 was the first pick for `java` and is why the rule is tested); *Ambiguous*
  ones (`●`, `◉`, `—`) are fine — the app already draws them. Two documented ASCII exceptions,
  `ellipsis` ("...") and `transition` ("->"), because no fixed-width column measures against them.
  - **Consequence that bit twice:** any truncation helper must subtract `ellipsis.length`, not a
    literal `1`. `Toast.wrapText` and `Servers.cell` both take the marker as a parameter now.
- **`useIcons()` deliberately does NOT throw outside a provider** — it returns the auto-detected
  set. This is the one place the icon system diverges from theming: a component with no colours is
  unrenderable so `useTheme()` failing loudly is right, but every icon has a working default, and
  kit components must stay mountable in a bare test renderer.
- **`Button` only inks its label when `children` is a plain string** (`Button.tsx:212`). So
  `Get started {icons.arrowRight}` silently loses the label colour — children become an array.
  Interpolate into one string instead: `` {`Get started ${icons.arrowRight}`} ``.
- **Theme and icon writes share ONE queue** (`persistAppearance` in `App.tsx`, replacing
  `persistThemeId`). Each is a read-modify-write of the whole config, so separate queues would
  clobber each other. `configSubscriber(bus, select)` generalises the old `themeIdSubscriber` and
  feeds both providers.
  - `Settings.save` now takes `(themeId, iconMode)` for the same reason the theme id was already
    passed: `config` in hand can lag one write behind what the user is looking at.
- **ASCII mode cannot be complete:** `borderStyle` is OpenTUI's and 0.4.5 offers only
  `single | double | rounded | heavy`. Panel borders stay box-drawing; the Settings picker says so
  when `ascii` resolves rather than letting the user discover it. Prose ellipses/em-dashes in
  sentences are likewise untouched — they are typography, not icons.

## Scroll acceleration (2026-08-01)

- **A `<scrollbox>` defaults to `LinearScrollAccel` — one line per wheel notch, forever.** On a tall
  page that reads as "the wheel barely does anything". Pass `scrollAcceleration={…}`; `@opentui/core`
  exports `MacOSScrollAccel` (from `lib/scroll-acceleration`, re-exported by the package root), which
  keeps a 3-sample window of the intervals between scroll events and scales the delta by
  `1 + A*(e^(v/tau) - 1)`, capped at `maxMultiplier` (defaults `A=0.8, tau=3, max=6`). A streak breaks
  after 150 ms of silence, so a slow wheel stays exactly one line per notch.
- **The accelerator is stateful, so the instance must be stable** — a fresh instance per render resets
  the tick history on every keypress and silently degrades to linear.
- **Nothing renders the `<scrollbox>` intrinsic directly any more — use `components/ScrollBox.tsx`.**
  It is a pass-through wrapper (`ScrollBoxProps = OpenTuiScrollBoxProps & { enableAccel?: boolean }`;
  props *and* `ref` spread straight through) that owns the `useMemo`'d accelerator and adds
  `enableAccel`. It spreads `scrollAcceleration` **only when it resolves** — the renderable defaults to
  `LinearScrollAccel` when the option is absent at construction, but its setter would store an explicit
  `undefined`. An explicit `scrollAcceleration` from the caller wins over `enableAccel`.
- **`enableAccel` is off by default and set at exactly one call site:** the shell page host in
  `Router.tsx`. Acceleration is wrong for a short region — a 2-row tab strip (`NavRail`, `Tabs`) or a
  small list overshoots on the first flick. The Settings panel and the wizard are still linear by
  choice; flip them only if they feel sluggish in use.
- Measured in `components/ScrollBox.test.tsx` with `createTestRenderer` + synthetic
  `onMouseEvent({type:"scroll"})`: 30 notches 10 ms apart move **30** rows unaccelerated vs ~175
  accelerated. `onMouseEvent` is `protected` and `scrollX`/`scrollY` are absent from the public
  `ScrollBoxRenderable` type, so the test casts for both (runtime-correct, type-invisible).

## OpenTUI gotchas (added 2026-07-26)

- **Box borders are NOT clipped by ancestor scissor rects — upstream bug, patched locally.**
  `BoxRenderable.renderSelf` draws via the native `bufferDrawBox`, and that is the *only* native draw
  path that ignores the buffer's scissor stack (`drawText`, `drawTextBuffer`, `fillRect`,
  `drawFrameBuffer` all honour it). Symptom: a bordered `<box>` inside a `<scrollbox>` clips its text
  correctly but keeps painting border glyphs over the surrounding chrome (top bar, nav rail, hint
  strip) once scrolled. Not scrollbox-specific — a plain `<box overflow="hidden">` does it too.
  Reproduced on `@opentui/core` 0.4.5 (latest published).
  - **Fix:** `src/components/box-clip-patch.ts` → `installBoxClipPatch()`, called first thing in
    `renderApp()`. It monkey-patches `BoxRenderable.prototype.renderSelf`: when a box is *partially*
    outside its ancestors' clip, it lets the **original** `renderSelf` draw into a shared scratch
    `OptimizedBuffer` at the origin, then blits with `drawFrameBuffer` — which *does* respect the
    scissor. Fully-visible boxes keep the untouched native fast path, so there is no cost until a box
    straddles a clip edge, and **no glyph/title/border-style logic is reimplemented** (that was the
    point: partial sides, title alignments and focus colours stay byte-identical to upstream).
  - **How to apply:** delete the module and its one call site when upstream clips `bufferDrawBox`.
    Don't reach for `buffered: true` as a workaround — a buffered renderable renders at the wrong
    offset inside a clip (tested, produces garbage).
  - **Tests must live inside `src/`** (`src/components/box-clip-patch.test.ts`). A test file outside the
    project resolves `@opentui/core` to a *different copy* (the `~/.bun/install/cache` source tree), so
    patching one copy's prototype does nothing to the other — this silently made a scratch-dir
    verification look like the patch was a no-op. First `bun test` in the repo; `test` script added.

- **Box border *sides* are `border={["top"|"right"|"bottom"|"left"]}`** — `border?: boolean |
  BorderSides[]`. There is **no** `borderTop`/`borderRight`/`borderBottom`/`borderLeft` prop (they
  fail typecheck). `borderColor` colours whichever sides are on.
- **`CliRenderer` extends EventEmitter and emits `"destroy"`** (`RendererEvents.DESTROY`). Use
  `renderer.on("destroy", …)` to tear down process-wide resources (we stop the event system there).
  Note `useQuit` does `renderer.destroy()` then `process.exit(0)`, so on an explicit quit the OS also
  reaps watchers regardless.

## Theme follows config changes (2026-07-31)

- **`ThemeProvider` owns `themeId` as state seeded once from `initialThemeId`** — so a `config.theme`
  changed by *another instance* or a hand-edit did nothing, even though `ConfigChanged` fired and
  `useConfig` refreshed. It also can't subscribe itself: it is mounted **above** `EventBusProvider`
  (it must wrap everything) and is UI-layer, so it does no config I/O.
  - **Fix:** a `subscribeThemeId?: (apply: (id) => void) => () => void` prop — the mirror image of
    `onThemeChange`. `renderApp()` builds it once (`themeIdSubscriber(bus)` in `App.tsx`): on
    `ConfigChanged` it `loadConfig()`s and pushes `config.theme` in. The provider's effect only calls
    `setThemeIdState` and deliberately **does not** fire `onThemeChange` — the id came *from* the
    persisted config, re-persisting it would be a write loop between instances.
  - **How to apply:** any future provider mounted above the bus that must react to hard-state changes
    takes a subscribe *prop* wired in `renderApp()`; don't move it under `EventBusProvider` and don't
    give it disk access.
- **`persistThemeId` now serializes and coalesces its writes.** It is a read-modify-write, and cycling
  with `t` fires it faster than a round-trip completes; overlapping writes could land out of order. That
  was invisible before, but with the bridge above the losing write feeds back and **visibly snaps the
  theme back**. One in-flight write at a time, only the newest id, skip when unchanged.
- Verified in a pty against a sandbox HOME: an external atomic edit of `config.json` (`terminal`→`nord`)
  repaints in Nord within ~1 s (nord bg `46;52;64` + primary `136;192;208` in the new frames); with the
  fix stashed the same edit produces **0 new bytes** of output. Three rapid `t` presses land on the right
  theme with no snap-back.
- **Still not reactive: the theme *catalogue*.** `ThemeRegistry` is loaded once in `renderApp()`, so
  editing/adding `~/.config/mctl/themes/*.json` needs a restart. No watcher on that dir. Fix by watching
  it and reloading the registry into provider state if it ever matters.

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
