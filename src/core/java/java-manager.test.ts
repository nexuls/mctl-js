/**
 * Tests for the Java **selection policy** — the rules that decide which JDK a
 * server launches with. These are pure over a list of installations, which is
 * why they can be asserted exactly rather than depending on whatever JDKs the
 * machine running the suite happens to have.
 *
 * The rule under most scrutiny here is the LTS ceiling on an unbounded
 * requirement (`{ min: 21 }` does **not** mean "use the Java 26 you happen to
 * have"). That is not a theoretical concern: verifying Phase 2 against a real
 * Paper 1.21.4 server on Java 26 produced a native crash in Paper's bundled
 * profiler during shutdown — exactly the class of breakage the ceiling avoids.
 */

import { describe as suite, expect, test } from "bun:test";
import { chooseInstalled, describe, preferredMajor } from "./java-manager.ts";
import { majorOf } from "./detect.ts";
import { LTS_MAJORS, type JavaInstallation } from "../../types/java.ts";

/** Build a minimal installation record; only `major` matters to the policy. */
function jdk(major: number): JavaInstallation {
  return {
    major,
    version: `${major}.0.1`,
    javaPath: `/opt/jdk-${major}/bin/java`,
    home: `/opt/jdk-${major}`,
    source: "system",
  };
}

/** Newest-major-first, the order `detectJavaInstallations` guarantees. */
function installed(...majors: number[]): JavaInstallation[] {
  return majors.sort((a, b) => b - a).map(jdk);
}

suite("majorOf", () => {
  test("reads the second component for the 1.x era", () => {
    expect(majorOf("1.8.0_412")).toBe(8);
    expect(majorOf("1.7.0")).toBe(7);
  });

  test("reads the first component for Java 9+", () => {
    expect(majorOf("21.0.12")).toBe(21);
    expect(majorOf("17")).toBe(17);
    expect(majorOf("26.0.2")).toBe(26);
  });

  test("returns undefined for something that is not a version", () => {
    expect(majorOf("")).toBeUndefined();
    expect(majorOf("openjdk")).toBeUndefined();
  });
});

suite("preferredMajor", () => {
  test("picks the highest LTS inside the window", () => {
    expect(preferredMajor({ min: 17 })).toBe(LTS_MAJORS[0]);
    expect(preferredMajor({ min: 8, max: 17 })).toBe(17);
    expect(preferredMajor({ min: 8, max: 16 })).toBe(11);
  });

  test("falls back to the requirement's own bound when no LTS fits", () => {
    // A window that contains no LTS at all (16 is not one).
    expect(preferredMajor({ min: 16, max: 16 })).toBe(16);
    expect(preferredMajor({ min: 16, max: 16, recommended: 16 })).toBe(16);
  });

  test("handles a requirement above every LTS we know", () => {
    const beyond = LTS_MAJORS[0] + 5;
    expect(preferredMajor({ min: beyond })).toBe(beyond);
  });
});

suite("chooseInstalled", () => {
  test("takes the highest installed JDK inside the window", () => {
    expect(chooseInstalled(installed(8, 17, 21), { min: 17 })?.major).toBe(21);
    expect(chooseInstalled(installed(8, 11, 17), { min: 8, max: 11 })?.major).toBe(11);
  });

  test("rejects a JDK below the minimum", () => {
    expect(chooseInstalled(installed(8, 11), { min: 17 })).toBeUndefined();
  });

  test("rejects a JDK above a declared maximum", () => {
    expect(chooseInstalled(installed(21), { min: 8, max: 17 })).toBeUndefined();
  });

  test("caps an unbounded requirement at the newest LTS", () => {
    // `{ min: 21 }` with only a non-LTS 26 present must find nothing, so the
    // caller fetches an LTS instead of launching on an untested JVM.
    const newest = LTS_MAJORS[0];
    expect(chooseInstalled(installed(newest + 1), { min: 21 })).toBeUndefined();
    // …but the LTS itself is of course acceptable.
    expect(chooseInstalled(installed(newest, newest + 1), { min: 21 })?.major).toBe(
      newest,
    );
  });

  test("honours an explicit maximum above the LTS ceiling", () => {
    // Upstream saying "up to 26" is a statement about testing, and beats our
    // conservative default.
    const newest = LTS_MAJORS[0];
    expect(
      chooseInstalled(installed(newest + 1), { min: 21, max: newest + 1 })?.major,
    ).toBe(newest + 1);
  });

  test("a previously resolved bare major is preferred over a newer fit", () => {
    // Stability across launches: the server keeps the JVM it was resolved with.
    expect(chooseInstalled(installed(17, 21), { min: 17 }, 17)?.major).toBe(17);
  });

  test("but a stale bare major that no longer fits is ignored", () => {
    expect(chooseInstalled(installed(17, 21), { min: 21 }, 17)?.major).toBe(21);
  });
});

suite("describe", () => {
  test("spells the three shapes of a requirement", () => {
    expect(describe({ min: 21 })).toBe("Java 21+");
    expect(describe({ min: 17, max: 17 })).toBe("Java 17");
    expect(describe({ min: 8, max: 17 })).toBe("Java 8–17");
  });
});
