/**
 * Jobs — placeholder until the JobScheduler lands. Long-running work (downloads,
 * installs) becomes a Job with progress here in Phase 2.
 */

import { Placeholder } from "../shared.tsx";

export function Jobs() {
  return (
    <Placeholder
      title="Jobs"
      phase="Phase 2"
      note="Downloads and installs will run as staged jobs with live progress."
    />
  );
}
