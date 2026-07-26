/**
 * CLI output formatting — the human table vs. `--json` split (plan.md § Dual
 * Interface). Both front-ends render the **same** `Server` view models; this
 * module is only the CLI's presentation of them, so there is no divergent
 * formatting logic in core.
 *
 * UI-free of OpenTUI: plain strings to stdout. `--json` emits the raw view model
 * (machine-readable); the default emits an aligned text table.
 */

import type { Server } from "../types/server.ts";

/** Whether `argv` contains the `--json` flag. */
export function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

/** Serialize any value as pretty JSON for `--json` output. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** A single-character-safe state label for the table. */
function stateLabel(server: Server): string {
  return server.state;
}

/**
 * Render a list of servers as an aligned, header-topped text table. An empty
 * list yields a short hint rather than a bare header, so `mctl list` on a fresh
 * install is not confusing.
 */
export function formatServerTable(servers: Server[]): string {
  if (servers.length === 0) {
    return "No servers yet. Create one with `mctl create <name>` (Phase 2).";
  }
  const rows = servers.map((s) => [
    s.id,
    s.name,
    s.kind,
    s.minecraftVersion,
    s.runtime,
    stateLabel(s),
  ]);
  return renderTable(["ID", "NAME", "KIND", "MC", "RUNTIME", "STATE"], rows);
}

/**
 * Render one server's details as aligned `key: value` lines for `mctl status`.
 */
export function formatServerStatus(server: Server): string {
  const lines: [string, string][] = [
    ["id", server.id],
    ["name", server.name],
    ["kind", server.kind],
    ["minecraft", server.minecraftVersion],
    ["loader", server.loaderVersion ?? "—"],
    ["java", formatJava(server)],
    ["memory", server.memory],
    ["runtime", server.runtime],
    ["network", server.network],
    ["state", server.state],
    ["available", String(server.available)],
    ["path", server.path],
  ];
  if (server.session) {
    lines.push(["pid", String(server.session.pid)]);
    if (server.session.port !== undefined) {
      lines.push(["port", String(server.session.port)]);
    }
    lines.push(["startedAt", server.session.startedAt]);
  }
  const width = Math.max(...lines.map(([k]) => k.length));
  return lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

/** Human-readable Java field: a bare major, or `<n> (pinned)`. */
function formatJava(server: Server): string {
  if (server.java === undefined) return "—";
  return typeof server.java === "number"
    ? String(server.java)
    : `${server.java.pinned} (pinned)`;
}

/** Render headered rows as a space-aligned table (columns sized to content). */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => (r[col] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}
