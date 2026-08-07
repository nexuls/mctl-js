/**
 * World — the world itself and every rule `server.properties` sets for it.
 *
 * Everything here is read live from Minecraft's own file rather than from
 * `mctl.json`: MCTL does not own these settings and must never mirror them, or
 * an edit made in a text editor would silently disagree with what the page
 * shows (architecture.md § filesystem is the source of truth).
 */

import { useTerminalDimensions } from "@opentui/react";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { formatBytes } from "../../../lib/format.ts";
import { yesNo } from "../../shared.tsx";
import {
	Columns,
	Detail,
	EmptyNote,
	Panel,
	TWO_COLUMN_WIDTH,
	type ServerTabProps,
} from "../panels.tsx";

export function WorldTab({ insight, size }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const empty = icons.emptyValue;
	const properties = insight?.properties;
	const measuring = `measuring${icons.ellipsis}`;

	if (!properties) {
		return (
			<Panel title="World">
				<EmptyNote>
					No server.properties yet — Minecraft writes it on the first run.
				</EmptyNote>
			</Panel>
		);
	}

	const left = (
		<>
			<Panel title="World">
				<Detail label="level" value={properties.levelName} />
				<Detail label="generator" value={properties.levelType} />
				<Detail
					label="seed"
					value={properties.levelSeed === "" ? "random" : properties.levelSeed}
				/>
				<Detail
					label="size"
					value={size ? formatBytes(size.worldBytes) : measuring}
				/>
				<Detail label="motd" value={insight?.status?.motd || properties.motd} />
			</Panel>

			<Panel title="Difficulty">
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
					label="spawn guard"
					value={`${properties.spawnProtection} blocks`}
				/>
			</Panel>
		</>
	);

	const right = (
		<>
			<Panel title="Rules">
				<Detail label="whitelist" value={yesNo(properties.whitelist, empty)} />
				<Detail
					label="online mode"
					value={
						properties.onlineMode
							? "yes"
							: "no (unauthenticated players allowed)"
					}
					color={properties.onlineMode ? undefined : colors.warning}
				/>
				<Detail label="flight" value={yesNo(properties.allowFlight, empty)} />
				<Detail label="nether" value={yesNo(properties.allowNether, empty)} />
				<Detail
					label="command blk"
					value={yesNo(properties.commandBlocks, empty)}
				/>
			</Panel>

			<Panel title="Load">
				<Detail label="view dist" value={`${properties.viewDistance} chunks`} />
				{/* Simulation distance is the one that costs CPU: chunks inside it tick
				    entities and crops, chunks merely inside the view distance only
				    render. They are shown together because tuning one without the
				    other is the usual mistake. */}
				<Detail
					label="sim dist"
					value={`${properties.simulationDistance} chunks (these tick)`}
				/>
				<Detail label="max players" value={String(properties.maxPlayers)} />
			</Panel>
		</>
	);

	return <Columns wide={width >= TWO_COLUMN_WIDTH} left={left} right={right} />;
}
