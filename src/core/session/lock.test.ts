/**
 * Tests for the per-server advisory lock.
 *
 * The lock is what stops two `mctl` instances starting the same server at once,
 * and it has to survive the case that matters most in practice: an instance that
 * crashed while holding it. A lock owned by a dead pid must be *reclaimed*, not
 * respected — otherwise one crash wedges a server until the next startup sweep.
 *
 * `lib/paths` reads the XDG environment on every call, so each test points
 * `XDG_STATE_HOME` at a fresh temp directory rather than touching the real one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../../lib/fs.ts";
import { runtimeDir, runtimeLockFile } from "../../lib/paths.ts";
import { ResourceBusyError, withServerLock } from "./lock.ts";

let stateHome: string;
let originalStateHome: string | undefined;

beforeEach(async () => {
  originalStateHome = process.env.XDG_STATE_HOME;
  stateHome = await mkdtemp(join(tmpdir(), "mctl-lock-"));
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(async () => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
  await rm(stateHome, { recursive: true, force: true });
});

describe("withServerLock", () => {
  test("runs the work and releases the lock", async () => {
    const result = await withServerLock("survival", async () => "done");
    expect(result).toBe("done");
    expect(await Bun.file(runtimeLockFile("survival")).exists()).toBe(false);
  });

  test("holds the lock for the duration of the work", async () => {
    let seen = false;
    await withServerLock("survival", async () => {
      seen = await Bun.file(runtimeLockFile("survival")).exists();
    });
    expect(seen).toBe(true);
  });

  test("records the owner pid so a sweep can judge staleness", async () => {
    let body = "";
    await withServerLock("survival", async () => {
      body = await readFile(runtimeLockFile("survival"), "utf8");
    });
    expect(JSON.parse(body)).toEqual({ pid: process.pid });
  });

  test("releases the lock when the work throws", async () => {
    await expect(
      withServerLock("survival", async () => {
        throw new Error("install failed");
      }),
    ).rejects.toThrow("install failed");
    expect(await Bun.file(runtimeLockFile("survival")).exists()).toBe(false);
  });

  test("refuses when a live instance holds the lock", async () => {
    // Our own pid is unambiguously alive, so this stands in for a second instance.
    await ensureDir(runtimeDir());
    await writeFile(runtimeLockFile("survival"), JSON.stringify({ pid: process.pid }));

    await expect(withServerLock("survival", async () => "never")).rejects.toThrow(
      ResourceBusyError,
    );
  });

  test("reclaims a lock whose owner is dead", async () => {
    await ensureDir(runtimeDir());
    // pid 0x7FFFFFFF is above every plausible pid_max, so it cannot be running.
    await writeFile(runtimeLockFile("survival"), JSON.stringify({ pid: 2147483647 }));

    const result = await withServerLock("survival", async () => "reclaimed");
    expect(result).toBe("reclaimed");
  });

  test("reclaims a lock with an unreadable body", async () => {
    // A truncated or hand-edited lock has no discernible owner; nobody can prove
    // it live, so wedging the server forever would be the worse failure.
    await ensureDir(runtimeDir());
    await writeFile(runtimeLockFile("survival"), "not json at all");

    expect(await withServerLock("survival", async () => "reclaimed")).toBe("reclaimed");
  });

  test("locks are per server", async () => {
    await ensureDir(runtimeDir());
    await writeFile(runtimeLockFile("survival"), JSON.stringify({ pid: process.pid }));

    // A different server is unaffected by survival's held lock.
    expect(await withServerLock("creative", async () => "ok")).toBe("ok");
  });
});
