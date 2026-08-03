/**
 * Jobs — the long-running work this instance is doing (installs, JDK downloads),
 * with live progress.
 *
 * Page-layer (AGENTS.md § 3): it renders {@link useJobs} snapshots and does no
 * I/O. The list is deliberately **this instance's** jobs only — a job is
 * in-flight work owned by one process and has no on-disk form, so there is
 * nothing for another instance to show (see `core/jobs/`). What crosses
 * instances is the finished result, and the server list reflects that already.
 */

import { TextAttributes } from "@opentui/core";
import { ProgressBar } from "../../components/index.ts";
import type { Job, JobState } from "../../core/jobs/index.ts";
import { useIcons } from "../../hooks/use-icons.tsx";
import { useJobs } from "../../hooks/use-jobs.ts";
import { useTheme } from "../../hooks/use-theme.tsx";
import type { ThemeColors } from "../../types/theme.ts";
import type { IconName } from "../../types/icons.ts";
import { PageHeader } from "../shared.tsx";

/** Colour for a job state — the same success/warning/error vocabulary as servers. */
function stateColor(colors: ThemeColors, state: JobState): string {
  switch (state) {
    case "done":
      return colors.success;
    case "failed":
      return colors.error;
    case "cancelled":
      return colors.warning;
    case "running":
      return colors.primary;
    default:
      return colors.muted;
  }
}

/** Icon name for a job state; shape carries the meaning alongside colour. */
function stateIcon(state: JobState): IconName {
  switch (state) {
    case "done":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "warning";
    case "running":
      return "running";
    default:
      return "stopped";
  }
}

function JobRow({ job }: { job: Job }) {
  const { colors } = useTheme();
  const { icons } = useIcons();
  const active = job.state === "running" || job.state === "queued";

  return (
    <box
      flexDirection="column"
      border
      borderColor={colors.border}
      paddingX={1}
      marginBottom={1}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={stateColor(colors, job.state)}>{icons[stateIcon(job.state)]}</text>
        <text fg={colors.foreground} attributes={TextAttributes.BOLD}>
          {job.title}
        </text>
        <text fg={colors.muted}>{job.kind}</text>
        <text fg={stateColor(colors, job.state)}>{job.state}</text>
      </box>

      {active ? (
        <box flexDirection="column">
          <text fg={colors.muted}>
            {job.step ?? "working"}
            {job.message ? ` ${icons.separator} ${job.message}` : ""}
          </text>
          <ProgressBar
            value={job.fraction ?? 0}
            // A step with no measurable fraction (resolving a version, running
            // an installer) sweeps rather than sitting at 0% looking stuck.
            indeterminate={job.fraction === undefined}
            width={40}
            readout={job.fraction === undefined ? "none" : "percent"}
          />
        </box>
      ) : job.error ? (
        <text fg={colors.error}>{job.error}</text>
      ) : null}
    </box>
  );
}

export function Jobs() {
  const { colors } = useTheme();
  const jobs = useJobs();
  const running = jobs.filter(
    (job) => job.state === "running" || job.state === "queued",
  ).length;

  return (
    <box flexDirection="column" flexGrow={1} paddingX={1}>
      <PageHeader
        title="Jobs"
        subtitle={
          jobs.length === 0
            ? "nothing has run in this instance yet"
            : `${jobs.length} job${jobs.length === 1 ? "" : "s"}, ${running} active`
        }
      />
      {jobs.length === 0 ? (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={colors.muted}>
            Installs and JDK downloads started from this instance appear here.
          </text>
        </box>
      ) : (
        <box flexDirection="column">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </box>
      )}
    </box>
  );
}
