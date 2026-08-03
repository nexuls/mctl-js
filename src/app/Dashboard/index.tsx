/**
 * Dashboard — the landing screen and, since the Servers page was folded into it,
 * the app's single server list: a live summary across the top and an aligned
 * table of every server below it. The selected row expands in place to show the
 * rest of that server's view model, so browsing the fleet never costs a
 * navigation.
 *
 * Page-layer (AGENTS.md § 3): renders view models from hooks and navigates; it
 * does no I/O. Keyboard (↑/↓ or j/k to move, Enter to open, `c` console, `n` new)
 * is safe alongside the shell's digit nav because none of those keys overlap.
 */

import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useServers } from "../../hooks/use-servers.ts";
import { useRouter } from "../../hooks/use-router.tsx";
import { useIcons } from "../../hooks/use-icons.tsx";
import type { Server } from "../../types/server.ts";
import { PageHeader, serverStateColor, serverStateIcon } from "../shared.tsx";

/** Fixed column widths for the aligned server rows. */
const COLS = { id: 16, kind: 10, mc: 10, runtime: 12 };

/**
 * Pad/trim a cell to a fixed width so rows align without a table renderable.
 *
 * @param ellipsis The active icon set's truncation marker. Its own length is
 *   subtracted, not a literal 1 — the ASCII set spells it "...", and assuming
 *   one cell would push the column past `width` and break the alignment this
 *   function exists to provide.
 */
function cell(text: string, width: number, ellipsis: string): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}`.padEnd(
    width,
  );
}

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

/** A `label: value` row inside the expanded panel. */
function Detail({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <box flexDirection="row" gap={1}>
      <text fg={colors.muted}>{label.padEnd(10)}</text>
      <text fg={colors.foreground}>{value}</text>
    </box>
  );
}

/**
 * Human-readable Java field.
 *
 * @param empty The active icon set's placeholder for an absent value — passed in
 *   rather than hardcoded, since this is a module function with no hooks.
 */
function javaLabel(server: Server, empty: string): string {
  if (server.java === undefined) return empty;
  return typeof server.java === "number"
    ? String(server.java)
    : `${server.java.pinned} (pinned)`;
}

/** One table row. */
function ServerRow({
  server,
  selected,
  onSelect,
  onOpen,
}: {
  server: Server;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { colors } = useTheme();
  const { icons } = useIcons();
  const stateColor = serverStateColor(colors, server.state);
  return (
    <box
      flexDirection="row"
      gap={1}
      backgroundColor={selected ? colors.surface : undefined}
      // A first click selects (and therefore expands); a click on the already
      // selected row opens it. Mouse and keyboard then agree: Enter on the
      // selected row is the same "open" gesture.
      onMouseDown={selected ? onOpen : onSelect}
    >
      <text fg={selected ? colors.primary : colors.muted}>
        {selected ? icons.caret : " "}
      </text>
      <text
        fg={selected ? colors.primary : colors.foreground}
        attributes={selected ? TextAttributes.BOLD : undefined}
      >
        {cell(server.id, COLS.id, icons.ellipsis)}
      </text>
      <text fg={colors.muted}>{cell(server.kind, COLS.kind, icons.ellipsis)}</text>
      <text fg={colors.muted}>
        {cell(server.minecraftVersion, COLS.mc, icons.ellipsis)}
      </text>
      <text fg={colors.muted}>
        {cell(server.runtime, COLS.runtime, icons.ellipsis)}
      </text>
      {/* State reads as shape *and* colour, so it survives a colour-blind eye. */}
      <text fg={stateColor}>
        {icons[serverStateIcon(server.state)]} {server.state}
      </text>
    </box>
  );
}

/**
 * The expanded panel rendered directly beneath the selected row: everything in
 * the view model the table has no column for, plus the live session when the
 * server is running.
 */
function ServerDetails({ server }: { server: Server }) {
  const { colors } = useTheme();
  const { icons } = useIcons();
  return (
    <box
      flexDirection="column"
      marginLeft={2}
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
      border={["left"]}
      borderColor={colors.primary}
    >
      <box flexDirection="row" gap={4}>
        <box flexDirection="column">
          <Detail label="name" value={server.name} />
          <Detail label="loader" value={server.loaderVersion ?? icons.emptyValue} />
          <Detail label="java" value={javaLabel(server, icons.emptyValue)} />
          <Detail label="memory" value={server.memory} />
        </box>
        <box flexDirection="column">
          <Detail label="network" value={server.network} />
          {server.session ? (
            <>
              <Detail label="pid" value={String(server.session.pid)} />
              <Detail
                label="port"
                value={
                  server.session.port === undefined
                    ? icons.emptyValue
                    : String(server.session.port)
                }
              />
              <Detail label="started" value={server.session.startedAt} />
            </>
          ) : null}
        </box>
      </box>
      <Detail label="path" value={server.path} />
      <box marginTop={1}>
        <text fg={colors.muted}>
          <span fg={colors.info}>Enter</span> details {icons.separator}{" "}
          <span fg={colors.info}>c</span> console {icons.separator}{" "}
          <span fg={colors.info}>n</span> new server
        </text>
      </box>
    </box>
  );
}

export function Dashboard() {
  const { colors } = useTheme();
  const { icons } = useIcons();
  const { data: servers, loading, error } = useServers();
  const { navigate } = useRouter();
  const [selected, setSelected] = useState(0);
  const s = summarize(servers);

  // Keep the selection index valid as the (live) list grows or shrinks.
  useEffect(() => {
    if (selected >= servers.length && servers.length > 0) {
      setSelected(servers.length - 1);
    }
  }, [servers.length, selected]);

  const open = (server: Server) => navigate("server", { serverId: server.id });

  useKeyboard((key) => {
    // `n` works with an empty list — it is how the first server gets made.
    if (key.name === "n") {
      navigate("create");
      return;
    }
    if (servers.length === 0) return;
    if (key.name === "c") {
      const server = servers[selected];
      if (server) navigate("console", { serverId: server.id });
      return;
    }
    if (key.name === "down" || key.name === "j") {
      setSelected((i) => Math.min(i + 1, servers.length - 1));
    } else if (key.name === "up" || key.name === "k") {
      setSelected((i) => Math.max(i - 1, 0));
    } else if (key.name === "return") {
      const server = servers[selected];
      if (server) open(server);
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} paddingX={1}>
      <PageHeader
        title="Dashboard"
        subtitle={
          error
            ? `error: ${error}`
            : loading
              ? "reading servers…"
              : `${servers.length} server${servers.length === 1 ? "" : "s"} ${icons.separator} ${icons.arrowUp}/${icons.arrowDown} move ${icons.separator} Enter open ${icons.separator} c console ${icons.separator} n new`
        }
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

      {servers.length === 0 && !loading ? (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={colors.muted}>
            No servers yet. Press <span fg={colors.info}>n</span> to create one,
            or run <span fg={colors.info}>mctl create &lt;name&gt;</span>.
          </text>
        </box>
      ) : (
        <box flexDirection="column">
          {/* Column header */}
          <box flexDirection="row" gap={1}>
            <text fg={colors.muted}> </text>
            <text fg={colors.secondary} attributes={TextAttributes.BOLD}>
              {cell("ID", COLS.id, icons.ellipsis)}
            </text>
            <text fg={colors.secondary}>
              {cell("KIND", COLS.kind, icons.ellipsis)}
            </text>
            <text fg={colors.secondary}>{cell("MC", COLS.mc, icons.ellipsis)}</text>
            <text fg={colors.secondary}>
              {cell("RUNTIME", COLS.runtime, icons.ellipsis)}
            </text>
            <text fg={colors.secondary}>STATE</text>
          </box>
          {servers.map((server, i) => (
            <box key={server.id} flexDirection="column">
              <ServerRow
                server={server}
                selected={i === selected}
                onSelect={() => setSelected(i)}
                onOpen={() => open(server)}
              />
              {i === selected ? <ServerDetails server={server} /> : null}
            </box>
          ))}
        </box>
      )}
    </box>
  );
}
