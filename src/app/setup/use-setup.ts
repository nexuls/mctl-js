/**
 * useSetup — the first-run wizard's bridge to core.
 *
 * The wizard pages are UI-only (AGENTS.md § 3); the actual writes go through the
 * config service. This hook maps the {@link SetupDraft} view model to a real
 * config object and commits it: `writeConfig` (validates + fills defaults),
 * `writeSecrets({})` (an empty `0600` file), then `ensureDirTree` to create the
 * data directories. It never re-implements writing — those helpers already exist
 * in `core/config`.
 *
 * The mapping ({@link draftToConfig}) is exported separately and pure, so the
 * Review step can preview the exact object that will be written without doing any
 * I/O.
 */

import { useCallback, useState } from "react";
import {
  ensureDirTree,
  resolveRootPaths,
  writeConfig,
  writeSecrets,
} from "../../core/config/index.ts";
import { configFile } from "../../lib/paths.ts";
import { CONFIG_VERSION, type Config } from "../../types/config.ts";
import type { SetupDraft } from "./types.ts";

/** What {@link commitSetup} produced — the paths a caller wants to surface next. */
export interface SetupResult {
  /** The written config file path. */
  configFile: string;
  /** The chosen data root. */
  root: string;
  /** Resolved servers directory (override or `root/servers`). */
  serversDir: string;
  /** Resolved backups directory (override or `root/backups`). */
  backupsDir: string;
}

/**
 * Turn the wizard draft into a `config.json` object (unparsed — `writeConfig`
 * applies the Zod schema and defaults). `theme` carries the theme id the user is
 * currently viewing so their choice survives into the persisted config. Optional
 * string fields collapse to `undefined` when empty so the schema default applies.
 */
export function draftToConfig(draft: SetupDraft, themeId: string): unknown {
  return {
    configVersion: CONFIG_VERSION,
    root: draft.root,
    servers_dir:
      draft.overrideServers && draft.serversDir ? draft.serversDir : undefined,
    backups_dir:
      draft.overrideBackups && draft.backupsDir ? draft.backupsDir : undefined,
    theme: themeId,
    defaults: {
      minecraftVersion: draft.minecraftVersion || undefined,
      kind: draft.kind,
      memory: draft.memory,
      runtime: draft.runtime,
      eula: draft.eula,
    },
    backup: {
      enabled: draft.backupEnabled,
      provider: draft.backupProvider,
      compression: draft.compression,
    },
    network: {
      defaultProfile: draft.network,
    },
  };
}

/**
 * Write config + empty secrets + the directory tree for a completed wizard.
 * Standalone (not the hook) so non-React callers could reuse it later.
 * @throws whatever `writeConfig`/`writeSecrets` throw on a validation or I/O
 *   failure — the caller decides how to surface it.
 */
export async function commitSetup(
  draft: SetupDraft,
  themeId: string,
): Promise<SetupResult> {
  const config: Config = await writeConfig(draftToConfig(draft, themeId));
  await writeSecrets({});
  await ensureDirTree(config);
  const paths = resolveRootPaths(config);
  return {
    configFile: configFile(),
    root: config.root,
    serversDir: paths.serversDir,
    backupsDir: paths.backupsDir,
  };
}

/** The state and action returned by {@link useSetup}. */
export interface UseSetup {
  /** Commit the draft; resolves to the result, or `null` if it failed (see `error`). */
  commit: (draft: SetupDraft, themeId: string) => Promise<SetupResult | null>;
  /** True while a commit is in flight — disable the confirm control. */
  committing: boolean;
  /** The last commit error message, or `null`. Cleared when a new commit starts. */
  error: string | null;
}

/**
 * React wrapper over {@link commitSetup} that tracks in-flight and error state so
 * the Review step can show a spinner and surface a failure inline rather than
 * throwing out of the render tree.
 */
export function useSetup(): UseSetup {
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = useCallback(
    async (draft: SetupDraft, themeId: string) => {
      setCommitting(true);
      setError(null);
      try {
        return await commitSetup(draft, themeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setCommitting(false);
      }
    },
    [],
  );

  return { commit, committing, error };
}
