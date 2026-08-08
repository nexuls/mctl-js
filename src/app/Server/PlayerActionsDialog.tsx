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
 */

import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { Button, Dialog, Input } from "../../components/index.ts";
import { useCaptureKeys } from "../../hooks/use-input-capture.tsx";
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

export function PlayerActionsDialog({
	open,
	player,
	running,
	onClose,
	onRun,
}: PlayerActionsDialogProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const [index, setIndex] = useState(0);
	const [chosen, setChosen] = useState<PlayerActionDef>();
	const [argument, setArgument] = useState("");

	// Every open starts from the top of the menu: a dialog that reopened on the
	// previous selection would put "Kill" under the Enter key of someone who last
	// used it, which is not a keystroke to inherit.
	useEffect(() => {
		if (open) {
			setIndex(0);
			setChosen(undefined);
			setArgument("");
		}
	}, [open]);

	// The argument field owns the keyboard while it is up, so the shell's
	// character shortcuts (digits, `q`, `t`) stand down and typing a reason
	// containing a "q" does not quit the app.
	useCaptureKeys(open && chosen?.argument !== undefined);

	const available = player
		? PLAYER_ACTIONS.filter((action) => action.applies?.(player) ?? true)
		: [];

	useKeyboard((key) => {
		if (!open || chosen) return;
		if (key.name === "down" || key.name === "j") {
			setIndex((current) => Math.min(available.length - 1, current + 1));
		} else if (key.name === "up" || key.name === "k") {
			setIndex((current) => Math.max(0, current - 1));
		}
	});

	if (!open || !player) return null;

	const start = (action: PlayerActionDef) => {
		if (action.argument) {
			setChosen(action);
			return;
		}
		onRun(action.id, player);
		onClose();
	};

	const submit = () => {
		if (!chosen) return;
		if (chosen.argument?.required && argument.trim() === "") return;
		onRun(chosen.id, player, argument);
		onClose();
	};

	const title = ` ${player.name} `;

	if (chosen) {
		return (
			<Dialog
				open
				title={title}
				variant={toneVariant(chosen.tone)}
				width={54}
				// Escape belongs to the *stage*, not the dialog: it returns to the menu
				// so a mistyped reason does not cost the whole selection.
				onClose={() => setChosen(undefined)}
				footer={
					<>
						<Button
							size="small"
							kind="ghost"
							variant="neutral"
							onClick={() => setChosen(undefined)}
						>
							Back
						</Button>
						<Button
							size="small"
							kind="solid"
							variant={toneVariant(chosen.tone)}
							onClick={submit}
						>
							{chosen.label}
						</Button>
					</>
				}
			>
				<text fg={colors.muted}>{chosen.description}</text>
				<Input
					label={chosen.argument?.label}
					placeholder={chosen.argument?.placeholder}
					hint={chosen.argument?.required ? "required" : "optional"}
					value={argument}
					onChange={setArgument}
					onSubmit={submit}
					focused
					width="100%"
				/>
			</Dialog>
		);
	}

	return (
		<Dialog open title={title} width={54} onClose={onClose}>
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
				{available.map((action, position) => {
					const blocked = action.needsRunning && !running;
					return (
						<box key={action.id} flexDirection="column">
							<Button
								size="medium"
								kind="outline"
								variant={toneVariant(action.tone)}
								disabled={blocked}
								focused={position === index}
								onFocused={() => setIndex(position)}
								onClick={() => start(action)}
							>
								{`${action.label}${action.argument ? "…" : ""}`}
							</Button>
							{position === index ? (
								<text fg={colors.muted}>
									{`  ${blocked ? "Needs the server running." : action.description}`}
								</text>
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
		</Dialog>
	);
}
