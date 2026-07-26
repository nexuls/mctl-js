/**
 * useConfig — the live, validated `config.json` as render state, refreshed when
 * a `ConfigChanged` event fires (a write by this instance or an edit/`mctl init`
 * by another). Statelessness in the UI: the config is re-read from disk on
 * change, never held as authoritative.
 *
 * UI-layer hook: calls the `loadConfig` core service and subscribes to the bus.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadConfig } from "../core/config/index.ts";
import type { Config } from "../types/config.ts";
import { useEventBus } from "./use-event-bus.tsx";

/** Reactive config load result. */
export interface ConfigResult {
  /** The validated config, or `undefined` before the first load / on error. */
  config: Config | undefined;
  /** True until the first load resolves. */
  loading: boolean;
  /** A message when the load failed, else undefined. */
  error?: string;
}

/** Load `config.json` and keep it current across `ConfigChanged` events. */
export function useConfig(): ConfigResult {
  const bus = useEventBus();
  const [config, setConfig] = useState<Config>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const loaded = await loadConfig();
      if (!mounted.current) return;
      setConfig(loaded);
      setError(undefined);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === "ConfigChanged") void refresh();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [bus, refresh]);

  return { config, loading, error };
}
