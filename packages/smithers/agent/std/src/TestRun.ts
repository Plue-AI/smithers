/**
 * The `test` flow: run the declared suite, and answer with the two facts.
 *
 * Two things this returns that a shell command cannot. First, a *reading*:
 * `{passed, failed}` parsed from the runner's own report, with the raw tail
 * kept for whatever the parse could not carry — a suite's answer is a number
 * and a list of names, not twenty kilobytes of stdout for a model to re-read.
 *
 * Second, `against: "base"`: the same selection also runs against the pristine
 * base commit in a scratch checkout, and the two failure sets are differenced
 * here. That is the whole of attribution, in one call. Without it, agents pay
 * for it in frames — sphinx-8721 spent fourteen frames because a pre-existing
 * failure was never baselined, sympy-13878 spent $0.90 on the same mistake, and
 * django-24970 spent three frames. The rule the harness teaches ("before
 * blaming your own edit, run the same command on the unmodified tree") is only
 * cheap when the tool can do it.
 *
 * A third thing is answered on the way out: whether a non-zero exit is the
 * tree's failure at all, or the command failing to resolve a name. Jev decides
 * it through `Probe.classify`, so the flow needs an `Evaluator` and a host
 * uses its configured subscription seat. A judge that does not answer fails the call with
 * the code `Probe.unjudged` names, because a run nobody judged is not a run
 * this flow can report on.
 *
 * @since 1.0.0
 */

import * as Flow from "@smthrs/core/Flow"
import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Container from "./Container.ts"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Exec from "./internal/Exec.ts"
import { GitWorktree } from "./internal/GitWorktree.ts"
import * as Prune from "./internal/Prune.ts"
import * as TestReport from "./internal/TestReport.ts"
import { MAX_SHELL_OUTPUT_BYTES, truncateBytes } from "./internal/Text.ts"
import * as Probe from "./Probe.ts"
import * as StdError from "./StdError.ts"
import * as TestRunner from "./TestRunner.ts"

/**
 * Registry name for the test flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "test"

/**
 * Model-facing description of the test flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Run this repository's declared test runner and get {passed, failed[ids]}, not raw output. against:'base' also runs it on the pristine base commit, so a pre-existing failure is named, not investigated."

/**
 * The parent directory baseline checkouts are written into, relative to the
 * repository root, and therefore also relative to the runner's own directory.
 *
 * @category constants
 * @since 1.0.0
 */
export const scratchDirectory = Prune.testBaseScratch

/**
 * Default wall-clock budget for one test run.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_TIMEOUT_MS = 600_000

/**
 * Maximum bytes retained from each stream while a test run executes.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_CAPTURE_BYTES = 8_000_000

/**
 * Input schema for the test flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  selection: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Test ids, paths or selectors passed to the runner as arguments; all tests when omitted"
  }),
  against: Schema.optional(Schema.Literals(["workspace", "base"])).annotate({
    description:
      "workspace (default) runs the tree as it stands; base also runs the pristine base commit and reports which failures are new"
  }),
  timeoutMs: Schema.optional(Schema.Number).annotate({ description: "Wall-clock timeout in milliseconds" })
})

/**
 * Decoded input accepted by the `test` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * One run's outcome.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Outcome = Schema.Struct({
  command: Schema.String.annotate({
    description: "The logical invocation that ran, without container transport arguments"
  }),
  exitCode: Schema.Number,
  passed: Schema.Number.annotate({ description: "Tests reported passing; 0 when parsed is false" }),
  failed: Schema.Array(Schema.String).annotate({ description: "Ids of the tests reported failing or erroring" }),
  parsed: Schema.Boolean.annotate({
    description:
      "Whether the runner's complete report could be read; when false, tail is all there is. Base attribution is omitted unless both reports are complete"
  }),
  tail: Schema.String.annotate({ description: "The end of the runner's combined output" }),
  // `<field>Truncated` beside `<field>` is the wire convention
  // `@smthrs/harness/TruncatedOutput` reads to refuse a later write of these
  // exact bytes. A tail written over a file replaces it with its own end.
  tailTruncated: Schema.Boolean.annotate({
    description: "Whether the runner printed more than tail carries, leaving tail a fragment that must not be written"
  }),
  tailDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the start of tail" }),
  invalidProbe: Schema.optional(Probe.InvalidProbe)
})

/**
 * Output schema for the test flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  ...Outcome.fields,
  base: Schema.optional(Schema.Struct({
    ...Outcome.fields,
    ref: Schema.String.annotate({ description: "The ref the baseline tree came from" }),
    commit: Schema.String.annotate({ description: "The commit the baseline tree came from" })
  })),
  introduced: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Failing here and not on the base tree: the failures this working tree is responsible for"
  }),
  preexisting: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Failing on both trees: not yours, and not worth investigating"
  }),
  fixed: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Failing on the base tree and passing here"
  })
})

/**
 * Decoded output returned by the `test` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static conservative effect envelope for the test flow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "irreversible", mode: "expected", reads: [], writes: [] })

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the test flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("proc:spawn", "*")]

/**
 * Declaration-only test flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * What a call to this flow does, for a reader of a run.
 *
 * Display metadata only. `@smthrs/registry` `Descriptor.FlowActivity` is the
 * governing vocabulary and `StandardFlows` binds this value onto the flow's
 * descriptor, where the binding site checks it. `declarationDigest` excludes
 * it, so declaring it cannot invalidate a call identity or a cached prompt.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export const activity = "tests" as const

/**
 * How one recorded call to this flow reads: the verb for each settlement, the
 * input field that is its subject, and the measured output fields a one-line
 * summary may count.
 *
 * Display metadata only, governed by `@smthrs/registry`
 * `Descriptor.CallPresentation` and checked where `StandardFlows` binds it.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export const presentation = {
  verb: { pending: "running", success: "ran", failure: "failed to run" },
  subject: "selection",
  result: "tests"
} as const

/**
 * The invocation for one run: the declared command line with the selection
 * appended as arguments rather than as text.
 *
 * `bash -c '<command> "$@"' <command> id…` is how a selection reaches a runner
 * without being quoted into it. A test id holds `::`, `[`, `]`, spaces and
 * shell metacharacters routinely, and every one of them is data here.
 */
const invocation = (
  runner: TestRunner.Runner,
  selection: ReadonlyArray<string>
): { readonly file: string; readonly args: ReadonlyArray<string> } => ({
  file: "bash",
  args: ["-c", `${runner.command} "$@"`, runner.command, ...selection]
})

const failed = (message: string, code: StdError.Code = "command_failed"): StdError.StdError =>
  new StdError.StdError({ code, message })

/** Runs one invocation, in the container when the declaration names one. */
const execute = (
  runner: TestRunner.Runner,
  transport: Option.Option<Container.Container>,
  options: {
    readonly selection: ReadonlyArray<string>
    readonly cwd: string | undefined
    readonly timeoutMs: number
  }
): Effect.Effect<
  { readonly outcome: typeof Outcome.Type; readonly report: TestReport.Report },
  StdError.StdError,
  ChildProcessSpawner.ChildProcessSpawner | Evaluator.Evaluator
> =>
  Effect.gen(function*() {
    const plan = invocation(runner, options.selection)
    const routed: Container.Plan = runner.container === undefined ?
      { ...plan, env: runner.env } :
      Option.isNone(transport)
      ? yield* Effect.fail(Container.unavailable(runner.container))
      : yield* transport.value.exec({
        container: runner.container,
        file: plan.file,
        args: plan.args,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(runner.env === undefined ? {} : { env: runner.env }),
        stdin: false
      })
    // Report the logical invocation, never the transport or its credentials.
    const quoted = [plan.file, ...plan.args].join(" ")
    const result = yield* Exec.exec(routed.file, {
      args: [...routed.args],
      ...(options.cwd === undefined || runner.container !== undefined ? {} : { cwd: options.cwd }),
      ...(routed.env === undefined ? {} : { env: routed.env }),
      timeoutMs: options.timeoutMs,
      maxCaptureBytes: MAX_CAPTURE_BYTES
    }).pipe(
      Effect.mapError((error) =>
        new StdError.StdError({
          code: Exec.toStdErrorCode(error),
          message: `The test runner did not run: ${error.message}`,
          ...(error.limitMillis === undefined ? {} : { limitMillis: error.limitMillis })
        })
      )
    )
    const combined = result.stderr === ""
      ? result.stdout
      : result.stdout === ""
      ? result.stderr
      : `${result.stdout}\n${result.stderr}`
    const tail = truncateBytes(combined, MAX_SHELL_OUTPUT_BYTES, { keep: "tail" })
    const report = TestReport.parse(combined)
    // Judged on the text this call returns rather than the text it captured,
    // so the attribution is made from the output the reader can see. A judge
    // that does not answer fails the call: see `Probe.unjudged`.
    const probe = yield* Probe.classify({
      command: quoted,
      exitCode: result.exitCode,
      output: tail.text
    }).pipe(Effect.mapError(Probe.unjudged))
    const capturedDroppedBytes = result.stdoutDroppedBytes + result.stderrDroppedBytes
    return {
      outcome: {
        command: quoted,
        exitCode: result.exitCode,
        passed: report.passed,
        failed: report.failed,
        parsed: report.parsed,
        tail: tail.text,
        tailTruncated: capturedDroppedBytes > 0 || tail.truncated,
        tailDroppedBytes: capturedDroppedBytes + tail.droppedBytes,
        ...(probe.invalidProbe === undefined ? {} : { invalidProbe: probe.invalidProbe })
      },
      report
    }
  })

/**
 * Runs the declared suite, and on request the same suite on the pristine base.
 *
 * Baseline Git and both runners use the caller-provided process service.
 * A host that cannot safely stage the base declares `baseline: false`, which
 * refuses the request before running either suite or Git. Library hosts that
 * support staging remove the detached checkout when the call ends.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("TestRun.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<
  typeof Output.Type,
  StdError.StdError,
  ChildProcessSpawner.ChildProcessSpawner | Evaluator.Evaluator | TestRunner.TestRunner
> {
  const declaration = yield* TestRunner.TestRunner
  const runner = yield* declaration.declared
  if (input.against === "base" && runner.baseline === false) {
    return yield* Effect.fail(failed(
      "Baseline comparison is unavailable on this host. Run against the workspace.",
      "provider_unavailable"
    ))
  }
  const transport = yield* Effect.serviceOption(Container.Container)
  const selection = input.selection ?? []
  const timeoutMs = input.timeoutMs ?? runner.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const current = yield* execute(runner, transport, {
    selection,
    cwd: runner.cwd,
    timeoutMs
  })
  if (input.against !== "base") return current.outcome

  const root = runner.root ?? runner.cwd
  if (root === undefined) {
    return yield* Effect.fail(
      failed(
        "The declared runner names no repository directory, so there is no base tree to check out",
        "invalid_input"
      )
    )
  }
  const base = yield* GitWorktree.resolveCommit(
    root,
    runner.baseRef === undefined ? [TestRunner.captureBase, "HEAD"] : [runner.baseRef]
  ).pipe(Effect.mapError((error) =>
    error.code === "not_found"
      ? failed(`No pristine base to compare against: ${error.message} Run against the workspace instead.`, "not_found")
      : error
  ))
  const baseline = yield* GitWorktree.withDetachedWorktree(
    root,
    `${scratchDirectory}/run`,
    base.commit,
    (scratch) =>
      execute(runner, transport, {
        selection,
        cwd: runner.cwd === undefined
          ? scratch
          : `${runner.cwd.replace(/\/+$/, "")}${scratch.slice(root.replace(/\/+$/, "").length)}`,
        timeoutMs
      })
  )
  const difference = TestReport.attribute(current.report, baseline.report)
  return {
    ...current.outcome,
    base: { ...baseline.outcome, ref: base.ref, commit: base.commit },
    ...(difference === undefined ? {} : difference)
  }
})
