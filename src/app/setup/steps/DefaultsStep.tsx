/**
 * Step 3 — Server defaults. The values pre-filled when creating a new server:
 * Minecraft version, kind, JVM heap, runtime, and EULA behaviour. Each is
 * overridable per server later — this only sets the starting point.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3). The option sets are shared with the
 * Settings page through `app/choices.ts`, so the two cannot drift apart.
 */

import {
	Checkbox,
	Input,
	RadioGroup,
	Select,
} from "../../../components/index.ts";
import { useFocusRing } from "../../../hooks/use-focus-ring.ts";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { StepScaffold } from "../StepScaffold.tsx";
import { WizardFooter } from "../WizardFooter.tsx";
import type { StepProps } from "../types.ts";
import {
	KIND_ITEMS as KINDS,
	RUNTIME_ITEMS as RUNTIMES,
} from "../../choices.ts";

export function DefaultsStep({ draft, setDraft, onNext, onBack }: StepProps) {
	const { icons } = useIcons();
	const ring = useFocusRing([
		"mc",
		"kind",
		"memory",
		"runtime",
		"eula",
		"__back",
		"__next",
	]);

	return (
		<StepScaffold
			title="Defaults for new servers"
			description="Sensible starting values — each can be overridden per server."
			footer={
				<WizardFooter
					hints={[
						{ keys: "Tab", label: "next field" },
						{ keys: [icons.arrowUp, icons.arrowDown], label: "choose" },
					]}
					backFocused={ring.isFocused("__back")}
					nextFocused={ring.isFocused("__next")}
					onBack={onBack}
					onNext={onNext}
					onFocusBack={() => ring.setFocus("__back")}
					onFocusNext={() => ring.setFocus("__next")}
				/>
			}
		>
			<box flexDirection="row" gap={2} flexWrap="wrap">
				<Input
					label="Minecraft version"
					hint="blank = latest at create time"
					placeholder="latest"
					value={draft.minecraftVersion}
					width={30}
					focused={ring.isFocused("mc")}
					onFocused={() => ring.setFocus("mc")}
					onChange={(v) => setDraft({ minecraftVersion: v })}
					onSubmit={() => ring.next()}
				/>
				<Input
					label="Memory"
					hint="JVM heap, e.g. 2G or 4096M"
					value={draft.memory}
					width={22}
					focused={ring.isFocused("memory")}
					onFocused={() => ring.setFocus("memory")}
					onChange={(v) => setDraft({ memory: v })}
					onSubmit={() => ring.next()}
				/>
			</box>

			<Select
				label="Server kind"
				hint="the server implementation"
				options={KINDS}
				value={draft.kind}
				width={40}
				focused={ring.isFocused("kind")}
				onFocused={() => ring.setFocus("kind")}
				onChange={(v) => setDraft({ kind: v })}
			/>

			<RadioGroup
				label="Runtime"
				hint="how the server process is run"
				options={RUNTIMES}
				value={draft.runtime}
				focused={ring.isFocused("runtime")}
				onFocused={() => ring.setFocus("runtime")}
				onChange={(v) => setDraft({ runtime: v })}
			/>

			<Checkbox
				label="Minecraft EULA"
				caption="Auto-accept the EULA when creating a server"
				checked={draft.eula}
				focused={ring.isFocused("eula")}
				onFocused={() => ring.setFocus("eula")}
				onChange={(v) => setDraft({ eula: v })}
			/>
		</StepScaffold>
	);
}
