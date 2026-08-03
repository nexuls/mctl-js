/**
 * useMctl — the TUI's single bridge to the mutating core services
 * (`ServerManager`, `RuntimeManager`, `JobScheduler`).
 *
 * UI-layer hook (AGENTS.md § 3): pages call this instead of importing a manager,
 * and never touch the filesystem or a provider themselves. It is the exact peer
 * of `cli/context.ts` — both build the same {@link MctlContext}, which is what
 * keeps the two front-ends from drifting.
 *
 * **Why the context is built here and not in `renderApp()`.** It needs
 * `config.json`, which does not exist during the first-run wizard. So the
 * provider builds it *after* mount, exposes `undefined` until it resolves, and
 * rebuilds on `ConfigChanged` — which is also what makes a relocated
 * `servers_dir` take effect without a restart. The provider registry itself is
 * built once in `renderApp()` and injected, so `hooks/` never imports a concrete
 * provider either.
 */

import {
	createContext as createReactContext,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react";
import { createContext, type MctlContext } from "../core/context.ts";
import type { ProviderRegistry } from "../core/registry/provider-registry.ts";
import { EventType } from "../types/events.ts";
import { useEventBus } from "./use-event-bus.tsx";

/** What {@link useMctl} exposes. */
export interface MctlState {
	/** The wired core services, or `undefined` until the first build resolves. */
	context?: MctlContext;
	/** A message when the context could not be built (unreadable config). */
	error?: string;
}

const Ctx = createReactContext<MctlState | undefined>(undefined);

/** Props for {@link MctlProvider}. */
interface MctlProviderProps {
	/** Built once in `renderApp()` by `providers/index.ts`. */
	providers: ProviderRegistry;
	children: ReactNode;
}

/**
 * Build and hold the core context for the app tree, rebuilding it whenever
 * `config.json` changes.
 */
export function MctlProvider({ providers, children }: MctlProviderProps) {
	const bus = useEventBus();
	const [state, setState] = useState<MctlState>({});

	useEffect(() => {
		let mounted = true;
		const build = async () => {
			try {
				const context = await createContext(providers, bus);
				if (mounted) setState({ context });
			} catch (err) {
				// No config yet (the wizard is still running) is the common case here,
				// and is not an error the user should see — the pages that need the
				// context are not reachable until setup completes.
				if (mounted) {
					setState({ error: err instanceof Error ? err.message : String(err) });
				}
			}
		};
		void build();
		const unsubscribe = bus.subscribe((event) => {
			if (event.type === EventType.ConfigChanged) void build();
		});
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, [bus, providers]);

	return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/**
 * The core services for the current config.
 *
 * Deliberately **does not throw** outside a provider or before config loads: it
 * returns `{ context: undefined }` so a page can render its own "still loading"
 * or "run setup first" state. Every caller must handle the undefined case, which
 * is honest — during the first-run wizard there genuinely is no context.
 */
export function useMctl(): MctlState {
	return useContext(Ctx) ?? {};
}
