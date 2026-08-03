/**
 * Server — the detail page for one server, addressed by the router's `serverId`
 * param and re-derived live via {@link useServer}. It shows the full view model
 * and owns the lifecycle actions: start, stop, restart, console, delete.
 *
 * Page-layer (AGENTS.md § 3): renders the view model and calls
 * `RuntimeManager` / `ServerManager` through {@link useMctl}; no I/O of its own.
 * The buttons are exactly the CLI's `start`/`stop`/`restart`/`delete`, calling
 * the same services — the two front-ends are projections of one core.
 *
 * **Delete is guarded by a two-step confirmation**, and even then only removes
 * the registry entry: erasing worlds from a TUI keystroke is not something MCTL
 * offers, and `mctl delete --files --yes` is the deliberate, explicit path
 * (AGENTS.md § Secrets and user data).
 */

import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../hooks/use-theme.tsx";
import { useServer } from "../../hooks/use-servers.ts";
import { useRouter } from "../../hooks/use-router.tsx";
import { useFocusRing } from "../../hooks/use-focus-ring.ts";
import { useMctl } from "../../hooks/use-mctl.tsx";
import { useToast } from "../../hooks/use-toast.tsx";
import type { Server } from "../../types/server.ts";
import { useIcons } from "../../hooks/use-icons.tsx";
import { Button, Dialog, Hint } from "../../components/index.ts";
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

/** Which lifecycle action is currently in flight, for the button labels. */
type Pending = "start" | "stop" | "restart" | undefined;

export function ServerDetail() {
  const { colors } = useTheme();
  const { icons } = useIcons();
  const { params, navigate } = useRouter();
  const toast = useToast();
  const { context } = useMctl();
  const id = params.serverId ?? "";
  const { data: server, loading, refresh } = useServer(id);
  const [pending, setPending] = useState<Pending>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The action bar's buttons only honour Enter/Space while `focused`, so the page
  // owns a ring over them — without it the actions would be mouse-only, which is
  // not acceptable in a terminal UI. The ring's membership follows the *probed*
  // state, because that is what decides whether Stop+Restart or Start is on
  // screen; `useFocusRing` clamps its index, so the set changing under it (a
  // server stopping in another instance) is safe.
  const actions =
    server?.state === "running"
      ? ["stop", "restart", "console", "remove"]
      : ["start", "console", "remove"];
  const ring = useFocusRing(actions);

  /**
   * Run a lifecycle action, reporting the outcome as a toast.
   *
   * The view model is *not* patched optimistically: the action publishes a
   * `ServerStateChanged` event and `useServer` re-reads from disk, so what the
   * page shows is always a live probe rather than what it hoped would happen.
   */
  const act = async (action: Exclude<Pending, undefined>) => {
    if (!context || pending) return;
    setPending(action);
    try {
      if (action === "start") await context.runtime.start(id);
      else if (action === "stop") await context.runtime.stop(id);
      else await context.runtime.restart(id);
      toast.success(`${id} ${action === "stop" ? "stopped" : "started"}`);
    } catch (err) {
      toast.error(`Could not ${action} ${id}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(undefined);
      refresh();
    }
  };

  const remove = async () => {
    if (!context) return;
    setConfirmDelete(false);
    try {
      await context.servers.deleteServer(id);
      toast.success(`Removed ${id}`, {
        description: "Its directory and worlds were left untouched.",
      });
      navigate("dashboard");
    } catch (err) {
      toast.error(`Could not remove ${id}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

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
    <box flexDirection="column" flexGrow={1} paddingX={1}>
      <box flexDirection="row" gap={2} alignItems="center" marginBottom={1}>
        <text fg={colors.foreground} attributes={TextAttributes.BOLD}>
          {server.name}
        </text>
        <text fg={serverStateColor(colors, server.state)}>
          {icons[serverStateIcon(server.state)]} {server.state}
        </text>
      </box>

      {/* Action bar. Which of start/stop is offered follows the *probed* state,
          so a server another instance started shows "Stop" here without a
          refresh keystroke. */}
      <box flexDirection="row" gap={1} marginBottom={1}>
        {server.state === "running" ? (
          <>
            <Button
              size="small"
              kind="ghost"
              variant="error"
              disabled={pending !== undefined}
              focused={ring.isFocused("stop")}
              onFocused={() => ring.setFocus("stop")}
              onClick={() => void act("stop")}
            >
              {pending === "stop" ? "Stopping…" : "Stop"}
            </Button>
            <Button
              size="small"
              kind="ghost"
              variant="warning"
              disabled={pending !== undefined}
              focused={ring.isFocused("restart")}
              onFocused={() => ring.setFocus("restart")}
              onClick={() => void act("restart")}
            >
              {pending === "restart" ? "Restarting…" : "Restart"}
            </Button>
          </>
        ) : (
          <Button
            size="small"
            kind="ghost"
            variant="success"
            disabled={pending !== undefined || !server.available}
            focused={ring.isFocused("start")}
            onFocused={() => ring.setFocus("start")}
            onClick={() => void act("start")}
          >
            {pending === "start" ? "Starting…" : "Start"}
          </Button>
        )}
        <Button
          size="small"
          kind="ghost"
          variant="info"
          focused={ring.isFocused("console")}
          onFocused={() => ring.setFocus("console")}
          onClick={() => navigate("console", { serverId: server.id })}
        >
          Console
        </Button>
        <Button
          size="small"
          kind="ghost"
          variant="neutral"
          disabled={server.state === "running"}
          focused={ring.isFocused("remove")}
          onFocused={() => ring.setFocus("remove")}
          onClick={() => setConfirmDelete(true)}
        >
          Remove
        </Button>
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

      <box marginTop={1}>
        <Hint
          items={[
            { keys: "Tab", label: "next action" },
            { keys: "Enter", label: "activate" },
            { keys: "Esc", label: "back" },
          ]}
        />
      </box>

      <Dialog
        open={confirmDelete}
        title="Remove server"
        onClose={() => setConfirmDelete(false)}
      >
        <box flexDirection="column" gap={1}>
          <text fg={colors.foreground}>
            Remove <span fg={colors.primary}>{server.id}</span> from MCTL?
          </text>
          {/* Said plainly, because "delete" in most tools means the files go
              too. Erasing worlds is `mctl delete --files --yes` only. */}
          <text fg={colors.muted}>
            Its directory and worlds stay on disk at {server.path}. Only the
            registry entry is removed.
          </text>
          <box flexDirection="row" gap={1}>
            <Button
              size="small"
              kind="solid"
              variant="error"
              onClick={() => void remove()}
            >
              Remove
            </Button>
            <Button
              size="small"
              kind="ghost"
              variant="neutral"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </box>
        </box>
      </Dialog>
    </box>
  );
}
