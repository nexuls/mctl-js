/**
 * Content — what has been added to this server: mods, plugins, datapacks, and
 * the resource pack it asks clients to download.
 *
 * Counts come from the directory walk in `core/server/inspect.ts`, which
 * distinguishes "no `mods/` directory" from "an empty `mods/`" — a Paper server
 * should show nothing for mods, not "0 mods", so an absent directory reads as
 * `—` and an empty one as `0`.
 *
 * The resource pack is read straight out of `server.properties`' raw map: it is
 * three loosely-related keys rather than a modelled field, and only servers that
 * set one have them at all.
 *
 * TODO(phase-5): listing and managing individual mods/plugins needs the
 * Modrinth/CurseForge integration; until then this tab counts what is on disk
 * rather than pretending to a catalogue.
 */

import { useTerminalDimensions } from "@opentui/react";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { formatBytes } from "../../../lib/format.ts";
import {
	Columns,
	Detail,
	EmptyNote,
	Panel,
	TWO_COLUMN_WIDTH,
	type ServerTabProps,
} from "../panels.tsx";

/** A count that must distinguish "none" from "this server has no such folder". */
function countLabel(value: number | undefined, empty: string): string {
	return value === undefined ? `${empty} (no directory)` : String(value);
}

export function ContentTab({ server, insight, size }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const empty = icons.emptyValue;
	const content = insight?.content ?? {};
	const raw = insight?.properties?.raw ?? {};
	const measuring = `measuring${icons.ellipsis}`;

	const packUrl = raw["resource-pack"] ?? "";
	const packRequired = raw["require-resource-pack"] === "true";

	const left = (
		<>
			<Panel title="Mods & plugins">
				<Detail label="mods" value={countLabel(content.mods, empty)} />
				<Detail label="plugins" value={countLabel(content.plugins, empty)} />
				<Detail
					label="datapacks"
					value={countLabel(content.datapacks, empty)}
				/>
				<box marginTop={1}>
					{/* Said explicitly because the number will not match a `ls | wc -l`
					    on a server whose owner has parked jars: disabled mods are
					    conventionally renamed `*.jar.disabled` and are not loaded. */}
					<EmptyNote>
						{`Jars only; ${"*.jar.disabled"} files are present but not loaded, and are not counted.`}
					</EmptyNote>
				</box>
			</Panel>

			<Panel title="Resource pack">
				{packUrl === "" ? (
					<EmptyNote>
						This server does not ask clients for a resource pack.
					</EmptyNote>
				) : (
					<>
						<Detail label="url" value={packUrl} />
						<Detail
							label="required"
							value={
								packRequired ? "yes — clients must accept" : "no (optional)"
							}
							color={packRequired ? colors.warning : undefined}
						/>
						<Detail
							label="sha1"
							value={raw["resource-pack-sha1"] || `${empty} (unverified)`}
						/>
						<Detail
							label="prompt"
							value={raw["resource-pack-prompt"] || empty}
						/>
					</>
				)}
			</Panel>
		</>
	);

	const right = (
		<Panel title="On disk">
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
			{/* Label kept inside LABEL_WIDTH: a longer one pushes its value out of
			    the shared column and the panel stops lining up. */}
			<Detail
				label="rest"
				value={
					size ? formatBytes(size.totalBytes - size.worldBytes) : measuring
				}
			/>
			<Detail
				label="files"
				value={size ? String(size.files) : measuring}
				color={colors.muted}
			/>
			<Detail label="path" value={server.path} />
			{size?.truncated ? (
				<box marginTop={1}>
					<EmptyNote>
						The walk hit its entry cap, so these totals are lower bounds.
					</EmptyNote>
				</box>
			) : null}
		</Panel>
	);

	return <Columns wide={width >= TWO_COLUMN_WIDTH} left={left} right={right} />;
}
