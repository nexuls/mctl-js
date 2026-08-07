/**
 * Settings — what `mctl.json` records about this server: the fields MCTL itself
 * owns, as opposed to the world rules on the World tab (which belong to
 * Minecraft and are read live from `server.properties`).
 *
 * **Read-only for now, and it says so.** Editing goes through
 * `ServerManager.editServer`, which the CLI already exposes as `mctl edit`; a
 * form here is a real piece of work (validation, a focus ring, an in-flight
 * state, and a re-install when the version changes) and is not what "scaffold
 * the tabs" asked for. Showing the values with the exact command that changes
 * them is honest and immediately useful.
 *
 * TODO(phase-3): make this an editable form over `ServerManager.editServer`,
 * mirroring `app/Settings/use-settings.ts` — buffered draft, validation, Ctrl+S.
 */

import { useTerminalDimensions } from "@opentui/react";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { serverStateColor } from "../../shared.tsx";
import {
	Columns,
	Detail,
	EmptyNote,
	Panel,
	TWO_COLUMN_WIDTH,
	javaLabel,
	type ServerTabProps,
} from "../panels.tsx";

export function SettingsTab({ server }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const empty = icons.emptyValue;

	const left = (
		<>
			<Panel title="Identity">
				<Detail label="id" value={server.id} />
				<Detail label="name" value={server.name} />
				<Detail label="kind" value={server.kind} />
				<Detail label="minecraft" value={server.minecraftVersion} />
				<Detail label="loader" value={server.loaderVersion ?? empty} />
			</Panel>

			<Panel title="Execution">
				<Detail label="java" value={javaLabel(server, empty)} />
				<Detail label="memory" value={server.memory} />
				<Detail label="runtime" value={server.runtime} />
				<Detail label="network" value={server.network} />
			</Panel>
		</>
	);

	const right = (
		<>
			<Panel title="Location">
				<Detail label="path" value={server.path} />
				<Detail label="config" value={`${server.path}/mctl.json`} />
				<Detail
					label="available"
					value={server.available ? "yes" : "no — the path is missing"}
					color={server.available ? undefined : colors.error}
				/>
				<Detail
					label="state"
					value={server.state}
					color={serverStateColor(colors, server.state)}
				/>
				<box marginTop={1}>
					{/* The registry holds locations only; the file at that path is the
					    server's own truth. Worth stating on the page that shows both. */}
					<EmptyNote>
						MCTL owns exactly one file in this directory: mctl.json.
					</EmptyNote>
				</box>
			</Panel>

			<Panel title="Changing these">
				<EmptyNote>
					These values are not editable in the TUI yet. Use:
				</EmptyNote>
				<box marginTop={1} flexDirection="column">
					<text fg={colors.info}>{`mctl edit ${server.id} --memory 4G`}</text>
					<text fg={colors.info}>{`mctl edit ${server.id} --java 21`}</text>
					<text
						fg={colors.info}
					>{`mctl edit ${server.id} --runtime tmux`}</text>
				</box>
				<box marginTop={1}>
					<EmptyNote>
						An edit takes effect on the next start; a running server keeps the
						settings it was launched with.
					</EmptyNote>
				</box>
			</Panel>
		</>
	);

	return <Columns wide={width >= TWO_COLUMN_WIDTH} left={left} right={right} />;
}
