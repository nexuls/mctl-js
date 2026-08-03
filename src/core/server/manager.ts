/**
 * ServerManager — the **mutating** half of the server domain: create, edit, and
 * delete. Its read-only counterpart is `core/server/discover.ts`, which both
 * front-ends already use for listing and status.
 *
 * Core service — no UI, no argv. It resolves providers through the
 * {@link ProviderRegistry} and never imports a concrete one (AGENTS.md § 3).
 *
 * **Create is staged, never in place.** Everything is assembled inside
 * `$ROOT/downloads/staging/<uuid>/` and moved to the server's final path only
 * once the download, the digest check, and `mctl.json` have all succeeded. A
 * failed create therefore leaves the servers directory exactly as it was, rather
 * than a directory containing half a jar (plan.md § Server Installation).
 *
 * **Delete never removes files unless it is told to, twice.** `removeServer`
 * forgets a *location*; erasing world data requires an explicit
 * `deleteFiles: true` from a front-end that has already confirmed with the user,
 * and even then the target is checked for an `mctl.json` first so a mis-pointed
 * registry entry can never take an unrelated directory with it (AGENTS.md
 * § Secrets and user data).
 */

import { randomUUID } from "node:crypto";
import { cp, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ensureDir, pathExists, readJsonIfExists, writeJsonAtomic } from "../../lib/fs.ts";
import { log } from "../../lib/logger.ts";
import type { RootPaths } from "../../lib/paths.ts";
import type { Config, RuntimeKind } from "../../types/config.ts";
import { EventType } from "../../types/events.ts";
import { MctlJson, MCTL_JSON_VERSION, type Server } from "../../types/server.ts";
import type { EventBus } from "../events/bus.ts";
import { publish } from "../events/log.ts";
import type { JobContext, JobScheduler, StartedJob } from "../jobs/index.ts";
import { resolveJava } from "../java/index.ts";
import type { ServerProvider } from "../../types/provider.ts";
import type { ProviderRegistry } from "../registry/provider-registry.ts";
import {
  addServer,
  loadRegistry,
  mctlJsonPath,
  removeServer,
} from "../registry/server-registry.ts";
import { getServer } from "./discover.ts";
import { executeInstall, writeEulaAcceptance } from "./install.ts";

const logger = log("server-manager");

/** Thrown when a create/edit/delete request is not valid for the current state. */
export class ServerOperationError extends Error {
  constructor(
    readonly id: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ServerOperationError";
  }
}

/** What to create. Anything omitted falls back to `config.defaults`. */
export interface CreateServerOptions {
  /** Human-facing name; the server id is derived from it unless `id` is given. */
  name: string;
  /** Explicit id / directory name. Derived from `name` when omitted. */
  id?: string;
  /** Server kind (provider id), e.g. `"paper"`. Defaults to `config.defaults.kind`. */
  kind?: string;
  /** Minecraft version. Omitted ⇒ the provider's newest release. */
  minecraftVersion?: string;
  /** Loader version, for kinds that have one. */
  loaderVersion?: string;
  /** JVM heap, e.g. `"4G"`. Defaults to `config.defaults.memory`. */
  memory?: string;
  /** Runtime provider id. Defaults to `config.defaults.runtime`. */
  runtime?: RuntimeKind;
  /** Network profile name. Defaults to `config.network.defaultProfile`. */
  network?: string;
  /**
   * Absolute path for the server directory. Omitted ⇒ `<servers_dir>/<id>`.
   * This is the reason the Location Registry exists — a server may live on
   * another drive entirely.
   */
  path?: string;
  /** Accept the Minecraft EULA. Defaults to `config.defaults.eula`. */
  eula?: boolean;
  /**
   * Pin a Java major instead of resolving one. Recorded as `{ pinned }` in
   * `mctl.json` and never re-derived — this is the answer to the "upstream
   * declares nothing" prompt (plan.md § Java Manager).
   */
  javaPin?: number;
  /**
   * Skip resolving/installing Java during create. The server is created without
   * a `java` field and resolution happens at first start instead. Used by the
   * CLI's `--no-java` escape hatch for offline creates.
   */
  skipJava?: boolean;
}

/** Fields an edit may change. Everything else requires a different operation. */
export interface EditServerOptions {
  /** New display name (does **not** rename the directory or change the id). */
  name?: string;
  /** New JVM heap. */
  memory?: string;
  /** New runtime provider id. */
  runtime?: RuntimeKind;
  /** New network profile name. */
  network?: string;
  /** Pin a Java major, or `null` to clear the pin and resolve again. */
  javaPin?: number | null;
}

/** Options for {@link ServerManager.deleteServer}. */
export interface DeleteServerOptions {
  /**
   * Also erase the server directory. **Irreversible** — worlds are irreplaceable
   * user data, so the caller must have confirmed this with the user first.
   * Defaults to `false`, which only forgets the location.
   */
  deleteFiles?: boolean;
}

/** Everything the manager needs, injected so it stays testable and UI-free. */
export interface ServerManagerDeps {
  /** Loaded, validated configuration. */
  config: Config;
  /** Data paths derived from it (`resolveRootPaths(config)`). */
  paths: RootPaths;
  /** Concrete providers registered for this process. */
  providers: ProviderRegistry;
  /** The process event bus. */
  bus: EventBus;
  /** Scheduler for the long-running create job. */
  jobs: JobScheduler;
}

/**
 * Derive a server id from a display name: lowercase, non-alphanumerics collapsed
 * to single hyphens, trimmed. The id doubles as the **directory name**, which is
 * why it is restricted rather than free-form — `core/registry` derives ids from
 * directory names on drop-in discovery, so the two must agree.
 */
export function idFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Ids must round-trip through {@link idFromName} and survive as a directory name. */
function assertValidId(id: string): void {
  if (id === "" || id !== idFromName(id)) {
    throw new ServerOperationError(
      id,
      `invalid server id "${id}": use lowercase letters, digits and hyphens`,
    );
  }
}

export class ServerManager {
  readonly #deps: ServerManagerDeps;

  constructor(deps: ServerManagerDeps) {
    this.#deps = deps;
  }

  /**
   * Create a new server.
   *
   * Pre-flight checks (id validity, id collision, destination emptiness, unknown
   * kind) run **before** the job starts, so an obviously bad request fails
   * immediately with a clear error instead of appearing as a failed job the user
   * has to go and read.
   *
   * @returns the started job; `await result` for the finished `Server`.
   * @throws {ServerOperationError} when the request cannot be started.
   * @throws {UnknownProviderError} when `kind` is not registered.
   */
  async createServer(
    options: CreateServerOptions,
  ): Promise<StartedJob<Server>> {
    const { config, paths, providers, bus, jobs } = this.#deps;

    const id = options.id ?? idFromName(options.name);
    assertValidId(id);

    const kind = options.kind ?? config.defaults.kind;
    // Resolves now so an unknown kind is reported before any directory is touched.
    const provider = providers.server(kind);

    const dir = options.path ?? join(paths.serversDir, id);
    if (!isAbsolute(dir)) {
      throw new ServerOperationError(id, `server path must be absolute: ${dir}`);
    }

    const existing = await loadRegistry(paths.serversDir);
    if (existing.some((entry) => entry.id === id)) {
      throw new ServerOperationError(id, `a server with id "${id}" already exists`);
    }
    if (await pathExists(mctlJsonPath(dir))) {
      throw new ServerOperationError(
        id,
        `${dir} already contains an mctl.json — it is already a server`,
      );
    }

    const memory = options.memory ?? config.defaults.memory;
    const runtime = options.runtime ?? config.defaults.runtime;
    const network = options.network ?? config.network.defaultProfile;
    const eula = options.eula ?? config.defaults.eula;

    return jobs.run<Server>(
      { kind: "create", title: `Creating ${id}`, serverId: id },
      async (job) => {
        const staging = join(paths.stagingDir, randomUUID());
        try {
          const server = await this.#install(job, {
            id,
            dir,
            staging,
            provider,
            kind,
            name: options.name,
            memory,
            runtime,
            network,
            eula,
            minecraftVersion: options.minecraftVersion,
            loaderVersion: options.loaderVersion,
            javaPin: options.javaPin,
            skipJava: options.skipJava ?? false,
          });
          await publish(bus, EventType.ServerCreated, {
            id,
            kind,
            minecraftVersion: server.minecraftVersion,
            path: dir,
          });
          return server;
        } finally {
          // The staging tree is disposable in every outcome: on success it has
          // been moved away, on failure it is exactly what must not survive.
          await rm(staging, { recursive: true, force: true });
        }
      },
    );
  }

  /**
   * Edit a server's `mctl.json`. Only the fields in {@link EditServerOptions}
   * may change: `kind` and `minecraftVersion` are an *update* (re-install), which
   * is a different operation and arrives with Phase 3.
   *
   * The write **merges over the parsed file**, so unknown keys written by a newer
   * MCTL survive an edit — the same rule Settings follows for `config.json`.
   */
  async editServer(id: string, patch: EditServerOptions): Promise<Server> {
    const { bus, paths } = this.#deps;
    const server = await getServer(id, paths.serversDir);
    if (!server) throw new ServerOperationError(id, `no such server: ${id}`);
    if (!server.available) {
      throw new ServerOperationError(
        id,
        `server "${id}" is unavailable (${server.path} is missing); cannot edit it`,
      );
    }

    const file = mctlJsonPath(server.path);
    const current = MctlJson.parse(await readJsonIfExists(file));
    const next: MctlJson = { ...current };
    const changed: string[] = [];

    if (patch.name !== undefined && patch.name !== current.name) {
      next.name = patch.name;
      changed.push("name");
    }
    if (patch.memory !== undefined && patch.memory !== current.memory) {
      next.memory = patch.memory;
      changed.push("memory");
    }
    if (patch.runtime !== undefined && patch.runtime !== current.runtime) {
      this.#deps.providers.runtime(patch.runtime); // reject unknown runtimes early
      next.runtime = patch.runtime;
      changed.push("runtime");
    }
    if (patch.network !== undefined && patch.network !== current.network) {
      next.network = patch.network;
      changed.push("network");
    }
    if (patch.javaPin !== undefined) {
      if (patch.javaPin === null) {
        delete next.java;
      } else {
        next.java = { pinned: patch.javaPin };
      }
      changed.push("java");
    }

    if (changed.length === 0) return server;

    await writeJsonAtomic(file, next);
    logger.info({ id, changed }, "edited server");
    // Field *names* only — a payload never carries values that might be sensitive
    // and other instances only need to know to re-read the file.
    await publish(bus, EventType.ServerEdited, { id, fields: changed });

    const updated = await getServer(id, paths.serversDir);
    if (!updated) throw new ServerOperationError(id, `server "${id}" vanished during edit`);
    return updated;
  }

  /**
   * Delete a server. By default this only removes its registry entry — the
   * directory and its worlds are left untouched. Pass `deleteFiles` to erase the
   * directory as well, which the caller must have confirmed with the user.
   *
   * A running server is refused outright: stopping it first is the user's
   * decision, and deleting a live world's files would corrupt the save.
   */
  async deleteServer(id: string, options: DeleteServerOptions = {}): Promise<void> {
    const { bus, paths } = this.#deps;
    const server = await getServer(id, paths.serversDir);
    if (!server) throw new ServerOperationError(id, `no such server: ${id}`);
    if (server.state === "running") {
      throw new ServerOperationError(id, `server "${id}" is running; stop it first`);
    }

    if (options.deleteFiles) {
      // Guard against a stale or hand-edited registry entry pointing somewhere
      // unrelated: only a directory that really is a server may be erased.
      if (!(await pathExists(mctlJsonPath(server.path)))) {
        throw new ServerOperationError(
          id,
          `refusing to delete ${server.path}: it contains no mctl.json`,
        );
      }
      logger.warn({ id, path: server.path }, "deleting server directory");
      await rm(server.path, { recursive: true, force: true });
    }

    await removeServer(id);
    await publish(bus, EventType.ServerDeleted, {
      id,
      deletedFiles: options.deleteFiles === true,
    });
    logger.info({ id, deletedFiles: options.deleteFiles === true }, "deleted server");
  }

  /**
   * The staged install itself: resolve the version and Java, download into
   * staging, write `mctl.json`, then move the tree into place and register it.
   */
  async #install(
    job: JobContext,
    plan: {
      id: string;
      dir: string;
      staging: string;
      provider: ServerProvider;
      kind: string;
      name: string;
      memory: string;
      runtime: RuntimeKind;
      network: string;
      eula: boolean;
      minecraftVersion?: string;
      loaderVersion?: string;
      javaPin?: number;
      skipJava: boolean;
    },
  ): Promise<Server> {
    const { paths, bus } = this.#deps;

    job.step("Resolving", undefined);
    const minecraftVersion =
      plan.minecraftVersion ?? (await latestRelease(plan.provider));
    job.progress(undefined, `${plan.kind} ${minecraftVersion}`);

    const strategy = await plan.provider.resolveInstall({
      minecraftVersion,
      loaderVersion: plan.loaderVersion,
      dir: plan.staging,
    });

    // Java is resolved *before* the download so a machine that cannot run this
    // server fails fast, rather than after pulling 60 MB.
    let java: MctlJson["java"];
    if (plan.javaPin !== undefined) {
      java = { pinned: plan.javaPin };
    } else if (!plan.skipJava) {
      job.step("Resolving Java", undefined);
      const requirement = await plan.provider.javaRequirement(
        minecraftVersion,
        plan.loaderVersion,
      );
      const resolution = await resolveJava(requirement, undefined, paths, {
        onProgress: (progress) =>
          job.progress(progress.fraction, "downloading JDK"),
        signal: job.signal,
      });
      java = resolution.installation.major;
      if (resolution.installation.source === "managed") {
        await publish(bus, EventType.JavaInstalled, {
          major: resolution.installation.major,
          version: resolution.installation.version,
          home: resolution.installation.home,
        });
      }
    }

    await ensureDir(plan.staging);
    await executeInstall(strategy, plan.staging, job);
    if (plan.eula) await writeEulaAcceptance(plan.staging);

    job.step("Writing configuration", undefined);
    const mctlJson: MctlJson = {
      schemaVersion: MCTL_JSON_VERSION,
      name: plan.name,
      kind: plan.kind,
      minecraftVersion,
      loaderVersion: plan.loaderVersion,
      java,
      memory: plan.memory,
      runtime: plan.runtime,
      network: plan.network,
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(mctlJsonPath(plan.staging), mctlJson);

    job.step("Finishing", undefined);
    await moveIntoPlace(plan.staging, plan.dir);
    await addServer({ id: plan.id, path: plan.dir });

    const server = await getServer(plan.id, paths.serversDir);
    if (!server) {
      throw new ServerOperationError(
        plan.id,
        `created ${plan.dir} but it could not be read back`,
      );
    }
    logger.info({ id: plan.id, kind: plan.kind, minecraftVersion }, "created server");
    return server;
  }
}

/** The provider's newest stable release, used when the caller names no version. */
async function latestRelease(provider: ServerProvider): Promise<string> {
  const versions = await provider.minecraftVersions();
  const release = versions.find((v) => v.type === "release");
  if (!release) {
    throw new ServerOperationError(
      undefined,
      `${provider.id} publishes no release versions`,
    );
  }
  return release.id;
}

/**
 * Move the staged tree to its final location.
 *
 * `rename` is the fast path and is atomic, but staging lives under `$ROOT` while
 * a server may be created on another drive entirely — the very case the Location
 * Registry exists for — and `rename(2)` fails with `EXDEV` across filesystems.
 * The fallback copies and then removes the source, which is not atomic; that is
 * acceptable because the destination did not exist a moment ago and a partial
 * copy leaves no `mctl.json`, so discovery will not mistake it for a server.
 */
async function moveIntoPlace(staging: string, dir: string): Promise<void> {
  await ensureDir(join(dir, ".."));
  try {
    await rename(staging, dir);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  logger.info({ staging, dir }, "cross-device create; copying instead of renaming");
  await cp(staging, dir, { recursive: true });
  await rm(staging, { recursive: true, force: true });
}
