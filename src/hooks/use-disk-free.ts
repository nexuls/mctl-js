/**
 * useDiskFree — the free/total capacity of the filesystem a path lives on.
 *
 * The bridge between a page (which must not touch the filesystem, AGENTS.md § 3)
 * and {@link diskFree} in `lib/fs`. The first-run wizard uses it to show how much
 * space the chosen data root has available before the user commits to it.
 *
 * Re-queries whenever `path` changes, debounced so typing a path doesn't fire a
 * `statfs` per keystroke. Returns `undefined` while resolving or when the path is
 * not an absolute local path (nothing to measure yet).
 */

import { useEffect, useState } from "react";
import { diskFree, type DiskUsage } from "../lib/fs.ts";

/** Milliseconds to wait after the last `path` change before querying. */
const DEBOUNCE_MS = 150;

/**
 * Resolve the disk usage of the filesystem holding `path`.
 * @param path An absolute path (possibly not-yet-created); non-absolute values
 *   resolve to `undefined`.
 */
export function useDiskFree(path: string): DiskUsage | undefined {
  const [usage, setUsage] = useState<DiskUsage | undefined>(undefined);

  useEffect(() => {
    if (!path.startsWith("/")) {
      setUsage(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      diskFree(path)
        .then((u) => {
          if (!cancelled) setUsage(u);
        })
        .catch(() => {
          if (!cancelled) setUsage(undefined);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path]);

  return usage;
}
