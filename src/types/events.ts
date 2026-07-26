/**
 * Zod schemas and inferred types for MCTL's event system — the sync fabric that
 * keeps multiple `mctl` instances consistent without IPC (plan.md § Event
 * System, architecture.md § Statelessness).
 *
 * No I/O here: this module only describes the envelope and validates lines read
 * back from `events.jsonl`. The in-process bus, the append/tail, and the file
 * watchers live in `core/events/`.
 *
 * **Two tiers, one envelope.** Every state-changing action is one JSON line in
 * `~/.local/state/mctl/events.jsonl`, tagged with the emitting instance id so a
 * tailing instance can skip its own lines. The same envelope also travels on the
 * in-process bus, so a subscriber handles local and cross-instance events
 * identically.
 *
 * **Forward-compatible by design.** `type` is a free `string` and `payload` is
 * `unknown`: a newer MCTL writing an event type this version doesn't know about
 * must not break the tail. Consumers match on `type` and validate `payload`
 * themselves. Well-known types are enumerated in {@link EventType} for reference
 * and autocomplete, not as a closed set.
 */

import { z } from "zod";

/**
 * Well-known event types. This is a *reference list*, not a closed union — the
 * envelope accepts any string `type` so forward/backward compatibility holds
 * across versions. Phase 1 emits the first four; the rest arrive with their
 * subsystems (jobs, install, network, backup) in later phases.
 */
export const EventType = {
  /** `config.json` changed (written or edited on disk). */
  ConfigChanged: "ConfigChanged",
  /** `servers.json` changed — a server was registered, removed, or re-pointed. */
  RegistryChanged: "RegistryChanged",
  /** A server's run state changed (started/stopped). Payload: `{ id, state }`. */
  ServerStateChanged: "ServerStateChanged",
  /** A registered server's path went missing (drive unmounted). Payload: `{ id }`. */
  ServerUnavailable: "ServerUnavailable",
  // Later phases: JobProgress, InstallStepChanged, TunnelUp/Down, JavaInstalled,
  // DownloadCompleted, PlayerJoined/Left, BackupFinished.
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType] | (string & {});

/**
 * The event envelope — one line of `events.jsonl` and the unit the in-process
 * bus carries. Secrets are redacted *before* an event is ever constructed
 * (AGENTS.md § Secrets); `payload` must never contain a token.
 */
export const MctlEvent = z.object({
  /** Envelope version, for forward migration of the log format itself. */
  v: z.number().int().positive().default(1),
  /** Unique event id (used to dedupe if a tail re-reads a line). */
  id: z.string().min(1),
  /** ISO-8601 emit time. */
  ts: z.string(),
  /** Id of the instance that emitted this — a tail skips lines where this is self. */
  instance: z.string().min(1),
  /** Event type; see {@link EventType}. Open string for forward-compat. */
  type: z.string().min(1),
  /** Type-specific data. Consumers validate their own payload shape. */
  payload: z.unknown().optional(),
});
export type MctlEvent = z.infer<typeof MctlEvent>;
