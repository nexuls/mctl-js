/**
 * The per-process instance id. Every `mctl` invocation (TUI or one-shot CLI) is
 * a transient instance; its id tags every event this process appends to
 * `events.jsonl`, so a tailing instance can skip its own lines and avoid
 * re-processing what it already emitted locally (architecture.md § Statelessness).
 *
 * No I/O — a random id generated once at import and held for the process
 * lifetime. It is intentionally *not* persisted: identity is per-run, not
 * per-machine.
 */

import { randomUUID } from "node:crypto";

/** This process's instance id, stable for the lifetime of the run. */
export const INSTANCE_ID: string = randomUUID();
