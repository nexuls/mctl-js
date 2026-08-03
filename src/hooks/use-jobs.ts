/**
 * useJobs — the live list of this instance's jobs, for the Jobs page and any
 * page that wants to show a running install.
 *
 * UI-layer hook: it reads snapshots from the {@link JobScheduler} and re-reads
 * them when the bus says something changed. It holds no job state of its own.
 *
 * **Scope: this instance only.** Jobs are in-flight work owned by one process
 * and have no on-disk representation (see `core/jobs/`), so another instance's
 * download does not appear here. What *does* cross instances is the terminal
 * `JobFinished` event, and the data hooks react to that by re-reading disk —
 * which is the part that actually matters.
 */

import { useEffect, useState } from "react";
import type { Job } from "../core/jobs/index.ts";
import { EventType } from "../types/events.ts";
import { useEventBus } from "./use-event-bus.tsx";
import { useMctl } from "./use-mctl.tsx";

/** Event types that mean the job list may have changed. */
const JOB_EVENTS = new Set<string>([EventType.JobProgress, EventType.JobFinished]);

/**
 * Every job this instance has run, newest first, updating as they progress.
 * Empty until the core context is available.
 */
export function useJobs(): Job[] {
  const bus = useEventBus();
  const { context } = useMctl();
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    if (!context) {
      setJobs([]);
      return;
    }
    setJobs(context.jobs.list());
    return bus.subscribe((event) => {
      // Re-reading the whole (short) list rather than patching one entry keeps
      // this in step with the scheduler even for events we don't model here.
      if (JOB_EVENTS.has(event.type)) setJobs(context.jobs.list());
    });
  }, [bus, context]);

  return jobs;
}
