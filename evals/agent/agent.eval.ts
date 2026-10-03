/**
 * The fixed suite: seventeen scenarios that put the Smithers agent through the
 * behaviours a host depends on, and the two scorers that grade them.
 *
 * Each scenario is a whole agent run against a scripted provider, so a case is
 * not a prompt-response fixture — it is one execution of the production loop
 * under a stated host composition, reduced to an {@link Subject.Observation}.
 * The `expected` value on a case is that observation written out in full, which
 * is why a failing case names the behaviour that changed rather than a number
 * that moved.
 *
 * Two scorers grade every case, and they are independent on purpose. `behaviour`
 * asks whether the run did what the case declares. `contract` asks whether the
 * observation is well formed at all: it decodes against the declared schema and
 * then holds the invariants that schema cannot state, so a scenario that
 * reduced its run into a contradictory observation fails the second scorer even
 * when the first happens to compare equal.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CaseExecutor, EvalError, Suite, type Runner as EvalRunner } from "../../packages/smithers/agent/evals/src/index.ts"
import { Binding, Runner as ScorerRunner, Scorer } from "../../packages/smithers/agent/scorers/src/index.ts"
import * as Subject from "./subject.ts"

/**
 * The target every binding applies to.
 *
 * The evaluation runner scores an execution only when its `target` is the value
 * a binding was declared against, so one declaration here is what attaches both
 * scorers to every case.
 *
 * @category models
 * @since 0.1.0
 */
export const target = {
  capabilities: [],
  name: "evals/agent/subject",
  description: "One run of the Smithers agent under a scripted provider."
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)])
    )
  }
  return value
}

const stable = (value: unknown): string => JSON.stringify(canonical(value))

/** Did the run do what the case declares? */
const behaviour = Scorer.make({
  id: "evals/agent/suite/behaviour",
  version: "1",
  name: "evals/agent/behaviour",
  description: "Deep equality between the run's observation and the case's declared expectation.",
  score: ({ groundTruth, output }) =>
    Effect.succeed(
      stable(output) === stable(groundTruth)
        ? { score: 1, reason: "the observation matched the declared expectation" }
        : { score: 0, reason: `expected ${stable(groundTruth)}, observed ${stable(output)}` }
    )
})

/**
 * The invariants the observation schema cannot state.
 *
 * `kind` decides which of the two optional fields carries the result, and a
 * call tally is a count. The schema admits an observation that breaks either
 * rule — a failure with no tag, an answer that also carries one, a fractional
 * `modelCalls` — so this is where a scenario that reduced its run wrongly is
 * caught. Returns the broken invariant, or `undefined` when all of them hold.
 */
const brokenInvariant = (observation: Subject.Observation): string | undefined => {
  if (observation.kind === "failure") {
    if (observation.failure === undefined) return "a failure observation carried no failure tag"
    if (observation.value !== undefined) return "a failure observation also carried an answer value"
  } else if (observation.failure !== undefined) {
    return "an answer observation also carried a failure tag"
  }
  return Number.isInteger(observation.modelCalls) && observation.modelCalls >= 0
    ? undefined
    : `modelCalls is not a count: ${observation.modelCalls}`
}

/** Is the observation the shape this suite promises? */
const contract = Scorer.make({
  id: "evals/agent/suite/contract",
  version: "1",
  name: "evals/agent/contract",
  description: "The observation decodes as the declared schema and holds the invariants that schema cannot state.",
  score: ({ output }) =>
    Schema.decodeUnknownEffect(Subject.Observation)(output).pipe(
      Effect.match({
        onFailure: () => ({ score: 0, reason: "the observation did not decode as the declared schema" }),
        onSuccess: (observation) => {
          const broken = brokenInvariant(observation)
          return broken === undefined
            ? { score: 1, reason: "the observation decoded and held every declared invariant" }
            : { score: 0, reason: broken }
        }
      })
    )
})

interface Scenario {
  /** What the case measures, restated for the report and the README. */
  readonly summary: string
  readonly run: () => Effect.Effect<Subject.Observation>
  readonly expected: Subject.Observation
}

const answered = (
  value: unknown,
  modelCalls: number,
  flowCalls: ReadonlyArray<string> = []
): Subject.Observation => ({ kind: "answer", value, modelCalls, flowCalls })

const failed = (
  failure: string,
  modelCalls: number,
  flowCalls: ReadonlyArray<string> = []
): Subject.Observation => ({ kind: "failure", failure, modelCalls, flowCalls })

const review = (approved: boolean, issues: ReadonlyArray<string>): unknown => ({ approved, issues })

const scenarios: Readonly<Record<string, Scenario>> = {
  "structured-output-decode": {
    summary: "A well-formed answer decodes into the action's declared output schema in one model call.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAction({
        recorder,
        respond: () => Subject.completeWith(`{"approved":true,"issues":[]}`),
        maxFrames: 3
      })
    },
    expected: answered(review(true, []), 1)
  },

  "structured-output-from-prose": {
    summary: "An answer wrapped in prose is extracted and decoded without a correction re-prompt.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAction({
        recorder,
        respond: () =>
          Subject.completeWith(
            `Here is my review:\n\n{"approved":false,"issues":["missing test"]}\n\nHope that helps.`
          ),
        maxFrames: 3
      })
    },
    expected: answered(review(false, ["missing test"]), 1)
  },

  "correction-reprompt-recovers": {
    summary: "One malformed answer spends one correction slot; the re-prompted run decodes and the step succeeds.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAction({
        recorder,
        // Keyed on the correction teaching rather than on the call index, so
        // the case self-evidences: a boundary that stopped re-prompting shows
        // the model the same task again, gets prose again, and fails, instead
        // of passing because a second call happened for some other reason.
        respond: (prompt) =>
          Subject.completeWith(
            prompt.includes("Your previous answer did not validate")
              ? `{"approved":true,"issues":[]}`
              : "Looks fine to me."
          ),
        maxFrames: 3
      })
    },
    expected: answered(review(true, []), 2)
  },

  "correction-budget-exhausted": {
    summary: "A model that never produces the declared shape fails typed after its one correction, not silently.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAction({
        recorder,
        respond: () => Subject.completeWith("Looks fine to me."),
        maxFrames: 3
      })
    },
    expected: failed("/harness/StructuredOutputFailure", 2)
  },

  "cell-calls-a-flow": {
    summary: "A cell reaches a host capability through ctx.call, and the flow's typed result reaches the answer.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAction({
        recorder,
        respond: () => Subject.callEcho,
        maxFrames: 3,
        flows: [Subject.echoSource(recorder)]
      })
    },
    expected: answered(review(true, ["pong:one"]), 1, ["echo"])
  },

  "read-only-cap-stops-a-reading-run": {
    summary:
      "A task run that only reads is told to write or justify at its cap, and stops as a typed failure at twice it rather than reporting work it never did.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // The note the cell records says whether the demand had arrived, so
        // the case proves the intervention reached the model and not just
        // that a run ended.
        respond: (prompt) =>
          `await ctx.call("probe", { note: ${
            prompt.includes("Read-only discipline") ? "\"demanded\"" : "\"reading\""
          } })
           console.log("still reading")`,
        maxFrames: 20,
        readOnlyCap: 2,
        flows: [Subject.probeSource(recorder)]
      })
    },
    // Four handler runs for four frames, two before the demand and two after
    // it. The subject measures no workspace tree, so a sealed read keys on the
    // run and frame that made it (#1986): a later frame reads again rather
    // than replaying an answer the tree may have outgrown during the model wait.
    expected: failed("/harness/HarnessError", 4, [
      "probe:reading",
      "probe:reading",
      "probe:demanded",
      "probe:demanded"
    ])
  },

  "sufficiency-signal-reaches-the-next-frame": {
    summary:
      "A run that watched a check fail, changed the workspace, and watched a broader check pass is told its evidence is complete, and completes on it.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // The cell that completes is keyed on the observation itself, so the
        // case proves the sentence reached the model rather than that a run
        // ended: without it the fourth frame would check again and the run
        // would spend its budget instead of answering.
        respond: (prompt, index) =>
          prompt.includes("Evidence held")
            ? `ctx.done("completed on the pair I was shown")`
            : index === 0
            ? `await ctx.call("check", { command: "verify a/b.py", only: "one" })
               console.log("the probe fails")`
            : index === 1
            ? `await ctx.call("apply", { path: "a/b.py" })
               console.log("edited")`
            : `await ctx.call("check", { command: "verify a/b.py" })
               console.log("the probe passes")`,
        maxFrames: 8,
        flows: [Subject.checkSource(recorder)]
      })
    },
    // Four frames: fail, write, pass, complete. The third frame is where the
    // pair closes, and the fourth is the one that reads about it.
    expected: answered("completed on the pair I was shown", 4, ["check:one", "apply", "check"])
  },

  // `vacuous-verification-signal-reaches-the-next-frame` was here, and it is
  // gone with the arm it graded. `VacuousVerification` is unwired from
  // `CellTurn` on the r93 verdict — see that module's docblock — and a suite
  // that grades a signal no run receives grades nothing. The module keeps its
  // own unit suite, and `CellTurn.test.ts` pins that the shapes which used to
  // fire it are now told nothing. When the control gets its own measured wave,
  // the case comes back with it.

  "park-without-a-human-is-answered": {
    summary:
      "An unattended park fails visibly with approval_unavailable in its first frame; the agent cannot answer its own approval question.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        expectedFailureCode: "approval_unavailable",
        respond: () => `ctx.park("waiting-input", "which branch?")`,
        maxFrames: 4,
        flows: [Subject.probeSource(recorder)]
      })
    },
    expected: failed("/harness/HarnessError", 1)
  },

  "park-every-frame-still-hits-the-read-only-cap": {
    summary:
      "An unattended park fails before the read-only cap can demand another frame, preserving the approval failure rather than continuing autonomously.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        expectedFailureCode: "approval_unavailable",
        respond: () => `ctx.park("waiting-input", "which branch?")`,
        maxFrames: 40,
        readOnlyCap: 1,
        flows: [Subject.probeSource(recorder)]
      })
    },
    expected: failed("/harness/HarnessError", 1)
  },

  "repl-realm-carries-a-binding-across-frames": {
    summary:
      "A cell's top-level name is still bound in the next cell, and the run finishes by calling ctx.done.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // The second cell derives its whole call input from a name the first
        // cell bound and never filed anywhere. A loop that rebuilt the realm
        // between frames would throw on `subject` instead of calling `probe`
        // with it, so the case cannot pass by ending some other way.
        respond: (_prompt, index) =>
          index === 0
            ? `const subject = "carried"\nawait ctx.call("probe", { note: "first" })`
            : `await ctx.call("probe", { note: subject })\nctx.done("carried " + subject)`,
        maxFrames: 4,
        flows: [Subject.probeSource(recorder)]
      })
    },
    expected: answered("carried carried", 2, ["probe:first", "probe:carried"])
  },

  "repl-print-reaches-the-next-frame": {
    summary:
      "What a cell prints opens the next frame, so console.log is the whole of the context channel.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // Keyed on the printed bytes themselves: a loop that stopped
        // delivering the print buffer would show the second cell a prompt
        // without them, and the run would spend its budget instead of
        // answering.
        respond: (prompt) =>
          prompt.includes("beacon:printed")
            ? `ctx.done("read my own print")`
            : `console.log("beacon:printed")`,
        maxFrames: 4,
        flows: [Subject.probeSource(recorder)]
      })
    },
    expected: answered("read my own print", 2)
  },

  "repl-completion-behind-a-guard": {
    summary:
      "One cell reproduces the failure, writes, replays the identical check and completes behind a check of both exit codes — the shape the contract teaches, in the frame that took the evidence.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // The completion is decided by results this cell just took, not by
        // anything the model remembers about them. One model call for the whole
        // task is what the guard buys.
        //
        // A declared write advances the live-tree epoch, so the identical
        // sealed check runs again against the changed tree. Without that
        // epoch the first failure would replay and this guard could not pass.
        respond: () =>
          `const before = await ctx.call("check", { command: "verify a/b.py" })
           await ctx.call("apply", { path: "a/b.py" })
           const after = await ctx.call("check", { command: "verify a/b.py" })
           if (before.exitCode !== 0 && after.exitCode === 0) ctx.done("verify a/b.py failed before the write and exits 0 after it")`,
        maxFrames: 4,
        flows: [Subject.checkSource(recorder)]
      })
    },
    expected: answered("verify a/b.py failed before the write and exits 0 after it", 1, [
      "check",
      "apply",
      "check"
    ])
  },

  "repl-guard-that-does-not-fire-carries-on": {
    summary:
      "The identical cell against a check that was green to begin with does not complete: the guard is the whole difference between answering and getting another frame.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // `only: "green"` names a check nothing in this tree can fail, so the
        // baseline passes and the guard reads false. A run that completed here
        // would be claiming a change nobody watched happen.
        respond: (_prompt, index) =>
          index === 0
            ? `const verification = { flow: "check", input: { command: "verify a/b.py", only: "green" } }
               const before = await ctx.call(verification.flow, verification.input)
               await ctx.call("apply", { path: "a/b.py" })
               const after = await ctx.call(verification.flow, verification.input)
               if (before.exitCode !== 0 && after.exitCode === 0) ctx.done("proved it")`
            : `ctx.done("the baseline was already green")`,
        maxFrames: 4,
        flows: [Subject.checkSource(recorder)]
      })
    },
    // The write advances the live-tree epoch, so both identical checks run.
    // Their green results still cannot satisfy the failed-before guard.
    expected: answered("the baseline was already green", 2, ["check:green", "apply", "check:green"])
  },

  "checkpoint-mint-is-refused-catchably-without-a-store": {
    summary:
      "ctx.checkpoint() reaches the boundary through the real loop, and a composition that pins no trees answers it as an ordinary catchable failure the cell reads a code off.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // The output is built from the refusal's own code, so the case cannot
        // pass by ending some other way: a surface that threw would never reach
        // the completion, and one that resolved with a handle would name it.
        respond: () =>
          `const answer = await ctx.checkpoint()
           ctx.done(answer.ok === false ? "refused " + answer.error.code : "pinned " + answer.checkpoint)`,
        maxFrames: 4,
        flows: [Subject.probeSource(recorder)]
      })
    },
    expected: answered("refused checkpoint_unavailable", 1)
  },

  "checkpoint-at-base-is-never-silently-ignored": {
    summary:
      "A call that names ctx.base on a host that pins no trees is refused rather than run, because a reading of the live tree presented as a reading of the pinned one is a proof of nothing.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // The empty flow ledger is the assertion that matters: the check must
        // not have run. A loop that dropped the at would record a `check` and
        // answer with an exit code instead.
        respond: () =>
          `const before = await ctx.call("check", { command: "verify a/b.py" }, { at: ctx.base })
           ctx.done(before.ok === false ? "refused " + before.error.code : "ran " + before.exitCode)`,
        maxFrames: 4,
        flows: [Subject.checkSource(recorder)]
      })
    },
    expected: answered("refused checkpoint_unavailable", 1)
  },

  "checkpoint-refuses-a-write-at-a-pinned-tree": {
    summary:
      "A flow that declares a write is refused at a checkpoint before it reaches the engine: a checkpoint is a read-only view of a tree that has already been, and nothing runs.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        respond: () =>
          `const applied = await ctx.call("apply", { path: "a/b.py" }, { at: ctx.base })
           ctx.done(applied.ok === false ? "refused " + applied.error.code : "wrote")`,
        maxFrames: 4,
        flows: [Subject.checkSource(recorder)]
      })
    },
    // No `apply` in the ledger: the refusal is the controller's, ahead of the
    // engine, so the write never happened on any tree.
    expected: answered("refused checkpoint_readonly", 1)
  },

  "checkpoint-is-refused-by-a-host-that-pins-nothing": {
    summary:
      "`ctx.base` is always there and costs nothing; a mint on a host with no store is a catchable refusal at the line that asked, not a failed run.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        respond: () =>
          `const answer = await ctx.checkpoint()
           const base = JSON.stringify(ctx.base)
           ctx.done(base + " " + (answer.ok === false ? answer.error.code : "pinned"))`,
        maxFrames: 4,
        flows: [Subject.probeSource(recorder)]
      })
    },
    expected: answered(`{"checkpoint":"base"} checkpoint_unavailable`, 1)
  },

  "repl-completion-stops-the-calls-after-it": {
    summary:
      "ctx.done takes effect where it is called: the flow calls a cell would have made after it never reach the boundary, and they fail soft rather than throwing.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // The output is built from the refused call's own code, so the case
        // cannot pass by ending some other way: a loop that dispatched the call
        // anyway would record `probe:after-done`, and one that threw would never
        // reach the completion at all.
        respond: () =>
          `ctx.done("sealed")
           const after = await ctx.call("probe", { note: "after-done" })
           ctx.done("never " + after.error.code)`,
        maxFrames: 4,
        flows: [Subject.probeSource(recorder)]
      })
    },
    expected: answered("sealed", 1)
  },

  "repl-read-only-cap-takes-ctx-justify": {
    summary:
      "The read-only cap holds a run that only reads, and ctx.justify is the answer that buys quiet frames.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAgent({
        recorder,
        // The note the cell records says whether the demand had arrived, so
        // the case proves the intervention reached the model on this surface
        // as well, and that the call it names is the way out.
        respond: (prompt) =>
          prompt.includes("Read-only discipline")
            ? `await ctx.call("probe", { note: "demanded" })\nctx.justify("the failing assertion is still unread")`
            : `await ctx.call("probe", { note: "reading" })`,
        maxFrames: 20,
        readOnlyCap: 2,
        flows: [Subject.probeSource(recorder)]
      })
    },
    // The demand arrives at the cap, the
    // justification buys quiet frames without resetting the counter, and the
    // run still stops at twice the cap rather than reporting work it never did.
    // Each frame reads again; see read-only-cap-stops-a-reading-run.
    expected: failed("/harness/HarnessError", 4, [
      "probe:reading",
      "probe:reading",
      "probe:demanded",
      "probe:demanded"
    ])
  },

  "max-frames-stops-the-run": {
    summary: "A run that never completes stops at its frame budget and reports a typed harness failure.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAction({ recorder, respond: () => Subject.stall, maxFrames: 1 })
    },
    expected: failed("/harness/HarnessError", 1)
  },

  "seat-unresolved-is-typed": {
    summary: "A host with no model for the declared seat refuses before any model call, as a typed error.",
    run: () => {
      const recorder = Subject.makeRecorder()
      return Subject.runAction({
        recorder,
        respond: () => Subject.completeWith("unreachable"),
        maxFrames: 3,
        resolvable: false
      })
    },
    expected: failed("@smthrs/agent/Seat/SeatUnresolved", 0)
  }
}

/**
 * The suite's name, shared by the run, the baseline, and the report.
 *
 * @category models
 * @since 0.1.0
 */
export const name = "flows-agent"

/**
 * The cases, derived from the scenario table so a case and the run it names
 * cannot drift apart.
 *
 * @category models
 * @since 0.1.0
 */
export const cases: ReadonlyArray<Suite.Case> = Object.entries(scenarios).map(([scenario, declared]) => ({
  name: scenario,
  input: { scenario, summary: declared.summary },
  expected: declared.expected
}))

/**
 * Both scorers, bound to the one target every case executes.
 *
 * @category models
 * @since 0.1.0
 */
export const bindings: ReadonlyArray<Binding.Binding> = [
  Binding.make({ scorer: behaviour, appliesTo: target }),
  Binding.make({ scorer: contract, appliesTo: target })
]

/** Fixed-suite declaration for the public eval CLI. */
export const suite = Suite.make({ name: "agent", concurrency: 1, cases, bindings })


/**
 * The batch runner the evaluation runner scores through.
 *
 * `Runner.run` declares this service in its requirements, so a suite has to
 * supply one even when its scorers are pure and blocking. This one executes
 * each job in process and validates the result with the scorers package's own
 * `Scorer.validate`, which is what the store-backed `RunnerLive` does minus the
 * store: nothing here writes a score anywhere, because a committed baseline is
 * where this suite's scores live.
 *
 * @category services
 * @since 0.1.0
 */
export const scoring: EvalRunner.ScoreBatchRunner = {
  runBatch: (jobs, options) =>
    Effect.forEach(
      jobs,
      (job) =>
        job.score.pipe(
          Effect.flatMap(Scorer.validate),
          Effect.map((result) => ({
            ...job.observation,
            kind: "score" as const,
            score: result.score,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            ...(result.meta === undefined ? {} : { meta: result.meta }),
            at: job.at ?? 0
          })),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.succeed(ScorerRunner.inconclusive(job, cause))
          )
        ),
      { concurrency: options?.concurrency ?? 1 }
    )
}

/**
 * The execution boundary: it runs the named scenario as a whole agent run.
 *
 * A crash inside a scenario becomes a typed executor failure rather than a
 * defect that kills the suite, so a broken subject is reported as a missing
 * observation instead of an unreadable stack.
 *
 * @category services
 * @since 0.1.0
 */
export const executor: CaseExecutor.Service = CaseExecutor.make((suiteCase) =>
  Effect.suspend(() => {
    const requested = (suiteCase.input as { readonly scenario?: unknown }).scenario
    const scenario = typeof requested === "string" ? scenarios[requested] : undefined
    if (scenario === undefined) {
      return Effect.fail(
        new EvalError.EvalError({
          code: "executor",
          message: `Case '${suiteCase.name}' names no scenario this suite declares`
        })
      )
    }
    const started = performance.now()
    return scenario.run().pipe(
      Effect.map((output) => ({
        output,
        // The step key is fixed per case: the regression comparison treats a
        // changed key as a new step and a changed score under the same key as
        // nondeterminism, and both readings need the key to be stated, not
        // derived from a run.
        stepKey: `evals/agent:${suiteCase.name}`,
        latencyMs: performance.now() - started,
        target
      })),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.fail(
            new EvalError.EvalError({
              code: "executor",
              message: `Scenario '${suiteCase.name}' did not finish`,
              cause
            })
          )
      )
    )
  })
)
export default { suite, executor }

