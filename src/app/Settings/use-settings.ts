/**
 * useSettings — the Settings page's bridge to core, mirroring the first-run
 * wizard's `use-setup.ts`.
 *
 * The page is UI-only (AGENTS.md § 3); every read goes through {@link useConfig}
 * and every write through the config service. This hook owns the edit buffer: it
 * maps the validated `config.json` to a flat {@link SettingsDraft} the form
 * controls bind to, tracks whether it differs from disk, and commits it with
 * `writeConfig` (Zod validates and fills defaults) followed by `ensureDirTree`
 * so a newly-pointed `servers_dir` / `backups_dir` exists immediately.
 *
 * **The config-dir watcher publishes `ConfigChanged` on its own** (an atomic
 * rename over `config.json` is exactly what it watches for), so a save needs no
 * explicit event: `useConfig` re-reads and every instance's UI follows.
 *
 * **Theme and icon set are deliberately not part of the draft.** Their providers
 * own them and persist on change (`App.tsx`), so a theme or icon set picked here
 * applies instantly — a theme like `t` does, and the glyphs across the whole UI
 * at once, which is the only way to judge the choice. A settings save carries
 * whatever values are active at that moment.
 */

import { isAbsolute } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureDirTree, writeConfig } from "../../core/config/index.ts";
import {
	DIRECT_PROFILE,
	profileNameIssue,
} from "../../core/network/profiles.ts";
import { rootPaths } from "../../lib/paths.ts";
import type {
	BackupProvider,
	CompressionKind,
	Config,
	IconMode,
	NetworkProfile,
	RuntimeKind,
	ServerKind,
} from "../../types/config.ts";
import { useConfig } from "../../hooks/use-config.ts";

/**
 * The editable view of `config.json`.
 *
 * Flat and UI-shaped, not the config shape: the two relocatable directories carry
 * an explicit "override the default?" toggle (the config expresses that as an
 * absent key), and optional strings are `""` rather than `undefined` so a text
 * input can bind to them. `root` is absent by design — it is chosen once at first
 * run and is permanent (plan.md § First-Run Setup Wizard).
 */
export interface SettingsDraft {
	/** Whether `serversDir` overrides the default `root/servers`. */
	overrideServers: boolean;
	/** Custom servers directory; only meaningful when `overrideServers` is true. */
	serversDir: string;
	/** Whether `backupsDir` overrides the default `root/backups`. */
	overrideBackups: boolean;
	/** Custom backups directory; only meaningful when `overrideBackups` is true. */
	backupsDir: string;

	/** Default Minecraft version for new servers; "" ⇒ resolve latest at create time. */
	minecraftVersion: string;
	/** Default server kind. */
	kind: ServerKind;
	/** Default JVM heap, e.g. "2G". */
	memory: string;
	/** Default runtime provider. */
	runtime: RuntimeKind;
	/** Whether MCTL auto-accepts the Minecraft EULA on create. */
	eula: boolean;

	/** Whether scheduled/automatic backups are enabled. */
	backupEnabled: boolean;
	/** Backup provider id. */
	backupProvider: BackupProvider;
	/** Archive compression format. */
	compression: CompressionKind;

	/**
	 * Default network profile for new servers — a **profile name** from
	 * `config.network.profiles`, not a provider id. They coincide only because the
	 * stock profile is called `direct`.
	 */
	network: string;
	/**
	 * The named profiles themselves, as an **ordered array** rather than the
	 * config's record. A record cannot express "this profile is being renamed" —
	 * the key *is* the name, so an edit would delete one profile and create
	 * another on every keystroke. The array keeps a stable row the form binds to,
	 * and the record is rebuilt once, at save.
	 */
	profiles: ProfileDraft[];
}

/**
 * One network profile as the form edits it: flat, all-strings, with the DNS
 * block behind an explicit switch (the config expresses that as an absent key).
 */
export interface ProfileDraft {
	/** Profile name — also the value a server's `mctl.json` stores. */
	name: string;
	/** Network provider id this profile selects. */
	provider: string;
	/**
	 * Provider options, as the values themselves rather than as `key=value` text.
	 *
	 * The form renders one control per option the provider *declares*
	 * (`NetworkProvider.options`), so a number is a number and a switch is a
	 * boolean by the time it reaches here — there is nothing left to parse, and no
	 * format for a user to get wrong. Keys the provider does not declare (a
	 * hand-edited config, one written by a newer MCTL) are carried through
	 * untouched.
	 */
	options: Record<string, unknown>;
	/** Whether Cloudflare DNS records are published for this profile. */
	dnsEnabled: boolean;
	/** Cloudflare zone name or id. */
	dnsZone: string;
	/** Hostname players join. */
	dnsHostname: string;
	/** Record TTL in seconds, as typed. */
	dnsTtl: string;
	/** Route through Cloudflare's proxy — off, and it should stay off. */
	dnsProxied: boolean;
	/** Publish the `_minecraft._tcp` SRV record too. */
	dnsSrv: boolean;
}

/** Default TTL for a freshly-enabled DNS block, matching the schema's. */
const DEFAULT_DNS_TTL = "60";

/** The profile a freshly-added row starts as: direct, no options, no DNS. */
export function emptyProfile(name: string): ProfileDraft {
	return {
		name,
		provider: DIRECT_PROFILE,
		options: {},
		dnsEnabled: false,
		dnsZone: "",
		dnsHostname: "",
		dnsTtl: DEFAULT_DNS_TTL,
		dnsProxied: false,
		dnsSrv: true,
	};
}

/** Map one stored profile into its editable row. */
function profileToDraft(name: string, profile: NetworkProfile): ProfileDraft {
	return {
		name,
		provider: profile.provider,
		options: { ...(profile.options ?? {}) },
		dnsEnabled: profile.dns !== undefined,
		dnsZone: profile.dns?.zone ?? "",
		dnsHostname: profile.dns?.hostname ?? "",
		dnsTtl: String(profile.dns?.ttl ?? DEFAULT_DNS_TTL),
		dnsProxied: profile.dns?.proxied ?? false,
		dnsSrv: profile.dns?.srv ?? true,
	};
}

/** Map one editable row back to the stored shape. */
function draftToProfile(draft: ProfileDraft): NetworkProfile {
	return {
		provider: draft.provider.trim(),
		// An empty map is written as an absent key, so a profile that needs no
		// options keeps a clean file.
		options:
			Object.keys(draft.options).length > 0 ? { ...draft.options } : undefined,
		dns: draft.dnsEnabled
			? {
					zone: draft.dnsZone.trim(),
					hostname: draft.dnsHostname.trim(),
					ttl: Number.parseInt(draft.dnsTtl, 10),
					proxied: draft.dnsProxied,
					srv: draft.dnsSrv,
				}
			: undefined,
	};
}

/**
 * Per-row validation for the profile editor: one message map per profile, by
 * index. Exported so the page can mark the offending *field* rather than only
 * disabling Save, which on a form with a profile picker would leave the user
 * hunting through profiles for the problem.
 */
export function profileIssues(
	profiles: ProfileDraft[],
): Partial<Record<keyof ProfileDraft, string>>[] {
	const seen = new Map<string, number>();
	return profiles.map((profile, index) => {
		const issues: Partial<Record<keyof ProfileDraft, string>> = {};
		const nameIssue = profileNameIssue(profile.name);
		if (nameIssue) issues.name = nameIssue;
		else if (seen.has(profile.name)) issues.name = "already used";
		else seen.set(profile.name, index);

		// Options need no parse check any more: each is edited through the control
		// its provider declared, so a number field cannot hold prose. A value that
		// is still text where a number belongs (typed, then not finished) is caught
		// by the form, which owns the provider schema this module cannot see.

		if (profile.dnsEnabled) {
			if (profile.dnsZone.trim() === "") issues.dnsZone = "required";
			if (profile.dnsHostname.trim() === "") issues.dnsHostname = "required";
			const ttl = Number.parseInt(profile.dnsTtl, 10);
			if (!Number.isInteger(ttl) || ttl <= 0) {
				issues.dnsTtl = "a positive number of seconds";
			}
		}
		return issues;
	});
}

/**
 * Build the edit buffer from a loaded config. Pure.
 *
 * When an override is absent, the corresponding text field is pre-filled with
 * the `root/...` default it would otherwise resolve to, so switching the toggle
 * on starts from a sensible path instead of an empty box.
 */
export function configToDraft(config: Config): SettingsDraft {
	const defaults = rootPaths(config.root);
	return {
		overrideServers: config.servers_dir !== undefined,
		serversDir: config.servers_dir ?? defaults.serversDir,
		overrideBackups: config.backups_dir !== undefined,
		backupsDir: config.backups_dir ?? defaults.backupsDir,
		minecraftVersion: config.defaults.minecraftVersion ?? "",
		kind: config.defaults.kind,
		memory: config.defaults.memory,
		runtime: config.defaults.runtime,
		eula: config.defaults.eula,
		backupEnabled: config.backup.enabled,
		backupProvider: config.backup.provider,
		compression: config.backup.compression,
		network: config.network.defaultProfile,
		profiles: Object.entries(config.network.profiles).map(([name, profile]) =>
			profileToDraft(name, profile),
		),
	};
}

/**
 * Fold the edit buffer back into a full config object. Pure, and deliberately
 * **merge-not-replace**: `root`, `configVersion` and the backup
 * schedule/retention are carried over untouched, so editing a field the form
 * shows never drops one it doesn't. An override toggled off removes the key
 * entirely, restoring the `root/...` default.
 *
 * The network **profiles are the one wholesale replacement**, because the form
 * now edits them: the draft's array *is* the set of profiles, so one deleted in
 * the editor has to disappear here rather than survive a merge.
 *
 * @throws when a profile's options are not `key=value` pairs. `validateDraft`
 *   reports that first and Save is disabled until it is fixed, so this is the
 *   boundary being honest rather than a reachable path.
 *
 * @param themeId The theme id to persist — the *currently active* one, since the
 *   theme provider (not this draft) owns that choice.
 * @param iconMode The icon mode to persist, for the same reason: the icon
 *   provider owns it. Passing the live value (rather than trusting `config`)
 *   closes the window where a set picked a moment ago has been written to disk
 *   but the `ConfigChanged` refresh has not landed yet — without it, a Save in
 *   that window would write the *previous* mode back.
 */
export function draftToConfig(
	config: Config,
	draft: SettingsDraft,
	themeId: string,
	iconMode: IconMode,
): unknown {
	return {
		...config,
		theme: themeId,
		icons: iconMode,
		servers_dir: draft.overrideServers ? draft.serversDir.trim() : undefined,
		backups_dir: draft.overrideBackups ? draft.backupsDir.trim() : undefined,
		defaults: {
			...config.defaults,
			minecraftVersion: draft.minecraftVersion.trim() || undefined,
			kind: draft.kind,
			memory: draft.memory.trim(),
			runtime: draft.runtime,
			eula: draft.eula,
		},
		backup: {
			...config.backup,
			enabled: draft.backupEnabled,
			provider: draft.backupProvider,
			compression: draft.compression,
		},
		network: {
			...config.network,
			defaultProfile: draft.network,
			profiles: Object.fromEntries(
				draft.profiles.map((profile) => [
					profile.name.trim(),
					draftToProfile(profile),
				]),
			),
		},
	};
}

/**
 * Field-level validation, run on every keystroke so Save can be disabled before
 * the schema rejects the write. Only checks what the user can get wrong in a text
 * field; the Zod schema remains the authority at the write boundary.
 *
 * @returns a map of draft key → message, empty when the draft is valid.
 */
export function validateDraft(
	draft: SettingsDraft,
): Partial<Record<keyof SettingsDraft, string>> {
	const issues: Partial<Record<keyof SettingsDraft, string>> = {};
	if (draft.overrideServers && !isAbsolute(draft.serversDir.trim())) {
		issues.serversDir = "must be an absolute path";
	}
	if (draft.overrideBackups && !isAbsolute(draft.backupsDir.trim())) {
		issues.backupsDir = "must be an absolute path";
	}
	if (draft.memory.trim() === "") issues.memory = "required";

	// The profile editor reports per-field messages of its own (`profileIssues`);
	// this rolls them up to one draft-level message so the Network tab is flagged
	// and Save is disabled while a profile is half-typed, even from another group.
	const perProfile = profileIssues(draft.profiles);
	const bad = perProfile.findIndex((entry) => Object.keys(entry).length > 0);
	if (bad >= 0) {
		const name = draft.profiles[bad]?.name || `profile ${bad + 1}`;
		const first = Object.values(perProfile[bad] ?? {})[0];
		issues.profiles = `${name}: ${first}`;
	}
	// Both are invariants of the config rather than of a field: `direct` is the
	// fallback every profile degrades to, and a default naming nothing would leave
	// new servers pointing at a profile that does not exist.
	if (!draft.profiles.some((profile) => profile.name === DIRECT_PROFILE)) {
		issues.profiles = "the `direct` profile cannot be removed";
	}
	if (!draft.profiles.some((profile) => profile.name === draft.network)) {
		issues.network = "the default profile must be one of the profiles below";
	}
	return issues;
}

/** What {@link useSettings} hands the page. */
export interface UseSettings {
	/** The edit buffer, or `undefined` until the config has loaded. */
	draft: SettingsDraft | undefined;
	/** The config as loaded from disk (for read-only rows like `root`). */
	config: Config | undefined;
	/** True until the first config read resolves. */
	loading: boolean;
	/** A config *load* failure message, if any. */
	loadError?: string;
	/** Apply a partial edit to the draft. */
	set: (patch: Partial<SettingsDraft>) => void;
	/** Whether the draft differs from what is on disk. */
	dirty: boolean;
	/** Per-field validation messages; empty when the draft is valid. */
	issues: Partial<Record<keyof SettingsDraft, string>>;
	/** Discard edits and reload the buffer from the on-disk config. */
	revert: () => void;
	/**
	 * Write the draft. Resolves `null` on success, or the failure message — the
	 * caller needs the message itself to report it (a toast), not just a flag.
	 */
	save: (themeId: string, iconMode: IconMode) => Promise<string | null>;
	/** True while a write is in flight. */
	saving: boolean;
	/** The last save failure message, or `null`. */
	saveError: string | null;
	/** True after a successful save, until the next edit. */
	saved: boolean;
}

/**
 * Load the config into an edit buffer and commit changes back to disk.
 *
 * The buffer follows the file while it is clean — an edit from another instance
 * (or `mctl init --force`) shows up immediately — but a dirty buffer is never
 * clobbered by a refresh, so in-progress edits survive background events.
 */
export function useSettings(): UseSettings {
	const { config, loading, error: loadError } = useConfig();
	const [draft, setDraft] = useState<SettingsDraft>();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const fromDisk = useMemo(
		() => (config ? configToDraft(config) : undefined),
		[config],
	);

	// Comparing serialized drafts is enough: the draft is flat, small, and made of
	// primitives, so this is both the dirty check and the "same as disk?" check.
	const dirty =
		draft !== undefined &&
		fromDisk !== undefined &&
		JSON.stringify(draft) !== JSON.stringify(fromDisk);

	// The last draft we adopted from disk. A buffer still equal to it is clean, so
	// it can safely follow a new on-disk value; anything else is a user edit.
	const adopted = useRef<string | undefined>(undefined);

	// Adopt the on-disk values whenever the buffer is clean (first load, after a
	// save, or after another instance changed the file). A dirty buffer is left
	// alone — a background event must never eat in-progress edits.
	useEffect(() => {
		if (!fromDisk) return;
		const serialized = JSON.stringify(fromDisk);
		setDraft((current) => {
			if (current !== undefined) {
				const buffered = JSON.stringify(current);
				// Already matches the new file (the usual case right after our own save):
				// nothing to adopt, but re-baseline so a *later* external change is.
				if (buffered === serialized) {
					adopted.current = serialized;
					return current;
				}
				// Differs from what we last took off disk ⇒ user edits in progress. Keep
				// them; a background event must never eat an in-flight edit (`revert`
				// discards them deliberately).
				if (buffered !== adopted.current) return current;
			}
			adopted.current = serialized;
			return fromDisk;
		});
	}, [fromDisk]);

	const set = useCallback((patch: Partial<SettingsDraft>) => {
		setSaved(false);
		setSaveError(null);
		setDraft((current) => (current ? { ...current, ...patch } : current));
	}, []);

	const revert = useCallback(() => {
		setSaveError(null);
		setSaved(false);
		if (!fromDisk) return;
		adopted.current = JSON.stringify(fromDisk);
		setDraft(fromDisk);
	}, [fromDisk]);

	const save = useCallback(
		async (themeId: string, iconMode: IconMode) => {
			if (!config || !draft) return "settings are still loading";
			setSaving(true);
			setSaveError(null);
			try {
				const written = await writeConfig(
					draftToConfig(config, draft, themeId, iconMode),
				);
				// A relocated servers_dir/backups_dir must exist before anything tries to
				// scan or write into it; ensureDirTree is idempotent for the rest.
				await ensureDirTree(written);
				setSaved(true);
				return null;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setSaveError(message);
				return message;
			} finally {
				setSaving(false);
			}
		},
		[config, draft],
	);

	return {
		draft,
		config,
		loading,
		loadError,
		set,
		dirty,
		issues: draft ? validateDraft(draft) : {},
		revert,
		save,
		saving,
		saveError,
		saved,
	};
}
