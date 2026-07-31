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
 * **Theme is deliberately not part of the draft.** The theme provider owns the
 * active theme id and persists it on change (`App.tsx`), so a theme picked here
 * applies instantly like `t` does, rather than waiting for Save; a settings save
 * carries whatever id is active at that moment.
 */

import { isAbsolute } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureDirTree, writeConfig } from "../../core/config/index.ts";
import { rootPaths } from "../../lib/paths.ts";
import type {
  BackupProvider,
  CompressionKind,
  Config,
  NetworkProvider,
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

  /** Default network profile for new servers. */
  network: NetworkProvider;
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
  };
}

/**
 * Fold the edit buffer back into a full config object. Pure, and deliberately
 * **merge-not-replace**: `root`, `configVersion`, `theme`, the named network
 * profiles, and the backup schedule/retention are carried over untouched, so
 * editing a field the form shows never drops one it doesn't. An override toggled
 * off removes the key entirely, restoring the `root/...` default.
 *
 * @param themeId The theme id to persist — the *currently active* one, since the
 *   theme provider (not this draft) owns that choice.
 */
export function draftToConfig(
  config: Config,
  draft: SettingsDraft,
  themeId: string,
): unknown {
  return {
    ...config,
    theme: themeId,
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
    network: { ...config.network, defaultProfile: draft.network },
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
  save: (themeId: string) => Promise<string | null>;
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
    async (themeId: string) => {
      if (!config || !draft) return "settings are still loading";
      setSaving(true);
      setSaveError(null);
      try {
        const written = await writeConfig(draftToConfig(config, draft, themeId));
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
