/**
 * Settings — the editable view of `config.json`, rendering the same schema the
 * first-run wizard collects. Every field is editable except `root`, which is
 * permanent by design (plan.md § First-Run Setup Wizard) and shown read-only.
 *
 * Page-layer (AGENTS.md § 3): all state and I/O live in {@link useSettings};
 * this file only renders controls and reports intent. Edits are buffered and
 * written on Save (or Ctrl+S) — not on every keystroke — so a half-typed path
 * never reaches disk.
 *
 * ## Layout
 * The settings are grouped into {@link GROUPS} and shown one group at a time
 * behind a tab bar, so a group fits on screen instead of the whole schema being
 * one long scroll. The page owns its scrolling (see `Router.tsx`'s `OWN_SCROLL`):
 * the tab bar is pinned above the panel and the action bar below it, and only the
 * panel between them scrolls. That is what keeps Save reachable from every group
 * without hunting for it.
 *
 * A validation problem on a group that isn't showing would otherwise be invisible,
 * so an offending group's tab is flagged (see {@link GROUP_OF_ISSUE}).
 *
 * **Key capture:** while the focus ring sits on a text field this page holds an
 * input capture ({@link useCaptureKeys}), which suppresses the shell's
 * single-character shortcuts. Without it, typing `2` in *Memory* would navigate
 * to Servers and `q` would quit mid-edit.
 */

import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
	Button,
	Checkbox,
	FormGroup,
	Hint,
	Input,
	RadioGroup,
	ScrollBox,
	Select,
	Tabs,
	type RadioItem,
	type SelectItem,
	type TabItem,
} from "../../components/index.ts";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useFocusRing } from "../../hooks/use-focus-ring.ts";
import { useCaptureKeys } from "../../hooks/use-input-capture.tsx";
import { useToast } from "../../hooks/use-toast.tsx";
import { resolveRootPaths } from "../../core/config/index.ts";
import { alpha } from "../../lib/colors.ts";
import { configFile } from "../../lib/paths.ts";
import type {
	BackupProvider,
	CompressionKind,
	NetworkProvider,
	RuntimeKind,
	ServerKind,
} from "../../types/config.ts";
import { PageHeader } from "../shared.tsx";
import { useSettings, type SettingsDraft } from "./use-settings.ts";

/** Server kinds available today. Grows as providers land (Phase 2+). */
const KINDS: SelectItem<ServerKind>[] = [
	{
		label: "Vanilla",
		value: "vanilla",
		description: "Mojang's official server",
	},
];

/** Runtime providers, mirroring the wizard's Defaults step. */
const RUNTIMES: RadioItem<RuntimeKind>[] = [
	{ label: "foreground", value: "foreground", description: "tied to MCTL" },
	{ label: "tmux", value: "tmux", description: "detached (Phase 3)" },
	{ label: "docker", value: "docker", description: "containerised (Phase 5)" },
];

/** Backup providers registered today. */
const BACKUP_PROVIDERS: SelectItem<BackupProvider>[] = [
	{ label: "filesystem", value: "filesystem", description: "local directory" },
];

/** Archive formats. */
const COMPRESSIONS: RadioItem<CompressionKind>[] = [
	{ label: "tar.zst", value: "tar.zst", description: "smallest, fastest" },
	{ label: "tar.gz", value: "tar.gz", description: "most portable" },
	{ label: "zip", value: "zip", description: "widest tooling" },
];

/** Network profiles available today; tunnels arrive in Phase 4. */
const NETWORKS: RadioItem<NetworkProvider>[] = [
	{ label: "direct", value: "direct", description: "bind a local port" },
];

/** The settings groups, in tab order. */
type GroupId = "locations" | "defaults" | "backups" | "network" | "appearance";

/** Tab bar model — one entry per {@link GroupId}. */
const GROUPS: (TabItem & { id: GroupId })[] = [
	{ id: "locations", label: "Locations" },
	{ id: "defaults", label: "Defaults" },
	{ id: "backups", label: "Backups" },
	{ id: "network", label: "Network" },
	{ id: "appearance", label: "Appearance" },
];

/**
 * Which group each validatable draft field lives in, so a validation issue can
 * be flagged on its tab even while another group is showing. Only fields
 * {@link validateDraft} can report on need an entry.
 */
const GROUP_OF_ISSUE: Partial<Record<keyof SettingsDraft, GroupId>> = {
	serversDir: "locations",
	backupsDir: "locations",
	memory: "defaults",
};

/**
 * Ring ids that host a live text field. Focus on one of these means the user is
 * typing, so the shell's character shortcuts must stand down.
 */
const TEXT_FIELDS = new Set(["serversDir", "backupsDir", "mc", "memory"]);

/** Ring id of the tab bar — first in the ring, so Tab from the top reaches it. */
const TABS_ID = "__tabs";

/**
 * The focus order within each group. Ids that only exist while a toggle is on
 * are added by {@link ringIds}, which is the single place the ring is assembled.
 */
const GROUP_FIELDS: Record<GroupId, string[]> = {
	locations: ["overrideServers", "overrideBackups"],
	defaults: ["mc", "memory", "kind", "runtime", "eula"],
	backups: ["backupEnabled"],
	network: ["network"],
	appearance: ["theme"],
};

/**
 * The focus ring for a group: the tab bar, then the group's visible fields, then
 * the action bar. Conditional fields (a path input behind its override toggle)
 * appear only while they are on screen — `useFocusRing` clamps its index when the
 * list changes, so toggling one mid-cycle is safe.
 */
function ringIds(group: GroupId, draft: SettingsDraft): string[] {
	const fields: string[] = [];
	for (const id of GROUP_FIELDS[group]) {
		fields.push(id);
		if (id === "overrideServers" && draft.overrideServers)
			fields.push("serversDir");
		if (id === "overrideBackups" && draft.overrideBackups)
			fields.push("backupsDir");
		if (id === "backupEnabled" && draft.backupEnabled) {
			fields.push("backupProvider", "compression");
		}
	}
	return [TABS_ID, ...fields, "__revert", "__save"];
}

/** A read-only `label  value` row, for values that cannot be edited. */
function ReadOnlyRow({
	label,
	value,
	note,
}: {
	label: string;
	value: string;
	note?: string;
}) {
	const { colors } = useTheme();
	return (
		<box flexDirection="row" gap={1} flexShrink={0}>
			<text fg={colors.muted} flexShrink={0}>
				{label.padEnd(14)}
			</text>
			{/* Truncate rather than wrap: a long root path must not reflow the row
          into three lines on a narrow terminal. */}
			<text fg={colors.foreground} truncate wrapMode="none">
				{value}
			</text>
			{note ? (
				<text fg={colors.muted} attributes={TextAttributes.DIM} flexShrink={0}>
					{note}
				</text>
			) : null}
		</box>
	);
}

/**
 * A group's field stack, matching the spacing the wizard steps use.
 *
 * It carries no heading of its own — the active tab already names the group, and
 * repeating it would cost a row and read as a second, redundant title.
 */
function Section({
	description,
	children,
}: {
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<box flexDirection="column" marginBottom={1} flexShrink={0}>
			<FormGroup description={description}>{children}</FormGroup>
		</box>
	);
}

export function Settings() {
	const { colors, themeId, setThemeId, themes } = useTheme();
	const {
		draft,
		config,
		loading,
		loadError,
		set,
		dirty,
		issues,
		revert,
		save,
		saving,
		saveError,
		saved,
	} = useSettings();

	const toast = useToast();
	const [group, setGroup] = useState<GroupId>("defaults");

	// The ring depends on both the visible group and the override toggles, so it is
	// rebuilt every render from the draft rather than tracked separately.
	const ring = useFocusRing(draft ? ringIds(group, draft) : [TABS_ID]);

	// Suppress the shell's digit/q/t shortcuts while a text field has the ring.
	useCaptureKeys(ring.focus !== undefined && TEXT_FIELDS.has(ring.focus));

	const invalid = Object.keys(issues).length > 0;
	const canSave = dirty && !invalid && !saving;

	/**
	 * Save and report the outcome as a toast. The page header still carries the
	 * state (dirty / saved / the failure), but a save triggered by Ctrl+S from a
	 * scrolled-down group happens off screen — the toast is what makes it visible
	 * from anywhere on the page. A failed save offers `r` to try again.
	 */
	const commit = async (): Promise<void> => {
		const error = await save(themeId);
		if (error === null) {
			toast.success("Settings saved", {
				description: `Written to ${configFile()}`,
			});
			return;
		}
		toast.error("Settings not saved", {
			description: error,
			action: { label: "Retry", key: "r", onAction: () => void commit() },
		});
	};

	// Ctrl+S saves from anywhere on the page, including mid-edit — a modifier
	// chord is unambiguous even while a text field is capturing plain characters.
	useKeyboard((key) => {
		if (key.ctrl && key.name === "s" && canSave) void commit();
	});

	if (loading || !draft || !config) {
		return (
			<box flexDirection="column" flexGrow={1}>
				<PageHeader
					title="Settings"
					subtitle={loadError ? `error: ${loadError}` : "reading config…"}
				/>
			</box>
		);
	}

	const paths = resolveRootPaths(config);
	const edit = (patch: Partial<SettingsDraft>) => set(patch);

	// Groups holding a bad field are marked, since their fields are off screen
	// while another tab is showing and Save would otherwise be disabled for no
	// visible reason.
	const flagged = new Set<GroupId>();
	for (const key of Object.keys(issues) as (keyof SettingsDraft)[]) {
		const owner = GROUP_OF_ISSUE[key];
		if (owner) flagged.add(owner);
	}
	const tabs: TabItem[] = GROUPS.map((g) => ({
		id: g.id,
		label: flagged.has(g.id) ? `${g.label} !` : g.label,
	}));

	return (
		<box flexDirection="column" flexGrow={1}>
			{/* Group tabs — pinned above the panel. */}
			<Tabs
				items={tabs}
				paddingX={1}
				activeId={group}
				focused={ring.isFocused(TABS_ID)}
				onFocused={() => ring.setFocus(TABS_ID)}
				onChange={(id) => setGroup(id as GroupId)}
				initials="Settings"
			/>

			{/* The only scrolling region: one group's fields. Keyed by group so
          switching tabs remounts the panel and its scroll starts at the top. */}
			<ScrollBox
				key={group}
				flexGrow={1}
				paddingTop={1}
				paddingX={1}
				scrollbarOptions={{
					trackOptions: {
						backgroundColor: colors.surface,
						foregroundColor: alpha(colors.muted, 0.4),
					},
				}}
			>
				{group === "locations" ? (
					<Section description="`root` is chosen once at first run and is permanent.">
						<ReadOnlyRow label="root" value={config.root} note="(permanent)" />
						<ReadOnlyRow
							label="configVersion"
							value={String(config.configVersion)}
						/>
						<ReadOnlyRow label="config file" value={configFile()} />

						<Checkbox
							label="Servers directory"
							caption={
								draft.overrideServers
									? "Custom location"
									: `Default — ${paths.serversDir}`
							}
							checked={draft.overrideServers}
							focused={ring.isFocused("overrideServers")}
							onFocused={() => ring.setFocus("overrideServers")}
							onChange={(v) => edit({ overrideServers: v })}
						/>
						{draft.overrideServers ? (
							<Input
								label="servers_dir"
								hint={issues.serversDir ?? "absolute path"}
								value={draft.serversDir}
								invalid={issues.serversDir !== undefined}
								focused={ring.isFocused("serversDir")}
								onFocused={() => ring.setFocus("serversDir")}
								onChange={(v) => edit({ serversDir: v })}
								onSubmit={() => ring.next()}
							/>
						) : null}

						<Checkbox
							label="Backups directory"
							caption={
								draft.overrideBackups
									? "Custom location"
									: `Default — ${paths.backupsDir}`
							}
							checked={draft.overrideBackups}
							focused={ring.isFocused("overrideBackups")}
							onFocused={() => ring.setFocus("overrideBackups")}
							onChange={(v) => edit({ overrideBackups: v })}
						/>
						{draft.overrideBackups ? (
							<Input
								label="backups_dir"
								hint={issues.backupsDir ?? "absolute path"}
								value={draft.backupsDir}
								invalid={issues.backupsDir !== undefined}
								focused={ring.isFocused("backupsDir")}
								onFocused={() => ring.setFocus("backupsDir")}
								onChange={(v) => edit({ backupsDir: v })}
								onSubmit={() => ring.next()}
							/>
						) : null}
					</Section>
				) : null}

				{group === "defaults" ? (
					<Section description="Starting values when a server is created; each is overridable per server.">
						<box flexDirection="row" gap={2} flexWrap="wrap">
							<Input
								label="Minecraft version"
								hint="blank = latest at create time"
								placeholder="latest"
								value={draft.minecraftVersion}
								width="50%"
								maxWidth={40}
								focused={ring.isFocused("mc")}
								onFocused={() => ring.setFocus("mc")}
								onChange={(v) => edit({ minecraftVersion: v })}
								onSubmit={() => ring.next()}
							/>
							<Input
								label="Memory"
								hint={issues.memory ?? "JVM heap, e.g. 2G"}
								value={draft.memory}
								width="50%"
								maxWidth={22}
								invalid={issues.memory !== undefined}
								focused={ring.isFocused("memory")}
								onFocused={() => ring.setFocus("memory")}
								onChange={(v) => edit({ memory: v })}
								onSubmit={() => ring.next()}
							/>
						</box>

						<Select
							label="Server kind"
							hint="the server implementation"
							options={KINDS}
							value={draft.kind}
							width="50%"
							focused={ring.isFocused("kind")}
							onFocused={() => ring.setFocus("kind")}
							onChange={(v) => edit({ kind: v })}
						/>

						<RadioGroup
							label="Runtime"
							hint="how the server process is run"
							options={RUNTIMES}
							value={draft.runtime}
							focused={ring.isFocused("runtime")}
							onFocused={() => ring.setFocus("runtime")}
							onChange={(v) => edit({ runtime: v })}
						/>

						<Checkbox
							label="Minecraft EULA"
							caption="Auto-accept the EULA when creating a server"
							checked={draft.eula}
							focused={ring.isFocused("eula")}
							onFocused={() => ring.setFocus("eula")}
							onChange={(v) => edit({ eula: v })}
						/>
					</Section>
				) : null}

				{group === "backups" ? (
					<Section description="Scheduling and retention arrive in Phase 4.">
						<Checkbox
							label="Automatic backups"
							caption="Back servers up on a schedule"
							checked={draft.backupEnabled}
							focused={ring.isFocused("backupEnabled")}
							onFocused={() => ring.setFocus("backupEnabled")}
							onChange={(v) => edit({ backupEnabled: v })}
						/>
						{draft.backupEnabled ? (
							<>
								<Select
									label="Provider"
									hint="where archives are written"
									options={BACKUP_PROVIDERS}
									value={draft.backupProvider}
									width={40}
									focused={ring.isFocused("backupProvider")}
									onFocused={() => ring.setFocus("backupProvider")}
									onChange={(v) => edit({ backupProvider: v })}
								/>
								<RadioGroup
									label="Compression"
									hint="archive format"
									options={COMPRESSIONS}
									value={draft.compression}
									focused={ring.isFocused("compression")}
									onFocused={() => ring.setFocus("compression")}
									onChange={(v) => edit({ compression: v })}
								/>
							</>
						) : null}
					</Section>
				) : null}

				{group === "network" ? (
					<Section description="Tunnels and DNS arrive in Phase 4.">
						<RadioGroup
							label="Default profile"
							hint="applied to new servers"
							options={NETWORKS}
							value={draft.network}
							focused={ring.isFocused("network")}
							onFocused={() => ring.setFocus("network")}
							onChange={(v) => edit({ network: v })}
						/>
					</Section>
				) : null}

				{group === "appearance" ? (
					<Section description="Applies immediately and is saved on its own — no need to press Save.">
						<Select
							label="Theme"
							hint="`terminal` follows the host palette"
							options={themes.map((t) => ({
								label: t.name,
								value: t.id,
								description: t.source,
							}))}
							value={themeId}
							width={44}
							forceDropdown
							focused={ring.isFocused("theme")}
							onFocused={() => ring.setFocus("theme")}
							onChange={(id) => setThemeId(id)}
						/>
					</Section>
				) : null}
			</ScrollBox>

			{/* Action bar — pinned to the bottom of the page, outside the scrolling
          panel, so Save is reachable from every group without scrolling. */}
			<box
				flexShrink={0}
				flexDirection="row"
				justifyContent="space-between"
				alignItems="center"
				border={["top"]}
				borderStyle="single"
				borderColor={colors.border}
				paddingTop={0}
				paddingX={1}
			>
				{saveError ? (
					<text fg={colors.error} truncate wrapMode="none">
						{saveError}
					</text>
				) : (
					<Hint
						items={[
							{ keys: ["←", "→"], label: "group" },
							{ keys: "Tab", label: "next field" },
							{ keys: "Ctrl+S", label: "save" },
						]}
					/>
				)}
				<box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
					<Button
						size="small"
						kind="ghost"
						variant="neutral"
						disabled={!dirty || saving}
						focused={ring.isFocused("__revert")}
						onClick={revert}
						onFocused={() => ring.setFocus("__revert")}
					>
						Revert
					</Button>
					<Button
						size="small"
						kind="ghost"
						variant="primary"
						disabled={!canSave}
						focused={ring.isFocused("__save")}
						onClick={() => void commit()}
						onFocused={() => ring.setFocus("__save")}
					>
						{saving ? "Saving…" : "Save"}
					</Button>
				</box>
			</box>
		</box>
	);
}
