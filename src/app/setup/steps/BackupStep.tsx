/**
 * Step 4 — Backup policy. Whether backups run automatically, and the provider and
 * archive format used. Scheduling and retention are configured later (Phase 4),
 * so this keeps to the durable choices that belong in the initial config.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3). The provider/compression fields only
 * appear when backups are enabled — an off toggle needs no further questions.
 */

import {
  RadioGroup,
  Select,
  Toggle,
  type RadioItem,
  type SelectItem,
} from "../../../components/index.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useFocusRing } from "../../../hooks/use-focus-ring.ts";
import { StepScaffold } from "../StepScaffold.tsx";
import { WizardFooter } from "../WizardFooter.tsx";
import type { StepProps } from "../types.ts";
import type { BackupProvider, CompressionKind } from "../../../types/config.ts";

/** Backup providers available today. Cloud targets arrive in Phase 4. */
const PROVIDERS: SelectItem<BackupProvider>[] = [
  {
    label: "Filesystem",
    value: "filesystem",
    description: "archives written to the backups directory",
  },
];

/** Archive formats, best default first. */
const COMPRESSION: RadioItem<CompressionKind>[] = [
  { label: "tar.zst", value: "tar.zst", description: "best ratio + speed" },
  { label: "tar.gz", value: "tar.gz", description: "widely compatible" },
  { label: "zip", value: "zip", description: "portable" },
];

export function BackupStep({ draft, setDraft, onNext, onBack }: StepProps) {
  const { colors } = useTheme();
  const ids = [
    "enabled",
    ...(draft.backupEnabled ? ["provider", "compression"] : []),
    "__back",
    "__next",
  ];
  const ring = useFocusRing(ids);

  return (
    <StepScaffold
      title="Backups"
      description="How MCTL saves your worlds. You can back up manually regardless."
      footer={
        <WizardFooter
          hints={[
            { keys: "Tab", label: "next field" },
            { keys: "Space", label: "toggle" },
          ]}
          backFocused={ring.isFocused("__back")}
          nextFocused={ring.isFocused("__next")}
          onBack={onBack}
          onNext={onNext}
          onFocusBack={() => ring.setFocus("__back")}
          onFocusNext={() => ring.setFocus("__next")}
        />
      }
    >
      <Toggle
        label="Automatic backups"
        hint="scheduling is set up later on the Backups page"
        value={draft.backupEnabled}
        focused={ring.isFocused("enabled")}
        onFocused={() => ring.setFocus("enabled")}
        onChange={(v) => setDraft({ backupEnabled: v })}
      />

      {draft.backupEnabled ? (
        <>
          <Select
            label="Provider"
            hint="where archives are stored"
            options={PROVIDERS}
            value={draft.backupProvider}
            width={44}
            focused={ring.isFocused("provider")}
            onFocused={() => ring.setFocus("provider")}
            onChange={(v) => setDraft({ backupProvider: v })}
          />
          <RadioGroup
            label="Compression"
            hint="archive format"
            options={COMPRESSION}
            value={draft.compression}
            focused={ring.isFocused("compression")}
            onFocused={() => ring.setFocus("compression")}
            onChange={(v) => setDraft({ compression: v })}
          />
        </>
      ) : (
        <text fg={colors.muted}>
          Backups are off. Turn them on to choose a provider and format, or set
          this up later in Settings.
        </text>
      )}
    </StepScaffold>
  );
}
