/**
 * Step 6 — Review & create. Summarises every choice against the resolved paths,
 * then writes it: `config.json`, an empty `0600` `secrets.json`, and the data
 * directory tree (all via {@link useSetup}). This is the only step that performs
 * I/O, and it does so through the setup hook — never directly.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): resolved paths are computed with the
 * pure `rootPaths` helper; the write is delegated to the hook.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useFocusRing } from "../../../hooks/use-focus-ring.ts";
import { rootPaths } from "../../../lib/paths.ts";
import { StepScaffold } from "../StepScaffold.tsx";
import { WizardFooter } from "../WizardFooter.tsx";
import type { SetupDraft } from "../types.ts";

/** Props for {@link ReviewStep}. */
export interface ReviewStepProps {
  /** The draft to summarise and write. */
  draft: SetupDraft;
  /** Return to the previous step. */
  onBack: () => void;
  /** Commit the config; the container advances to the dashboard on success. */
  onCommit: () => void;
  /** True while the write is in flight. */
  committing: boolean;
  /** A commit error message to surface inline, or null. */
  error: string | null;
}

/** One label/value row in the summary panel. */
function Row({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <box width={16} flexShrink={0}>
        <text fg={colors.muted}>{label}</text>
      </box>
      <text fg={colors.foreground}>{value}</text>
    </box>
  );
}

export function ReviewStep({
  draft,
  onBack,
  onCommit,
  committing,
  error,
}: ReviewStepProps) {
  const { colors } = useTheme();
  const { icons } = useIcons();
  const ring = useFocusRing(["__back", "__next"]);
  const paths = rootPaths(
    draft.root,
    draft.overrideServers || draft.overrideBackups
      ? {
          serversDir: draft.overrideServers ? draft.serversDir : undefined,
          backupsDir: draft.overrideBackups ? draft.backupsDir : undefined,
        }
      : undefined,
  );

  return (
    <StepScaffold
      title="Review & create"
      description="Confirm the setup below. Only the data root is permanent."
      footer={
        <WizardFooter
          hints={[
            { keys: "Tab", label: "back / create" },
            { keys: "Enter", label: "create" },
          ]}
          nextLabel={committing ? "Creating…" : `Create ${icons.success}`}
          nextDisabled={committing}
          backFocused={ring.isFocused("__back")}
          nextFocused={ring.isFocused("__next")}
          onBack={onBack}
          onNext={onCommit}
          onFocusBack={() => ring.setFocus("__back")}
          onFocusNext={() => ring.setFocus("__next")}
        />
      }
    >
      <box
        border
        borderStyle="rounded"
        borderColor={colors.border}
        padding={1}
        flexDirection="column"
        flexShrink={0}
      >
        <Row label="Data root" value={paths.root} />
        <Row label="Servers" value={paths.serversDir} />
        <Row label="Backups" value={paths.backupsDir} />
        <Row
          label="New servers"
          value={`${draft.kind} · MC ${draft.minecraftVersion || "latest"} · ${draft.memory} · ${draft.runtime}`}
        />
        <Row label="EULA" value={draft.eula ? "auto-accept" : "prompt on create"} />
        <Row
          label="Backups"
          value={
            draft.backupEnabled
              ? `on · ${draft.backupProvider} · ${draft.compression}`
              : "off (manual only)"
          }
        />
        <Row label="Network" value={draft.network} />
      </box>

      <text fg={colors.muted} attributes={TextAttributes.DIM}>
        Writes config.json, an empty secrets.json (0600), and the data directory
        tree.
      </text>

      {error ? (
        <box
          border
          borderStyle="rounded"
          borderColor={colors.error}
          padding={1}
          flexShrink={0}
        >
          <text fg={colors.error}>Setup failed: {error}</text>
        </box>
      ) : null}
    </StepScaffold>
  );
}
