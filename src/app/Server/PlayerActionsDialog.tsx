/**
 * PlayerActionsDialog — the modal that runs one moderation or utility action
 * against one player.
 *
 * Page-layer, pure UI (AGENTS.md § 3): it renders the action catalogue it is
 * handed and reports the chosen action through `onRun`. It performs no I/O — the
 * Players tab's `usePlayers().act` does that, which is what keeps the console
 * command in core where the CLI could reach it too.
 *
 * **Two stages, because half the actions take an argument.** The menu lists the
 * actions that apply to *this* player right now (`PlayerActionDef.applies`);
 * choosing one that needs a reason, a destination or a game mode switches the
 * dialog to a single input rather than opening a second modal. Escape steps back
 * one stage instead of closing outright, which is what a two-stage flow has to
 * do to be usable — closing from the argument field would lose the choice.
 *
 * **Each stage is its own component, mounted only while it is showing.** That is
 * what makes "every open starts at the top of the menu" fall out of the tree
 * instead of needing an effect to reset it: a closed dialog has no stage mounted,
 * so the next open builds a fresh focus ring. It also keeps exactly one ring
 * listening for Tab at a time, which is the rule `useFocusRing` documents.
 */

import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { Button, Dialog, Input } from "../../components/index.ts";
import { useCaptureKeys } from "../../hooks/use-input-capture.tsx";
import { useFocusRing, type FocusItem } from "../../hooks/use-focus-ring.ts";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import type { Variant } from "../../components/support.ts";
import {
	PLAYER_ACTIONS,
	type PlayerActionDef,
	type PlayerActionId,
	type PlayerActionTone,
} from "../../core/server/player-admin.ts";
import type { PlayerProfile } from "../../core/server/players.ts";

/** Map core's intent name onto the component kit's variant vocabulary. */
function toneVariant(tone: PlayerActionTone): Variant {
	return tone === "neutral" ? "neutral" : tone;
}

/** Props for {@link PlayerActionsDialog}. */
export interface PlayerActionsDialogProps {
	/** Whether the dialog is shown. */
	open: boolean;
	/** The target player, or `undefined` when nothing is selected. */
	player?: PlayerProfile;
	/** Whether the server is currently running, which gates most actions. */
	running: boolean;
	/** Dismiss the dialog. */
	onClose: () => void;
	/** Run the chosen action; the parent reports success or failure as a toast. */
	onRun: (
		action: PlayerActionId,
		player: PlayerProfile,
		argument?: string,
	) => void;
}

/**
 * Stage one: the menu of applicable actions.
 *
 * The ring is the *only* selection state — an action the server cannot run is
 * marked disabled, so Tab and the arrow keys step straight over it rather than
 * landing on a dimmed chip that ignores Enter. Why the action is unavailable is
 * said once at the foot of the dialog (the server is stopped), which is where the
 * reason actually lives; repeating it per action would be noise.
 */
function ActionMenu({
	player,
	running,
	onChoose,
}: {
	player: PlayerProfile;
	running: boolean;
	onChoose: (action: PlayerActionDef) => void;
}) {
	const { colors } = useTheme();
	const { icons } = useIcons();

	const available = PLAYER_ACTIONS.filter(
		(action) => action.applies?.(player) ?? true,
	);
	const items: FocusItem[] = available.map((action) => ({
		id: action.id,
		disabled: action.needsRunning === true && !running,
	}));
	const ring = useFocusRing(items);

	// The menu wraps across rows, so there is no meaningful "the one above": every
	// arrow simply steps along the ring in the direction it points, and Tab does
	// the same. Both therefore skip the actions the server cannot run.
	useKeyboard((key) => {
		if (key.name === "down" || key.name === "j" || key.name === "right") {
			ring.next();
		} else if (key.name === "up" || key.name === "k" || key.name === "left") {
			ring.prev();
		}
	});

	return (
		<>
			<box flexDirection="row" gap={1}>
				<text fg={colors.muted}>
					{player.online ? "online" : "offline"}
					{player.op ? ` ${icons.separator} op ${player.op.level}` : ""}
					{player.ban ? ` ${icons.separator} banned` : ""}
					{player.shadowBan ? ` ${icons.separator} shadow-banned` : ""}
				</text>
			</box>

			{/* `alignItems` is load-bearing: a Button sizes to its label, and the
			    column's default stretch/centre makes a list of them read as a ragged
			    stack rather than a menu. */}
			<box flexDirection="row" flexWrap="wrap" alignItems="flex-start">
				{available.map((action) => {
					const blocked = action.needsRunning === true && !running;
					return (
						<box key={action.id} flexDirection="column">
							<Button
								size="medium"
								kind="outline"
								variant={toneVariant(action.tone)}
								disabled={blocked}
								focused={ring.isFocused(action.id)}
								onFocused={() => ring.setFocus(action.id)}
								onClick={() => onChoose(action)}
							>
								{`${action.label}${action.argument ? "…" : ""}`}
							</Button>
							{ring.isFocused(action.id) ? (
								<text fg={colors.muted}>{`  ${action.description}`}</text>
							) : null}
						</box>
					);
				})}
			</box>

			{/* Said once, here, rather than on every disabled row: the reason the
			    console-backed actions are unavailable is a property of the server, not
			    of the action the user happened to land on. */}
			{running ? null : (
				<text fg={colors.warning}>
					{`${icons.warning} The server is stopped — MCTL sends these as console commands, so only the MCTL-side marks can run.`}
				</text>
			)}
		</>
	);
}

/**
 * Stage two: the single argument the chosen action needs.
 *
 * The ring runs field → Back → the action itself, and the action is disabled
 * exactly when the field fails its `required` check, so Tab cannot reach a submit
 * that would silently do nothing.
 */
function ArgumentStage({
	action,
	onBack,
	onSubmit,
}: {
	action: PlayerActionDef;
	onBack: () => void;
	onSubmit: (argument: string) => void;
}) {
	const { colors } = useTheme();
	const [argument, setArgument] = useState("");
	const incomplete =
		action.argument?.required === true && argument.trim() === "";

	const ring = useFocusRing([
		"value",
		"back",
		{ id: "run", disabled: incomplete },
	]);

	// The argument field owns the keyboard while it holds the ring, so the shell's
	// character shortcuts (digits, `q`, `t`) stand down and typing a reason
	// containing a "q" does not quit the app.
	useCaptureKeys(ring.isFocused("value"));

	const submit = () => {
		if (incomplete) return;
		onSubmit(argument);
	};

	return (
		<Dialog
			open
			title={` ${action.label} `}
			variant={toneVariant(action.tone)}
			width={54}
			// Escape belongs to the *stage*, not the dialog: it returns to the menu
			// so a mistyped reason does not cost the whole selection.
			onClose={onBack}
			footer={
				<>
					<Button
						size="small"
						kind="ghost"
						variant="neutral"
						focused={ring.isFocused("back")}
						onFocused={() => ring.setFocus("back")}
						onClick={onBack}
					>
						Back
					</Button>
					<Button
						size="small"
						kind="solid"
						variant={toneVariant(action.tone)}
						disabled={incomplete}
						focused={ring.isFocused("run")}
						onFocused={() => ring.setFocus("run")}
						onClick={submit}
					>
						{action.label}
					</Button>
				</>
			}
		>
			<text fg={colors.muted}>{action.description}</text>
			<Input
				label={action.argument?.label}
				placeholder={action.argument?.placeholder}
				hint={action.argument?.required ? "required" : "optional"}
				value={argument}
				onChange={setArgument}
				onSubmit={submit}
				focused={ring.isFocused("value")}
				onFocused={() => ring.setFocus("value")}
				width="100%"
			/>
		</Dialog>
	);
}

export function PlayerActionsDialog({
	open,
	player,
	running,
	onClose,
	onRun,
}: PlayerActionsDialogProps) {
	const [chosen, setChosen] = useState<PlayerActionDef>();

	if (!open || !player) return null;

	/** Leave the dialog, discarding the stage so the next open starts at the menu. */
	const close = () => {
		setChosen(undefined);
		onClose();
	};

	const start = (action: PlayerActionDef) => {
		if (action.argument) {
			setChosen(action);
			return;
		}
		onRun(action.id, player);
		close();
	};

	if (chosen) {
		return (
			<ArgumentStage
				action={chosen}
				onBack={() => setChosen(undefined)}
				onSubmit={(argument) => {
					onRun(chosen.id, player, argument);
					close();
				}}
			/>
		);
	}

	return (
		<Dialog open title={` ${player.name} `} width={54} onClose={close}>
			<ActionMenu player={player} running={running} onChoose={start} />
		</Dialog>
	);
}
