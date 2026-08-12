/**
 * Dialog — a modal overlay centred over the current page, for confirmations and
 * short prompts (delete-server confirm, restore-from-backup, etc.).
 *
 * **Pure-UI, page-layer** (AGENTS.md § 3): renders an overlay and reports intent
 * via `onClose`. It performs no action itself — a destructive confirm is wired to
 * the page's handler, which is where the staged/confirmed deletion actually runs
 * (AGENTS.md § "Destructive operations stage first and confirm").
 *
 * The terminal has no window manager, so the "modal" is two absolutely-positioned
 * layers filling the screen: a dimming backdrop behind, and the dialog box
 * centred on top at a higher `zIndex`. The backdrop carries its own dimming via
 * `opacity` so the page shows faintly through; the dialog is drawn at full
 * opacity as a sibling so it stays crisp.
 */

import { useKeyboard } from "@opentui/react";
import { useModalOpen } from "../hooks/use-modal.tsx";
import { useTheme } from "../hooks/use-theme.tsx";
import { variantColor, type Variant } from "./support.ts";

/** Props for {@link Dialog}. */
export interface DialogProps {
	/** Whether the dialog is shown. When false, nothing renders. */
	open: boolean;
	/** Title on the dialog's top border. */
	title?: string;
	/**
	 * Accent for the dialog's border/title — e.g. `"error"` for a destructive
	 * confirm, `"warning"` for a caution. Defaults to `"primary"`.
	 */
	variant?: Variant;
	/** Invoked when the user dismisses via Esc (or a backdrop click). */
	onClose?: () => void;
	/** Fixed dialog width in cells. Defaults to 48. */
	width?: number;
	/** Body content (message, form, …). */
	children: React.ReactNode;
	/**
	 * Footer content, typically a right-aligned row of {@link "./Button".Button}s.
	 * Rendered under the body with a separating gap.
	 */
	footer?: React.ReactNode;
}

/**
 * A centred modal. Escape triggers `onClose`; clicking the dimmed backdrop does
 * too (clicking the dialog itself does not, so the body stays interactive). The
 * caller keeps focus management for any buttons/inputs in `footer`/`children`.
 */
export function Dialog({
	open,
	title,
	variant = "primary",
	onClose,
	width = 48,
	children,
	footer,
}: DialogProps) {
	const { colors } = useTheme();

	// Tell the shell a modal owns the keyboard, so its global shortcuts — Esc
	// included — stand down for as long as this dialog is up. Raised here rather
	// than by each caller, so every dialog in the app gets it for free.
	useModalOpen(open);

	// Hooks must run unconditionally; the handler no-ops while closed.
	useKeyboard((key) => {
		if (open && key.name === "escape") onClose?.();
	});

	if (!open) return null;

	const accent = variantColor(colors, variant);

	return (
		<box
			position="absolute"
			left={0}
			top={0}
			width="100%"
			height="100%"
			zIndex={1000}
			justifyContent="center"
			alignItems="center"
		>
			{/* Dimming backdrop: fills the screen, its own opacity lets the page show
          through faintly. A click anywhere on it dismisses the dialog. */}
			<box
				position="absolute"
				left={0}
				top={0}
				width="100%"
				height="100%"
				backgroundColor={colors.background}
				opacity={0.7}
				onMouseDown={onClose}
			/>
			{/* The dialog itself, above the backdrop and fully opaque. */}
			<box
				zIndex={1}
				width={width}
				flexDirection="column"
				border
				borderStyle="rounded"
				borderColor={accent}
				title={title}
				titleColor={accent}
				titleAlignment="center"
				backgroundColor={colors.surface}
				padding={1}
				gap={1}
			>
				<box flexDirection="column" gap={1}>
					{children}
				</box>
				{footer ? (
					<box flexDirection="row" justifyContent="flex-end" gap={1}>
						{footer}
					</box>
				) : null}
			</box>
		</box>
	);
}
