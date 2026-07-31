/**
 * useToast — the app's transient-notification system: a provider that owns the
 * toast queue and its timers, and a hook that lets any page raise one in a line.
 *
 * ```tsx
 * const toast = useToast();
 * toast.success("Settings saved");
 * toast.error("Start failed", { description: err.message, duration: 0 });
 * ```
 *
 * **UI-layer only** (AGENTS.md § 3): React state and timers, no I/O and no domain
 * knowledge. A toast is a *report* of something that already happened — the page
 * or hook that performed the action raises it; the toast never performs one. The
 * cards themselves are pure UI in `components/Toast.tsx`; this file is the
 * scheduler in front of them.
 *
 * ## What the provider owns
 *
 * - **Delay** — a toast can be scheduled to appear later (`delay`), so a fast
 *   operation that succeeds immediately never flashes a spinner.
 * - **Time to live** — each toast expires after `duration` ms (`0`/`Infinity`
 *   makes it sticky, dismissed only by the user or by code). Hovering a card
 *   pauses its countdown and leaving resumes it, so a toast can't vanish while it
 *   is being read.
 * - **Stacking** — at most `maxVisible` toasts show per position; the rest queue
 *   and their countdown only starts once they are actually on screen.
 * - **Position** — six screen anchors, chosen per toast or per provider.
 *
 * ## Keyboard safety
 *
 * A toast action may bind a single key (`action.key`). Plain characters belong to
 * a focused text field first, so the binding stands down while an input capture
 * is held — the same guard the shell uses for its digit/`q`/`t` shortcuts
 * (`use-input-capture.tsx`). `Esc` is never bound: the shell owns it.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useKeyboard } from "@opentui/react";
import {
	SPINNER_FRAMES,
	TOAST_POSITIONS,
	ToastViewport,
	type ToastAction,
	type ToastPosition,
	type ToastVisual,
} from "../components/Toast.tsx";
import type { Variant } from "../components/support.ts";
import { useKeysCaptured } from "./use-input-capture.tsx";

/** Handle to a live toast, returned by every raise. */
export type ToastId = string;

/** Why a toast went away — passed to {@link ToastOptions.onDismiss}. */
export type ToastDismissReason =
	/** Its time to live elapsed. */
	| "timeout"
	/** The user clicked it or its ✕. */
	| "user"
	/** Its action was invoked. */
	| "action"
	/** `dismiss()` / `dismissAll()` was called. */
	| "programmatic";

/** Everything a caller can say about a toast. All fields are optional but `title`. */
export interface ToastOptions {
	/**
	 * Reuse a specific id. Raising a toast with an id that is already showing
	 * **updates it in place** (and restarts its countdown) instead of stacking a
	 * duplicate — the way to keep one live toast for a repeating event.
	 */
	id?: ToastId;
	/** The headline. Required when calling {@link ToastApi.show} with an object. */
	title?: string;
	/** Supporting detail under the title. */
	description?: string;
	/** Intent → colour. Defaults to `"info"` (or the variant helper you called). */
	variant?: Variant;
	/** Override the variant's glyph, or `false` for no icon. */
	icon?: string | false;
	/**
	 * Milliseconds on screen once shown. `0` or `Infinity` makes the toast sticky.
	 * Defaults to the provider's `duration`, lengthened for `warning`/`error` so a
	 * problem outlives a confirmation.
	 */
	duration?: number;
	/**
	 * Milliseconds to wait before showing it at all. The countdown starts when the
	 * toast appears, not when it was raised.
	 */
	delay?: number;
	/** Screen anchor. Defaults to the provider's `position`. */
	position?: ToastPosition;
	/** Whether the user can click it away. Defaults to the provider's setting. */
	dismissible?: boolean;
	/** Draw a meter of the remaining time to live. Sticky toasts never show one. */
	progress?: boolean;
	/** Show a spinner instead of the icon. Implies sticky unless `duration` is set. */
	loading?: boolean;
	/** An action offered alongside the message (click, or `action.key`). */
	action?: ToastAction;
	/** Card width in cells. Defaults to the provider's `width`. */
	width?: number;
	/** Called once when the toast goes away, with the reason. */
	onDismiss?: (reason: ToastDismissReason) => void;
}

/** What {@link ToastApi.promise} shows at each stage of the awaited work. */
export interface ToastPromiseMessages<T> {
	/** Shown while the promise is pending (as a `loading` toast). */
	loading: string;
	/** Shown on resolve — a string, or built from the resolved value. */
	success: string | ((value: T) => string);
	/** Shown on reject — a string, or built from the error. */
	error: string | ((error: unknown) => string);
	/** Extra options applied to all three stages (position, width, …). */
	options?: Omit<ToastOptions, "title" | "variant" | "loading">;
}

/** The toast API handed to pages by {@link useToast}. */
export interface ToastApi {
	/** Raise a toast from a message, or from a full options object. */
	show: {
		(message: string, options?: ToastOptions): ToastId;
		(options: ToastOptions & { title: string }): ToastId;
	};
	/** Raise an `info` toast. */
	info: (message: string, options?: ToastOptions) => ToastId;
	/** Raise a `success` toast. */
	success: (message: string, options?: ToastOptions) => ToastId;
	/** Raise a `warning` toast. */
	warning: (message: string, options?: ToastOptions) => ToastId;
	/** Raise an `error` toast. */
	error: (message: string, options?: ToastOptions) => ToastId;
	/** Raise a sticky spinner toast; update or dismiss it by its returned id. */
	loading: (message: string, options?: ToastOptions) => ToastId;
	/**
	 * Patch a live toast. Any timing field (`duration`, `loading`) restarts its
	 * countdown, so promoting a `loading` toast to a `success` one gives the
	 * result a full time to live.
	 */
	update: (id: ToastId, patch: ToastOptions) => void;
	/** Dismiss one toast. No-op if it has already gone. */
	dismiss: (id: ToastId) => void;
	/** Dismiss every toast, or every toast at one position. */
	dismissAll: (position?: ToastPosition) => void;
	/**
	 * Bind a toast to a promise: a spinner while it is pending, then a success or
	 * error toast. Returns the original promise, so it stays awaitable — and
	 * rejections still reject, they are only *reported* here.
	 */
	promise: <T>(work: Promise<T>, messages: ToastPromiseMessages<T>) => Promise<T>;
}

/** A toast plus the scheduling state the provider tracks for it. */
interface ToastRecord extends ToastOptions {
	id: ToastId;
	title: string;
	variant: Variant;
	position: ToastPosition;
	duration: number;
	/** False while the `delay` has not elapsed — the card is not rendered yet. */
	ready: boolean;
	/** Monotonic sequence number: creation order within a position. */
	seq: number;
}

/** The live countdown for one visible toast, kept in a ref (never rendered from). */
interface Countdown {
	timer: ReturnType<typeof setTimeout>;
	/** Wall-clock ms at which the toast expires, when running. */
	expiresAt: number;
	/** Milliseconds left, recorded while paused. */
	remaining: number;
	paused: boolean;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);

/** Default time to live per variant — a problem should outlive a confirmation. */
function defaultDuration(variant: Variant, base: number): number {
	if (variant === "error") return base * 2;
	if (variant === "warning") return base * 1.5;
	return base;
}

/** How often the meter/spinner repaints while any toast needs animation. */
const TICK_MS = 100;

/** Props for {@link ToastProvider}. */
export interface ToastProviderProps {
	children: ReactNode;
	/** Default screen anchor for toasts that don't name one. Defaults to `"bottom-right"`. */
	position?: ToastPosition;
	/** Default time to live in ms (scaled per variant). Defaults to 4000. */
	duration?: number;
	/** How many toasts show at once *per position*; the rest queue. Defaults to 3. */
	maxVisible?: number;
	/** Default card width in cells. Defaults to the card's own default (42). */
	width?: number;
	/** Cells of clearance between the stacks and the screen edges. Defaults to 1. */
	margin?: number;
	/** Whether toasts are click-dismissible by default. Defaults to true. */
	dismissible?: boolean;
	/** Whether toasts show a time-to-live meter by default. Defaults to false. */
	progress?: boolean;
}

/**
 * Own the toast queue and render the anchored stacks. Mount once, at the **root**
 * of the tree (`App.tsx`), so the stacks are positioned against the screen and
 * every page — wizard included — can raise a toast.
 *
 * Mount it *below* `InputCaptureProvider`: that is what lets a toast action key
 * stand down while a text field is being typed into.
 */
export function ToastProvider({
	children,
	position = "bottom-right",
	duration = 4000,
	maxVisible = 3,
	width,
	margin = 0,
	dismissible = true,
	progress = false,
}: ToastProviderProps) {
	const [toasts, setToasts] = useState<ToastRecord[]>([]);
	// Bumped by the animation ticker to repaint spinners and meters. The countdowns
	// themselves live in refs, so a tick is the only thing that re-reads them.
	const [tick, setTick] = useState(0);

	const seq = useRef(0);
	const delayTimers = useRef(new Map<ToastId, ReturnType<typeof setTimeout>>());
	const countdowns = useRef(new Map<ToastId, Countdown>());
	// Ids already dismissed this frame — see `remove`. Only the newest handful can
	// still matter (the dedupe window is a single frame), so it is bounded, not
	// grown forever.
	const removed = useRef(new Set<ToastId>());
	// The list, readable from callbacks and timers without stale-closure risk.
	const latest = useRef<ToastRecord[]>([]);
	latest.current = toasts;

	const captured = useKeysCaptured();

	/** Drop a toast, clear its timers, and tell the caller why. */
	const remove = useCallback((id: ToastId, reason: ToastDismissReason) => {
		// A toast can be dismissed twice in the same frame (its countdown fires as
		// the user clicks it), and `latest` only refreshes on the next render — so
		// dedupe here rather than firing `onDismiss` twice.
		if (removed.current.has(id)) return;
		const dismissed = latest.current.find((t) => t.id === id);
		if (!dismissed) return;
		removed.current.add(id);
		if (removed.current.size > 64) {
			removed.current.clear();
			removed.current.add(id);
		}

		const delayTimer = delayTimers.current.get(id);
		if (delayTimer) {
			clearTimeout(delayTimer);
			delayTimers.current.delete(id);
		}
		const countdown = countdowns.current.get(id);
		if (countdown) {
			clearTimeout(countdown.timer);
			countdowns.current.delete(id);
		}

		setToasts((current) => current.filter((t) => t.id !== id));
		// Deliberately after the state update: the callback may raise another toast.
		queueMicrotask(() => dismissed.onDismiss?.(reason));
	}, []);

	/** Build a record from options, filling in provider and variant defaults. */
	const record = useCallback(
		(options: ToastOptions & { title: string }, id: ToastId): ToastRecord => {
			const variant = options.variant ?? "info";
			// A loading toast has no natural end, so it is sticky until updated.
			const ttl =
				options.duration ??
				(options.loading ? 0 : defaultDuration(variant, duration));
			return {
				...options,
				id,
				variant,
				position: options.position ?? position,
				duration: ttl,
				dismissible: options.dismissible ?? dismissible,
				progress: options.progress ?? progress,
				width: options.width ?? width,
				ready: (options.delay ?? 0) <= 0,
				seq: seq.current++,
			};
		},
		[dismissible, duration, position, progress, width],
	);

	/** Schedule the `delay` before a toast becomes visible. */
	const scheduleDelay = useCallback((entry: ToastRecord) => {
		const delay = entry.delay ?? 0;
		if (delay <= 0) return;
		const timer = setTimeout(() => {
			delayTimers.current.delete(entry.id);
			setToasts((current) =>
				current.map((t) => (t.id === entry.id ? { ...t, ready: true } : t)),
			);
		}, delay);
		delayTimers.current.set(entry.id, timer);
	}, []);

	const show = useCallback(
		(first: string | (ToastOptions & { title: string }), second?: ToastOptions) => {
			const options: ToastOptions & { title: string } =
				typeof first === "string" ? { ...second, title: first } : first;
			const id = options.id ?? `toast-${seq.current}-${Date.now()}`;
			const entry = record(options, id);
			// A caller-supplied id may be one we dismissed earlier; it is live again.
			removed.current.delete(id);

			setToasts((current) => {
				const existing = current.findIndex((t) => t.id === id);
				if (existing === -1) return [...current, entry];
				// Re-raising a live id updates it in place, keeping its slot in the
				// stack rather than stacking a duplicate.
				const previous = current[existing] as ToastRecord;
				const next = [...current];
				next[existing] = { ...entry, seq: previous.seq, ready: entry.ready };
				return next;
			});
			// Any restart clears the old countdown; the reconciler starts a fresh one.
			const running = countdowns.current.get(id);
			if (running) {
				clearTimeout(running.timer);
				countdowns.current.delete(id);
			}
			scheduleDelay(entry);
			return id;
		},
		[record, scheduleDelay],
	) as ToastApi["show"];

	const update = useCallback(
		(id: ToastId, patch: ToastOptions) => {
			const current = latest.current.find((t) => t.id === id);
			if (!current) return;
			// Re-raise through `show` so the patch goes through the same defaulting
			// and timer-restart path as a fresh toast.
			const merged: ToastOptions & { title: string } = {
				...current,
				...patch,
				// `loading` is the field a promise toast flips; an explicit patch of a
				// timed variant must not inherit the spinner's stickiness.
				duration: patch.duration ?? (patch.loading === false ? undefined : current.duration),
				id,
				title: patch.title ?? current.title,
				delay: 0,
			};
			show(merged);
		},
		[show],
	);

	const dismiss = useCallback(
		(id: ToastId) => remove(id, "programmatic"),
		[remove],
	);

	const dismissAll = useCallback(
		(where?: ToastPosition) => {
			for (const entry of latest.current) {
				if (where && entry.position !== where) continue;
				remove(entry.id, "programmatic");
			}
		},
		[remove],
	);

	const promise = useCallback(
		<T,>(work: Promise<T>, messages: ToastPromiseMessages<T>): Promise<T> => {
			const id = show({
				...messages.options,
				title: messages.loading,
				variant: "info",
				loading: true,
			});
			work.then(
				(value) =>
					update(id, {
						title:
							typeof messages.success === "function"
								? messages.success(value)
								: messages.success,
						variant: "success",
						loading: false,
					}),
				(err: unknown) =>
					update(id, {
						title:
							typeof messages.error === "function" ? messages.error(err) : messages.error,
						variant: "error",
						loading: false,
					}),
			);
			// The caller's promise is returned untouched — reporting a rejection here
			// must not swallow it.
			return work;
		},
		[show, update],
	);

	const api = useMemo<ToastApi>(() => {
		const raise =
			(variant: Variant, extra?: ToastOptions) =>
			(message: string, options?: ToastOptions) =>
				show({ variant, ...extra, ...options, title: message });
		return {
			show,
			info: raise("info"),
			success: raise("success"),
			warning: raise("warning"),
			error: raise("error"),
			loading: raise("info", { loading: true }),
			update,
			dismiss,
			dismissAll,
			promise,
		};
	}, [show, update, dismiss, dismissAll, promise]);

	// Which toasts are actually on screen: per position, the first `maxVisible`
	// that have passed their delay. Newest sits nearest the anchored edge.
	const visible = useMemo(() => {
		const byPosition = new Map<ToastPosition, ToastRecord[]>();
		for (const entry of toasts) {
			if (!entry.ready) continue;
			const list = byPosition.get(entry.position);
			if (list) list.push(entry);
			else byPosition.set(entry.position, [entry]);
		}
		for (const [where, list] of byPosition) {
			// Oldest first, and the overflow *waits* rather than being dropped: a
			// burst of five toasts must not lose two of them unseen. The queued ones
			// have no countdown until they reach the screen (see the reconciler).
			list.sort((a, b) => a.seq - b.seq);
			byPosition.set(where, list.slice(0, maxVisible));
		}
		return byPosition;
	}, [toasts, maxVisible]);

	// Reconcile the countdowns with what is on screen: start one for every visible,
	// non-sticky toast that lacks one, and drop any belonging to a toast that has
	// left the screen (dismissed, or pushed back into the queue). A queued toast
	// deliberately has no countdown — its time to live starts when it is seen.
	useEffect(() => {
		const onScreen = new Set<ToastId>();
		for (const list of visible.values()) for (const entry of list) onScreen.add(entry.id);

		for (const [id, countdown] of countdowns.current) {
			if (onScreen.has(id)) continue;
			clearTimeout(countdown.timer);
			countdowns.current.delete(id);
		}

		for (const list of visible.values()) {
			for (const entry of list) {
				if (!Number.isFinite(entry.duration) || entry.duration <= 0) continue;
				if (countdowns.current.has(entry.id)) continue;
				const timer = setTimeout(() => remove(entry.id, "timeout"), entry.duration);
				countdowns.current.set(entry.id, {
					timer,
					expiresAt: Date.now() + entry.duration,
					remaining: entry.duration,
					paused: false,
				});
			}
		}
	}, [visible, remove]);

	// Clear every outstanding timer on unmount so a torn-down tree can't fire into
	// dead state.
	useEffect(() => {
		const delays = delayTimers.current;
		const running = countdowns.current;
		return () => {
			for (const timer of delays.values()) clearTimeout(timer);
			for (const countdown of running.values()) clearTimeout(countdown.timer);
			delays.clear();
			running.clear();
		};
	}, []);

	/** Freeze a toast's countdown while the pointer rests on it. */
	const pause = useCallback((id: ToastId) => {
		const countdown = countdowns.current.get(id);
		if (!countdown || countdown.paused) return;
		clearTimeout(countdown.timer);
		countdown.paused = true;
		countdown.remaining = Math.max(0, countdown.expiresAt - Date.now());
	}, []);

	/** Resume a paused countdown from exactly where it stopped. */
	const resume = useCallback(
		(id: ToastId) => {
			const countdown = countdowns.current.get(id);
			if (!countdown?.paused) return;
			countdown.paused = false;
			countdown.expiresAt = Date.now() + countdown.remaining;
			countdown.timer = setTimeout(() => remove(id, "timeout"), countdown.remaining);
		},
		[remove],
	);

	/** Run a toast's action, then close it — the action *is* the dismissal. */
	const runAction = useCallback(
		(id: ToastId) => {
			const entry = latest.current.find((t) => t.id === id);
			if (!entry?.action) return;
			entry.action.onAction();
			remove(id, "action");
		},
		[remove],
	);

	// A toast's action key. Plain characters belong to a focused text field first,
	// so the binding stands down while an input capture is held. Newest toast wins
	// when two bind the same key.
	useKeyboard((key) => {
		if (captured()) return;
		for (const list of visible.values()) {
			for (let i = list.length - 1; i >= 0; i--) {
				const entry = list[i] as ToastRecord;
				if (entry.action?.key && entry.action.key === key.name) {
					runAction(entry.id);
					return;
				}
			}
		}
	});

	// Animate only while something on screen needs it: a spinner, or a meter.
	const animating = useMemo(() => {
		for (const list of visible.values()) {
			for (const entry of list) {
				if (entry.loading) return true;
				if (entry.progress && Number.isFinite(entry.duration) && entry.duration > 0) return true;
			}
		}
		return false;
	}, [visible]);

	useEffect(() => {
		if (!animating) return;
		const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
		return () => clearInterval(timer);
	}, [animating]);

	const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];

	/** Project a record onto what the card draws, reading the live countdown. */
	const toVisual = (entry: ToastRecord): ToastVisual => {
		let remaining: number | undefined;
		if (entry.progress && Number.isFinite(entry.duration) && entry.duration > 0) {
			const countdown = countdowns.current.get(entry.id);
			const left = countdown
				? countdown.paused
					? countdown.remaining
					: Math.max(0, countdown.expiresAt - Date.now())
				: entry.duration;
			remaining = left / entry.duration;
		}
		return {
			id: entry.id,
			title: entry.title,
			description: entry.description,
			variant: entry.variant,
			icon: entry.icon,
			loading: entry.loading,
			dismissible: entry.dismissible,
			action: entry.action,
			width: entry.width,
			remaining,
		};
	};

	return (
		<ToastContext.Provider value={api}>
			{children}
			{TOAST_POSITIONS.map((where) => {
				const list = visible.get(where);
				if (!list || list.length === 0) return null;
				// Toasts grow away from their anchored edge, so the newest is always
				// closest to it: last for a bottom stack, first for a top one.
				const ordered = where.startsWith("top") ? [...list].reverse() : list;
				return (
					<ToastViewport
						key={where}
						position={where}
						toasts={ordered.map(toVisual)}
						margin={margin}
						spinner={spinner}
						onDismiss={(id) => remove(id, "user")}
						onAction={runAction}
						onPause={pause}
						onResume={resume}
					/>
				);
			})}
		</ToastContext.Provider>
	);
}

/**
 * The toast API for the current tree.
 *
 * @throws {Error} when used outside a {@link ToastProvider} — a silently
 * swallowed notification is worse than a loud wiring mistake.
 */
export function useToast(): ToastApi {
	const ctx = useContext(ToastContext);
	if (!ctx) throw new Error("useToast must be used within a ToastProvider");
	return ctx;
}
