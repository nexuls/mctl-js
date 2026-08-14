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
 * is also why the items arrive in plain name order — see `core/server/content.ts`
 * — and why the tab takes no keys at all.
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
import { useTerminalDimensions } from "@opentui/react";
import { Button, Checkbox } from "../../../components/index.ts";
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
import {
	Columns,
	Detail,
	EmptyNote,
	Panel,
	TWO_COLUMN_WIDTH,
	type ServerTabProps,
} from "../panels.tsx";

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
	onToggle,
}: {
	item: ContentItem;
	detailed: boolean;
	/** Whether this section reserves the leading icon column at all. */
	icons: boolean;
	last: boolean;
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

	if (!showIcons) return <box {...rule}>{body}</box>;

	return (
		<box flexDirection="row" gap={1} {...rule}>
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
			{body}
		</box>
	);
}

/** A section's list, or the one line explaining why it has nothing to show. */
function SectionBody({
	section,
	detailed,
	icons,
	onToggle,
}: {
	section: ContentSection;
	detailed: boolean;
	icons: boolean;
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
					onToggle={() => onToggle(item)}
				/>
			))}
		</box>
	);
}

export function ContentTab({ server, insight, size }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const toast = useToast();
	const { listing, loading, toggle } = useServerContent(
		server,
		insight?.properties?.levelName,
	);
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

	// No keyboard handler and no context hints: the list has no caret to move, so
	// the tab claims none of the page's keys and ←/→ always belong to the tab bar.
	// Switching an item is the checkbox's click; the keyboard peer is
	// `mctl content enable|disable`.

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
			<Panel key={section.id} title={SECTION_TITLES[section.id]}>
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
							onClick={() => market(section.id)}
						>
							Browse marketplace
						</Button>
					) : null}
				</box>
				<box marginTop={1} flexDirection="column">
					<SectionBody
						section={section}
						detailed={detailed}
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
			</Panel>
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

	return (
		<box flexDirection="column" paddingX={1}>
			{loading && installed === 0 ? (
				<box paddingBottom={1}>
					<EmptyNote>Reading what is installed…</EmptyNote>
				</box>
			) : null}

			{/* The lists take the full width: a mod's name, version and description
			    on one row is already most of a terminal, and halving it would leave
			    every row truncated. Only the two summary panels below share a row. */}
			{listing.sections.map((section) => panel(section))}

			<Columns
				wide={width >= TWO_COLUMN_WIDTH}
				left={resourcePack}
				right={onDisk}
				paddingX={0}
			/>

			<EmptyNote>
				{`Disabling renames a jar to *${".jar.disabled"}, which every loader ignores. Nothing is deleted, and it takes effect at the next start.`}
			</EmptyNote>
		</box>
	);
}
