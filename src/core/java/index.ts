/**
 * Java subsystem barrel. Detection (`detect.ts`), vendor fetching
 * (`adoptium.ts`), and the selection policy (`java-manager.ts`) are separate
 * modules with one responsibility each; callers import from here.
 */

export {
  detectJavaInstallations,
  clearJavaProbeCache,
  majorOf,
  probeJava,
} from "./detect.ts";
export {
  installTemurin,
  managedJavaHome,
  resolveTemurin,
  JavaExtractError,
  JavaNotAvailableError,
  type AdoptiumRelease,
  type InstallJavaOptions,
} from "./adoptium.ts";
export {
  chooseInstalled,
  describe,
  installJava,
  listJava,
  preferredMajor,
  resolveJava,
  JavaNotResolvedError,
  type JavaPaths,
  type ResolveJavaOptions,
} from "./java-manager.ts";
