/**
 * SetupWizard — the first-run setup flow (plan.md § First-Run Setup Wizard).
 *
 * Triggered by {@link App} when `config.json` is absent. It owns the whole flow:
 * a branded {@link Welcome} splash, then six steps (data root → locations →
 * defaults → backups → network → review) laid out with a {@link Stepper} rail.
 * On the final step it commits config via {@link useSetup} and calls `onComplete`,
 * which drops the app into the dashboard.
 *
 * **Page-layer** (AGENTS.md § 3): it holds the draft view model and step state
 * and renders components; the only I/O (the commit) goes through the setup hook.
 * Keyboard for stage transitions (Enter to begin, Esc to go back / quit) lives
 * here so there's a single owner of "which stage am I in"; within a step, Tab
 * focus and the buttons' Enter/Space are owned by the step and its controls.
 */

import { useCallback, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../../hooks/use-theme.tsx";
import { Stepper } from "./Stepper.tsx";
import { Welcome } from "./Welcome.tsx";
import { DataRootStep } from "./steps/DataRootStep.tsx";
import { PathsStep } from "./steps/PathsStep.tsx";
import { DefaultsStep } from "./steps/DefaultsStep.tsx";
import { BackupStep } from "./steps/BackupStep.tsx";
import { NetworkStep } from "./steps/NetworkStep.tsx";
import { ReviewStep } from "./steps/ReviewStep.tsx";
import { initialDraft, STEP_TITLES, type SetupDraft } from "./types.ts";
import { useSetup } from "./use-setup.ts";
import { useQuit } from "../../hooks/use-quit.ts";
import { alpha } from "../../lib/colors.ts";

/** Props for {@link SetupWizard}. */
export interface SetupWizardProps {
	/** Called once config has been written — the app should enter the dashboard. */
	onComplete: () => void;
}

/** The complete first-run wizard. */
export function SetupWizard({ onComplete }: SetupWizardProps) {
	const { colors, theme, themeId } = useTheme();
	const quit = useQuit();

	const [stage, setStage] = useState<"welcome" | "wizard">("welcome");
	const [step, setStep] = useState(0);
	const [draft, setDraftState] = useState<SetupDraft>(initialDraft);
	const { commit, committing, error } = useSetup();

	const setDraft = useCallback(
		(patch: Partial<SetupDraft>) =>
			setDraftState((current) => ({ ...current, ...patch })),
		[],
	);

	const next = useCallback(
		() => setStep((s) => Math.min(s + 1, STEP_TITLES.length - 1)),
		[],
	);
	const back = useCallback(
		() =>
			setStep((s) => {
				if (s === 0) {
					setStage("welcome");
					return 0;
				}
				return s - 1;
			}),
		[],
	);

	const handleCommit = useCallback(async () => {
		const result = await commit(draft, themeId);
		if (result) onComplete();
	}, [commit, draft, themeId, onComplete]);

	// Stage transitions. Enter only acts on the welcome splash (in-step Enter is
	// owned by inputs/buttons); Esc quits from welcome, otherwise steps back.
	useKeyboard((key) => {
		if (key.name === "escape") {
			if (stage === "welcome") quit();
			else back();
		} else if (key.name === "return" && stage === "welcome") {
			setStage("wizard");
		}
	});

	// Match App.tsx: paint the terminal theme's background as transparent so it
	// never flashes a stale derived colour during a live terminal theme switch.
	const pageBackground =
		theme.source === "terminal" ? "transparent" : colors.background;

	if (stage === "welcome") {
		return (
			<scrollbox
				flexGrow={1}
				backgroundColor={pageBackground}
				scrollbarOptions={{
					trackOptions: {
						backgroundColor: colors.surface,
						foregroundColor: alpha(colors.muted, 0.4),
					},
				}}
			>
				<Welcome onBegin={() => setStage("wizard")} />
			</scrollbox>
		);
	}

	const stepProps = { draft, setDraft, onNext: next, onBack: back };
	const steps = [
		<DataRootStep key={1} {...stepProps} />,
		<PathsStep key={2} {...stepProps} />,
		<DefaultsStep key={3} {...stepProps} />,
		<BackupStep key={4} {...stepProps} />,
		<NetworkStep key={5} {...stepProps} />,
		<ReviewStep
			key={6}
			draft={draft}
			onBack={back}
			onCommit={handleCommit}
			committing={committing}
			error={error}
		/>,
	];

	return (
		<scrollbox
			flexGrow={1}
			backgroundColor={pageBackground}
			scrollbarOptions={{
				trackOptions: {
					backgroundColor: colors.surface,
					foregroundColor: alpha(colors.muted, 0.4),
				},
			}}
		>
			<box flexGrow={1} flexDirection="column" padding={1} gap={1}>
				<box
					flexDirection="row"
					gap={1}
					alignItems="center"
					flexShrink={0}
					border={["bottom"]}
					borderColor={colors.muted}
				>
					<text fg={colors.primary} attributes={TextAttributes.BOLD}>
						mctl
					</text>
					<text fg={colors.muted}>
						· first-run setup · step {step + 1} of {STEP_TITLES.length}
					</text>
				</box>

				<box flexGrow={1} flexDirection="row" gap={3}>
					<Stepper steps={STEP_TITLES} current={step} />
					{/* Key by step so each step remounts fresh — its focus ring resets to the
            first field rather than carrying the previous step's index. */}
					<box key={step} flexGrow={1} flexDirection="column">
						{steps[step]}
					</box>
				</box>
			</box>
		</scrollbox>
	);
}
