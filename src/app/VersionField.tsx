/**
 * VersionField — the Minecraft-version picker: a {@link Select} over the
 * versions the chosen kind actually publishes, plus a row of channel toggles
 * that decide which of them are offered.
 *
 * Page-layer UI (AGENTS.md § 3): it renders the view models
 * `hooks/use-server-versions.ts` hands it and does no I/O. It lives in `app/`
 * rather than `components/` because it is bound to one domain concept (a server
 * kind's version list); the component kit stays domain-free.
 *
 * It replaced a free-text input on both screens that ask for a version. The
 * input was defensible while the list cost a blocking round trip per kind — but
 * it also meant a typo produced a confusing 404 halfway through a create, and it
 * asked the user to know that Fabric spells its snapshots the way Mojang does.
 * Fetching is non-blocking now, so the picker degrades to an empty list plus a
 * hint rather than to an unusable form (see the hook's header).
 */

import { useKeyboard } from "@opentui/react";
import {
	CHANNEL_LABELS,
	type VersionChannel,
} from "../core/server/versions.ts";
import type { VersionInfo } from "../types/install.ts";
import type { ServerVersionsState } from "../hooks/use-server-versions.ts";
import { useIcons } from "../hooks/use-icons.tsx";
import { useTheme } from "../hooks/use-theme.tsx";
import { Select, type SelectItem } from "../components/index.ts";
import { alpha } from "../lib/colors.ts";

/**
 * The value that means "do not pin a version" — the newest release is resolved
 * at create time instead. It is the empty string because that is what both
 * callers already store (`config.defaults.minecraftVersion` omits the key, the
 * create form sends `undefined`).
 */
const LATEST = "";

/**
 * Ring ids this field contributes, in tab order: the select, then one per
 * toggleable channel.
 *
 * Exported because the *page* owns its focus ring and the channel row's length
 * is data — it depends on what the selected kind publishes. `useFocusRing`
 * clamps when the list changes, so a kind switch that adds or removes a channel
 * mid-cycle is safe.
 */
export function versionFieldIds(
	state: ServerVersionsState,
	prefix = "mc",
): string[] {
	return [prefix, ...toggleableChannels(state).map((c) => `${prefix}:${c}`)];
}

/**
 * The channels that get a checkbox: every channel present except `release`.
 *
 * Releases have no toggle on purpose. Hiding them leaves a picker that offers
 * only snapshots, which is never what someone unchecking a box meant, and the
 * row reads better as "and also show…" than as a set of filters one of which
 * must not be touched.
 */
function toggleableChannels(state: ServerVersionsState): VersionChannel[] {
	return state.channels.filter((channel) => channel !== "release");
}

/** Props for {@link VersionField}. */
export interface VersionFieldProps {
	/** The fetched list, its channel filter, and the loading/error state. */
	state: ServerVersionsState;
	/** The selected version id; `""` means "newest release at create time". */
	value: string;
	/** Fired with the newly-selected version id. */
	onChange: (value: string) => void;
	/**
	 * The page's focus ring, narrowed to what this field needs. The ids are the
	 * ones {@link versionFieldIds} returned for the same `prefix`.
	 */
	focus: {
		isFocused: (id: string) => boolean;
		setFocus: (id: string) => void;
	};
	/** Ring id prefix; must match the one passed to {@link versionFieldIds}. */
	prefix?: string;
	/** Field label on the top border. */
	label?: string;
	/**
	 * Offer the "latest" entry. True where a blank value is meaningful (the
	 * create form, the defaults), false where a concrete version is required.
	 */
	allowLatest?: boolean;
	/** What the "latest" entry promises, e.g. `"newest release at create time"`. */
	latestHint?: string;
	/** Field width, forwarded to the {@link Select}. */
	width?: number | `${number}%` | "auto";
}

/**
 * Render the version picker and its channel toggles.
 */
export function VersionField({
	state,
	value,
	onChange,
	focus,
	prefix = "mc",
	label = "Minecraft version",
	allowLatest = true,
	latestHint = "newest release at create time",
	width = "100%",
}: VersionFieldProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const toggles = toggleableChannels(state);

	// Space toggles the focused channel; Enter deliberately does not. Both pages
	// hosting this field submit on Enter from any field, and a chip that also
	// answered Enter would toggle a filter *and* create a server in one keypress.
	useKeyboard((key) => {
		if (key.name !== "space") return;
		const channel = toggles.find((c) => focus.isFocused(`${prefix}:${c}`));
		if (channel) state.toggle(channel);
	});

	// Deliberately no `description` on any option: `Select`'s dropdown gives every
	// row **two** lines as soon as one option has one, which halves how much of a
	// 900-entry list is on screen and pushes the rest of the form off the bottom.
	// What a version is fits in its label, and what "latest" means is the hint.
	const options: SelectItem<string>[] = [];
	if (allowLatest) options.push({ value: LATEST, label: "latest" });
	for (const version of state.versions) {
		options.push({ value: version.id, label: describe(version) });
	}
	// A value the list does not contain still has to be selectable, or the field
	// would silently re-point at its first option: the list may have failed to
	// load, the version may belong to a channel the user has hidden, or it may be
	// a version this kind stopped publishing since it was configured.
	if (value !== LATEST && !options.some((o) => o.value === value)) {
		options.unshift({
			value,
			label: state.loading ? value : `${value} (not listed)`,
		});
	}

	return (
		<box flexDirection="column" flexShrink={0}>
			<Select
				label={label}
				hint={fieldHint(
					state,
					options.length - (allowLatest ? 1 : 0),
					value === LATEST && allowLatest ? latestHint : undefined,
				)}
				options={options}
				value={value}
				onChange={onChange}
				focused={focus.isFocused(prefix)}
				onFocused={() => focus.setFocus(prefix)}
				width={width}
				// Six rows: enough to scan a version list without the picker taking
				// over the form it sits in the middle of.
				maxVisible={6}
			/>
			{toggles.length > 0 ? (
				<box
					flexDirection="row"
					flexWrap="wrap"
					gap={2}
					paddingX={2}
					flexShrink={0}
				>
					<text fg={colors.muted} flexShrink={0}>
						also show
					</text>
					{toggles.map((channel) => {
						const id = `${prefix}:${channel}`;
						const on = state.shown.has(channel);
						const focused = focus.isFocused(id);
						return (
							<text
								key={channel}
								flexShrink={0}
								fg={on ? colors.success : colors.muted}
								bg={focused ? alpha(colors.primary, 0.18) : undefined}
								onMouseDown={() => state.toggle(channel)}
							>
								{`${on ? icons.checkOn : icons.checkOff} ${CHANNEL_LABELS[channel]}`}
							</text>
						);
					})}
				</box>
			) : null}
		</box>
	);
}

/**
 * The bottom-border hint. A failure or a fetch in flight always wins the line —
 * "could not load versions" is the only place that news is shown, so it must not
 * be displaced by an explanation of the option that happens to be selected.
 *
 * @param latest what "latest" promises, when that is the selected option.
 */
function fieldHint(
	state: ServerVersionsState,
	count: number,
	latest?: string,
): string {
	if (state.error) return `could not load versions — ${state.error}`;
	if (state.loading) return "loading versions…";
	if (latest !== undefined) return latest;
	if (state.all.length === 0) return "no versions published";
	return `${count} of ${state.all.length} versions`;
}

/**
 * One version's label. Releases carry their id alone — they are the bulk of the
 * list and the case that needs no explaining. Anything else names its channel,
 * so an opted-in snapshot is never mistaken for a release two rows above it.
 */
function describe(version: VersionInfo): string {
	if (version.type === "release") return version.id;
	const name = CHANNEL_LABELS[version.type].replace(/s$/, "").toLowerCase();
	return `${version.id} (${name})`;
}
