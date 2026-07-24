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

## Gotchas / open questions

- Anything referencing `.toml`, Rust crates, `cargo`, `thiserror`, or a top-level `pages/` in an
  artifact is stale — port it on sight.
- **Supervision under statelessness is a real tension:** without a daemon, auto-restart/tunnel keepalive
  only runs while some instance is alive (opportunistic, lock-guarded). If the user wants always-on
  behaviour, that's the Phase-5 agent — flag it rather than silently assuming a daemon.
