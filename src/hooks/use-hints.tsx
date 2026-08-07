/**
 * useHints — the app's single keyboard-hint strip, contributed to from anywhere.
 *
 * The bottom hint strip is rendered exactly once, by the shell (`app/Router.tsx`).
 * Every screen that has shortcuts worth advertising *registers* them here instead
 * of drawing a strip of its own — before this existed the shell and each page both
 * painted one, so the same keys appeared twice and a page's strip could contradict
 * the shell's.
 *
 * **Three scopes, most specific first.** A contribution declares where it belongs:
 *
 * | Scope | Who registers it | Where it renders |
 * |---|---|---|
 * | `context` | the focused control, or a page mode (the Console tab's command line) | first |
 * | `page` | the active page | middle |
 * | `global` | the shell (navigate / theme / quit / Esc) | last |
 *
 * Merging is by **key signature**, not by label: the most specific contribution
 * owns a key, so a page registering `Esc → cancel` replaces the shell's
 * `Esc → back` rather than showing both. That is what lets a page override the
 * chrome without knowing what the chrome says.
 *
 * **Typing is handled here, not by the caller.** A hint declares *when* it applies
 * ({@link HintWhen}); while an input capture is held (`use-input-capture.tsx`) the
 * shell's character shortcuts do nothing, so `idle` hints are dropped and `typing`
 * hints take their place. A page therefore never has to mirror the capture state
 * in its own strip.
 *
 * UI-layer hook: React state only — no I/O, no domain knowledge.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import type { HintItem } from "../components/Hint.tsx";
import { useIsCapturing } from "./use-input-capture.tsx";

/**
 * When a hint is worth showing.
 *
 * - `idle` — only while nothing is being typed into. Plain-character shortcuts
 *   (`q`, `t`, digits) belong here: they are inert while a text field owns the
 *   keyboard, and advertising a key that silently does nothing is worse than
 *   showing no key at all.
 * - `typing` — only while a text field is capturing keys.
 * - `always` — the default. Keys no text field consumes (`Esc`, `Tab`, `Ctrl+S`).
 */
export type HintWhen = "always" | "idle" | "typing";

/** Where a hint sits in the strip; see the module comment for the ordering rule. */
export type HintScope = "context" | "page" | "global";

/** One registered hint: a {@link HintItem} plus when and where it applies. */
export interface HintSpec extends HintItem {
	/** Defaults to `"always"`. */
	when?: HintWhen;
}

/** Options for {@link useHints}. */
export interface UseHintsOptions {
	/** Which band of the strip these belong to. Defaults to `"page"`. */
	scope?: HintScope;
	/**
	 * Register only while true — for hints that belong to a mode rather than to
	 * the page (the Console tab's command line, a focused list). Defaults to true.
	 */
	active?: boolean;
}

/** A live registration, in registration order within its scope. */
interface Registration {
	scope: HintScope;
	items: HintSpec[];
}

/** Register a set of hints; the returned function withdraws them. */
type Register = (entry: Registration) => () => void;

/**
 * Two contexts, deliberately: the register function never changes, so a page
 * that only *contributes* hints never re-renders when the strip changes, while
 * the one component that draws the strip subscribes to its contents.
 */
const RegisterContext = createContext<Register | undefined>(undefined);
const ItemsContext = createContext<HintItem[]>([]);

/** Scope order: most specific first, so a page's keys lead the shell's chrome. */
const SCOPE_ORDER: readonly HintScope[] = ["context", "page", "global"];

/** The identity of a hint for de-duplication: its keys, not its label. */
function keySignature(item: HintSpec): string {
	return (Array.isArray(item.keys) ? item.keys : [item.keys]).join("+");
}

/** Whether a hint applies in the current typing state. */
function applies(item: HintSpec, typing: boolean): boolean {
	const when = item.when ?? "always";
	if (when === "always") return true;
	return when === "typing" ? typing : !typing;
}

/**
 * Merge every registration into the strip: most specific scope first, one entry
 * per key signature (the first — i.e. most specific — wins), dropping hints that
 * do not apply while typing.
 */
export function composeHints(
	registrations: Iterable<Registration>,
	typing: boolean,
): HintItem[] {
	const all = [...registrations];
	const seen = new Set<string>();
	const out: HintItem[] = [];
	for (const scope of SCOPE_ORDER) {
		for (const registration of all) {
			if (registration.scope !== scope) continue;
			for (const item of registration.items) {
				if (!applies(item, typing)) continue;
				const signature = keySignature(item);
				if (seen.has(signature)) continue;
				seen.add(signature);
				out.push({ keys: item.keys, label: item.label });
			}
		}
	}
	return out;
}

/** The inert registration used when no provider is mounted; see {@link useRegister}. */
const NO_REGISTER: Register = () => () => {};

/**
 * Provide the hint registry. Mount it above both the shell's strip and the pages
 * that contribute to it, and below `InputCaptureProvider` so the typing filter
 * can see the capture.
 *
 * Registrations live in a **ref** keyed by a serial id, with a counter in state
 * as the change signal: pages register from an effect, and holding the map in
 * state would make that effect feed its own dependency. Composition is cheap
 * (a dozen short strings), so it simply re-runs on each signal.
 */
export function HintProvider({ children }: { children: ReactNode }) {
	const typing = useIsCapturing();
	const registrations = useRef(new Map<number, Registration>());
	const nextId = useRef(0);
	const [, bumpVersion] = useState(0);

	const register = useCallback<Register>((entry) => {
		const id = nextId.current++;
		registrations.current.set(id, entry);
		bumpVersion((v) => v + 1);
		return () => {
			registrations.current.delete(id);
			bumpVersion((v) => v + 1);
		};
	}, []);

	const items = composeHints(registrations.current.values(), typing);

	return (
		<RegisterContext.Provider value={register}>
			<ItemsContext.Provider value={items}>{children}</ItemsContext.Provider>
		</RegisterContext.Provider>
	);
}

/**
 * The register function, or a no-op when no provider is mounted. Deliberately
 * does not throw (unlike `useTheme`): the setup wizard draws its own footer
 * outside the shell, and a component with no hint strip is still renderable.
 */
function useRegister(): Register {
	return useContext(RegisterContext) ?? NO_REGISTER;
}

/**
 * Contribute hints to the shell's strip for as long as this component is mounted
 * (and `options.active` holds). Withdrawn automatically on unmount, so navigating
 * away can never leave a stale hint on screen.
 *
 * `items` is compared by value, so callers do not have to memoize the array —
 * hint lists are a handful of short strings, and requiring a `useMemo` at every
 * call site would be a trap that fails silently (an infinite re-register loop).
 */
export function useHints(
	items: HintSpec[],
	options: UseHintsOptions = {},
): void {
	const register = useRegister();
	const { scope = "page", active = true } = options;
	// Value identity: the effect must re-run when the *contents* change, not when
	// the caller happens to build a fresh array.
	const signature = JSON.stringify(items);

	useEffect(() => {
		if (!active) return;
		return register({ scope, items: JSON.parse(signature) as HintSpec[] });
	}, [register, scope, active, signature]);
}

/**
 * The merged strip, for the one component that renders it. Everything else
 * contributes with {@link useHints} instead of reading this.
 */
export function useHintItems(): HintItem[] {
	return useContext(ItemsContext);
}
