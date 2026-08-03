# MCTL — Architecture

Detailed architecture for the **TypeScript + OpenTUI (Bun)** implementation. `plan.md` is the product
intent; this file is how the code is actually structured. When code and this file disagree, the code
wins — fix this file and note it in `memory.md`.

---

## The four load-bearing constraints

1. **Filesystem is the source of truth** — no SQLite, no mirror of server *contents*.
2. **No authoritative in-memory state** — MCTL manages servers, it does not hold them. State is
   re-derived from disk + live probes on every launch and every change. This is what makes
   multi-instance operation possible.
3. **JSON / JSONL only** — no TOML, no YAML. One format, one parser, Zod at every boundary.
4. **Two front-ends (TUI + CLI), one core** — core is ignorant of both.

Everything below serves these.

---

## Layering (dependencies point inward only)

```
app/ pages (OpenTUI/React)   cli/ commands
        ↓ hooks                   ↓ (direct call)
              Core services / managers
                        ↓  provider interfaces
              Providers (server / runtime / backup / network)
                        ↓
              lib/ (fs, shell, http, download, paths, watch, logger)
```

- **`components/` and `app/` pages never** touch the filesystem, spawn processes, or call `Bun.*` I/O.
  They render props and call hooks. A "Forge server" reaches the UI as a plain field on a view model,
  never as a `ForgeProvider`.
- **Hooks are the only bridge** between the TUI and core. **`cli/commands/` are the CLI's bridge** —
  equally thin, calling the same core services. There must be no domain logic that exists in one
  front-end but not the other; both are projections of core view models.
- **Core knows provider *interfaces*, never concrete providers.** Concrete providers register into a
  `ProviderRegistry` at startup (wired in `src/index.tsx`); core resolves them by id. No provider
  imports another provider.
- **`lib/` is leaf-level:** pure helpers over Bun/Node APIs, no knowledge of servers or providers.

---

## Directory structure (target)

Mirrors `plan.md` § Project Structure. `src/hooks/` and `src/index.tsx` exist today; the rest is built
per roadmap phase — do **not** scaffold empty folders ahead of their phase.

```
src/
  index.tsx            entry: parse argv → TUI (no args) | one-shot CLI
  cli/                 router.ts, commands/ (list, create, start, …), format.ts (--json vs table)
  app/                 the TUI — App.tsx, Router.tsx, setup/ (wizard), and PAGES live here now
                         Dashboard/ Server/ ServerCreate/ Console/ Jobs/
                         Backups/ Network/ Settings/
  components/          pure UI (Table, Console, ProgressBar, Modal, StatusBar…)
  hooks/               useServers, useServer, useJobs, useConsole, useEventLog…
  core/                config, theme, registry, session, events, jobs, server, java, runtime, network, backup
  providers/           server/ runtime/ backup/ network/  (concrete impls)
  lib/                 fs, shell, download, http, paths, watch, logger
  types/               server, runtime, java, events, config…
  utils/
```

> **Change from earlier drafts:** pages moved out of a top-level `pages/` and now live **inside
> `src/app/`**. There is no `src/pages/`.

---

## Paths & the state directory

Resolved centrally in `lib/paths.ts` (XDG-aware; never hardcode). Config is XDG-fixed; data is
relocatable. **All formats are JSON/JSONL.**

```
~/.config/mctl/          FIXED
  config.json            root path, defaults, network profiles, backup policy, servers_dir default
  secrets.json           0600; API tokens (env vars override)
  themes/*.json  keybindings.json

$ROOT/  (default ~/.mctl, chosen at first run, not editable after)
  servers/               DEFAULT parent for new servers  (config.servers_dir)
  backups/               config.backups_dir
  java/<vendor>-<major>/
  downloads/             + downloads/staging/<uuid>/ for in-progress installs

~/.cache/mctl/           XDG; safe to delete anytime
  api/                   cached upstream manifests (ETag + TTL)

~/.local/state/mctl/     DURABLE local state (NOT disposable)
  servers.json           server id → absolute path            ← location registry
  events.jsonl           append-only cross-instance event log
  runtime/<id>.json      session descriptor: pid, runtime, sessionRef, port, startedAt
  runtime/<id>.lock      per-server action / supervisor locks
  console/<id>.log       captured server console — shared, so any instance can tail it
  logs/                  MCTL's own logs
```

A server directory contains exactly one MCTL-owned file — **`mctl.json`** (was `mctl.toml`).

---

## Statelessness & multi-instance sync — `core/session/` + `core/events/`

The core mechanism that lets several `mctl` processes coexist.

**No instance owns "the servers."** Each is a transient view over hard state. An in-process cache is
allowed only as a derived projection, invalidated on any watched-file change.

**Session re-identification (`SessionManager`, `core/session/`):**

- On start, a runtime writes `~/.local/state/mctl/runtime/<id>.json` = `{ pid, runtime, sessionRef,
  port, startedAt }`.
- `probe(id)` reads that file and confirms liveness: pid alive; for tmux/docker, the session/container
  still exists. Dead descriptor ⇒ reaped. The "running set" is **always** recomputed from disk, never
  cached as truth.
- Per-resource **lock files** (`runtime/<id>.lock`) guard actions that must not double-run (start,
  install, supervise). Stale locks (dead owner pid) are reaped at startup.

**Sync without IPC (`core/events/`):** two tiers, no daemon, no leader.

1. **In-process bus** — EventEmitter3; core/providers emit, hooks and CLI commands subscribe.
2. **Cross-instance log** — `events.jsonl`, append-only, one JSON line per state change, tagged with
   the emitting instance id. Every instance **tails** it from the end and re-emits onto its local bus.
   Plus `fs.watch` on `config.json`, `servers.json`, `runtime/`, and active server dirs → re-read the
   changed hard state → emit locally. Together these keep every instance consistent.
   - The log is **rotated by size** (`trimEventLog`: >512 KB ⇒ keep the last ~128 KB of whole lines,
     rewritten atomically) at startup and opportunistically from the tail. On a shrink the tail
     resumes at the file's new end — replaying the surviving lines would double the activity feed.
   - Watchers watch **directories**, and a watch event naming one of our temp files
     (`.<target>.<pid>-<rand>.tmp`) is attributed to `<target>`. Bun's `fs.watch` reports a rename
     under its *source* name only, so an atomic write is otherwise invisible under the target's name.
     `lib/fs.ts` (`tempNameFor`) and `core/events/watch.ts` (`targetOfTempName`) are a matched pair.

**Supervision** (auto-restart, tunnel keepalive) needs a live process, so it is **opportunistic**:
whichever instance holds a server's supervisor lock performs it; it pauses when no instance runs. A
dedicated always-on agent is a Phase-5 addition built on this same substrate.

**Detached vs foreground runtimes:** foreground ties the server to the MCTL process (dev/quick use);
tmux/docker detach so the server outlives the instance and any later instance re-attaches by probing.
Detached is the norm for anything long-lived — it is what makes "manage, don't hold" real.

**Invariant checklist:**

- Never keep an authoritative in-memory set of servers or their states — recompute from disk/probe.
- Never write server *contents* into state files. `servers.json` = paths only; `runtime/<id>.json` =
  liveness only; `mctl.json` = the server's config truth.
- All shared-file writes are atomic (temp + `rename`). Concurrent instances must never corrupt them.
- `events.jsonl` is append-only and periodically truncated by size (keep a tail); it is a sync + recent-
  activity feed, not a permanent record.

---

## Server Location Registry — `core/registry/`

Lets a server live **anywhere**, not only under `servers_dir`.

**File:** `~/.local/state/mctl/servers.json` = `{ version, servers: [{ id, path }] }`. A **location
index only** — server config still lives solely in each server's `mctl.json`.

**`ServerRegistry.load()`:**

1. Read `servers.json` (empty if absent).
2. For each entry verify `path` exists **and** `path/mctl.json` is readable.
   - valid → build the `Server` view model from `mctl.json`.
   - missing → keep the entry, mark `available: false` (drive may be unmounted). Never auto-delete.
3. Scan `config.servers_dir` for `*/mctl.json`; fold any unregistered server in (id from dir name).
4. Persist additions atomically.

**Invariants:** paths never contents; absence ≠ deletion; atomic writes; durable state (a wiped
`servers.json` loses references to servers *outside* `servers_dir` — those under it are recoverable by
the step-3 scan, others are not). Create ⇒ write `mctl.json` then `registry.add`. Delete ⇒
`registry.remove`; deleting the directory is a separate, explicitly-confirmed destructive action.

**Read path — `core/server/discover.ts`.** `loadRegistry` returns *locations*; discovery turns them
into `Server` **view models** by parsing each `mctl.json` and probing liveness (`core/session`).
`listServers(serversDir)` / `getServer(id, serversDir)` are the **single read path** both front-ends
use (CLI `list`/`status`, TUI `useServers`/`useServer`), re-derived from disk on every call — no cache.
This module is **read-only**; mutation lives in `core/server/manager.ts` (below). A server that fails
to load (missing path, invalid `mctl.json`) becomes an `unavailable` view model rather than throwing,
so one bad server never breaks a listing.

---

## Provider system — `core/registry/provider-registry.ts`

Dynamically registered modules, not compile-time wiring. `ProviderRegistry` is an **instance**, not a
module singleton: each front-end and each test builds its own, and a global would be the hidden
authoritative state the rest of MCTL avoids.

```ts
new ProviderRegistry()
  .registerServer(new PaperProvider())
  .registerServer(new VanillaProvider())
  .registerRuntime(new ForegroundRuntime());
```

Interfaces live in **`types/provider.ts`** (`ServerProvider`, `RuntimeProvider`; `BackupProvider` and
`NetworkProvider` arrive with Phase 4 — writing them now would design against imaginary code). Core
resolves by the `kind` / `runtime` / `network` fields in `mctl.json`; an unresolvable id is a typed,
user-facing `UnknownProviderError`, because it means the server was made by a build that knows a kind
this one does not.

**The one wiring point is `providers/index.ts` (`createProviderRegistry()`)**, called by each
front-end. Nothing under `core/` or `hooks/` may import a concrete provider — that is the arrow that
must not reverse.

## Install & launch — `types/install.ts` + `core/server/install.ts`

Install shape is an explicit tagged union, not a hidden branch inside one `install()`:

- `InstallStrategy` — Phase 2 ships `directJar` (Vanilla, Paper). Phase 3 adds `loaderJar`,
  `installer`, `buildFromSource`; every consumer already switches on `kind`, and the exhaustiveness
  guard in `executeInstall` makes a new member a compile error rather than a silent no-op.
- `LaunchSpec` — Phase 2 ships `jar`; `argFile` (Forge 1.17+) and `script` follow.

`core/server/install.ts` executes a strategy into a directory and knows nothing about where those
files will end up — which is what guarantees a failed install leaves no half-built server.

## Java — `core/java/`

Three modules, one responsibility each: `detect.ts` (find JDKs and ask each one what it is),
`adoptium.ts` (resolve + fetch + extract Temurin), `java-manager.ts` (the selection **policy**).

The policy is pure and exported (`chooseInstalled`, `preferredMajor`) so the rules are testable
without a machine that happens to have four JDKs. The load-bearing rule: an **unbounded** requirement
(`{min: 21}`) is capped at the newest LTS MCTL can fetch, so a machine holding only a newer non-LTS
JDK gets an LTS installed rather than a server that mysteriously fails. A `{pinned}` in `mctl.json`
always wins and is never re-derived.

## Jobs — `core/jobs/`

Long work becomes an observable `Job` rather than an awaited promise, so nothing blocks the render
path. The in-memory job list is **not** a violation of "no authoritative in-memory state": a job is
this process's own in-flight work with no on-disk representation, and what it produces (a jar, an
`mctl.json`) is the durable part.

Two tiers, deliberately asymmetric: `JobProgress` is emitted on the **local bus only** (it fires many
times a second and would rotate `events.jsonl` away); only the terminal `JobFinished` is published
cross-instance, which is the signal another instance actually needs — "re-read the disk".

## Server mutation — `core/server/manager.ts`

`ServerManager` is the mutating counterpart to the read-only `discover.ts`. Create is **staged**:
everything is assembled in `$ROOT/downloads/staging/<uuid>/` and moved into place only after the
download, digest check and `mctl.json` all succeed (`rename`, falling back to copy+remove on `EXDEV`,
since a server may be created on another drive). Delete forgets a *location* by default; erasing
files needs an explicit flag **and** a target that really contains an `mctl.json`, so a mis-pointed
registry entry can never take an unrelated directory with it. Edit merges over the parsed file, so
keys written by a newer MCTL survive.

`eula.txt` is the single deliberate exception to "MCTL writes only `mctl.json` into a server dir":
written once at create, only on explicit opt-in, into staging, and never touched again.

## Runtime — `core/runtime/` + `providers/runtime/`

`RuntimeManager` does everything *around* a runtime provider: resolve the provider, resolve Java,
build the JVM args, take the per-server lock, announce the state change. `restart` lives here rather
than on the interface because it is "stop, then start with a **freshly resolved** context".

`ForegroundRuntime` ties the server to the MCTL process. Its handles map is process-local (an OS
handle cannot be re-derived); every fact another instance needs is in `runtime/<id>.json`. Console
output is captured to `~/.local/state/mctl/console/<id>.log` — outside the server directory, and
shared, so any instance can tail it. Its one genuine limit: `exec` needs the child's stdin and so
works only from the owning process (`SessionNotOwnedError`); `stop` from a foreign instance sends
SIGTERM, which Minecraft's shutdown hook handles as a graceful save.

**Locks — `core/session/lock.ts`.** `withServerLock(id, fn)` uses `open(path, "wx")`, whose
check-and-create is atomic in the kernel. A lock owned by a dead pid is reclaimed, not respected.

## The shared object graph — `core/context.ts`

`createContext(providers, bus)` assembles config, paths, registry, bus, scheduler, `ServerManager`
and `RuntimeManager`. `cli/context.ts` and `hooks/use-mctl.tsx` are its two thin adapters — that is
the concrete mechanism behind "two front-ends, one core". The TUI's provider rebuilds the context on
`ConfigChanged`, so a relocated `servers_dir` takes effect without a restart.

---

## Theming — `core/theme/` + `hooks/use-theme`

Colour is a first-class, swappable concern. Components never hardcode colours; they read **semantic
roles** off the active theme (`theme.colors.error`, `theme.colors.primary`, …). Eleven roles, defined
and validated in `types/theme.ts` (`ThemeColors`, hex-only for user files).

- **`core/theme/`** owns the *static* catalogue, UI-free: `builtin.ts` (GitHub Dark, Nord),
  `registry.ts` (`ThemeRegistry` — folds in `~/.config/mctl/themes/*.json`, id = filename; `load()` is
  the one disk-reading step; one invalid file is logged-and-skipped, not fatal), and `terminal.ts`
  (`themeFromTerminalColors` — a **pure** map from a neutral `TerminalPalette` to roles; no OpenTUI
  import, so core stays UI-free).
- **The dynamic `"terminal"` theme** is the host terminal's own palette. It is *reserved*: the registry
  only lists it (no stored colours); the UI layer supplies live colours. `hooks/use-terminal-colors.ts`
  adapts OpenTUI's `getPalette()` + `theme_mode`/`palette` events (OpenTUI already implements the OSC
  10/11/4 + DEC-2031 querying) into `TerminalPalette`, with a 5s poll fallback that self-cancels once a
  live event proves the terminal reports changes.
- **`hooks/use-theme.tsx`** (`ThemeProvider` + `useTheme`) picks between sources by id and hands the UI
  one resolved `Theme`. The registry is loaded in `renderApp()` (front-end → core) and injected; the
  React tree never touches disk. Active id is persisted in **`config.theme`** (default `"terminal"`),
  read at startup — an id naming a deleted theme degrades to the terminal/fallback theme.

## Icons — `core/icons/` + `hooks/use-icons`

The other half of "appearance", built on the same split as theming: **pure data and
resolution in core, a React adapter in `hooks/`, one persisted id in `config.json`.**
Components never hardcode a glyph, exactly as they never hardcode a colour — they ask for a
semantic name (`icons.success`, `icons.caret`, `icons.ruleLine`).

- **`types/icons.ts`** — `IconSet` (`nerd | unicode | ascii`), the `IconName` union, `IconMap`.
- **`core/icons/catalogue.ts`** — `ICONS`, the exhaustive `IconName × IconSet` glyph table, plus
  `SPINNERS` and the memoized `iconsFor(set)` / `spinnerFor(set)`. Nerd glyphs are written as
  `\u{…}` escapes with their upstream names so the file is readable without a patched font.
  **Invariant: one cell per glyph** (bar `ellipsis`/`transition` in ASCII), enforced by a test —
  a wider glyph in one set would shift every column beside it on a switch.
- **`core/icons/detect.ts`** — `resolveIconSet(mode, env)`, pure over an env record. Precedence:
  `MCTL_ICONS` env → explicit `config.icons` → `auto`. `auto` picks `nerd` only on **positive**
  evidence (ghostty / WezTerm / kitty, or `MCTL_NERD_FONT`), `ascii` on an explicitly non-UTF-8
  locale, and `unicode` otherwise — a terminal cannot be asked whether its font has Nerd glyphs,
  and a wrong guess is tofu.
- **`config.icons`** is `auto | nerd | ascii` (an enum — unlike themes, icon sets are not
  user-extensible). The rendering sets are a *superset*: `unicode` is what `auto` lands on and is
  reachable only through `MCTL_ICONS`.
- **`hooks/use-icons.tsx`** — `IconProvider` (mounted in `renderApp()` beside `ThemeProvider`,
  above the component kit) + `useIcons()`. Same `onModeChange` / `subscribeMode` prop pair the
  theme provider uses, for the same reasons. **One deliberate difference: `useIcons()` does not
  throw outside a provider** — it returns the auto-detected set, so a kit component stays
  mountable in a test. `useTheme()` still throws, because a component with no colours is
  unrenderable while every icon has a working default.
- **`App.tsx` persists both through one queue** (`persistAppearance`). Each write is a
  read-modify-write of the whole config, so separate queues for theme and icons would clobber
  one another; `configSubscriber(bus, select)` is the shared `ConfigChanged` bridge back.
- **Known limit:** `borderStyle` is OpenTUI's, and 0.4.5 offers only `single | double | rounded |
  heavy` — no ASCII variant. Panel borders therefore stay box-drawing even in `ascii` mode, and
  the Settings picker says so rather than letting the user discover it.

## Dual interface — `cli/` and `app/`

`src/index.tsx` dispatches on argv: no args → mount the OpenTUI app; `mctl <cmd>` → run one command and
exit. Both call identical core services.

- CLI output derives from the same view models the TUI renders. `--json` prints the raw view model;
  default prints a human table (`cli/format.ts`).
- A CLI command is a transient instance: read hard state → act → append to `events.jsonl` → exit. Open
  TUI instances reflect it immediately via the log tail. `mctl start survival` and a live dashboard
  never disagree.
- First run in CLI mode does not silently create config; it errors toward `mctl init` (or offers the
  wizard if attached to a TTY).

**TUI router — `app/routes.ts` + `hooks/use-router.tsx` + `app/Router.tsx`.** No URL: an in-memory
`RouterProvider` holds the active route, its params, and a back-stack; pages navigate via `useRouter`.
`Router.tsx` is the shell (top bar + `NavRail` + page host + hint strip) and owns the global keyboard
(digits 1–6 → routes, `Esc` = back-else-quit, `q` quit, `t` theme). Adding a screen = one `NAV` row +
one entry in the `Page` switch. The event bus (started in `renderApp`, injected via `EventBusProvider`)
drives the data hooks (`use-servers`/`use-config`/`use-jobs`), which re-run the core read path
on invalidating events and hold no authoritative state — statelessness reaches into the UI.

> **Character-shortcut constraint:** digits, `q`, and `t` are plain characters, so the shell stands them
> down while a page holds an **input capture** (`hooks/use-input-capture.tsx`): the provider (mounted at
> the app root in `App.tsx`, above both the wizard and the router) counts active text fields, pages call
> `useCaptureKeys(...)`, and the shell consults
> `useKeysCaptured()` — a *getter*, since a `useKeyboard` closure would otherwise read a stale flag.
> `Esc` is exempt. Any new page with a text input must take the capture.

> **Page host — who scrolls.** By default the shell wraps the page in a `<scrollbox>`, which is right
> for a page that is one long document. A page with chrome that must stay put (Settings pins a tab bar
> above its panel and an action bar below it) instead names its route in `OWN_SCROLL` in `Router.tsx`
> and is hosted in a plain `flexGrow` box; that host is what gives it a **definite height**, which an
> inner `<scrollbox flexGrow={1}>` needs to resolve against. Such a page scrolls only its own panel —
> never nest a page-level scrollbox inside the shell's. `OWN_SCROLL` currently holds `settings` and
> `console` (which pins a command input under a scrolling output pane).

> **Routes outside the rail.** `server`, `console`, and `create` are not in `NAV`: two of them need a
> `serverId` param, so a bare digit shortcut could not address them. They are reached from the
> Dashboard's server table (`Enter` / `c` / `n`) and from the detail page's action bar. **There is no
> Servers screen** — the table lives on the Dashboard (§ Dashboard below).

## Notifications — `components/Toast.tsx` + `hooks/use-toast.tsx`

The app's one channel for transient reports ("Settings saved", "Start failed"), split on the same
pure-UI line as everything else: the **card and its anchored viewport** are rendering only, and the
**provider** owns the queue, the delays, the time-to-live countdowns, and the stacking. A toast never
performs an action — the page or hook that did the work raises it afterwards.

`ToastProvider` is mounted **at the root** (`App.tsx`, below `InputCaptureProvider`) for two reasons: a
viewport is `position="absolute"` against its parent, so the parent must be the screen; and the setup
wizard needs toasts too. Being below the capture is what lets a toast action's single-key binding stand
down while a text field is being typed into — the same rule the shell's shortcuts follow.

Viewports are content-sized rather than full-screen, so they never intercept the page's mouse events
(the opposite of `Dialog`, whose backdrop intercepts on purpose). Overflow beyond `maxVisible`
**queues** — a queued toast has no countdown until it is actually on screen — so a burst of reports
loses none of them.

---

## First-run wizard — `app/setup/`

Triggered when `~/.config/mctl/config.json` is absent. Its own flow (not a normal page): data root →
path overrides → defaults → backup policy → network → review & write. Writes the directory tree,
`config.json`, and an empty `0600` `secrets.json`, then enters the dashboard. Settings renders the same
Zod schema so everything but `root` is editable later; `configVersion` drives forward migration.
`mctl init` is the headless equivalent, same fields as flags, identical `config.json` output.

## Dashboard — `app/Dashboard/`

The landing screen **and** the fleet list: the former Servers page was folded into it (2026-08-03), so
there is one place that answers "what do I have and what is it doing". Layout is summary tiles →
column header → one row per server, and the **selected row expands in place** beneath itself with the
fields the table has no column for (name, loader, java, memory, network, path) plus the live session
(pid/port/startedAt) when the server is running. Expansion follows selection rather than being a
separate toggle — there is only ever one open panel, so the page cannot become a wall of detail.

`Enter` opens the full detail page (`server`), `c` the console, `n` the create form; ↑/↓ or j/k move.
A mouse click selects an unselected row and opens an already-selected one, so the pointer and the
keyboard mean the same thing. Recent activity was dropped: the event feed read as debug output next
to the server table, and `events.jsonl` is a sync mechanism, not a user-facing log.

## Settings — `app/Settings/`

The wizard's peer for every later edit. `use-settings.ts` is the page's only bridge to core: it maps
the validated config to a flat `SettingsDraft` (everything but `root`, which is permanent), validates
it, and commits with `writeConfig` → `ensureDirTree`. `draftToConfig` **merges over the loaded
config**, so keys the form does not render (backup schedule/retention, named network profiles, keys
written by a newer MCTL) survive an edit. Edits are buffered and written on Save / Ctrl+S; the
config-dir watcher's `ConfigChanged` refreshes this and every other instance. The **Appearance group
is the exception**: its theme and icon pickers are owned by their providers, which persist on change,
so both apply immediately rather than on Save. `save(themeId, iconMode)` takes both live values as
arguments, so a Save fired in the window between a pick and its `ConfigChanged` refresh cannot write
the previous value back.

---

## Errors, validation, jobs

- **Zod at every boundary** — `config.json`, `secrets.json`, `servers.json`, `events.jsonl` lines,
  every upstream API response. Trust nothing off disk or network. Throw typed errors; never swallow.
- **Jobs** (`core/jobs/`): long work → `Job` with `Queued → Downloading → Installing → Verifying →
  Done|Failed`, emitting `JobProgress`. Installs stage into `$ROOT/downloads/staging/<uuid>/` and move
  into place only on success. Nothing long-running blocks the render path.
- Test providers against **recorded API fixtures**, not the live network.
