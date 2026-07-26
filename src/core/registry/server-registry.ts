/**
 * ServerRegistry — the Server Location Registry (`~/.local/state/mctl/servers.json`).
 * Lets a server live **anywhere**, not just under `servers_dir`, by recording
 * `id → absolute path`. A **location index only**: server config still lives
 * solely in each server's `mctl.json`. See architecture.md § Server Location
 * Registry.
 *
 * Core service — no UI, no argv, no provider imports. Depends only on `lib/`
 * (paths, fs, logger) and the Zod schemas in `types/server.ts`.
 *
 * **Invariants (do not let this grow into a data mirror):**
 *  - Paths never contents. Never store anything about a server but its location.
 *  - Absence ≠ deletion. A missing path is marked *unavailable*, never
 *    auto-removed — an unmounted drive is not a deleted server.
 *  - Durable state, atomic writes (temp + rename via `lib/fs`).
 *  - On top of the registry, `servers_dir` is scanned for drop-in servers and
 *    they are folded in — dropping a folder into `servers_dir` "just works".
 */

import { basename, join } from "node:path";
import { serversRegistryFile } from "../../lib/paths.ts";
import {
  readJsonIfExists,
  writeJsonAtomic,
  pathExists,
  readDirIfExists,
} from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import {
  ServerRegistryFile,
  type ServerRegistryEntry,
} from "../../types/server.ts";

const logger = log("registry");

/**
 * A registry entry resolved against the filesystem: the recorded location plus
 * whether its `mctl.json` is actually readable right now. `available: false`
 * means the path or its `mctl.json` is missing (drive unmounted, folder moved) —
 * the entry is kept, never deleted.
 */
export interface ResolvedEntry extends ServerRegistryEntry {
  /** True when `path/mctl.json` exists and is readable. */
  available: boolean;
}

/** Path to a server directory's `mctl.json`. */
export function mctlJsonPath(dir: string): string {
  return join(dir, "mctl.json");
}

/** Read and validate `servers.json`, returning an empty registry when absent. */
async function readRegistry(): Promise<ServerRegistryFile> {
  const raw = await readJsonIfExists(serversRegistryFile());
  if (raw === undefined) return { version: 1, servers: [] };
  const parsed = ServerRegistryFile.safeParse(raw);
  if (!parsed.success) {
    // A corrupt registry must not wipe the user's server references silently, but
    // it also must not crash the whole app. Log loudly and treat as empty for the
    // read; the servers_dir scan still recovers drop-in servers, and a later write
    // rebuilds a valid file. References to servers *outside* servers_dir are lost
    // only if the user also never re-adds them — acceptable for a corrupt file.
    logger.error(
      { file: serversRegistryFile(), issues: parsed.error.message },
      "servers.json is invalid; treating as empty (drop-ins still recovered by scan)",
    );
    return { version: 1, servers: [] };
  }
  return parsed.data;
}

/** Atomically persist the registry (durable state; temp + rename). */
async function writeRegistry(file: ServerRegistryFile): Promise<void> {
  await writeJsonAtomic(serversRegistryFile(), file);
  logger.debug({ count: file.servers.length }, "wrote servers.json");
}

/**
 * Load the registry, verify each entry against disk, fold in any unregistered
 * `mctl.json` found under `servers_dir`, and persist newly-discovered entries.
 *
 * This is the one disk-reading discovery step (architecture.md § Discovery
 * flow). It returns *resolved* entries — locations plus availability — leaving
 * the actual `mctl.json` parse and liveness probe to the caller
 * (`core/server/discover.ts`), which builds the `Server` view models.
 *
 * @param serversDir the configured default parent to scan for drop-in servers
 *   (`config.servers_dir`). Absent → skip the scan (registry-only load).
 * @returns every known server location with its current availability, id-sorted.
 */
export async function loadRegistry(
  serversDir?: string,
): Promise<ResolvedEntry[]> {
  const file = await readRegistry();
  const byId = new Map<string, ServerRegistryEntry>();
  for (const entry of file.servers) byId.set(entry.id, entry);

  // Fold in drop-in servers: any `*/mctl.json` under servers_dir not already
  // registered. Id is the directory name (the same rule create uses).
  let added = 0;
  if (serversDir !== undefined) {
    for (const name of await readDirIfExists(serversDir)) {
      const dir = join(serversDir, name);
      const id = basename(dir);
      if (byId.has(id)) continue;
      if (await pathExists(mctlJsonPath(dir))) {
        byId.set(id, { id, path: dir });
        added++;
      }
    }
  }

  // Persist additions so servers outside servers_dir stay tracked and drop-ins
  // are remembered even if the scan dir later changes. Only write when something
  // actually changed, to avoid needless churn (and needless watcher events).
  if (added > 0) {
    await writeRegistry({
      version: file.version,
      servers: [...byId.values()],
    });
    logger.info({ added }, "folded drop-in servers into registry");
  }

  // Resolve availability for every entry. Unavailable entries are kept as-is.
  const resolved: ResolvedEntry[] = [];
  for (const entry of byId.values()) {
    const available = await pathExists(mctlJsonPath(entry.path));
    resolved.push({ ...entry, available });
  }
  resolved.sort((a, b) => a.id.localeCompare(b.id));
  return resolved;
}

/**
 * Register a server location. Idempotent by id: re-adding an id updates its path
 * (a server was moved and re-pointed). Create calls this after writing
 * `mctl.json`. Atomic.
 */
export async function addServer(entry: ServerRegistryEntry): Promise<void> {
  const file = await readRegistry();
  const servers = file.servers.filter((s) => s.id !== entry.id);
  servers.push(entry);
  await writeRegistry({ version: file.version, servers });
  logger.info({ id: entry.id, path: entry.path }, "registered server location");
}

/**
 * Remove a server's registry entry. This forgets the *location only* — it does
 * **not** delete the server directory (that is a separate, explicitly-confirmed
 * destructive action, per AGENTS.md § Secrets and user data). No-op if absent.
 */
export async function removeServer(id: string): Promise<void> {
  const file = await readRegistry();
  const servers = file.servers.filter((s) => s.id !== id);
  if (servers.length === file.servers.length) return; // not present
  await writeRegistry({ version: file.version, servers });
  logger.info({ id }, "removed server location from registry");
}
