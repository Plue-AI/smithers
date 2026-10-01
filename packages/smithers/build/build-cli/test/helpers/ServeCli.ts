/**
 * The one CLI harness the execution suites share: it serves a command against
 * a workspace through `makeCli` with injected standard output and standard
 * error terminals, the `RuntimeConfig` seam an embedder uses, so a suite reads
 * exactly what the run wrote there and never patches the process streams.
 */
import type * as Audience from "../../src/Audience.ts"
import { makeCli, normalizeArgv } from "../../src/Cli.ts"
import * as Environment from "../../src/Environment.ts"
import type * as PackageExec from "../../src/PackageExec.ts"
import type * as Reporter from "../../src/Reporter.ts"
import { executionPresentation } from "../fixtures/presentation.ts"

export interface ServeOptions {
  /** The hermetic environment `RuntimeConfig.environment` receives; `process.env` when omitted. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** The audience policy; the plain, structured {@link executionPresentation} when omitted. */
  readonly presentation?: Audience.Policy | undefined
  readonly signal?: AbortSignal | undefined
  /** Observes each standard error chunk as it is written, for suites that act mid-run. */
  readonly onLog?: ((text: string) => void) | undefined
  /** The durable approval store `approval: "required"` targets are checked against. */
  readonly approvals?: PackageExec.TargetApprovals | undefined
}

export interface Served {
  /** The code incur's exit hook received; 0 when it was never called. */
  readonly exitCode: number
  /** incur's envelope and anything rendered to the standard output terminal. */
  readonly output: string
  /** Everything written to the standard error terminal: progress, notes, tool output. */
  readonly logs: string
}

/** A terminal that is not a TTY, so renderers stay plain regardless of the host. */
const terminal = (write: (text: string) => void): Reporter.Terminal => ({ write, isTTY: false, columns: undefined })

/**
 * Serves `args` against the workspace at `root` and returns what the run
 * wrote through each seam.
 */
export const serve = async (
  root: string,
  args: ReadonlyArray<string>,
  options: ServeOptions = {}
): Promise<Served> => {
  let exitCode = 0
  let output = ""
  let logs = ""
  // The process entry anchors relative PATH entries before anything reads
  // them; a suite launched by `pnpm exec` inherits `./node_modules/.bin`, so
  // the ambient environment gets the same treatment the real CLI gives it.
  if (options.environment === undefined) Environment.anchorSearchPath(process.env, process.cwd())
  await makeCli({
    presentation: options.presentation ?? executionPresentation,
    environment: options.environment,
    signal: options.signal,
    approvals: options.approvals,
    stdout: terminal((text) => {
      output += text
    }),
    stderr: terminal((text) => {
      logs += text
      options.onLog?.(text)
    })
  }).serve([...normalizeArgv(args), "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      output += text
    }
  })
  return { exitCode, output, logs }
}
