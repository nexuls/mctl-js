/**
 * Network — how a player reaches this server.
 *
 * Two pictures side by side, and they are genuinely different questions. The
 * **profile** panel is what MCTL arranged: which provider ran, what address it
 * announced, whether it had to fall back, and any DNS name published on top.
 * The **direct** panel is what this machine looks like regardless: the port and
 * bind address from `server.properties`, the LAN address, and whether the server
 * is answering a list ping at all.
 *
 * Keeping them apart matters because a tunnel being up says nothing about the
 * server being alive behind it, and a server answering on the LAN says nothing
 * about anyone outside reaching it. Merging them into one "status" would make
 * both halves unreadable.
 */

import { useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { Button } from "../../../components/index.ts";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useMctl } from "../../../hooks/use-mctl.tsx";
import { useNetworkStatus } from "../../../hooks/use-network.ts";
import { useTheme } from "../../../hooks/use-theme.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import type { NetState } from "../../../types/network.ts";
import { readinessLabel } from "../../../types/network.ts";
import type { ThemeColors } from "../../../types/theme.ts";
import {
	Columns,
	Detail,
	EmptyNote,
	Panel,
	TWO_COLUMN_WIDTH,
	type ServerTabProps,
} from "../panels.tsx";

/**
 * Ring id of this tab's Re-apply button. Exported so the container can splice it
 * into its own ring while the tab is showing — a tab may not open a ring of its
 * own (only one may listen at a time).
 */
export const NETWORK_APPLY_ID = "net-apply";

/** Colour for a network state, in the app's success/warning/error vocabulary. */
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

export function NetworkTab({ server, insight, focus }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const { context } = useMctl();
	const toast = useToast();
	const empty = icons.emptyValue;
	const address = insight?.address;
	const properties = insight?.properties;
	const status = insight?.status;
	const { status: net, loading, refresh } = useNetworkStatus(server);
	const [applying, setApplying] = useState(false);

	const netColor = stateColor(colors, net?.state ?? "inactive");
	const running = server.state === "running";

	/**
	 * Re-apply the server's profile without restarting it — the TUI peer of
	 * `mctl network up`, which until now was the *only* way to do it.
	 *
	 * The two cases it exists for are a tunnel that dropped and a profile that was
	 * just edited; neither should cost a Minecraft restart. Tearing down first is
	 * what makes it a re-apply rather than a second agent.
	 */
	const reapply = async (): Promise<void> => {
		if (!context || !running || applying) return;
		const port = server.session?.port;
		if (port === undefined) {
			toast.error("No port recorded", {
				description:
					"Restart the server so MCTL can see which port it bound, then try again.",
			});
			return;
		}
		setApplying(true);
		try {
			await context.network.teardown(server);
			const result = await context.network.expose(server, port);
			toast.success(
				`${server.id} is reachable at ${result.endpoint.joinAddress}`,
				{
					description:
						result.degradedReason ??
						result.dnsError ??
						result.dnsSkipped ??
						`Through ${result.provider}.`,
				},
			);
		} catch (err) {
			toast.error(`Could not re-apply networking for ${server.id}`, {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setApplying(false);
			refresh();
		}
	};

	const left = (
		<>
			<Panel
				title="Join address"
				accent={net?.state === "up" ? colors.success : undefined}
			>
				<Detail
					label="address"
					value={net?.endpoint?.joinAddress ?? (loading ? "…" : empty)}
					color={colors.primary}
				/>
				<Detail label="profile" value={net?.profile ?? server.network} />
				<Detail
					label="provider"
					value={net ? `${net.providerName} (${net.provider})` : empty}
				/>
				<Detail
					label="state"
					value={net?.state ?? (loading ? "…" : "inactive")}
					color={netColor}
				/>
				<Detail
					label="since"
					value={net?.since ? new Date(net.since).toLocaleString() : empty}
				/>
				{net?.detail ? (
					<box marginTop={1}>
						{/* Always set for `degraded` and `down` — it is the reason the
						    address is not what the profile asked for. */}
						<EmptyNote>{net.detail}</EmptyNote>
					</box>
				) : null}
				{net?.endpoint?.note ? (
					<box marginTop={1}>
						{/* The provider's own caveat. For cloudflared this is the
						    client-side `cloudflared access tcp` command, without which the
						    address above simply does not work — see that provider's docs. */}
						<EmptyNote>{net.endpoint.note}</EmptyNote>
					</box>
				) : null}
				{(net?.endpoint?.alternates ?? []).map((alternate) => (
					<Detail
						key={alternate.label}
						label={alternate.label}
						value={alternate.address}
					/>
				))}
			</Panel>

			<Panel
				title="DNS"
				accent={net?.dns?.state === "ready" ? colors.success : undefined}
			>
				{net?.dns ? (
					<>
						<Detail
							label="hostname"
							value={net.dns.hostname}
							color={colors.primary}
						/>
						<Detail
							label="state"
							value={
								net.dns.state === "ready"
									? "published on start"
									: net.dns.state === "no-token"
										? "not published"
										: "handled by the tunnel"
							}
							color={
								net.dns.state === "ready" ? colors.success : colors.warning
							}
						/>
						{net.dns.detail ? (
							<box marginTop={1}>
								{/* The reason records are missing. Without this the profile
								    looks configured and simply does nothing. */}
								<EmptyNote>{net.dns.detail}</EmptyNote>
							</box>
						) : null}
					</>
				) : (
					<EmptyNote>
						This profile publishes no DNS records. Add a hostname to it in
						Settings → Network to have MCTL keep an A/CNAME and an SRV record
						pointing at this server.
					</EmptyNote>
				)}
			</Panel>

			<Panel title="Provider readiness">
				<Detail
					label="readiness"
					value={net ? readinessLabel(net.readiness) : empty}
					color={
						net?.readiness.kind === "ready" ? colors.success : colors.warning
					}
				/>
				{net?.readiness.kind === "missing" ? (
					<box marginTop={1}>
						<EmptyNote>{net.readiness.hint}</EmptyNote>
					</box>
				) : null}
				{net?.readiness.kind === "unauthenticated" ? (
					<box marginTop={1}>
						<EmptyNote>{net.readiness.hint}</EmptyNote>
					</box>
				) : null}
				<box marginTop={1} flexDirection="row" gap={2} alignItems="center">
					<Button
						size="small"
						kind="ghost"
						variant="primary"
						disabled={!running || applying}
						focused={focus?.isFocused(NETWORK_APPLY_ID) ?? false}
						onFocused={() => focus?.setFocus(NETWORK_APPLY_ID)}
						onClick={() => void reapply()}
					>
						{applying ? "Applying…" : "Re-apply"}
					</Button>
					<text fg={colors.muted} truncate wrapMode="none">
						{running
							? "Brings the profile up again — for a dropped tunnel or one you just edited."
							: "Start the server to apply its profile."}
					</text>
				</box>
			</Panel>
		</>
	);

	const right = (
		<>
			<Panel title="This machine">
				<Detail label="port" value={address ? String(address.port) : empty} />
				<Detail
					label="bind"
					value={address?.bindIp ? address.bindIp : "all interfaces"}
				/>
				<Detail label="lan ip" value={address?.lanIp ?? empty} />
				<Detail
					label="lan address"
					value={address?.joinAddress ?? empty}
					color={colors.primary}
				/>
				<Detail
					label="reachable"
					value={
						status
							? `yes — answered in ${status.latencyMs} ms`
							: server.state === "running"
								? "no answer yet"
								: "the server is not running"
					}
					color={status ? colors.success : colors.muted}
				/>
			</Panel>

			<Panel title="Listeners">
				<Detail
					label="minecraft"
					value={address ? `${address.port} (tcp)` : empty}
				/>
				<Detail
					label="rcon"
					value={
						properties === undefined
							? empty
							: properties.rconEnabled
								? `enabled on ${properties.rconPort}`
								: "disabled"
					}
					color={properties?.rconEnabled ? colors.info : undefined}
				/>
				<Detail
					label="query"
					value={
						properties === undefined
							? empty
							: properties.queryEnabled
								? "enabled"
								: "disabled"
					}
				/>
				<Detail
					label="online mode"
					value={
						properties === undefined
							? empty
							: properties.onlineMode
								? "yes"
								: "no (unauthenticated players allowed)"
					}
					color={properties?.onlineMode === false ? colors.warning : undefined}
				/>
				<Detail label="advertises" value={status?.versionName ?? empty} />
				{properties?.rconEnabled ? (
					<box marginTop={1}>
						{/* Worth knowing where the TPS reading will come from once RCON
						    lands — this server is already configured for it. */}
						<EmptyNote>
							RCON is on, so this server is ready for the TPS readout when the
							RCON client lands.
						</EmptyNote>
					</box>
				) : null}
			</Panel>
		</>
	);

	return <Columns wide={width >= TWO_COLUMN_WIDTH} left={left} right={right} />;
}
