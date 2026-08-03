/**
 * Server — the detail page for one server, addressed by the router's `serverId`
 * param and re-derived live via {@link useServer}. Read-only in Phase 1
 * (start/stop/console arrive in Phase 2); it shows the full view model.
 *
 * Page-layer (AGENTS.md § 3): renders the view model, no I/O.
 */

import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useServer } from "../../hooks/use-servers.ts";
import { useRouter } from "../../hooks/use-router.tsx";
import type { Server } from "../../types/server.ts";
import { useIcons } from "../../hooks/use-icons.tsx";
import { PageHeader, serverStateColor, serverStateIcon } from "../shared.tsx";

/** A `label: value` detail row. */
function Detail({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <box flexDirection="row" gap={1}>
      <text fg={colors.muted}>{label.padEnd(12)}</text>
      <text fg={colors.foreground}>{value}</text>
    </box>
  );
}

/**
 * Human-readable Java field.
 *
 * @param empty The active icon set's placeholder for an absent value — passed
 *   in rather than hardcoded, since this is a module function with no hooks.
 */
function javaLabel(server: Server, empty: string): string {
  if (server.java === undefined) return empty;
  return typeof server.java === "number"
    ? String(server.java)
    : `${server.java.pinned} (pinned)`;
}

export function ServerDetail() {
  const { colors } = useTheme();
  const { icons } = useIcons();
  const { params } = useRouter();
  const id = params.serverId ?? "";
  const { data: server, loading } = useServer(id);

  if (loading) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <PageHeader title={id} subtitle="reading…" />
      </box>
    );
  }

  if (!server) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <PageHeader title={id} subtitle="not found" />
        <text fg={colors.muted}>
          No server with id <span fg={colors.error}>{id}</span>. Press{" "}
          <span fg={colors.info}>Esc</span> to go back.
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2} alignItems="center" marginBottom={1}>
        <text fg={colors.foreground} attributes={TextAttributes.BOLD}>
          {server.name}
        </text>
        <text fg={serverStateColor(colors, server.state)}>
          {icons[serverStateIcon(server.state)]} {server.state}
        </text>
      </box>

      <box
        flexDirection="column"
        border
        borderColor={colors.border}
        title="Configuration"
        titleColor={colors.secondary}
        padding={1}
        gap={0}
      >
        <Detail label="id" value={server.id} />
        <Detail label="kind" value={server.kind} />
        <Detail label="minecraft" value={server.minecraftVersion} />
        <Detail
          label="loader"
          value={server.loaderVersion ?? icons.emptyValue}
        />
        <Detail label="java" value={javaLabel(server, icons.emptyValue)} />
        <Detail label="memory" value={server.memory} />
        <Detail label="runtime" value={server.runtime} />
        <Detail label="network" value={server.network} />
        <Detail label="path" value={server.path} />
      </box>

      {server.session ? (
        <box
          flexDirection="column"
          border
          borderColor={colors.border}
          title="Live session"
          titleColor={colors.success}
          padding={1}
          marginTop={1}
        >
          <Detail label="pid" value={String(server.session.pid)} />
          {server.session.port !== undefined ? (
            <Detail label="port" value={String(server.session.port)} />
          ) : null}
          <Detail label="startedAt" value={server.session.startedAt} />
        </box>
      ) : null}
    </box>
  );
}
