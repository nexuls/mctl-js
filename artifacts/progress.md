# MCTL — Progress

Baseline state for the next session. What's done, what's half-done and where it stopped, what to pick
up next. Updated at the end of every session that changes code or decisions.

_Last updated: 2026-07-25 (Phase 1 — foundation groundwork landed)_

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

## In progress

- Nothing mid-implementation. All the above compiles and runs.

## Next up (Phase 1 — Foundation, remaining)

Roughly in order:

1. First-run **setup wizard** (`app/setup/`) + `mctl init` command — collect fields, call `writeConfig` /
   `writeSecrets` / `ensureDirTree` (all already exist in `core/config`). CLI `init` currently stubs.
2. `core/registry/` — `ServerRegistry`: read/verify/write `servers.json` (atomic via `lib/fs`), verify
   each path + `mctl.json`, mark unavailable, fold in `servers_dir` scan. Needs a `Server` view model
   (`types/server.ts`) + `mctl.json` schema.
3. `core/session/` — probe `runtime/<id>.json` liveness, reap stale locks (statelessness core).
4. `core/events/` — in-process EventEmitter3 bus + `events.jsonl` tail/append + `fs.watch` watchers.
   `lib/fs.appendLine` is ready for the append side.
5. Front-ends: OpenTUI Dashboard + `Router`; `cli/` real `list` and `status` (+ `cli/format.ts`).
6. `lib/http.ts` with ETag cache (Phase 1 tail; first real need is Phase 2 downloads).

## Notes for the next agent

- **Do not scaffold empty phase-2+ folders** (providers, backups, network). Build per roadmap phase.
- **Statelessness is non-negotiable:** never cache an authoritative server set; recompute from disk +
  `runtime/<id>.json` probes. Cross-instance sync = `fs.watch` + `events.jsonl` tail, no IPC/daemon.
- **JSON/JSONL only** — no TOML anywhere. `mctl.json`, `config.json`, `secrets.json`, `events.jsonl`.
- Pages live in `src/app/`, not `src/pages/`. CLI in `src/cli/`.
- Registry + statelessness invariants live in `architecture.md` — read before touching discovery/session.
- Verify with `bunx tsc --noEmit` (or `bun run typecheck`) + `bun run dev`. No test/lint runner wired
  yet — add `bun test` when the first module worth unit-testing lands (registry/session are prime).
- **Path discipline:** never build an MCTL path by hand — call a `lib/paths.ts` helper. Never read/write
  a shared JSON file directly — go through `lib/fs.ts` (atomic) and validate with Zod.
- Config service already exposes everything the wizard/`init` need: `writeConfig`, `writeSecrets`,
  `ensureDirTree`, `resolveRootPaths`. Don't re-implement writing in the front-end.
