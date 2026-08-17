/**
 * Server — the detail page for one server, addressed by the router's `serverId`
 * param and re-derived live via {@link useServer} + {@link useServerInsight}.
 *
 * **A tabbed multi-screen page.** One server carries far more than a screen of
 * information, and the tabs (`tabs.ts`) split it by the question being asked:
 * Overview / Console / Players / World / Content / Backups / Performance /
 * Network / Settings. This container owns everything the tabs share — the
 * identity header, the lifecycle action bar, the tab bar, the focus ring and the
 * delete confirmation — and each tab under `tabs/` renders one screen from the
 * `server` + `insight` + `size` it is handed. Adding a screen is one row in
 * `SERVER_TABS`, one file, and one `case` below (the union makes a missing case
 * a type error).
 *
 * Page-layer (AGENTS.md § 3): renders view models and calls `RuntimeManager` /
 * `ServerManager` through {@link useMctl}; no I/O of its own. The buttons are
 * exactly the CLI's `start`/`stop`/`restart`/`delete`, calling the same services
 * — the two front-ends are projections of one core.
 *
 * **The page owns its scrolling** (its route is in `OWN_SCROLL`): the header,
 * action bar and tab bar are pinned chrome, and only the active tab's body
 * scrolls. The Console tab is hosted without a scrollbox because it already
 * pins a command line under a scrolling pane of its own — never nest one page
 * scrollbox inside another.
 *
 * **Delete is guarded by a two-step confirmation**, and even then only removes
 * the registry entry: erasing worlds from a TUI keystroke is not something MCTL
 * offers, and `mctl delete --files --yes` is the deliberate, explicit path
 * (AGENTS.md § Secrets and user data).
 */

import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useServer } from "../../hooks/use-servers.ts";
import { useServerInsight } from "../../hooks/use-server-insights.ts";
import { useRouter } from "../../hooks/use-router.tsx";
import { useFocusRing, type FocusItem } from "../../hooks/use-focus-ring.ts";
import { useMctl } from "../../hooks/use-mctl.tsx";
import { useToast } from "../../hooks/use-toast.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import { useHints } from "../../hooks/use-hints.tsx";
import { Button, Dialog, ScrollBox } from "../../components/index.ts";
import { Tabs } from "../../components/Tabs.tsx";
import { PageHeader, serverStateColor, serverStateIcon } from "../shared.tsx";
import { DEFAULT_SERVER_TAB, SERVER_TABS, type ServerTabId } from "./tabs.ts";
import type { ServerSettingsFormState, ServerTabProps } from "./panels.tsx";
import { OverviewTab } from "./tabs/Overview.tsx";
import { ConsoleTab } from "./tabs/Console.tsx";
import { PlayersTab } from "./tabs/Players.tsx";
import { WorldTab } from "./tabs/World.tsx";
import { ContentTab } from "./tabs/Content.tsx";
import { BackupsTab } from "./tabs/Backups.tsx";
import { PerformanceTab } from "./tabs/Performance.tsx";
import { NETWORK_APPLY_ID, NetworkTab } from "./tabs/Network.tsx";
import { SettingsTab, serverSettingsRingIds } from "./tabs/Settings.tsx";

/** Which lifecycle action is currently in flight, for the button labels. */
type Pending = "start" | "stop" | "restart" | undefined;

/** Ring id of the tab bar. Always first, so ←/→ switch tabs on arrival. */
const TABS_ID = "__tabs";

/** Ring id of the Console tab's command line. */
const CONSOLE_ID = "__console";

/**
 * Ring id of the Players tab's card grid. Like the console's command line, it
 * joins the ring only while its tab is active — so ←/→ still reach the tab bar
 * whenever the grid does not hold the focus.
 */
const PLAYERS_ID = "__players";

/**
 * Tabs that manage their own vertical scrolling and are therefore hosted in a
 * plain box — the same rule the shell applies to pages (`OWN_SCROLL` in
 * `Router.tsx`), for the same reason: an inner scrollbox needs a definite
 * height, which a surrounding scrollbox cannot give it.
 */
const TAB_OWNS_SCROLL: ReadonlySet<ServerTabId> = new Set<ServerTabId>([
	"console",
	"players",
]);

export function ServerDetail() {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { params, navigate } = useRouter();
	const toast = useToast();
	const { context } = useMctl();
	const id = params.serverId ?? "";
	const { data: server, loading, refresh } = useServer(id);
	const { insight, size } = useServerInsight(server);
	const [tab, setTab] = useState<ServerTabId>(DEFAULT_SERVER_TAB);
	const [pending, setPending] = useState<Pending>();
	const [confirmDelete, setConfirmDelete] = useState(false);
	// The Settings tab's form state (dirty, and whether its conditional Java field
	// is on screen). It reaches the container because the container owns the ring
	// — see `ServerTabProps.onFormState`.
	const [settingsForm, setSettingsForm] = useState<ServerSettingsFormState>({
		dirty: false,
		javaPinned: false,
	});
	// A tab can raise a modal of its own (the Players tab's action menu). While one
	// is up it owns the keyboard, so this page's ring stands down — see `onModal`
	// on `ServerTabProps`.
	const [tabModal, setTabModal] = useState(false);

	// The tab bar and the action buttons only honour keys while `focused`, so the
	// page owns a ring over them — without it both would be mouse-only, which is
	// not acceptable in a terminal UI. The ring's membership follows the *probed*
	// state (Stop+Restart vs Start) and the active tab (the console adds its
	// command line); `useFocusRing` clamps its index, so a set that changes under
	// it — a server stopped by another instance — is safe.
	//
	// Each action carries the same `disabled` condition as its Button, so Tab
	// steps over a button that would ignore Enter: while an action is in flight
	// every lifecycle button is inert, Start is unusable on a server whose
	// directory is missing, and Remove is refused while the server runs.
	const running = server?.state === "running";
	const busy = pending !== undefined;
	const actions: FocusItem[] = running
		? [
				{ id: "stop", disabled: busy },
				{ id: "restart", disabled: busy },
			]
		: [{ id: "start", disabled: busy || server?.available === false }];
	const ring = useFocusRing(
		[
			TABS_ID,
			...actions,
			{ id: "remove", disabled: running },
			...(tab === "console" ? [CONSOLE_ID] : []),
			// The Content tab is deliberately absent: its rows are checkboxes with no
			// caret to move, so it answers no keys and a ring stop there would be a
			// Tab that lands on nothing.
			...(tab === "players" ? [PLAYERS_ID] : []),
			// The Settings tab is a form: its fields join *this* ring rather than
			// opening one of their own, because only one ring may listen at a time.
			...(tab === "settings" ? serverSettingsRingIds(settingsForm) : []),
			// The Network tab's one action. Disabled exactly as its button is —
			// re-applying a profile needs a running server.
			...(tab === "network"
				? [{ id: NETWORK_APPLY_ID, disabled: !running }]
				: []),
		],
		// A modal takes the keyboard while it is up: with both rings listening, one
		// Tab would move the page's focus *behind* the dialog.
		{ enabled: !confirmDelete && !tabModal },
	);

	// The dialog's own ring, live only while the dialog is. Without it the two
	// buttons on a destructive confirmation would be mouse-only — the one place in
	// the app where that is least acceptable.
	const confirmRing = useFocusRing(["confirm-cancel", "confirm-remove"], {
		enabled: confirmDelete,
	});

	// Hints follow the ring, not the page: while the Console tab's command line
	// holds the focus, ←/→ belong to the text field rather than the tab bar and
	// Enter sends a command instead of pressing a button, so the page advertises a
	// different set. Both are registered unconditionally with an `active` flag —
	// hooks cannot live behind the early returns below.
	const onConsole = tab === "console" && ring.isFocused(CONSOLE_ID);
	// A modal replaces the page's keys with its own (the shell contributes those),
	// so the page's set stands down for as long as one is up.
	const modal = confirmDelete || tabModal;
	useHints(
		[
			{ keys: "Tab", label: "next control" },
			{ keys: [icons.arrowLeft, icons.arrowRight], label: "switch tab" },
			{ keys: "Enter", label: "activate" },
		],
		{ active: !onConsole && !modal },
	);
	useHints(
		[
			{ keys: "Enter", label: "send command" },
			{ keys: "Tab", label: "leave console" },
		],
		{ scope: "context", active: onConsole && !modal },
	);

	/**
	 * Run a lifecycle action, reporting the outcome as a toast.
	 *
	 * The view model is *not* patched optimistically: the action publishes a
	 * `ServerStateChanged` event and `useServer` re-reads from disk, so what the
	 * page shows is always a live probe rather than what it hoped would happen.
	 */
	const act = async (action: Exclude<Pending, undefined>) => {
		if (!context || pending) return;
		setPending(action);
		try {
			if (action === "start") await context.runtime.start(id);
			else if (action === "stop") await context.runtime.stop(id);
			else await context.runtime.restart(id);
			toast.success(`${id} ${action === "stop" ? "stopped" : "started"}`);
		} catch (err) {
			toast.error(`Could not ${action} ${id}`, {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setPending(undefined);
			refresh();
		}
	};

	const remove = async () => {
		if (!context) return;
		setConfirmDelete(false);
		try {
			// Tear the networking down first: a `direct` endpoint descriptor outlives
			// a stop, and one left behind would keep describing a server that is gone.
			if (server) await context.network.teardown(server);
			await context.servers.deleteServer(id);
			toast.success(`Removed ${id}`, {
				description: "Its directory and worlds were left untouched.",
			});
			navigate("dashboard");
		} catch (err) {
			toast.error(`Could not remove ${id}`, {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	};

	if (loading) {
		return (
			<box flexDirection="column" flexGrow={1} paddingX={1}>
				<PageHeader title={id} subtitle="reading…" />
			</box>
		);
	}

	if (!server) {
		return (
			<box flexDirection="column" flexGrow={1} paddingX={1}>
				<PageHeader title={id} subtitle="not found" />
				<text fg={colors.muted}>
					No server with id <span fg={colors.error}>{id}</span>. Press{" "}
					<span fg={colors.info}>Esc</span> to go back.
				</text>
			</box>
		);
	}

	const tabProps: ServerTabProps = { server, insight, size };
	const body = (() => {
		switch (tab) {
			case "overview":
				return <OverviewTab {...tabProps} />;
			case "console":
				return (
					<ConsoleTab
						{...tabProps}
						focused={ring.isFocused(CONSOLE_ID)}
						onFocused={() => ring.setFocus(CONSOLE_ID)}
					/>
				);
			case "players":
				return (
					<PlayersTab
						{...tabProps}
						focused={ring.isFocused(PLAYERS_ID)}
						onModal={setTabModal}
					/>
				);
			case "world":
				return <WorldTab {...tabProps} />;
			case "content":
				return <ContentTab {...tabProps} />;
			case "backups":
				return <BackupsTab {...tabProps} />;
			case "performance":
				return <PerformanceTab {...tabProps} />;
			case "network":
				return <NetworkTab {...tabProps} focus={ring} />;
			case "settings":
				return (
					<SettingsTab
						{...tabProps}
						focus={ring}
						onFormState={setSettingsForm}
						onRefresh={refresh}
					/>
				);
		}
	})();

	return (
		<box flexDirection="column" flexGrow={1} paddingX={0}>
			{/* Identity + lifecycle, pinned above the tabs: which server this is and
			    what it is doing must not scroll away, and the actions belong to the
			    whole page rather than to any one tab. */}
			{/* `flexShrink={0}` on both pinned rows is load-bearing, not decoration:
			    the tab body below them is `flexGrow`, so on a short terminal yoga
			    shrinks whatever it may — and a 1-row action bar shrinks to *nothing*,
			    silently removing the lifecycle buttons at small sizes. */}
			<box
				flexDirection="row"
				justifyContent="space-between"
				alignItems="center"
				flexShrink={0}
				border={["bottom"]}
				borderColor={colors.border}
			>
				<box
					flexDirection="row"
					gap={2}
					alignItems="center"
					paddingX={1}
					flexShrink={0}
				>
					<text fg={colors.foreground} attributes={TextAttributes.BOLD}>
						{server.name}
					</text>
					<text fg={serverStateColor(colors, server.state)}>
						{icons[serverStateIcon(server.state)]} {server.state}
					</text>
					<text fg={colors.muted}>
						{server.kind} {server.minecraftVersion}
						{server.loaderVersion ? ` · ${server.loaderVersion}` : ""}
					</text>
				</box>

				{/* Action bar. Which of start/stop is offered follows the *probed* state,
			    so a server another instance started shows "Stop" here without a
			    refresh keystroke. */}
				<box flexDirection="row" paddingX={1} flexShrink={0}>
					{server.state === "running" ? (
						<>
							<Button
								size="small"
								kind="ghost"
								variant="error"
								disabled={busy}
								focused={ring.isFocused("stop")}
								onFocused={() => ring.setFocus("stop")}
								onClick={() => void act("stop")}
							>
								{pending === "stop" ? "Stopping…" : "Stop"}
							</Button>
							<Button
								size="small"
								kind="ghost"
								variant="warning"
								disabled={busy}
								focused={ring.isFocused("restart")}
								onFocused={() => ring.setFocus("restart")}
								onClick={() => void act("restart")}
							>
								{pending === "restart" ? "Restarting…" : "Restart"}
							</Button>
						</>
					) : (
						<Button
							size="small"
							kind="ghost"
							variant="success"
							disabled={busy || !server.available}
							focused={ring.isFocused("start")}
							onFocused={() => ring.setFocus("start")}
							onClick={() => void act("start")}
						>
							{pending === "start" ? "Starting…" : "Start"}
						</Button>
					)}
					<Button
						size="small"
						kind="ghost"
						variant="neutral"
						disabled={running}
						focused={ring.isFocused("remove")}
						onFocused={() => ring.setFocus("remove")}
						onClick={() => {
							// Always open the confirmation on Cancel, never on the
							// previous choice.
							confirmRing.setFocus("confirm-cancel");
							setConfirmDelete(true);
						}}
					>
						Remove
					</Button>
				</box>
			</box>

			<Tabs
				items={SERVER_TABS.map((entry) => ({
					id: entry.id,
					label: entry.label,
				}))}
				activeId={tab}
				onChange={(next) => setTab(next as ServerTabId)}
				focused={ring.isFocused(TABS_ID)}
				onFocused={() => ring.setFocus(TABS_ID)}
				// initials={server.id}
				paddingX={1}
			/>

			{/* `key={tab}` remounts the body on a switch, so each tab starts at the
			    top of its own scroll rather than inheriting the previous tab's
			    offset. */}
			{TAB_OWNS_SCROLL.has(tab) ? (
				<box key={tab} flexGrow={1} flexDirection="column">
					{body}
				</box>
			) : (
				<ScrollBox key={tab} flexGrow={1} enableAccel>
					{body}
				</ScrollBox>
			)}

			<Dialog
				open={confirmDelete}
				title="Remove server"
				onClose={() => setConfirmDelete(false)}
			>
				<box flexDirection="column" gap={1}>
					<text fg={colors.foreground}>
						Remove <span fg={colors.primary}>{server.id}</span> from MCTL?
					</text>
					{/* Said plainly, because "delete" in most tools means the files go
					    too. Erasing worlds is `mctl delete --files --yes` only. */}
					<text fg={colors.muted}>
						Its directory and worlds stay on disk at {server.path}. Only the
						registry entry is removed.
					</text>
					{/* Cancel is first in the ring, so the key that lands on arrival is the
					    harmless one — a destructive confirmation must not open with the
					    destructive button under Enter. */}
					<box flexDirection="row" gap={1}>
						<Button
							size="small"
							kind="ghost"
							variant="neutral"
							focused={confirmRing.isFocused("confirm-cancel")}
							onFocused={() => confirmRing.setFocus("confirm-cancel")}
							onClick={() => setConfirmDelete(false)}
						>
							Cancel
						</Button>
						<Button
							size="small"
							kind="solid"
							variant="error"
							focused={confirmRing.isFocused("confirm-remove")}
							onFocused={() => confirmRing.setFocus("confirm-remove")}
							onClick={() => void remove()}
						>
							Remove
						</Button>
					</box>
				</box>
			</Dialog>
		</box>
	);
}
