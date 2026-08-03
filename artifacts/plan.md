# MCTL — Plan

**MCTL** reads like a native Unix utility (`systemctl`, `journalctl`, `loginctl`, `podman`) — and that
is the point. It is a **platform for managing Minecraft servers**, not a single launcher. Minecraft-
specific behaviour lives in providers, so supporting a new server implementation, runtime, backup
target, or tunnel never means editing the core.

Implemented in **TypeScript on Bun**, with an **OpenTUI (React) TUI** *and* a scriptable **one-shot
CLI** over the same core. The architecture is a direct descendant of the original Rust design — the
separation of concerns carries over unchanged; only the language, the crate layout, and a few
deliberate simplifications differ.

---

# Design Principles

1. **No database. The filesystem is the source of truth.** Minecraft servers are already a file-based
   store. A mirror (SQLite or otherwise) would be a second source of truth that silently drifts the
   moment the user edits `server.properties`, drops a jar into `mods/`, or moves a directory.
   Everything about a server is discovered by reading disk at read time.

2. **No in-memory authoritative state. MCTL manages servers; it does not hold them.** The running
   application caches nothing it treats as truth. Every server's identity, configuration, and run
   state is re-derived from disk (and from live process probes) on each launch and on every change.
   The consequence — a first-class requirement, not an accident — is that **multiple `mctl` instances
   can run at once and stay in sync**, because none of them owns the state; they are all thin views
   over the same files, kept live by filesystem watching and an on-disk event log. See
   *Statelessness & Multi-Instance Sync*.

3. **JSON / JSONL everywhere. No TOML, no YAML.** One serialization format across config, per-server
   metadata, the location registry, and the append-only event log. `mctl.json` is a server's owned
   file; `config.json` and `secrets.json` are MCTL's; `events.jsonl` is the cross-instance log.
   One parser, one schema tool (Zod), no format juggling.

4. **Install methods are per-server-type and explicit.** Fabric/Paper/Vanilla ship a directly runnable
   jar; Forge/NeoForge ship an *installer* jar that must be executed to generate a run script and
   library tree; Spigot must be compiled with BuildTools. A single `install()` hook would hide this —
   MCTL models it as an explicit strategy union instead.

5. **Java is resolved from upstream APIs**, choosing the highest version within the declared range.
   Only when no API declares a requirement does MCTL ask the user, and that answer is then pinned.

6. **Config is XDG-fixed; data is relocatable.** World data gets large and often belongs on a
   different drive. `servers_dir` is only a *default*; each server records its true location in the
   registry and may live anywhere.

7. **Networking is a first-class subsystem** — direct, tunnels, and Cloudflare DNS automation.

8. **Two front-ends, one core.** The TUI and the CLI are peers. The core knows about neither. Anything
   the TUI can do, the CLI can do; anything either does goes `front-end → hook/command → core service
   → provider`.

---

# High-Level Goals

```
        ┌───────────────────────┐   ┌───────────────────────┐
        │   OpenTUI (React) UI  │   │   One-shot CLI        │
        └───────────┬───────────┘   └───────────┬───────────┘
                    │                            │
                    └────────────┬───────────────┘
                        Commands / Events
                                 │
                    ┌────────────┴────────────┐
                    │     MCTL Core Engine    │   (no authoritative in-memory state)
                    └────────────┬────────────┘
                                 │
   ┌───────────┬─────────────────┼─────────────────┬───────────┐
   │           │                 │                 │           │
Location    Provider          Session           Network      Job
Registry    Registry          Manager           Manager    Scheduler
   │           │                 │                 │           │
   ▼           ▼                 ▼                 ▼           ▼
servers.json  Server         probe pid/lock     Network     Download /
+ per-dir     Runtime        in state/runtime   Providers   Install jobs
mctl.json     Backup         (never held)       (direct,
scan          Providers                          tunnels)
```

Everything is replaceable. Nothing is remembered between reads.

---

# Statelessness & Multi-Instance Sync

This is the defining architectural constraint of the TypeScript version, and it shapes everything else.

**MCTL is not a daemon and holds no authoritative model.** There is no long-lived process that "owns"
the servers. Each `mctl` invocation — TUI or CLI — is a transient view built entirely from:

* on-disk **hard state** (`config.json`, `servers.json`, each server's `mctl.json`), and
* live **process probes** (pid/lock files under `~/.local/state/mctl/runtime/`, plus tmux/docker
  session existence).

A single instance may keep an *in-process* cache to render efficiently, but that cache is a derived
projection, never a source of truth, and is invalidated the instant the underlying file changes.

**Server sessions are re-identified at launch, never stored.** When a runtime starts a server it writes
a session descriptor — `~/.local/state/mctl/runtime/<id>.json` — holding `{ pid, runtime, sessionRef,
port, startedAt }`. On any launch or refresh, `SessionManager.probe(id)` reads that file and confirms
liveness (pid alive; for tmux/docker, the session/container still exists). A dead descriptor is reaped.
No instance carries "the set of running servers" in memory; the set is always recomputed from disk.

**Multiple instances stay in sync by watching files, not by talking to each other.** There is no IPC
socket and no leader. Two mechanisms keep every instance current:

1. **Filesystem watchers** (`fs.watch` / Bun) on `config.json`, `servers.json`, the `runtime/`
   directory, and each active server directory. A change → re-read the affected hard state → emit a
   local event → UI/CLI updates.
2. **An append-only event log**, `~/.local/state/mctl/events.jsonl`. Every state-changing action
   (server started/stopped, job progressed, backup finished, config changed) is appended as one JSON
   line, tagged with the originating instance id. Every instance **tails** this log from the end and
   re-emits entries onto its local bus. This gives ordered, semantically rich cross-instance events
   that raw file-watching cannot (e.g. "instance B started *survival*"), and doubles as a recent
   activity feed for the dashboard.

**Concurrency & ownership.** Writes to shared files are atomic (temp file + `rename`). Actions that must
not run twice at once (starting the same server, running one installer) take a per-resource **lock
file** under `runtime/`; a stale lock (dead owner pid) is reaped. Long-lived *supervision* (auto-restart,
tunnel keepalive) requires a live process, so it is performed **opportunistically** by whichever
instance holds the supervisor lock for that server, and simply pauses if no instance is running. A
dedicated always-on agent is deferred to Phase 5 — the file-based model is the substrate it would build
on, so nothing is thrown away.

**Detached runtimes are the norm for anything long-lived.** Foreground runtime ties the server's
lifetime to the MCTL process (fine for dev/quick use); tmux and docker runtimes **outlive** the
instance, so a server survives closing the TUI and any later instance re-discovers and re-attaches to it
by probing. This is what makes "MCTL manages, does not hold" real.

---

# Layered Architecture

```
Pages (src/app)  →  Hooks     ┐
                              ├─►  Core services (managers)
CLI commands     →  Commands  ┘         │
                                        ▼
                              Provider interfaces
                                        │
                                        ▼
                              Provider implementations
                                        │
                                        ▼
                    lib/ (fs, shell, http, download, paths, watch, logger)
```

Dependencies point **inward only**. The UI and the CLI know **nothing** about PaperMC, Docker, tmux,
Java, or Cloudflare. If the UI must know a server is Forge, that arrives as a plain field on a view
model — never as a `ForgeProvider` type.

```
Start a server (either front-end)
        │
        ▼
Core receives the command
        │
        ▼
Read servers.json → resolve path → read that server's mctl.json
        │
        ▼
Resolve Java   ‖   ask the network provider to expose
        │
        ▼
Ask the runtime provider to start (writes runtime/<id>.json)
        │
        ▼
Append `ServerStateChanged` to events.jsonl  →  every instance updates
```

---

# Directory Layout

MCTL's own configuration is XDG-fixed and never configurable. Data lives at a user-chosen `$ROOT`
(default `$HOME/.mctl`), with `servers` and `backups` independently overridable so large worlds can
live on a separate drive.

```
~/.config/mctl/                 FIXED, never configurable
  config.json                   root path, defaults, network profiles, backup policy, servers_dir
  secrets.json                  0600; API tokens. Env vars override.
  themes/*.json
  keybindings.json

$ROOT/                          chosen at first run, NOT editable afterwards
  servers/                      DEFAULT parent for new servers — config.servers_dir
  backups/                      config.backups_dir
  java/<vendor>-<major>/        managed JDKs
  downloads/                    installer jars, in-flight downloads, staging

~/.cache/mctl/                  XDG; safe to delete at any time
  api/                          cached upstream manifests (ETag + TTL)

~/.local/state/mctl/            DURABLE local state — not disposable
  servers.json                  location registry: server id → absolute path
  events.jsonl                  append-only cross-instance event log
  runtime/<id>.json             per-server session descriptor (pid, sessionRef, port…)
  runtime/<id>.lock             per-server action / supervisor locks
  logs/                         MCTL's own logs only
```

Server logs stay inside each server directory. MCTL writes exactly **one** file into a server
directory:

```
<server dir>/                   may live anywhere; default is $SERVERS_DIR/<name>
  mctl.json            ← the ONLY MCTL-owned file; the server's source of truth
  server.jar | run.sh  ← depends on install strategy
  server.properties    ← read live, never mirrored
  libraries/ mods/ plugins/ world/ logs/
```

`mctl.json` holds: name, kind, Minecraft version, loader version, Java pin, memory, runtime, install
strategy, launch spec, network profile, created-at. Everything else — mod list, players, port, MOTD,
world size, last run — is derived from disk or RCON at display time.

---

# Server Location Registry

Servers are **not** confined to `servers_dir`, so scanning one directory cannot find them all.
`~/.local/state/mctl/servers.json` is a **pointer index** — locations only, never contents:

```jsonc
{
  "version": 1,
  "servers": [
    { "id": "survival", "path": "/home/user/.mctl/servers/Survival" },
    { "id": "creative", "path": "/mnt/big-drive/mc/Creative" }
  ]
}
```

**Load & verify (every launch).** For each entry, check the path exists and holds a readable
`mctl.json`:

| Outcome | Behaviour |
|---|---|
| Valid | Server appears, loaded from its `mctl.json`. |
| Path/`mctl.json` missing | Marked **unavailable** (e.g. drive unmounted). **Never** auto-deleted — an unmounted drive is not a deleted server. User re-points or forgets it explicitly. |

**Auto-discovery.** On top of the registry, MCTL scans `config.servers_dir` for `*/mctl.json` and folds
any found-but-unregistered server in. Dropping a folder into `servers_dir` "just works"; servers
elsewhere are tracked only because the registry records them — which is why the registry is **durable
state** (`~/.local/state/`, atomic writes), not disposable cache.

**Discovery flow.**

```
read servers.json → verify each path (+mctl.json)
        │
        ▼
scan servers_dir for new mctl.json → merge into registry (atomic)
        │
        ▼
build Server view models (valid) / mark unavailable (missing)
```

Create writes `mctl.json`, then registers `{ id, path }`. Delete removes the registry entry (and, only
on explicit confirmation, the directory). There is no separate import/registration step.

---

# Project Structure

`src/hooks/` and `src/index.tsx` exist today; the rest is built per roadmap phase — folders are not
scaffolded ahead of their phase.

```
src/
  index.tsx              entry: parse argv → TUI (no args) or one-shot CLI

  cli/                   one-shot command layer
    router.ts            argv → command
    commands/            list, create, start, stop, logs, backup, init, …
    format.ts            human table vs --json output

  app/                   the OpenTUI (React) TUI — pages live HERE now
    App.tsx
    Router.tsx
    setup/               first-run wizard (its own flow, not a normal page)
    Dashboard/  Server/  Console/  Jobs/
    Backups/    Network/  Settings/

  components/            pure UI: Table, Console, ProgressBar, Modal, StatusBar…
  hooks/                 useServers, useServer, useJobs, useConsole, useEventLog…

  core/                  the brain — no UI, no argv, no direct Bun I/O in signatures
    config/              load/validate config.json + secrets.json, first-run detection, migration
    registry/            ServerRegistry (servers.json) + ProviderRegistry
    session/             SessionManager — probe/reap runtime/<id>.json, locks
    events/              in-process bus + events.jsonl tail/append + fs watchers
    jobs/                JobScheduler
    server/              ServerManager, install strategies, version + Java resolution
    java/                JavaManager
    runtime/             RuntimeManager
    network/             NetworkManager
    backup/              BackupManager

  providers/             concrete, dynamically-registered implementations
    server/    vanilla.ts paper.ts fabric.ts forge.ts …
    runtime/   foreground.ts tmux.ts docker.ts
    backup/    filesystem.ts s3.ts drive.ts …
    network/   direct.ts cloudflared.ts playit.ts …

  lib/                   leaf helpers: fs, shell, download, http, paths, watch, logger
  types/                 server.ts runtime.ts java.ts events.ts config.ts
  utils/
```

**Responsibilities:** `components/` render only (never touch fs, never spawn). `app/` pages compose
components and call hooks. `hooks/` adapt core state to render state and are the *only* bridge between
TUI and core. `cli/commands/` are the CLI's equivalent bridge — thin, calling the same core services.
`core/` holds all logic; every front-end talks to it. `lib/` knows nothing of servers or providers.

---

# Dual Interface — TUI and CLI

`mctl` dispatches on argv in `src/index.tsx`:

```
mctl                      → launch the OpenTUI dashboard (interactive)
mctl <command> [args]     → run one command, print, exit (scriptable)
```

Both paths call identical core services — the CLI is not a second implementation, it is a second
front-end.

```
mctl list                     table of servers + state (probed live)
mctl create <name> --kind paper --mc 1.21.4 [--path /mnt/…]
mctl start <id> | stop <id> | restart <id>
mctl logs <id> [-f]           stream from the runtime
mctl status <id>              one server, verbose
mctl backup <id> | restore <id> <archive>
mctl java list | install <major>
mctl init                     run first-run setup non-interactively (flags) or prompt
mctl <anything> --json        machine-readable output for scripting
```

Design rules:

* **CLI output is derived from the same view models the TUI renders** — no divergent formatting logic
  in core. `--json` emits the raw view model; the default emits a human table.
* **A one-shot CLI command is a transient instance too.** It reads hard state, acts, appends to
  `events.jsonl`, exits. A TUI instance watching the log reflects the change immediately. This is the
  statelessness principle paying off: `mctl start survival` from a script and an open dashboard never
  disagree.
* **First run in CLI mode** does not silently create config: an action that needs config when
  `config.json` is absent errors with "run `mctl init`" (or, if a TTY, offers to run the wizard).

---

# First-Run Setup Wizard

Triggered when `~/.config/mctl/config.json` is absent. A dedicated wizard flow (its own screens under
`app/setup/`), not a normal page. It writes the defaults once, and never blocks again.

1. **Data root** — path input, default `$HOME/.mctl`, showing free space on the chosen filesystem.
   Permanent; shown read-only in Settings afterwards.
2. **Path overrides** (optional) — `servers_dir`, `backups_dir`.
3. **Defaults** — default Minecraft version, server kind, memory, runtime, EULA behaviour.
4. **Backup policy** — enabled, provider, schedule, retention, compression (`tar.zst` default).
5. **Network** — default profile, `direct` preselected. Tunnel/DNS setup deferred to the Network page
   so the wizard stays short.
6. **Review & write** — create the directory tree, write `config.json` and an empty `0600`
   `secrets.json`, then enter the dashboard.

The Settings page renders the **same schema**, so every value except `root` is editable later. Config
carries a `configVersion` with a forward migration path. The CLI equivalent is `mctl init`, which
accepts the same fields as flags for headless/first-boot setup and writes the identical `config.json`.

---

# Core Objects

## Server (view model — rebuilt from disk each read)

```ts
interface Server {
  id: string;              // derived from directory name
  name: string;
  kind: string;            // "fabric" | "forge" | "paper" | …
  minecraftVersion: string;
  loaderVersion?: string;
  java: number | { pinned: number };   // resolved major, or explicit pin
  memory: string;
  runtime: string;         // "foreground" | "tmux" | "docker"
  network: string;         // profile name, defaults to "direct"
  path: string;
  state: ServerState;      // PROBED from the runtime, never stored
  available: boolean;      // false when the registry path is missing
}
```

---

# Server Installation

Different server types install in genuinely different shapes, so the strategy is an explicit tagged
union rather than a hidden branch inside one `install()`:

```ts
type InstallStrategy =
  /** Vanilla, Paper, Purpur, Velocity: download one runnable jar. */
  | { kind: "directJar"; url: string; sha256?: string; dest: string }

  /** Fabric, Quilt: the meta API serves a pre-built launcher jar directly.
   *  meta.fabricmc.net/v2/versions/loader/{game}/{loader}/{installer}/server/jar */
  | { kind: "loaderJar"; url: string; dest: string }

  /** Forge, NeoForge: download an installer, run `java -jar installer.jar --installServer`,
   *  which generates libraries/, run.sh, user_jvm_args.txt and an @argfile.
   *  The installer is then discarded. */
  | { kind: "installer"; url: string; args: string[]; produces: LaunchSpec; cleanup: string[] }

  /** Spigot: fetch BuildTools.jar and compile. Slow; needs git + network. */
  | { kind: "buildFromSource"; toolUrl: string; args: string[]; outputGlob: string };

type LaunchSpec =
  /** java <jvmArgs> -jar server.jar nogui */
  | { kind: "jar"; jar: string }
  /** java @user_jvm_args.txt @libraries/.../unix_args.txt nogui  (Forge/NeoForge 1.17+) */
  | { kind: "argFile"; files: string[] }
  /** delegate to the generated run.sh / run.bat */
  | { kind: "script"; path: string };
```

## Server Provider

```ts
interface ServerProvider {
  readonly id: string;              // "fabric"
  readonly displayName: string;

  minecraftVersions(): Promise<VersionInfo[]>;
  loaderVersions(mc: string): Promise<LoaderVersion[]>;

  /** What the upstream API says about Java. null ⇒ the caller must ask the user. */
  javaRequirement(mc: string, loader?: string): Promise<JavaRequirement | null>;

  resolveInstall(req: InstallRequest): Promise<InstallStrategy>;
  launchSpec(dir: string): LaunchSpec;
  update(server: Server, target: VersionSpec): Promise<InstallStrategy>;
}
```

Implementations: Vanilla, Paper, Purpur, Fabric, Quilt, Forge, NeoForge, Velocity, Spigot, BungeeCord,
Waterfall.

Installs run as a **staged job** (`Download → RunInstaller → Verify`) inside
`$ROOT/downloads/staging/<uuid>/`, moved into place only on success. Each step emits progress; a failed
installer leaves a resumable state rather than a half-built server directory. The front-ends never know
which strategy was used.

---

# Java Manager

```ts
interface JavaRequirement { min: number; max?: number; recommended?: number }
```

Sources, per server kind:

| Kind | Source |
|---|---|
| Vanilla | version JSON → `javaVersion.majorVersion` (via `version_manifest_v2.json`) |
| Paper / Purpur | PaperMC v3 API version endpoint → java min/max |
| Fabric / Quilt | no declaration → fall back to the Vanilla requirement for that MC version |
| Forge / NeoForge | no declaration → Vanilla requirement, clamped by known loader constraints |

**Selection:** the highest installed-or-installable LTS (21 → 17 → 11 → 8) satisfying `min..=max`. When
`max` is absent, cap at the newest LTS MCTL knows how to fetch — *unbounded* ≠ *"tested at 25"*.

**Fallback:** if every source returns `null`, block with a prompt — *"Could not determine the Java
version for &lt;kind&gt; &lt;version&gt;. Select one:"* — listing installed JDKs plus a free-entry
field. The choice is written to `mctl.json` as `java.pinned` and never re-derived.

Responsibilities: detect installed Java (`$ROOT/java/`, `JAVA_HOME`, `PATH`, `/usr/lib/jvm`); download
Temurin from the Adoptium API for the current OS/arch; hold multiple versions side by side; per-server
override always wins.

---

# Runtime

```ts
interface RuntimeProvider {
  readonly id: string;                                  // "tmux"
  start(server: Server, spec: LaunchSpec): Promise<Session>;
  stop(server: Server): Promise<void>;
  restart(server: Server): Promise<void>;
  attach(server: Server): AsyncIterable<string>;        // stream console
  logs(server: Server): AsyncIterable<string>;
  exec(server: Server, command: string): Promise<void>; // send a console command
  /** Re-identify a session from runtime/<id>.json + a liveness probe. */
  status(server: Server): Promise<ServerState>;
}
```

Implementations: `ForegroundRuntime`, `TmuxRuntime`, `DockerRuntime`.

`status()` reads `~/.local/state/mctl/runtime/<id>.json` and verifies the recorded pid/session is alive
— this **replaces what a database would have tracked** and is the beating heart of statelessness. Stale
descriptors and locks are reaped at startup. Foreground ties the child to the MCTL process; tmux/docker
detach so servers outlive the instance and any later instance re-attaches by probing.

---

# Networking

```ts
interface NetworkProvider {
  readonly id: string;
  requires(): Binary[];                                 // e.g. ["cloudflared"]
  preflight(): Promise<Readiness>;                      // binary present? authenticated?
  expose(server: Server, port: number): Promise<Endpoint>;
  teardown(server: Server): Promise<void>;
  status(server: Server): Promise<NetStatus>;
}
```

All modes are optional; the default is direct.

* **Direct** — bind IPv4 / IPv6 / localhost, optional interface pinning. Reports detected LAN and
  public address as a copyable join address. No external dependency.
* **Tunnels (TCP)** — `cloudflared`, `playit`, `ngrok`, `tailscale`. Each is a supervised child
  process whose lifetime is tied to the server's (and, under the stateless model, supervised by
  whichever instance holds the supervisor lock). MCTL parses the assigned hostname/port from the
  client's output and surfaces it as the join address, with auto-restart and backoff on drop.
* **Cloudflare DNS** — creates/updates an `A`/`AAAA` record plus an `SRV` record for `_minecraft._tcp`,
  so players join on a bare domain with no port. Records are tagged with the server id in their comment
  field, so MCTL only ever touches records it created; teardown removes exactly those.

**Tunnel binaries are not managed by MCTL.** Providers discover them on `PATH`; a missing binary yields
`Readiness.Missing` with the platform's install command shown in the UI, and the server still starts on
direct networking rather than failing.

Profiles are named in `config.json` and referenced per server (`network.profile = "cf-tunnel"`).
Credentials live in `secrets.json` (`0600`), overridable by `MCTL_CLOUDFLARE_TOKEN`, `MCTL_NGROK_TOKEN`,
etc. Secrets are never logged and are redacted in every event payload.

---

# Backup System

```ts
interface BackupProvider {
  readonly id: string;
  backup(server: Server): Promise<BackupRef>;
  restore(server: Server, ref: BackupRef): Promise<void>;
  list(server: Server): Promise<BackupRef[]>;
  delete(ref: BackupRef): Promise<void>;
}
```

Providers: Filesystem, Google Drive, Dropbox, AWS S3, Azure Blob, MinIO, FTP, SFTP. Compression:
`tar.zst` (default), `tar.gz`, `zip`.

Archives are named `<server>-<utc-timestamp>.tar.zst` and enumerated by **listing the backup
directory** — no backup table. A sidecar `.json` per archive records MC version, kind, and size.
Incremental backups come later.

---

# Provider System

Providers are **dynamically registered modules** (the TypeScript simplification over Rust's compile-time
crates). Everything downstream talks only to the registry:

```ts
registry.register(new PaperProvider());
registry.register(new FabricProvider());
registry.register(new TmuxRuntime());
registry.register(new FilesystemBackupProvider());
```

Core resolves a provider by id from the `kind` / `runtime` / `network` fields in `mctl.json`. Write the
interface against the **first** real implementation; generalize when the second arrives. No provider
imports another provider.

---

# Event System

Events are the sync fabric, not just UI glue. There are two tiers:

* **In-process bus** (EventEmitter3): core and providers emit; hooks and CLI commands subscribe.
* **Cross-instance log** (`events.jsonl`): every state-changing event is appended as one JSON line
  tagged with the instance id; every instance tails the log and re-emits onto its local bus. Combined
  with `fs.watch` on the hard-state files, this keeps all instances consistent with no IPC.

```
ServerStateChanged      JobProgress          InstallStepChanged
TunnelUp / TunnelDown   JavaInstalled        DownloadCompleted
PlayerJoined / Left     BackupFinished       ConfigChanged
ServerUnavailable       RegistryChanged
```

Secrets are redacted before an event is ever emitted or written.

---

# Download Manager

Sources: Mojang, PaperMC, Fabric, Quilt, Forge, NeoForge, Adoptium, CurseForge and Modrinth metadata.
A shared HTTP layer (`lib/http.ts`) handles ETag-based caching into `~/.cache/mctl/api/` and resumable
downloads.

```
Queued → Downloading → Installing → Verifying → Done
```

---

# TUI Pages (under `src/app/`)

```
Dashboard  Server  Console  Jobs  Backups  Network  Settings
                                              (+ setup wizard on first run)
```

## Network Page

Per-server profile, provider readiness with missing-binary install hints, live tunnel status, the
current join address, and Cloudflare DNS record state.

---

# Recommended Libraries

| Purpose | Library |
|---|---|
| UI | OpenTUI (`@opentui/core`, `@opentui/react`) + React 19 |
| Runtime | Bun |
| Config / metadata / registry | **JSON** (native) — no TOML |
| Validation | Zod (every boundary) |
| Events | EventEmitter3 (in-process) + `events.jsonl` (cross-instance) |
| CLI parsing | lightweight argv parser (or hand-rolled `cli/router.ts`) |
| Logging | Pino |
| HTTP | `Bun.fetch` |
| Compression | tar + zstd bindings |
| Filesystem watching | `fs.watch` / `Bun` file watchers |

---

# Development Roadmap

**Phase 1 — Foundation**

* `lib/paths.ts` (XDG + `$ROOT`), config + secrets loading (JSON, Zod), first-run detection
* First-run **setup wizard** + `mctl init`
* Location registry (`servers.json`) + filesystem discovery
* Session probing (`runtime/<id>.json`) and stale-lock reaping
* Event system: in-process bus + `events.jsonl` tail/append + fs watchers
* OpenTUI shell + Dashboard; CLI dispatch (`mctl` vs `mctl <cmd>`) with `list`/`status`
* Logger; `lib/http.ts` with ETag cache

**Phase 2 — Server Lifecycle**

* `ServerProvider` + `InstallStrategy`; Vanilla and Paper (directJar)
* Java resolution, Adoptium download, manual-pin prompt
* Foreground runtime; console and log streaming
* Create / delete / edit servers (TUI and CLI)

**Phase 3 — Loaders, Installers, Runtimes**

* Fabric and Quilt (loaderJar); Forge and NeoForge (installer → argFile / script)
* Purpur, Velocity
* tmux runtime (detached, re-attachable); staged installs with resume

**Phase 4 — Networking & Operations**

* `direct` provider; cloudflared / playit / ngrok / tailscale
* Cloudflare DNS with SRV records
* Backup providers + scheduling; auto-restart, health checks, resource monitoring (supervisor lock)

**Phase 5 — Ecosystem**

* Docker runtime; Modrinth and CurseForge integration; RCON manager
* Optional always-on **agent/daemon** (built on the file-based sync substrate)
* REST API and web UI; remote agents, multi-host management
* Plugin protocol (JSON-RPC over stdio) for third-party providers

---

# Future Plugin Ideas

Geyser / Floodgate installers · mod & plugin marketplace · scheduled restarts · cron jobs · Prometheus
exporter · Discord and Telegram integration · SSH management · Kubernetes deployment · live player map ·
world editing tools.

---

## Architectural note

Providers are compiled-in modules registered at startup — type-safe, simply versioned, no dynamic
loading and no ABI. For third-party extensions later, add a stable protocol (JSON-RPC over stdio)
rather than exposing internal APIs. With the stateless, file-synced, provider-based structure above,
MCTL can grow from a local TUI + CLI into a complete Minecraft infrastructure platform without a core
rewrite.
