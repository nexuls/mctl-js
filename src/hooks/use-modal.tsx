/**
 * useModal — the "a modal owns the keyboard" guard.
 *
 * The sibling of {@link "./use-input-capture".useCaptureKeys}, for the other
 * thing OpenTUI has no notion of: modality. Every mounted `useKeyboard` handler
 * receives every key, so a `Dialog` drawn *over* the page does not stop the page
 * — or the shell — from acting on the same keypress. Before this, one `Esc` in a
 * confirmation dialog both closed the dialog and quit the app, and a `5` typed
 * with a dialog open navigated to Settings behind it.
 *
 * Note the deliberate difference from the input capture: **`Esc` is not exempt
 * here.** A text field cannot consume `Esc`, so the shell keeps it while typing;
 * a modal exists precisely to consume it.
 *
 * {@link "../components/Dialog".Dialog} raises the signal itself, so every modal
 * in the app is covered without its caller remembering to. Like the capture it is
 * a **count**, so nested or overlapping modals release independently.
 *
 * UI-layer hook: React state only, no I/O, no domain knowledge.
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

/** The modal API shared through context. */
interface ModalGuard {
	/** Declare a modal open; call the returned function when it closes. */
	acquire: () => () => void;
	/**
	 * Whether any modal is open, read at call time. A getter (not a boolean)
	 * because keyboard handlers close over their render's values — the shell must
	 * see the *current* state, not the one from when it subscribed.
	 */
	isOpen: () => boolean;
	/** Reactive mirror of {@link isOpen}, for rendering (e.g. the hint strip). */
	open: boolean;
}

const ModalContext = createContext<ModalGuard | undefined>(undefined);

/**
 * Provide the modal count to the tree. Mount this above both the shell (which
 * reads the guard) and the pages (which raise it).
 */
export function ModalProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	// A ref, so `acquire`/release never depend on render timing and `isOpen`
	// reports the truth even between renders.
	const count = useRef(0);

	const acquire = useCallback(() => {
		count.current += 1;
		if (count.current === 1) setOpen(true);
		let released = false;
		return () => {
			if (released) return; // a double release must not unbalance the count
			released = true;
			count.current = Math.max(0, count.current - 1);
			if (count.current === 0) setOpen(false);
		};
	}, []);

	const value = useMemo<ModalGuard>(
		() => ({ acquire, isOpen: () => count.current > 0, open }),
		[acquire, open],
	);

	return (
		<ModalContext.Provider value={value}>{children}</ModalContext.Provider>
	);
}

/** The context, or an inert guard when no provider is mounted (e.g. the wizard). */
function useGuard(): ModalGuard {
	const ctx = useContext(ModalContext);
	return ctx ?? { acquire: () => () => {}, isOpen: () => false, open: false };
}

/**
 * Declare a modal open while `active` is true. Released automatically on
 * unmount, so a dialog whose page navigates away can never wedge the shell's
 * keyboard.
 */
export function useModalOpen(active: boolean): void {
	const { acquire } = useGuard();
	useEffect(() => {
		if (!active) return;
		return acquire();
	}, [active, acquire]);
}

/**
 * Ask whether a modal is currently open. Returns a getter to call *inside* a key
 * handler; see {@link ModalGuard.isOpen} for why.
 */
export function useModalsOpen(): () => boolean {
	return useGuard().isOpen;
}

/** Reactive modal flag, for chrome that must change while a modal is up. */
export function useIsModalOpen(): boolean {
	return useGuard().open;
}
