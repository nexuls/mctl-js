/**
 * Server discovery — builds `Server` view models by combining the location
 * registry, each server's `mctl.json`, and a live session probe. This is the
 * single **read path** shared by both front-ends: the CLI `list`/`status`
 * commands and the TUI Dashboard/Servers pages all call these, so neither
 * front-end holds logic the other lacks (AGENTS.md § Two front-ends, one core).
 *
 * Core service — no UI, no argv, no provider imports. It re-derives everything
 * from disk on each call and caches nothing (architecture.md § Statelessness):
 * calling `listServers()` twice re-reads the registry, re-parses each
 * `mctl.json`, and re-probes liveness every time.
 *
 * NOTE: this deliberately lives in `core/server/` but is *read-only*. The
 * mutating `ServerManager` (create/delete/edit, install strategies) is Phase 2;
 * keeping discovery separate lets Phase 1 list servers without it.
 */

import { loadRegistry, mctlJsonPath } from "../registry/server-registry.ts";
import { probe } from "../session/session-manager.ts";
import { readJsonIfExists } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import { MctlJson, type Server } from "../../types/server.ts";

const logger = log("discover");

/**
 * Discover every known server and build its `Server` view model, rebuilt fresh
 * from disk on each call. Servers are returned id-sorted. An unavailable entry
 * (missing path / `mctl.json`) yields a minimal `unavailable` view model rather
 * than being dropped, so the UI can show and offer to re-point it.
 *
 * @param serversDir `config.servers_dir`, scanned for drop-in servers.
 */
export async function listServers(serversDir?: string): Promise<Server[]> {
  const entries = await loadRegistry(serversDir);
  return Promise.all(
    entries.map((entry) => buildServer(entry.id, entry.path, entry.available)),
  );
}

/**
 * Build one server's view model by id. Returns `undefined` when the id is not in
 * the registry (nor a drop-in under `servers_dir`).
 *
 * @param id the server id.
 * @param serversDir `config.servers_dir`, so a drop-in-only server still resolves.
 */
export async function getServer(
  id: string,
  serversDir?: string,
): Promise<Server | undefined> {
  const entries = await loadRegistry(serversDir);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return undefined;
  return buildServer(entry.id, entry.path, entry.available);
}

/**
 * Assemble a `Server` from its id, path, and availability: parse `mctl.json` for
 * config, probe the runtime for live state. An unavailable path or an
 * unreadable/invalid `mctl.json` produces a safe `unavailable` view model
 * (never throws) — one bad server must not break the whole listing.
 */
async function buildServer(
  id: string,
  path: string,
  available: boolean,
): Promise<Server> {
  if (!available) return unavailableServer(id, path);

  let raw: unknown;
  try {
    raw = await readJsonIfExists(mctlJsonPath(path));
  } catch (err) {
    logger.warn({ id, err: String(err) }, "unreadable mctl.json; marking unavailable");
    return unavailableServer(id, path);
  }
  const parsed = MctlJson.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { id, issues: parsed.error.message },
      "invalid mctl.json; marking unavailable",
    );
    return unavailableServer(id, path);
  }
  const cfg = parsed.data;

  // Live-probe run state — never stored, always re-derived (statelessness).
  const { state, session } = await probe(id);

  return {
    id,
    name: cfg.name,
    kind: cfg.kind,
    minecraftVersion: cfg.minecraftVersion,
    loaderVersion: cfg.loaderVersion,
    java: cfg.java,
    memory: cfg.memory,
    runtime: cfg.runtime,
    network: cfg.network,
    path,
    state,
    available: true,
    session,
  };
}

/**
 * A placeholder view model for a server whose location or `mctl.json` cannot be
 * read. Config fields are empty/`"—"` and `state` is `unavailable`, so the UI
 * shows the id and path and can offer to re-point or forget it.
 */
function unavailableServer(id: string, path: string): Server {
  return {
    id,
    name: id,
    kind: "—",
    minecraftVersion: "—",
    memory: "—",
    runtime: "—",
    network: "—",
    path,
    state: "unavailable",
    available: false,
  };
}
