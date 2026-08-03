/**
 * Tests for `ServerManager` — create, edit, delete — driven end to end against a
 * temp `$HOME`, with a **stub `ServerProvider`** serving a `file://` URL.
 *
 * No network: the point is not to re-test Mojang's or PaperMC's APIs (those are
 * the providers' job) but to prove the manager's own contract, and specifically
 * the two properties that protect user data:
 *
 *  1. A failed install leaves **nothing** behind — no half-built server
 *     directory, no registry entry.
 *  2. Delete removes the *location* by default and only erases files when told
 *     to, and never for a running server or a directory that is not a server.
 *
 * `lib/paths` reads XDG env vars on every call, so redirecting `XDG_STATE_HOME`
 * and `XDG_CONFIG_HOME` per test is enough to isolate the whole state tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir, pathExists } from "../../lib/fs.ts";
import { rootPaths, type RootPaths } from "../../lib/paths.ts";
import { Config } from "../../types/config.ts";
import type {
  InstallStrategy,
  LaunchSpec,
  LoaderVersion,
  VersionInfo,
} from "../../types/install.ts";
import type { JavaRequirement } from "../../types/java.ts";
import type { ServerProvider } from "../../types/provider.ts";
import { EventBus } from "../events/bus.ts";
import { JobScheduler } from "../jobs/index.ts";
import { ProviderRegistry } from "../registry/provider-registry.ts";
import { loadRegistry } from "../registry/server-registry.ts";
import { getServer } from "./discover.ts";
import { idFromName, ServerManager, ServerOperationError } from "./manager.ts";

/**
 * A provider that "downloads" a local file. Everything about the manager's
 * behaviour — staging, digest checking, the move into place — is exercised for
 * real; only the origin is local.
 */
class StubProvider implements ServerProvider {
  readonly id = "stub";
  readonly displayName = "Stub";
  /** Set to a nonexistent path to make the install fail mid-job. */
  jarPath: string;

  constructor(jarPath: string) {
    this.jarPath = jarPath;
  }

  async minecraftVersions(): Promise<VersionInfo[]> {
    return [
      { id: "1.21.4", type: "release" },
      { id: "26w01a", type: "snapshot" },
    ];
  }
  async loaderVersions(): Promise<LoaderVersion[]> {
    return [];
  }
  async javaRequirement(): Promise<JavaRequirement | null> {
    return { min: 21 };
  }
  async resolveInstall(): Promise<InstallStrategy> {
    return {
      kind: "directJar",
      url: `file://${this.jarPath}`,
      dest: "server.jar",
      // Deliberately no digest: the local origin publishes none, and the
      // manager must not require one.
      size: undefined,
    };
  }
  launchSpec(): LaunchSpec {
    return { kind: "jar", jar: "server.jar" };
  }
}

let home: string;
let saved: Record<string, string | undefined>;
let paths: RootPaths;
let config: Config;
let manager: ServerManager;
let provider: StubProvider;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mctl-manager-"));
  saved = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  process.env.XDG_STATE_HOME = join(home, "state");
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.XDG_CACHE_HOME = join(home, "cache");

  const root = join(home, "root");
  paths = rootPaths(root);
  config = Config.parse({ root });
  await ensureDir(paths.serversDir);

  // The "upstream" artefact.
  const jar = join(home, "upstream-server.jar");
  await writeFile(jar, "PK-not-really-a-jar");
  provider = new StubProvider(jar);

  const bus = new EventBus();
  manager = new ServerManager({
    config,
    paths,
    providers: new ProviderRegistry().registerServer(provider),
    bus,
    jobs: new JobScheduler(bus),
  });
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

/** Create a server and wait for its job, returning the finished view model. */
async function create(options: Parameters<ServerManager["createServer"]>[0]) {
  const started = await manager.createServer(options);
  return started.result;
}

describe("idFromName", () => {
  test("slugifies a display name into a directory-safe id", () => {
    expect(idFromName("Test Survival")).toBe("test-survival");
    expect(idFromName("My  Server!! ")).toBe("my-server");
    expect(idFromName("SMP-2024")).toBe("smp-2024");
  });

  test("is idempotent, so an id round-trips through it", () => {
    expect(idFromName(idFromName("Test Survival"))).toBe("test-survival");
  });
});

describe("createServer", () => {
  test("installs, writes mctl.json, and registers the location", async () => {
    const server = await create({ name: "Test Survival", kind: "stub", skipJava: true });

    expect(server.id).toBe("test-survival");
    expect(server.path).toBe(join(paths.serversDir, "test-survival"));
    expect(await pathExists(join(server.path, "server.jar"))).toBe(true);

    const written = JSON.parse(await readFile(join(server.path, "mctl.json"), "utf8"));
    expect(written.name).toBe("Test Survival");
    expect(written.kind).toBe("stub");
    expect(written.minecraftVersion).toBe("1.21.4"); // newest *release*, not the snapshot
    expect(written.createdAt).toBeString();

    const registry = await loadRegistry(paths.serversDir);
    expect(registry.map((e) => e.id)).toContain("test-survival");
  });

  test("applies config defaults for anything unspecified", async () => {
    const server = await create({ name: "Defaults", kind: "stub", skipJava: true });
    expect(server.memory).toBe(config.defaults.memory);
    expect(server.runtime).toBe(config.defaults.runtime);
    expect(server.network).toBe(config.network.defaultProfile);
  });

  test("writes eula.txt only when the EULA was accepted", async () => {
    const accepted = await create({
      name: "Accepted",
      kind: "stub",
      skipJava: true,
      eula: true,
    });
    expect(await readFile(join(accepted.path, "eula.txt"), "utf8")).toContain(
      "eula=true",
    );

    const declined = await create({ name: "Declined", kind: "stub", skipJava: true });
    expect(await pathExists(join(declined.path, "eula.txt"))).toBe(false);
  });

  test("records an explicit Java pin and never resolves one", async () => {
    const server = await create({
      name: "Pinned",
      kind: "stub",
      javaPin: 17,
    });
    expect(server.java).toEqual({ pinned: 17 });
  });

  test("honours an explicit path outside servers_dir", async () => {
    const elsewhere = join(home, "big-drive", "Creative");
    const server = await create({
      name: "Creative",
      kind: "stub",
      skipJava: true,
      path: elsewhere,
    });
    expect(server.path).toBe(elsewhere);
    // The location registry is exactly what makes this findable again.
    const registry = await loadRegistry(paths.serversDir);
    expect(registry.find((e) => e.id === "creative")?.path).toBe(elsewhere);
  });

  test("refuses a duplicate id before touching the disk", async () => {
    await create({ name: "Twice", kind: "stub", skipJava: true });
    await expect(
      manager.createServer({ name: "Twice", kind: "stub", skipJava: true }),
    ).rejects.toThrow(ServerOperationError);
  });

  test("refuses an unknown kind", async () => {
    await expect(
      manager.createServer({ name: "Nope", kind: "fabric", skipJava: true }),
    ).rejects.toThrow(/unknown server provider/);
  });

  test("refuses a directory that is already a server", async () => {
    const dir = join(home, "existing");
    await ensureDir(dir);
    await writeFile(join(dir, "mctl.json"), "{}");
    await expect(
      manager.createServer({ name: "Existing", kind: "stub", skipJava: true, path: dir }),
    ).rejects.toThrow(/already contains an mctl.json/);
  });

  test("a failed install leaves no directory and no registry entry", async () => {
    // The artefact vanishes between resolve and download.
    provider.jarPath = join(home, "does-not-exist.jar");

    const started = await manager.createServer({
      name: "Doomed",
      kind: "stub",
      skipJava: true,
    });
    await expect(started.result).rejects.toThrow();

    expect(await pathExists(join(paths.serversDir, "doomed"))).toBe(false);
    const registry = await loadRegistry(paths.serversDir);
    expect(registry.map((e) => e.id)).not.toContain("doomed");
    // And the staging tree is cleaned up rather than accumulating.
    expect(await pathExists(paths.stagingDir)).toBe(true);
    expect(await readdirLength(paths.stagingDir)).toBe(0);
  });
});

describe("editServer", () => {
  test("changes only the requested fields and preserves unknown keys", async () => {
    const server = await create({ name: "Edited", kind: "stub", skipJava: true });
    const file = join(server.path, "mctl.json");

    // A key written by a newer MCTL must survive an edit by this one.
    const original = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...original, futureField: 42 }));

    const updated = await manager.editServer("edited", { memory: "8G" });
    expect(updated.memory).toBe("8G");

    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.futureField).toBe(42);
    expect(after.name).toBe("Edited");
    expect(after.minecraftVersion).toBe("1.21.4");
  });

  test("sets and clears a Java pin", async () => {
    await create({ name: "Pinning", kind: "stub", skipJava: true });

    expect((await manager.editServer("pinning", { javaPin: 21 })).java).toEqual({
      pinned: 21,
    });
    expect((await manager.editServer("pinning", { javaPin: null })).java).toBeUndefined();
  });

  test("rejects an unknown runtime", async () => {
    await create({ name: "Runtimes", kind: "stub", skipJava: true });
    await expect(
      manager.editServer("runtimes", { runtime: "tmux" }),
    ).rejects.toThrow(/unknown runtime provider/);
  });

  test("rejects an unknown server", async () => {
    await expect(manager.editServer("ghost", { memory: "1G" })).rejects.toThrow(
      ServerOperationError,
    );
  });
});

describe("deleteServer", () => {
  test("forgets the location but leaves the files alone by default", async () => {
    const server = await create({
      name: "Kept",
      kind: "stub",
      skipJava: true,
      // Outside servers_dir, or the drop-in scan would immediately re-discover it.
      path: join(home, "kept"),
    });

    await manager.deleteServer("kept");

    expect(await pathExists(join(server.path, "mctl.json"))).toBe(true);
    expect(await getServer("kept", paths.serversDir)).toBeUndefined();
  });

  test("erases the directory when explicitly asked", async () => {
    const server = await create({ name: "Gone", kind: "stub", skipJava: true });
    await manager.deleteServer("gone", { deleteFiles: true });
    expect(await pathExists(server.path)).toBe(false);
  });

  test("refuses to erase a directory that is not a server", async () => {
    // A hand-edited or stale registry entry must never take an unrelated
    // directory with it.
    const server = await create({ name: "Repointed", kind: "stub", skipJava: true });
    await rm(join(server.path, "mctl.json"));

    await expect(
      manager.deleteServer("repointed", { deleteFiles: true }),
    ).rejects.toThrow(/contains no mctl.json/);
    expect(await pathExists(server.path)).toBe(true);
  });

  test("rejects an unknown server", async () => {
    await expect(manager.deleteServer("ghost")).rejects.toThrow(ServerOperationError);
  });
});

/** Count the entries in a directory (0 when it does not exist). */
async function readdirLength(dir: string): Promise<number> {
  const { readDirIfExists } = await import("../../lib/fs.ts");
  return (await readDirIfExists(dir)).length;
}
