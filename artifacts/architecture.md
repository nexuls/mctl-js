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
                         Dashboard/ Servers/ Server/ Console/ Jobs/ Backups/ Network/ Settings/
  components/          pure UI (Table, Console, ProgressBar, Modal, StatusBar…)
  hooks/               useServers, useServer, useJobs, useConsole, useEventLog…
  core/                config, registry, session, events, jobs, server, java, runtime, network, backup
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

---

## Provider system — `core/registry/` (ProviderRegistry)

Dynamically registered modules, not compile-time wiring:

```ts
registry.register(new PaperProvider());
registry.register(new TmuxRuntime());
registry.register(new FilesystemBackupProvider());
```

Interfaces (`types/` + `core/*/`): `ServerProvider`, `RuntimeProvider`, `BackupProvider`,
`NetworkProvider`. Core resolves by the `kind` / `runtime` / `network` fields in `mctl.json`. Write the
interface against the first real implementation; generalize at the second.

---

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

---

## First-run wizard — `app/setup/`

Triggered when `~/.config/mctl/config.json` is absent. Its own flow (not a normal page): data root →
path overrides → defaults → backup policy → network → review & write. Writes the directory tree,
`config.json`, and an empty `0600` `secrets.json`, then enters the dashboard. Settings renders the same
Zod schema so everything but `root` is editable later; `configVersion` drives forward migration.
`mctl init` is the headless equivalent, same fields as flags, identical `config.json` output.

---

## Errors, validation, jobs

- **Zod at every boundary** — `config.json`, `secrets.json`, `servers.json`, `events.jsonl` lines,
  every upstream API response. Trust nothing off disk or network. Throw typed errors; never swallow.
- **Jobs** (`core/jobs/`): long work → `Job` with `Queued → Downloading → Installing → Verifying →
  Done|Failed`, emitting `JobProgress`. Installs stage into `$ROOT/downloads/staging/<uuid>/` and move
  into place only on success. Nothing long-running blocks the render path.
- Test providers against **recorded API fixtures**, not the live network.
