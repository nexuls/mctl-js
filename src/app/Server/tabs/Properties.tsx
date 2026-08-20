/**
 * Properties — the editor for `server.properties`, Minecraft's own configuration
 * file, with **every key in it editable**.
 *
 * The World tab reads a handful of these values back as prose; this tab is the
 * place they are changed. The two are deliberately different views: World shows
 * MCTL's *interpretation* (hardcore reported as `hard` whatever the difficulty
 * key says, the MOTD stripped of its `§` colour codes), while an editor must
 * show what is on disk character for character or Save writes back something the
 * user never typed.
 *
 * **The form is generated, not laid out by hand.** `core/server/properties-
 * catalogue.ts` carries the 64 keys Minecraft documents — label, kind, range,
 * default, and which screen each belongs on — and this file turns a kind into a
 * control. A hand-written form would drift from the file the first time Mojang
 * added a key, and "every field is editable" is the whole promise. Keys found in
 * the file that the catalogue does *not* know (a mod's own, or one from an older
 * Minecraft) get a text field on the **Other** screen rather than being hidden.
 *
 * **The screens are a nested tab bar**, as on the Content tab and for the same
 * reason: sixty-four fields in one column is a page nobody can navigate. The bar
 * is pinned, only the fields under it scroll, and the Revert/Save row is pinned
 * under them — so a change made at the bottom of Performance does not require
 * scrolling back up to commit it. That is why this tab is in the container's
 * `TAB_OWNS_SCROLL`.
 *
 * **The container owns the focus ring** (only one ring may listen at a time), so
 * this tab exports its ids through {@link serverPropertiesRingIds} and reports
 * which fields are currently on screen through `ServerTabProps.onPropertiesState`.
 * Unlike the Content tab's fixed three stops, the members here *are* the active
 * screen's fields — switching screen is as deliberate an act as switching tab,
 * and enumerating all 64 as permanently-disabled stops would buy nothing.
 *
 * Page-layer (AGENTS.md § 3): every value arrives from `useServerProperties`;
 * this file reads and writes no files.
 */

import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import {
	Button,
	Checkbox,
	FormGrid,
	FormGridItem,
	Input,
	ScrollBox,
	Select,
	Tabs,
	type SelectItem,
	type TabItem,
} from "../../../components/index.ts";
import type { FocusItem } from "../../../hooks/use-focus-ring.ts";
import { useCaptureKeys } from "../../../hooks/use-input-capture.tsx";
import { useHints } from "../../../hooks/use-hints.tsx";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useServerProperties } from "../../../hooks/use-server-properties.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import {
	PROPERTY_GROUPS,
	type PropertyField,
	type PropertyGroup,
} from "../../../core/server/properties-catalogue.ts";
import { EmptyNote, type ServerTabProps } from "../panels.tsx";

/** Ring id of the nested screen bar — the tab's first stop, so ←/→ are there on arrival. */
export const PROPERTIES_TABS_ID = "__props-tabs";

/** Ring id of the Revert button. */
export const PROPERTIES_REVERT_ID = "__props-revert";

/** Ring id of the Save button. */
export const PROPERTIES_SAVE_ID = "__props-save";

/** Ring id of one field. Derived from the key, so it is stable across renders. */
export function propertyFieldId(key: string): string {
	return `prop:${key}`;
}

/**
 * What the container needs in order to build this tab's ring members: which
 * fields the screen on show has, and whether the buffer is committable.
 *
 * It travels up through `ServerTabProps.onPropertiesState` for the same reason
 * the Settings tab's form state does — a member's `disabled` must be the *same
 * expression* as its control's, and both facts live here.
 */
export interface ServerPropertiesTabState {
	/** Keys of the fields currently rendered, in Tab order. */
	keys: readonly string[];
	/** Whether anything differs from disk. */
	dirty: boolean;
	/** Whether any field on *any* screen fails validation. */
	invalid: boolean;
}

/**
 * This tab's contribution to the container's focus ring, in Tab order: the
 * screen bar, the screen's fields, then Revert and Save.
 */
export function serverPropertiesRingIds(
	state: ServerPropertiesTabState,
): FocusItem[] {
	return [
		PROPERTIES_TABS_ID,
		...state.keys.map(propertyFieldId),
		{ id: PROPERTIES_REVERT_ID, disabled: !state.dirty },
		{ id: PROPERTIES_SAVE_ID, disabled: !state.dirty || state.invalid },
	];
}

/**
 * Whether a field's control captures plain character keys, so the shell's
 * single-key shortcuts (`q` to quit, `2` to jump to Jobs) stand down while it
 * holds the focus. A checkbox and a dropdown do not; a text field does.
 */
function isTextField(field: PropertyField): boolean {
	return field.kind.type === "int" || field.kind.type === "string";
}

/**
 * One field, rendered from its kind.
 *
 * The **key** is the frame's label rather than the human name: it is what the
 * wiki, every guide and every other tool call this setting, so it is the string
 * a user matches against what they are reading. The human name survives as a
 * checkbox's caption, where there is a second line to put it on.
 *
 * A changed field is marked with a trailing `*` on that label. There is no
 * per-field accent to use — {@link Input} and friends colour their frame for
 * *focus* and *invalid*, and a third meaning on the same border would make all
 * three unreadable.
 */
function PropertyControl({
	field,
	value,
	changed,
	issue,
	focused,
	onFocus,
	onChange,
	onSubmit,
}: {
	field: PropertyField;
	value: string;
	changed: boolean;
	issue: string | undefined;
	focused: boolean;
	onFocus: () => void;
	onChange: (value: string) => void;
	/** Enter in a text field moves on, as it does on every other form here. */
	onSubmit: () => void;
}) {
	const label = changed ? `${field.key} *` : field.key;
	const hint = issue ?? field.hint;

	if (field.kind.type === "boolean") {
		return (
			<Checkbox
				label={label}
				hint={hint}
				// Bracketed because this is read as a *column* of checkboxes: in the
				// `ascii` icon set an unchecked glyph is the empty string, so without
				// the brackets an off field shows nothing at all.
				boxed
				caption={field.label}
				checked={value === "true"}
				focused={focused}
				onFocused={onFocus}
				onChange={(next) => onChange(next ? "true" : "false")}
			/>
		);
	}

	if (field.kind.type === "enum") {
		// A value the file carries that is not one of the documented options is
		// kept as an option of its own, exactly as the Settings tab does for a
		// deleted network profile: without it `Select` falls back to index 0 and
		// Save silently rewrites a value the user never touched.
		const options: SelectItem<string>[] = field.kind.values.map((option) => ({
			label: option,
			value: option,
		}));
		if (!field.kind.values.includes(value)) {
			options.push({
				label: value || "(empty)",
				value,
				description: "in the file, but not a documented value",
			});
		}
		return (
			<Select
				label={label}
				hint={hint}
				options={options}
				value={value}
				width="100%"
				maxVisible={5}
				invalid={issue !== undefined}
				focused={focused}
				onFocused={onFocus}
				onChange={onChange}
			/>
		);
	}

	// A credential is masked while the field does not hold the focus, so the page
	// is safe to read over a shoulder or paste into a bug report. Focusing it
	// reveals the text — there is no way to edit what you cannot see, and the act
	// of focusing is the user asking for it.
	const masked = field.secret === true && !focused;

	return (
		<Input
			label={label}
			hint={hint}
			value={masked ? "*".repeat(value.length) : value}
			placeholder={field.fallback === "" ? "(empty)" : field.fallback}
			width="100%"
			invalid={issue !== undefined}
			focused={focused}
			onFocused={onFocus}
			onChange={onChange}
			onSubmit={onSubmit}
		/>
	);
}

export function PropertiesTab({
	server,
	insight,
	focus,
	onPropertiesState,
}: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const toast = useToast();
	const [group, setGroup] = useState<PropertyGroup>("general");

	const {
		fields,
		draft,
		set,
		changed,
		issues,
		revert,
		save,
		saving,
		present,
		loading,
	} = useServerProperties(server, insight);

	// Only screens with something on them become entries: a bar stop leading to an
	// empty page is worse than no stop. In practice that drops "Other" for every
	// server whose file holds nothing MCTL does not know.
	const groups = PROPERTY_GROUPS.filter((entry) =>
		fields.some((field) => field.group === entry.id),
	);
	// Derived rather than corrected in an effect: "Other" can disappear under the
	// user when a poll no longer sees the unknown key that created it.
	const active = (
		groups.some((entry) => entry.id === group) ? group : groups[0]?.id
	) as PropertyGroup;
	const meta = groups.find((entry) => entry.id === active);
	const shown = fields.filter((field) => field.group === active);

	const invalid = Object.keys(issues).length > 0;
	const dirty = changed.size > 0;
	const canSave = dirty && !invalid && !saving;

	// The container owns the ring, so it needs the facts only this tab has.
	// Joined into a string so the effect fires on a *membership* change rather
	// than on every render's fresh array.
	const keySignature = shown.map((field) => field.key).join("|");
	useEffect(() => {
		const keys = keySignature === "" ? [] : keySignature.split("|");
		onPropertiesState?.({ keys, dirty, invalid });
		// Leaving the tab with a dirty buffer would otherwise strand this tab's
		// members in the container's ring for the *next* tab.
		return () =>
			onPropertiesState?.({ keys: [], dirty: false, invalid: false });
	}, [keySignature, dirty, invalid, onPropertiesState]);

	const focusedId = focus?.focus;
	const focusedField = shown.find(
		(field) => propertyFieldId(field.key) === focusedId,
	);
	// Typing `2` into the port must not navigate to Jobs, and `q` must not quit.
	useCaptureKeys(focusedField !== undefined && isTextField(focusedField));

	const commit = async (): Promise<void> => {
		if (!canSave) return;
		const count = changed.size;
		const error = await save();
		if (error !== null) {
			toast.error("Could not write server.properties", {
				description: error,
			});
			return;
		}
		toast.success(`Wrote ${count} ${count === 1 ? "property" : "properties"}`, {
			// Said every time rather than only when it matters. Minecraft reads
			// this file once at boot and rewrites it from memory when it saves, so
			// an edit under a running server does nothing *and* stands to be
			// overwritten — which is exactly what a silent success would hide.
			description:
				server.state === "running"
					? "The server is running: it keeps the values it booted with, and may overwrite these when it saves. Restart to apply."
					: "Applied at the next start.",
		});
	};

	// Ctrl+S from anywhere on the tab, including mid-edit: a modifier chord is
	// unambiguous while a text field is capturing plain characters.
	useKeyboard((key) => {
		if (key.ctrl && key.name === "s") void commit();
	});
	useHints([{ keys: "Ctrl+S", label: "save" }], {
		scope: "context",
		active: canSave,
	});
	// Registered against the same signature the container advertises, so on this
	// tab the strip says which "switch" the arrows currently perform.
	useHints(
		[{ keys: [icons.arrowLeft, icons.arrowRight], label: "switch section" }],
		{ scope: "context", active: focus?.isFocused(PROPERTIES_TABS_ID) === true },
	);

	const items: TabItem[] = groups.map((entry) => {
		// The count of pending changes rides on the label, because "which screen
		// did I touch?" is the question a 64-field form makes hard to answer.
		const pending = fields.filter(
			(field) => field.group === entry.id && changed.has(field.key),
		).length;
		return {
			id: entry.id,
			label: pending > 0 ? `${entry.label} ${pending}*` : entry.label,
		};
	});

	const body = (() => {
		if (loading) return <EmptyNote>Reading server.properties…</EmptyNote>;
		if (!draft) return <EmptyNote>Reading server.properties…</EmptyNote>;
		return (
			<FormGrid>
				{shown.map((field) => (
					<FormGridItem
						key={field.key}
						// A dropdown needs the room to draw its options, and a long URL or
						// a MOTD is unreadable in half a terminal. Everything else pairs up.
						span={
							field.kind.type === "enum" || field.key === "motd" ? "full" : 1
						}
					>
						<PropertyControl
							field={field}
							value={draft[field.key] ?? ""}
							changed={changed.has(field.key)}
							issue={issues[field.key]}
							focused={focus?.isFocused(propertyFieldId(field.key)) ?? false}
							onFocus={() => focus?.setFocus(propertyFieldId(field.key))}
							onChange={(value) => set(field.key, value)}
							onSubmit={() => focus?.next()}
						/>
					</FormGridItem>
				))}
			</FormGrid>
		);
	})();

	return (
		// The bar is pinned above and the action row below, with only the fields
		// scrolling between them: a change made at the bottom of a long screen must
		// not require scrolling back up to commit it.
		<box flexDirection="column" flexGrow={1}>
			<Tabs
				items={items}
				activeId={active}
				onChange={(next) => setGroup(next as PropertyGroup)}
				focused={focus?.isFocused(PROPERTIES_TABS_ID)}
				onFocused={() => focus?.setFocus(PROPERTIES_TABS_ID)}
				paddingX={1}
			/>

			<box flexDirection="column" paddingX={1} flexShrink={0}>
				<text fg={colors.muted} truncate wrapMode="none">
					{meta?.description ?? ""}
				</text>
				{/* Said once, on the screen where it matters: a server that has never
				    booted has no file at all, and an editor that silently created one
				    would look like it had failed to find anything. */}
				{!loading && !present ? (
					<text fg={colors.warning} truncate wrapMode="none">
						{`${icons.warning} No server.properties yet — saving creates it, and Minecraft fills in the rest on its first run.`}
					</text>
				) : null}
			</box>

			{/* `key` remounts on a switch, so each screen opens at its own top rather
			    than inheriting the previous one's scroll offset. */}
			<ScrollBox key={active} flexGrow={1} enableAccel>
				<box flexDirection="column" paddingX={1} paddingTop={1}>
					{body}
				</box>
			</ScrollBox>

			{/* `flexShrink={0}`: the fields above are `flexGrow`, so on a short
			    terminal yoga shrinks whatever it may — and a one-row action bar
			    shrinks to nothing, silently removing Save. */}
			<box
				flexDirection="row"
				gap={2}
				alignItems="center"
				paddingX={1}
				flexShrink={0}
				border={["top"]}
				borderColor={colors.border}
			>
				<Button
					size="small"
					kind="ghost"
					variant="neutral"
					disabled={!dirty || saving}
					focused={focus?.isFocused(PROPERTIES_REVERT_ID)}
					onFocused={() => focus?.setFocus(PROPERTIES_REVERT_ID)}
					onClick={revert}
				>
					Revert
				</Button>
				<Button
					size="small"
					kind="ghost"
					variant="primary"
					disabled={!canSave}
					focused={focus?.isFocused(PROPERTIES_SAVE_ID)}
					onFocused={() => focus?.setFocus(PROPERTIES_SAVE_ID)}
					onClick={() => void commit()}
				>
					{saving ? "Saving…" : "Save"}
				</Button>
				<text
					fg={invalid ? colors.error : dirty ? colors.warning : colors.muted}
					truncate
					wrapMode="none"
				>
					{invalid
						? `${Object.keys(issues).length} field(s) need fixing`
						: dirty
							? `${changed.size} changed ${icons.separator} Ctrl+S saves ${icons.separator} only these keys are written`
							: "Nothing changed. Only keys you edit are ever written to the file."}
				</text>
			</box>
		</box>
	);
}
