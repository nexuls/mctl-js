/**
 * A tiny argv parser for the one-shot CLI — enough for `--flag`, `--key value`,
 * `--key=value`, short aliases, and positionals, and deliberately nothing more
 * (plan.md § Recommended Libraries: "lightweight argv parser or hand-rolled").
 *
 * UI-free, core-free: it turns strings into strings. **Validation is not this
 * module's job** — a value's legality is decided by the Zod schema or the core
 * service that consumes it, so there is exactly one definition of what is valid
 * (the same rule `mctl init` already follows).
 */

/** The result of parsing one command's arguments. */
export interface ParsedArgs {
  /** Arguments that were not flags nor flag values, in order. */
  positionals: string[];
  /**
   * Flag values by long name. A valueless flag maps to `true`, a `--no-<name>`
   * negation to `false`, and a valued flag to its string.
   *
   * The negation is stored as the **boolean** `false`, not the string
   * `"false"`, so that {@link stringFlag} (and therefore {@link intFlag}) skip
   * it entirely. When one name serves both spellings — `--java 21` to pin,
   * `--no-java` to opt out — conflating the two would make `intFlag` throw
   * "must be a positive integer (got false)" on a perfectly valid `--no-java`.
   */
  flags: Map<string, string | boolean>;
}

/** Thrown for a flag the command does not accept, or a missing flag value. */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

/** Declares what a command accepts, so unknown flags can be rejected. */
export interface ArgSpec {
  /** Long flag names that take a value, e.g. `["kind", "mc"]`. */
  valued?: readonly string[];
  /** Long flag names that are booleans, e.g. `["json", "force"]`. */
  boolean?: readonly string[];
  /** Short alias → long name, e.g. `{ f: "follow", n: "lines" }`. */
  aliases?: Readonly<Record<string, string>>;
}

/**
 * Parse `argv` against a spec.
 *
 * Unknown flags are an **error, not a warning**: a mistyped `--memroy 4G` that
 * was silently ignored would create a server with the wrong heap and no
 * indication why.
 *
 * `--no-<name>` sets the boolean flag `<name>` to `false`, which is how
 * `--no-java` opts out of a default-on behaviour. A name may appear in **both**
 * `valued` and `boolean` — that is how `--java 21` (pin) and `--no-java` (opt
 * out) coexist; the valued form wins for the positive spelling.
 *
 * @throws {ArgError} on an unknown flag or a valued flag with no value.
 */
export function parseArgs(argv: string[], spec: ArgSpec = {}): ParsedArgs {
  const valued = new Set(spec.valued ?? []);
  const boolean = new Set(spec.boolean ?? []);
  const aliases = spec.aliases ?? {};
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--") {
      // Everything after `--` is a positional, even if it looks like a flag.
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }

    let name: string;
    let inlineValue: string | undefined;

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      name = eq === -1 ? body : body.slice(0, eq);
      inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
    } else {
      const short = arg.slice(1);
      name = aliases[short] ?? short;
    }

    // `--no-x` is the negation of the boolean flag `x`.
    if (inlineValue === undefined && name.startsWith("no-") && boolean.has(name.slice(3))) {
      flags.set(name.slice(3), false);
      continue;
    }

    // `valued` is checked before `boolean` so a name declared in **both** sets
    // (`--java 21` to pin, `--no-java` to opt out) takes its value. The negation
    // form was already handled above, so nothing is lost by the ordering.
    if (valued.has(name)) {
      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw new ArgError(`--${name} needs a value`);
      flags.set(name, value);
      continue;
    }

    if (boolean.has(name)) {
      flags.set(name, inlineValue ?? true);
      continue;
    }

    throw new ArgError(`unknown flag \`${arg}\``);
  }

  return { positionals, flags };
}

/** A valued flag as a string, or `undefined` when absent. */
export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/**
 * A boolean flag's value: `true` when present bare, `false` for `--no-<name>`
 * or an explicit `=false`, `undefined` when absent (so a command can tell
 * "unset" from "explicitly off" and fall back to a config default).
 */
export function boolFlag(args: ParsedArgs, name: string): boolean | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  // An explicit `--flag=false` / `--flag=0` reads as off, so a shell script can
  // pass a computed value without branching on whether to emit the flag at all.
  return value !== "false" && value !== "0";
}

/**
 * A valued flag parsed as a positive integer.
 * @throws {ArgError} when present but not a positive integer.
 */
export function intFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ArgError(`--${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}
