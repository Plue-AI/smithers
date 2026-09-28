/**
 * `@smthrs/harness-detect` — which coding-agent CLIs this machine has, and
 * which account each one is signed into.
 *
 * Every host read is injected as a {@link HarnessHost}, so the table is a
 * pure function of a machine's files, environment and `--version` output.
 * The package spawns nothing and touches no filesystem itself: a runtime
 * adapter (Bun, Node, a test fixture) supplies the host.
 *
 * @since 0.1.0
 */

export { detectHarnessesWith } from "./Detect.ts"
export {
  decodeJwtClaims,
  DETECTORS,
  harnessModels,
  harnessModelSpec,
  OPENCODE_CEREBRAS_MODEL,
  OPENCODE_KIMI_MODEL
} from "./Detectors.ts"
export type { Detector, HarnessModels, Signal } from "./Detectors.ts"
export { findBinary, harnessCandidateDirs } from "./HarnessHost.ts"
export type { HarnessHost, HarnessId } from "./HarnessHost.ts"
export {
  modelProbeEnv,
  parseVersionLine,
  PROBE_ENV_KEYS,
  probeEnv,
  VERSION_MAX_LENGTH,
  VERSION_TIMEOUT_MS
} from "./Probe.ts"
