/**
 * Central path resolution for MCTL. Single responsibility: turn XDG env vars,
 * `$HOME`, and the user-chosen data `$ROOT` into concrete absolute paths.
 *
 * UI-free, provider-free, no I/O — pure string computation over `os`/`path` and
 * environment variables. Every other module MUST resolve paths through here;
 * hardcoding `~/.config/mctl` or `~/.local/state/mctl` anywhere else is a bug.
 *
 * Two families of path live here:
 *
 *  1. **Config/cache/state paths** — XDG-fixed, known *before* config is loaded
 *     (first-run detection needs `configFile()` to exist as a path even when the
 *     file does not). These never depend on `config.json`.
 *  2. **Data paths** (`servers/`, `backups/`, `java/`, `downloads/`) — rooted at
 *     the user-chosen `$ROOT`, so they are computed from a `RootPaths` object
 *     built from loaded config, not from the environment.
 *
 * See artifacts/architecture.md § "Paths & the state directory".
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** MCTL's namespace under every XDG base directory. */
const APP = "mctl";

/**
 * Resolve an XDG base directory: use `$VAR` when set and absolute, else the
 * spec default under `$HOME`. XDG requires the value be an absolute path; a
 * relative value is treated as unset per the base-dir spec.
 * https://specifications.freedesktop.org/basedir-spec/latest/
 */
function xdgBase(envVar: string, fallbackSegments: string[]): string {
  const value = process.env[envVar];
  if (value?.startsWith("/")) return value;
  return join(homedir(), ...fallbackSegments);
}

// ── Config: ~/.config/mctl (XDG_CONFIG_HOME) — FIXED, never configurable ──────

/** Root of MCTL's own configuration; `config.json`, `secrets.json`, themes. */
export function configDir(): string {
  return join(xdgBase("XDG_CONFIG_HOME", [".config"]), APP);
}

/** MCTL's main config file. Its absence is the first-run trigger. */
export function configFile(): string {
  return join(configDir(), "config.json");
}

/** API tokens, created `0600`. Env vars (`MCTL_*`) override its contents. */
export function secretsFile(): string {
  return join(configDir(), "secrets.json");
}

/** Directory of user theme JSON files. */
export function themesDir(): string {
  return join(configDir(), "themes");
}

/** User keybinding overrides. */
export function keybindingsFile(): string {
  return join(configDir(), "keybindings.json");
}

// ── Cache: ~/.cache/mctl (XDG_CACHE_HOME) — safe to delete at any time ────────

/** Root of disposable cache. Anything here must be safely deletable. */
export function cacheDir(): string {
  return join(xdgBase("XDG_CACHE_HOME", [".cache"]), APP);
}

/** Cached upstream manifests (ETag + TTL), keyed by source. */
export function apiCacheDir(): string {
  return join(cacheDir(), "api");
}

// ── State: ~/.local/state/mctl (XDG_STATE_HOME) — DURABLE, not disposable ─────

/** Root of durable local state: registry, event log, runtime descriptors. */
export function stateDir(): string {
  return join(xdgBase("XDG_STATE_HOME", [".local", "state"]), APP);
}

/** Server Location Registry: `id → absolute path`. Locations only, never contents. */
export function serversRegistryFile(): string {
  return join(stateDir(), "servers.json");
}

/** Append-only cross-instance event log tailed by every running instance. */
export function eventsLogFile(): string {
  return join(stateDir(), "events.jsonl");
}

/** Directory holding per-server session descriptors and lock files. */
export function runtimeDir(): string {
  return join(stateDir(), "runtime");
}

/** Session descriptor for one server: `{ pid, runtime, sessionRef, port, startedAt }`. */
export function runtimeFile(id: string): string {
  return join(runtimeDir(), `${id}.json`);
}

/** Per-server action / supervisor lock file. */
export function runtimeLockFile(id: string): string {
  return join(runtimeDir(), `${id}.lock`);
}

/** MCTL's own log directory (server logs stay inside each server dir instead). */
export function logsDir(): string {
  return join(stateDir(), "logs");
}

// ── Data: $ROOT (default ~/.mctl) — relocatable, chosen at first run ──────────

/** The default `$ROOT` when the first-run wizard offers one. */
export function defaultRoot(): string {
  return join(homedir(), ".mctl");
}

/**
 * Concrete data paths derived from loaded config. `servers` and `backups` are
 * independently overridable (large worlds may live on another drive), so they
 * are passed explicitly rather than always assumed under `root`.
 */
export interface RootPaths {
  /** The data root itself (`config.root`). */
  root: string;
  /** Default parent for new servers (`config.servers_dir`, defaults to `root/servers`). */
  serversDir: string;
  /** Backup destination (`config.backups_dir`, defaults to `root/backups`). */
  backupsDir: string;
  /** Managed JDKs, one dir per `<vendor>-<major>`. */
  javaDir: string;
  /** Installer jars and in-flight downloads. */
  downloadsDir: string;
  /** Per-install staging area (`downloads/staging/<uuid>/`); moved into place on success. */
  stagingDir: string;
}

/**
 * Build the data-path set for a given root and optional dir overrides. Pure:
 * callers pass values already read and validated from `config.json`.
 */
export function rootPaths(
  root: string,
  overrides?: { serversDir?: string; backupsDir?: string },
): RootPaths {
  const downloadsDir = join(root, "downloads");
  return {
    root,
    serversDir: overrides?.serversDir ?? join(root, "servers"),
    backupsDir: overrides?.backupsDir ?? join(root, "backups"),
    javaDir: join(root, "java"),
    downloadsDir,
    stagingDir: join(downloadsDir, "staging"),
  };
}
