import { useRenderer } from "@opentui/react";

// Returns a function that exits the app cleanly. `process.exit` on its own
// leaves the terminal in OpenTUI's alternate-screen + raw mode, which corrupts
// the user's shell; destroying the renderer first restores the terminal state.
// It also fires before React can run unmount cleanups, so any process-wide side
// effect (e.g. the public listener) must be torn down here explicitly.
export function useQuit(): () => void {
  const renderer = useRenderer();
  return () => {
    // Release the public port before exiting — `process.exit` below pre-empts
    // React's unmount cleanup, so the proxy's own teardown never gets to run.
    renderer.destroy();
    process.exit(0);
  };
}
