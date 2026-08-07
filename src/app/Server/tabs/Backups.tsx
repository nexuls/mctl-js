/**
 * Backups — this server's archives.
 *
 * The screen exists so the navigation model is complete; the functionality
 * arrives with the backup providers in **Phase 4** (`plan.md` § Development
 * Roadmap). It says so rather than showing an empty list, which would read as
 * "you have no backups" — a materially different and dangerous claim.
 *
 * TODO(phase-4): render `BackupProvider.list(server)` — archive name, size,
 * created-at and the sidecar's MC version — plus Back up now / Restore actions
 * and the retention policy in force.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useConfig } from "../../../hooks/use-config.ts";
import { resolveRootPaths } from "../../../core/config/index.ts";
import { Detail, EmptyNote, Panel, type ServerTabProps } from "../panels.tsx";

export function BackupsTab({ server }: ServerTabProps) {
	const { colors } = useTheme();
	const { config } = useConfig();
	const backup = config?.backup;

	return (
		<box flexDirection="column">
			<Panel title="Backups" accent={colors.warning}>
				<text fg={colors.warning} attributes={TextAttributes.BOLD}>
					Backups arrive in Phase 4
				</text>
				<box marginTop={1} flexDirection="column">
					<EmptyNote>
						{`No archive of ${server.id} has been taken by MCTL — the backup providers `}
					</EmptyNote>
					<EmptyNote>
						(filesystem, S3, Drive, …) and the scheduler are not built yet.
					</EmptyNote>
					<box marginTop={1}>
						<EmptyNote>
							Until then, the server directory is an ordinary directory: copy it
							while the server is stopped.
						</EmptyNote>
					</box>
				</box>
			</Panel>

			{/* The policy is already configurable in Settings, so showing what is
			    configured is honest and useful — it is the part that exists. */}
			<Panel title="Configured policy">
				<Detail
					label="enabled"
					value={backup === undefined ? "—" : backup.enabled ? "yes" : "no"}
				/>
				<Detail label="provider" value={backup?.provider ?? "—"} />
				<Detail label="compression" value={backup?.compression ?? "—"} />
				{/* `backups_dir` is an *override*; resolving it through the config
				    service is what turns an unset field into the real default rather
				    than an empty row (and never builds a path by hand). */}
				<Detail
					label="destination"
					value={config ? resolveRootPaths(config).backupsDir : "—"}
				/>
			</Panel>
		</box>
	);
}
