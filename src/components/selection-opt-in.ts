/**
 * Makes drag-selection **opt-in** across the whole TUI.
 *
 * OpenTUI's text-bearing renderables (`<text>`, `<code>`, `<markdown>`,
 * `<input>`, `<textarea>`, `<ascii-font>`, …) ship `selectable: true` by
 * default — the base `Renderable` is `false`, they override it. The renderer
 * turns a left mouse-down over any such renderable into a drag-selection
 * (`chunk`: `canStartSelection = renderable.selectable && …` →
 * `startSelection()`), which highlights text and fights with our
 * click-to-navigate UI, where nearly every label is also a click target.
 *
 * The previous fix neutered `renderer.startSelection`, which killed selection
 * *globally* — including on `<text selectable>` where we do want it (the server
 * console, so log lines can be copied). This module instead flips the
 * **default**: a renderable that was not given an explicit `selectable` prop
 * comes up non-selectable; one that was given the prop keeps exactly what the
 * caller asked for. Selection then works normally wherever it is opted into.
 *
 * Implemented by re-registering every entry of the React catalogue as a thin
 * subclass, because `selectable` is resolved inside each renderable's own
 * constructor (`options.selectable ?? this._defaultOptions.selectable`, where
 * `_defaultOptions` is a class *field* — not patchable from the prototype).
 * The reconciler constructs every catalogue component as
 * `new Component(ctx, { id, ...props })`, so a uniform `(ctx, options)`
 * subclass is safe for all of them.
 *
 * Note the two guards in the subclass: we only override when the prop was
 * absent, and only when the class actually defaulted to selectable — so
 * renderables that never had the flag (span nodes) and ones already
 * non-selectable (`<box>`) are left untouched.
 *
 * Install once, before the first render — `renderApp()` does this.
 *
 * UI-layer module: no I/O, no domain knowledge.
 */

import type { RenderContext } from "@opentui/core";
import {
  baseComponents,
  extend,
  type RenderableConstructor,
} from "@opentui/react";

/** The `selectable` flag as seen from outside the renderable class hierarchy. */
interface MaybeSelectable {
  selectable?: boolean;
}

/**
 * A catalogue entry seen structurally. `RenderableConstructor` resolves to the
 * *abstract* `BaseRenderable`, which TypeScript refuses to subclass in a class
 * expression, so the base is narrowed to just what this wrapper touches.
 */
type SelectableConstructor = new (
  ctx: RenderContext,
  options: { selectable?: boolean },
) => MaybeSelectable;

/**
 * Re-register the built-in component catalogue so `selectable` defaults to
 * `false`. Call once, before the first render; calling it again is harmless but
 * pointless (it would wrap the already-wrapped classes).
 */
export function installSelectionOptIn(): void {
  const optIn: Record<string, RenderableConstructor> = {};

  for (const [name, Base] of Object.entries(baseComponents) as [
    string,
    SelectableConstructor,
  ][]) {
    optIn[name] = class extends Base {
      constructor(ctx: RenderContext, options: { selectable?: boolean }) {
        super(ctx, options);
        // Ignore if input node. Input should be selectable, but the input field itself is not a text renderable — the selection is handled by the input's internal text buffer. The input field itself is a box, which is not selectable.
        if (name === "input" || name === "textarea") {
          return;
        }

        // Prop given → the caller decides. Prop absent → off, but only for
        // classes that opted themselves in; leave everything else as built.
        if (options?.selectable === undefined && this.selectable === true) {
          this.selectable = false;
        }
      }
    } as unknown as RenderableConstructor;
  }

  extend(optIn);
}
