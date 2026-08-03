/**
 * Servers — the server list. Rebuilt from disk on every relevant event via
 * {@link useServers}; selecting a row opens that server's detail page.
 *
 * Page-layer (AGENTS.md § 3): renders view models, navigates via the router,
 * does no I/O. Keyboard (↑/↓ or j/k to move, Enter to open) is safe alongside the
 * shell's digit nav because none of those keys overlap.
 */

import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useServers } from "../../hooks/use-servers.ts";
import { useRouter } from "../../hooks/use-router.tsx";
import type { Server } from "../../types/server.ts";
import { useIcons } from "../../hooks/use-icons.tsx";
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

function ServerRow({
  server,
  selected,
  onOpen,
}: {
  server: Server;
  selected: boolean;
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
      onMouseDown={onOpen}
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

export function Servers() {
  const { colors } = useTheme();
  const { icons } = useIcons();
  const { data: servers, loading, error } = useServers();
  const { navigate } = useRouter();
  const [selected, setSelected] = useState(0);

  // Keep the selection index valid as the (live) list grows or shrinks.
  useEffect(() => {
    if (selected >= servers.length && servers.length > 0) {
      setSelected(servers.length - 1);
    }
  }, [servers.length, selected]);

  const open = (server: Server) => navigate("server", { serverId: server.id });

  useKeyboard((key) => {
    if (servers.length === 0) return;
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
    <box flexDirection="column" flexGrow={1}>
      <PageHeader
        title="Servers"
        subtitle={
          error
            ? `error: ${error}`
            : loading
              ? "reading servers…"
              : `${servers.length} server${servers.length === 1 ? "" : "s"} ${icons.separator} ${icons.arrowUp}/${icons.arrowDown} move ${icons.separator} Enter open`
        }
      />

      {servers.length === 0 && !loading ? (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={colors.muted}>
            No servers. Create one with{" "}
            <span fg={colors.info}>mctl create &lt;name&gt;</span> (Phase 2).
          </text>
        </box>
      ) : (
        <box flexDirection="column">
          {/* Column header */}
          <box flexDirection="row" gap={1} marginBottom={0}>
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
            <ServerRow
              key={server.id}
              server={server}
              selected={i === selected}
              onOpen={() => {
                setSelected(i);
                open(server);
              }}
            />
          ))}
        </box>
      )}
    </box>
  );
}
