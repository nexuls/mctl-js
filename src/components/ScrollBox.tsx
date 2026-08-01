/**
 * ScrollBox — the project's wrapper around OpenTUI's `<scrollbox>` intrinsic.
 *
 * It is a pass-through: every prop and the `ref` go straight to `<scrollbox>`,
 * so it behaves exactly like the intrinsic element. It exists to add one prop —
 * `enableAccel` — and to give the app a single place to put future
 * scroll-behaviour defaults instead of repeating them at seven call sites.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): rendering only, no I/O.
 */

import { MacOSScrollAccel } from "@opentui/core";
import type { ScrollBoxProps as OpenTuiScrollBoxProps } from "@opentui/react";
import { useMemo } from "react";

export type ScrollBoxProps = OpenTuiScrollBoxProps & {
  /**
   * Accelerate the mouse wheel: a fast flick covers a long region in one
   * gesture while a slow wheel still moves a line per notch.
   *
   * Off by default, because acceleration is wrong for a short region — a
   * two-row tab strip or a small list would overshoot on the first flick. Turn
   * it on for a region that can be *pages* long (the router's page host).
   *
   * Ignored when the caller passes its own {@link OpenTuiScrollBoxProps.scrollAcceleration}.
   */
  enableAccel?: boolean;
};

/**
 * A `<scrollbox>` with an optional accelerated wheel. All other props and the
 * `ref` are forwarded untouched.
 */
export function ScrollBox({
  enableAccel = false,
  scrollAcceleration,
  ...rest
}: ScrollBoxProps) {
  // `MacOSScrollAccel` scales the wheel delta by an exponential of the recent
  // scroll velocity (a streak breaks after 150 ms of silence, so a slow wheel
  // stays 1:1). The accelerator is **stateful** — it holds the tick history —
  // so the instance must survive re-renders: a fresh one per render would reset
  // the streak on every keypress and silently degrade to linear scrolling.
  const accel = useMemo(
    () => (enableAccel ? new MacOSScrollAccel() : undefined),
    [enableAccel],
  );
  const resolved = scrollAcceleration ?? accel;

  // Spread the prop only when it resolves to something: OpenTUI's ScrollBox
  // falls back to `LinearScrollAccel` when the option is absent at construction,
  // but its setter would happily store an explicit `undefined`.
  return (
    <scrollbox {...rest} {...(resolved ? { scrollAcceleration: resolved } : {})} />
  );
}
