/**
 * Content — what has been added to this server: the mods, plugins and datapacks
 * actually installed on disk, and the resource pack it asks clients to download.
 *
 * Every row is read out of the item's *own* manifest (`fabric.mod.json`,
 * `META-INF/mods.toml`, `plugin.yml`, `pack.mcmeta`) by
 * `core/server/content.ts`, so the list says what each mod calls itself rather
 * than what its filename happens to be. A jar whose manifest MCTL cannot read
 * still appears — under a name derived from its filename, marked as such —
 * because "installed but unreadable" is information, and hiding it would make
 * the count disagree with the directory.
 *
 * Page-layer (AGENTS.md § 3): every value arrives on a view model from
 * `hooks/use-server-content.ts`; this file reads no files and renames nothing.
 *
 * **Each row leads with the item's own icon**, the logo its manifest points at
 * (or the PNG at the root of its archive), extracted by the same core service
 * and arriving here as a *path* — an `<image>` renderable takes it from there and
 * draws it with Kitty graphics, Sixel or Unicode blocks depending on the
 * terminal. An item that ships none draws {@link PLACEHOLDER_ICON} instead, so
 * the column is a column rather than a scatter; below {@link ICON_ROW_WIDTH} it
 * is dropped entirely.
 *
 * The list is **rows separated by a rule, with no selected row**: the checkbox on
 * each row is the only control, so there is nothing for a caret to point at. That
 * is also why the items arrive in plain name order — see `core/server/content.ts`.
 *
 * **The sections are a nested tab bar, not one stacked page.** A modpack server
 * carries a hundred mods at three rows apiece, so a single column put the
 * datapacks and the resource pack hundreds of rows below the fold. Each section
 * — plus the resource pack and the on-disk totals — is its own screen behind a
 * second {@link Tabs} bar, which is pinned while only the screen under it
 * scrolls (this tab is therefore in the container's `TAB_OWNS_SCROLL`: an inner
 * scrollbox needs a definite height, which a surrounding one cannot give it).
 *
 * The bar answers ←/→ while it holds the page's focus ring, which is the tab's
 * only keyboard: the rows themselves still have no caret, and switching an item
 * is the checkbox's click.
 *
 * **Enabling and disabling is a rename**, to and from `*.jar.disabled` — the
 * ecosystem's own convention, and the reason a disabled jar is listed at all.
 * It takes effect at the server's next start, because loaders read `mods/` once
 * during boot; the toast says so rather than letting the checkbox imply a live
 * change. **Datapacks have no switch**: the *world* records which are enabled,
 * so renaming one would leave `level.dat` naming a pack that no longer exists —
 * said out loud in the section rather than offered and quietly broken.
 *
 * The resource pack is read straight out of `server.properties`' raw map: it is
 * three loosely-related keys rather than a modelled field, and only servers that
 * set one have them at all.
 *
 * TODO(phase-5): the *Browse marketplace* buttons are deliberate placeholders —
 * installing content needs the Modrinth/CurseForge integration, which is a
 * Phase-5 subsystem. They report that rather than doing nothing silently.
 */

import type { BoxProps } from "@opentui/react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import {
	Button,
	Checkbox,
	ScrollBox,
	Tabs,
	type TabItem,
} from "../../../components/index.ts";
import type { FocusItem } from "../../../hooks/use-focus-ring.ts";
import { useHints } from "../../../hooks/use-hints.tsx";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useServerContent } from "../../../hooks/use-server-content.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { formatBytes } from "../../../lib/format.ts";
import { PLACEHOLDER_ICON } from "./content-placeholder.ts";
import type {
	ContentItem,
	ContentSection,
} from "../../../core/server/content.ts";
import { Detail, EmptyNote, Panel, type ServerTabProps } from "../panels.tsx";

/**
 * One screen of the Content tab: a content section, or one of the two summary
 * panels that are not sections at all.
 */
type ContentSubTabId = ContentSection["id"] | "resource" | "disk";

/** Ring id of the nested section bar — the tab's first stop, so ←/→ are there on arrival. */
export const CONTENT_TABS_ID = "__content-tabs";

/** Ring id of the screen's *Browse marketplace* button. */
export const CONTENT_MARKET_ID = "__content-market";

/** Ring id of the screen's list of installed items. */
export const CONTENT_LIST_ID = "__content-list";

/**
 * What the container needs to know about the screen currently on show, so it can
 * build this tab's ring members.
 *
 * It travels up through `ServerTabProps.onContentState` for the same reason the
 * Settings tab's form state does: a member's `disabled` must be the *same
 * expression* as its control's, and which controls exist depends on the sub-tab —
 * a fact that lives here. A stop that lands on nothing is what that rule prevents.
 */
export interface ServerContentTabState {
	/** Whether the screen offers a marketplace button at all. */
	market: boolean;
	/** How many rows its list has; `0` when the screen has no list. */
	rows: number;
}

/**
 * This tab's contribution to the container's focus ring, in Tab order: the
 * section bar, the screen's one button, then its list.
 *
 * The ids are always present and merely *disabled* where the control is not on
 * screen, so Tab does not renumber under the user's fingers as they move between
 * sections.
 */
export function serverContentRingIds(
	state: ServerContentTabState,
): FocusItem[] {
	return [
		CONTENT_TABS_ID,
		{ id: CONTENT_MARKET_ID, disabled: !state.market },
		{ id: CONTENT_LIST_ID, disabled: state.rows === 0 },
	];
}

/** Human title per section, in the order the tab lists them. */
const SECTION_TITLES: Record<ContentSection["id"], string> = {
	mods: "Mods",
	plugins: "Plugins",
	datapacks: "Datapacks",
};

/**
 * What each section's marketplace button would search. Phase-5 wiring; the
 * strings exist now so the placeholder can at least be specific about what it
 * will do.
 */
const SECTION_MARKETS: Record<ContentSection["id"], string> = {
	mods: "Modrinth and CurseForge mods",
	plugins: "Modrinth and Hangar plugins",
	datapacks: "Modrinth datapacks",
};

/**
 * Terminal width at or above which a row spells out its version, loader and
 * size beside the name. Below it those are dropped: a row that wraps turns the
 * list into a wall, and the name plus its enabled state is the part that has to
 * survive.
 */
const DETAILED_ROW_WIDTH = 72;

/**
 * Terminal width at or above which rows carry their item's icon. Below it the
 * seven cells the column costs are worth more to the name than to the picture.
 */
const ICON_ROW_WIDTH = 64;

/**
 * The icon's cell box, and with it the height of every row.
 *
 * **Six cells by three is *square*, not oblong**: a terminal cell is roughly
 * twice as tall as it is wide, so a picture three rows high needs six columns to
 * come out with its aspect intact. Giving it three of each draws a logo at half
 * width.
 *
 * Three rows is also exactly a name line plus a two-line description, so the
 * picture sits beside the text rather than making the list taller. Rows are a
 * fixed three tall so the list reads as a column of even cards — a row that
 * sized itself to its own description would step between two and three and make
 * the rules beneath them uneven.
 */
const ICON_WIDTH = 6;
const ICON_HEIGHT = 3;

/**
 * Rows the description is given. It **wraps** into them rather than being
 * truncated to one line: manifest descriptions run to a sentence or two, and two
 * rows is enough for nearly all of them. Anything longer is clipped by the box —
 * OpenTUI wraps text regardless of `overflow`, which only hides what the wrap
 * produced, and that is exactly the behaviour wanted here.
 */
const DESCRIPTION_ROWS = 2;

/** `1.2 MB`, or nothing at all for an unpacked datapack (a folder has no size). */
function sizeLabel(item: ContentItem): string | undefined {
	return item.sizeBytes === undefined ? undefined : formatBytes(item.sizeBytes);
}

/**
 * Cells reserved at the head of every row for the selection caret.
 *
 * Reserved on *every* row, not just the selected one: a caret that inserted
 * itself would shift the whole row sideways as the selection moved, which reads
 * as the list twitching rather than as a caret travelling down it.
 */
const CARET_WIDTH = 2;

/**
 * Where a row's second line starts, so it sits under the item's name rather than
 * under its checkbox. Derived, not eyeballed: the {@link Checkbox}'s frame pays a
 * cell of padding, `[x]` is three, and the caption is a cell further along.
 */
const ROW_TEXT_INDENT = 5;

/**
 * One installed item: a checkbox carrying its name, and — when there is room —
 * the version, the manifest it came from and its size.
 *
 * The checkbox *is* the control: clicking it enables or disables the item, so a
 * row has no selected state and nothing else on it is clickable. `last` drops the
 * separator under the final row — the rule belongs *between* items, and one under
 * the bottom of the list would read as the section having a footer.
 *
 * The description is a dimmed block under the name rather than a column:
 * manifest descriptions run to a sentence or more, and a column that wide would
 * push everything else off a normal terminal. It is given two rows and wraps
 * into them, which — with the icon three cells tall beside it — is what makes
 * every row exactly three rows high.
 */
function ContentRow({
	item,
	detailed,
	icons: showIcons,
	last,
	selected,
	listFocused,
	onSelect,
	onToggle,
}: {
	item: ContentItem;
	detailed: boolean;
	/** Whether this section reserves the leading icon column at all. */
	icons: boolean;
	last: boolean;
	/** Whether the list's caret is on this row. */
	selected: boolean;
	/** Whether the *list* holds the page's focus ring. */
	listFocused: boolean;
	/** Move the caret here — a click on the row selects it as well as toggling. */
	onSelect: () => void;
	onToggle: () => void;
}) {
	const { colors } = useTheme();
	const { icons } = useIcons();

	// A disabled item is still installed, so it is dimmed rather than hidden or
	// marked as an error — nothing is wrong with a parked mod.
	const ink = item.enabled ? colors.foreground : colors.muted;
	const facts = [
		item.version,
		item.loader,
		item.directory ? "folder" : sizeLabel(item),
	].filter((fact): fact is string => fact !== undefined && fact !== "");

	// The separator is applied as a *pair* of props or not at all: a `borderColor`
	// on a box with `border` false (or absent) makes OpenTUI infer that a border
	// was wanted and draw all four sides, so the last row would end up in a box of
	// its own. Verified in a rendered frame — see `memory.md`.
	const rule: BoxProps = last
		? {}
		: { border: ["bottom"], borderColor: colors.border };

	const body = (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="row" gap={1} alignItems="center">
				{/* The checkbox is drawn for datapacks too, showing them as present —
				    clicking one raises the toast that says why it cannot change. */}
				<Checkbox
					noBorder
					// boxed
					caption={item.name}
					captionColor={ink}
					checked={item.enabled}
					onChange={onToggle}
				/>
				{detailed ? (
					<>
						<box flexGrow={1} />
						<text
							fg={colors.muted}
							flexShrink={0}
							paddingRight={1}
							truncate
							wrapMode="none"
						>
							{facts.join(` ${icons.separator} `)}
						</text>
					</>
				) : null}
			</box>
			{/*
			 * Padding lives on a wrapping box: a `<text>` renderable ignores it.
			 * The box is a fixed two rows tall and clips, so a long description
			 * wraps into the space the row already reserves and a short one leaves
			 * the row exactly as tall as every other.
			 */}
			<box
				paddingLeft={ROW_TEXT_INDENT}
				paddingRight={1}
				height={DESCRIPTION_ROWS}
				overflow="hidden"
			>
				<text fg={colors.muted}>
					{item.derivedName
						? `${item.file} ${icons.separator} no readable manifest, so this is the filename`
						: (item.description ?? "")}
				</text>
			</box>
		</box>
	);

	// The caret is drawn even when the list does not hold the ring, in the muted
	// ink instead of the accent: it is *where the keyboard would land*, which stays
	// true — and useful — while the focus sits on the bar above.
	const caret = (
		<text
			flexShrink={0}
			width={CARET_WIDTH}
			fg={listFocused ? colors.primary : colors.muted}
		>
			{selected ? icons.caret : " "}
		</text>
	);

	// A row that is not the selected one still reports a click, so the pointer and
	// the keyboard agree about where the caret is.
	return (
		<box flexDirection="row" gap={1} {...rule} onMouseDown={onSelect}>
			{caret}
			{!showIcons ? null : (
				<>
					{/*
					 * The column is reserved whether or not *this* item has an icon, so the
					 * names in a section stay in one line rather than stepping in and out by
					 * seven cells depending on what each jar happened to ship.
					 *
					 * `cover` fills the box and centre-crops. A mod logo is very nearly
					 * always square, so there is nothing to crop; what this buys is that a
					 * logo which is *not* square still fills the column instead of sitting
					 * letterboxed inside it, which reads as a broken picture at this size.
					 * The protocol is left at `auto`, which resolves to Kitty or Sixel where
					 * the terminal has them and Unicode half-blocks everywhere else — under
					 * tmux that is always blocks.
					 */}
					{/*
					 * The explicit background is what makes a transparent picture work. The
					 * block renderer blends a sampled alpha into whatever the frame buffer
					 * already holds for that cell, and an unpainted cell holds *black* — so
					 * a logo with a transparent ground (most of them) draws its corners as
					 * black squares. Painting the theme's own background here first gives
					 * the blend something correct to land on. Found in a rendered frame.
					 */}
					<box
						width={ICON_WIDTH}
						height={ICON_HEIGHT}
						flexShrink={0}
						backgroundColor={colors.background}
					>
						{/*
						 * The size goes on the `<image>` itself, not only on this box. An
						 * unsized image is laid out `auto` and draws at a fraction of the
						 * space its parent reserved — the box alone keeps the *names*
						 * aligned but leaves the picture small and adrift inside it.
						 *
						 * An item that ships no icon draws the placeholder rather than
						 * leaving a hole: plenty of jars have no logo at all (and every
						 * `plugin.yml` declares none), so an empty box is the common case,
						 * not the exception, and a column of them reads as a rendering
						 * failure rather than as "this one shipped no picture".
						 */}
						<image
							source={item.icon ?? PLACEHOLDER_ICON}
							fit="cover"
							width={ICON_WIDTH}
							height={ICON_HEIGHT}
						/>
					</box>
				</>
			)}
			{body}
		</box>
	);
}

/** A section's list, or the one line explaining why it has nothing to show. */
function SectionBody({
	section,
	detailed,
	icons,
	selectedKey,
	listFocused,
	onSelect,
	onToggle,
}: {
	section: ContentSection;
	detailed: boolean;
	icons: boolean;
	/** Key of the row the caret is on, if any. */
	selectedKey: string | undefined;
	/** Whether the list holds the page's focus ring. */
	listFocused: boolean;
	onSelect: (item: ContentItem) => void;
	onToggle: (item: ContentItem) => void;
}) {
	if (!section.present) {
		return (
			<EmptyNote>
				{`This server has no ${section.directory} directory, so it takes no ${SECTION_TITLES[section.id].toLowerCase()}.`}
			</EmptyNote>
		);
	}
	if (section.items.length === 0) {
		return <EmptyNote>{`${section.directory} is empty.`}</EmptyNote>;
	}
	return (
		<box flexDirection="column">
			{section.items.map((item, index) => (
				<ContentRow
					key={item.key}
					item={item}
					detailed={detailed}
					icons={icons}
					last={index === section.items.length - 1}
					selected={item.key === selectedKey}
					listFocused={listFocused}
					onSelect={() => onSelect(item)}
					onToggle={() => onToggle(item)}
				/>
			))}
		</box>
	);
}

export function ContentTab({
	server,
	insight,
	size,
	focus,
	onContentState,
}: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const toast = useToast();
	const { listing, loading, toggle } = useServerContent(
		server,
		insight?.properties?.levelName,
	);
	const [sub, setSub] = useState<ContentSubTabId>("mods");
	const [selectedKey, setSelectedKey] = useState<string>();
	const empty = icons.emptyValue;
	const raw = insight?.properties?.raw ?? {};
	const measuring = `measuring${icons.ellipsis}`;
	const detailed = width >= DETAILED_ROW_WIDTH;

	const packUrl = raw["resource-pack"] ?? "";
	const packRequired = raw["require-resource-pack"] === "true";

	// Only ever a count: the rows carry no selection, so the tab has no reason to
	// flatten the sections into one sequence beyond knowing whether the first
	// listing has landed yet.
	const installed = listing.sections.reduce(
		(total, section) => total + section.items.length,
		0,
	);

	const sectionOf = (item: ContentItem) =>
		listing.sections.find((section) => section.id === item.section);

	const market = (section: ContentSection["id"]) => {
		toast.info(`${SECTION_TITLES[section]} marketplace is not built yet`, {
			description: `Installing from ${SECTION_MARKETS[section]} arrives with the Phase-5 catalogue integration.`,
		});
	};

	const run = async (item: ContentItem) => {
		if (!sectionOf(item)?.toggleable) {
			toast.warning(`${item.name} cannot be switched here`, {
				description:
					"A world records which datapacks are on, so they are enabled in game with /datapack, not by renaming the file.",
			});
			return;
		}
		const enabling = !item.enabled;
		const failure = await toggle(item, enabling);
		if (failure) {
			toast.error(`Could not ${enabling ? "enable" : "disable"} ${item.name}`, {
				description: failure,
			});
			return;
		}
		// What actually happened, and when it will matter: a loader reads its
		// directory once at boot, so a toggle on a running server changes nothing
		// until it restarts. Saying "enabled" alone would misrepresent that.
		// toast.success(`${enabling ? "Enabled" : "Disabled"} ${item.name}`, {
		// 	description:
		// 		server.state === "running"
		// 			? `Renamed on disk. ${server.id} is running, so it takes effect on the next restart.`
		// 			: "Renamed on disk. It takes effect the next time this server starts.",
		// });
	};

	/** A section's panel: its counts and its marketplace button, then its rows. */
	const panel = (section: ContentSection) => {
		// A kind that does not load this sort of content has no panel at all: a
		// Paper server is not a Fabric server missing its mods, and an empty "Mods"
		// list implies mods are a thing it could be given.
		//
		// Unless files are there anyway — someone dropped a Fabric jar into a Paper
		// server's `mods/`. Then the panel is drawn *and says so*, because a jar
		// that will never load is exactly the thing a user needs told.
		if (!section.supported && section.items.length === 0) return null;
		const enabled = section.items.filter((item) => item.enabled).length;
		const disabled = section.items.length - enabled;
		return (
			<box key={section.id} paddingBottom={1}>
				{section.supported ? null : (
					<box marginBottom={1}>
						<text fg={colors.warning} truncate wrapMode="none">
							{`${icons.warning} A ${server.kind} server does not load ${SECTION_TITLES[section.id].toLowerCase()} — these files are ignored.`}
						</text>
					</box>
				)}
				<box
					flexDirection="row"
					justifyContent="space-between"
					alignItems="center"
					gap={1}
				>
					<text fg={colors.muted} truncate wrapMode="none">
						{section.present
							? `${icons.folder}  ${section.directory} ${icons.separator} ${enabled} enabled${disabled > 0 ? `, ${disabled} disabled` : ""}`
							: `${icons.folder}  ${section.directory} ${icons.separator} ${empty} (no directory)`}
					</text>
					{/* No marketplace where nothing from it could ever load. */}
					{section.supported ? (
						<Button
							size="small"
							kind="ghost"
							variant="info"
							focused={focus?.isFocused(CONTENT_MARKET_ID)}
							onFocused={() => focus?.setFocus(CONTENT_MARKET_ID)}
							onClick={() => market(section.id)}
						>
							Browse marketplace
						</Button>
					) : null}
				</box>
				<box
					// marginTop={1}
					flexDirection="column"
					border={["top", "bottom"]}
					borderColor={colors.border}
				>
					<SectionBody
						section={section}
						detailed={detailed}
						selectedKey={selectedKey}
						listFocused={focus?.isFocused(CONTENT_LIST_ID) === true}
						onSelect={(item) => {
							setSelectedKey(item.key);
							focus?.setFocus(CONTENT_LIST_ID);
						}}
						// Every row has a picture now — its own or the placeholder — so
						// the column is reserved whenever the terminal is wide enough to
						// pay for it, rather than depending on what the section's jars
						// happened to ship.
						icons={width >= ICON_ROW_WIDTH}
						onToggle={(item) => void run(item)}
					/>
				</box>
				{section.present && !section.toggleable ? (
					<box marginTop={1}>
						<EmptyNote>
							Enablement lives in the world, not in the filename — use /datapack
							in the console.
						</EmptyNote>
					</box>
				) : null}
			</box>
		);
	};

	const resourcePack = (
		<Panel title="Resource pack">
			<box
				flexDirection="row"
				justifyContent="space-between"
				alignItems="center"
				gap={1}
			>
				<text fg={colors.muted} truncate wrapMode="none">
					{packUrl === "" ? "none configured" : "server-provided"}
				</text>
				<Button
					size="small"
					kind="ghost"
					variant="info"
					focused={focus?.isFocused(CONTENT_MARKET_ID)}
					onFocused={() => focus?.setFocus(CONTENT_MARKET_ID)}
					onClick={() =>
						toast.info("Resource pack marketplace is not built yet", {
							description:
								"Picking a pack and publishing it to clients arrives with the Phase-5 catalogue integration.",
						})
					}
				>
					Browse marketplace
				</Button>
			</box>
			<box marginTop={1} flexDirection="column">
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
			</box>
		</Panel>
	);

	const onDisk = (
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

	// Only the sections that would draw a panel become sub-tabs, by exactly the
	// rule `panel()` applies: a bar entry leading to an explanation of why there
	// is nothing there is worse than no entry at all.
	const sections = listing.sections.filter(
		(section) => section.supported || section.items.length > 0,
	);

	// The count rides on the label because it is the number the bar exists for —
	// which section is worth opening. A section whose directory is absent shows no
	// count rather than `(0)`: "not a thing here" and "empty" are different, and
	// the panel says which.
	const items: TabItem[] = [
		...sections.map((section) => ({
			id: section.id,
			label: section.present
				? `${SECTION_TITLES[section.id]} ${section.items.length}`
				: SECTION_TITLES[section.id],
		})),
		{ id: "resource", label: "Resource pack" },
		{ id: "disk", label: "On disk" },
	];

	// Derived rather than corrected in an effect: the sections land a round after
	// mount, so the remembered id names nothing on the first frames (and stops
	// naming anything if a kind's last stray jar is removed under it). Falling back
	// to the first entry keeps the bar and the body in agreement without a write.
	// `items` is never empty — the last two entries do not depend on the listing.
	const active = (
		items.some((item) => item.id === sub) ? sub : items[0]?.id
	) as ContentSubTabId;
	const shown = sections.find((section) => section.id === active);
	const rows = shown?.items ?? [];

	// Keep the caret alive across polls and re-seed it when the screen changes.
	// Keyed on the *keys*, not on `rows`: the listing is rebuilt every poll, so the
	// array identity changes constantly while its membership rarely does.
	const rowKeys = rows.map((item) => item.key).join("|");
	useEffect(() => {
		const keys = rowKeys === "" ? [] : rowKeys.split("|");
		if (keys.length === 0) {
			if (selectedKey !== undefined) setSelectedKey(undefined);
			return;
		}
		if (!selectedKey || !keys.includes(selectedKey)) setSelectedKey(keys[0]);
	}, [rowKeys, selectedKey]);

	// The container owns the ring, so it needs the two facts only this tab has:
	// whether the screen on show has a button, and whether it has any rows.
	const hasMarket = shown ? shown.supported : active === "resource";
	useEffect(() => {
		onContentState?.({ market: hasMarket, rows: rows.length });
		// Leaving the tab would otherwise strand these members in the container's
		// ring for the *next* tab.
		return () => onContentState?.({ market: false, rows: 0 });
	}, [hasMarket, rows.length, onContentState]);

	const listFocused = focus?.isFocused(CONTENT_LIST_ID) === true;
	const selected = rows.find((item) => item.key === selectedKey);

	const move = (delta: number) => {
		if (rows.length === 0) return;
		const from = rows.findIndex((item) => item.key === selectedKey);
		const next = Math.max(0, Math.min(rows.length - 1, from + delta));
		setSelectedKey(rows[next]?.key);
	};

	// The list answers keys only while it holds the ring — otherwise ←/→ belong to
	// one of the two tab bars, exactly as they do on the Players grid. Space is the
	// keyboard peer of the row's checkbox; Enter does the same, because a list of
	// checkboxes is one of the few places both readings are obvious.
	useKeyboard((key) => {
		if (!listFocused) return;
		if (key.name === "down" || key.name === "j") move(1);
		else if (key.name === "up" || key.name === "k") move(-1);
		else if (key.name === "space" || key.name === "return") {
			if (selected) void run(selected);
		}
	});

	// Both sets are registered against the same key signatures the container
	// advertises, so a context hint *replaces* "switch tab" rather than
	// contradicting it: on this tab the arrows move within the page, and the strip
	// says which "within" is currently under them.
	useHints(
		[{ keys: [icons.arrowLeft, icons.arrowRight], label: "switch section" }],
		{ scope: "context", active: focus?.isFocused(CONTENT_TABS_ID) === true },
	);
	useHints(
		[
			{ keys: [icons.arrowUp, icons.arrowDown], label: "select item" },
			{ keys: "Space", label: "enable / disable" },
			{ keys: "Tab", label: "leave list" },
		],
		{ scope: "context", active: listFocused },
	);

	const body = shown ? (
		<>
			{panel(shown)}
			{shown.present && shown.toggleable ? (
				<EmptyNote>
					{`Disabling renames a jar to *${".jar.disabled"}, which every loader ignores. Nothing is deleted, and it takes effect at the next start.`}
				</EmptyNote>
			) : null}
		</>
	) : active === "disk" ? (
		onDisk
	) : (
		resourcePack
	);

	return (
		// The bar is pinned and only the screen under it scrolls, which is the whole
		// point of the split: a hundred-mod list must not carry the section bar off
		// the top of the terminal with it.
		<box flexDirection="column" flexGrow={1}>
			<Tabs
				items={items}
				activeId={active}
				onChange={(next) => setSub(next as ContentSubTabId)}
				focused={focus?.isFocused(CONTENT_TABS_ID)}
				onFocused={() => focus?.setFocus(CONTENT_TABS_ID)}
				paddingX={1}
			/>
			{/* `key` remounts on a switch, so each screen opens at its own top rather
			    than inheriting the previous one's scroll offset. */}
			<ScrollBox key={active} flexGrow={1} enableAccel>
				<box flexDirection="column" paddingX={1}>
					{loading && installed === 0 ? (
						<box paddingBottom={1}>
							<EmptyNote>Reading what is installed…</EmptyNote>
						</box>
					) : null}
					{body}
				</box>
			</ScrollBox>
		</box>
	);
}
