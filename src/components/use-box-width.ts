/**
 * useBoxWidth — the laid-out width, in cells, of a box the caller holds a ref to.
 *
 * Pure-UI (AGENTS.md § 3): no I/O, no domain knowledge. It exists because a
 * terminal component that must lay itself out in columns needs a real number,
 * and OpenTUI's `width` prop vocabulary (`number | "auto" | "<n>%"`) does not
 * hand one back — a percentage resolves against the parent, inside the layout
 * engine, after React has finished.
 *
 * Shared by {@link "./Form".Select} (tabs vs dropdown) and
 * {@link "./Table".Table} (which columns fit).
 */

import type { BoxRenderable } from "@opentui/core";
import { useEffect, useState } from "react";

/**
 * Track the laid-out width in cells of the box `ref` points at.
 *
 * A renderable's `width` is only meaningful *after* yoga has laid it out, which
 * happens on the render loop's next frame — after React's effects. So an effect
 * can only seed the value and then wait: OpenTUI emits `"resize"` on a
 * renderable whenever its computed size changes (`Renderable.onResize`, which
 * `updateFromLayout` calls on a size change). Note the event is `"resize"` on a
 * *renderable* — `"resized"` belongs to the root and `"resize"` on the renderer
 * is the terminal itself; neither reaches a box.
 *
 * Returns 0 until the first layout, so callers must have a sensible answer for
 * "not measured yet" (`Select` falls back to its `width` prop; `Table` falls
 * back to the terminal width).
 *
 * The ref must be attached on **every** render path, or the listener is never
 * installed: a branch that only attaches it in one of its arms can never leave
 * the other arm, because the width that would flip it is never observed.
 */
export function useBoxWidth(
	ref: React.RefObject<BoxRenderable | null>,
): number {
	const [width, setWidth] = useState(0);

	useEffect(() => {
		const box = ref.current;
		if (!box) return;
		const onResize = () => setWidth(box.width);
		onResize();
		box.on("resize", onResize);
		return () => {
			box.off("resize", onResize);
		};
	}, [ref]);

	return width;
}
