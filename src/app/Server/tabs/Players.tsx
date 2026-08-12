/**
 * Players — everyone this server knows about, and what can be done to them.
 *
 * Three groups, in the order they matter: **online** (whoever a live list ping
 * named), then **offline** (the rosters plus anyone with player data on disk),
 * then **banned**. Each player is a card carrying everything the server records
 * about them — game mode, last position, health and hunger from their
 * `playerdata` NBT, and playtime, kills and deaths from their stats file — with
 * their real face from {@link "../../../hooks/use-player-heads".usePlayerHeads}
 * when one can be fetched, and a built-in head picked deterministically from
 * their uuid until then. See {@link PlayerCard} for the card's shape.
 *
 * Page-layer (AGENTS.md § 3): every value arrives on a view model from
 * `hooks/use-players.ts`; this file reads no files and sends no commands. The
 * actions are console commands executed by `core/server/player-admin.ts`.
 *
 * **Honest gaps, stated rather than faked:**
 *  - **Per-player ping does not exist outside the server.** The list-ping
 *    protocol carries MCTL's own round trip and nothing per player; a real
 *    per-player latency needs RCON or a plugin (`TODO(phase-5)`).
 *  - **Nor does current session length.** Playtime is the lifetime counter from
 *    the stats file; "last seen" is the last time player data was written.
 *  - The ping returns only a **sample** of names, so a server that truncates or
 *    disables it leaves connected players unnamed — said out loud rather than
 *    letting the cards pass for the full list.
 *
 * **Responsiveness is layout, not reflow.** The card grid fits its cards to the
 * measured width of a section's interior: as many columns as fit at
 * {@link CARD_MIN_WIDTH_WITH_HEAD}, then every card widened to an equal share of
 * what is actually there, so two columns are half the row each and three a third.
 * The heads — the widest thing on a card — are dropped below
 * {@link HEAD_MIN_WIDTH}, which narrows the minimum by nine cells.
 */

import { useEffect, useRef, useState } from "react";
import type { BoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
	MinecraftHead,
	ScrollBox,
	skinFor,
	useBoxWidth,
} from "../../../components/index.ts";
import { useHints } from "../../../hooks/use-hints.tsx";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { usePlayerHeads } from "../../../hooks/use-player-heads.ts";
import { usePlayers } from "../../../hooks/use-players.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { formatDuration } from "../../../lib/format.ts";
import { commandFor, playerAction } from "../../../core/server/player-admin.ts";
import type { PlayerProfile } from "../../../core/server/players.ts";
import type { HeadSkin } from "../../../types/skin.ts";
import { EmptyNote, type ServerTabProps } from "../panels.tsx";
import { PlayerActionsDialog } from "../PlayerActionsDialog.tsx";

/**
 * Terminal width at or above which player heads are drawn. A head is 8 cells
 * wide plus its gap, which is a quarter of a card — below this the cards would
 * be mostly portrait and no data.
 */
const HEAD_MIN_WIDTH = 84;

/**
 * The narrowest a card may be drawn, with a head and without one. These decide
 * the **column count** only — the cards are then stretched to fill the row, so
 * these are a floor, not the width anything actually renders at.
 *
 * With a head: 4 cells of border and padding, 9 for the head and its gap, and
 * ~23 for the game-mode/kills/deaths line (`Survival 12.4k Kills 12.4k Deaths`
 * shortens gracefully; `Survival 1 Kill 1 Death` does not). Without a head the
 * floor drops by exactly the head's nine cells.
 *
 * The position line (`Last Position: Overworld(-2, 56, 105)`, ~37 cells) is the
 * first thing to clip and is deliberately *not* what sets the floor: sizing
 * every card to the longest coordinate a world can produce would cost a whole
 * column on a 100-cell terminal to spell out one line in full.
 */
const CARD_MIN_WIDTH_WITH_HEAD = 52;
const CARD_MIN_WIDTH_PLAIN = CARD_MIN_WIDTH_WITH_HEAD - 9;

/**
 * The widest a card is stretched to. A single card spread across a 130-cell
 * terminal is four lines of text in a field of whitespace; past this the grid
 * leaves the surplus empty instead.
 */
const CARD_MAX_WIDTH = 60;

/** Cells between two cards in a row, matching the row's `gap`. */
const CARD_GAP = 1;

/**
 * Interior width assumed for a section while its real width is unmeasured — the
 * terminal less the shell frame, the tab's padding, the section's border and
 * padding, and the scrollbar. Deliberately an *under*estimate: erring narrow
 * costs a column for one frame, erring wide wraps a card onto its own line and
 * breaks the grid's alignment before the measurement lands.
 */
const SECTION_CHROME = 9;

/**
 * How wide each card is drawn, and how many fit, in a row `available` cells
 * wide. Pure so the arithmetic can be reasoned about on its own: as many columns
 * as fit at `minimum`, then the leftover shared out equally between them.
 *
 * Every card in every row gets the **same** width — the few cells that do not
 * divide evenly are left unused at the right edge rather than making one card in
 * the row a cell wider than its neighbours, which reads as a rendering fault.
 */
function fitCards(
	available: number,
	minimum: number,
): { columns: number; cardWidth: number } {
	// `+ CARD_GAP` on both sides: n columns cost n widths and n-1 gaps, which is
	// (width + gap) per column with one gap's worth of slack added back.
	const columns = Math.max(
		1,
		Math.floor((available + CARD_GAP) / (minimum + CARD_GAP)),
	);
	const share = Math.floor((available - (columns - 1) * CARD_GAP) / columns);
	return {
		columns,
		cardWidth: Math.max(minimum, Math.min(CARD_MAX_WIDTH, share)),
	};
}

/** Minecraft's default health and hunger ceilings, both in half-units. */
const DEFAULT_MAX_HEALTH = 20;
const MAX_FOOD = 20;

/**
 * Icons in a health or hunger meter. Ten, because that is what the game's own
 * HUD draws — twenty half-units render as ten hearts, so a player on 9 health
 * shows four and a half hearts in game and, here, five of ten icons plus the
 * exact percentage beside them.
 */
const METER_ICONS = 10;

/**
 * Width the `Health:` / `Food:` captions are padded to, so the two meters start
 * in the same column. `Health:` is the longer of the two at 7 cells; the eighth
 * is the space between the caption and the first icon.
 */
const METER_LABEL_WIDTH = 8;

/** Which group a card belongs to, which decides what its four lines say. */
type CardKind = "online" | "offline" | "banned";

/** Split `items` into rows of `size` — the grid, laid out by hand. */
function chunk<T>(items: T[], size: number): T[][] {
	const rows: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		rows.push(items.slice(i, i + size));
	return rows;
}

/** `3d 4h ago`, or `—` when nothing recorded a timestamp. */
function ago(at: number | undefined, empty: string): string {
	if (at === undefined) return empty;
	const delta = Date.now() - at;
	return delta < 60_000 ? "just now" : `${formatDuration(delta)} ago`;
}

/** A compact count, so `12480` does not eat a card line. */
function compactCount(value: number | undefined, empty: string): string {
	if (value === undefined) return empty;
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * How many of a meter's ten icons are filled at `value` of `max`.
 *
 * Rounded to the nearest icon, but biased at both ends so the two states that
 * matter are never misread: a player who is alive but nearly dead keeps one
 * heart rather than showing an empty bar, and a player one point short of full
 * loses one rather than reading as untouched. Same rule `ProgressBar` applies to
 * its cells, for the same reason.
 */
function meterFill(value: number, max: number): number {
	if (max <= 0) return 0;
	const fraction = Math.max(0, Math.min(1, value / max));
	const filled = Math.round(fraction * METER_ICONS);
	if (filled === 0 && fraction > 0) return 1;
	if (filled === METER_ICONS && fraction < 1) return METER_ICONS - 1;
	return filled;
}

/**
 * One player meter — a caption, ten icons, and the exact percentage pushed to
 * the card's right edge.
 *
 * Ten icons cannot express 20 half-units on their own (a whole heart is two
 * points), which is why the percentage is spelled out rather than left implied:
 * the icons give the shape at a glance, the readout gives the number.
 */
function StatMeter({
	label,
	value,
	max,
	full,
	empty,
	color,
}: {
	label: string;
	value: number;
	max: number;
	/** Glyph for a remaining point. */
	full: string;
	/** Glyph for a lost one. */
	empty: string;
	color: string;
}) {
	const { colors } = useTheme();
	const filled = meterFill(value, max);
	const percent = max > 0 ? Math.round((value / max) * 100) : 0;
	return (
		// `flexShrink={0}` on all three: the spacer is `flexGrow`, so without it
		// yoga takes the row's slack out of the caption and the icons — a meter
		// that silently renders as a blank gap between "Health:" and "50%".
		<box flexDirection="row" alignItems="center">
			<text fg={colors.muted} flexShrink={0}>
				{label.padEnd(METER_LABEL_WIDTH)}
			</text>
			<text flexShrink={0}>
				<span fg={color}>{full.repeat(filled)}</span>
				<span fg={colors.border}>{empty.repeat(METER_ICONS - filled)}</span>
			</text>
			<box flexGrow={1} />
			<text fg={colors.muted} flexShrink={0}>
				{`${Math.max(0, Math.min(100, percent))}%`}
			</text>
		</box>
	);
}

/**
 * `minecraft:the_nether` → `The Nether`. The namespace is noise on a card, and a
 * modded dimension (`aether:the_aether`) reads correctly under the same rule.
 */
function dimensionLabel(dimension: string): string {
	const bare = dimension.includes(":")
		? (dimension.split(":")[1] ?? dimension)
		: dimension;
	return bare
		.split("_")
		.filter((word) => word.length > 0)
		.map((word) => word[0]?.toUpperCase() + word.slice(1))
		.join(" ");
}

/** `Survival`, `Creative` — the game's own capitalisation. */
function titleCase(text: string): string {
	return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1);
}

/**
 * `1 Kill` / `2 Kills` / `12.4k Kills`. Minecraft's own counters are singular at
 * one, and "1 Kills" on a fresh player's card is the kind of detail that makes a
 * panel look unfinished.
 */
function counted(
	value: number | undefined,
	noun: string,
	empty: string,
): string {
	return `${compactCount(value, empty)} ${noun}${value === 1 ? "" : "s"}`;
}

/**
 * The colour a game mode is named in. Deliberately not one accent for all four:
 * the mode changes what a player can do to the world, so creative and spectator
 * are worth spotting in a grid of cards.
 */
function gameModeColor(
	mode: string,
	colors: ReturnType<typeof useTheme>["colors"],
): string {
	if (mode === "creative") return colors.warning;
	if (mode === "spectator") return colors.muted;
	if (mode === "adventure") return colors.info;
	return colors.secondary;
}

/**
 * One player card, six interior rows tall:
 *
 * ```
 * ╭──────────────────────────────────────── OP ─╮
 * │ ████  BeardStone ● Last Online: 2d ago      │
 * │ ████  6m Played                             │
 * │ ████  Last Position: Overworld(-2, 56, 105) │
 * │ ████  Survival 1 Kill 1 Death               │
 * │ Health: ♥♥♥♥♥♡♡♡♡♡                      50% │
 * │ Food:   ▰▰▰▰▰▰▰▱▱▱                      50% │
 * ╰─────────────────────────────────────────────╯
 * ```
 *
 * The head is 4 rows tall, so the four lines beside it are exactly its height
 * and the two meters below span the card. That total is fixed whatever the card
 * has to say — a player with no data on disk still draws six rows — because a
 * row of cards of differing heights reads as a broken grid.
 *
 * Only the player's *standing* (`OP`/`WL`/`SHADOW`) rides the border; the name
 * shares line 1 with the player's status, which a border title could not hold.
 *
 * Exported for `Players.test.tsx`: the card's promises — six rows whatever the
 * data, ten meter icons, a percentage that agrees with them — are claims about
 * rendered frames, and a frame is the only place they can be checked.
 */
export function PlayerCard({
	player,
	kind,
	selected,
	showHead,
	head,
	width,
	onSelect,
	onActivate,
}: {
	player: PlayerProfile;
	kind: CardKind;
	selected: boolean;
	showHead: boolean;
	/** The player's real face, once one has been fetched. */
	head: HeadSkin | undefined;
	width: number;
	onSelect: () => void;
	onActivate: () => void;
}) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const empty = icons.emptyValue;
	const state = player.state;
	const stats = player.stats;

	const accent =
		kind === "banned"
			? colors.error
			: kind === "online"
				? colors.success
				: colors.muted;

	// Roster standing only. The game mode is *not* a badge any more — it names the
	// player's own line beside their kills and deaths, where the wireframe puts it.
	const badges = [
		player.op
			? `OP${player.op.level < 4 ? ` ${player.op.level}` : ""}`
			: undefined,
		player.whitelisted ? "WL" : undefined,
		player.shadowBan ? "SHADOW" : undefined,
	].filter((badge): badge is string => badge !== undefined);

	const maxHealth = state?.maxHealth ?? DEFAULT_MAX_HEALTH;
	const playtime =
		stats?.playTimeMs === undefined ? empty : formatDuration(stats.playTimeMs);

	/** Line 1's right half: where this player is, in one phrase. */
	const status =
		kind === "banned"
			? `Banned${player.ban?.source ? ` by ${player.ban.source}` : ""}`
			: kind === "online"
				? "Online now"
				: `Last Online: ${ago(player.lastSeen, empty)}`;

	const lines =
		kind === "banned"
			? [
					<text key="reason" fg={colors.foreground} truncate wrapMode="none">
						{player.ban?.reason ?? "No reason given"}
					</text>,
					<text key="created" fg={colors.muted} truncate wrapMode="none">
						{`Banned: ${player.ban?.created ?? empty}`}
					</text>,
					<text key="expires" fg={colors.muted} truncate wrapMode="none">
						{`Expires: ${player.ban?.expires ?? "never"}`}
					</text>,
				]
			: [
					<text key="played" fg={colors.foreground} truncate wrapMode="none">
						{`${playtime} Played`}
					</text>,
					<text key="position" fg={colors.muted} truncate wrapMode="none">
						Last Position:{" "}
						<span fg={colors.info}>
							{state?.position
								? `${dimensionLabel(state.dimension ?? "overworld")}(${state.position.x}, ${state.position.y}, ${state.position.z})`
								: empty}
						</span>
					</text>,
					<text key="kd" truncate wrapMode="none">
						{state?.gameMode ? (
							<span fg={gameModeColor(state.gameMode, colors)}>
								{`${titleCase(state.gameMode)} `}
							</span>
						) : null}
						<span fg={colors.foreground}>
							{`${counted(stats?.playerKills ?? stats?.mobKills, "Kill", empty)} ${counted(stats?.deaths, "Death", empty)}`}
						</span>
					</text>,
				];

	return (
		<box
			width={width}
			flexDirection="column"
			flexShrink={0}
			border
			borderStyle="rounded"
			borderColor={selected ? colors.primary : colors.border}
			// Standing rides the top border, right-aligned — the wireframe's `OP`
			// tab. The name is a body line here rather than a border title: it shares
			// its row with the player's status, and a border can hold only one run of
			// text per side.
			title={badges.length > 0 ? ` ${badges.join(" ")} ` : undefined}
			titleAlignment="right"
			titleColor={selected ? colors.primary : accent}
			paddingX={1}
			onMouseDown={() => (selected ? onActivate() : onSelect())}
		>
			{/* Head + four lines. The head is 4 rows tall, so the column beside it
			    holds exactly four: identity, then three facts. */}
			<box flexDirection="row" gap={1}>
				{/* The player's own face when one has been fetched, else the deterministic
				    built-in `skinFor` picks. The card never waits on the network. */}
				{showHead ? (
					<MinecraftHead skin={head ?? skinFor(player.uuid ?? player.name)} />
				) : null}
				{/* `truncate wrapMode="none"` on every line, not just the long ones: a
				    line that wraps grows the card by a row, and one taller card makes
				    the whole grid row ragged. Clipping is the only safe overflow here. */}
				<box flexDirection="column" flexGrow={1} overflow="hidden">
					<text truncate wrapMode="none">
						<span fg={colors.foreground} attributes={TextAttributes.BOLD}>
							{player.name}
						</span>
						<span fg={accent}>{` ${icons.bullet} ${status}`}</span>
					</text>
					{lines}
				</box>
			</box>

			{/* The two meters span the whole card, under the head — they are the one
			    thing on the card with a fixed shape, and full width is what lets the
			    percentages line up down a column of cards. */}
			{state?.health === undefined && state?.food === undefined ? (
				<>
					<text fg={colors.muted} truncate wrapMode="none">
						{kind === "online"
							? "No player data written yet."
							: "No player data on disk."}
					</text>
					{/* Holds the card at six interior rows whatever it has to say, so a
					    row of cards has one baseline instead of a ragged one. */}
					<text> </text>
				</>
			) : (
				<>
					<StatMeter
						label="Health:"
						value={state?.health ?? 0}
						max={maxHealth}
						full={icons.heartFull}
						empty={icons.heartEmpty}
						color={colors.error}
					/>
					<StatMeter
						label="Food:"
						value={state?.food ?? 0}
						max={MAX_FOOD}
						full={icons.foodFull}
						empty={icons.foodEmpty}
						color={colors.warning}
					/>
				</>
			)}
		</box>
	);
}

/**
 * A group heading with its count, drawn as a quiet rule across the tab.
 *
 * It also **reports the width of its interior** through `onWidth`: that number —
 * not the terminal's — is what the card grid divides into columns, because only
 * the layout engine knows what the shell frame, the tab padding, this border and
 * the scrollbar have already taken. Every section is the same width, so the tab
 * can let them all report to one setter.
 */
function Section({
	label,
	count,
	onWidth,
	children,
}: {
	label: string;
	count: number;
	onWidth?: (width: number) => void;
	children?: React.ReactNode;
}) {
	const { colors } = useTheme();
	const contentRef = useRef<BoxRenderable>(null);
	const measured = useBoxWidth(contentRef);

	// 0 means "yoga has not laid this out yet" (see `useBoxWidth`), which is not a
	// width — reporting it would collapse the grid to one column for a frame.
	useEffect(() => {
		if (measured > 0) onWidth?.(measured);
	}, [measured, onWidth]);

	return (
		<box
			flexDirection="column"
			border
			borderColor={colors.border}
			borderStyle="rounded"
			paddingX={1}
		>
			<box
				flexDirection="row"
				gap={1}
				alignItems="center"
				backgroundColor={colors.background}
				paddingX={1}
				position="absolute"
				top={-1}
				left={2}
			>
				<text fg={colors.primary} attributes={TextAttributes.BOLD}>
					{label}
				</text>
				<text fg={colors.muted}>{count}</text>
			</box>
			{/* The measured wrapper is unconditional — a ref attached on only one
			    render path is never installed (see `useBoxWidth`). */}
			<box ref={contentRef} flexDirection="column">
				{children}
			</box>
		</box>
	);
}

export function PlayersTab({ server, insight, focused }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const toast = useToast();
	const { roster, loading, act } = usePlayers(server, insight);
	const [selectedKey, setSelectedKey] = useState<string>();
	const [actionsOpen, setActionsOpen] = useState(false);

	const empty = icons.emptyValue;
	const status = insight?.status;
	const maxPlayers = status?.playersMax ?? insight?.properties?.maxPlayers ?? 0;
	const running = server.state === "running";

	const online = roster.players.filter((player) => player.online);
	const banned = roster.players.filter((player) => player.ban !== undefined);
	const offline = roster.players.filter(
		(player) => !player.online && player.ban === undefined,
	);
	// One flat sequence in display order, so the caret moves between sections
	// without the page having to know which one it is in.
	const ordered = [...online, ...offline, ...banned];

	const whitelisted = roster.players.filter((player) => player.whitelisted);
	const notEnforced =
		insight?.properties !== undefined && !insight.properties.whitelist;
	const summary: { id: string; text: string; fg: string }[] = [
		{
			id: "online",
			text: `${icons.bullet} ${status ? status.playersOnline : empty}/${maxPlayers || empty} online`,
			fg: running ? colors.success : colors.muted,
		},
		{
			id: "known",
			text: `${roster.players.length} known`,
			fg: colors.muted,
		},
		{
			id: "ops",
			text: `${roster.players.filter((player) => player.op).length} ops`,
			fg: colors.muted,
		},
		{
			id: "whitelisted",
			text: `${whitelisted.length} whitelisted${notEnforced ? " (not enforced)" : ""}`,
			// A whitelist that exists but is switched off is a real misconfiguration
			// — the players on it believe they are the ones who can join.
			fg: notEnforced && whitelisted.length > 0 ? colors.warning : colors.muted,
		},
		{
			id: "banned",
			text: `${banned.length} banned`,
			fg: banned.length > 0 ? colors.error : colors.muted,
		},
		...(status
			? [
					{
						id: "latency",
						// MCTL's own round trip, explicitly labelled: it is not any
						// player's ping, and an unqualified "1 ms" would read as one.
						text: `${status.latencyMs} ms to MCTL`,
						fg: colors.muted,
					},
				]
			: []),
	];

	const showHead = width >= HEAD_MIN_WIDTH;
	// Real faces, fetched in display order and arriving whenever they arrive. Not
	// looked up at all when the terminal is too narrow to draw a head — there is
	// nothing to show them in.
	const heads = usePlayerHeads(ordered, showHead);
	// The sections all report the same interior width; until one of them has been
	// laid out, fall back to a conservative guess off the terminal.
	const [sectionWidth, setSectionWidth] = useState(0);
	const available =
		sectionWidth > 0 ? sectionWidth : Math.max(1, width - SECTION_CHROME);
	const { columns, cardWidth } = fitCards(
		available,
		showHead ? CARD_MIN_WIDTH_WITH_HEAD : CARD_MIN_WIDTH_PLAIN,
	);

	// Keep the selection alive across polls, and seed it on the first roster. The
	// effect is keyed on the *keys*, not on `ordered`: the roster is rebuilt every
	// poll, so the array identity changes constantly while its membership rarely
	// does — depending on the array would re-run this several times a minute for
	// nothing.
	const orderedKeys = ordered.map((player) => player.key).join("|");
	useEffect(() => {
		const keys = orderedKeys === "" ? [] : orderedKeys.split("|");
		if (keys.length === 0) {
			if (selectedKey !== undefined) setSelectedKey(undefined);
			return;
		}
		if (!selectedKey || !keys.includes(selectedKey)) setSelectedKey(keys[0]);
	}, [orderedKeys, selectedKey]);

	const selected = ordered.find((player) => player.key === selectedKey);
	const index = ordered.findIndex((player) => player.key === selectedKey);

	const move = (delta: number) => {
		if (ordered.length === 0) return;
		const next = Math.max(0, Math.min(ordered.length - 1, index + delta));
		setSelectedKey(ordered[next]?.key);
	};

	// The tab only answers the keyboard while it holds the page's focus ring —
	// otherwise ←/→ belong to the tab bar, exactly as they do for the console.
	useKeyboard((key) => {
		if (!focused || actionsOpen) return;
		if (key.name === "down" || key.name === "j") move(columns);
		else if (key.name === "up" || key.name === "k") move(-columns);
		else if (key.name === "right" || key.name === "l") move(1);
		else if (key.name === "left" || key.name === "h") move(-1);
		else if (key.name === "return" && selected) setActionsOpen(true);
	});

	// `←→` is registered with the *same* key signature the container uses for
	// "switch tab", which is how a context-scope hint replaces it rather than
	// adding a second, contradictory entry: while the grid holds the ring the
	// arrows move the caret, not the tab.
	useHints(
		[
			{ keys: [icons.arrowUp, icons.arrowDown], label: "select player" },
			{ keys: [icons.arrowLeft, icons.arrowRight], label: "select player" },
			{ keys: "Enter", label: "actions" },
		],
		{ scope: "context", active: focused === true && !actionsOpen },
	);

	const run = async (
		action: Parameters<typeof act>[0],
		player: PlayerProfile,
		argument?: string,
	) => {
		const failure = await act(action, player, argument);
		const label = playerAction(action).label;
		if (failure) {
			toast.error(`Could not ${label.toLowerCase()} ${player.name}`, {
				description: failure,
			});
		} else {
			// Report *what was actually done*, which differs by action: a console
			// action is a command the user could equally have typed, while a shadow
			// ban is a note in `mctl.json` that changes nothing on the server. One
			// generic "done" would misrepresent the second.
			const command = commandFor(action, player.name, argument);
			toast.success(`${label} ${player.name}`, {
				description: command
					? `Sent "${command}" to the console.`
					: "Recorded in mctl.json. Minecraft has no shadow ban, so nothing is enforced on the server itself.",
			});
		}
	};

	const grid = (players: PlayerProfile[], kind: CardKind) => (
		<box flexDirection="column">
			{chunk(players, columns).map((row) => (
				<box
					key={row.map((player) => player.key).join("|")}
					flexDirection="row"
					gap={CARD_GAP}
				>
					{row.map((player) => (
						<PlayerCard
							key={player.key}
							player={player}
							kind={kind}
							selected={player.key === selectedKey}
							showHead={showHead}
							head={heads.get(player.key)}
							width={cardWidth}
							onSelect={() => setSelectedKey(player.key)}
							onActivate={() => {
								setSelectedKey(player.key);
								setActionsOpen(true);
							}}
						/>
					))}
				</box>
			))}
		</box>
	);

	return (
		<box flexDirection="column" paddingX={1}>
			{/* Summary: the live counts first, then what the rosters say. One wrapping
			    row of facts rather than a panel — the cards below are the content.
			    Each item carries its own trailing separator and the row has **no**
			    gap: a gap on a wrapping row is a *cross*-axis gap too, which inserts
			    a blank line between the wrapped rows on a narrow terminal. */}
			<box flexDirection="row" flexWrap="wrap" paddingBottom={1}>
				{summary.map((item, position) => (
					<text key={item.id} fg={item.fg}>
						{position === summary.length - 1
							? item.text
							: `${item.text} ${icons.separator} `}
					</text>
				))}
			</box>

			{loading && roster.players.length === 0 ? (
				<box marginTop={1}>
					<EmptyNote>Reading the server's rosters…</EmptyNote>
				</box>
			) : null}

			<ScrollBox
				flexGrow={1}
				enableAccel
				contentOptions={{
					flexDirection: "column",
					gap: 1,
				}}
			>
				<Section label="Online" count={online.length} onWidth={setSectionWidth}>
					{online.length > 0 ? (
						grid(online, "online")
					) : (
						<EmptyNote>
							{running
								? status
									? status.playersOnline > 0
										? "This server does not publish player names in its status response."
										: "Nobody is connected."
									: "The server is not answering a status ping yet."
								: "The server is not running, so there is no live player list."}
						</EmptyNote>
					)}
					{roster.onlineUnnamed > 0 ? (
						<EmptyNote>
							{`${roster.onlineUnnamed} more online — the server sends only a sample of names.`}
						</EmptyNote>
					) : null}
				</Section>

				<Section label="Offline" count={offline.length}>
					{offline.length > 0 ? (
						grid(offline, "offline")
					) : (
						<EmptyNote>
							No other players on record. The server writes these files only for
							players it has actually seen.
						</EmptyNote>
					)}
				</Section>

				{banned.length > 0 ? (
					<Section label="Banned" count={banned.length}>
						{grid(banned, "banned")}
					</Section>
				) : null}

				{roster.bannedIps.length > 0 ? (
					<Section label="Banned addresses" count={roster.bannedIps.length}>
						{roster.bannedIps.map((ban) => (
							<box key={ban.ip} flexDirection="row" gap={1}>
								<text fg={colors.error}>{ban.ip.padEnd(18)}</text>
								<text fg={colors.muted}>
									{`${ban.created ?? empty} ${icons.separator} ${ban.reason ?? "no reason given"}`}
								</text>
							</box>
						))}
					</Section>
				) : null}
			</ScrollBox>

			<box marginTop={1} flexDirection="column">
				{roster.detailsTruncated ? (
					<EmptyNote>
						Only the most recent players' stats were read — the rest show names
						alone.
					</EmptyNote>
				) : null}
				{/* Named rather than omitted: a missing figure reads as a bug, and these
				    two are the ones people expect a server panel to show. */}
				<EmptyNote>
					{`Per-player ping and current session length need RCON or a plugin, so they are not shown. Playtime is the lifetime total.`}
				</EmptyNote>
			</box>

			<PlayerActionsDialog
				open={actionsOpen}
				player={selected}
				running={running}
				onClose={() => setActionsOpen(false)}
				onRun={(action, player, argument) => void run(action, player, argument)}
			/>
		</box>
	);
}
