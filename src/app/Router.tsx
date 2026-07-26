/**
 * Router — the app shell that renders the active screen. It composes the top bar,
 * the persistent {@link NavRail}, the current page, and the bottom hint strip,
 * and owns the global keyboard: digit shortcuts jump between routes, `Esc` steps
 * back (or quits at the root), `q` quits, `t` cycles themes.
 *
 * Page-layer (AGENTS.md § 3): it renders view models and navigates; all data
 * comes from hooks. It is the single place that maps a {@link RouteId} to a page
 * component, so adding a screen is one map entry plus a {@link NAV} row.
 *
 * **Character-shortcut safety:** digits, `q`, and `t` are plain characters, so
 * they are only safe as global shortcuts while nothing on screen is being typed
 * into. A page with a live text field holds an *input capture* (see
 * `hooks/use-input-capture.tsx`) and the shell stands its character shortcuts
 * down for as long as it is held — typing `2` in the Settings form edits the
 * field instead of navigating to Servers. `Esc` is exempt: it is the universal
 * "get me out of here" key and never inserts a character.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import { useTheme } from "../hooks/use-theme.tsx";
import { useQuit } from "../hooks/use-quit.ts";
import { RouterProvider, useRouter } from "../hooks/use-router.tsx";
import {
	InputCaptureProvider,
	useIsCapturing,
	useKeysCaptured,
} from "../hooks/use-input-capture.tsx";
import { Hint } from "../components/index.ts";
import { NAV, type RouteId } from "./routes.ts";
import { NavRail } from "./NavRail.tsx";
import { Dashboard } from "./Dashboard/index.tsx";
import { Servers } from "./Servers/index.tsx";
import { ServerDetail } from "./Server/index.tsx";
import { Jobs } from "./Jobs/index.tsx";
import { Backups } from "./Backups/index.tsx";
import { Network } from "./Network/index.tsx";
import { Settings } from "./Settings/index.tsx";
import { alpha } from "../lib/colors.ts";

/** The active page component for a route. */
function Page({ route }: { route: RouteId }) {
	switch (route) {
		case "dashboard":
			return <Dashboard />;
		case "servers":
			return <Servers />;
		case "server":
			return <ServerDetail />;
		case "jobs":
			return <Jobs />;
		case "backups":
			return <Backups />;
		case "network":
			return <Network />;
		case "settings":
			return <Settings />;
	}
}

/** The chrome + page host, inside the {@link RouterProvider}. */
function AppShell() {
	const renderer = useRenderer();
	const quit = useQuit();
	const { theme, colors: c, setThemeId, themes } = useTheme();
	const { route, navigate, back, canBack } = useRouter();
	// `captured()` is a getter, not a boolean: the handler below closes over this
	// render, and the capture can change without one. `typing` is the reactive
	// mirror, used only to relabel the hint strip.
	const captured = useKeysCaptured();
	const typing = useIsCapturing();

	useKeyboard((key) => {
		// Esc first: it works even while a text field is capturing, because it can
		// never be part of what the user is typing.
		if (key.name === "escape") {
			// Esc steps back through the history, and quits from the root.
			if (canBack) back();
			else quit();
			return;
		}
		// Every shortcut below is a plain character, so it belongs to the focused
		// text field (if any) rather than to the shell.
		if (captured()) return;

		const navItem = NAV.find((n) => n.digit === key.name);
		if (navItem) {
			navigate(navItem.id);
			return;
		}
		if (key.name === "q") {
			quit();
		} else if (key.name === "t") {
			const idx = themes.findIndex((t) => t.id === theme.id);
			const next = themes[(idx + 1) % themes.length];
			if (next) setThemeId(next.id);
		}
	});

	// Toggle the debug console with Ctrl+` (kept from the shell it replaces).
	useKeyboard((key) => {
		if (key.ctrl && key.name === "`") renderer.console.toggle();
	});

	// Paint "transparent" for the live terminal theme so a terminal colour-scheme
	// change shows through instantly instead of flashing the last derived hex; a
	// static theme keeps its opaque background. (See App.tsx for the full rationale.)
	const pageBackground =
		theme.source === "terminal" ? "transparent" : c.background;

	return (
		<box flexGrow={1} flexDirection="column" backgroundColor={pageBackground}>
			{/* Body: the framed shell — nav bar + active page. The screen name rides
			    the top border and the brand the bottom one, so neither costs a row. */}
			<box
				flexDirection="column"
				flexGrow={1}
				border
				borderStyle="rounded"
				borderColor={c.border}
				focusedBorderColor={c.border}
				title={` ${titleFor(route)} `}
				titleAlignment="right"
				titleColor={c.primary}
			>
				<NavRail active={route} onNavigate={navigate} />
				<scrollbox
					flexGrow={1}
					flexDirection="row"
					padding={1}
					scrollbarOptions={{
						trackOptions: {
							backgroundColor: c.surface,
							foregroundColor: alpha(c.muted, 0.4),
						},
					}}
				>
					<Page route={route} />
				</scrollbox>
			</box>

			{/* Bottom hint strip. While a field is capturing keys the shell's
			    character shortcuts are inactive, so it advertises the keys that
			    still work instead of ones that would silently do nothing. */}
			<box paddingX={1} flexShrink={0}>
				<Hint
					items={
						typing
							? [
									{ keys: "Tab", label: "next field" },
									{ keys: "Enter", label: "confirm" },
									{ keys: "Esc", label: canBack ? "back" : "quit" },
								]
							: [
									{ keys: ["1", "…", "6"], label: "navigate" },
									{ keys: "Enter", label: "open" },
									{ keys: "Esc", label: canBack ? "back" : "quit" },
									{ keys: "t", label: "theme" },
									{ keys: "q", label: "quit" },
								]
					}
				/>
			</box>
		</box>
	);
}

/** The human title for a route (the detail page shows the parent's name). */
function titleFor(route: RouteId): string {
	if (route === "server") return "Server";
	return NAV.find((n) => n.id === route)?.label ?? "";
}

/**
 * The router entry point mounted by {@link "./App".App} once setup is complete.
 * Wraps the shell in the {@link RouterProvider} so every page can navigate.
 */
export function AppRouter() {
	return (
		<RouterProvider initialRoute="dashboard">
			{/* Above the shell so the shell can read the capture its pages set. */}
			<InputCaptureProvider>
				<AppShell />
			</InputCaptureProvider>
		</RouterProvider>
	);
}
