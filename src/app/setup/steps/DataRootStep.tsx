/**
 * Step 1 — Data root. The single most important choice: where MCTL stores
 * everything (servers, backups, managed Java, downloads). Permanent after setup,
 * so it's the one field the wizard nudges hardest to get right, showing the free
 * space of the filesystem it will live on.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): the free-space probe is a hook
 * (`useDiskFree`), not a direct filesystem call.
 */

import { TextAttributes } from "@opentui/core";
import { Input } from "../../../components/index.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useDiskFree } from "../../../hooks/use-disk-free.ts";
import { useFocusRing } from "../../../hooks/use-focus-ring.ts";
import { formatBytes } from "../../../lib/format.ts";
import { StepScaffold } from "../StepScaffold.tsx";
import { WizardFooter } from "../WizardFooter.tsx";
import type { StepProps } from "../types.ts";

export function DataRootStep({ draft, setDraft, onNext, onBack }: StepProps) {
  const { colors } = useTheme();
  const ring = useFocusRing(["root", "__back", "__next"]);
  const usage = useDiskFree(draft.root);

  // Must be absolute — the config schema rejects a relative root, so catch it here
  // with an inline error rather than at commit time.
  const valid = draft.root.trim().startsWith("/");
  const showInvalid = draft.root.length > 0 && !valid;

  return (
    <StepScaffold
      title="Where should MCTL keep its data?"
      description="Servers, backups, managed Java, and downloads all live under this root."
      footer={
        <WizardFooter
          hints={[
            { keys: "Tab", label: "next field" },
            { keys: "Enter", label: "continue" },
          ]}
          nextDisabled={!valid}
          backFocused={ring.isFocused("__back")}
          nextFocused={ring.isFocused("__next")}
          onBack={onBack}
          onNext={() => valid && onNext()}
          onFocusBack={() => ring.setFocus("__back")}
          onFocusNext={() => ring.setFocus("__next")}
        />
      }
    >
      <Input
        label="Data root"
        required
        hint="an absolute path, e.g. /home/you/.mctl"
        value={draft.root}
        width="100%"
        invalid={showInvalid}
        focused={ring.isFocused("root")}
        onFocused={() => ring.setFocus("root")}
        onChange={(v) => setDraft({ root: v })}
        onSubmit={() => ring.next()}
      />

      <box flexDirection="column" gap={1}>
        <text fg={colors.muted}>
          Free space here:{" "}
          <span fg={colors.info}>
            {usage ? formatBytes(usage.free) : "…"}
          </span>
          {usage ? (
            <span fg={colors.muted}> of {formatBytes(usage.total)}</span>
          ) : null}
        </text>
        <text fg={colors.warning} attributes={TextAttributes.DIM}>
          This is permanent — it can't be changed after setup. Worlds get large;
          pick a drive with room.
        </text>
      </box>
    </StepScaffold>
  );
}
