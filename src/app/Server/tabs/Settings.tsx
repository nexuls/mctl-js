/**
 * Settings — what `mctl.json` records about this server, and the form that
 * changes it. The world rules on the World tab belong to Minecraft and are read
 * live from `server.properties`; these values are MCTL's own.
 *
 * The editable fields are exactly `EditServerOptions` — name, memory, runtime,
 * network profile, Java pin — because that is what `ServerManager.editServer`
 * supports and this tab is a projection of it, not a second implementation of
 * editing (`mctl edit` is the same call). **Kind and Minecraft version are shown
 * read-only on purpose:** changing either is an *update* (a new jar, possibly a
 * re-run installer, a staged download and a rollback story), which core does not
 * have yet — a text field here would be a form that corrupts a server directory.
 *
 * **The container owns the focus ring**, as it does for the Console and Players
 * tabs: this tab contributes its field ids through {@link SERVER_SETTINGS_FIELDS}
 * and reports whether its buffer is dirty through `onDirty`, so the container can
 * mark Save/Revert disabled in the ring exactly when their buttons are. Only one
 * ring may listen at a time (see `useFocusRing`), which is why the tab does not
 * open one of its own.
 */

import { useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
	Button,
	Checkbox,
	FormGrid,
	FormGridItem,
	Input,
	RadioGroup,
	Select,
	type RadioItem,
} from "../../../components/index.ts";
import { useCaptureKeys } from "../../../hooks/use-input-capture.tsx";
import { useHints } from "../../../hooks/use-hints.tsx";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useMctl } from "../../../hooks/use-mctl.tsx";
import { useServerSettings } from "../../../hooks/use-server-settings.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import type { FocusItem } from "../../../hooks/use-focus-ring.ts";
import type { RuntimeKind } from "../../../types/config.ts";
import { serverStateColor } from "../../shared.tsx";
import { RUNTIME_ITEMS } from "../../choices.ts";
import {
	Columns,
	Detail,
	EmptyNote,
	Panel,
	TWO_COLUMN_WIDTH,
	javaLabel,
	type ServerSettingsFormState,
	type ServerTabProps,
} from "../panels.tsx";

/**
 * The tab's ring ids, in focus order. Exported so the container can splice them
 * into its own ring while this tab is active — the same shape `versionFieldIds`
 * uses on the create form.
 */
export const SERVER_SETTINGS_FIELDS = [
	"set-name",
	"set-memory",
	"set-runtime",
	"set-network",
	"set-java",
] as const;

/** Ids whose control is a text field, so the shell's character keys stand down. */
const TEXT_FIELDS = new Set(["set-name", "set-memory", "set-javaMajor"]);

/**
 * This tab's contribution to the container's focus ring.
 *
 * The state reaches the container through `ServerTabProps.onFormState` for one
 * reason: a ring member's `disabled` must be the *same expression* as its
 * control's, and only the tab knows whether its buffer has changed or whether
 * the Java field is on screen at all. A stop that lands on nothing is exactly
 * what that rule exists to prevent.
 */
export function serverSettingsRingIds(
	state: ServerSettingsFormState,
): FocusItem[] {
	return [
		...SERVER_SETTINGS_FIELDS,
		// Only rendered while Java is pinned; omitted rather than disabled because
		// it does not exist, and a disabled member holds a place for a control the
		// user can see.
		...(state.javaPinned ? ["set-javaMajor"] : []),
		{ id: "set-revert", disabled: !state.dirty },
		{ id: "set-save", disabled: !state.dirty },
	];
}

export function SettingsTab({
	server,
	focus,
	onFormState,
	onRefresh,
}: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const { context } = useMctl();
	const toast = useToast();
	const empty = icons.emptyValue;

	const { draft, set, dirty, issues, revert, save, saving } = useServerSettings(
		server,
		onRefresh,
	);

	// The container owns the ring, so it needs the two facts only this tab has.
	const javaPinned = draft?.javaPinned ?? false;
	useEffect(() => {
		onFormState?.({ dirty, javaPinned });
		// Leaving the tab with a dirty buffer would otherwise strand this tab's
		// members in the container's ring for the *next* tab.
		return () => onFormState?.({ dirty: false, javaPinned: false });
	}, [dirty, javaPinned, onFormState]);

	const invalid = Object.keys(issues).length > 0;
	const canSave = dirty && !invalid && !saving;
	const focused = (id: string) => focus?.isFocused(id) ?? false;
	const takeFocus = (id: string) => () => focus?.setFocus(id);

	// Typing `2` in Memory must not navigate to Jobs, and `q` must not quit.
	useCaptureKeys(focus?.focus !== undefined && TEXT_FIELDS.has(focus.focus));

	const commit = async (): Promise<void> => {
		if (!canSave) return;
		const error = await save();
		if (error === null) {
			toast.success(`${server.id} updated`, {
				// Said every time rather than only when it matters: a running server
				// keeps the settings it was launched with, and a memory change that
				// appears to do nothing is exactly what that looks like.
				description:
					server.state === "running"
						? "A running server keeps the settings it was launched with — restart to apply."
						: "Applied at the next start.",
			});
			return;
		}
		toast.error(`Could not update ${server.id}`, { description: error });
	};

	// Ctrl+S from anywhere on the tab, including mid-edit: a modifier chord is
	// unambiguous while a text field is capturing plain characters.
	useKeyboard((key) => {
		if (key.ctrl && key.name === "s") void commit();
	});
	// Advertised only while it would do anything — a key listed as live that is
	// not is worse than one that is never advertised.
	useHints([{ keys: "Ctrl+S", label: "save" }], {
		scope: "context",
		active: canSave,
	});

	/**
	 * The profiles this config defines, for the network picker. Read from the
	 * registry-backed context rather than typed out, because profiles are
	 * user-defined — a hand-kept list could not name the one added five minutes
	 * ago in Settings.
	 */
	const profileItems: RadioItem<string>[] = (
		context?.network.profiles() ?? []
	).map((profile) => ({
		label: profile.name,
		value: profile.name,
		description: profile.known
			? profile.provider
			: `${profile.provider} (unknown)`,
	}));
	// A server naming a profile that has since been deleted keeps its value as an
	// option; without it `Select` falls back to index 0 and a Save would silently
	// repoint the server at whichever profile happens to be first.
	if (draft && !profileItems.some((item) => item.value === draft.network)) {
		profileItems.push({
			label: draft.network,
			value: draft.network,
			description: "not defined — this server falls back to direct",
		});
	}

	const left = (
		<>
			<Panel title="Identity">
				{/* Read-only: the id *is* the directory name, and kind/version are an
				    update rather than an edit. */}
				<Detail label="id" value={server.id} />
				<Detail label="kind" value={server.kind} />
				<Detail label="minecraft" value={server.minecraftVersion} />
				<Detail label="loader" value={server.loaderVersion ?? empty} />
				<Detail label="java (now)" value={javaLabel(server, empty)} />
			</Panel>

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
		</>
	);

	const right = draft ? (
		<Panel title="Settings" accent={dirty ? colors.warning : undefined}>
			<FormGrid>
				<Input
					label="Name"
					hint={issues.name ?? "display name; the id never changes"}
					value={draft.name}
					width="100%"
					invalid={issues.name !== undefined}
					focused={focused("set-name")}
					onFocused={takeFocus("set-name")}
					onChange={(v) => set({ name: v })}
					onSubmit={() => focus?.next()}
				/>

				<Input
					label="Memory"
					hint={issues.memory ?? "JVM heap, e.g. 4G"}
					value={draft.memory}
					width="100%"
					invalid={issues.memory !== undefined}
					focused={focused("set-memory")}
					onFocused={takeFocus("set-memory")}
					onChange={(v) => set({ memory: v })}
					onSubmit={() => focus?.next()}
				/>

				<RadioGroup
					label="Runtime"
					hint="how the server process is run"
					options={RUNTIME_ITEMS}
					value={draft.runtime}
					focused={focused("set-runtime")}
					onFocused={takeFocus("set-runtime")}
					onChange={(v) => set({ runtime: v as RuntimeKind })}
				/>

				<Select
					label="Network profile"
					hint="how players reach this server"
					options={profileItems}
					value={draft.network}
					width="100%"
					maxVisible={5}
					focused={focused("set-network")}
					onFocused={takeFocus("set-network")}
					onChange={(v) => set({ network: v })}
				/>

				<FormGridItem span="full">
					<Checkbox
						label="Java"
						caption="Pin a Java version instead of resolving one from the version's requirement"
						checked={draft.javaPinned}
						focused={focused("set-java")}
						onFocused={takeFocus("set-java")}
						onChange={(v) => set({ javaPinned: v })}
					/>
				</FormGridItem>

				{draft.javaPinned ? (
					<Input
						label="Java major"
						hint={issues.javaMajor ?? "e.g. 21 — never re-derived"}
						value={draft.javaMajor}
						width="100%"
						invalid={issues.javaMajor !== undefined}
						focused={focused("set-javaMajor")}
						onFocused={takeFocus("set-javaMajor")}
						onChange={(v) => set({ javaMajor: v })}
						onSubmit={() => focus?.next()}
					/>
				) : null}
			</FormGrid>

			<box flexDirection="row" gap={2} alignItems="center" marginTop={1}>
				<Button
					size="small"
					kind="ghost"
					variant="neutral"
					disabled={!dirty || saving}
					focused={focused("set-revert")}
					onFocused={takeFocus("set-revert")}
					onClick={revert}
				>
					Revert
				</Button>
				<Button
					size="small"
					kind="ghost"
					variant="primary"
					disabled={!canSave}
					focused={focused("set-save")}
					onFocused={takeFocus("set-save")}
					onClick={() => void commit()}
				>
					{saving ? "Saving…" : "Save"}
				</Button>
				<text fg={colors.muted} truncate wrapMode="none">
					{dirty ? "Ctrl+S saves" : "Changes apply at the next start"}
				</text>
			</box>
		</Panel>
	) : (
		<Panel title="Settings">
			<EmptyNote>reading mctl.json…</EmptyNote>
		</Panel>
	);

	return <Columns wide={width >= TWO_COLUMN_WIDTH} left={left} right={right} />;
}
