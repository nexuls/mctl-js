/**
 * Step 2 — Locations. Optional overrides for the servers and backups directories
 * so large worlds or backup archives can live on a different drive than the data
 * root. Both default to under the root; the override inputs only appear when the
 * user opts out of the default, keeping the common path a single glance.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): default paths are computed with the
 * pure `rootPaths` helper (string math, no I/O).
 */

import { Input, Toggle } from "../../../components/index.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useFocusRing } from "../../../hooks/use-focus-ring.ts";
import { rootPaths } from "../../../lib/paths.ts";
import { StepScaffold } from "../StepScaffold.tsx";
import { WizardFooter } from "../WizardFooter.tsx";
import type { StepProps } from "../types.ts";

export function PathsStep({ draft, setDraft, onNext, onBack }: StepProps) {
	const { colors } = useTheme();
	const defaults = rootPaths(draft.root);

	// The ring only includes an override input while that override is enabled, so
	// Tab skips fields that aren't on screen.
	const ids = [
		"srvToggle",
		...(draft.overrideServers ? ["srvPath"] : []),
		"bkpToggle",
		...(draft.overrideBackups ? ["bkpPath"] : []),
		"__back",
		"__next",
	];
	const ring = useFocusRing(ids);

	return (
		<StepScaffold
			title="Where do servers and backups go?"
			description="Keep them under the data root, or point either at another drive."
			footer={
				<WizardFooter
					hints={[
						{ keys: "Tab", label: "next field" },
						{ keys: "Space", label: "toggle" },
					]}
					backFocused={ring.isFocused("__back")}
					nextFocused={ring.isFocused("__next")}
					onBack={onBack}
					onNext={onNext}
					onFocusBack={() => ring.setFocus("__back")}
					onFocusNext={() => ring.setFocus("__next")}
				/>
			}
		>
			<Toggle
				label="Servers directory"
				hint="where new servers are created by default"
				labels={["Under root", "Custom"]}
				value={draft.overrideServers}
				focused={ring.isFocused("srvToggle")}
				onFocused={() => ring.setFocus("srvToggle")}
				onChange={(v) => setDraft({ overrideServers: v })}
			/>
			{draft.overrideServers ? (
				<Input
					label="Custom servers directory"
					hint="absolute path"
					value={draft.serversDir}
					width={60}
					focused={ring.isFocused("srvPath")}
					onFocused={() => ring.setFocus("srvPath")}
					onChange={(v) => setDraft({ serversDir: v })}
					onSubmit={() => ring.next()}
				/>
			) : (
				<text fg={colors.muted}>
					Default: <span fg={colors.info}>{defaults.serversDir}</span>
				</text>
			)}

			<Toggle
				label="Backups directory"
				hint="where backup archives are written"
				labels={["Under root", "Custom"]}
				value={draft.overrideBackups}
				focused={ring.isFocused("bkpToggle")}
				onFocused={() => ring.setFocus("bkpToggle")}
				onChange={(v) => setDraft({ overrideBackups: v })}
			/>
			{draft.overrideBackups ? (
				<Input
					label="Custom backups directory"
					hint="absolute path"
					value={draft.backupsDir}
					width={60}
					focused={ring.isFocused("bkpPath")}
					onFocused={() => ring.setFocus("bkpPath")}
					onChange={(v) => setDraft({ backupsDir: v })}
					onSubmit={() => ring.next()}
				/>
			) : (
				<text fg={colors.muted}>
					Default: <span fg={colors.info}>{defaults.backupsDir}</span>
				</text>
			)}
		</StepScaffold>
	);
}
