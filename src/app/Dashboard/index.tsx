/**
 * Dashboard — the landing screen: a live summary of all servers plus a recent-
 * activity feed sourced from the event bus (so activity from *every* running
 * `mctl` instance shows up, not just this one).
 *
 * Page-layer (AGENTS.md § 3): renders view models from hooks, does no I/O.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useServers } from "../../hooks/use-servers.ts";
import { useRecentEvents } from "../../hooks/use-recent-events.ts";
import { useRouter } from "../../hooks/use-router.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import type { ThemeColors } from "../../types/theme.ts";
import type { Server } from "../../types/server.ts";
import type { MctlEvent } from "../../types/events.ts";
import { PageHeader } from "../shared.tsx";

/** One summary tile in the top row. */
function StatTile({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const { colors } = useTheme();
  return (
    <box
      flexDirection="column"
      alignItems="center"
      paddingLeft={2}
      paddingRight={2}
      border
      borderStyle="rounded"
      borderColor={colors.border}
    >
      <text fg={color} attributes={TextAttributes.BOLD}>
        {String(value)}
      </text>
      <text fg={colors.muted}>{label}</text>
    </box>
  );
}

/** Count servers by state for the summary tiles. */
function summarize(servers: Server[]) {
  return {
    total: servers.length,
    running: servers.filter((s) => s.state === "running").length,
    stopped: servers.filter((s) => s.state === "stopped").length,
    unavailable: servers.filter((s) => s.state === "unavailable").length,
  };
}

/** `HH:MM:SS` from an ISO timestamp, for the activity feed. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toTimeString().slice(0, 8);
}

/**
 * A one-line human summary of an event for the feed.
 *
 * @param arrow The active icon set's transition marker (`→`, or `->` in ASCII).
 */
function describe(event: MctlEvent, arrow: string): string {
  const payload = event.payload as { id?: string; state?: string } | undefined;
  const id = payload?.id ? ` ${payload.id}` : "";
  const state = payload?.state ? ` ${arrow} ${payload.state}` : "";
  return `${event.type}${id}${state}`;
}

export function Dashboard() {
  const { colors } = useTheme();
  const { icons } = useIcons();
  const { data: servers, loading } = useServers();
  const events = useRecentEvents(12);
  const { navigate } = useRouter();
  const s = summarize(servers);

  return (
    <box flexDirection="column" flexGrow={1} paddingX={1}>
      <PageHeader
        title="Dashboard"
        subtitle={loading ? "reading servers…" : "live server summary & activity"}
      />

      <box flexDirection="row" gap={2} marginBottom={1}>
        <StatTile label="servers" value={s.total} color={colors.primary} />
        <StatTile label="running" value={s.running} color={colors.success} />
        <StatTile label="stopped" value={s.stopped} color={colors.muted} />
        <StatTile
          label="unavailable"
          value={s.unavailable}
          color={s.unavailable > 0 ? colors.error : colors.muted}
        />
      </box>

      {s.total === 0 && !loading ? (
        <box
          onMouseDown={() => navigate("servers")}
          flexDirection="column"
          marginBottom={1}
        >
          <text fg={colors.muted}>
            No servers yet. Press <span fg={colors.info}>2</span> to open Servers.
          </text>
        </box>
      ) : null}

      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderColor={colors.border}
        title="Recent activity"
        titleColor={colors.secondary}
        padding={1}
      >
        {events.length === 0 ? (
          <text fg={colors.muted}>
            No activity yet — events from any instance appear here.
          </text>
        ) : (
          events.map((event) => (
            <box key={event.id} flexDirection="row" gap={1}>
              <text fg={colors.muted}>{clockTime(event.ts)}</text>
              <text fg={activityColor(colors, event.type)}>{describe(event, icons.transition)}</text>
            </box>
          ))
        )}
      </box>
    </box>
  );
}

/** Tint an activity line by event family. */
function activityColor(colors: ThemeColors, type: string): string {
  if (type === "ServerUnavailable") return colors.error;
  if (type === "ServerStateChanged") return colors.success;
  if (type === "ConfigChanged" || type === "RegistryChanged") return colors.info;
  return colors.foreground;
}
