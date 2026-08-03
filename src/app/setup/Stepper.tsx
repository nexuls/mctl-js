/**
 * Stepper — the vertical progress rail on the left of the wizard.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders the step list from props.
 * Completed steps show a filled check in the success colour, the current step a
 * filled bullet in the accent colour (bold), and upcoming steps a hollow bullet,
 * muted — so "where am I / what's left" reads at a glance.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";

/** Props for {@link Stepper}. */
export interface StepperProps {
  /** Step titles, in order. */
  steps: readonly string[];
  /** Index of the active step (0-based). Steps before it are treated as done. */
  current: number;
}

/** The left-hand progress rail. Fixed-width so the content column stays stable. */
export function Stepper({ steps, current }: StepperProps) {
  const { colors } = useTheme();
  const { icons } = useIcons();
  return (
    <box flexDirection="column" gap={1} width={18} flexShrink={0}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const marker = done
          ? icons.stepDone
          : active
            ? icons.stepActive
            : icons.stepTodo;
        const markerColor = done
          ? colors.success
          : active
            ? colors.primary
            : colors.border;
        const labelColor = active ? colors.foreground : colors.muted;
        return (
          <box
            // Static list, never reordered — index key is fine.
            key={i}
            flexDirection="row"
            gap={1}
            alignItems="center"
            flexShrink={0}
          >
            <text fg={markerColor}>{marker}</text>
            <text
              fg={labelColor}
              attributes={active ? TextAttributes.BOLD : undefined}
            >
              {label}
            </text>
          </box>
        );
      })}
    </box>
  );
}
