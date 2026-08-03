/**
 * Server — the detail page for one server, addressed by the router's `serverId`
 * param and re-derived live via {@link useServer} + {@link useServerInsight}. It
 * owns the lifecycle actions (start, stop, restart, console, delete) and is the
 * **exhaustive** view of a server: everything MCTL can learn about it without
 * asking the user for credentials.
 *
 * Page-layer (AGENTS.md § 3): renders view models and calls `RuntimeManager` /
 * `ServerManager` through {@link useMctl}; no I/O of its own. The buttons are
 * exactly the CLI's `start`/`stop`/`restart`/`delete`, calling the same services
 * — the two front-ends are projections of one core.
 *
 * **Why the detail lives here and not on the Dashboard.** The dashboard answers
 * "what is happening across the fleet" and has one row per server to say it in;
 * this page has the whole screen, so it carries the long tail — every
 * `server.properties` rule, the player rosters, the mod counts, the join
 * address, the on-disk footprint.
 *
 * **Delete is guarded by a two-step confirmation**, and even then only removes
 * the registry entry: erasing worlds from a TUI keystroke is not something MCTL
 * offers, and `mctl delete --files --yes` is the deliberate, explicit path
 * (AGENTS.md § Secrets and user data).
 */

import { useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useServer } from "../../hooks/use-servers.ts";
import { useServerInsight } from "../../hooks/use-server-insights.ts";
import { useRouter } from "../../hooks/use-router.tsx";
import { useFocusRing } from "../../hooks/use-focus-ring.ts";
import { useMctl } from "../../hooks/use-mctl.tsx";
import { useToast } from "../../hooks/use-toast.tsx";
import type { Server } from "../../types/server.ts";
import type { ServerInsight, ServerSize } from "../../core/server/inspect.ts";
import { useIcons } from "../../hooks/use-icons.tsx";
import { Button, Dialog, Hint, ProgressBar } from "../../components/index.ts";
import {
	formatBytes,
	formatDuration,
	parseMemorySize,
} from "../../lib/format.ts";
import {
	PageHeader,
	serverStateColor,
	serverStateIcon,
	uptimeOf,
	yesNo,
} from "../shared.tsx";

/** Terminal width at or above which the panels sit in two columns. */
const TWO_COLUMN_WIDTH = 96;

/** Label column width inside a panel, so every row's values line up. */
const LABEL_WIDTH = 13;

/** A `label: value` detail row. */
function Detail({
	label,
	value,
	color,
}: {
	label: string;
	value: string;
	color?: string;
}) {
	const { colors } = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={colors.muted}>{label.padEnd(LABEL_WIDTH)}</text>
			<text fg={color ?? colors.foreground}>{value}</text>
		</box>
	);
}

/** A bordered, titled section of the page. */
function Panel({
	title,
	accent,
	children,
}: {
	title: string;
	accent?: string;
	children: ReactNode;
}) {
	const { colors } = useTheme();
	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor={colors.border}
			title={` ${title} `}
			titleColor={accent ?? colors.secondary}
			paddingX={1}
			marginBottom={1}
			flexGrow={1}
		>
			{children}
		</box>
	);
}

/**
 * A metered row: a label, a bar, and a readout. Used where a number only means
 * something against a ceiling — players against slots, memory against the heap
 * the JVM was given.
 */
function Meter({
	label,
	value,
	max,
	readout,
	variant,
}: {
	label: string;
	value: number;
	max: number;
	readout: string;
	variant: "primary" | "success" | "info" | "warning";
}) {
	const { colors } = useTheme();
	return (
		<box flexDirection="row" gap={1} alignItems="center">
			<text fg={colors.muted}>{label.padEnd(LABEL_WIDTH)}</text>
			<ProgressBar
				value={max > 0 ? Math.min(value, max) : 0}
				max={max > 0 ? max : 1}
				width={18}
				style="smooth"
				variant={variant}
				readout="none"
			/>
			<text fg={colors.foreground}>{readout}</text>
		</box>
	);
}

/** Human-readable Java field. */
function javaLabel(server: Server, empty: string): string {
	if (server.java === undefined) return empty;
	return typeof server.java === "number"
		? String(server.java)
		: `${server.java.pinned} (pinned)`;
}

/** Which lifecycle action is currently in flight, for the button labels. */
type Pending = "start" | "stop" | "restart" | undefined;

/** Live status: where it is, how long it has been there, what it answers. */
function StatusPanel({
	server,
	insight,
}: {
	server: Server;
	insight?: ServerInsight;
}) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const empty = icons.emptyValue;
	const uptime = uptimeOf(server);
	return (
		<Panel title="Status" accent={serverStateColor(colors, server.state)}>
			<Detail
				label="state"
				value={`${icons[serverStateIcon(server.state)]} ${server.state}`}
				color={serverStateColor(colors, server.state)}
			/>
			<Detail
				label="uptime"
				value={uptime === undefined ? empty : formatDuration(uptime)}
			/>
			<Detail
				label="pid"
				value={server.session ? String(server.session.pid) : empty}
			/>
			<Detail
				label="started"
				value={server.session?.startedAt ?? empty}
			/>
			<Detail
				label="join address"
				value={insight?.address.joinAddress ?? empty}
			/>
			<Detail
				label="bind"
				value={
					insight?.address.bindIp
						? insight.address.bindIp
						: "all interfaces"
				}
			/>
			<Detail label="port" value={String(insight?.address.port ?? empty)} />
			<Detail
				label="responding"
				value={
					insight?.status
						? `yes (${insight.status.latencyMs} ms)`
						: server.state === "running"
							? "not yet"
							: empty
				}
			/>
			<Detail
				label="advertises"
				value={insight?.status?.versionName ?? empty}
			/>
		</Panel>
	);
}

/** CPU, memory and threads of the server process. */
function ResourcesPanel({
	server,
	insight,
}: {
	server: Server;
	insight?: ServerInsight;
}) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const empty = icons.emptyValue;
	const usage = insight?.usage;
	const heapBytes = parseMemorySize(server.memory);

	return (
		<Panel title="Resources">
			{usage ? (
				<>
					<Meter
						label="cpu"
						value={usage.cpuPercent}
						max={100 * usage.cores}
						readout={`${Math.round(usage.cpuPercent)}% of ${usage.cores} cores`}
						variant="info"
					/>
					<Meter
						label="memory"
						value={usage.rssBytes}
						max={heapBytes ?? usage.rssBytes}
						readout={
							heapBytes
								? `${formatBytes(usage.rssBytes)} / ${server.memory} heap`
								: formatBytes(usage.rssBytes)
						}
						variant="primary"
					/>
					<Detail
						label="threads"
						value={usage.threads === undefined ? empty : String(usage.threads)}
					/>
					<Detail
						label="of machine"
						value={`${usage.memoryPercent.toFixed(1)}% of system memory`}
					/>
				</>
			) : (
				<text fg={colors.muted}>
					No process to sample — the server is not running.
				</text>
			)}
			<Detail label="heap" value={server.memory} />
			<Detail label="java" value={javaLabel(server, empty)} />
			{/* Said out loud rather than left as a mysterious gap: these are the
			    numbers people expect next to CPU, and none of them can be read from
			    outside the JVM. TPS/MSPT need an RCON `/tps` (Phase 4/5) or a mod,
			    and heap *occupancy* needs JMX. */}
			<Detail
				label="tps / mspt"
				value="needs RCON — not available yet"
				color={colors.muted}
			/>
		</Panel>
	);
}

/** Who is online now, and who the server knows about. */
function PlayersPanel({ insight }: { insight?: ServerInsight }) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const empty = icons.emptyValue;
	const status = insight?.status;
	const max = status?.playersMax ?? insight?.properties?.maxPlayers ?? 0;
	const content = insight?.content ?? {};

	return (
		<Panel title="Players">
			<Meter
				label="online"
				value={status?.playersOnline ?? 0}
				max={max}
				readout={`${status ? status.playersOnline : empty} / ${max || empty}`}
				variant="success"
			/>
			{status && status.sample.length > 0 ? (
				<Detail
					label="here now"
					value={status.sample.map((p) => p.name).join(", ")}
					color={colors.success}
				/>
			) : null}
			{status && status.playersOnline > status.sample.length ? (
				<text fg={colors.muted}>
					{" "}
					The server sends only a sample of names, not the whole list.
				</text>
			) : null}
			<Detail
				label="known"
				value={
					content.knownPlayers === undefined
						? empty
						: `${content.knownPlayers} (recent)`
				}
			/>
			<Detail
				label="operators"
				value={content.ops === undefined ? empty : String(content.ops)}
			/>
			<Detail
				label="whitelisted"
				value={
					content.whitelisted === undefined
						? empty
						: `${content.whitelisted} (${
								insight?.properties?.whitelist ? "enforced" : "not enforced"
							})`
				}
			/>
			<Detail
				label="banned"
				value={content.banned === undefined ? empty : String(content.banned)}
			/>
		</Panel>
	);
}

/** Everything `server.properties` says about how the world plays. */
function WorldPanel({ insight }: { insight?: ServerInsight }) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const empty = icons.emptyValue;
	const properties = insight?.properties;

	if (!properties) {
		return (
			<Panel title="World & rules">
				<text fg={colors.muted}>
					No server.properties yet — Minecraft writes it on the first run.
				</text>
			</Panel>
		);
	}

	return (
		<Panel title="World & rules">
			<Detail label="motd" value={insight?.status?.motd || properties.motd} />
			<Detail label="level" value={properties.levelName} />
			<Detail label="generator" value={properties.levelType} />
			<Detail
				label="seed"
				value={properties.levelSeed === "" ? "random" : properties.levelSeed}
			/>
			<Detail
				label="difficulty"
				value={
					properties.hardcore
						? `${properties.difficulty} (hardcore)`
						: properties.difficulty
				}
				color={properties.hardcore ? colors.error : undefined}
			/>
			<Detail label="gamemode" value={properties.gamemode} />
			<Detail label="pvp" value={yesNo(properties.pvp, empty)} />
			<Detail
				label="online mode"
				value={
					properties.onlineMode ? "yes" : "no (unauthenticated players allowed)"
				}
				color={properties.onlineMode ? undefined : colors.warning}
			/>
			<Detail label="whitelist" value={yesNo(properties.whitelist, empty)} />
			<Detail
				label="distances"
				value={`view ${properties.viewDistance} · sim ${properties.simulationDistance}`}
			/>
			<Detail
				label="spawn guard"
				value={`${properties.spawnProtection} blocks`}
			/>
			<Detail label="flight" value={yesNo(properties.allowFlight, empty)} />
			<Detail label="nether" value={yesNo(properties.allowNether, empty)} />
			<Detail
				label="command blk"
				value={yesNo(properties.commandBlocks, empty)}
			/>
			<Detail
				label="rcon"
				value={
					properties.rconEnabled
						? `enabled on ${properties.rconPort}`
						: "disabled"
				}
			/>
			<Detail label="query" value={yesNo(properties.queryEnabled, empty)} />
		</Panel>
	);
}

/** What the server directory holds and how much room it takes. */
function StoragePanel({
	insight,
	size,
}: {
	insight?: ServerInsight;
	size?: ServerSize;
}) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const empty = icons.emptyValue;
	const content = insight?.content ?? {};
	const measuring = `measuring${icons.ellipsis}`;

	return (
		<Panel title="Storage & content">
			<Detail
				label="total"
				value={
					size
						? `${size.truncated ? "≥ " : ""}${formatBytes(size.totalBytes)}`
						: measuring
				}
			/>
			<Detail
				label="world"
				value={size ? formatBytes(size.worldBytes) : measuring}
			/>
			<Detail
				label="files"
				value={size ? String(size.files) : measuring}
				color={colors.muted}
			/>
			<Detail
				label="mods"
				value={content.mods === undefined ? empty : String(content.mods)}
			/>
			<Detail
				label="plugins"
				value={content.plugins === undefined ? empty : String(content.plugins)}
			/>
			<Detail
				label="datapacks"
				value={
					content.datapacks === undefined ? empty : String(content.datapacks)
				}
			/>
		</Panel>
	);
}

/** The `mctl.json` side: what MCTL itself was told about this server. */
function ConfigurationPanel({ server }: { server: Server }) {
	const { icons } = useIcons();
	const empty = icons.emptyValue;
	return (
		<Panel title="Configuration">
			<Detail label="id" value={server.id} />
			<Detail label="name" value={server.name} />
			<Detail label="kind" value={server.kind} />
			<Detail label="minecraft" value={server.minecraftVersion} />
			<Detail label="loader" value={server.loaderVersion ?? empty} />
			<Detail label="runtime" value={server.runtime} />
			<Detail label="network" value={server.network} />
			<Detail label="path" value={server.path} />
		</Panel>
	);
}

export function ServerDetail() {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { params, navigate } = useRouter();
	const { width: terminalWidth } = useTerminalDimensions();
	const toast = useToast();
	const { context } = useMctl();
	const id = params.serverId ?? "";
	const { data: server, loading, refresh } = useServer(id);
	const { insight, size } = useServerInsight(server);
	const [pending, setPending] = useState<Pending>();
	const [confirmDelete, setConfirmDelete] = useState(false);

	// The action bar's buttons only honour Enter/Space while `focused`, so the page
	// owns a ring over them — without it the actions would be mouse-only, which is
	// not acceptable in a terminal UI. The ring's membership follows the *probed*
	// state, because that is what decides whether Stop+Restart or Start is on
	// screen; `useFocusRing` clamps its index, so the set changing under it (a
	// server stopping in another instance) is safe.
	const actions =
		server?.state === "running"
			? ["stop", "restart", "console", "remove"]
			: ["start", "console", "remove"];
	const ring = useFocusRing(actions);

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
			<box flexDirection="column" flexGrow={1}>
				<PageHeader title={id} subtitle="reading…" />
			</box>
		);
	}

	if (!server) {
		return (
			<box flexDirection="column" flexGrow={1}>
				<PageHeader title={id} subtitle="not found" />
				<text fg={colors.muted}>
					No server with id <span fg={colors.error}>{id}</span>. Press{" "}
					<span fg={colors.info}>Esc</span> to go back.
				</text>
			</box>
		);
	}

	// Two columns when the terminal can carry them, one when it cannot. The
	// panels are grouped by how they are read, not by size: the live picture on
	// the left, the durable configuration on the right.
	const wide = terminalWidth >= TWO_COLUMN_WIDTH;
	const left = (
		<>
			<StatusPanel server={server} insight={insight} />
			<ResourcesPanel server={server} insight={insight} />
			<PlayersPanel insight={insight} />
		</>
	);
	const right = (
		<>
			<WorldPanel insight={insight} />
			<StoragePanel insight={insight} size={size} />
			<ConfigurationPanel server={server} />
		</>
	);

	return (
		<box flexDirection="column" flexGrow={1} paddingX={1}>
			<box flexDirection="row" gap={2} alignItems="center">
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
			<box flexDirection="row" gap={1} marginBottom={1}>
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
					variant="info"
					focused={ring.isFocused("console")}
					onFocused={() => ring.setFocus("console")}
					onClick={() => navigate("console", { serverId: server.id })}
				>
					Console
				</Button>
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

			{wide ? (
				<box flexDirection="row" gap={1} alignItems="flex-start">
					<box flexDirection="column" flexGrow={1} flexBasis={0}>
						{left}
					</box>
					<box flexDirection="column" flexGrow={1} flexBasis={0}>
						{right}
					</box>
				</box>
			) : (
				<box flexDirection="column">
					{left}
					{right}
				</box>
			)}

			<box marginTop={1}>
				<Hint
					items={[
						{ keys: "Tab", label: "next action" },
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
