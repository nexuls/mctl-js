/**
 * Step 5 — Network. The default network profile for new servers. The wizard stays
 * short here: only `direct` exists at this phase, and tunnels / Cloudflare DNS are
 * set up per-server on the Network page (Phase 4). So this is really a one-choice
 * confirmation plus a pointer to where the richer options live.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3).
 */

import { RadioGroup, type RadioItem } from "../../../components/index.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useFocusRing } from "../../../hooks/use-focus-ring.ts";
import { StepScaffold } from "../StepScaffold.tsx";
import { WizardFooter } from "../WizardFooter.tsx";
import type { StepProps } from "../types.ts";
/**
 * Profiles the wizard can offer.
 *
 * Only `direct`, and not because tunnels are unimplemented: the wizard runs
 * *before* there is a `config.json`, so there are no named profiles yet, and a
 * tunnel profile needs a provider choice plus its options (and often a
 * credential) — a flow that belongs on the Network page, not in a six-step
 * first-run wizard. Every server created before then can be re-pointed later.
 */
const PROFILES: RadioItem<string>[] = [
	{
		label: "direct",
		value: "direct",
		description: "bind a local port; players join on your LAN / public IP",
	},
];

export function NetworkStep({ draft, setDraft, onNext, onBack }: StepProps) {
	const { colors } = useTheme();
	const ring = useFocusRing(["network", "__back", "__next"]);

	return (
		<StepScaffold
			title="Networking"
			description="The default way new servers are exposed."
			footer={
				<WizardFooter
					hints={[
						{ keys: "Tab", label: "next field" },
						{ keys: "Enter", label: "continue" },
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
			<RadioGroup
				label="Default profile"
				hint="applied to new servers"
				options={PROFILES}
				value={draft.network}
				focused={ring.isFocused("network")}
				onFocused={() => ring.setFocus("network")}
				onChange={(v) => setDraft({ network: v })}
			/>
			<text fg={colors.muted}>
				Tunnels (cloudflared, playit, ngrok, tailscale) and Cloudflare DNS are
				configured per server on the <span fg={colors.info}>Network</span> page.
			</text>
		</StepScaffold>
	);
}
