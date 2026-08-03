/**
 * Zod schemas and inferred types for MCTL's own configuration: `config.json`
 * and `secrets.json`. The Zod schema is the source of truth — the TypeScript
 * types are inferred from it, so there is exactly one definition of the shape.
 *
 * No I/O here: this module only *describes and validates* the config. Loading,
 * first-run detection, and writing live in `core/config/`. Validation is
 * applied at the disk boundary (AGENTS.md § "Zod at every boundary").
 *
 * **Key-naming note:** `servers_dir` and `backups_dir` keep their snake_case
 * spelling because plan.md documents them verbatim as `config.servers_dir` /
 * `config.backups_dir` — that spelling is a published contract. Everything else
 * is camelCase.
 */

import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Current config schema version. Bump when the shape changes in a
 * non-backward-compatible way; `core/config/` migrates older files forward.
 */
export const CONFIG_VERSION = 1;

/** An absolute filesystem path. Relative paths in config are always a mistake. */
const AbsolutePath = z
  .string()
  .min(1)
  .refine(isAbsolute, { message: "must be an absolute path" });

/** How a server is run by default. Mirrors the runtime provider ids. */
export const RuntimeKind = z.enum(["foreground", "tmux", "docker"]);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

/** Archive format for backups. */
export const CompressionKind = z.enum(["tar.zst", "tar.gz", "zip"]);
export type CompressionKind = z.infer<typeof CompressionKind>;

/**
 * How the UI picks its glyphs.
 *
 * - `auto` — detect what the terminal can draw (see `core/icons/detect.ts`).
 * - `nerd` — force Nerd Font glyphs; the user asserts their font is patched.
 * - `ascii` — force 7-bit ASCII, for terminals and pipes that mangle anything else.
 *
 * The *rendering* sets are a superset of this (`nerd | unicode | ascii`, see
 * `types/icons.ts`): `unicode` is the middle tier `auto` lands on and is not
 * offered as a mode, because "the plain symbols every UTF-8 terminal has" is
 * exactly what auto-detection should be trusted to decide. `MCTL_ICONS` can
 * still pin it explicitly for debugging.
 */
export const IconMode = z.enum(["auto", "nerd", "ascii"]);
export type IconMode = z.infer<typeof IconMode>;

/** Available Server Kinds, e.g. "vanilla", "paper", "fabric". */
export const ServerKind = z.enum(["vanilla"]);
export type ServerKind = z.infer<typeof ServerKind>;

/** Defaults applied to newly created servers (each is overridable per server). */
export const ServerDefaults = z.object({
  /** Default Minecraft version; absent means "resolve latest at create time". */
  minecraftVersion: z.string().optional(),
  /** Default server kind/provider id, e.g. "paper", "vanilla", "fabric". */
  kind: ServerKind.default("vanilla"),
  /** Default JVM heap, e.g. "2G". Free-form; validated by the runtime later. */
  memory: z.string().default("2G"),
  /** Default runtime provider. */
  runtime: RuntimeKind.default("foreground"),
  /** Whether MCTL auto-accepts the Minecraft EULA on create. Off by default. */
  eula: z.boolean().default(false),
});
export type ServerDefaults = z.infer<typeof ServerDefaults>;

/** Available Backup Providers, e.g. "filesystem", "s3", "drive". */
export const BackupProvider = z.enum(["filesystem"]);
export type BackupProvider = z.infer<typeof BackupProvider>;

/** Backup policy defaults. Providers/scheduling land in Phase 4; shape is stable now. */
export const BackupPolicy = z.object({
  enabled: z.boolean().default(false),
  /** Backup provider id, e.g. "filesystem", "s3", "drive". */
  provider: BackupProvider.default("filesystem"),
  /** Optional cron schedule; absent means manual-only. */
  schedule: z.string().optional(),
  /** Optional retention count (keep N most recent). */
  retention: z.number().int().positive().optional(),
  compression: CompressionKind.default("tar.zst"),
});
export type BackupPolicy = z.infer<typeof BackupPolicy>;

/** Available Network Providers, e.g. "direct", "cloudflared", "ngrok", "playit", "tailscale" … */
export const NetworkProvider = z.enum(["direct"]);
export type NetworkProvider = z.infer<typeof NetworkProvider>;

/**
 * A named network profile. `provider` selects a NetworkProvider id ("direct",
 * "cloudflared", …). Provider-specific settings are kept loose (`options`) until
 * the concrete providers land in Phase 4 and define their own schemas.
 */
export const NetworkProfile = z.object({
  provider: NetworkProvider.default("direct"),
  options: z.record(z.string(), z.unknown()).optional(),
});
export type NetworkProfile = z.infer<typeof NetworkProfile>;

/** Network configuration: a default profile name plus the named profiles. */
export const NetworkConfig = z.object({
  defaultProfile: NetworkProvider.default("direct"),
  profiles: z
    .record(z.string(), NetworkProfile)
    .default({ direct: { provider: "direct" } }),
});
export type NetworkConfig = z.infer<typeof NetworkConfig>;

/**
 * The full `config.json`. `root` is chosen once at first run and is not editable
 * afterwards; `servers_dir` / `backups_dir` default to `root/servers` and
 * `root/backups` but may point elsewhere (large worlds on another drive).
 */
export const Config = z.object({
  configVersion: z.number().int().positive().default(CONFIG_VERSION),
  root: AbsolutePath,
  servers_dir: AbsolutePath.optional(),
  backups_dir: AbsolutePath.optional(),
  // Active theme id: a built-in ("github", "nord"), a custom theme's filename,
  // or "terminal" (the default) for the live host-terminal palette. Just an id —
  // the palette itself is resolved by the theme registry at startup, so a config
  // naming a since-deleted theme degrades gracefully rather than storing colours.
  theme: z.string().min(1).default("terminal"),
  // Glyph family for the UI, alongside `theme` as the other half of the
  // appearance settings. An enum rather than a free string: unlike themes, icon
  // sets are not user-extensible — they are a fixed table in `core/icons/`.
  icons: IconMode.default("auto"),
  // `.prefault({})` = input-side default: an absent section is parsed as `{}`,
  // which fills each nested field's own default. (`.default()` in Zod v4 wants a
  // fully-formed output object, which would duplicate every nested default here.)
  defaults: ServerDefaults.prefault({}),
  backup: BackupPolicy.prefault({}),
  network: NetworkConfig.prefault({}),
});
export type Config = z.infer<typeof Config>;

/**
 * `secrets.json` — API tokens, written `0600`. Every key is optional and may be
 * overridden by the matching `MCTL_*` environment variable at read time. Loose
 * by design: new providers add their own keys without a schema change. Never
 * logged, never placed in an event payload.
 */
export const Secrets = z.record(z.string(), z.string());
export type Secrets = z.infer<typeof Secrets>;
