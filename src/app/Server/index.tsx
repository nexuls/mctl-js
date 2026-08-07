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
import { useFocusRing } from "../../hooks/use-focus-ring.ts";
import { useMctl } from "../../hooks/use-mctl.tsx";
import { useToast } from "../../hooks/use-toast.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import { Button, Dialog, Hint, ScrollBox } from "../../components/index.ts";
import { Tabs } from "../../components/Tabs.tsx";
import { PageHeader, serverStateColor, serverStateIcon } from "../shared.tsx";
import {
	DEFAULT_SERVER_TAB,
	SERVER_TABS,
	serverTab,
	type ServerTabId,
} from "./tabs.ts";
import type { ServerTabProps } from "./panels.tsx";
import { OverviewTab } from "./tabs/Overview.tsx";
import { ConsoleTab } from "./tabs/Console.tsx";
import { PlayersTab } from "./tabs/Players.tsx";
import { WorldTab } from "./tabs/World.tsx";
import { ContentTab } from "./tabs/Content.tsx";
import { BackupsTab } from "./tabs/Backups.tsx";
import { PerformanceTab } from "./tabs/Performance.tsx";
import { NetworkTab } from "./tabs/Network.tsx";
import { SettingsTab } from "./tabs/Settings.tsx";

/** Which lifecycle action is currently in flight, for the button labels. */
type Pending = "start" | "stop" | "restart" | undefined;

/** Ring id of the tab bar. Always first, so ←/→ switch tabs on arrival. */
const TABS_ID = "__tabs";

/** Ring id of the Console tab's command line. */
const CONSOLE_ID = "__console";

/**
 * Tabs that manage their own vertical scrolling and are therefore hosted in a
 * plain box — the same rule the shell applies to pages (`OWN_SCROLL` in
 * `Router.tsx`), for the same reason: an inner scrollbox needs a definite
 * height, which a surrounding scrollbox cannot give it.
 */
const TAB_OWNS_SCROLL: ReadonlySet<ServerTabId> = new Set<ServerTabId>([
	"console",
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

	// The tab bar and the action buttons only honour keys while `focused`, so the
	// page owns a ring over them — without it both would be mouse-only, which is
	// not acceptable in a terminal UI. The ring's membership follows the *probed*
	// state (Stop+Restart vs Start) and the active tab (the console adds its
	// command line); `useFocusRing` clamps its index, so a set that changes under
	// it — a server stopped by another instance — is safe.
	const actions =
		server?.state === "running"
			? ["stop", "restart", "remove"]
			: ["start", "remove"];
	const ring = useFocusRing([
		TABS_ID,
		...actions,
		...(tab === "console" ? [CONSOLE_ID] : []),
	]);

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
				return <PlayersTab {...tabProps} />;
			case "world":
				return <WorldTab {...tabProps} />;
			case "content":
				return <ContentTab {...tabProps} />;
			case "backups":
				return <BackupsTab {...tabProps} />;
			case "performance":
				return <PerformanceTab {...tabProps} />;
			case "network":
				return <NetworkTab {...tabProps} />;
			case "settings":
				return <SettingsTab {...tabProps} />;
		}
	})();

	return (
		<box flexDirection="column" flexGrow={1}>
			{/* Identity + lifecycle, pinned above the tabs: which server this is and
			    what it is doing must not scroll away, and the actions belong to the
			    whole page rather than to any one tab. */}
			{/* `flexShrink={0}` on both pinned rows is load-bearing, not decoration:
			    the tab body below them is `flexGrow`, so on a short terminal yoga
			    shrinks whatever it may — and a 1-row action bar shrinks to *nothing*,
			    silently removing the lifecycle buttons at small sizes. */}
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
			<box flexDirection="row" gap={1} paddingX={1} flexShrink={0}>
				{server.state === "running" ? (
					<>
						<Button
							size="small"
							kind="ghost"
							variant="error"
							disabled={pending !== undefined}
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
							disabled={pending !== undefined}
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
						disabled={pending !== undefined || !server.available}
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
					disabled={server.state === "running"}
					focused={ring.isFocused("remove")}
					onFocused={() => ring.setFocus("remove")}
					onClick={() => setConfirmDelete(true)}
				>
					Remove
				</Button>
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
				initials={server.id}
				paddingX={1}
			/>

			<box paddingX={1} flexShrink={0}>
				<text fg={colors.muted}>{serverTab(tab).description}</text>
			</box>

			{/* `key={tab}` remounts the body on a switch, so each tab starts at the
			    top of its own scroll rather than inheriting the previous tab's
			    offset. */}
			{TAB_OWNS_SCROLL.has(tab) ? (
				<box key={tab} flexGrow={1} flexDirection="column" paddingX={1}>
					{body}
				</box>
			) : (
				<ScrollBox key={tab} flexGrow={1} paddingX={1}>
					{body}
				</ScrollBox>
			)}

			<box paddingX={1} flexShrink={0}>
				<Hint
					items={[
						{ keys: "Tab", label: "next control" },
						{ keys: [icons.arrowLeft, icons.arrowRight], label: "switch tab" },
						{ keys: "Enter", label: "activate" },
						{ keys: "Esc", label: "back" },
					]}
				/>
			</box>

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
					<box flexDirection="row" gap={1}>
						<Button
							size="small"
							kind="solid"
							variant="error"
							onClick={() => void remove()}
						>
							Remove
						</Button>
						<Button
							size="small"
							kind="ghost"
							variant="neutral"
							onClick={() => setConfirmDelete(false)}
						>
							Cancel
						</Button>
					</box>
				</box>
			</Dialog>
		</box>
	);
}
