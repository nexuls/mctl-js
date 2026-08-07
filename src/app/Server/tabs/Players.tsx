/**
 * Players — who is connected now, and who the server knows about.
 *
 * Two different sources, deliberately shown apart. **Online** comes from the
 * live list ping, which is the only player count obtainable without RCON or a
 * mod; **rosters** are the four JSON files Minecraft keeps in the server
 * directory (`usercache`, `ops`, `whitelist`, `banned-players`). The first is
 * absent whenever the server is not answering, the second whenever it has never
 * booted — so neither is allowed to imply the other.
 *
 * The ping returns only a *sample* of names (vanilla caps it, and many servers
 * disable it entirely), which the panel says rather than presenting a partial
 * list as the full one.
 */

import { useTerminalDimensions } from "@opentui/react";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useTheme } from "../../../hooks/use-theme.tsx";
import {
	Columns,
	Detail,
	EmptyNote,
	Meter,
	Panel,
	TWO_COLUMN_WIDTH,
	type ServerTabProps,
} from "../panels.tsx";

export function PlayersTab({ server, insight }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const empty = icons.emptyValue;
	const status = insight?.status;
	const properties = insight?.properties;
	const content = insight?.content ?? {};
	const max = status?.playersMax ?? properties?.maxPlayers ?? 0;

	const left = (
		<Panel title="Online">
			<Meter
				label="online"
				value={status?.playersOnline ?? 0}
				max={max}
				readout={`${status ? status.playersOnline : empty} / ${max || empty}`}
				variant="success"
			/>
			{status ? (
				status.sample.length > 0 ? (
					<>
						<box marginTop={1} flexDirection="column">
							{status.sample.map((player) => (
								<text key={player.name} fg={colors.success}>
									{`${icons.bullet} ${player.name}`}
								</text>
							))}
						</box>
						{status.playersOnline > status.sample.length ? (
							<box marginTop={1}>
								<EmptyNote>
									{`${status.playersOnline - status.sample.length} more online — the server sends only a sample of names.`}
								</EmptyNote>
							</box>
						) : null}
					</>
				) : status.playersOnline > 0 ? (
					<box marginTop={1}>
						<EmptyNote>
							This server does not publish player names in its status response.
						</EmptyNote>
					</box>
				) : (
					<box marginTop={1}>
						<EmptyNote>Nobody is connected.</EmptyNote>
					</box>
				)
			) : (
				<box marginTop={1}>
					<EmptyNote>
						{server.state === "running"
							? "The server is not answering a status ping yet."
							: "The server is not running, so there is no live player list."}
					</EmptyNote>
				</box>
			)}
		</Panel>
	);

	const right = (
		<Panel title="Rosters">
			<Detail
				label="known"
				value={
					content.knownPlayers === undefined
						? empty
						: `${content.knownPlayers} (seen recently)`
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
								properties?.whitelist ? "enforced" : "not enforced"
							})`
				}
				color={
					properties?.whitelist === false && (content.whitelisted ?? 0) > 0
						? colors.warning
						: undefined
				}
			/>
			<Detail
				label="banned"
				value={content.banned === undefined ? empty : String(content.banned)}
			/>
			<Detail
				label="slots"
				value={properties ? String(properties.maxPlayers) : empty}
			/>
			<Detail
				label="online mode"
				value={
					properties === undefined
						? empty
						: properties.onlineMode
							? "yes (Mojang-authenticated)"
							: "no (unauthenticated players allowed)"
				}
				color={properties?.onlineMode === false ? colors.warning : undefined}
			/>
			{/* Minecraft rewrites these files live, so they are the server's own
			    record — but only for players it has *seen*. A brand-new server has
			    none of them, which is why every row degrades to "—" rather than 0. */}
			<box marginTop={1}>
				<EmptyNote>
					Counts come from the server's own ops / whitelist / ban files.
				</EmptyNote>
			</box>
		</Panel>
	);

	return <Columns wide={width >= TWO_COLUMN_WIDTH} left={left} right={right} />;
}
