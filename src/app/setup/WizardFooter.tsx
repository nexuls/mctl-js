/**
 * WizardFooter — the shared bottom bar of a wizard step: a keyboard-hint strip on
 * the left, Back / Continue buttons on the right.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): the buttons report intent via
 * `onBack`/`onNext`; the step owns the focus ring and passes the focused flags in.
 * The buttons handle their own Enter/Space when focused (see {@link Button}), so
 * the footer needs no keyboard logic of its own.
 */

import { Button, Hint, type HintItem } from "../../components/index.ts";

/** Props for {@link WizardFooter}. */
export interface WizardFooterProps {
  /** Shortcut hints shown on the left. */
  hints: HintItem[];
  /** Whether a Back button is shown (hidden on the very first step if desired). */
  canBack?: boolean;
  /** Label for the primary button. Defaults to "Continue". */
  nextLabel?: string;
  /** Whether the Back button holds focus. */
  backFocused?: boolean;
  /** Whether the primary button holds focus. */
  nextFocused?: boolean;
  /** Disable the primary button (invalid step, or a commit in flight). */
  nextDisabled?: boolean;
  /** Go back a step. */
  onBack?: () => void;
  /** Advance / commit. */
  onNext?: () => void;
  /** Move the ring to the Back button (mouse click). */
  onFocusBack?: () => void;
  /** Move the ring to the primary button (mouse click). */
  onFocusNext?: () => void;
}

/** The step's navigation bar. */
export function WizardFooter({
  hints,
  canBack = true,
  nextLabel = "Continue",
  backFocused = false,
  nextFocused = false,
  nextDisabled = false,
  onBack,
  onNext,
  onFocusBack,
  onFocusNext,
}: WizardFooterProps) {
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      flexShrink={0}
    >
      <Hint items={hints} />
      <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
        {canBack ? (
          <Button
            kind="ghost"
            variant="neutral"
            focused={backFocused}
            onClick={onBack}
            onFocused={onFocusBack}
          >
            ← Back
          </Button>
        ) : null}
        <Button
          kind="outline"
          variant="primary"
          focused={nextFocused}
          disabled={nextDisabled}
          onClick={onNext}
          onFocused={onFocusNext}
        >
          {nextLabel}
        </Button>
      </box>
    </box>
  );
}
