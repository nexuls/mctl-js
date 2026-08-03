/**
 * Tests for the CLI argv parser.
 *
 * The case that motivated most of these: `--java 21` (pin a version) and
 * `--no-java` (skip resolution) share one flag name, so the name appears in both
 * the `valued` and `boolean` sets. An earlier ordering checked `boolean` first,
 * which silently swallowed `--java 21` as a bare boolean and left `21` sitting
 * in the positionals — `mctl edit x --java 26` reported success and changed
 * nothing. That is the regression the "valued wins" tests guard.
 */

import { describe, expect, test } from "bun:test";
import { ArgError, boolFlag, intFlag, parseArgs, stringFlag } from "./args.ts";

describe("parseArgs", () => {
  test("collects positionals", () => {
    const args = parseArgs(["survival", "extra"], {});
    expect(args.positionals).toEqual(["survival", "extra"]);
  });

  test("reads valued flags in both spellings", () => {
    const spec = { valued: ["kind"] };
    expect(stringFlag(parseArgs(["--kind", "paper"], spec), "kind")).toBe("paper");
    expect(stringFlag(parseArgs(["--kind=paper"], spec), "kind")).toBe("paper");
  });

  test("reads boolean flags and their negation", () => {
    const spec = { boolean: ["eula"] };
    expect(boolFlag(parseArgs(["--eula"], spec), "eula")).toBe(true);
    expect(boolFlag(parseArgs(["--no-eula"], spec), "eula")).toBe(false);
    // Absent is distinct from explicitly-off, so a command can fall back to a
    // configured default rather than forcing it off.
    expect(boolFlag(parseArgs([], spec), "eula")).toBeUndefined();
  });

  test("a name in both sets takes its value for the positive spelling", () => {
    const spec = { valued: ["java"], boolean: ["java"] };
    const pinned = parseArgs(["--java", "21"], spec);
    expect(intFlag(pinned, "java")).toBe(21);
    expect(pinned.positionals).toEqual([]);
  });

  test("…and still negates through --no-", () => {
    const spec = { valued: ["java"], boolean: ["java"] };
    expect(boolFlag(parseArgs(["--no-java"], spec), "java")).toBe(false);
    expect(intFlag(parseArgs(["--no-java"], spec), "java")).toBeUndefined();
  });

  test("resolves short aliases", () => {
    const args = parseArgs(["-f", "-n", "20"], {
      boolean: ["follow"],
      valued: ["lines"],
      aliases: { f: "follow", n: "lines" },
    });
    expect(boolFlag(args, "follow")).toBe(true);
    expect(intFlag(args, "lines")).toBe(20);
  });

  test("treats everything after -- as positional", () => {
    const args = parseArgs(["say", "--", "--not-a-flag"], { boolean: ["json"] });
    expect(args.positionals).toEqual(["say", "--not-a-flag"]);
  });

  test("rejects an unknown flag rather than ignoring it", () => {
    // A silently-ignored `--memroy 4G` would create a server with the wrong heap.
    expect(() => parseArgs(["--memroy", "4G"], { valued: ["memory"] })).toThrow(
      ArgError,
    );
  });

  test("rejects a valued flag with no value", () => {
    expect(() => parseArgs(["--kind"], { valued: ["kind"] })).toThrow(ArgError);
  });

  test("intFlag rejects non-positive integers", () => {
    const spec = { valued: ["lines"] };
    expect(() => intFlag(parseArgs(["--lines", "zero"], spec), "lines")).toThrow(
      ArgError,
    );
    expect(() => intFlag(parseArgs(["--lines", "0"], spec), "lines")).toThrow(ArgError);
  });
});
