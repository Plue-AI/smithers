/**
 * Runs the flows-agent evaluation suite and gates it on the committed baseline.
 *
 * Launch line, from the repository root:
 *
 * ```bash
 * node evals/agent/run.ts
 * ```
 *
 * Add `--update` to rewrite `evals/agent/baseline.json` from this run. Do that
 * only when a score moved for a reason you can name, because the baseline is
 * the record of what the agent used to do. Add `--json` to print the full
 * machine-readable regression report when a run drifts.
 *
 * The run is offline: the only replaced pieces are the model behind the seat
 * resolver and the route it seals against, so no API key, network access, or
 * global CLI install is involved and every score is reproducible.
 *
 * Exit codes follow the shared CI convention. `0` means every case matched the
 * baseline and cleared the gate. `1` means the run disagreed with the committed
 * baseline: a score dropped, a score moved under an unchanged step key, or an
 * observation went missing. `5` means the gate could not decide, which is an
 * unusable harness rather than a result — repair it instead of reading the red.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { readFile, writeFile } from "node:fs/promises"
import {
  Baseline,
  CaseExecutor,
  EvalError,
  Gate,
  Regression,
  Report,
  Runner,
  Suite
} from "../../packages/smithers/agent/evals/src/index.ts"
import * as AgentSuite from "./agent.eval.ts"

const baselinePath = new URL("./baseline.json", import.meta.url)

interface EvalRunHostService {
  readonly args: ReadonlyArray<string>
  readonly readBaseline: Effect.Effect<string, EvalError.EvalError>
  readonly writeBaseline: (contents: string) => Effect.Effect<void, EvalError.EvalError>
  readonly stdout: (text: string) => Effect.Effect<void>
  readonly stderr: (text: string) => Effect.Effect<void>
  readonly setExitCode: (code: number) => Effect.Effect<void>
}

class EvalRunHost extends Context.Service<EvalRunHost, EvalRunHostService>()("evals/agent/run/EvalRunHost") {}

const evalRunHostLayer = Layer.succeed(EvalRunHost)(EvalRunHost.of({
  args: process.argv.slice(2),
  readBaseline: Effect.tryPromise({
    try: () => readFile(baselinePath, "utf8"),
    catch: (cause) => new EvalError.EvalError({ code: "invalid_baseline", message: "Could not read the eval baseline", cause })
  }),
  writeBaseline: (contents) => Effect.tryPromise({
    try: () => writeFile(baselinePath, contents),
    catch: (cause) => new EvalError.EvalError({ code: "invalid_baseline", message: "Could not write the eval baseline", cause })
  }),
  stdout: (text) => Effect.sync(() => process.stdout.write(text)).pipe(Effect.asVoid),
  stderr: (text) => Effect.sync(() => process.stderr.write(text)).pipe(Effect.asVoid),
  setExitCode: (code) => Effect.sync(() => { process.exitCode = code })
}))

/**
 * A fixed instant. Observation timestamps are report material, not evidence,
 * and pinning them keeps two runs of an unchanged suite byte-identical.
 */
const at = "1970-01-01T00:00:00.000Z"

const layer = Layer.merge(
  Layer.succeed(CaseExecutor.CaseExecutor)(AgentSuite.executor),
  Layer.succeed(Runner.Runner)(AgentSuite.scoring)
)

const scores = (run: Runner.RunResult): string =>
  run.observations
    .map((observation) =>
      observation.kind === "score"
        ? `  ${observation.score.toFixed(3)}  ${observation.case}  ${observation.scorer}` +
          (observation.score < 1 ? `\n         ${observation.reason ?? "no reason recorded"}` : "")
        : `  ----   ${observation.case}  ${observation.scorer}\n         inconclusive: ${observation.reason}`
    )
    .join("\n")

const execute = Effect.gen(function*() {
  const suite = yield* Suite.make({
    name: AgentSuite.name,
    cases: AgentSuite.cases,
    bindings: AgentSuite.bindings,
    // One at a time. Every scenario builds its own engine and its own scripted
    // provider, so concurrency would be safe, but a serial run keeps the
    // printed order equal to the declared order.
    concurrency: 1
  })
  const run = yield* Runner.run(suite, { runId: AgentSuite.name, sampleId: "committed", at })
  const failures = run.cases.filter((result) => result.error !== undefined)
  return { run, failures }
})

const update = Effect.gen(function*() {
  const host = yield* EvalRunHost
  const { failures, run } = yield* execute
  if (failures.length > 0) {
    return yield* Effect.fail(
      new EvalError.EvalError({
        code: "executor",
        message: `Refusing to record a baseline: ${failures.length} case(s) did not finish`
      })
    )
  }
  const baseline = yield* Baseline.fromRun(run)
  yield* host.writeBaseline(Baseline.write(baseline))
  yield* host.stdout(`${scores(run)}\nrecorded ${baseline.records.length} baseline record(s)\n`)
  return 0
})

const gate = Effect.gen(function*() {
  const host = yield* EvalRunHost
  const { run } = yield* execute
  const baselineText = yield* host.readBaseline
  const baseline = yield* Baseline.load(baselineText)
  const regression = yield* Regression.compare(baseline, run)
  // A threshold breach is a typed failure rather than a verdict, so it is
  // caught here: a case that scored zero is a result this suite has to report,
  // not a crash.
  const graded = yield* Gate.check(regression, { mean: 1, min: 1 }).pipe(
    Effect.map(Gate.ciGrade),
    Effect.catch((error) =>
      Effect.succeed({
        exitCode: 1 as const,
        summary: `${error.code}: threshold ${error.threshold}, actual ${error.actual}`
      })
    )
  )
  const drifted = regression.regressions.length + regression.nondeterminism.length + regression.missing.length
  yield* host.stdout(`${scores(run)}\n\n${Report.markdown(regression)}`)
  if (drifted > 0) {
    // The full JSON report carries per-case latencies, which are the one
    // nondeterministic field in a run; it is printed only on request so the
    // ordinary output stays diffable.
    if (host.args.includes("--json")) yield* host.stdout(Report.json(regression))
    yield* host.stdout(`\nthe run disagrees with ${baselinePath.pathname}\n`)
  }
  // Precedence: an undecided gate outranks drift. An inconclusive observation
  // is excluded from the comparison's actual set, so it also counts as a
  // missing observation; letting drift win would report a red result the run
  // never measured and would make exit code 5 unreachable.
  const exitCode = graded.exitCode === 5 ? 5 : drifted > 0 ? 1 : graded.exitCode
  // The verdict names the exit. Drift made entirely of missing observations
  // reaches no threshold, so the gate's own summary would say "passed" on a run
  // that exits 1.
  const verdict = drifted > 0 && exitCode === 1
    ? `failed: ${drifted} observation(s) disagree with the baseline`
    : graded.summary
  yield* host.stdout(`${AgentSuite.name}: ${verdict}\n`)
  return exitCode
})

// A harness that cannot load its own baseline, or a scenario that crashed the
// suite, still has to leave a readable exit rather than an unhandled rejection.
const program = Effect.gen(function*() {
  const host = yield* EvalRunHost
  return yield* (host.args.includes("--update") ? update : gate)
}).pipe(
  Effect.catchCause((cause) =>
    EvalRunHost.use((host) => host.stderr(`${Cause.pretty(cause)}\n`).pipe(Effect.as(1)))
  ),
  Effect.flatMap((exitCode) => EvalRunHost.use((host) => host.setExitCode(exitCode))),
  Effect.provide([layer, evalRunHostLayer])
)

await Effect.runPromise(program)
