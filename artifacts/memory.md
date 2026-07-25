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

## Theming (2026-07-25)

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

## Gotchas / open questions

- Anything referencing `.toml`, Rust crates, `cargo`, `thiserror`, or a top-level `pages/` in an
  artifact is stale — port it on sight.
- **Supervision under statelessness is a real tension:** without a daemon, auto-restart/tunnel keepalive
  only runs while some instance is alive (opportunistic, lock-guarded). If the user wants always-on
  behaviour, that's the Phase-5 agent — flag it rather than silently assuming a daemon.
