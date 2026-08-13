/**
 * Network — which ways of exposing a server this machine can actually use, the
 * profiles that are configured, and where every server is currently reachable.
 *
 * Page-layer (AGENTS.md § 3): it renders {@link useNetworkOverview} and
 * {@link useNetworkStatus} projections and does no I/O of its own.
 *
 * The page is built around one question a user actually has — *"can I use a
 * tunnel, and if not, what do I install?"* — so a provider MCTL cannot use is a
 * **row with an install command**, not an absence. A missing binary is the
 * normal state of a fresh machine, and hiding the providers that are missing
 * would leave the page saying only "direct", which is precisely the information
 * the user does not need.
 */

import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ProviderReadiness } from "../../core/network/index.ts";
import { useIcons } from "../../hooks/use-icons.tsx";
import {
	useNetworkOverview,
	useNetworkStatus,
} from "../../hooks/use-network.ts";
import { useServers } from "../../hooks/use-servers.ts";
import { useTheme } from "../../hooks/use-theme.tsx";
import { readinessLabel } from "../../types/network.ts";
import type { NetState } from "../../types/network.ts";
import type { Server } from "../../types/server.ts";
import type { ThemeColors } from "../../types/theme.ts";
import type { IconName } from "../../types/icons.ts";
import { PageHeader } from "../shared.tsx";

/** Width at or above which the page lays its two halves out side by side. */
const TWO_COLUMN_WIDTH = 100;

/** Colour for a readiness, in the app's success/warning/error vocabulary. */
function readinessColor(colors: ThemeColors, kind: string): string {
	switch (kind) {
		case "ready":
			return colors.success;
		case "missing":
			return colors.muted;
		case "unauthenticated":
			return colors.warning;
		default:
			return colors.error;
	}
}

/** Colour for a server's network state. */
function stateColor(colors: ThemeColors, state: NetState): string {
	switch (state) {
		case "up":
			return colors.success;
		case "degraded":
			return colors.warning;
		case "down":
			return colors.error;
		default:
			return colors.muted;
	}
}

/** Icon for a readiness — shape carries the meaning alongside colour. */
function readinessIcon(kind: string): IconName {
	switch (kind) {
		case "ready":
			return "success";
		case "missing":
			return "stopped";
		case "unauthenticated":
			return "warning";
		default:
			return "error";
	}
}

/**
 * A bordered, titled section. Local to this page, like the Server page's `Panel`.
 *
 * Deliberately **not** `flexGrow`/`flexBasis`: those share the parent's *main*
 * axis, and inside this page's column that makes the sections fight over the
 * page's height and render as overlapping text — the same trap the Dashboard's
 * expanded panel hit (see `memory.md`). Sections size to their content.
 */
function Section({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle?: string;
	children: React.ReactNode;
}) {
	const { colors } = useTheme();
	return (
		<box
			flexDirection="column"
			border
			borderColor={colors.border}
			title={` ${title} `}
			paddingX={1}
			marginBottom={1}
			flexShrink={0}
		>
			{subtitle ? (
				<text fg={colors.muted} truncate wrapMode="none">
					{subtitle}
				</text>
			) : null}
			{children}
		</box>
	);
}

/** One provider: its state, and — when it is missing — how to get it. */
function ProviderRow({ entry }: { entry: ProviderReadiness }) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const color = readinessColor(colors, entry.readiness.kind);

	return (
		<box flexDirection="column" marginTop={1}>
			<box flexDirection="row" gap={1}>
				<text fg={color}>{icons[readinessIcon(entry.readiness.kind)]}</text>
				<text fg={colors.foreground} attributes={TextAttributes.BOLD}>
					{entry.providerName}
				</text>
				<text fg={colors.muted}>{entry.provider}</text>
			</box>
			<text fg={color} truncate wrapMode="none">
				{readinessLabel(entry.readiness)}
			</text>
			{/* The install command is the whole point of showing a missing provider,
			    so it is printed in full rather than truncated into uselessness. */}
			{entry.readiness.kind === "missing" ? (
				<text fg={colors.info}>{entry.readiness.hint}</text>
			) : null}
			{entry.readiness.kind === "unauthenticated" ? (
				<text fg={colors.info}>{entry.readiness.hint}</text>
			) : null}
		</box>
	);
}

/** One server's live endpoint. */
function ServerRow({ server }: { server: Server }) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { status } = useNetworkStatus(server);

	return (
		<box flexDirection="column" marginTop={1}>
			<box flexDirection="row" gap={1}>
				<text fg={stateColor(colors, status?.state ?? "inactive")}>
					{icons.bullet}
				</text>
				<text fg={colors.foreground} attributes={TextAttributes.BOLD}>
					{server.id}
				</text>
				<text fg={colors.muted}>{status?.profile ?? server.network}</text>
				<text fg={stateColor(colors, status?.state ?? "inactive")}>
					{status?.state ?? "…"}
				</text>
			</box>
			<text fg={colors.primary} truncate wrapMode="none">
				{status?.endpoint?.joinAddress ?? icons.emptyValue}
			</text>
			{status?.detail ? (
				<text fg={colors.warning} truncate wrapMode="none">
					{status.detail}
				</text>
			) : null}
		</box>
	);
}

export function Network() {
	const { colors } = useTheme();
	const { providers, profiles, loading, error } = useNetworkOverview();
	const { data: servers } = useServers();
	const { width } = useTerminalDimensions();
	const wide = width >= TWO_COLUMN_WIDTH;

	const ready = providers.filter((p) => p.readiness.kind === "ready").length;

	const left = (
		<box
			flexDirection="column"
			flexGrow={wide ? 1 : undefined}
			flexBasis={wide ? 1 : undefined}
		>
			<Section
				title="Providers"
				subtitle="MCTL never downloads these — install them yourself."
			>
				{loading && providers.length === 0 ? (
					<text fg={colors.muted}>checking…</text>
				) : (
					providers.map((entry) => (
						<ProviderRow key={entry.provider} entry={entry} />
					))
				)}
			</Section>
		</box>
	);

	const right = (
		<box
			flexDirection="column"
			flexGrow={wide ? 1 : undefined}
			flexBasis={wide ? 1 : undefined}
		>
			<Section
				title="Profiles"
				subtitle="Defined in config.json; a server names one."
			>
				{profiles.map((profile) => (
					<box key={profile.name} flexDirection="row" gap={1} marginTop={1}>
						<text fg={colors.foreground} attributes={TextAttributes.BOLD}>
							{profile.name}
						</text>
						<text fg={profile.known ? colors.muted : colors.error}>
							{profile.known
								? profile.provider
								: `${profile.provider} (unknown)`}
						</text>
						{profile.dnsHostname ? (
							<text fg={colors.info}>dns {profile.dnsHostname}</text>
						) : null}
					</box>
				))}
			</Section>

			<Section title="Servers" subtitle="Where each server is reachable now.">
				{servers.length === 0 ? (
					<text fg={colors.muted}>no servers yet</text>
				) : (
					servers.map((server) => <ServerRow key={server.id} server={server} />)
				)}
			</Section>
		</box>
	);

	return (
		<box flexDirection="column" flexGrow={1} paddingX={1}>
			<PageHeader
				title="Network"
				subtitle={
					error
						? `error: ${error}`
						: `${ready} of ${providers.length} providers usable on this machine`
				}
			/>
			<box flexDirection={wide ? "row" : "column"} gap={wide ? 1 : 0}>
				{left}
				{right}
			</box>
			<box marginTop={1}>
				<text fg={colors.muted} truncate wrapMode="none">
					Tunnels come up when a server starts. `mctl network up &lt;id&gt;`
					re-applies a profile without restarting the server.
				</text>
			</box>
		</box>
	);
}
