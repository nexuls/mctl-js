/**
 * Player administration — the moderation and utility actions MCTL can perform
 * on one player of one server.
 *
 * Core service (AGENTS.md § 3): no UI, no argv, no provider imports. The
 * counterpart to the read-only `players.ts`, and the same split `discover.ts` /
 * `manager.ts` uses.
 *
 * **Every action is a console command the server already has.** MCTL does not
 * edit `ops.json`, `whitelist.json` or `banned-players.json` itself, for two
 * reasons: `mctl.json` is the only file MCTL owns inside a server directory
 * (AGENTS.md § "Secrets and user data"), and a running server holds those
 * rosters in memory and rewrites them on its own schedule — an edit underneath
 * it would simply be overwritten. So the commands go through
 * {@link "../runtime".RuntimeManager.exec}, which means **an action needs the
 * server to be running**; {@link PlayerActionDef.needsRunning} says so per
 * action and the UI disables the rest rather than failing them.
 *
 * **`feed` and `heal` are not vanilla commands.** They exist in Essentials and
 * friends, not in Minecraft, so they are expressed as the status effects that
 * produce the same result — `saturation` refills the hunger bar, `instant_health`
 * refills hearts. That keeps them working on a plugin-free vanilla server.
 *
 * **Shadow ban has no command at all** — Minecraft has no such concept. It is
 * recorded in `mctl.json` (`shadowBans`) as an MCTL-side marker, which changes
 * what the UI shows and nothing on the server.
 * TODO(phase-5): enforce it for real once the RCON/plugin subsystem lands —
 * a marker without enforcement is a label, and the UI says exactly that.
 */

import type { ShadowBan } from "../../types/server.ts";
import type { RuntimeManager } from "../runtime/index.ts";
import type { ServerManager } from "./manager.ts";
import type { PlayerProfile } from "./players.ts";

/** Every action MCTL offers against a player. */
export type PlayerActionId =
	| "kick"
	| "ban"
	| "pardon"
	| "op"
	| "deop"
	| "whitelistAdd"
	| "whitelistRemove"
	| "shadowBan"
	| "shadowPardon"
	| "message"
	| "teleport"
	| "gamemode"
	| "feed"
	| "heal"
	| "kill";

/**
 * How prominently an action should read. A semantic name rather than a colour —
 * core states intent and the UI maps it to the theme, exactly as it does for
 * server state (AGENTS.md § 3).
 */
export type PlayerActionTone =
	| "neutral"
	| "success"
	| "info"
	| "warning"
	| "error";

/** A free-text argument an action needs before it can run. */
export interface PlayerActionArgument {
	/** Field label, e.g. `"Reason"`. */
	label: string;
	/** Placeholder / example value. */
	placeholder: string;
	/** True when the action cannot run without it. */
	required: boolean;
}

/** One action's definition: what it is, when it applies, what it needs. */
export interface PlayerActionDef {
	id: PlayerActionId;
	/** Button label. */
	label: string;
	/** One line explaining what it does — including any caveat. */
	description: string;
	/** Intent, mapped to a theme colour by the UI. */
	tone: PlayerActionTone;
	/** True when the server must be running for this to work. */
	needsRunning: boolean;
	/** The argument to prompt for, when there is one. */
	argument?: PlayerActionArgument;
	/**
	 * Whether the action makes sense for this player right now — an already
	 * banned player is offered `pardon`, not `ban`. Absent means always.
	 */
	applies?: (player: PlayerProfile) => boolean;
}

/**
 * The action catalogue, in the order the UI offers them: moderation first, then
 * permissions, then the in-world utilities.
 */
export const PLAYER_ACTIONS: readonly PlayerActionDef[] = [
	{
		id: "kick",
		label: "Kick",
		description: "Disconnect the player; they may rejoin immediately.",
		tone: "warning",
		needsRunning: true,
		argument: { label: "Reason", placeholder: "optional", required: false },
		applies: (player) => player.online,
	},
	{
		id: "ban",
		label: "Ban",
		description: "Kick and add to banned-players.json.",
		tone: "error",
		needsRunning: true,
		argument: { label: "Reason", placeholder: "optional", required: false },
		applies: (player) => player.ban === undefined,
	},
	{
		id: "pardon",
		label: "Pardon",
		description: "Lift the ban and let the player back in.",
		tone: "success",
		needsRunning: true,
		applies: (player) => player.ban !== undefined,
	},
	{
		id: "shadowBan",
		label: "Shadow ban",
		description:
			"Record an MCTL-side mark. Minecraft has no shadow ban — nothing is enforced yet.",
		tone: "warning",
		needsRunning: false,
		argument: { label: "Reason", placeholder: "optional", required: false },
		applies: (player) => player.shadowBan === undefined,
	},
	{
		id: "shadowPardon",
		label: "Clear shadow ban",
		description: "Remove MCTL's shadow-ban mark.",
		tone: "success",
		needsRunning: false,
		applies: (player) => player.shadowBan !== undefined,
	},
	{
		id: "op",
		label: "Op",
		description: "Grant operator permissions.",
		tone: "info",
		needsRunning: true,
		applies: (player) => player.op === undefined,
	},
	{
		id: "deop",
		label: "De-op",
		description: "Revoke operator permissions.",
		tone: "warning",
		needsRunning: true,
		applies: (player) => player.op !== undefined,
	},
	{
		id: "whitelistAdd",
		label: "Whitelist",
		description: "Add to whitelist.json.",
		tone: "info",
		needsRunning: true,
		applies: (player) => !player.whitelisted,
	},
	{
		id: "whitelistRemove",
		label: "Un-whitelist",
		description: "Remove from whitelist.json.",
		tone: "warning",
		needsRunning: true,
		applies: (player) => player.whitelisted,
	},
	{
		id: "message",
		label: "Message",
		description: "Send a private message to the player.",
		tone: "neutral",
		needsRunning: true,
		argument: { label: "Message", placeholder: "hello", required: true },
		applies: (player) => player.online,
	},
	{
		id: "teleport",
		label: "Teleport",
		description: "Move the player to another player, or to x y z.",
		tone: "neutral",
		needsRunning: true,
		argument: {
			label: "Destination",
			placeholder: "player name or: 100 64 -20",
			required: true,
		},
		applies: (player) => player.online,
	},
	{
		id: "gamemode",
		label: "Game mode",
		description: "Change the player's game mode.",
		tone: "neutral",
		needsRunning: true,
		argument: {
			label: "Mode",
			placeholder: "survival | creative | adventure | spectator",
			required: true,
		},
		applies: (player) => player.online,
	},
	{
		id: "feed",
		label: "Feed",
		description: "Refill hunger (a saturation effect — no plugin needed).",
		tone: "success",
		needsRunning: true,
		applies: (player) => player.online,
	},
	{
		id: "heal",
		label: "Heal",
		description: "Refill health (an instant-health effect).",
		tone: "success",
		needsRunning: true,
		applies: (player) => player.online,
	},
	{
		id: "kill",
		label: "Kill",
		description: "Kill the player. They drop their inventory.",
		tone: "error",
		needsRunning: true,
		applies: (player) => player.online,
	},
];

/** Look one action up by id. */
export function playerAction(id: PlayerActionId): PlayerActionDef {
	const action = PLAYER_ACTIONS.find((entry) => entry.id === id);
	if (!action) throw new Error(`unknown player action: ${id}`);
	return action;
}

/**
 * Build the console command line for an action, or `undefined` when the action
 * has no server-side command (shadow bans).
 *
 * Pure and exported so the exact wording of every command is unit-testable
 * without a running server — these are moderation commands, and a wrong argument
 * order would ban the wrong account.
 *
 * Commands are written **without** a leading `/`: a server console takes bare
 * commands, and the slash is a chat-window convention.
 *
 * @param name the target player's name. Names, not uuids, because `kick`,
 *   `tell` and `gamemode` do not accept a uuid on any version.
 * @param argument the user-supplied argument, when the action takes one.
 */
export function commandFor(
	id: PlayerActionId,
	name: string,
	argument?: string,
): string | undefined {
	const arg = argument?.trim() ?? "";
	switch (id) {
		case "kick":
			return arg ? `kick ${name} ${arg}` : `kick ${name}`;
		case "ban":
			return arg ? `ban ${name} ${arg}` : `ban ${name}`;
		case "pardon":
			return `pardon ${name}`;
		case "op":
			return `op ${name}`;
		case "deop":
			return `deop ${name}`;
		case "whitelistAdd":
			return `whitelist add ${name}`;
		case "whitelistRemove":
			return `whitelist remove ${name}`;
		case "message":
			return `tell ${name} ${arg}`;
		case "teleport":
			// `tp <target> <destination>` takes either a player name or three
			// coordinates; both are passed straight through, so relative forms
			// (`~ ~10 ~`) work as they do in-game.
			return `tp ${name} ${arg}`;
		case "gamemode":
			// Argument order is `gamemode <mode> <player>`, which is the reverse of
			// most commands and the easiest one to get backwards.
			return `gamemode ${arg} ${name}`;
		case "feed":
			// Saturation restores hunger directly; a high amplifier fills the bar in
			// the effect's first tick, and the 1-second duration keeps it from
			// lingering as a hidden buffer.
			return `effect give ${name} minecraft:saturation 1 20 true`;
		case "heal":
			// Instant health heals 2 × 2^amplifier half-hearts, so amplifier 4 covers
			// any vanilla health pool in one application.
			return `effect give ${name} minecraft:instant_health 1 4 true`;
		case "kill":
			return `kill ${name}`;
		case "shadowBan":
		case "shadowPardon":
			// No server-side command exists; handled by `runPlayerAction`.
			return undefined;
	}
}

/** What {@link runPlayerAction} needs from the core context. */
export interface PlayerAdminDeps {
	/** Sends the console command. */
	runtime: RuntimeManager;
	/** Writes the shadow-ban marker into `mctl.json`. */
	servers: ServerManager;
}

/**
 * Perform one action against one player.
 *
 * @param serverId the server the player belongs to.
 * @param player the target, as read by `readPlayers`.
 * @param argument the user-supplied argument for actions that take one.
 * @throws {ServerOperationError} when the server is not running (for the
 *   console-backed actions) or the id is unknown.
 * @throws {Error} when a required argument is missing.
 */
export async function runPlayerAction(
	deps: PlayerAdminDeps,
	serverId: string,
	id: PlayerActionId,
	player: PlayerProfile,
	argument?: string,
): Promise<void> {
	const action = playerAction(id);
	if (action.argument?.required && !argument?.trim()) {
		throw new Error(
			`${action.label} needs a ${action.argument.label.toLowerCase()}`,
		);
	}

	if (id === "shadowBan" || id === "shadowPardon") {
		await setShadowBan(
			deps.servers,
			serverId,
			player,
			id === "shadowBan",
			argument,
		);
		return;
	}

	const command = commandFor(id, player.name, argument);
	if (!command) return;
	await deps.runtime.exec(serverId, command);
}

/**
 * Add or remove a shadow-ban marker in the server's `mctl.json`.
 *
 * Read-modify-write of the whole list, through `ServerManager.editServer` so the
 * write merges over the parsed file and keys from a newer MCTL survive — the
 * same rule every other `mctl.json` edit follows.
 */
async function setShadowBan(
	servers: ServerManager,
	serverId: string,
	player: PlayerProfile,
	marked: boolean,
	reason?: string,
): Promise<void> {
	const existing = await servers.shadowBans(serverId);
	// Matched by uuid when both sides have one, else by name: an offline-mode
	// player has no uuid anywhere, and a renamed player keeps their uuid.
	const matches = (mark: ShadowBan) =>
		player.uuid && mark.uuid
			? mark.uuid === player.uuid
			: mark.name.toLowerCase() === player.name.toLowerCase();

	const next = existing.filter((mark) => !matches(mark));
	if (marked) {
		next.push({
			name: player.name,
			uuid: player.uuid,
			at: new Date().toISOString(),
			reason: reason?.trim() || undefined,
		});
	}
	await servers.editServer(serverId, { shadowBans: next });
}
