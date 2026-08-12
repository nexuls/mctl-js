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
 * Two rules make the ring behave the way a keyboard user expects, and both are
 * load-bearing:
 *
 *  - **A disabled control is not in the ring.** An entry may be given as
 *    `{ id, disabled: true }`, and Tab then steps straight over it. Tabbing onto
 *    a dimmed button that ignores Enter is indistinguishable from the keyboard
 *    being broken, and the disabled state usually depends on live data (a running
 *    server, a dirty form), so the caller cannot express it by omitting the id —
 *    omission would also renumber the ring under the user's fingers, whereas a
 *    disabled entry holds its place and simply cannot hold focus.
 *  - **Only one ring listens at a time.** Every mounted `useFocusRing` installs a
 *    `useKeyboard` handler, and OpenTUI delivers a keypress to *all* of them — so
 *    a page ring and a modal's ring would both move on one Tab. Whichever ring is
 *    not currently interactive passes `{ enabled: false }` (see the `Dialog`
 *    users), which stands its keyboard down while leaving `isFocused` intact.
 *
 * UI-layer hook (uses `useKeyboard`); no I/O, no domain knowledge — it only knows
 * a list of string ids.
 */

import { useCallback, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";

/**
 * One ring member: a bare id, or an id that may currently be unfocusable.
 *
 * The object form exists so a page can hand the ring the *same* list every
 * render and let the ring skip what is disabled, rather than assembling a
 * different list per state.
 */
export type FocusItem = string | { id: string; disabled?: boolean };

/** Options for {@link useFocusRing}. */
export interface FocusRingOptions {
	/**
	 * Whether the ring reacts to Tab / Shift-Tab. Defaults to `true`. Set `false`
	 * while something else owns the keyboard (a modal is open, the page is busy) —
	 * the ring keeps its focused id, it just stops moving.
	 */
	enabled?: boolean;
}

/** The focus-ring controls returned by {@link useFocusRing}. */
export interface FocusRing {
	/** The currently-focused id, or `undefined` when no member can hold focus. */
	focus: string | undefined;
	/** Whether `id` is the focused control. Feed this to a control's `focused` prop. */
	isFocused: (id: string) => boolean;
	/** Move focus to `id` (no-op if it isn't in the ring, or is disabled). Wire to `onFocused`. */
	setFocus: (id: string) => void;
	/** Advance focus to the next enabled control, wrapping at the end. */
	next: () => void;
	/** Move focus to the previous enabled control, wrapping at the start. */
	prev: () => void;
}

/** Internal, normalized ring member. */
interface Entry {
	id: string;
	disabled: boolean;
}

/** Widen the caller's mixed list into one uniform shape. */
function normalize(items: FocusItem[]): Entry[] {
	return items.map((item) =>
		typeof item === "string"
			? { id: item, disabled: false }
			: { id: item.id, disabled: item.disabled === true },
	);
}

/**
 * Resolve a stored index onto a focusable member: the entry itself if it can hold
 * focus, otherwise the next enabled one (wrapping). Returns `-1` when nothing in
 * the ring is focusable — an all-disabled action bar is a legitimate state.
 */
function resolve(entries: Entry[], index: number): number {
	const count = entries.length;
	if (count === 0) return -1;
	const start = Math.min(Math.max(index, 0), count - 1);
	for (let step = 0; step < count; step += 1) {
		const at = (start + step) % count;
		if (!entries[at]?.disabled) return at;
	}
	return -1;
}

/**
 * Manage focus across an ordered set of controls.
 *
 * @param items Focus order, first to last. May change between renders (e.g. a
 *   conditionally-shown field) — the internal index is clamped so focus stays
 *   valid, and `setFocus`/`isFocused` always resolve against the current list.
 *   Disabled members are skipped by every movement.
 * @param options See {@link FocusRingOptions}.
 */
export function useFocusRing(
	items: FocusItem[],
	options: FocusRingOptions = {},
): FocusRing {
	const { enabled = true } = options;
	const [index, setIndex] = useState(0);
	const entries = normalize(items);

	// The keyboard handler closes over one render, so it reads the current ring
	// through a ref rather than the captured `entries` — a server that stopped
	// between renders must not be tabbed onto.
	const entriesRef = useRef<Entry[]>(entries);
	entriesRef.current = entries;

	const move = useCallback((delta: number) => {
		setIndex((current) => {
			const list = entriesRef.current;
			const count = list.length;
			if (count === 0) return 0;
			const from = resolve(list, current);
			if (from < 0) return current;
			// Walk in `delta`'s direction until an enabled member turns up; a full
			// lap with none found means `from` was the only one, so stay put.
			for (let step = 1; step <= count; step += 1) {
				const at = (((from + delta * step) % count) + count) % count;
				if (!list[at]?.disabled) return at;
			}
			return from;
		});
	}, []);

	useKeyboard((key) => {
		if (!enabled) return;
		// Shift-Tab arrives either as `tab` with the shift modifier or as the
		// distinct `backtab` name depending on the terminal — handle both.
		if (key.name === "tab") move(key.shift ? -1 : 1);
		else if (key.name === "backtab") move(-1);
	});

	const focusIndex = resolve(entries, index);
	const focus = focusIndex >= 0 ? entries[focusIndex]?.id : undefined;

	return {
		focus,
		isFocused: (id: string) => id === focus,
		setFocus: (id: string) => {
			const at = entries.findIndex((entry) => entry.id === id);
			if (at >= 0 && !entries[at]?.disabled) setIndex(at);
		},
		next: () => move(1),
		prev: () => move(-1),
	};
}
