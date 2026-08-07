/**
 * Dashboard — the landing screen and, since the Servers page was folded into it,
 * the app's single server list: a live summary across the top and a
 * width-responsive table of every server below it. The selected row expands in
 * place, so browsing the fleet never costs a navigation.
 *
 * Page-layer (AGENTS.md § 3): renders view models from hooks and navigates; it
 * does no I/O. Keyboard (↑/↓ or j/k to move, Enter to open, `c` console, `n` new)
 * is safe alongside the shell's digit nav because none of those keys overlap.
 *
 * **What lands here versus on the Server page.** This screen answers "what do I
 * have and what is it doing right now", so it carries the numbers that change:
 * state, players, CPU, memory, uptime, size. The exhaustive read — every
 * `server.properties` rule, the player rosters, the mod counts, the join address
 * — belongs to the detail page, which has the room to lay it out and is one
 * keystroke away. A dashboard that shows everything shows nothing.
 *
 * The page **owns its scrolling** (its route is in `OWN_SCROLL`): the summary
 * tiles and the column header stay pinned while only the rows scroll.
 */

import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useServers } from "../../hooks/use-servers.ts";
import { useServerInsights } from "../../hooks/use-server-insights.ts";
import { useRouter } from "../../hooks/use-router.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import type { Server } from "../../types/server.ts";
import type { ServerInsight, ServerSize } from "../../core/server/inspect.ts";
import { Table, type TableColumn } from "../../components/index.ts";
import { useHints } from "../../hooks/use-hints.tsx";
import { formatBytes, formatDuration } from "../../lib/format.ts";
import {
	cpuText,
	memoryText,
	playersText,
	serverStateColor,
	serverStateIcon,
	uptimeOf,
	yesNo,
} from "../shared.tsx";
import { alpha } from "../../lib/colors.ts";

/**
 * Terminal width below which the summary strip sheds its resource totals and
 * keeps only the three tiles that answer "what have I got and is it up".
 *
 * Set by what the *labels* need, not by a round number: below this the tiles are
 * narrow enough that "unavailable" wraps onto a second line and the whole strip
 * grows a row.
 */
const NARROW_WIDTH = 112;

/** Width below which the expanded row panel stacks its groups instead of columning them. */
const PANEL_STACK_WIDTH = 104;

/**
 * Width below which a tile's label must be short enough to fit a ~10-cell tile.
 * `unavailable` is one cell too long there and wraps, which grows the whole
 * strip by a row for one word.
 */
const SHORT_LABEL_WIDTH = 76;

/** One summary tile in the top strip. */
function StatTile({
	label,
	value,
	detail,
	color,
}: {
	label: string;
	value: string;
	detail?: string;
	color: string;
}) {
	const { colors } = useTheme();
	return (
		<box
			flexDirection="column"
			flexGrow={1}
			flexBasis={0}
			alignItems="center"
			paddingX={1}
			border
			borderStyle="rounded"
			borderColor={colors.border}
		>
			<text fg={color} attributes={TextAttributes.BOLD}>
				{value}
			</text>
			<text fg={colors.muted}>{label}</text>
			{detail ? <text fg={colors.muted}>{detail}</text> : null}
		</box>
	);
}

/** The fleet-wide totals shown in the tiles. */
interface Summary {
	total: number;
	running: number;
	stopped: number;
	unavailable: number;
	playersOnline: number;
	playersMax: number;
	cpuPercent: number;
	memoryBytes: number;
	diskBytes: number;
	/** True while at least one server's disk walk has not finished. */
	diskPartial: boolean;
}

/** Roll up states and live resource use across the whole fleet. */
function summarize(
	servers: Server[],
	insights: Record<string, ServerInsight>,
	sizes: Record<string, ServerSize>,
): Summary {
	const summary: Summary = {
		total: servers.length,
		running: 0,
		stopped: 0,
		unavailable: 0,
		playersOnline: 0,
		playersMax: 0,
		cpuPercent: 0,
		memoryBytes: 0,
		diskBytes: 0,
		diskPartial: false,
	};
	for (const server of servers) {
		if (server.state === "running") summary.running += 1;
		else if (server.state === "stopped") summary.stopped += 1;
		else if (server.state === "unavailable") summary.unavailable += 1;

		const insight = insights[server.id];
		// Only a *responding* server contributes slots: adding the configured cap
		// of every stopped server would report a fleet capacity nobody can join.
		if (insight?.status) {
			summary.playersOnline += insight.status.playersOnline;
			summary.playersMax += insight.status.playersMax;
		}
		if (insight?.usage) {
			summary.cpuPercent += insight.usage.cpuPercent;
			summary.memoryBytes += insight.usage.rssBytes;
		}
		const size = sizes[server.id];
		if (size) summary.diskBytes += size.totalBytes;
		else if (server.available) summary.diskPartial = true;
	}
	return summary;
}

/** A `label: value` row inside the expanded panel. */
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
			<text fg={colors.muted}>{label.padEnd(10)}</text>
			<text fg={color ?? colors.foreground}>{value}</text>
		</box>
	);
}

/**
 * A titled group of details inside the expanded panel.
 *
 * `columned` is load-bearing, not cosmetic: `flexGrow`/`flexBasis` share the
 * parent's **main axis**, so the same props that give three equal columns in a
 * row make three groups fight over the *height* of a column — which renders as
 * overlapping text, not as a tall panel.
 */
function DetailGroup({
	title,
	columned,
	children,
}: {
	title: string;
	columned: boolean;
	children: ReactNode;
}) {
	const { colors } = useTheme();
	return (
		<box
			flexDirection="column"
			flexGrow={columned ? 1 : 0}
			flexBasis={columned ? 0 : "auto"}
			marginBottom={columned ? 0 : 1}
		>
			<text fg={colors.secondary} attributes={TextAttributes.BOLD}>
				{title}
			</text>
			{children}
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

/**
 * The panel rendered directly beneath the selected row: the fields the table has
 * no column for, grouped so a glance finds the right one. Three groups when
 * there is room, stacked when there is not.
 */
function ServerDetails({
	server,
	insight,
	size,
	width,
}: {
	server: Server;
	insight?: ServerInsight;
	size?: ServerSize;
	width: number;
}) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const empty = icons.emptyValue;
	const properties = insight?.properties;
	const stacked = width < PANEL_STACK_WIDTH;

	return (
		<box
			flexDirection="column"
			marginLeft={2}
			padding={1}
			border={["left"]}
			borderColor={colors.primary}
			backgroundColor={alpha(colors.primary, 0.18)}
		>
			<box flexDirection={stacked ? "column" : "row"} gap={stacked ? 0 : 3}>
				<DetailGroup title="Server" columned={!stacked}>
					<Detail label="name" value={server.name} />
					<Detail label="loader" value={server.loaderVersion ?? empty} />
					<Detail label="java" value={javaLabel(server, empty)} />
					<Detail label="heap" value={server.memory} />
					<Detail label="runtime" value={server.runtime} />
				</DetailGroup>

				<DetailGroup title="World" columned={!stacked}>
					<Detail
						label="motd"
						value={insight?.status?.motd ?? properties?.motd ?? empty}
					/>
					<Detail label="mode" value={properties?.gamemode ?? empty} />
					<Detail label="difficulty" value={properties?.difficulty ?? empty} />
					<Detail label="pvp" value={yesNo(properties?.pvp, empty)} />
					<Detail label="content" value={contentLabel(insight, size, empty)} />
				</DetailGroup>

				<DetailGroup title="Live" columned={!stacked}>
					{server.session ? (
						<>
							<Detail label="pid" value={String(server.session.pid)} />
							<Detail
								label="threads"
								value={
									insight?.usage?.threads === undefined
										? empty
										: String(insight.usage.threads)
								}
							/>
							<Detail
								label="latency"
								value={
									insight?.status ? `${insight.status.latencyMs} ms` : empty
								}
							/>
							<Detail
								label="version"
								value={insight?.status?.versionName ?? empty}
							/>
							<Detail
								label="address"
								value={insight?.address.joinAddress ?? empty}
							/>
						</>
					) : (
						<text fg={colors.muted}>not running</text>
					)}
				</DetailGroup>
			</box>

			<box marginTop={1} flexDirection="column">
				<Detail label="path" value={server.path} />
				<text fg={colors.muted} alignSelf="flex-end">
					<span fg={colors.info}>Enter</span> full details {icons.separator}{" "}
					<span fg={colors.info}>c</span> console
				</text>
			</box>
		</box>
	);
}

/** "12 mods · 340 MB" — what the server directory holds, in one line. */
function contentLabel(
	insight: ServerInsight | undefined,
	size: ServerSize | undefined,
	empty: string,
): string {
	const parts: string[] = [];
	if (insight?.content.mods !== undefined) {
		parts.push(`${insight.content.mods} mods`);
	}
	if (insight?.content.plugins !== undefined) {
		parts.push(`${insight.content.plugins} plugins`);
	}
	if (size) parts.push(formatBytes(size.totalBytes));
	return parts.length === 0 ? empty : parts.join(" · ");
}

export function Dashboard() {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width: terminalWidth } = useTerminalDimensions();
	const { data: servers, loading } = useServers();
	const { insights, sizes } = useServerInsights(servers);
	const { navigate } = useRouter();
	const [selected, setSelected] = useState(0);
	const summary = summarize(servers, insights, sizes);
	const empty = icons.emptyValue;
	const narrow = terminalWidth < NARROW_WIDTH;

	// Keep the selection index valid as the (live) list grows or shrinks.
	useEffect(() => {
		if (selected >= servers.length && servers.length > 0) {
			setSelected(servers.length - 1);
		}
	}, [servers.length, selected]);

	const open = (server: Server) => navigate("server", { serverId: server.id });

	// The shell draws the strip; this page only says what its own keys do. `n` is
	// listed even with an empty list (it is how the first server gets made) while
	// the row keys are registered only once there is a row to act on.
	useHints(
		servers.length === 0
			? [{ keys: "n", label: "new server", when: "idle" }]
			: [
					{ keys: `${icons.arrowUp}${icons.arrowDown}/jk`, label: "move" },
					{ keys: "Enter", label: "details" },
					{ keys: "c", label: "console", when: "idle" },
					{ keys: "n", label: "new server", when: "idle" },
				],
	);

	useKeyboard((key) => {
		// `n` works with an empty list — it is how the first server gets made.
		if (key.name === "n") {
			navigate("create");
			return;
		}
		if (servers.length === 0) return;
		if (key.name === "c") {
			const server = servers[selected];
			if (server) navigate("console", { serverId: server.id });
			return;
		}
		if (key.name === "down" || key.name === "j") {
			setSelected((i) => Math.min(i + 1, servers.length - 1));
		} else if (key.name === "up" || key.name === "k") {
			setSelected((i) => Math.max(i - 1, 0));
		} else if (key.name === "return") {
			const server = servers[selected];
			if (server) open(server);
		}
	});

	/**
	 * The columns, most valuable first. `priority` is what survives a narrow
	 * terminal: identity and state are `required`, the live numbers outrank the
	 * static configuration, and the things also visible in the expanded panel
	 * (runtime, java) go first.
	 */
	const columns: TableColumn<Server>[] = [
		{
			id: "caret",
			header: " ",
			width: 1,
			required: true,
			render: (server) => ({
				text: servers[selected]?.id === server.id ? icons.caret : " ",
				fg: colors.primary,
			}),
		},
		{
			// Capped: without a ceiling the id absorbs every spare cell on a wide
			// terminal and the row reads as one name marooned in whitespace.
			id: "id",
			header: "id",
			min: 10,
			max: 24,
			flex: 1,
			required: true,
			render: (server) => ({
				text: server.id,
				fg:
					servers[selected]?.id === server.id
						? colors.primary
						: colors.foreground,
				attributes:
					servers[selected]?.id === server.id ? TextAttributes.BOLD : undefined,
			}),
		},
		{
			// 13 cells is exactly `⊘ unavailable`, the longest state label — a cell
			// narrower and the one state that most needs reading gets an ellipsis.
			id: "state",
			header: "state",
			width: 10,
			required: true,
			render: (server) => ({
				// State reads as shape *and* colour, so it survives a colour-blind eye.
				text: `${icons[serverStateIcon(server.state)]} ${server.state}`,
				fg: serverStateColor(colors, server.state),
			}),
		},
		{
			id: "players",
			header: "players",
			width: 7,
			priority: 90,
			align: "right",
			render: (server) => {
				const insight = insights[server.id];
				return {
					text: playersText(insight, empty),
					fg: insight?.status?.playersOnline ? colors.success : colors.muted,
				};
			},
		},
		{
			id: "cpu",
			header: "cpu",
			width: 5,
			priority: 85,
			align: "right",
			render: (server) => ({
				text: cpuText(insights[server.id]?.usage, empty),
				fg: colors.muted,
			}),
		},
		{
			id: "mem",
			header: "mem",
			width: 8,
			priority: 80,
			align: "right",
			render: (server) => ({
				text: memoryText(insights[server.id]?.usage, empty),
				fg: colors.muted,
			}),
		},
		{
			id: "uptime",
			header: "uptime",
			width: 8,
			priority: 75,
			align: "right",
			render: (server) => {
				const uptime = uptimeOf(server);
				return {
					text: uptime === undefined ? empty : formatDuration(uptime),
					fg: colors.muted,
				};
			},
		},
		{
			id: "kind",
			header: "kind",
			width: 8,
			priority: 70,
			render: (server) => ({ text: server.kind, fg: colors.muted }),
		},
		{
			id: "mc",
			header: "mc",
			width: 8,
			priority: 65,
			render: (server) => ({
				text: server.minecraftVersion,
				fg: colors.muted,
			}),
		},
		{
			id: "port",
			header: "port",
			width: 5,
			priority: 50,
			align: "right",
			render: (server) => {
				const port = insights[server.id]?.address.port;
				return { text: port ? String(port) : empty, fg: colors.muted };
			},
		},
		{
			id: "size",
			header: "size",
			width: 8,
			priority: 40,
			align: "right",
			render: (server) => {
				const size = sizes[server.id];
				return {
					text: size ? formatBytes(size.totalBytes) : empty,
					fg: colors.muted,
				};
			},
		},
		{
			id: "runtime",
			header: "runtime",
			width: 10,
			priority: 30,
			render: (server) => ({ text: server.runtime, fg: colors.muted }),
		},
		{
			id: "java",
			header: "java",
			width: 4,
			priority: 20,
			align: "right",
			render: (server) => ({
				text: javaLabel(server, empty).replace(" (pinned)", "*"),
				fg: colors.muted,
			}),
		},
	];

	return (
		<box flexDirection="column" flexGrow={1}>
			<box
				flexDirection="row"
				gap={1}
				marginBottom={1}
				flexShrink={0}
				paddingX={1}
			>
				<StatTile
					label="servers running"
					value={`${String(summary.running)}/${String(summary.total)}`}
					color={summary.running > 0 ? colors.success : colors.muted}
				/>
				<StatTile
					label="players"
					value={`${summary.playersOnline}/${summary.playersMax}`}
					color={summary.playersOnline > 0 ? colors.success : colors.muted}
				/>
				<StatTile
					label="cpu"
					value={`${Math.round(summary.cpuPercent)}%`}
					color={colors.info}
				/>
				{narrow ? null : (
					<>
						{/* A percentage of one core, as `top` reports it — a four-core
						    machine can legitimately read 400%. */}
						<StatTile
							label="memory"
							value={formatBytes(summary.memoryBytes)}
							color={colors.info}
						/>
						<StatTile
							label="on disk"
							value={`${summary.diskPartial ? icons.ellipsis : ""}${formatBytes(summary.diskBytes)}`}
							color={colors.secondary}
						/>
					</>
				)}
				{/* Shown only when it is non-zero: "unavailable: 0" is the normal
				    state of every fleet and costs a tile to say nothing. */}
				{summary.unavailable > 0 ? (
					<StatTile
						label={
							terminalWidth < SHORT_LABEL_WIDTH ? "missing" : "unavailable"
						}
						value={String(summary.unavailable)}
						color={colors.error}
					/>
				) : null}
			</box>

			<Table
				columns={columns}
				rows={servers}
				keyOf={(server) => server.id}
				gap={2}
				selectedKey={servers[selected]?.id}
				onSelect={(_, index) => setSelected(index)}
				onActivate={(server) => open(server)}
				scrollRows
				renderExpanded={(server, width) => (
					<ServerDetails
						server={server}
						insight={insights[server.id]}
						size={sizes[server.id]}
						width={width}
					/>
				)}
				empty={
					loading ? (
						<box paddingY={1}>
							<text fg={colors.muted}>reading servers{icons.ellipsis}</text>
						</box>
					) : (
						<box
							flexGrow={1}
							justifyContent="center"
							alignItems="center"
							paddingY={1}
						>
							<text fg={colors.muted}>
								No servers yet. Press <span fg={colors.info}>n</span> to create
								one, or run{" "}
								<span fg={colors.info}>mctl create &lt;name&gt;</span>.
							</text>
						</box>
					)
				}
			/>
		</box>
	);
}
