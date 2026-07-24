# MCTL — Progress

Baseline state for the next session. What's done, what's half-done and where it stopped, what to pick
up next. Updated at the end of every session that changes code or decisions.

_Last updated: 2026-07-25 (second design pass)_

---

## Done

- Repo scaffolded from `create-tui`: Bun + `@opentui/core` + `@opentui/react` + React 19.
- `src/index.tsx` entry and `src/hooks/use-terminal-colors.ts` exist (starter template only).
- `opentui` skill available and vendored under `.agents/skills/opentui/`.
- **Planning artifacts written for the TypeScript/OpenTUI stack, now reflecting the full design:**
  - `plan.md` — substantially enhanced (concrete TS interfaces, diagrams, tables) and updated with:
    JSON/JSONL-only, no in-memory state + multi-instance sync, dual TUI/CLI interface, first-run wizard,
    pages under `src/app/`, and the Server Location Registry.
  - `architecture.md` — layering, directory targets, statelessness/sync, registry, provider system,
    dual interface, wizard.
  - `memory.md` — stack + all decisions from both design passes.
  - `AGENTS.md` — rewritten for TypeScript/Bun/OpenTUI with the new invariants.

## In progress

- Nothing mid-implementation. Codebase is still the starter template; no `core/`, `providers/`,
  `app/`, `cli/`, or `lib/` yet.

## Next up (Phase 1 — Foundation)

Roughly in order:

1. `lib/paths.ts` — XDG resolution (`~/.config/mctl`, `$ROOT`, `~/.cache/mctl`, `~/.local/state/mctl`).
   Everything depends on it.
2. `core/config/` — load/validate **`config.json`** + `secrets.json` with Zod; first-run detection.
3. First-run **setup wizard** (`app/setup/`) + `mctl init` — write `config.json`, `0600 secrets.json`.
4. `core/registry/` — `ServerRegistry`: read/verify/write `servers.json` (atomic), verify paths +
   `mctl.json`, mark unavailable, fold in `servers_dir` scan.
5. `core/session/` — probe `runtime/<id>.json` liveness, reap stale locks (statelessness core).
6. `core/events/` — in-process EventEmitter3 bus + `events.jsonl` tail/append + `fs.watch` watchers.
7. Front-ends: `src/index.tsx` argv dispatch (TUI vs CLI); OpenTUI shell (`app/App.tsx`, `Router.tsx`,
   Dashboard); `cli/` with `list` and `status`.
8. Logger; `lib/http.ts` with ETag cache.

## Notes for the next agent

- **Do not scaffold empty phase-2+ folders** (providers, backups, network). Build per roadmap phase.
- **Statelessness is non-negotiable:** never cache an authoritative server set; recompute from disk +
  `runtime/<id>.json` probes. Cross-instance sync = `fs.watch` + `events.jsonl` tail, no IPC/daemon.
- **JSON/JSONL only** — no TOML anywhere. `mctl.json`, `config.json`, `secrets.json`, `events.jsonl`.
- Pages live in `src/app/`, not `src/pages/`. CLI in `src/cli/`.
- Registry + statelessness invariants live in `architecture.md` — read before touching discovery/session.
- Verify with `bun run dev`. No test/lint scripts yet — add them when the first real module lands.
