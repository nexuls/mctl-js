/**
 * Welcome — the first-run splash shown before the wizard proper.
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders the branded hero and reports
 * "begin" via `onBegin`. Keyboard (Enter to begin, Esc to quit) is owned by the
 * parent {@link SetupWizard} so there's a single place that knows the stage; the
 * button here is the mouse affordance and the always-focused Enter target.
 */

import { TextAttributes } from "@opentui/core";
import { Button, Hint, MinecraftHead } from "../../components/index.ts";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import type { ThemeColors } from "../../types/theme.ts";
import type { IconName } from "../../types/icons.ts";
import pkg from "../../../package.json" with { type: "json" };

/** Props for {@link Welcome}. */
export interface WelcomeProps {
	/** Begin the wizard (also fired by Enter, handled in the container). */
	onBegin: () => void;
}

/**
 * What MCTL is, in three lines — shown on first run so the user knows what
 * they're setting up before the wizard asks for anything. Intentionally about
 * the product, not the wizard steps: the steps reveal themselves as the user
 * walks through them.
 */
interface Feature {
	/** Leading icon, tinted with {@link accent}. A name, not a glyph — the
	 * character depends on the active icon set. */
	icon: IconName;
	/** Semantic colour role for the icon — colour-codes the feature at a glance. */
	accent: keyof ThemeColors;
	/** Short feature name; rendered in the fixed-width label column. */
	name: string;
	/** One-line elaboration, muted. */
	detail: string;
}

const ABOUT: Feature[] = [
	{
		icon: "loader",
		accent: "primary",
		name: "Multi-loader",
		detail: "Vanilla, Paper, Fabric, Forge, NeoForge, Quilt, Purpur",
	},
	{
		icon: "server",
		accent: "secondary",
		name: "Multi-server",
		detail:
			"Many servers from one interface, with shared backups and networking",
	},
	{
		icon: "session",
		accent: "info",
		name: "Sessions",
		detail: "Run in tmux, docker, or foreground mode",
	},
	{
		icon: "backup",
		accent: "success",
		name: "Backups",
		detail: "Automatic, scheduled, and on-demand, with retention policies",
	},
];

/** Widest feature name, so the detail column lines up. */
const LABEL_WIDTH = Math.max(...ABOUT.map((f) => f.name.length));

/** The branded welcome hero. */
export function Welcome({ onBegin }: WelcomeProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();

	return (
		<box
			flexGrow={1}
			flexDirection="column"
			justifyContent="center"
			alignItems="center"
			gap={1}
			padding={2}
		>
			<box flexDirection="row" alignItems="center" gap={3}>
				<ascii-font
					font="block"
					text="mctl"
					color={[colors.primary, colors.secondary]}
				/>
			</box>
			<box flexDirection="column" alignItems="center">
				<text fg={colors.foreground}>Minecraft Server Management Platform</text>
				<text fg={colors.muted} attributes={TextAttributes.DIM}>
					Version {pkg.version ?? "unknown"} — © {new Date().getFullYear()}{" "}
					Nexul
				</text>
			</box>

			<box
				border
				borderStyle="rounded"
				borderColor={colors.border}
				backgroundColor={colors.surface}
				title={` ${icons.separator} WELCOME TO MCTL ${icons.separator} `}
				titleColor={colors.primary}
				titleAlignment="center"
				paddingTop={1}
				paddingBottom={1}
				paddingLeft={2}
				paddingRight={2}
				flexDirection="column"
				gap={1}
				width="100%"
				maxWidth={90}
			>
				<text fg={colors.muted}>
					From a single survival world to a fleet of production servers,{" "}
					<span fg={colors.foreground}>MCTL</span> brings{" "}
					<span fg={colors.foreground}>
						Java management, server provisioning, backups, networking, and
						automation
					</span>{" "}
					together in one fast, extensible terminal interface.
				</text>
				<box flexDirection="column" gap={1}>
					{ABOUT.map((f) => (
						<box key={f.name} flexDirection="row" gap={2} flexShrink={0}>
							<text fg={colors[f.accent]} flexShrink={0}>
								{icons[f.icon]}
							</text>
							<box width={LABEL_WIDTH} flexShrink={0}>
								<text fg={colors.foreground} attributes={TextAttributes.BOLD}>
									{f.name}
								</text>
							</box>
							<text fg={colors.muted}>{f.detail}</text>
						</box>
					))}
				</box>
				<text fg={colors.muted} attributes={TextAttributes.DIM}>
					A quick one-time setup comes next. Everything except the data root can
					be changed later in Settings.
				</text>
			</box>

			<box>
				<Button kind="outline" variant="primary" focused onClick={onBegin}>
					{/* One interpolated string, not `text {expr}`: `Button` only inks
					    its label when `children` is a plain string (see Button.tsx). */}
					{`Get started ${icons.arrowRight}`}
				</Button>
			</box>
			<Hint
				items={[
					{ keys: "Enter", label: "begin" },
					{ keys: "Esc", label: "quit" },
				]}
			/>
		</box>
	);
}
