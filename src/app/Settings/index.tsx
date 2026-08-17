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
 * Within a group the fields sit in a {@link FormGrid} — one column on a narrow
 * terminal, two once there is room — filled row-major in the same order as the
 * focus ring, so Tab and the eye agree. Fields that only make sense across the
 * full width (a switch that reveals the fields under it, the icon preview) say
 * so with {@link FormGridItem}.
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
	FormGrid,
	FormGridItem,
	FormGroup,
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
import { useIcons } from "../../hooks/use-icons.tsx";
import { useFocusRing, type FocusItem } from "../../hooks/use-focus-ring.ts";
import { useCaptureKeys } from "../../hooks/use-input-capture.tsx";
import { useHints } from "../../hooks/use-hints.tsx";
import { useMctl } from "../../hooks/use-mctl.tsx";
import { useServers } from "../../hooks/use-servers.ts";
import { useToast } from "../../hooks/use-toast.tsx";
import { useRouter } from "../../hooks/use-router.tsx";
import { resolveRootPaths } from "../../core/config/index.ts";
import { DIRECT_PROFILE } from "../../core/network/profiles.ts";
import type { ProviderRegistry } from "../../core/registry/provider-registry.ts";
import { alpha } from "../../lib/colors.ts";
import { configFile } from "../../lib/paths.ts";
import type {
	BackupProvider,
	CompressionKind,
	IconMode,
} from "../../types/config.ts";
import { PageHeader } from "../shared.tsx";
import { VersionField, versionFieldIds } from "../VersionField.tsx";
import { useServerVersions } from "../../hooks/use-server-versions.ts";
import {
	emptyProfile,
	profileIssues,
	useSettings,
	type ProfileDraft,
	type SettingsDraft,
} from "./use-settings.ts";

// Kinds and runtimes are shared with the setup wizard (`app/choices.ts`): this
// page and the Defaults step set the same two config fields, and two hand-kept
// copies of the option list is how one of them ends up a phase behind.
import { KIND_ITEMS as KINDS, RUNTIME_ITEMS as RUNTIMES } from "../choices.ts";

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

/**
 * Icon modes, with the trade-off spelled out in each description — the choice is
 * only obvious to someone who already knows whether their font is patched.
 */
const ICON_MODES: RadioItem<IconMode>[] = [
	{
		label: "auto",
		value: "auto",
		description: "detect what the terminal can draw",
	},
	{ label: "nerd", value: "nerd", description: "requires a Nerd Font" },
	{
		label: "ascii",
		value: "ascii",
		description: "plain 7-bit, works anywhere",
	},
];

/**
 * The profiles the *draft* defines, for the default-profile picker.
 *
 * Built from the edit buffer rather than from `config.json`, because a profile
 * added a moment ago has not been written yet and must still be selectable as
 * the default — otherwise creating a profile and making it the default takes two
 * saves. Each option is described by the provider it selects, since a profile
 * name alone says nothing.
 */
export function profileOptions(
	profiles: ProfileDraft[],
	defaultProfile: string,
): SelectItem<string>[] {
	return profiles.map((profile) => ({
		label: profile.name || "(unnamed)",
		value: profile.name,
		description: [
			profile.provider,
			profile.dnsEnabled ? `dns ${profile.dnsHostname}` : undefined,
			// Which profile new servers get is a property *of* a profile, so it is
			// shown on the profile rather than in a second list beside this one.
			profile.name === defaultProfile ? "default" : undefined,
		]
			.filter(Boolean)
			.join(" · "),
	}));
}

/**
 * Network provider options for the profile editor, from the **registry** — the
 * same rule the create form's Kind picker follows, since a hand-kept list here
 * would be a phase behind the providers that actually exist.
 *
 * A profile naming a provider this build does not have (a config written by a
 * newer MCTL) is re-added as an option marked unknown. Without that, `Select`
 * falls back to index 0 and a Save would silently rewrite the profile to
 * whatever happens to be first.
 */
function providerOptions(
	registry: ProviderRegistry | undefined,
	current: string,
): SelectItem<string>[] {
	const options = (registry?.networks() ?? []).map((provider) => ({
		label: provider.id,
		value: provider.id,
		description: provider.displayName,
	}));
	if (current !== "" && !options.some((option) => option.value === current)) {
		options.push({
			label: current,
			value: current,
			description: "not available in this build",
		});
	}
	return options;
}

/**
 * The options each provider reads, named in the field's hint.
 *
 * `options` is a free-form map by design — each provider validates its own shape
 * at the point of use rather than forcing every provider's schema into MCTL's
 * config schema (`types/config.ts`) — which leaves the user with an empty box and
 * no idea what may go in it. These are the keys each provider actually reads
 * today; a provider missing from the table simply gets the generic hint.
 */
const PROVIDER_OPTION_HINTS: Record<string, string> = {
	direct: "host, publicAddress",
	// `mode` leads because it decides what the rest mean: quick takes none of
	// them, named needs tunnelId + hostname.
	cloudflared: "mode=quick|named, tunnelId, tunnel, hostname",
	playit: "address, args, timeoutSeconds",
	ngrok: "region, remoteAddr, timeoutSeconds",
	tailscale: "preferIp",
};

/** Hint for the options field: the provider's own keys, or the format. */
function optionsHint(provider: string): string {
	const keys = PROVIDER_OPTION_HINTS[provider];
	return keys ? `${provider}: ${keys}` : "key=value pairs";
}

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
	profiles: "network",
	network: "network",
};

/**
 * Ring ids that host a live text field. Focus on one of these means the user is
 * typing, so the shell's character shortcuts must stand down.
 */
const TEXT_FIELDS = new Set([
	"serversDir",
	"backupsDir",
	"memory",
	"pName",
	"pOptions",
	"pDnsZone",
	"pDnsHostname",
	"pDnsTtl",
]);

/** Ring id of the tab bar — first in the ring, so Tab from the top reaches it. */
const TABS_ID = "__tabs";

/**
 * The focus order within each group. Ids that only exist while a toggle is on
 * are added by {@link ringIds}, which is the single place the ring is assembled.
 */
const GROUP_FIELDS: Record<GroupId, string[]> = {
	locations: ["overrideServers", "overrideBackups"],
	defaults: ["kind", "mc", "memory", "runtime", "eula"],
	backups: ["backupEnabled"],
	// Choosing a profile and acting on the *list* come first — New / Make default
	// / Delete are things done to profiles, not fields of the one being edited —
	// and only then the selected profile's own fields.
	network: [
		"profileSelect",
		"profileNew",
		"profileDefault",
		"profileDelete",
		"pName",
		"pProvider",
		"pOptions",
		"pDns",
	],
	appearance: ["theme", "icons"],
};

/**
 * Ring ids belonging to the *selected* profile rather than to the list. They are
 * skipped entirely when there is no profile to edit — unlike the list actions,
 * which keep their place in the ring and go disabled.
 */
const PROFILE_FIELDS = new Set(["pName", "pProvider", "pOptions", "pDns"]);

/**
 * The focus ring for a group: the tab bar, then the group's visible fields, then
 * the action bar. Conditional fields (a path input behind its override toggle)
 * appear only while they are on screen — `useFocusRing` clamps its index when the
 * list changes, so toggling one mid-cycle is safe.
 *
 * Revert and Save keep their places in the ring at all times but are marked
 * disabled exactly when their buttons are, so Tab runs the fields and comes back
 * round instead of parking on a dimmed chip that ignores Enter. A clean form has
 * neither button live, which is the common case.
 */
function ringIds(
	group: GroupId,
	draft: SettingsDraft,
	actions: {
		canRevert: boolean;
		canSave: boolean;
		canDeleteProfile: boolean;
		canMakeDefault: boolean;
	},
	versionChannelIds: string[],
	profile: ProfileDraft | undefined,
): FocusItem[] {
	const fields: FocusItem[] = [];
	for (const id of GROUP_FIELDS[group]) {
		// The selected profile's own fields only exist while there *is* one to edit —
		// a config with none is impossible in practice (`direct` cannot be removed)
		// but the ring must not name fields that are not on screen.
		if (PROFILE_FIELDS.has(id) && !profile) continue;
		// The two list actions that need a selection carry the same disabled
		// condition as their buttons rather than being dropped: they hold their place
		// in the ring while the reason is printed beside them.
		if (id === "profileDelete") {
			fields.push({ id, disabled: !actions.canDeleteProfile });
			continue;
		}
		if (id === "profileDefault") {
			fields.push({ id, disabled: !actions.canMakeDefault });
			continue;
		}
		fields.push(id);
		// One per channel the default kind publishes — data, not a fixed list.
		if (id === "mc") fields.push(...versionChannelIds);
		if (id === "overrideServers" && draft.overrideServers)
			fields.push("serversDir");
		if (id === "overrideBackups" && draft.overrideBackups)
			fields.push("backupsDir");
		if (id === "backupEnabled" && draft.backupEnabled) {
			fields.push("backupProvider", "compression");
		}
		if (id === "pDns" && profile?.dnsEnabled) {
			// In the order the grid draws them (Zone|Hostname, TTL|SRV, then the
			// full-width Proxied), so Tab and the eye agree — `packRows` is
			// order-preserving precisely so a ring can be read off the markup.
			fields.push(
				"pDnsZone",
				"pDnsHostname",
				"pDnsTtl",
				"pDnsSrv",
				"pDnsProxied",
			);
		}
	}
	return [
		TABS_ID,
		...fields,
		{ id: "__revert", disabled: !actions.canRevert },
		{ id: "__save", disabled: !actions.canSave },
	];
}

/**
 * Why this profile may not be deleted, or `undefined` when it may.
 *
 * The two rules are `core/network/profiles.ts`'s, restated here because the
 * draft is deleted from *before* that function ever sees it — the editor is
 * buffered, so the guard has to hold in the buffer too, or a Save would carry a
 * config whose own invariants are broken.
 */
function profileDeleteBlock(
	draft: SettingsDraft,
	profile: ProfileDraft | undefined,
): string | undefined {
	if (!profile) return "there is no profile to remove";
	if (profile.name === DIRECT_PROFILE) {
		return "`direct` is the fallback every profile degrades to";
	}
	if (profile.name === draft.network) {
		return "this is the default for new servers — pick another default first";
	}
	return undefined;
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
	// Like the theme, the icon set is owned by its provider and persisted on
	// change — it is not part of the save-on-Ctrl+S draft, so the effect of a
	// pick is visible across the whole UI the instant it is made.
	const {
		icons,
		set: iconSet,
		mode: iconMode,
		setMode: setIconMode,
	} = useIcons();
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
	} = useSettings();

	const toast = useToast();
	const { context } = useMctl();
	const { params } = useRouter();
	// Only to warn about servers a profile edit would strand — the page renders
	// nothing per-server. Cheap: the same cached read path the Dashboard uses.
	const { data: servers } = useServers();
	// The Network page links here (`navigate("settings", { group: "network" })`),
	// so the landing group is the route's if it named one. Read once as the
	// initial state rather than in an effect: a later navigate remounts the page.
	const [group, setGroup] = useState<GroupId>(() =>
		params.group && GROUPS.some((entry) => entry.id === params.group)
			? (params.group as GroupId)
			: "locations",
	);
	// Which profile the editor is showing. Page state, not draft state — it is a
	// view choice, and putting it in the draft would make merely *looking* at
	// another profile mark the form dirty.
	const [profileIndex, setProfileIndex] = useState(0);

	const invalid = Object.keys(issues).length > 0;
	const canSave = dirty && !invalid && !saving;
	const canRevert = dirty && !saving;

	// The version list for the *default* kind, so the Defaults group can offer a
	// picker instead of a free-text version. Fetched whatever group is showing —
	// it is one ETag-cached request and the tab switch is instant as a result.
	const versions = useServerVersions(draft?.kind);
	const versionChannelIds = versionFieldIds(versions).slice(1);

	// The profile under the editor, clamped: deleting the last profile in the list
	// leaves the index past the end for one render, and a row that used to exist
	// must not take the ring with it.
	const profiles = draft?.profiles ?? [];
	const shownProfile = Math.min(profileIndex, Math.max(profiles.length - 1, 0));
	const profile = profiles[shownProfile];
	const perProfileIssues = profileIssues(profiles)[shownProfile] ?? {};
	const deleteBlock = draft ? profileDeleteBlock(draft, profile) : undefined;
	// Promoting is only meaningful for a *named* profile that is not already the
	// default — an unnamed new row would write a default naming nothing.
	const canMakeDefault =
		profile !== undefined &&
		profile.name.trim() !== "" &&
		profile.name !== draft?.network;

	// The ring depends on the visible group, the override toggles and whether the
	// action buttons are live, so it is rebuilt every render from the draft rather
	// than tracked separately.
	const ring = useFocusRing(
		draft
			? ringIds(
					group,
					draft,
					{
						canRevert,
						canSave,
						canDeleteProfile: deleteBlock === undefined && !saving,
						canMakeDefault,
					},
					versionChannelIds,
					profile,
				)
			: [TABS_ID],
	);

	// Suppress the shell's digit/q/t shortcuts while a text field has the ring.
	useCaptureKeys(ring.focus !== undefined && TEXT_FIELDS.has(ring.focus));

	// ←/→ only reach the tab bar while the ring is on it; anywhere else they are
	// the text cursor, so the hint follows the ring rather than the page. Ctrl+S is
	// listed only when it would do something — a disabled key advertised as live is
	// the one thing worse than an unadvertised one.
	useHints([
		...(ring.isFocused(TABS_ID)
			? [{ keys: [icons.arrowLeft, icons.arrowRight], label: "group" }]
			: []),
		{ keys: "Tab", label: "next field" },
		...(canSave ? [{ keys: "Ctrl+S", label: "save" }] : []),
	]);

	/**
	 * Servers whose profile the pending save would delete or rename.
	 *
	 * Compared against the *draft*'s names rather than the config's: the profile
	 * about to vanish is the one the user removed in the buffer, and after the
	 * write there is nothing left to compare against. Declared above `commit`
	 * because `commit` closes over it and the page returns early before the draft
	 * exists.
	 */
	const orphanedServers = (): string[] => {
		if (!draft) return [];
		const names = new Set(draft.profiles.map((entry) => entry.name.trim()));
		return servers
			.filter((server) => !names.has(server.network))
			.map((server) => server.id);
	};

	/**
	 * Save and report the outcome as a toast. The page header still carries the
	 * state (dirty / saved / the failure), but a save triggered by Ctrl+S from a
	 * scrolled-down group happens off screen — the toast is what makes it visible
	 * from anywhere on the page. A failed save offers `r` to try again.
	 */
	const commit = async (): Promise<void> => {
		// Taken *before* the write, because a save re-baselines the draft: which
		// profiles are about to disappear is only knowable from the pre-save config.
		const orphaned = orphanedServers();
		const error = await save(themeId, iconMode);
		if (error === null) {
			toast.success("Settings saved", {
				description: `Written to ${configFile()}`,
			});
			// A server naming a profile that no longer exists still starts — it falls
			// back to direct networking — so this is a warning, not an error. Saying
			// nothing would leave that fallback to be discovered as a broken tunnel.
			if (orphaned.length > 0) {
				toast.warning("Some servers lost their profile", {
					description: `${orphaned.join(", ")} — each will use direct networking until repointed with \`mctl edit <id> --network <profile>\`.`,
				});
			}
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

	/**
	 * Edit the profile the editor is showing.
	 *
	 * A rename carries the **default** with it: the default is stored as a name,
	 * so renaming the default profile without this would leave `defaultProfile`
	 * pointing at a profile that no longer exists — which the form would then
	 * refuse to save, for a reason the user did not cause.
	 */
	const editProfile = (patch: Partial<ProfileDraft>) => {
		if (!profile) return;
		const next = draft.profiles.map((entry, at) =>
			at === shownProfile ? { ...entry, ...patch } : entry,
		);
		const renamed =
			patch.name !== undefined && draft.network === profile.name
				? { network: patch.name }
				: {};
		edit({ profiles: next, ...renamed });
	};

	/**
	 * Append a new profile, move the editor onto it and put the cursor in its Name
	 * field.
	 *
	 * The row starts **unnamed** rather than as `profile-4`: a generated name is
	 * one the user has to notice, select and delete, and it would also be
	 * immediately savable — a profile nobody meant to keep. An empty name is
	 * flagged `required` and holds Save until it is given one, which is the
	 * form saying what it needs. Focus moves there so the next keystroke is the
	 * name.
	 */
	const addProfile = () => {
		edit({ profiles: [...draft.profiles, emptyProfile("")] });
		setProfileIndex(draft.profiles.length);
		ring.setFocus("pName");
	};

	/** Remove the shown profile from the draft; it disappears from disk on Save. */
	const removeProfile = () => {
		if (!profile || deleteBlock) return;
		edit({
			profiles: draft.profiles.filter((_, at) => at !== shownProfile),
		});
		setProfileIndex(Math.max(shownProfile - 1, 0));
	};

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
						{/* The read-only rows are plain lines, so they stay a full-width
						    stack — pairing a path with a field beside it would only make
						    both of them narrower. */}
						<ReadOnlyRow label="root" value={config.root} note="(permanent)" />
						<ReadOnlyRow
							label="configVersion"
							value={String(config.configVersion)}
						/>
						<ReadOnlyRow label="config file" value={configFile()} />

						{/* Each override is one cell: the toggle and the path it reveals
						    belong together, and the two overrides sit side by side. */}
						<FormGrid>
							<box flexDirection="column" gap={1}>
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
							</box>

							<box flexDirection="column" gap={1}>
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
							</box>
						</FormGrid>
					</Section>
				) : null}

				{group === "defaults" ? (
					<Section description="Starting values when a server is created; each is overridable per server.">
						{/* Two columns where the terminal allows it. The fields used to be
						    pinned at 50% each in their own row, which cost as much height
						    as a full-width stack and half the width. */}
						<FormGrid>
							{/* Kind leads the group: the version list beside it is that
							    kind's, so picking the kind second meant picking a version
							    from the wrong catalogue first. */}
							<Select
								label="Server kind"
								hint="the server implementation"
								options={KINDS}
								value={draft.kind}
								width="100%"
								focused={ring.isFocused("kind")}
								onFocused={() => ring.setFocus("kind")}
								onChange={(v) => edit({ kind: v })}
							/>

							<VersionField
								state={versions}
								value={draft.minecraftVersion}
								onChange={(v) => edit({ minecraftVersion: v })}
								focus={ring}
								latestHint="resolve the newest release at create time"
							/>

							<Input
								label="Memory"
								hint={issues.memory ?? "JVM heap, e.g. 2G"}
								value={draft.memory}
								width="100%"
								invalid={issues.memory !== undefined}
								focused={ring.isFocused("memory")}
								onFocused={() => ring.setFocus("memory")}
								onChange={(v) => edit({ memory: v })}
								onSubmit={() => ring.next()}
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

							<FormGridItem span="full">
								<Checkbox
									label="Minecraft EULA"
									caption="Auto-accept the EULA when creating a server"
									checked={draft.eula}
									focused={ring.isFocused("eula")}
									onFocused={() => ring.setFocus("eula")}
									onChange={(v) => edit({ eula: v })}
								/>
							</FormGridItem>
						</FormGrid>
					</Section>
				) : null}

				{group === "backups" ? (
					<Section description="Scheduling and retention arrive in Phase 4.">
						<FormGrid>
							{/* The switch that reveals the other two spans the row, so
							    turning it on adds a row beneath it rather than shuffling
							    the fields already on screen. */}
							<FormGridItem span="full">
								<Checkbox
									label="Automatic backups"
									caption="Back servers up on a schedule"
									checked={draft.backupEnabled}
									focused={ring.isFocused("backupEnabled")}
									onFocused={() => ring.setFocus("backupEnabled")}
									onChange={(v) => edit({ backupEnabled: v })}
								/>
							</FormGridItem>
							{draft.backupEnabled ? (
								<Select
									label="Provider"
									hint="where archives are written"
									options={BACKUP_PROVIDERS}
									value={draft.backupProvider}
									width="100%"
									focused={ring.isFocused("backupProvider")}
									onFocused={() => ring.setFocus("backupProvider")}
									onChange={(v) => edit({ backupProvider: v })}
								/>
							) : null}
							{draft.backupEnabled ? (
								<RadioGroup
									label="Compression"
									hint="archive format"
									options={COMPRESSIONS}
									value={draft.compression}
									focused={ring.isFocused("compression")}
									onFocused={() => ring.setFocus("compression")}
									onChange={(v) => edit({ compression: v })}
								/>
							) : null}
						</FormGrid>
					</Section>
				) : null}

				{group === "network" ? (
					<Section description="A profile is a way of exposing a server; a new server is given the default one. The Network page shows which providers this machine can actually use.">
						{/* The list and the actions that act on it, above the editor and
						    visually separate from it. They used to sit under the fields, where
						    "Add profile" read as part of the profile being edited (user
						    report). Choosing, creating, promoting and deleting are all things
						    done to the *list*; the fields below belong to one member of it. */}
						<Select
							label="Profile"
							hint={
								issues.network ??
								`${draft.profiles.length} defined · default is ${draft.network}`
							}
							options={profileOptions(draft.profiles, draft.network)}
							value={profile?.name ?? ""}
							width="100%"
							maxVisible={6}
							invalid={issues.network !== undefined}
							focused={ring.isFocused("profileSelect")}
							onFocused={() => ring.setFocus("profileSelect")}
							onChange={(name) => {
								const at = draft.profiles.findIndex((p) => p.name === name);
								if (at >= 0) setProfileIndex(at);
							}}
						/>

						<box flexDirection="row" gap={2} alignItems="center">
							<Button
								size="small"
								kind="ghost"
								variant="primary"
								focused={ring.isFocused("profileNew")}
								onFocused={() => ring.setFocus("profileNew")}
								onClick={addProfile}
							>
								New profile
							</Button>
							<Button
								size="small"
								kind="ghost"
								variant="neutral"
								disabled={!canMakeDefault}
								focused={ring.isFocused("profileDefault")}
								onFocused={() => ring.setFocus("profileDefault")}
								onClick={() => profile && edit({ network: profile.name })}
							>
								Make default
							</Button>
							{/* Named, so the button cannot be read as "delete profiles" or as
							    an action on the whole form. */}
							<Button
								size="small"
								kind="ghost"
								variant="error"
								disabled={deleteBlock !== undefined || saving}
								focused={ring.isFocused("profileDelete")}
								onFocused={() => ring.setFocus("profileDelete")}
								onClick={removeProfile}
							>
								{profile ? `Delete ${profile.name || "profile"}` : "Delete"}
							</Button>
						</box>

						{/* A disabled button with no stated reason reads as a bug, and the two
						    protected profiles are not guessable. This line is the only place
						    they are explained. */}
						<text fg={colors.muted} truncate wrapMode="none">
							{deleteBlock
								? `Cannot delete: ${deleteBlock}.`
								: profile
									? `Editing ${profile.name || "the new profile"} — nothing is written until you save.`
									: "No profile selected."}
						</text>

						{profile ? (
							// Keyed by row, so switching profiles **remounts** these fields.
							// Without it the same `<input>` renderable is reused across rows, and
							// OpenTUI emits `onInput` when a value prop is assigned — so a switch
							// fed the outgoing profile's text back into the incoming row and
							// silently renamed it. Seen in a pty, not in the types.
							<FormGrid key={shownProfile}>
								<Input
									label="Name"
									hint={
										perProfileIssues.name ??
										(profile.name === DIRECT_PROFILE
											? "the built-in fallback profile"
											: "what a server names in its mctl.json")
									}
									value={profile.name}
									width="100%"
									invalid={perProfileIssues.name !== undefined}
									focused={ring.isFocused("pName")}
									onFocused={() => ring.setFocus("pName")}
									onChange={(v) => editProfile({ name: v })}
									onSubmit={() => ring.next()}
								/>

								<Select
									label="Provider"
									hint="how the port is exposed"
									options={providerOptions(
										context?.providers,
										profile.provider,
									)}
									value={profile.provider}
									width="100%"
									maxVisible={6}
									focused={ring.isFocused("pProvider")}
									onFocused={() => ring.setFocus("pProvider")}
									onChange={(v) => editProfile({ provider: v })}
								/>

								<FormGridItem span="full">
									<Input
										label="Options"
										hint={
											perProfileIssues.options ?? optionsHint(profile.provider)
										}
										value={profile.options}
										placeholder="key=value, key=value"
										width="100%"
										invalid={perProfileIssues.options !== undefined}
										focused={ring.isFocused("pOptions")}
										onFocused={() => ring.setFocus("pOptions")}
										onChange={(v) => editProfile({ options: v })}
										onSubmit={() => ring.next()}
									/>
								</FormGridItem>

								{/* DNS is a block, not a field: turning it on adds five inputs,
								    so it spans the row and they appear beneath it rather than
								    shuffling what is already on screen. */}
								<FormGridItem span="full">
									<Checkbox
										label="Cloudflare DNS"
										caption="Publish this server's address as records on a domain you own"
										checked={profile.dnsEnabled}
										focused={ring.isFocused("pDns")}
										onFocused={() => ring.setFocus("pDns")}
										onChange={(v) => editProfile({ dnsEnabled: v })}
									/>
								</FormGridItem>

								{profile.dnsEnabled ? (
									<Input
										label="Zone"
										hint={perProfileIssues.dnsZone ?? "zone name or id"}
										value={profile.dnsZone}
										width="100%"
										invalid={perProfileIssues.dnsZone !== undefined}
										focused={ring.isFocused("pDnsZone")}
										onFocused={() => ring.setFocus("pDnsZone")}
										onChange={(v) => editProfile({ dnsZone: v })}
										onSubmit={() => ring.next()}
									/>
								) : null}

								{profile.dnsEnabled ? (
									<Input
										label="Hostname"
										hint={perProfileIssues.dnsHostname ?? "e.g. mc.example.com"}
										value={profile.dnsHostname}
										width="100%"
										invalid={perProfileIssues.dnsHostname !== undefined}
										focused={ring.isFocused("pDnsHostname")}
										onFocused={() => ring.setFocus("pDnsHostname")}
										onChange={(v) => editProfile({ dnsHostname: v })}
										onSubmit={() => ring.next()}
									/>
								) : null}

								{profile.dnsEnabled ? (
									<Input
										label="TTL"
										hint={perProfileIssues.dnsTtl ?? "seconds; 1 = automatic"}
										value={profile.dnsTtl}
										width="100%"
										invalid={perProfileIssues.dnsTtl !== undefined}
										focused={ring.isFocused("pDnsTtl")}
										onFocused={() => ring.setFocus("pDnsTtl")}
										onChange={(v) => editProfile({ dnsTtl: v })}
										onSubmit={() => ring.next()}
									/>
								) : null}

								{profile.dnsEnabled ? (
									<Checkbox
										label="SRV record"
										caption="Also publish _minecraft._tcp, so players omit the port"
										checked={profile.dnsSrv}
										focused={ring.isFocused("pDnsSrv")}
										onFocused={() => ring.setFocus("pDnsSrv")}
										onChange={(v) => editProfile({ dnsSrv: v })}
									/>
								) : null}

								{profile.dnsEnabled ? (
									<FormGridItem span="full">
										{/* Said in the caption rather than left to be discovered:
										    the orange cloud proxies HTTP(S), and Minecraft is not
										    HTTP — a proxied record makes the server unreachable. */}
										<Checkbox
											label="Proxied"
											caption="Route through Cloudflare's proxy — breaks Minecraft; leave off"
											checked={profile.dnsProxied}
											focused={ring.isFocused("pDnsProxied")}
											onFocused={() => ring.setFocus("pDnsProxied")}
											onChange={(v) => editProfile({ dnsProxied: v })}
										/>
									</FormGridItem>
								) : null}
							</FormGrid>
						) : null}
					</Section>
				) : null}

				{group === "appearance" ? (
					<Section description="Applies immediately and is saved on its own — no need to press Save.">
						<FormGrid>
							<Select
								label="Theme"
								hint="`terminal` follows the host palette"
								options={themes.map((t) => ({
									label: `${t.name}  (${t.source})`,
									value: t.id,
								}))}
								value={themeId}
								width="100%"
								forceDropdown
								focused={ring.isFocused("theme")}
								onFocused={() => ring.setFocus("theme")}
								onChange={(id) => setThemeId(id)}
							/>

							<box gap={1}>
								{/* The hint names the *resolved* set, not just the mode: "auto"
							    on its own tells the user nothing about what they are looking
							    at, and the whole point of picking a set is seeing it
							    applied. */}
								<RadioGroup
									label="Icons"
									hint={
										iconMode === "auto"
											? `detected: ${iconSet}`
											: `using: ${iconSet}`
									}
									options={ICON_MODES}
									value={iconMode}
									focused={ring.isFocused("icons")}
									onFocused={() => ring.setFocus("icons")}
									onChange={(mode) => setIconMode(mode)}
								/>

								{/* A live sample, so the choice can be judged by eye rather than by
						    guessing whether the font has the glyphs. A row of tofu here is
						    exactly the signal that `nerd` is the wrong pick. */}
								<box flexDirection="row" gap={2} flexShrink={0} paddingLeft={1}>
									<text fg={colors.muted}>preview</text>
									<text fg={colors.success}>{icons.success}</text>
									<text fg={colors.warning}>{icons.warning}</text>
									<text fg={colors.error}>{icons.error}</text>
									<text fg={colors.info}>{icons.info}</text>
									<text fg={colors.primary}>{icons.running}</text>
									<text fg={colors.muted}>{icons.stopped}</text>
									<text fg={colors.secondary}>{icons.backup}</text>
									<text fg={colors.secondary}>{icons.network}</text>
									<text fg={colors.foreground}>{icons.radioOn}</text>
									<text fg={colors.muted}>{icons.radioOff}</text>
									<text fg={colors.primary}>{icons.caret}</text>
								</box>
							</box>
						</FormGrid>

						{/* Honest about the limit rather than letting the user discover it:
						    `borderStyle` is OpenTUI's, and 0.4.5 offers no ASCII variant. */}
						{iconSet === "ascii" ? (
							<text fg={colors.muted} attributes={TextAttributes.DIM}>
								Note: panel borders still use box-drawing characters — the
								terminal UI library provides no ASCII border style.
							</text>
						) : null}
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
				{/* The keys live in the shell's strip now; this row keeps only what is
				    specific to a save that failed. */}
				{saveError ? (
					<text fg={colors.error} truncate wrapMode="none">
						{saveError}
					</text>
				) : (
					<box />
				)}
				<box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
					<Button
						size="small"
						kind="ghost"
						variant="neutral"
						disabled={!canRevert}
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
