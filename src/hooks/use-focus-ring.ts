/**
 * useFocusRing — keyboard focus management for a page's controls.
 *
 * OpenTUI has no global focus manager, so a page that stacks several focusable
 * controls (a form, a wizard step, a toolbar) must decide which one is "active"
 * and cycle between them itself. This hook owns that: given an ordered list of
 * control ids, it tracks the focused one and moves the ring with Tab / Shift-Tab.
 *
 * The page passes `isFocused(id)` to each control's `focused` prop and wires each
 * control's `onFocused` to `setFocus(id)` (so a mouse click also moves the ring —
 * the convention in components/*). `next`/`prev` let a control advance the ring
 * itself, e.g. an `<Input onSubmit>` moving to the following field on Enter.
 *
 * UI-layer hook (uses `useKeyboard`); no I/O, no domain knowledge — it only knows
 * a list of string ids.
 */

import { useCallback, useState } from "react";
import { useKeyboard } from "@opentui/react";

/** The focus-ring controls returned by {@link useFocusRing}. */
export interface FocusRing {
  /** The currently-focused id, or `undefined` when the ring is empty. */
  focus: string | undefined;
  /** Whether `id` is the focused control. Feed this to a control's `focused` prop. */
  isFocused: (id: string) => boolean;
  /** Move focus to `id` (no-op if it isn't in the ring). Wire to `onFocused`. */
  setFocus: (id: string) => void;
  /** Advance focus to the next control, wrapping at the end. */
  next: () => void;
  /** Move focus to the previous control, wrapping at the start. */
  prev: () => void;
}

/**
 * Manage focus across an ordered set of control ids.
 *
 * @param ids Focus order, first to last. May change between renders (e.g. a
 *   conditionally-shown field) — the internal index is clamped so focus stays
 *   valid, and `setFocus`/`isFocused` always resolve against the current list.
 */
export function useFocusRing(ids: string[]): FocusRing {
  const [index, setIndex] = useState(0);
  const count = ids.length;

  const move = useCallback(
    (delta: number) => {
      setIndex((i) => {
        if (count === 0) return 0;
        const cur = Math.min(i, count - 1);
        return (cur + delta + count) % count;
      });
    },
    [count],
  );

  useKeyboard((key) => {
    // Shift-Tab arrives either as `tab` with the shift modifier or as the
    // distinct `backtab` name depending on the terminal — handle both.
    if (key.name === "tab") move(key.shift ? -1 : 1);
    else if (key.name === "backtab") move(-1);
  });

  const clamped = count === 0 ? -1 : Math.min(index, count - 1);
  const focus = clamped >= 0 ? ids[clamped] : undefined;

  return {
    focus,
    isFocused: (id: string) => id === focus,
    setFocus: (id: string) => {
      const i = ids.indexOf(id);
      if (i >= 0) setIndex(i);
    },
    next: () => move(1),
    prev: () => move(-1),
  };
}
