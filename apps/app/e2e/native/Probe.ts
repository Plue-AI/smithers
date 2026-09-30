/*
 * The wire contract between the native main-process driver (MainProcess.ts)
 * and its caller (src/bun/Main.test.ts). It holds no side effects on purpose:
 * MainProcess.ts imports the real entrypoint and exits at the end of the
 * module, so importing it from a test would end the test run.
 */

/** stdout carries build noise too; the report is the line behind this marker. */
export const PROBE_MARKER = "__NATIVE_PROBE__ "

/** One RPC request to make against the handlers the entrypoint registered. */
export interface ProbeExercise {
  readonly label: string
  readonly request: string
  readonly params: unknown
}

export interface ProbeScenario {
  /** What the host says when asked to open a URL in the system browser. */
  readonly openExternalAnswer?: boolean
  readonly exercises?: ReadonlyArray<ProbeExercise>
  /** URLs macOS hands the native wrapper: before the entrypoint loads, then after it has started. */
  readonly openUrlsAtLaunch?: ReadonlyArray<string>
  readonly openUrlsAfterStart?: ReadonlyArray<string>
}

export interface RecordedWindow {
  readonly title: unknown
  readonly url: unknown
  readonly frame: unknown
  readonly hidden: unknown
  readonly activate: unknown
  /** True when the window was handed the very object BrowserView.defineRPC returned. */
  readonly rpcBound: boolean
  /** Every URL the entrypoint loaded into the window after constructing it. */
  readonly loaded: ReadonlyArray<string>
}

export interface NativeProbeReport {
  readonly logs: ReadonlyArray<string>
  readonly windows: ReadonlyArray<RecordedWindow>
  readonly requestNames: ReadonlyArray<string>
  readonly messageNames: ReadonlyArray<string>
  readonly openedExternally: ReadonlyArray<string>
  /** The origin the entrypoint printed, and what its /api/health answered. */
  readonly origin: string | null
  readonly health: unknown
  readonly results: Readonly<Record<string, unknown>>
}
