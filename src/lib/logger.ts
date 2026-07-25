/**
 * Structured logging for MCTL, built on Pino.
 *
 * UI-free, provider-free. Knows about paths (for the log file) and nothing else.
 *
 * **Why a file, not stdout:** in TUI mode OpenTUI owns the terminal; anything
 * written to stdout/stderr corrupts the render. So MCTL always logs to
 * `~/.local/state/mctl/logs/mctl.log` (JSON lines) and never to the console.
 * The CLI reads the same file if it needs diagnostics.
 *
 * **Secrets never reach the log.** Pino's `redact` masks common credential keys
 * defensively, but the real contract is upstream: callers must not pass tokens
 * into log payloads at all (see AGENTS.md § Secrets). Redaction here is a second
 * line of defence, not a licence to log secrets.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { logsDir } from "./paths.ts";

/**
 * Credential-bearing keys that must be masked wherever they appear in a log
 * object. Kept broad on purpose — a redacted field that was never secret costs
 * nothing; a leaked token is a real incident.
 */
const REDACT_PATHS = [
  "token",
  "*.token",
  "authtoken",
  "*.authtoken",
  "secret",
  "*.secret",
  "password",
  "*.password",
  "apiKey",
  "*.apiKey",
  "accessKey",
  "*.accessKey",
  "secretKey",
  "*.secretKey",
];

let root: Logger | undefined;

/**
 * The process-wide root logger, created lazily on first use. Log level comes
 * from `MCTL_LOG_LEVEL` (default `info`). The log directory is created
 * synchronously here so the destination is always writable.
 */
export function logger(): Logger {
  if (root) return root;
  const dir = logsDir();
  mkdirSync(dir, { recursive: true });
  root = pino(
    {
      level: process.env.MCTL_LOG_LEVEL ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    },
    // `append: true` (default) — one growing log; rotation is a later concern.
    // `sync: true`: log volume is tiny and this is a plain file (never the render
    // path), and a *synchronous* destination avoids the async sonic-boom teardown
    // race where a short-lived CLI command (`process.exit` after a fast failure)
    // exits before the async stream's fd has opened — pino's on-exit flush then
    // throws "sonic boom is not ready yet". Sync writes sidestep that entirely.
    pino.destination({ dest: join(dir, "mctl.log"), sync: true }),
  );
  return root;
}

/**
 * Create a child logger tagged with a subsystem name, e.g.
 * `log("config")` → every line carries `{ mod: "config" }`. Preferred over the
 * root logger so lines are attributable to a module.
 */
export function log(mod: string): Logger {
  return logger().child({ mod });
}
