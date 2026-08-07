/**
 * Network — how a player reaches this server.
 *
 * What exists today is the **direct** picture: the port and bind address from
 * `server.properties`, this machine's LAN address, and whether the server is
 * actually answering. Tunnels (cloudflared/playit/ngrok/tailscale) and
 * Cloudflare DNS are Phase 4; the profile named in `mctl.json` is shown either
 * way, and the panel says plainly that only `direct` is implemented rather than
 * implying a tunnel might be up.
 *
 * TODO(phase-4): render `NetworkProvider.status(server)` — readiness, the
 * assigned hostname, and the DNS records MCTL created — once the providers land.
 */

import { useTerminalDimensions } from "@opentui/react";
import { useIcons } from "../../../hooks/use-icons.tsx";
import { useTheme } from "../../../hooks/use-theme.tsx";
import {
	Columns,
	Detail,
	EmptyNote,
	Panel,
	TWO_COLUMN_WIDTH,
	type ServerTabProps,
} from "../panels.tsx";

export function NetworkTab({ server, insight }: ServerTabProps) {
	const { colors } = useTheme();
	const { icons } = useIcons();
	const { width } = useTerminalDimensions();
	const empty = icons.emptyValue;
	const address = insight?.address;
	const properties = insight?.properties;
	const status = insight?.status;

	const left = (
		<>
			<Panel title="Join address" accent={status ? colors.success : undefined}>
				<Detail
					label="address"
					value={address?.joinAddress ?? empty}
					color={colors.primary}
				/>
				<Detail label="port" value={address ? String(address.port) : empty} />
				<Detail
					label="bind"
					value={address?.bindIp ? address.bindIp : "all interfaces"}
				/>
				<Detail label="lan ip" value={address?.lanIp ?? empty} />
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
				<box marginTop={1}>
					{/* Deliberately not claimed: MCTL can only see this machine. A player
					    on the internet also needs a port forward or a tunnel, and
					    nothing here proves that exists. */}
					<EmptyNote>
						This is the address on this machine's network. Reaching it from the
						internet needs a port forward or a tunnel.
					</EmptyNote>
				</box>
			</Panel>

			<Panel title="Profile">
				<Detail label="profile" value={server.network} />
				<Detail
					label="provider"
					value={
						server.network === "direct" ? "direct (no tunnel)" : server.network
					}
				/>
				<box marginTop={1}>
					<EmptyNote>
						Tunnels and Cloudflare DNS arrive in Phase 4. Only `direct` is
						implemented today.
					</EmptyNote>
				</box>
			</Panel>
		</>
	);

	const right = (
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
	);

	return <Columns wide={width >= TWO_COLUMN_WIDTH} left={left} right={right} />;
}
