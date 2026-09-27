/**
 * The sixth brake, driven through the branch that owns it.
 *
 * `Frame.judgeCompletion` is the seam: it is where the five deterministic
 * brakes are ordered, where the caps are spent, and where the claim brake was
 * added last. Driving the module alone would prove the decision rule and
 * nothing about the precedence, the cap, or the no-op, which are the three
 * things a brake wired into an ordered list can get wrong.
 *
 * Nothing here reaches a network: every evaluation is answered by
 * `Evaluator.layerScripted`, and the cases about a transport that cannot
 * answer bind `Evaluator.layerUnavailable()` or script a failure.
 *
 * The rule the cases pin: the brake never falls back and it never goes quiet,
 * and what it refuses is narrower than what it asks about. A completion
 * nothing could judge fails the turn as `completion_unjudged` naming the
 * reason. A claim that reports a command or a result the run's own record does
 * not record fails it as `claim_unproven` once the run has had its frame to
 * prove it, both the way `read_only_cap` fails a turn. A claim the brake only
 * finds thin is handed back once and then stands: refusing that one too is
 * what destroyed honest answers, and `CompletionClaim`'s header carries the
 * corpus that measured it.
 */
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CallLedger from "../src/CallLedger.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as CompletionClaim from "../src/CompletionClaim.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as FailedCall from "../src/FailedCall.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as Frame from "../src/internal/frame.ts"

const task = "Make AdminSite.catch_all_view() preserve the query string on an APPEND_SLASH redirect."
const claim = "Updated AdminSite.catch_all_view() to preserve query strings."

const window = ContextWindow.make({
  modelId: "test-model",
  segments: [
    {
      kind: "instructions",
      zone: "prefix",
      content: [ModelRequest.SystemPart.make({ text: `The task for this run:\n\n${task}` })]
    }
  ]
})

const base = CellTurn.make({
  session: "session-1",
  seat: "anthropic:test-model",
  modelParams: ModelRequest.GenerationParams.make(),
  layers: [],
  capabilityEnvelope: [],
  placement: Option.none(),
  contextWindow: window,
  maxFrames: 10
})

const tree = (digest: string) => Option.some(new EngineLike.Observation({ digest, paths: 3, complete: true }))

const call = (changes: Partial<Frame.ObservedCall> = {}): Frame.ObservedCall => ({
  flow: "bash",
  ok: true,
  summary: "",
  ordinal: 1,
  mutates: false,
  remote: false,
  signature: "pytest tests",
  subject: "pytest tests",
  at: undefined,
  input: { command: "pytest tests" },
  value: { exitCode: 0, stdout: "148 passed" },
  message: undefined,
  invalidProbe: undefined,
  failing: false,
  passing: true,
  ...changes
})

/**
 * One completion judged, over a run whose tree moved and whose calls give the
 * deterministic five nothing to name — so whatever fires here is the sixth.
 */
const judge = (options: {
  readonly layer?: Layer.Layer<Evaluator.Evaluator>
  readonly changes?: Frame.StateChanges
  readonly calls?: ReadonlyArray<Frame.ObservedCall>
  readonly closed?: string
  readonly claim?: string
} = {}) => {
  // The failed-call demand is spent: several cases put a failed call in the
  // completing frame to test the evidence this brake reads, and that demand
  // would otherwise hand the frame back first.
  const state = new CellTurn.State({
    ...base,
    openingDigest: "t0",
    failedCallDemands: FailedCall.cap,
    ...options.changes
  })
  const judged = Frame.judgeCompletion(
    state,
    Frame.account({
      state,
      calls: options.calls ?? [],
      opened: tree("t0"),
      closed: tree(options.closed ?? "t1"),
      minted: [],
      bindings: [],
      captures: []
    }),
    state.contextWindow,
    options.claim ?? claim
  )
  return Effect.provide(judged, options.layer ?? Evaluator.layerUnavailable())
}

/** One judgement, which must not fail. */
const settled = (options: Parameters<typeof judge>[0] = {}) => Effect.runPromise(judge(options))

/**
 * The typed failure one judgement ended in. A success here is the brake
 * falling back, which is the thing this file exists to refuse.
 */
const unjudged = async (options: Parameters<typeof judge>[0] = {}): Promise<HarnessError> => {
  const outcome = await Effect.runPromise(Effect.result(judge(options)))
  if (outcome._tag !== "Failure") throw new Error("the claim stood where nothing could judge it")
  return outcome.failure
}

/** A scripted evaluator that also records what it was asked. */
const scripted = (answers: Readonly<Record<string, Evaluator.ScriptedAnswer>>) => {
  const asked: Array<Evaluator.Request> = []
  const layer = Evaluator.layerScripted((request) => {
    asked.push(request)
    return answers
  })
  return { asked, layer }
}

/**
 * A scripted Jev named by the probabilities it answers with. Anything a case
 * does not name reads as a claim nothing objects to, so each case below states
 * only the number it is about.
 */
const reading = (probabilities: Partial<CompletionClaim.Probabilities>) =>
  scripted({
    complete: { probability: probabilities.complete ?? 0.9 },
    overclaims: { probability: probabilities.overclaims ?? 0.1 },
    invented: { probability: probabilities.invented ?? 0.05 }
  })

const refusing = (error: Evaluator.EvaluatorError) => {
  const asked: Array<Evaluator.Request> = []
  const layer = Evaluator.layerScripted((request) => {
    asked.push(request)
    return Effect.fail(error)
  })
  return { asked, layer }
}

describe("the claim brake", () => {
  it("fails the turn on a host that binds no evaluator, naming it unconfigured", async () => {
    const error = await unjudged({ layer: Layer.empty as Layer.Layer<Evaluator.Evaluator> })

    expect(error.code).toBe("completion_unjudged")
    expect(error.message).toContain("unconfigured")
  })

  it("fails the turn when the bound evaluator has no transport behind it", async () => {
    const error = await unjudged()

    expect(error.code).toBe("completion_unjudged")
    expect(error.message).toContain("unreachable")
    expect(error.message).toContain(Evaluator.unreachableMessage)
    expect(error.message).not.toContain("No evaluator is installed on this host")
  })

  it("hands back a completion Jev reads as unproven, once, and spends its own cap", async () => {
    const jev = reading({ complete: 0.1, overclaims: 0.4, invented: 0.6 })
    const judged = await settled({ layer: jev.layer })

    expect(judged.demand?.event).toMatchObject({
      _tag: "claim-demanded",
      complete: 0.1,
      overclaims: 0.4,
      invented: 0.6,
      demanded: true,
      nextFrame: 1
    })
    expect(judged.demand?.spent).toEqual({ claimDemands: 1 })
    // The demand is the event, so it is journaled once and not twice.
    expect(judged.observed).toBeUndefined()
    // The prose asks for a direct answer with support for claimed work, and quotes no
    // probability: a score in front of a model is a score to negotiate. It
    // also re-quotes no task, so `Transcript` rebuilds it from the event.
    expect(judged.demand?.note).toContain("Completion review")
    expect(judged.demand?.note).not.toContain("0.6")
    expect(judged.demand?.note).not.toContain(task)
    expect(jev.asked).toHaveLength(1)
  })

  it("journals the reading of a claim it lets through, and demands nothing", async () => {
    const jev = reading({ complete: 0.9, overclaims: 0.2, invented: 0.05 })
    const judged = await settled({ layer: jev.layer })

    expect(judged.demand).toBeUndefined()
    expect(judged.observed).toMatchObject({
      _tag: "claim-demanded",
      complete: 0.9,
      overclaims: 0.2,
      invented: 0.05,
      demanded: false
    })
  })

  it("journals no decision for a reader that reports no evidence, rather than rebuilding one from its numbers", async () => {
    const state = new CellTurn.State({ ...base, openingDigest: "t0" })
    const judged = await Effect.runPromise(
      Frame.judgeCompletion(
        state,
        Frame.account({
          state,
          calls: [],
          opened: tree("t0"),
          closed: tree("t1"),
          minted: [],
          bindings: [],
          captures: []
        }),
        state.contextWindow,
        claim,
        // A host's own reader: three probabilities and a latency, and nothing
        // about what it sent. The reading is still journaled; the decision is
        // explicitly unavailable, because the evidence this judge assembled is
        // not proof of what that reader asked.
        () => Effect.succeed({ complete: 0.9, overclaims: 0.1, invented: 0.1, latencyMs: 5 })
      ).pipe(Effect.provide(Evaluator.layerUnavailable()))
    )
    expect(judged.observed).toMatchObject({ _tag: "claim-demanded", demanded: false })
    expect(judged.decision).toBeUndefined()
  })

  it("asks a soft-bounced conversational answer to keep the requested form without alleging invented work", async () => {
    const jev = reading({ complete: 0.27, overclaims: 0.20, invented: 0.14 })
    const contextWindow = ContextWindow.make({
      modelId: "test-model",
      segments: [{
        kind: "instructions",
        zone: "prefix",
        content: [ModelRequest.SystemPart.make({ text: "The task for this run:\n\nReply with only the letter A." })]
      }]
    })
    const judged = await settled({ layer: jev.layer, changes: { contextWindow }, claim: "A" })

    expect(judged.demand?.event).toMatchObject({ _tag: "claim-demanded", demanded: true, invented: 0.14 })
    expect(judged.unproven).toBeUndefined()
    expect(judged.demand?.note).toContain("Completion review")
    expect(judged.demand?.note).toContain("current request")
    expect(judged.demand?.note).toContain("requested format")
    expect(judged.demand?.note).toContain("purely conversational answer")
    expect(judged.demand?.note).not.toContain("Unrecorded claim")
    expect(judged.demand?.note).not.toContain("saying only what this run did")
  })

  it("hands back a claim that reports a command the record does not record, however complete it looks", async () => {
    const jev = reading({ complete: 0.95, invented: 0.6 })
    const judged = await settled({ layer: jev.layer })

    expect(judged.demand?.event).toMatchObject({ _tag: "claim-demanded", demanded: true })
  })

  it("hands back a claim the first two questions answer against, and never refuses one", async () => {
    // Both still ask. Neither may refuse: the corpus in `CompletionClaim`'s
    // header has `complete` at or below 0.3 firing on eight of twelve honest
    // completions, its two lowest readings in the whole corpus being an honest
    // "the call was denied" and an honest "I changed it and the test still
    // fails", and `overclaims` at or above 0.8 firing on five of them, because
    // thin evidence shows nothing by construction.
    const jev = reading({ complete: 0.02, overclaims: 0.93, invented: 0.2 })
    const bounced = await settled({ layer: jev.layer })
    const spent = await settled({ layer: jev.layer, changes: { claimCap: 1, claimDemands: 1 } })

    expect(bounced.demand?.event).toMatchObject({ _tag: "claim-demanded", demanded: true })
    expect(spent.demand).toBeUndefined()
    expect(spent.unproven).toBeUndefined()
    expect(spent.observed).toMatchObject({ _tag: "claim-demanded", complete: 0.02, overclaims: 0.93, demanded: false })
  })

  it("lets a claim it only found thin stand once the cap is spent, rather than taking the answer", async () => {
    // The defect this lane was opened on. A reading between the two heights is
    // a bounce and not a verdict: the run was told once, it answered, and the
    // answer stands. Refusing it as well killed five question-shaped turns in
    // a row and one live CI dispatch whose planted bug was fixed.
    const jev = reading({ complete: 0.2, overclaims: 0.87, invented: 0.7 })
    const judged = await settled({ layer: jev.layer, changes: { claimCap: 1, claimDemands: 1 } })

    expect(judged.unproven).toBeUndefined()
    expect(judged.demand).toBeUndefined()
    expect(judged.observed).toMatchObject({ _tag: "claim-demanded", invented: 0.7, demanded: false })
  })

  it("keeps a thin bounced answer for the budget, because it would have let that answer stand", async () => {
    const jev = reading({ invented: 0.6 })
    const judged = await settled({ layer: jev.layer })

    expect(judged.demand?.keeps).toBe(true)
  })

  it("does not keep the answer it takes away, so the budget cannot hand it back", async () => {
    const jev = reading({ complete: 0.1, overclaims: 0.4, invented: 0.95 })
    const judged = await settled({ layer: jev.layer })

    // The five measured demands keep the bounced answer for the budget notice,
    // and so does a claim demand the brake would let stand. This one is a claim
    // the brake would refuse, so restoring it on the budget notice would hand
    // back the very sentence it refused. See `CompletionDemand.keeps`.
    expect(judged.demand?.keeps).toBe(false)
  })

  it("reads the claim again once the cap is spent, and ends the run rather than letting it stand", async () => {
    const jev = reading({ complete: 0.1, overclaims: 0.9, invented: 0.95 })
    const judged = await settled({ layer: jev.layer, changes: { claimCap: 1, claimDemands: 1 } })

    // The cap is the frames the run is given, not the completions that are
    // read: a spent cap used to mean the second claim stood unread.
    expect(jev.asked).toHaveLength(1)
    expect(judged.demand).toBeUndefined()
    expect(judged.observed).toMatchObject({ _tag: "claim-demanded", demanded: false })
    expect(judged.unproven?.code).toBe("claim_unproven")
    expect(judged.unproven?.message).toContain("reporting work this run never recorded")
    expect(judged.unproven?.message).toContain("came back still unrecorded")
    // All three probabilities are in the failure, so a wave is graded from the
    // runs it ended as well as from the readings it journaled, and the two that
    // decide nothing are named as deciding nothing.
    expect(judged.unproven?.message).toContain("invented 0.95")
    expect(judged.unproven?.message).toContain("complete 0.10")
    expect(judged.unproven?.message).toContain("overclaims 0.90")
    expect(judged.unproven?.message).toContain("neither of which decides this")
    // The refusal quotes the sentence it refused. Without it the only copy of
    // a correct answer the brake was wrong about lived in a `complete`
    // transition inside the journal, where nobody reads.
    expect(judged.unproven?.message).toContain(claim)
    expect(judged.observed).toMatchObject({ _tag: "claim-demanded", refused: true })
  })

  it("says on the reading itself that it refused, so a projection can tell it from one that stood", async () => {
    const stood = await settled({
      layer: reading({ complete: 0.95, overclaims: 0.02, invented: 0.02 }).layer,
      changes: { claimCap: 1, claimDemands: 1 }
    })
    const handed = await settled({ layer: reading({ invented: 0.6 }).layer })

    // `demanded` false meant both of these and the refusal, which is why the
    // refusal wrote no card and its sentence was nowhere a person could read.
    expect(stood.observed).toMatchObject({ demanded: false, refused: false })
    expect(handed.demand?.event).toMatchObject({ demanded: true, refused: false })
  })

  it("keeps the whole refused completion where it fits, and says what it dropped where it does not", () => {
    const short = CompletionClaim.unproven({ complete: 0.1, overclaims: 0.9, invented: 0.95 }, true, "  short  ")
    expect(short.message).toContain("\n\nshort")

    const long = "x".repeat(CompletionClaim.refusedBytes + 100)
    const clipped = CompletionClaim.unproven({ complete: 0.1, overclaims: 0.9, invented: 0.95 }, false, long)
    expect(clipped.message).toContain("the run record has the whole completion")
    expect(clipped.message).not.toContain(long)
  })

  it("lets a claim the run went and proved stand, cap spent or not", async () => {
    const jev = reading({ complete: 0.95, overclaims: 0.02, invented: 0.02 })
    const judged = await settled({ layer: jev.layer, changes: { claimCap: 1, claimDemands: 1 } })

    expect(judged.unproven).toBeUndefined()
    expect(judged.demand).toBeUndefined()
    expect(judged.observed).toMatchObject({ _tag: "claim-demanded", demanded: false })
  })

  it("ends the run when there is no frame to hand the claim back to, and says so", async () => {
    const jev = reading({ complete: 0.1, overclaims: 0.9, invented: 0.95 })
    // The last frame of the budget: nothing can be demanded here, and standing
    // would make an unsupported sentence the run's answer.
    const judged = await settled({ layer: jev.layer, changes: { frame: 9 } })

    expect(judged.demand).toBeUndefined()
    expect(judged.unproven?.code).toBe("claim_unproven")
    expect(judged.unproven?.message).toContain("no frame left to hand it back to")
  })

  it("gives a run three frames to prove a claim by default, and no more", () => {
    // One was too few on a real seat: this seat claims a fix before making the
    // edit, and a run bounced once then killed had the bug still in the file.
    expect(CellTurn.defaultClaimDemands).toBe(3)
    expect(new CellTurn.State({ ...base, openingDigest: "t0" }).claimCap).toBe(3)
  })

  it("reads nothing at all when the cap disarms it", async () => {
    const jev = reading({ complete: 0.1, overclaims: 0.9, invented: 0.95 })
    const judged = await settled({ layer: jev.layer, changes: { claimCap: 0 } })

    expect(jev.asked).toEqual([])
    expect(judged.demand).toBeUndefined()
    expect(judged.observed).toBeUndefined()
    expect(judged.unproven).toBeUndefined()
  })

  it("fails the turn when the evaluator refuses, times out, or is unreachable, naming which", async () => {
    for (const code of ["refused", "timeout", "unreachable", "empty", "invalid_answer"] as const) {
      const jev = refusing(new Evaluator.EvaluatorError({ code, message: `scripted ${code}` }))
      const error = await unjudged({ layer: jev.layer })

      expect(error.code, code).toBe("completion_unjudged")
      expect(error.message, code).toContain(code)
      // The transport's own words survive into the journal line, except an
      // unreachable transport's, which can name hosts and URLs.
      if (code === "unreachable") {
        expect(error.message).toContain(Evaluator.unreachableMessage)
        expect(error.message).not.toContain(`scripted ${code}`)
      } else {
        expect(error.message, code).toContain(`scripted ${code}`)
      }
      expect(jev.asked, code).toHaveLength(1)
    }
  })

  it("quotes the completion it could not judge, so a judge outage does not lose the answer", async () => {
    for (const layer of [Layer.empty as Layer.Layer<Evaluator.Evaluator>, Evaluator.layerUnavailable()]) {
      const error = await unjudged({ layer, claim: "The answer is 42, written to answer.txt." })

      expect(error.message).toContain("The completion this refused, word for word:")
      expect(error.message).toContain("The answer is 42, written to answer.txt.")
    }
  })

  it("carries the transport's code and status as the cause, and never its text", async () => {
    const failure = new Evaluator.EvaluatorError({
      code: "unreachable",
      status: 503,
      message: "connect ECONNREFUSED judge.internal:8443"
    })
    const error = await unjudged({ layer: refusing(failure).layer })

    expect(error.cause).toEqual({ code: "unreachable", status: 503 })
    expect(error.message).not.toContain("judge.internal")
    const persisted = Schema.decodeSync(HarnessError)(Schema.encodeSync(HarnessError)(error))
    expect(persisted.cause).toEqual({ code: "unreachable", status: 503 })
    const bare = await unjudged({
      layer: refusing(new Evaluator.EvaluatorError({ code: "timeout", message: "late" })).layer
    })
    expect(bare.cause).toEqual({ code: "timeout" })
  })

  it("journals its decision without the transport's usage, which claim-demanded carries", async () => {
    const metered = Layer.succeed(Evaluator.Evaluator)(
      Evaluator.Evaluator.of({
        evaluate: () =>
          Effect.succeed({
            answers: {
              complete: { type: "boolean", probability: 0.9 },
              overclaims: { type: "boolean", probability: 0.1 },
              invented: { type: "boolean", probability: 0.05 }
            },
            latencyMs: 7,
            usage: { inputTokens: 321, outputTokens: 12 }
          })
      })
    )
    const judged = await settled({ layer: metered })

    expect(judged.decision).toMatchObject({ _tag: "decision-settled", classifier: "completion/claim" })
    expect(judged.decision).not.toHaveProperty("usage")
  })

  it("is never consulted when a deterministic brake already named something", async () => {
    const jev = reading({ complete: 0.1, overclaims: 0.9, invented: 0.95 })
    // The tree the run was handed is the tree it is completing on.
    const judged = await settled({ layer: jev.layer, closed: "t0" })

    expect(judged.demand?.event._tag).toBe("unmoved-demanded")
    expect(judged.demand?.spent).toEqual({ unmovedDemands: 1 })
    expect(jev.asked).toEqual([])
  })

  it("sends the task, the claim and measured check and call receipts", async () => {
    const jev = reading({ complete: 0.9, overclaims: 0.1, invented: 0.05 })
    await settled({
      layer: jev.layer,
      calls: [
        call({
          ordinal: 1,
          signature: "grep catch_all_view",
          subject: "grep catch_all_view",
          input: { command: "grep -rn catch_all_view" },
          value: { matches: 2 },
          passing: false
        }),
        // The write the frame declared, which is what lets the check after it
        // be stamped with the tree the frame closed on.
        call({
          ordinal: 2,
          signature: "edit admin.py",
          subject: "edit admin.py",
          mutates: true,
          flow: "edit",
          input: { path: "admin.py" },
          value: {}
        }),
        call({
          ordinal: 3,
          signature: "pytest admin_views",
          subject: "pytest admin_views",
          input: { command: "pytest tests/admin_views" },
          value: { exitCode: 0, stdout: "148 passed" }
        })
      ]
    })

    const state = jev.asked[0]?.state as Record<string, unknown>
    expect(state["task"]).toContain(task)
    expect(state["claim"]).toBe(claim)
    expect(state["treeMoved"]).toBe(true)
    expect(state["lastCheck"]).toEqual({
      command: "{\"command\":\"pytest tests/admin_views\"}",
      exitCode: 0,
      output: "{\"exitCode\":0,\"stdout\":\"148 passed\"}"
    })
    // The check that reported an outcome, and not the grep, which reported
    // none: a command that found something is not a reading of whether
    // anything works, and neither is the edit. The pytest run is here twice on
    // purpose, once with its result and once in the list, because the list is
    // what a claim about an earlier check is read against.
    expect(state["checksRun"]).toEqual([
      {
        command: "{\"command\":\"pytest tests/admin_views\"}",
        outcome: "passed",
        result: "{\"exitCode\":0,\"stdout\":\"148 passed\"}"
      }
    ])
    expect(state["callsRun"]).toEqual([
      { flow: "bash", input: "{\"command\":\"grep -rn catch_all_view\"}", ok: true, resultSummary: "matches=2" },
      { flow: "edit", input: "admin.py", ok: true, resultSummary: "{}" },
      { flow: "bash", input: "tests/admin_views", ok: true, resultSummary: "exitCode=0 stdout=10b" }
    ])
    expect(Object.keys(state).sort()).toEqual(["callsRun", "checksRun", "claim", "lastCheck", "task", "treeMoved"])
    expect(Object.keys(jev.asked[0]?.questions ?? {}).sort()).toEqual(["complete", "invented", "overclaims"])
  })

  it("keeps the newest request at the end of a long original task", async () => {
    const jev = reading({})
    const current = "The person now says: reply with only A."
    await settled({
      layer: jev.layer,
      claim: "A",
      changes: {
        contextWindow: ContextWindow.make({
          modelId: "test-model",
          segments: [{
            kind: "instructions",
            zone: "prefix",
            content: [ModelRequest.SystemPart.make({
              text: `The conversation so far:\n${"earlier detail ".repeat(1600)}\n${current}`
            })]
          }]
        })
      }
    })
    const evidence = jev.asked[0]?.state as { readonly task: string; readonly claim: string }
    expect(evidence.task).toContain("The conversation so far:")
    expect(evidence.task).toContain(current)
    expect(evidence.task).toContain("elided")
    expect(new TextEncoder().encode(evidence.task).byteLength).toBeLessThanOrEqual(CompletionClaim.proseBytes)
    expect(evidence.claim).toBe("A")
  })

  it("reads the task off the instructions text and off nothing else", async () => {
    const jev = reading({ complete: 0.9, overclaims: 0.1, invented: 0.05 })
    const mixed = ContextWindow.make({
      modelId: "test-model",
      segments: [
        // Not the task: the cell contract and the flow catalog land here.
        { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
        {
          kind: "instructions",
          zone: "prefix",
          // A part that carries no text at all, which an instructions segment
          // may hold and which teaches the brake nothing.
          content: [ModelRequest.Message.user("hello"), ModelRequest.SystemPart.make({ text: `The task: ${task}` })]
        },
        // Not the task either: the transcript is where the model's own words
        // are, and a claim judged against them would be judged against itself.
        { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
      ]
    })
    const state = new CellTurn.State({ ...base, contextWindow: mixed, openingDigest: "t0" })
    await Effect.runPromise(
      Effect.provide(
        Frame.judgeCompletion(
          state,
          Frame.account({
            state,
            calls: [],
            opened: tree("t0"),
            closed: tree("t1"),
            minted: [],
            bindings: [],
            captures: []
          }),
          mixed,
          claim
        ),
        jev.layer
      )
    )

    expect((jev.asked[0]?.state as Record<string, unknown>)["task"]).toBe(`The task: ${task}`)
  })

  it("carries settled classifier and read receipts from earlier frames into the completion evidence", async () => {
    const jev = reading({})
    const classified = CallLedger.entry(1, {
      flow: "classify",
      input: { states: [1, 2], question: "even" },
      ok: true,
      value: { results: [{ ok: true }, { ok: true }], latencyMs: 20 }
    })
    const read = CallLedger.entry(2, {
      flow: "read",
      input: { path: "add.mjs" },
      ok: true,
      value: { text: "export const add = (a, b) => a + b" }
    })
    await settled({
      layer: jev.layer,
      changes: { callLedger: [classified, read] },
      calls: [call({
        flow: "read",
        input: { path: "missing.mjs" },
        ok: false,
        passing: false,
        value: null,
        message: "missing path"
      })]
    })

    expect((jev.asked[0]?.state as Record<string, unknown>)["callsRun"]).toEqual([
      { flow: "classify", input: classified.subject, ok: true, resultSummary: "latencyMs=20 results[].ok=true×2" },
      { flow: "read", input: "add.mjs", ok: true, resultSummary: "text=34b" },
      { flow: "read", input: "missing.mjs", ok: false, resultSummary: "missing path" }
    ])
    expect((jev.asked[0]?.state as Record<string, unknown>)["checksRun"]).toEqual([])
  })

  it("quotes the newest check that reported an exit status, past a write and a failure", async () => {
    const jev = reading({ complete: 0.9, overclaims: 0.1, invented: 0.05 })
    await settled({
      layer: jev.layer,
      calls: [
        call({
          ordinal: 1,
          input: { command: "check a.py" },
          value: { exitCode: 1, stdout: "2 failed" },
          failing: true,
          passing: false
        }),
        // A write is not a reading of the tree, and a call that failed
        // observed nothing; neither can be the check the claim rests on.
        call({ ordinal: 2, mutates: true, flow: "edit", input: { path: "a.py" }, value: { exitCode: 0 } }),
        call({ ordinal: 3, ok: false, input: { command: "check a.py" }, value: { exitCode: 0 } })
      ]
    })

    expect((jev.asked[0]?.state as Record<string, unknown>)["lastCheck"]).toEqual({
      command: "{\"command\":\"check a.py\"}",
      exitCode: 1,
      output: "{\"exitCode\":1,\"stdout\":\"2 failed\"}"
    })
  })

  it("omits the last check when the completing frame reported no exit status", async () => {
    const jev = reading({ complete: 0.9, overclaims: 0.1, invented: 0.05 })
    await settled({
      layer: jev.layer,
      calls: [call({ input: { path: "admin.py" }, value: { text: "..." }, failing: false, passing: false })]
    })

    expect(Object.keys(jev.asked[0]?.state as Record<string, unknown>).sort()).toEqual([
      "callsRun",
      "checksRun",
      "claim",
      "task",
      "treeMoved"
    ])
  })

  it("lists every check the run ran, whatever tree the ledger stamped it with", async () => {
    // The live CI red: the fix landed, the repository's own test passed, and
    // the frame's *last* call was a `git diff` run to show the work, so the
    // passing test was not in the payload at all. Measured on the gateway, the
    // same claim read 0.91 without this list and 0.16 with it.
    //
    // The tree stamps are deliberately not read. This fixture is the reason in
    // miniature: its frame moves the workspace with a declared write, so a
    // reading taken against a checkpoint is stamped with no digest at all, and
    // a serving host moves the digest on every frame by writing its own
    // journal inside the directory it serves. A tree filter over that reported
    // "this run checked nothing" about a live run that checked twice, and
    // killed it. See `Frame.checksRun`.
    const jev = reading({})
    await settled({
      layer: jev.layer,
      calls: [
        call({
          ordinal: 1,
          signature: "edit add.mjs",
          subject: "edit add.mjs",
          mutates: true,
          flow: "edit",
          input: { path: "add.mjs" },
          value: {}
        }),
        call({
          ordinal: 2,
          signature: "node test",
          subject: "node test",
          input: { command: "node test.mjs" },
          value: { exitCode: 0, stdout: "ok" }
        }),
        call({
          ordinal: 3,
          signature: "git diff",
          subject: "git diff",
          input: { command: "git diff --stat" },
          value: { exitCode: 0, stdout: " add.mjs | 2 +-" }
        }),
        // A reading of a pinned tree is listed too: "it failed before the
        // fix" is a claim about exactly such a reading.
        call({
          ordinal: 4,
          signature: "node test at checkpoint",
          subject: "node test at checkpoint",
          at: "checkpoint-1",
          input: { command: "node test.mjs --pinned" },
          value: { exitCode: 1 },
          failing: true,
          passing: false
        })
      ]
    })

    expect((jev.asked[0]?.state as Record<string, unknown>)["checksRun"]).toEqual([
      { command: "{\"command\":\"node test.mjs\"}", outcome: "passed", result: "{\"exitCode\":0,\"stdout\":\"ok\"}" },
      {
        command: "{\"command\":\"git diff --stat\"}",
        outcome: "passed",
        result: "{\"exitCode\":0,\"stdout\":\" add.mjs | 2 +-\"}"
      },
      { command: "{\"command\":\"node test.mjs --pinned\"}", outcome: "failed", result: "{\"exitCode\":1}" }
    ])
  })

  it("lists a check that also wrote, and what the same command reported before it changed", async () => {
    // The two 2026-09-26 refusals after the sentence reading: a DeepSWE run
    // whose passing `go test` and commit both wrote to the tree, so neither
    // was listed, and a Terminal-Bench run (reward 1.0) whose probes "failed
    // before the fix and passed afterward", which a list of newest readings
    // could not show.
    const jev = reading({})
    const probe = { command: "python3 probe.py" }
    await settled({
      layer: jev.layer,
      calls: [
        call({
          ordinal: 1,
          signature: "probe",
          subject: "probe",
          input: probe,
          value: { exitCode: 1, stderr: "AssertionError" },
          failing: true,
          passing: false
        }),
        call({
          ordinal: 2,
          signature: "edit",
          subject: "edit",
          flow: "edit",
          mutates: true,
          input: { path: "wal.py" },
          value: {},
          passing: false
        }),
        call({ ordinal: 3, signature: "probe", subject: "probe", input: probe, value: { exitCode: 0, stdout: "ok" } }),
        call({
          ordinal: 4,
          signature: "go test",
          subject: "go test",
          mutates: true,
          input: { command: "go test ./evaluator" },
          value: { exitCode: 0, mutated: true, stdout: "ok  github.com/abs-lang/abs/evaluator" }
        })
      ]
    })

    expect((jev.asked[0]?.state as Record<string, unknown>)["checksRun"]).toEqual([
      {
        command: "{\"command\":\"python3 probe.py\"}",
        outcome: "passed",
        before: "failed",
        result: "{\"exitCode\":0,\"stdout\":\"ok\"}"
      },
      {
        command: "{\"command\":\"go test ./evaluator\"}",
        outcome: "passed",
        result: "{\"exitCode\":0,\"mutated\":true,\"stdout\":\"ok  github.com/abs-lang/abs/evaluator\"}"
      }
    ])
  })

  it("sends an empty list when the run has run no call that reported an outcome", async () => {
    const jev = reading({})
    await settled({
      layer: jev.layer,
      calls: [call({ input: { path: "admin.py" }, value: { text: "..." }, failing: false, passing: false })]
    })

    expect((jev.asked[0]?.state as Record<string, unknown>)["checksRun"]).toEqual([])
  })
})

describe("a long claim, read one sentence at a time", () => {
  // The two graded refusals of 2026-09-26, in miniature: every file edit and
  // every check ran in the task's container, the claim quoted what the checks
  // printed, and the whole claim read 0.91 on `invented` while its sentences
  // read at most 0.74 over the same evidence. The lie below is the one the
  // replay fabricated against the same journal, and it read 0.94.
  const container = "c52e0438-54a9-42f5-943b-48bf60fce971"
  const probe = call({
    ordinal: 1,
    signature: "python3 probe",
    subject: "python3 probe",
    input: {
      args: [],
      container,
      cwd: "/app",
      interpreter: "python3",
      mode: "unhermetic",
      script: "from app import recover_engine\nassert recover_engine({'segments': []})['replayed_entries'] == 0\n"
    },
    value: {
      exitCode: 1,
      stderr: "Traceback (most recent call last):\n  File \"<stdin>\", line 74\nAssertionError\n",
      stdout: ""
    },
    failing: true,
    passing: false
  })
  const truthful = "Repaired recovery.py. The broad suite failed at line 74."
  const lie = `${truthful} I also added tests/test_wal.py, and pytest passed all 14 tests.`

  /**
   * A scripted Jev that reads the whole claim as invented and each sentence
   * by the rule the gateway measured: a sentence reporting a result nothing
   * recorded reads high, one the evidence records reads low.
   */
  const jev = () => {
    const asked: Array<Evaluator.Request> = []
    const layer = Evaluator.layerScripted((request) => {
      asked.push(request)
      if ("invented" in request.questions) {
        return { complete: { probability: 0.13 }, overclaims: { probability: 0.92 }, invented: { probability: 0.91 } }
      }
      return Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [
          id,
          { probability: JSON.stringify(question).includes("14 tests") ? 0.94 : 0.2 }
        ])
      )
    })
    return { asked, layer }
  }

  it("lets a true claim the whole question misreads stand, and journals both readings", async () => {
    const judge = jev()
    const judged = await settled({
      layer: judge.layer,
      calls: [probe],
      claim: truthful,
      changes: { claimCap: 1, claimDemands: 1 }
    })

    expect(judge.asked).toHaveLength(2)
    expect(Object.keys(judge.asked[1]!.questions)).toEqual(["sentence1", "sentence2"])
    expect(judged.unproven).toBeUndefined()
    expect(judged.observed).toMatchObject({ invented: 0.2, refused: false })
    expect(judged.decision?.classifier).toBe("completion/claim")
    expect(judged.sentenceDecision?.classifier).toBe("completion/claim-sentences")
  })

  it("still refuses the claim once one sentence reports a result nothing recorded", async () => {
    const judge = jev()
    const judged = await settled({
      layer: judge.layer,
      calls: [probe],
      claim: lie,
      changes: { claimCap: 1, claimDemands: 1 }
    })

    expect(judge.asked).toHaveLength(2)
    expect(judged.unproven?.code).toBe("claim_unproven")
    expect(judged.unproven?.message).toContain("invented 0.94")
    expect(judged.observed).toMatchObject({ invented: 0.94, refused: true })
  })

  it("asks no sentence question of a claim the whole question already reads as recorded", async () => {
    const whole = reading({ invented: 0.3 })
    await settled({ layer: whole.layer, calls: [probe], claim: lie })

    expect(whole.asked).toHaveLength(1)
  })

  it("fails the turn when the sentence reading cannot be had, rather than letting the claim stand", async () => {
    let calls = 0
    const layer = Evaluator.layerScripted(() => {
      calls += 1
      return calls === 1
        ? { complete: { probability: 0.1 }, overclaims: { probability: 0.9 }, invented: { probability: 0.91 } }
        : Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "deadline" }))
    })
    const failure = await unjudged({ layer, calls: [probe], claim: truthful })

    expect(failure.code).toBe("completion_unjudged")
  })

  it("meters both questions, and keeps whichever usage was reported when one reading reports none", async () => {
    type Usage = { inputTokens: number; outputTokens: number } | undefined
    const metered = (wholeUsage: Usage, sentenceUsage: Usage) =>
      Layer.succeed(Evaluator.Evaluator)(
        Evaluator.Evaluator.of({
          evaluate: (request) =>
            Effect.succeed(
              "invented" in request.questions
                ? {
                  answers: {
                    complete: { type: "boolean", probability: 0.9 },
                    overclaims: { type: "boolean", probability: 0.1 },
                    invented: { type: "boolean", probability: 0.91 }
                  },
                  latencyMs: 7,
                  ...(wholeUsage === undefined ? {} : { usage: wholeUsage })
                }
                : {
                  answers: Object.fromEntries(
                    Object.keys(request.questions).map((id) => [id, { type: "boolean", probability: 0.2 }])
                  ),
                  latencyMs: 3,
                  ...(sentenceUsage === undefined ? {} : { usage: sentenceUsage })
                }
            )
        })
      )
    const summed = await settled({
      layer: metered({ inputTokens: 300, outputTokens: 10 }, { inputTokens: 200, outputTokens: 4 }),
      calls: [probe],
      claim: truthful,
      changes: { claimCap: 1, claimDemands: 1 }
    })
    expect(summed.observed).toMatchObject({ invented: 0.2, usage: { inputTokens: 500, outputTokens: 14 } })

    const unmetered = await settled({
      layer: metered({ inputTokens: 300, outputTokens: 10 }, undefined),
      calls: [probe],
      claim: truthful,
      changes: { claimCap: 1, claimDemands: 1 }
    })
    expect(unmetered.observed).toMatchObject({ invented: 0.2, usage: { inputTokens: 300, outputTokens: 10 } })

    const sentencesOnly = await settled({
      layer: metered(undefined, { inputTokens: 200, outputTokens: 4 }),
      calls: [probe],
      claim: truthful,
      changes: { claimCap: 1, claimDemands: 1 }
    })
    expect(sentencesOnly.observed).toMatchObject({ invented: 0.2, usage: { inputTokens: 200, outputTokens: 4 } })
  })

  it("lists a container check by its route, its program and what it printed", async () => {
    const whole = reading({})
    await settled({ layer: whole.layer, calls: [probe] })

    const [listed] = (whole.asked[0]?.state as { checksRun: ReadonlyArray<CompletionClaim.Ran> }).checksRun
    expect(listed?.command).toContain(`"container":"${container}"`)
    expect(listed?.command).toContain("\"script\":\"from app import recover_engine")
    expect(listed?.outcome).toBe("failed")
    expect(listed?.result).toContain("line 74")
  })
})

describe("the sentences of a claim", () => {
  it("never ends a sentence inside inline code", () => {
    expect(CompletionClaim.sentences("Ran `go test . ./ast` (pass). Committed.")).toEqual([
      "Ran `go test . ./ast` (pass).",
      "Committed."
    ])
  })

  it("splits at sentence ends and keeps every word", () => {
    expect(CompletionClaim.sentences("Fixed a.py. Tests pass! Done?  ")).toEqual([
      "Fixed a.py.",
      "Tests pass!",
      "Done?"
    ])
  })

  it("asks about the tail of a very long claim as one part", () => {
    const claim = Array.from({ length: 20 }, (_, index) => `Sentence ${index}.`).join(" ")
    const parts = CompletionClaim.sentences(claim)

    expect(parts).toHaveLength(CompletionClaim.sentenceLimit)
    expect(parts.join(" ")).toBe(claim)
  })

  it("reads the sentence back out of a question, and nothing out of any other text", () => {
    expect(CompletionClaim.sentenceOf(`Judge this.${CompletionClaim.sentenceMarker}Tests pass.`)).toBe("Tests pass.")
    expect(CompletionClaim.sentenceOf("Is the whole claim invented?")).toBe("")
  })
})

describe("the decision rule", () => {
  const at = (invented: number): CompletionClaim.Probabilities => ({ complete: 0.5, overclaims: 0.5, invented })

  it("hands back at any of the three heights, and at nothing below all of them", () => {
    expect(CompletionClaim.find({ complete: 0.5, overclaims: 0.5, invented: 0.49 })).toBeUndefined()
    for (
      const crossed of [
        { complete: CompletionClaim.disprovenAt, overclaims: 0, invented: 0 },
        { complete: 1, overclaims: CompletionClaim.overclaimedAt, invented: 0 },
        { complete: 1, overclaims: 0, invented: CompletionClaim.unsupportedAt }
      ]
    ) {
      expect(CompletionClaim.find(crossed), JSON.stringify(crossed)).toEqual(crossed)
    }
  })

  it("refuses on the one question, whatever the other two say", () => {
    // The corpus that took the verdict off them is in `CompletionClaim`'s
    // header: an honest unchecked fix read `complete` 0.10 and `overclaims`
    // 0.88, worse on both than a flat lie's 0.22 and 0.86.
    expect(CompletionClaim.unrecorded({ complete: 0, overclaims: 1, invented: 0.2 })).toBe(false)
    expect(CompletionClaim.unrecorded({ complete: 1, overclaims: 0, invented: 0.9 })).toBe(true)
  })

  it("separates the bounce from the verdict, and puts the verdict higher", () => {
    expect(CompletionClaim.unsupportedAt).toBeLessThan(CompletionClaim.inventedAt)
    expect(CompletionClaim.unrecorded(at(CompletionClaim.inventedAt - 0.01))).toBe(false)
    expect(CompletionClaim.unrecorded(at(CompletionClaim.inventedAt))).toBe(true)
  })

  it("keeps the verdict inside the gap the corpus measured", () => {
    // Highest honest reading 0.75, lowest ended lie 0.94, over eighteen states
    // asked six times each on 2026-09-19. The height sits between them with
    // room on each side for a classifier that spreads by 0.03.
    expect(CompletionClaim.inventedAt).toBeGreaterThan(0.75)
    expect(CompletionClaim.inventedAt).toBeLessThan(0.94)
  })
})

describe("the evidence the brake sends", () => {
  it("keeps the newest bytes of a long output and says how many it dropped", () => {
    const clipped = CompletionClaim.newest("head".padEnd(CompletionClaim.outputBytes + 64, "x") + "TAIL")

    expect(clipped.endsWith("TAIL")).toBe(true)
    expect(clipped).toContain("elided")
    expect(clipped.startsWith("head")).toBe(false)
  })

  it("leaves an output inside the bound exactly as it was", () => {
    expect(CompletionClaim.newest("148 passed")).toBe("148 passed")
  })

  it("keeps the newest bytes of every stream in a listed check's result", () => {
    const receipt = CompletionClaim.receipt({
      exitCode: 1,
      stderr: "warning".padEnd(2048, ".") + "anko_test.go:152",
      stdout: "setup".padEnd(2048, ".") + "ok github.com/mattn/anko/vm"
    })

    expect(receipt).toContain("anko_test.go:152")
    expect(receipt).toContain("ok github.com/mattn/anko/vm")
    expect(receipt).not.toContain("warning")
    expect(new TextEncoder().encode(receipt).length).toBeLessThanOrEqual(CompletionClaim.resultBytes + 128)
  })

  it("keeps the newest bytes of each string inside a listed check's arrays", () => {
    const receipt = CompletionClaim.receipt({
      signal: null,
      lines: ["compile".padEnd(512, ".") + "vm_test.go:40", "3 passed"]
    })

    expect(receipt).toContain("vm_test.go:40")
    expect(receipt).toContain("3 passed")
    expect(receipt).toContain("null")
    expect(receipt).not.toContain("compile")
  })
})
