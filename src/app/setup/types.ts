/**
 * The first-run wizard's working state — the mutable draft the user edits across
 * the steps before it is written to `config.json`.
 *
 * This is a **flat view model**, not the config shape: paths carry an explicit
 * "override the default?" toggle, optional fields are plain strings (empty = "use
 * the default / resolve later"), and every choice is a value the components can
 * bind to directly. `use-setup.ts` maps this to a real {@link Config} object at
 * commit time (where Zod fills defaults and validates). No I/O, no OpenTUI here.
 */

import { join } from "node:path";
import { defaultRoot } from "../../lib/paths.ts";
import type {
  BackupProvider,
  CompressionKind,
  NetworkProvider,
  RuntimeKind,
  ServerKind,
} from "../../types/config.ts";

/** The wizard's editable state. */
export interface SetupDraft {
  /** Data root ($ROOT). Permanent after setup — plan.md § First-Run Setup Wizard. */
  root: string;

  /** Whether `serversDir` overrides the default `root/servers`. */
  overrideServers: boolean;
  /** Custom servers directory, used only when `overrideServers` is true. */
  serversDir: string;
  /** Whether `backupsDir` overrides the default `root/backups`. */
  overrideBackups: boolean;
  /** Custom backups directory, used only when `overrideBackups` is true. */
  backupsDir: string;

  /** Default Minecraft version for new servers; "" ⇒ resolve latest at create time. */
  minecraftVersion: string;
  /** Default server kind. */
  kind: ServerKind;
  /** Default JVM heap (e.g. "2G"). */
  memory: string;
  /** Default runtime provider. */
  runtime: RuntimeKind;
  /** Whether MCTL auto-accepts the Minecraft EULA on create. */
  eula: boolean;

  /** Whether scheduled/automatic backups are enabled by default. */
  backupEnabled: boolean;
  /** Default backup provider. */
  backupProvider: BackupProvider;
  /** Default archive compression. */
  compression: CompressionKind;

  /** Default network profile for new servers. */
  network: NetworkProvider;
}

/** Props every wizard step receives from the {@link SetupWizard} container. */
export interface StepProps {
  /** The current draft to render. */
  draft: SetupDraft;
  /** Apply a partial update to the draft (shallow-merged by the container). */
  setDraft: (patch: Partial<SetupDraft>) => void;
  /** Advance to the next step. */
  onNext: () => void;
  /** Return to the previous step (or the welcome screen from step 1). */
  onBack: () => void;
}

/** Human titles for the wizard steps, in order. Drives the {@link Stepper} rail. */
export const STEP_TITLES = [
  "Data root",
  "Locations",
  "Defaults",
  "Backups",
  "Network",
  "Review",
] as const;

/** The starting draft: sensible defaults matching the config schema's own defaults. */
export function initialDraft(): SetupDraft {
  const root = defaultRoot();
  return {
    root,
    overrideServers: false,
    serversDir: join(root, "servers"),
    overrideBackups: false,
    backupsDir: join(root, "backups"),
    minecraftVersion: "",
    kind: "vanilla",
    memory: "2G",
    runtime: "foreground",
    eula: false,
    backupEnabled: false,
    backupProvider: "filesystem",
    compression: "tar.zst",
    network: "direct",
  };
}
