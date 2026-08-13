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

/**
 * Server kinds MCTL offers as a *default* in the setup wizard and Settings.
 *
 * Deliberately narrower than what a server may actually be: `mctl.json`'s `kind`
 * is a free string resolved against the `ProviderRegistry` at runtime, so a
 * server created by a newer MCTL still reads back. This enum only bounds the
 * picker, and grows as each provider lands. Ordered as the picker offers them:
 * plain servers, then loaders, then the proxy — which is the one entry a user
 * choosing "a Minecraft server" does not want.
 */
export const ServerKind = z.enum([
	"vanilla",
	"paper",
	"purpur",
	"fabric",
	"quilt",
	"forge",
	"neoforge",
	"velocity",
]);
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

/**
 * Network provider ids MCTL offers in the setup wizard and Settings.
 *
 * Like {@link ServerKind}, this bounds a *picker* and nothing else: a profile's
 * `provider` is a free string resolved against the `ProviderRegistry`, so a
 * config written by a newer MCTL still loads instead of failing validation and
 * taking every other setting down with it.
 */
export const NETWORK_PROVIDER_IDS = [
	"direct",
	"cloudflared",
	"playit",
	"ngrok",
	"tailscale",
] as const;
export const NetworkProviderId = z.enum(NETWORK_PROVIDER_IDS);
export type NetworkProviderId = z.infer<typeof NetworkProviderId>;

/**
 * Cloudflare DNS automation for a profile: publish the server's address as
 * records on a domain the user owns, so players join on a bare hostname.
 *
 * Two records are written (plan.md § Networking): an `A`/`AAAA` for the address
 * itself and an `SRV` for `_minecraft._tcp.<hostname>`, which is what lets the
 * Minecraft client find a non-default port without the user typing one.
 *
 * Every record MCTL creates is tagged in its `comment` field with the server id,
 * and teardown removes **only** records carrying that tag — the user's own
 * records on the same zone are never touched. This is the single most important
 * safety property of the DNS integration.
 */
export const CloudflareDnsConfig = z.object({
	/** Zone name (`example.com`) or zone id. A name is resolved through the API. */
	zone: z.string().min(1),
	/** Full hostname players will join, e.g. `mc.example.com`. */
	hostname: z.string().min(1),
	/**
	 * Route the record through Cloudflare's proxy. **Defaults to false and
	 * should stay there:** the orange-cloud proxy handles HTTP(S), not the
	 * Minecraft TCP protocol, so a proxied record makes the server unreachable
	 * rather than protected.
	 */
	proxied: z.boolean().default(false),
	/** Also publish the `_minecraft._tcp` SRV record. */
	srv: z.boolean().default(true),
	/** Record TTL in seconds; `1` means "automatic". Short by default — tunnel addresses move. */
	ttl: z.number().int().positive().default(60),
});
export type CloudflareDnsConfig = z.infer<typeof CloudflareDnsConfig>;

/**
 * A named network profile. `provider` selects a network provider id
 * (`"direct"`, `"cloudflared"`, …); `options` carries that provider's own
 * settings, kept loose because each provider validates its own shape at the
 * point of use rather than forcing every provider's schema into MCTL's config
 * schema.
 */
export const NetworkProfile = z.object({
	provider: z.string().min(1).default("direct"),
	options: z.record(z.string(), z.unknown()).optional(),
	/** Optional Cloudflare DNS automation applied on top of whatever the provider announced. */
	dns: CloudflareDnsConfig.optional(),
});
export type NetworkProfile = z.infer<typeof NetworkProfile>;

/**
 * Network configuration: the profile new servers get by default, plus the named
 * profiles themselves. `defaultProfile` is a **profile name**, not a provider
 * id — they coincide only because the stock profile is called `direct`.
 */
export const NetworkConfig = z.object({
	defaultProfile: z.string().min(1).default("direct"),
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
