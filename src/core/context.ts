/**
 * MctlContext — the assembled set of core services a front-end works with:
 * loaded config, resolved paths, the provider registry, the event bus, the job
 * scheduler, and the two managers built on top of them.
 *
 * Core service — no UI, no argv, and **no concrete provider imports**: the
 * registry is passed in, built by `providers/index.ts` at the front-end edge.
 * That is what lets this module sit in `core/` while still knowing which
 * providers exist.
 *
 * It exists so the CLI and the TUI construct the same object graph. A command
 * that builds its own `ServerManager` by hand would be the first step toward the
 * two front-ends drifting apart, which AGENTS.md § 3 rules out.
 *
 * The context holds **no server state** — `config` and `paths` are the only
 * cached values, both re-read whenever a `ConfigChanged` event says so, and
 * everything about a server is still re-derived from disk on each call.
 */

import type { RootPaths } from "../lib/paths.ts";
import type { Config } from "../types/config.ts";
import { loadConfig, resolveRootPaths } from "./config/index.ts";
import { EventBus } from "./events/bus.ts";
import { JobScheduler } from "./jobs/index.ts";
import type { ProviderRegistry } from "./registry/provider-registry.ts";
import { RuntimeManager } from "./runtime/index.ts";
import { ServerManager } from "./server/manager.ts";

/** The core services a front-end needs, wired together. */
export interface MctlContext {
  /** Loaded, validated `config.json`. */
  config: Config;
  /** Data paths derived from it. */
  paths: RootPaths;
  /** Providers this build ships. */
  providers: ProviderRegistry;
  /** The process event bus. */
  bus: EventBus;
  /** Scheduler for long-running work (installs, JDK downloads). */
  jobs: JobScheduler;
  /** Create / edit / delete servers. */
  servers: ServerManager;
  /** Start / stop / restart / stream servers. */
  runtime: RuntimeManager;
}

/**
 * Build a context from a provider registry and an optional shared bus.
 *
 * @param providers from `createProviderRegistry()` — passed in so `core/` never
 *   imports a concrete provider.
 * @param bus an existing bus (the TUI's, already tailing `events.jsonl`); a
 *   one-shot CLI command omits it and gets a bare local bus, which is enough
 *   because `publish` still appends to the shared log for other instances.
 * @throws {ConfigNotFoundError} when `config.json` is absent — the caller should
 *   steer the user to `mctl init` or the setup wizard.
 */
export async function createContext(
  providers: ProviderRegistry,
  bus: EventBus = new EventBus(),
): Promise<MctlContext> {
  const config = await loadConfig();
  const paths = resolveRootPaths(config);
  const jobs = new JobScheduler(bus);

  return {
    config,
    paths,
    providers,
    bus,
    jobs,
    servers: new ServerManager({ config, paths, providers, bus, jobs }),
    runtime: new RuntimeManager({ config, paths, providers, bus }),
  };
}
