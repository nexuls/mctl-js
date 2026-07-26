/**
 * useInputCapture — the "a text field is being typed into" guard.
 *
 * The app shell owns single-key global shortcuts (digits jump between routes,
 * `q` quits, `t` cycles themes). Those are only safe while nothing on screen is
 * consuming plain characters: typing `2` into the Settings form's *Memory* field
 * must edit the field, not navigate to Servers.
 *
 * OpenTUI delivers every key to every mounted `useKeyboard` handler, so there is
 * no built-in notion of "an input has focus" for the shell to consult. This is
 * that notion: a page with a live text input calls {@link useCaptureKeys} while
 * one is focused, and the shell asks {@link useKeysCaptured} before acting on a
 * character shortcut.
 *
 * Capture is a **count**, not a flag, so overlapping owners (a page plus a modal)
 * release independently and the shell only frees its shortcuts when the last one
 * lets go.
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

/** The capture API shared through context. */
interface InputCapture {
  /** Take a capture; call the returned function to release it. */
  acquire: () => () => void;
  /**
   * Whether any capture is currently held, read at call time. A getter (not a
   * boolean) because keyboard handlers close over their render's values — the
   * shell must see the *current* state, not the one from when it subscribed.
   */
  isCaptured: () => boolean;
  /** Reactive mirror of {@link isCaptured}, for rendering (e.g. the hint strip). */
  captured: boolean;
}

const InputCaptureContext = createContext<InputCapture | undefined>(undefined);

/**
 * Provide the capture count to the tree. Mount this above both the shell (which
 * reads the guard) and the pages (which set it).
 */
export function InputCaptureProvider({ children }: { children: ReactNode }) {
  const [captured, setCaptured] = useState(false);
  // The count is a ref so `acquire`/release never depend on render timing, and
  // `isCaptured` reports the truth even between renders.
  const count = useRef(0);

  const acquire = useCallback(() => {
    count.current += 1;
    if (count.current === 1) setCaptured(true);
    let released = false;
    return () => {
      if (released) return; // a double release must not unbalance the count
      released = true;
      count.current = Math.max(0, count.current - 1);
      if (count.current === 0) setCaptured(false);
    };
  }, []);

  const value = useMemo<InputCapture>(
    () => ({ acquire, isCaptured: () => count.current > 0, captured }),
    [acquire, captured],
  );

  return (
    <InputCaptureContext.Provider value={value}>
      {children}
    </InputCaptureContext.Provider>
  );
}

/** The context, or a no-op capture when no provider is mounted (e.g. the wizard). */
function useCapture(): InputCapture {
  const ctx = useContext(InputCaptureContext);
  return (
    ctx ?? {
      acquire: () => () => {},
      isCaptured: () => false,
      captured: false,
    }
  );
}

/**
 * Hold a capture while `active` is true — i.e. while this page's focus ring sits
 * on a text input. Released automatically on unmount, so navigating away can
 * never strand the shell's shortcuts.
 */
export function useCaptureKeys(active: boolean): void {
  const { acquire } = useCapture();
  useEffect(() => {
    if (!active) return;
    return acquire();
  }, [active, acquire]);
}

/**
 * Ask whether a text input is currently capturing keys. Returns a getter to call
 * *inside* a key handler; see {@link InputCapture.isCaptured} for why.
 */
export function useKeysCaptured(): () => boolean {
  return useCapture().isCaptured;
}

/** Reactive capture flag, for chrome that should look different while typing. */
export function useIsCapturing(): boolean {
  return useCapture().captured;
}
