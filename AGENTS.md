# AGENTS.md — Working Agreement for MCTL

MCTL is a **TypeScript + OpenTUI TUI *and* a scriptable CLI (on Bun)** for managing Minecraft servers,
built as a stateless, multi-instance platform over provider modules. This file is the
contract every agent session follows. Read it fully before touching code.

---

## 1. Read the artifacts first — every session, before any work

Four files carry the project's memory across sessions. **Read all four at the start of every
session, in this order, before writing a single line of code or answering a design question.**

| Artifact | What it is | Read | Write |
|---|---|---|---|
| [artifacts/plan.md](artifacts/plan.md) | High-level plan, product intent, roadmap phases | Always | Rarely — only when the user changes direction |
| [artifacts/memory.md](artifacts/memory.md) | Cross-session memory: decisions, gotchas, user preferences | Always | **Every session** |
| [artifacts/architecture.md](artifacts/architecture.md) | Detailed architecture: layers, directory structure, interfaces, data flow, invariants | Always | When a structural decision is made or changed |
| [artifacts/progress.md](artifacts/progress.md) | Baseline state for the next agent: done / in progress / next | Always | **Every session, at the end** |

Rules:

- **Never** start implementing from the user's prompt alone. The prompt is the delta; the artifacts
  are the state.
- If an artifact contradicts the code, the **code is truth** — fix the artifact and note the
  correction in `memory.md`.
- If an artifact contradicts another artifact, `plan.md` outranks `architecture.md` outranks
  `progress.md`. Resolve the conflict explicitly, don't silently pick one.
- Keep artifacts **append-light and prune-heavy**. Delete entries that are no longer true rather
  than stacking contradictory history. These are living documents, not a changelog — git already
  keeps history.
- Write to `memory.md` the moment something non-obvious is learned, not at the end of the session.
  A session can be interrupted; unwritten memory is lost memory.

---

## 2. Use the skills — they are checked in for a reason

Project skills are available to load via the Skill tool. **Load the relevant skill before writing
code in its domain.** They encode this project's chosen conventions; guessing from memory produces
code that drifts from them.

| Skill | Load it before |
|---|---|
| `opentui` | Any TUI work: components, layout, keyboard input, the React/Solid bindings, keymaps, plugins, testing. Covers the OpenTUI core API and `@opentui/react`. The repo pins `@opentui/core` / `@opentui/react` `^0.4.5` and React 19 — do not invent APIs; check the skill. |

If no skill covers the domain you're working in (HTTP/download managers, process supervision, Java
resolution, provider design), say so explicitly rather than pretending one guided you, and lean on the
patterns in `architecture.md`.

---

## 3. Clean architecture — the layering is non-negotiable

```
app/ pages  →  Hooks     ┐
                         ├─►  Core services  →  Provider interfaces  →  Provider impls
cli/ commands ───────────┘                              ↓
                                       lib/ (fs, shell, http, download, paths, watch, logger)
```

Dependencies point **inward only**. Concretely:

- **`components/` and `app/` pages must never** touch the filesystem, spawn processes, or call `Bun.*`
  I/O. They render props and call hooks. If the UI needs to know a server is a Forge server, that
  fact arrives as data on a view model — not as a `ForgeProvider` type. (Pages live in **`src/app/`**;
  there is no `src/pages/`.)
- **Two front-ends, one core.** The **TUI** (`app/`, via `hooks/`) and the **one-shot CLI**
  (`cli/commands/`) are peers over the same core services. Neither may hold domain logic the other
  lacks; both are projections of the same core view models. Never call `Bun.spawn` / `fs` from a page
  or a command — go `front-end → hook|command → core service → provider`.
- **Core knows provider *interfaces*, never concrete providers.** Concrete providers register into a
  `ProviderRegistry` at startup (wired in `src/index.tsx`); core resolves them by id. No provider
  imports another provider — a backup provider must not reach into a runtime.
- **`lib/` is leaf-level:** pure helpers over Bun/Node APIs, no knowledge of servers or providers.
- **The filesystem is the source of truth.** Never introduce SQLite or a store that mirrors server
  *contents*. A server's `mctl.json` is authoritative for its config; mods/players/port/state are
  derived from disk or RCON at display time; anything in `~/.cache/mctl/` must be safely deletable.
- **No authoritative in-memory state — MCTL manages servers, it does not hold them.** Never keep a
  cached "running set" or server model you treat as truth. Re-derive from disk + live probes
  (`~/.local/state/mctl/runtime/<id>.json`, pid/session liveness) on every launch and every change.
  This is what lets **multiple `mctl` instances run at once and stay in sync** — they coordinate only
  through the filesystem: `fs.watch` on hard-state files **plus** the append-only `events.jsonl` that
  every instance tails and re-emits. No IPC, no daemon, no leader. Supervision (auto-restart, tunnel
  keepalive) is opportunistic behind a lock file; an always-on agent is Phase 5. See `architecture.md`
  § Statelessness before touching session/discovery/event code.
- **JSON / JSONL only — no TOML, no YAML.** `mctl.json`, `config.json`, `secrets.json`,
  `events.jsonl`. Validate every one with **Zod** at the boundary.
- **The one sanctioned state file that references servers is the Server Location Registry**
  (`~/.local/state/mctl/servers.json`): **locations only** (`id → path`), never contents. It exists so
  servers can live outside `servers_dir`. Durable state, atomic writes; verify every path against a real
  `mctl.json` on load; mark missing paths *unavailable* rather than deleting them. See `architecture.md`
  § Server Location Registry — do not let it grow into a data mirror.

Practices:

- **One responsibility per module/service.** If a module needs a second sentence to describe, split it.
- **Errors:** throw typed errors; never swallow them. Validate all external data (config, registry,
  upstream API responses) with **Zod** at the boundary — trust nothing off disk or network.
- **No blocking I/O on the render path.** Long work becomes a **Job** that emits progress events.
- **Write the interface against the first real implementation**, then generalize when the second
  arrives. Don't design abstractions against imaginary cases.
- **Providers are registered modules**, not compile-time wiring. Adding a provider = write the class +
  `registry.register(new Thing())`.
- Test providers against **recorded API fixtures**, not the live network. Live end-to-end tests are
  opt-in, never part of the default run.

---

## 4. Comments — write for the developer who arrives later

The bar: a competent TypeScript developer who has never seen this code should understand **why**
without reading upstream API docs or Minecraft wiki pages.

- **Every exported function / class / interface gets a doc comment** (`/** … */`) — what it does, what
  it returns, when it throws.
- **Every module** carries a top-of-file comment stating its single responsibility and what it must
  *not* depend on (e.g. "UI-free; no `Bun.spawn`").
- **Comment the domain, not the syntax.** `// increment i` is noise. This is signal:

  ```ts
  /**
   * Forge 1.17+ does not ship a runnable jar. The installer generates
   * `libraries/net/minecraftforge/forge/<ver>/unix_args.txt`, which must be
   * passed to the JVM as an @argfile — launching the installer jar directly
   * silently re-runs the installer instead of starting the server.
   */
  launchSpec(dir: string): LaunchSpec {
  ```

- **Always document:** upstream API quirks and the endpoint they came from; version-dependent behaviour
  (Minecraft/loader version cutoffs); why a fallback exists and what triggers it; any non-obvious
  ordering, locking, or lifetime requirement; deliberate deviations from the plan (the Location
  Registry is one — say so where relevant).
- **Link the source.** When behaviour is derived from an external API, put the URL in the comment. The
  next developer will need to re-check it when the API changes.
- Mark deferred work as `// TODO(<phase>): …` referencing a roadmap phase from `plan.md`, and record it
  in `progress.md` too. A TODO that exists only in code is a TODO that gets lost.

---

## 5. Other important instructions

**Scope**

- Build what was asked. Don't scaffold future roadmap phases speculatively — the plan has phases for a
  reason, and empty folders rot. No `providers/backup/` before the backup phase.
- If the request conflicts with `plan.md` or `architecture.md`, say so in a sentence, then follow the
  user's instruction and record the deviation in `memory.md`.

**Verification before claiming completion**

- Type-check and run the app: `bunx tsc --noEmit` (once a `tsconfig` build is meaningful) and
  `bun run dev`. Add `lint`/`test` scripts when the first real module lands, then run them.
- Report failures honestly with the actual output. Never describe untested code as working.

**Secrets and user data**

- Never log, print, or place in an event payload: Cloudflare tokens, ngrok authtokens, S3 keys, or
  anything from `secrets.json`. Redact at the boundary.
- `secrets.json` is created `0600`. Verify the mode after any code that writes it.
- **Never delete or overwrite anything inside a server directory** except `mctl.json`. Worlds are
  irreplaceable user data. Destructive operations stage first and confirm before committing. Removing a
  server from the registry is not the same as deleting its directory — deletion is separate and
  explicitly confirmed.

**Platform**

- Linux is the primary target; keep macOS/Windows viable. Do not hardcode paths — resolve XDG dirs and
  `$ROOT` through `lib/paths.ts`. The Location Registry lives under `~/.local/state/mctl/`.
- Tunnel binaries (`cloudflared`, `playit`, `ngrok`, `tailscale`) are **discovered on `PATH`, never
  downloaded**. A missing binary degrades to direct networking with an install hint; it is not an error
  that stops a server from starting.

**Git**

- Do not commit or push unless asked. Conventional commit prefixes (`feat:`, `fix:`, `chore:`) match the
  existing history.

**End of session**

Before finishing any session that changed code or decisions:

1. Update [artifacts/progress.md](artifacts/progress.md) — what is done, what is half-done and exactly
   where it stopped, what the next agent should pick up.
2. Update [artifacts/memory.md](artifacts/memory.md) — decisions made, dead ends hit, user preferences
   learned, API quirks discovered.
3. Update [artifacts/architecture.md](artifacts/architecture.md) if any structural decision changed.

A session that leaves the artifacts stale has failed regardless of the code it produced.
