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
 * **Enabling and disabling is a rename**, to and from `*.jar.disabled` — the
 * ecosystem's own convention, and the reason a disabled jar is listed at all.
 * It takes effect at the server's next start, because loaders read `mods/` once
 * during boot; the toast says so rather than letting the switch imply a live
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

import { TextAttributes } from "@opentui/core";
import { useEffect, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Button } from "../../../components/index.ts";
import { useHints } from "../../../hooks/use-hints.tsx";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useServerContent } from "../../../hooks/use-server-content.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { formatBytes } from "../../../lib/format.ts";
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

/** `1.2 MB`, or nothing at all for an unpacked datapack (a folder has no size). */
function sizeLabel(item: ContentItem): string | undefined {
	return item.sizeBytes === undefined ? undefined : formatBytes(item.sizeBytes);
}

/**
 * One installed item: a checkbox, its name, and — when there is room — the
 * version, the manifest it came from and its size.
 *
 * The description is a second, dimmed line rather than a column: manifest
 * descriptions run to a sentence or more, and a column that wide would push
 * everything else off a normal terminal.
 */
function ContentRow({
	item,
	selected,
	detailed,
	onSelect,
	onToggle,
}: {
	item: ContentItem;
	selected: boolean;
	detailed: boolean;
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

	return (
		<box
			flexDirection="column"
			paddingX={1}
			backgroundColor={selected ? colors.border : undefined}
			onMouseDown={() => (selected ? onToggle() : onSelect())}
		>
			<box flexDirection="row" gap={1} alignItems="center">
				<text fg={selected ? colors.primary : colors.muted} flexShrink={0}>
					{selected ? icons.caret : " "}
				</text>
				{/* The checkbox is drawn for datapacks too, showing them as present —
				    it simply never changes, and the section says why. */}
				<text fg={item.enabled ? colors.success : colors.muted} flexShrink={0}>
					{`[${item.enabled ? icons.checkOn : icons.checkOff}]`}
				</text>
				<text
					fg={ink}
					attributes={item.enabled ? TextAttributes.BOLD : undefined}
					truncate
					wrapMode="none"
					flexShrink={1}
				>
					{item.name}
				</text>
				{detailed ? (
					<>
						<box flexGrow={1} />
						<text fg={colors.muted} flexShrink={0} truncate wrapMode="none">
							{facts.join(` ${icons.separator} `)}
						</text>
					</>
				) : null}
			</box>
			{item.description ? (
				<text fg={colors.muted} truncate wrapMode="none">
					{`      ${item.description}`}
				</text>
			) : null}
			{item.derivedName ? (
				<text fg={colors.muted} truncate wrapMode="none">
					{`      ${item.file} ${icons.separator} no readable manifest, so this is the filename`}
				</text>
			) : null}
		</box>
	);
}

/** A section's list, or the one line explaining why it has nothing to show. */
function SectionBody({
	section,
	selectedKey,
	detailed,
	onSelect,
	onToggle,
}: {
	section: ContentSection;
	selectedKey: string | undefined;
	detailed: boolean;
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
			{section.items.map((item) => (
				<ContentRow
					key={item.key}
					item={item}
					selected={item.key === selectedKey}
					detailed={detailed}
					onSelect={() => onSelect(item)}
					onToggle={() => onToggle(item)}
				/>
			))}
		</box>
	);
}

export function ContentTab({ server, insight, size, focused }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const toast = useToast();
	const { listing, loading, toggle } = useServerContent(
		server,
		insight?.properties?.levelName,
	);
	const [selectedKey, setSelectedKey] = useState<string>();

	const empty = icons.emptyValue;
	const raw = insight?.properties?.raw ?? {};
	const measuring = `measuring${icons.ellipsis}`;
	const detailed = width >= DETAILED_ROW_WIDTH;

	const packUrl = raw["resource-pack"] ?? "";
	const packRequired = raw["require-resource-pack"] === "true";

	// One flat sequence in display order, so the caret moves between sections
	// without the page having to know which one it is in — the same shape the
	// Players tab's grid uses.
	const ordered = listing.sections.flatMap((section) => section.items);
	const orderedKeys = ordered.map((item) => item.key).join("|");

	// Keep the selection alive across polls and seed it on the first listing.
	// Keyed on the *keys* rather than on `ordered`: the listing is rebuilt every
	// round, so the array identity changes while its membership rarely does.
	useEffect(() => {
		const keys = orderedKeys === "" ? [] : orderedKeys.split("|");
		if (keys.length === 0) {
			if (selectedKey !== undefined) setSelectedKey(undefined);
			return;
		}
		if (!selectedKey || !keys.includes(selectedKey)) setSelectedKey(keys[0]);
	}, [orderedKeys, selectedKey]);

	const selected = ordered.find((item) => item.key === selectedKey);
	const index = ordered.findIndex((item) => item.key === selectedKey);
	const sectionOf = (item: ContentItem) =>
		listing.sections.find((section) => section.id === item.section);

	const move = (delta: number) => {
		if (ordered.length === 0) return;
		const next = Math.max(0, Math.min(ordered.length - 1, index + delta));
		setSelectedKey(ordered[next]?.key);
	};

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
		toast.success(`${enabling ? "Enabled" : "Disabled"} ${item.name}`, {
			description:
				server.state === "running"
					? `Renamed on disk. ${server.id} is running, so it takes effect on the next restart.`
					: "Renamed on disk. It takes effect the next time this server starts.",
		});
	};

	// The tab only answers the keyboard while it holds the page's focus ring —
	// otherwise ←/→ belong to the tab bar, exactly as they do for the console and
	// the player grid.
	useKeyboard((key) => {
		if (!focused) return;
		if (key.name === "down" || key.name === "j") move(1);
		else if (key.name === "up" || key.name === "k") move(-1);
		else if ((key.name === "space" || key.name === "return") && selected) {
			void run(selected);
		} else if (key.name === "m" && selected) {
			market(selected.section);
		}
	});

	useHints(
		[
			{ keys: [icons.arrowUp, icons.arrowDown], label: "select" },
			{ keys: "Space", label: "enable/disable" },
			{ keys: "m", label: "marketplace" },
		],
		{ scope: "context", active: focused === true },
	);

	/** A section's panel: its counts and its marketplace button, then its rows. */
	const panel = (section: ContentSection) => {
		const enabled = section.items.filter((item) => item.enabled).length;
		const disabled = section.items.length - enabled;
		return (
			<Panel key={section.id} title={SECTION_TITLES[section.id]}>
				<box
					flexDirection="row"
					justifyContent="space-between"
					alignItems="center"
					gap={1}
				>
					<text fg={colors.muted} truncate wrapMode="none">
						{section.present
							? `${icons.folder} ${section.directory} ${icons.separator} ${enabled} enabled${disabled > 0 ? `, ${disabled} disabled` : ""}`
							: `${icons.folder} ${section.directory} ${icons.separator} ${empty} (no directory)`}
					</text>
					<Button
						size="small"
						kind="ghost"
						variant="info"
						onClick={() => market(section.id)}
					>
						Browse marketplace
					</Button>
				</box>
				<box marginTop={1} flexDirection="column">
					<SectionBody
						section={section}
						selectedKey={selectedKey}
						detailed={detailed}
						onSelect={(item) => setSelectedKey(item.key)}
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
			{loading && ordered.length === 0 ? (
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
