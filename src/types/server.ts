/**
 * Zod schemas and inferred types for the server domain: the server-owned
 * `mctl.json` file, the Server Location Registry file (`servers.json`), the
 * runtime session descriptor (`runtime/<id>.json`), and the derived `Server`
 * view model the front-ends render.
 *
 * No I/O here — this module only *describes and validates* shapes. Reading,
 * verifying, and probing live in `core/registry/` and `core/session/`.
 * Validation is applied at the disk boundary (AGENTS.md § "Zod at every
 * boundary"): `mctl.json`, `servers.json`, and every `runtime/<id>.json` are
 * off-disk data and are trusted only after parsing here.
 *
 * **Key invariants encoded here:**
 *  - `mctl.json` is the server's *config* source of truth. The `Server` view
 *    model additionally carries `state` (probed live, never stored) and
 *    `available` (false when the registry path is missing) — those are derived,
 *    not read from `mctl.json`.
 *  - `servers.json` holds **locations only** (`id → path`), never contents.
 */

import { isAbsolute } from "node:path";
import { z } from "zod";
import { RuntimeKind } from "./config.ts";

/** An absolute filesystem path; a relative path in state files is always a bug. */
const AbsolutePath = z
  .string()
  .min(1)
  .refine(isAbsolute, { message: "must be an absolute path" });

/**
 * Current `mctl.json` schema version. Bumped when the on-disk shape changes in a
 * non-backward-compatible way. Phase 1 never *writes* `mctl.json` (create is
 * Phase 2), so this is a read-time contract for now.
 */
export const MCTL_JSON_VERSION = 1;

/**
 * The resolved Java requirement recorded for a server: either a plain major
 * version (MCTL resolved it from an upstream API) or an explicit user pin that
 * must never be re-derived. Mirrors `plan.md` § Core Objects.
 */
export const JavaPin = z.union([
  z.number().int().positive(),
  z.object({ pinned: z.number().int().positive() }),
]);
export type JavaPin = z.infer<typeof JavaPin>;

/**
 * `mctl.json` — the single MCTL-owned file inside a server directory and the
 * authoritative source for that server's configuration. Everything else (mods,
 * players, port, live state, world size) is derived from disk or RCON at display
 * time, never mirrored here.
 *
 * A **loose** object: unknown keys are preserved rather than stripped, so fields
 * added by later phases (install strategy, launch spec — Phase 2/3) survive a
 * read/parse round-trip on a server created by a newer MCTL.
 */
export const MctlJson = z.looseObject({
  schemaVersion: z.number().int().positive().default(MCTL_JSON_VERSION),
  /** Human-facing server name. The id is derived from the directory name, not this. */
  name: z.string().min(1),
  /**
   * Server kind — the id of the `ServerProvider` that owns this server
   * (`"vanilla"`, `"paper"`, later `"fabric"`, …).
   *
   * A free string, **not** the `ServerKind` enum, and deliberately so: the
   * authoritative list of kinds is the runtime `ProviderRegistry`, and duplicating
   * it in a schema would mean a server created by a newer MCTL fails to parse and
   * shows up as *unavailable* rather than as "this build has no provider for
   * `fabric`". An unknown kind surfaces as an `UnknownProviderError` at the
   * moment it matters (start/install), which is a far better message.
   */
  kind: z.string().min(1),
  minecraftVersion: z.string().min(1),
  /** Loader version for Fabric/Forge/etc.; absent for vanilla-family servers. */
  loaderVersion: z.string().optional(),
  /** Resolved Java major, or an explicit `{ pinned }`. Absent until Phase 2 resolves it. */
  java: JavaPin.optional(),
  /** JVM heap, e.g. `"2G"`. Free-form; validated by the runtime later. */
  memory: z.string().default("2G"),
  /** Runtime provider id the server runs under. */
  runtime: RuntimeKind.default("foreground"),
  /** Network profile name; `"direct"` unless a tunnel profile is chosen. */
  network: z.string().default("direct"),
  /** ISO-8601 creation timestamp, written at create time (Phase 2). */
  createdAt: z.string().optional(),
});
export type MctlJson = z.infer<typeof MctlJson>;

/** One entry in the Server Location Registry: an id pointing at an absolute path. */
export const ServerRegistryEntry = z.object({
  /** Stable server id (derived from the directory name at create/discovery time). */
  id: z.string().min(1),
  /** Absolute path to the server directory (may live outside `servers_dir`). */
  path: AbsolutePath,
});
export type ServerRegistryEntry = z.infer<typeof ServerRegistryEntry>;

/**
 * `~/.local/state/mctl/servers.json` — the location registry. A **pointer index
 * only**: it maps ids to paths and stores nothing about server contents. Durable
 * state, written atomically. See `architecture.md` § Server Location Registry.
 */
export const ServerRegistryFile = z.object({
  version: z.number().int().positive().default(1),
  servers: z.array(ServerRegistryEntry).default([]),
});
export type ServerRegistryFile = z.infer<typeof ServerRegistryFile>;

/**
 * The runtime session descriptor written by a runtime provider when it starts a
 * server (`~/.local/state/mctl/runtime/<id>.json`). This is the on-disk record
 * that *replaces what a database would have tracked*: liveness is re-derived from
 * it on every launch, never held in memory. It carries liveness/identity only —
 * never server config.
 */
export const RuntimeSession = z.object({
  /** OS process id to probe for liveness. */
  pid: z.number().int().positive(),
  /** Runtime provider that owns this session. */
  runtime: RuntimeKind,
  /**
   * Provider-specific session handle — a tmux session name or docker container
   * id — used to confirm the session still exists for detached runtimes. Absent
   * for the foreground runtime, whose liveness is the pid alone.
   */
  sessionRef: z.string().optional(),
  /** Port the server bound, when known. */
  port: z.number().int().positive().optional(),
  /** ISO-8601 start time. */
  startedAt: z.string(),
});
export type RuntimeSession = z.infer<typeof RuntimeSession>;

/**
 * Probed run state of a server. **Always derived** from `runtime/<id>.json` plus
 * a liveness probe (or the registry, for `unavailable`) — never stored. See
 * `architecture.md` § Statelessness.
 *
 *  - `running`     — a session descriptor exists and its process/session is alive.
 *  - `stopped`     — no live session (no descriptor, or a reaped dead one).
 *  - `unavailable` — the registry path or its `mctl.json` is missing (drive
 *                    unmounted, folder moved) — the server can't be inspected.
 *  - `unknown`     — the descriptor could not be probed conclusively.
 */
export const ServerState = z.enum([
  "running",
  "stopped",
  "unavailable",
  "unknown",
]);
export type ServerState = z.infer<typeof ServerState>;

/**
 * The `Server` view model — the shape both front-ends render, rebuilt from disk
 * on every read (never cached as truth). Its config fields come from `mctl.json`;
 * `state` is probed live and `available` reflects the registry path. This is the
 * only server type the UI and CLI ever see — they never touch a provider type.
 */
export interface Server {
  /** Server id, derived from the directory name; the registry key. */
  id: string;
  /** Human-facing name from `mctl.json` (falls back to `id` when unavailable). */
  name: string;
  /** Server kind / provider id. */
  kind: string;
  /** Minecraft version. */
  minecraftVersion: string;
  /** Loader version, when the kind has one. */
  loaderVersion?: string;
  /** Resolved Java major or explicit pin, when known. */
  java?: JavaPin;
  /** JVM heap string, e.g. `"2G"`. */
  memory: string;
  /** Runtime provider id. */
  runtime: string;
  /** Network profile name. */
  network: string;
  /** Absolute path to the server directory. */
  path: string;
  /** Live-probed run state (never stored). */
  state: ServerState;
  /** False when the registry path is missing — the server can't be loaded. */
  available: boolean;
  /** Live session details when `state === "running"`, else absent. */
  session?: RuntimeSession;
}
