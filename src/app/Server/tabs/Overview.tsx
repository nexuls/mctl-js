/**
 * Overview — the Server page's landing tab: where the server is, how long it has
 * been there, and the numbers that answer "is it healthy right now".
 *
 * It deliberately carries a *summary* of what the Players, Performance and
 * Network tabs go into properly: the tabs exist so the page is not one wall of
 * detail, but a first screen that made you visit three tabs to learn whether the
 * server is fine would be a worse page than the one it replaced.
 */

import { useTerminalDimensions } from "@opentui/react";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useTheme } from "../../../hooks/use-theme.tsx";
import {
	formatBytes,
	formatDuration,
	parseMemorySize,
} from "../../../lib/format.ts";
import { serverStateColor, serverStateIcon, uptimeOf } from "../../shared.tsx";
import {
	Columns,
	Detail,
	EmptyNote,
	Meter,
	Panel,
	TWO_COLUMN_WIDTH,
	javaLabel,
	type ServerTabProps,
} from "../panels.tsx";

export function OverviewTab({ server, insight, size }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const empty = icons.emptyValue;
	const uptime = uptimeOf(server);
	const usage = insight?.usage;
	const heapBytes = parseMemorySize(server.memory);
	const status = insight?.status;
	const maxPlayers = status?.playersMax ?? insight?.properties?.maxPlayers ?? 0;

	const left = (
		<>
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
				<Detail label="started" value={server.session?.startedAt ?? empty} />
				<Detail
					label="responding"
					value={
						status
							? `yes (${status.latencyMs} ms)`
							: server.state === "running"
								? "not yet"
								: empty
					}
				/>
				<Detail label="advertises" value={status?.versionName ?? empty} />
				<Detail
					label="motd"
					value={status?.motd || insight?.properties?.motd || empty}
				/>
			</Panel>

			<Panel title="Right now">
				<Meter
					label="players"
					value={status?.playersOnline ?? 0}
					max={maxPlayers}
					readout={`${status ? status.playersOnline : empty} / ${maxPlayers || empty}`}
					variant="success"
				/>
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
					</>
				) : (
					<EmptyNote>
						No process to sample — the server is not running.
					</EmptyNote>
				)}
			</Panel>
		</>
	);

	const right = (
		<>
			<Panel title="Connection">
				<Detail
					label="join address"
					value={insight?.address.joinAddress ?? empty}
				/>
				<Detail label="port" value={String(insight?.address.port ?? empty)} />
				<Detail
					label="bind"
					value={
						insight?.address.bindIp ? insight.address.bindIp : "all interfaces"
					}
				/>
				<Detail label="profile" value={server.network} />
			</Panel>

			<Panel title="Server">
				<Detail label="id" value={server.id} />
				<Detail label="kind" value={server.kind} />
				<Detail label="minecraft" value={server.minecraftVersion} />
				<Detail label="loader" value={server.loaderVersion ?? empty} />
				<Detail label="java" value={javaLabel(server, empty)} />
				<Detail label="heap" value={server.memory} />
				<Detail label="runtime" value={server.runtime} />
				<Detail
					label="on disk"
					value={
						size
							? `${size.truncated ? "≥ " : ""}${formatBytes(size.totalBytes)}`
							: `measuring${icons.ellipsis}`
					}
				/>
				<Detail label="path" value={server.path} />
			</Panel>
		</>
	);

	return <Columns wide={width >= TWO_COLUMN_WIDTH} left={left} right={right} />;
}
