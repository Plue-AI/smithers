/**
 * The journal shape of agent events projected by the executor.
 *
 * `AgentSession.test.ts` covers the events a live run produces. These
 * cases pin every payload field independently of the run that produced it.
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as Digest from "@smthrs/core/Digest"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as CellTurn from "@smthrs/harness/CellTurn"
import * as ContextWindow from "@smthrs/harness/ContextWindow"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as Transcript from "@smthrs/harness/Transcript"
import { Redaction } from "@smthrs/journal"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Frame from "../harness/src/internal/frame.ts"
import * as AgentSession from "../src/AgentSession.ts"
import { unordered } from "../src/internal/TraceOrder.ts"

const identity = new Cell.CallIdentity({
  session: "session-1",
  frame: 2,
  cell: "sha256:cell",
  ordinal: 1,
  declaration: "sha256:declaration",
  layers: ["layer-a"]
})

describe("completion refusal projection", () => {
  it("keeps the refusal produced by the real completion judge", async () => {
    const contextWindow = ContextWindow.make({
      modelId: "test-model",
      segments: [{
        kind: "instructions",
        zone: "prefix",
        content: [ModelRequest.SystemPart.make({ text: "The task: preserve query strings." })]
      }]
    })
    const state = new CellTurn.State({
      ...CellTurn.make({
        session: "claim-refusal",
        seat: "anthropic:test-model",
        modelParams: ModelRequest.GenerationParams.make(),
        layers: [],
        capabilityEnvelope: [],
        placement: Option.none(),
        contextWindow,
        maxFrames: 10
      }),
      openingDigest: "before",
      claimCap: 1,
      claimDemands: 1
    })
    const observation = (digest: string) =>
      Option.some(new EngineLike.Observation({ digest, paths: 3, complete: true }))
    const judged = await Effect.runPromise(Effect.provide(
      Frame.judgeCompletion(
        state,
        Frame.account({
          state,
          calls: [],
          opened: observation("before"),
          closed: observation("after"),
          minted: [],
          bindings: [],
          captures: []
        }),
        contextWindow,
        "Updated the redirect and ran the tests."
      ),
      Evaluator.layerScripted(() => ({
        complete: { probability: 0.1 },
        overclaims: { probability: 0.9 },
        invented: { probability: 0.95 }
      }))
    ))
    expect(judged.unproven?.code).toBe("claim_unproven")
    expect(judged.observed).toMatchObject({ _tag: "claim-demanded", demanded: false, refused: true })
    if (judged.observed === undefined) throw new Error("completion judge emitted no reading")
    expect(AgentSession.trace(judged.observed)).toMatchObject({
      eventType: "control.agent.claim-demanded",
      payload: { demanded: false, refused: true }
    })
  })
})

describe("capacity event trace", () => {
  it("projects failover, park, and wake fields for the control journal", () => {
    expect(AgentSession.trace(
      new AgentEvent.SeatFailedOver({
        eventType: AgentEvent.eventType.seatFailedOver,
        from: "first",
        to: "second",
        code: "rate_limited",
        resetAtEpochMillis: 5000
      })
    )).toEqual({
      eventType: "control.agent.seat-failed-over",
      payload: { from: "first", to: "second", code: "rate_limited", resetAtEpochMillis: 5000 }
    })
    expect(AgentSession.trace(
      new AgentEvent.ModelParked({
        eventType: AgentEvent.eventType.modelParked,
        seat: "second",
        wakeAt: 5000,
        source: "reset",
        code: "rate_limited"
      })
    )).toEqual({
      eventType: "control.agent.model-parked",
      payload: { seat: "second", wakeAt: 5000, source: "reset", code: "rate_limited" }
    })
    expect(AgentSession.trace(
      new AgentEvent.ModelUnparked({
        eventType: AgentEvent.eventType.modelUnparked,
        seat: "second",
        at: 5000
      })
    )).toEqual({ eventType: "control.agent.model-unparked", payload: { seat: "second", at: 5000 } })
  })
})

describe("durable call identity", () => {
  it("joins starts and both settlement outcomes by dispatch coordinates, independent of emission order", () => {
    const first = new Cell.Call({ ...call, identity })
    const second = new Cell.Call({ ...call, identity: new Cell.CallIdentity({ ...identity, ordinal: 2 }) })
    const start = (value: Cell.Call) =>
      AgentSession.trace(
        new AgentEvent.CellCallStarted({
          eventType: "flows.harness.cell-call-started.v1",
          call: value
        })
      )!.payload as Record<string, unknown>
    const settle = (value: Cell.Call, outcome: "success" | "failure") =>
      AgentSession.trace(
        new AgentEvent.CellCallSettled({
          eventType: "flows.harness.cell-call-settled.v1",
          flowName: value.flowName,
          identity: value.identity,
          result: new Cell.CallResult({ outcome, value: null })
        })
      )!.payload as Record<string, unknown>

    const opened = [start(first), start(second)]
    const closed = [settle(second, "failure"), settle(first, "success")]
    expect(opened[0]!.callId).toMatch(/^cell-call-v1:[0-9a-f]{64}$/)
    expect(opened[0]!.callId).not.toBe(opened[1]!.callId)
    expect(closed.map((event) => event.callId)).toEqual([opened[1]!.callId, opened[0]!.callId])
    expect(start(new Cell.Call({ ...first, identity: new Cell.CallIdentity({ ...identity }) }))).toEqual(opened[0])
  })

  it("distinguishes every durable dispatch coordinate", () => {
    const original = AgentSession.callId(identity)
    // This versioned identity is a persisted wire contract, not an internal
    // hash callers may change without migrating their event readers.
    expect(original).toBe("cell-call-v1:18b4aad60dd9bbc9875dda2124e7dde13cc960181ebcb84729df8e461b1a2929")
    const changed = [
      { session: "another-session" },
      { frame: 3 },
      { cell: "another-cell" },
      { ordinal: 2 },
      { declaration: "another-declaration" },
      { layers: ["layer-b"] }
    ]
    expect(
      new Set(changed.map((change) => AgentSession.callId(new Cell.CallIdentity({ ...identity, ...change })))).size
    )
      .toBe(changed.length)
    for (const change of changed) {
      expect(AgentSession.callId(new Cell.CallIdentity({ ...identity, ...change })))
        .not.toBe(original)
    }
  })

  it("keeps legacy producer dedup keys when callId is added during a resumed run", () => {
    for (const kind of ["control.agent.cell-call-started", "control.agent.cell-call-settled"]) {
      const legacy = { flowName: "write", input: {}, outcome: "success", value: "written" }
      expect(AgentSession.traceIdentity(2, 4, "cell", kind, { ...legacy, callId: AgentSession.callId(identity) }))
        .toBe(AgentSession.traceIdentity(2, 4, "cell", kind, legacy))
    }
    // This migration rule applies only to call lifecycle records.
    expect(AgentSession.traceIdentity(2, 4, "cell", "control.agent.cell-printed", { callId: "a" }))
      .not.toBe(AgentSession.traceIdentity(2, 4, "cell", "control.agent.cell-printed", { callId: "b" }))
  })
})

const call = new Cell.Call({
  flowName: "notes/save",
  input: { text: "Remember this." },
  capabilities: ["fs:write:notes/**"],
  effects: {
    reads: ["/notes/**"],
    writes: ["/notes/log.md"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  placement: Option.none(),
  identity
})

const cell = Cell.source("ctx.done('done')")
const transition = new Cell.Complete({ output: "done" })
const outcome = new Cell.Settled({ transition })
const reason = new EngineLike.SuspendReason({ code: "waiting-input", message: "Needs an answer" })
const request = new Permission.PermissionRequired({
  requestId: "permission-1",
  runId: "run-1",
  capability: Capability.make("fs:write", "notes/log.md"),
  tier: "irreversible",
  meta: { flowName: "notes/save" }
})
const assistant = ModelRequest.Message.assistant([
  ModelRequest.TextPart.make({ text: "First line." }),
  ModelRequest.ToolCallPart.make({ id: "call-0", name: "cell", arguments: "{}" }),
  ModelRequest.TextPart.make({ text: "Second line." })
])

describe("trace", () => {
  it.each([undefined, false, true])("preserves supervisor readings and optional evidence (steer=%s)", (steer) => {
    const present = steer !== undefined
    const payload = {
      scope: "session-1",
      frame: 2,
      thrashing: 0.1,
      onTarget: 0.9,
      suspect: 0.2,
      frustrated: "mild" as const,
      anxious: "none" as const,
      scared: "strong" as const,
      confused: "none" as const,
      confident: "strong" as const,
      needsHelp: "permission" as const,
      crossed: true,
      nudged: false,
      latencyMs: 23,
      ...(present
        ? {
          outdatedContext: 0,
          irrelevantContext: 0.8,
          steer,
          usage: { inputTokens: 7, outputTokens: 3 },
          skillsCapped: true
        }
        : {})
    }
    const event = new AgentEvent.SupervisorSettled({ eventType: "flows.harness.supervisor-settled.v1", ...payload })
    expect(AgentSession.trace(event)).toEqual({ eventType: "control.agent.supervisor-settled", payload })
  })

  it.each(
    [
      [
        "model-retried",
        new AgentEvent.ModelRetried({
          eventType: "flows.harness.model-retried.v1",
          attempt: 2,
          code: "transport",
          delayMillis: 2_137
        }),
        {
          eventType: "control.agent.model-retried",
          // The delay is journaled with the attempt: every retry of one sealed
          // step is written when that step settles, so the run's own event
          // timestamps cannot tell a backoff from an immediate re-fire, and a
          // wave report reads the schedule off this payload instead.
          payload: { attempt: 2, code: "transport", delayMillis: 2_137 }
        }
      ],
      [
        "discipline-armed",
        new AgentEvent.DisciplineArmed({
          eventType: "flows.harness.discipline-armed.v1",
          readOnlyCap: 12,
          maxFrames: 100,
          approvalChannel: false,
          modelCallMs: 300_000,
          repeatCap: 4,
          narrowingCap: 1,
          unmovedCap: 1,
          unresolvedCap: 1,
          calls: 64,
          memoryBytes: 134_217_728,
          steps: 1_000,
          timeMs: 30_000,
          callMs: 120_000,
          totalMs: 900_000
        }),
        {
          eventType: "control.agent.discipline-armed",
          payload: {
            readOnlyCap: 12,
            maxFrames: 100,
            // False says nobody can answer a park, so the loop refuses one
            // rather than leaving the run waiting on an operator who is not
            // there. It is journaled before the first frame, like every other
            // armed budget.
            approvalChannel: false,
            // The model-call budget is journaled beside the cell budgets, and
            // `control.agent.model-settled` already carries `durationMillis`
            // per call, so a report can grade every call against the ceiling
            // the run armed without re-instrumenting anything.
            modelCallMs: 300_000,
            // The convergence threshold, journaled for the same reason the
            // read cap is: a wave that records no repeat demand can then say
            // whether the control was armed and never needed, or never armed.
            repeatCap: 4,
            // The completion control, journaled for the same reason: it fires
            // at most once in a run and usually not at all, so its absence
            // from a wave says nothing unless the arming is on the record.
            narrowingCap: 1,
            // The two controls that judge what a completion is about rather
            // than how it was verified — whether the run changed anything, and
            // whether it answered the check that told it something was broken
            // — journaled for the same reason and read the same way.
            unmovedCap: 1,
            unresolvedCap: 1,
            calls: 64,
            memoryBytes: 134_217_728,
            steps: 1_000,
            timeMs: 30_000,
            callMs: 120_000,
            totalMs: 900_000
          }
        }
      ],
      [
        "cell-rejected-in-frame",
        new AgentEvent.CellRejectedInFrame({
          eventType: "flows.harness.cell-rejected-in-frame.v1",
          attempt: 2,
          code: "no_cell",
          message: "No cell was found in the response."
        }),
        {
          eventType: "control.agent.cell-rejected-in-frame",
          // A refused reply is a real model call, so the frame's re-ask is
          // spend a wave counting cost per frame must see. `attempt` is what
          // makes the ratio to the frame's settlement readable.
          payload: { attempt: 2, code: "no_cell", message: "No cell was found in the response." }
        }
      ],
      [
        "narrowed-demanded",
        new AgentEvent.NarrowedDemanded({
          eventType: "flows.harness.narrowed-demanded.v1",
          flow: "bash",
          broader: "{\"command\":\"run the whole check\"}",
          narrower: "{\"command\":\"run the whole check -select one\"}",
          broaderDigest: "tree-before",
          currentDigest: "tree-after",
          nextFrame: 19
        }),
        {
          eventType: "control.agent.narrowed-demanded",
          // Both inputs and both digests: the demand's whole justification is
          // the pair, and a grader must be able to second-guess it from the
          // journal without replaying the run.
          payload: {
            flow: "bash",
            broader: "{\"command\":\"run the whole check\"}",
            narrower: "{\"command\":\"run the whole check -select one\"}",
            broaderDigest: "tree-before",
            currentDigest: "tree-after",
            nextFrame: 19
          }
        }
      ],
      [
        "narrow-only-demanded",
        new AgentEvent.NarrowOnlyDemanded({
          eventType: "flows.harness.narrow-only-demanded.v1",
          flow: "bash",
          check: "{\"command\":\"run one case of the check\"}",
          targets: ["src/one.ts", "test/one.test.ts"],
          currentDigest: "tree-after",
          nextFrame: 21
        }),
        {
          eventType: "control.agent.narrow-only-demanded",
          // No broader input exists to pair the check against — that is what
          // separates this demand from `narrowed-demanded` — so `targets` is
          // the record of what the demand was about.
          payload: {
            flow: "bash",
            check: "{\"command\":\"run one case of the check\"}",
            targets: ["src/one.ts", "test/one.test.ts"],
            currentDigest: "tree-after",
            nextFrame: 21
          }
        }
      ],
      [
        "unmoved-demanded",
        new AgentEvent.UnmovedDemanded({
          eventType: "flows.harness.unmoved-demanded.v1",
          openedDigest: "tree-opened",
          currentDigest: "tree-opened",
          nextFrame: 7
        }),
        {
          eventType: "control.agent.unmoved-demanded",
          // Both digests, because the judgement is the comparison: one alone
          // cannot tell an unmoved tree from a measurement that never happened,
          // and the pair reconciles against the run's `mutation-observed`
          // record without replaying anything.
          payload: { openedDigest: "tree-opened", currentDigest: "tree-opened", nextFrame: 7 }
        }
      ],
      [
        "claim-demanded",
        new AgentEvent.ClaimDemanded({
          eventType: "flows.harness.claim-demanded.v1",
          complete: 0.11,
          overclaims: 0.93,
          invented: 0.94,
          latencyMs: 412,
          demanded: true,
          currentDigest: "tree-after",
          nextFrame: 12
        }),
        {
          eventType: "control.agent.claim-demanded",
          // All three probabilities and the latency, because this is the one
          // demand a grader cannot recompute: it is a model's answer, and
          // `demanded` names a firing; `refused` names a spent-cap rejection.
          // `invented` is the one that acts; the other two are journaled and
          // decide nothing. See `CompletionClaim`.
          payload: {
            complete: 0.11,
            overclaims: 0.93,
            invented: 0.94,
            latencyMs: 412,
            demanded: true,
            refused: false,
            currentDigest: "tree-after",
            nextFrame: 12
          }
        }
      ],
      [
        "unresolved-demanded",
        new AgentEvent.UnresolvedDemanded({
          eventType: "flows.harness.unresolved-demanded.v1",
          flow: "bash",
          failed: "{\"command\":\"run the whole check\"}",
          instead: "{\"command\":\"diff it && run one case of the check\"}",
          currentDigest: "tree-after",
          nextFrame: 14
        }),
        {
          eventType: "control.agent.unresolved-demanded",
          // The failing reading and the one that displaced it, for the same
          // reason the narrowing pair travels together: either alone is
          // unremarkable and the demand is entirely about the two of them.
          payload: {
            flow: "bash",
            failed: "{\"command\":\"run the whole check\"}",
            instead: "{\"command\":\"diff it && run one case of the check\"}",
            currentDigest: "tree-after",
            nextFrame: 14
          }
        }
      ],
      [
        "failed-call-demanded",
        new AgentEvent.FailedCallDemanded({
          eventType: "flows.harness.failed-call-demanded.v1",
          failures: [{ flow: "agent.delegate", message: "Flow agent.delegate failed: Three workers are active" }],
          nextFrame: 1
        }),
        {
          eventType: "control.agent.failed-call-demanded",
          // The failed calls the completion was written before, verbatim.
          payload: {
            failures: [{ flow: "agent.delegate", message: "Flow agent.delegate failed: Three workers are active" }],
            nextFrame: 1
          }
        }
      ],
      [
        "output-demanded",
        new AgentEvent.OutputDemanded({
          eventType: "flows.harness.output-demanded.v1",
          note: "## Your previous answer did not validate",
          nextFrame: 2
        }),
        {
          eventType: "control.agent.output-demanded",
          // The correction the same session was handed, verbatim.
          payload: { note: "## Your previous answer did not validate", nextFrame: 2 }
        }
      ],
      [
        "unobserved-demanded",
        new AgentEvent.UnobservedDemanded({
          eventType: "flows.harness.unobserved-demanded.v1",
          calls: [{ flow: "bash", ordinal: 1, ok: true, summary: "{\"exitCode\":0,\"stdout\":\"ok\\n\"}" }],
          nextFrame: 2
        }),
        {
          eventType: "control.agent.unobserved-demanded",
          // The calls the completion was written without reading, with the
          // head of each result the next frame was shown.
          payload: {
            calls: [{ flow: "bash", ordinal: 1, ok: true, summary: "{\"exitCode\":0,\"stdout\":\"ok\\n\"}" }],
            nextFrame: 2
          }
        }
      ],
      [
        "sufficiency-observed",
        new AgentEvent.SufficiencyObserved({
          eventType: "flows.harness.sufficiency-observed.v1",
          flow: "bash",
          failed: "{\"command\":\"run the whole check\"}",
          passed: "{\"command\":\"run the whole check\"}",
          epoch: 3,
          nextFrame: 9
        }),
        {
          eventType: "control.agent.sufficiency-observed",
          // The only control in the set that is not a brake, and the only
          // event written for a frame that did nothing wrong. `epoch` is the
          // run's mutating-frame count when the failure was recorded, which is
          // what makes the before-and-after ordering checkable after the fact.
          payload: {
            flow: "bash",
            failed: "{\"command\":\"run the whole check\"}",
            passed: "{\"command\":\"run the whole check\"}",
            epoch: 3,
            nextFrame: 9
          }
        }
      ],
      [
        "vacuous-verification-observed",
        new AgentEvent.VacuousVerificationObserved({
          eventType: "flows.harness.vacuous-verification-observed.v1",
          flow: "bash",
          check: "{\"command\":\"run the whole check\"}",
          callDigest: "e3b0c44298fc1c14",
          nextFrame: 15
        }),
        {
          eventType: "control.agent.vacuous-verification-observed",
          // The stored input and the identity it was matched by: the whole
          // judgement is that this exact call had already been watched passing,
          // and a reader with only the text cannot tell an exact reuse from a
          // command that merely reads like one.
          payload: {
            flow: "bash",
            check: "{\"command\":\"run the whole check\"}",
            callDigest: "e3b0c44298fc1c14",
            nextFrame: 15
          }
        }
      ],
      [
        "read-only-demand-issued",
        new AgentEvent.ReadOnlyDemandIssued({
          eventType: "flows.harness.read-only-demand-issued.v1",
          streak: 12,
          cap: 12,
          nextFrame: 13
        }),
        {
          eventType: "control.agent.read-only-demand-issued",
          // The demand's issuance, kept apart from `read-only-demanded`, which
          // is the same demand's later answer: a crash between those two
          // boundaries must still leave the demand on the record.
          payload: { streak: 12, cap: 12, nextFrame: 13 }
        }
      ],
      [
        "read-only-demanded",
        new AgentEvent.ReadOnlyDemanded({
          eventType: "flows.harness.read-only-demanded.v1",
          streak: 12,
          cap: 12,
          nextFrame: 13,
          nextAction: "write"
        }),
        {
          eventType: "control.agent.read-only-demanded",
          payload: { streak: 12, cap: 12, nextFrame: 13, nextAction: "write" }
        }
      ],
      [
        "repeat-demanded",
        new AgentEvent.RepeatDemanded({
          eventType: "flows.harness.repeat-demanded.v1",
          frames: 4,
          cap: 4,
          nextFrame: 15
        }),
        {
          eventType: "control.agent.repeat-demanded",
          // Written when the demand is issued rather than when it is answered:
          // the answer is the shape of frame 15's calls, and those are already
          // journaled one at a time.
          payload: { frames: 4, cap: 4, nextFrame: 15 }
        }
      ],
      [
        "turn-opened",
        new AgentEvent.TurnOpened({
          eventType: "flows.harness.turn-opened.v1",
          seat: "anthropic:test-model",
          modelParams: ModelRequest.GenerationParams.make({ temperature: 0 }),
          activeToolNames: ["cell"],
          contextDigest: "sha256:context"
        }),
        {
          eventType: "control.agent.turn-opened",
          payload: { seat: "anthropic:test-model", contextDigest: "sha256:context" }
        }
      ],
      [
        "model-settled",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: assistant,
          usage: ModelEvent.Usage.make({ inputTokens: 12, outputTokens: 3 }),
          durationMillis: 1_250
        }),
        {
          eventType: "control.agent.model-settled",
          payload: {
            text: "First line.\nSecond line.",
            usage: { inputTokens: 12, outputTokens: 3 },
            durationMillis: 1_250
          }
        }
      ],
      [
        "model-settled by a wrapped CLI seat",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: assistant,
          usage: ModelEvent.Usage.make({ inputTokens: 12, outputTokens: 3 }),
          durationMillis: 1_250,
          sessionId: "5f3c-claude-session"
        }),
        {
          eventType: "control.agent.model-settled",
          payload: {
            text: "First line.\nSecond line.",
            usage: { inputTokens: 12, outputTokens: 3 },
            durationMillis: 1_250,
            sessionId: "5f3c-claude-session"
          }
        }
      ],
      [
        "cell-produced",
        new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell }),
        {
          eventType: "control.agent.cell-produced",
          payload: { language: cell.language, digest: cell.digest, text: cell.text }
        }
      ],
      [
        "cell-call-started",
        new AgentEvent.CellCallStarted({ eventType: "flows.harness.cell-call-started.v1", call }),
        {
          eventType: "control.agent.cell-call-started",
          payload: { callId: AgentSession.callId(identity), flowName: "notes/save", input: { text: "Remember this." } }
        }
      ],
      [
        "cell-call-settled",
        new AgentEvent.CellCallSettled({
          eventType: "flows.harness.cell-call-settled.v1",
          flowName: "notes/save",
          identity,
          result: new Cell.CallResult({ outcome: "failure", value: null, message: "The note was locked" })
        }),
        {
          eventType: "control.agent.cell-call-settled",
          payload: {
            callId: AgentSession.callId(identity),
            flowName: "notes/save",
            outcome: "failure",
            message: "The note was locked",
            value: null
          }
        }
      ],
      [
        "cell-printed",
        // The whole of the REPL mode's context channel. Journaled with the cell
        // that produced it, so a transcript projection rebuilds a resumed run's
        // window from the journal rather than by re-running anything.
        new AgentEvent.CellPrinted({
          eventType: "flows.harness.cell-printed.v1",
          cell: cell.digest,
          text: "found 2"
        }),
        { eventType: "control.agent.cell-printed", payload: { cell: cell.digest, text: "found 2" } }
      ],
      [
        "cell-settled",
        new AgentEvent.CellSettled({ eventType: "flows.harness.cell-settled.v1", cell: cell.digest, outcome }),
        { eventType: "control.agent.cell-settled", payload: { outcome } }
      ],
      ...[
        new Cell.Raised({ name: "TypeError", message: "cell threw" }),
        new Cell.Rejected({ code: "compile_failed", message: "invalid cell" })
      ].map((failure) =>
        [
          `cell-${failure._tag}`,
          new AgentEvent.CellSettled({
            eventType: "flows.harness.cell-settled.v1",
            cell: cell.digest,
            outcome: failure
          }),
          { eventType: "control.agent.cell-settled", payload: { outcome: failure } }
        ] as const
      ),
      [
        "checkpoint-minted",
        // The store's own name for the tree travels with the id, because the
        // frame that reads against a checkpoint is usually not the frame that
        // pinned it: a journal holding only the reading could not say which
        // tree it was a reading of, and a fails-before proof is that claim.
        new AgentEvent.CheckpointMinted({
          eventType: "flows.harness.checkpoint-minted.v1",
          id: "cp-3-1",
          ref: "refs/flows/checkpoints/cp-3-1",
          cell: cell.digest,
          ordinal: 1
        }),
        {
          eventType: "control.agent.checkpoint-minted",
          payload: { id: "cp-3-1", ref: "refs/flows/checkpoints/cp-3-1", cell: cell.digest, ordinal: 1 }
        }
      ],
      [
        "transition-applied",
        new AgentEvent.TransitionApplied({
          eventType: "flows.harness.transition-applied.v1",
          transition
        }),
        { eventType: "control.agent.transition-applied", payload: { transition } }
      ],
      [
        "suspended",
        new AgentEvent.Suspended({ eventType: "flows.harness.suspended.v1", reason }),
        { eventType: "control.agent.suspended", payload: { reason } }
      ],
      [
        "compaction-settled",
        new AgentEvent.CompactionSettled({
          eventType: "flows.harness.compaction-settled.v1",
          replacedPrefixDigest: "sha256:prefix",
          summary: ModelRequest.Message.assistant("Six frames of edits, summarised.")
        }),
        {
          eventType: "control.agent.compaction-settled",
          payload: { replacedPrefixDigest: "sha256:prefix" }
        }
      ],
      [
        "steering-drained",
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [
            ModelRequest.Message.user("Stop rewriting the parser and fix the lockfile."),
            ModelRequest.Message.assistant("Acknowledged.")
          ]
        }),
        {
          eventType: "control.agent.steering-drained",
          // The operator's own words, which existed nowhere else in the
          // journal: the trail used to record only that some number of steers
          // had been drained. The role travels with each one because a drain
          // carries whatever the queue held.
          payload: {
            messages: [
              { role: "user", text: "Stop rewriting the parser and fix the lockfile." },
              { role: "assistant", text: "Acknowledged." }
            ]
          }
        }
      ],
      [
        "supervisor-memory-failed",
        new AgentEvent.SupervisorMemoryFailed({
          eventType: "flows.harness.supervisor-memory-failed.v1",
          scope: "session-1",
          frame: 2,
          operation: "remember",
          detail: "store: notes locked"
        }),
        {
          eventType: "control.agent.supervisor-memory-failed",
          payload: { scope: "session-1", frame: 2, operation: "remember", detail: "store: notes locked" }
        }
      ],
      [
        "turn-closed",
        new AgentEvent.TurnClosed({
          eventType: "flows.harness.turn-closed.v1",
          stopReason: "tool-calls",
          outcome: "continue"
        }),
        {
          eventType: "control.agent.turn-closed",
          payload: { stopReason: "tool-calls", outcome: "continue" }
        }
      ],
      [
        "permission-required",
        new AgentEvent.PermissionRequired({ eventType: "flows.harness.permission-required.v1", request }),
        { eventType: "control.agent.permission-required", payload: { request } }
      ],
      [
        "aborted",
        new AgentEvent.Aborted({
          eventType: "flows.harness.aborted.v1",
          reason: "frame ceiling reached"
        }),
        {
          eventType: "control.agent.aborted",
          payload: { reason: "frame ceiling reached" }
        }
      ],
      [
        "resolved",
        new AgentEvent.Resolved({ eventType: "flows.harness.resolved.v1", message: assistant }),
        { eventType: "control.agent.resolved", payload: { text: "First line.\nSecond line." } }
      ],
      ...(["cell-settled", "transition-applied"] as const).map((tag) => {
        const transition = new Cell.Complete({ output: "x".repeat(131_072) })
        const outcome = new Cell.Settled({ transition })
        const value = transition.output
        const marker = {
          truncated: true,
          bytes: new TextEncoder().encode(value).byteLength,
          digest: Digest.digest(CanonicalJson.stringify(value))
        }
        return [
          `${tag} with oversized completion output`,
          tag === "cell-settled"
            ? new AgentEvent.CellSettled({ eventType: "flows.harness.cell-settled.v1", cell: cell.digest, outcome })
            : new AgentEvent.TransitionApplied({ eventType: "flows.harness.transition-applied.v1", transition }),
          {
            eventType: `control.agent.${tag}`,
            payload: tag === "cell-settled"
              ? { outcome: { ...outcome, transition: { ...transition, output: marker } } }
              : { transition: { ...transition, output: marker } }
          }
        ] as const
      })
    ] satisfies ReadonlyArray<readonly [string, AgentEvent.AgentEvent, unknown]>
  )(
    "projects %s with its durable payload",
    (_name, event, expected) => {
      expect(AgentSession.trace(event)).toEqual(expected)
    }
  )

  it("journals no model delta", () => {
    expect(
      AgentSession.trace(
        new AgentEvent.ModelDelta({
          eventType: "flows.harness.model-delta.v1",
          delta: { type: "text-delta", id: "text-0", text: "par" }
        })
      )
    ).toBeUndefined()
  })

  it("replaces an oversized call value with its byte count and full-value digest", () => {
    const value = "x".repeat(5 * 1024 * 1024)
    const projected = AgentSession.trace(
      new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "read",
        identity,
        result: new Cell.CallResult({ outcome: "success", value })
      })
    )

    expect(projected).toEqual({
      eventType: "control.agent.cell-call-settled",
      payload: {
        callId: AgentSession.callId(identity),
        flowName: "read",
        outcome: "success",
        message: undefined,
        value: {
          truncated: true,
          bytes: new TextEncoder().encode(value).byteLength,
          digest: Digest.digest(CanonicalJson.stringify(value))
        }
      }
    })

    const small = { content: "unchanged" }
    expect(
      AgentSession.trace(
        new AgentEvent.CellCallSettled({
          eventType: "flows.harness.cell-call-settled.v1",
          flowName: "read",
          identity,
          result: new Cell.CallResult({ outcome: "success", value: small })
        })
      )
    ).toEqual({
      eventType: "control.agent.cell-call-settled",
      payload: {
        callId: AgentSession.callId(identity),
        flowName: "read",
        outcome: "success",
        message: undefined,
        value: small
      }
    })
  })

  it("replaces an oversized call input with its byte count and full-value digest", () => {
    // The record that OPENS a call is as large as the one that settles it: a
    // `write` carries the whole file in its input, so bounding only the
    // result left the durable trail unbounded on the way in.
    const text = "y".repeat(5 * 1024 * 1024)
    const input = { path: "/notes/log.md", text }
    const projected = AgentSession.trace(
      new AgentEvent.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({ ...call, flowName: "write", input })
      })
    )

    expect(projected).toEqual({
      eventType: "control.agent.cell-call-started",
      payload: {
        callId: AgentSession.callId(identity),
        flowName: "write",
        input: {
          truncated: true,
          bytes: new TextEncoder().encode(CanonicalJson.stringify(input)).byteLength,
          digest: Digest.digest(CanonicalJson.stringify(input))
        }
      }
    })
  })

  it("replaces an oversized failure message with its byte count and full-value digest", () => {
    // A failure message is free text the handler chose, and a compiler or a
    // test runner writes megabytes of it into one failed call.
    const message = "error: no such field\n".repeat(200_000)
    const projected = AgentSession.trace(
      new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "test/run",
        identity,
        result: new Cell.CallResult({ outcome: "failure", value: null, message })
      })
    )

    expect(projected).toEqual({
      eventType: "control.agent.cell-call-settled",
      payload: {
        callId: AgentSession.callId(identity),
        flowName: "test/run",
        outcome: "failure",
        message: {
          truncated: true,
          bytes: new TextEncoder().encode(message).byteLength,
          digest: Digest.digest(CanonicalJson.stringify(message))
        },
        value: null
      }
    })
  })

  // The writer of these entries and the resume validator that reads them back
  // live in different packages. `trace` is typed against
  // `Transcript.ControlEventType`, so the namespace cannot be renamed on one
  // side alone: this pins the runtime half of that agreement.
  it("writes every journaled event under the namespace resume validation reads", () => {
    const events = [
      new AgentEvent.ModelRetried({
        eventType: "flows.harness.model-retried.v1",
        attempt: 1,
        code: "transport",
        delayMillis: 1
      }),
      new AgentEvent.TurnOpened({
        eventType: "flows.harness.turn-opened.v1",
        seat: "sdk:default",
        modelParams: ModelRequest.GenerationParams.make(),
        activeToolNames: [],
        contextDigest: "sha256:context"
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Continue({})
      })
    ]

    const projected = events.map((event) => AgentSession.trace(event)).filter((entry) => entry !== undefined)
    expect(projected).toHaveLength(events.length)
    for (const entry of projected) {
      expect(entry.eventType.startsWith(Transcript.controlEventPrefix)).toBe(true)
    }

    const entries = projected.map((entry, index) => ({
      seq: index + 1,
      eventType: entry.eventType,
      payload: { ...(entry.payload as Record<string, unknown>), journalVersion: Transcript.journalVersion }
    }))
    expect(Result.isSuccess(Transcript.validateJournal(entries as never))).toBe(true)
    // The same entries without the version stamp are exactly what resume must
    // refuse, which proves the filter selected them rather than skipping them.
    expect(Result.isFailure(
      Transcript.validateJournal(entries.map(({ payload: _payload, ...rest }) => ({ ...rest, payload: {} })) as never)
    )).toBe(true)
  })
})

/**
 * The migration half of the projection.
 *
 * `traceIdentity` hashes the payload, so giving an event type fields it did
 * not have changes what its identity derives to. A run journaled by the old
 * producer and resumed under the new one re-projects its whole recorded prefix
 * with the new fields, derives identities none of the recorded rows carry, and
 * `UNIQUE (run_id, source_id, source_seq)` admits every one of them: the prefix
 * is published a second time. `lateFields` is what keeps the old keys, and
 * these cases are the proof that it does — over the real projection, not over
 * the exclusion set's contents.
 */
describe("late payload fields", () => {
  const enriched = [
    new AgentEvent.CellRejectedInFrame({
      eventType: "flows.harness.cell-rejected-in-frame.v1",
      attempt: 2,
      code: "no_cell",
      message: "No cell was found in the response."
    }),
    new AgentEvent.ReadOnlyDemandIssued({
      eventType: "flows.harness.read-only-demand-issued.v1",
      streak: 12,
      cap: 12,
      nextFrame: 13
    }),
    new AgentEvent.NarrowOnlyDemanded({
      eventType: "flows.harness.narrow-only-demanded.v1",
      flow: "bash",
      check: "{\"command\":\"run one case of the check\"}",
      targets: ["src/one.ts"],
      currentDigest: "tree-after",
      nextFrame: 21
    }),
    new AgentEvent.SufficiencyObserved({
      eventType: "flows.harness.sufficiency-observed.v1",
      flow: "bash",
      failed: "{\"command\":\"run the whole check\"}",
      passed: "{\"command\":\"run the whole check\"}",
      epoch: 3,
      nextFrame: 9
    }),
    new AgentEvent.SteeringDrained({
      eventType: "flows.harness.steering-drained.v1",
      messages: [ModelRequest.Message.user("Fix the lockfile.")]
    })
  ] satisfies ReadonlyArray<AgentEvent.AgentEvent>

  /** The bytes the executor derives an identity from: the projection, JSON-normalized. */
  const material = (event: AgentEvent.AgentEvent) =>
    JSON.parse(JSON.stringify(AgentSession.trace(event)!.payload)) as Record<string, unknown>

  it("keeps a resumed old-producer prefix deduplicating across every enriched arm", () => {
    for (const event of enriched) {
      const projected = AgentSession.trace(event)!
      // The old producer wrote these five through the `default` arm: the same
      // event type, derived from `_tag`, with an empty payload. The enriched
      // arm must land on that same identity or the resumed prefix republishes.
      expect(projected.eventType).toBe(`control.agent.${event._tag}`)
      const populated = material(event)
      expect(Object.keys(populated).length).toBeGreaterThan(0)
      expect(AgentSession.traceIdentity(4, 2, cell.digest, projected.eventType, populated))
        .toBe(AgentSession.traceIdentity(4, 2, cell.digest, projected.eventType, {}))
    }
  })

  it("still separates an enriched event by where it sits", () => {
    // The exclusion is not a licence to drop the event from the sequence
    // space: two sufficiency observations at different coordinates remain two
    // identities, which is what admits the second one at all.
    const event = enriched[3]!
    const type = AgentSession.trace(event)!.eventType
    const payload = material(event)
    const base = AgentSession.traceIdentity(4, 2, cell.digest, type, payload)
    expect(AgentSession.traceIdentity(5, 2, cell.digest, type, payload)).not.toBe(base)
    expect(AgentSession.traceIdentity(4, 3, cell.digest, type, payload)).not.toBe(base)
    expect(AgentSession.traceIdentity(4, 2, "sha256:other", type, payload)).not.toBe(base)
  })

  it("keeps a pre-refused claim reading on the identity it was journaled under", () => {
    // `claim-demanded` is not one of the five: it always carried a payload,
    // and `refused` alone is late. So the whole payload still contributes and
    // only that one key is dropped, which is what lets a resumed run find its
    // recorded prefix and admit what comes after it.
    const type = "control.agent.claim-demanded"
    const before = { complete: 0.05, overclaims: 0.93, invented: 0.89, latencyMs: 380, demanded: false, nextFrame: 2 }
    const base = AgentSession.traceIdentity(4, 2, cell.digest, type, before)

    expect(AgentSession.traceIdentity(4, 2, cell.digest, type, { ...before, refused: false })).toBe(base)
    expect(AgentSession.traceIdentity(4, 2, cell.digest, type, { ...before, refused: true })).toBe(base)
    // Every other field still separates two readings, so the exclusion cannot
    // collapse a bounce and a refusal that differ in what Jev answered.
    expect(AgentSession.traceIdentity(4, 2, cell.digest, type, { ...before, invented: 0.9 })).not.toBe(base)
  })

  it("excludes only the fields the table names, and only for the type it names them under", () => {
    // A field the table does not list still contributes, so the mechanism
    // cannot quietly collapse two different events onto one key.
    const observed = "control.agent.sufficiency-observed"
    expect(AgentSession.traceIdentity(4, 2, cell.digest, observed, { epoch: 3, verdict: "a" }))
      .not.toBe(AgentSession.traceIdentity(4, 2, cell.digest, observed, { epoch: 3, verdict: "b" }))
    // `streak` and `cap` are late on the issuance and original on the answer.
    // The table is keyed by event type, so the answer keeps hashing them.
    const answered = (streak: number) =>
      AgentSession.traceIdentity(4, 2, cell.digest, "control.agent.read-only-demanded", {
        streak,
        cap: 12,
        nextFrame: 13,
        nextAction: "write"
      })
    expect(answered(12)).not.toBe(answered(11))
  })

  it("derives an identity for an event type that names an Object.prototype key", () => {
    // The event type is read off a decoded event, so it is host data. A plain
    // object literal resolves `lateFields["constructor"]` through the
    // prototype to a function — truthy, so `??` cannot catch it — and the
    // membership test then throws on a value that was never an entry.
    for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(() => AgentSession.traceIdentity(4, 2, cell.digest, type, { streak: 3 })).not.toThrow()
    }
    // Nothing is excluded for such a type, so its payload still separates it.
    expect(AgentSession.traceIdentity(4, 2, cell.digest, "constructor", { streak: 3 }))
      .not.toBe(AgentSession.traceIdentity(4, 2, cell.digest, "constructor", { streak: 4 }))
  })

  it("reads the prose out of whatever role the drain carried", () => {
    // A drain carries whatever the queue held, and the queue admits any
    // transcript message: a tool result keeps its prose in `content` rather
    // than in a text part, and an assistant turn carries a tool call between
    // its text parts that `cell-call-started` has already journaled on its own.
    expect(
      AgentSession.trace(
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [
            ModelRequest.Message.tool(
              ModelRequest.ToolResultPart.make({ toolCallId: "call-0", content: "exit 0" })
            ),
            assistant
          ],
          supervisor: [ModelRequest.Message.user("Recalled fact: run tox before marking the task complete.")]
        })
      )
    ).toEqual({
      eventType: "control.agent.steering-drained",
      payload: {
        messages: [
          { role: "tool", text: "exit 0" },
          { role: "assistant", text: "First line.\nSecond line." }
        ],
        supervisor: [{ role: "user", text: "Recalled fact: run tox before marking the task complete." }]
      }
    })
  })

  it("bounds one steering insert without erasing the steers around it", () => {
    // A steer is whatever an operator pasted, and the trail is a durable
    // journal row: one pasted file must not take the row, or the identity
    // hashing behind it, with it.
    const pasted = "z".repeat(5 * 1024 * 1024)
    expect(
      AgentSession.trace(
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [ModelRequest.Message.user(pasted), ModelRequest.Message.user("And keep the tests green.")]
        })
      )
    ).toEqual({
      eventType: "control.agent.steering-drained",
      payload: {
        messages: [
          {
            role: "user",
            text: {
              truncated: true,
              bytes: new TextEncoder().encode(pasted).byteLength,
              digest: Digest.digest(CanonicalJson.stringify(pasted))
            }
          },
          { role: "user", text: "And keep the tests green." }
        ]
      }
    })
  })
})

/*
 * The journal is redacted on its write path, by field name. A projected
 * payload that a reader must reconcile against another row therefore has to
 * survive that pass: a field the redactor replaces is a fact the journal
 * records and can never answer.
 */
describe("what survives the journal's own redaction", () => {
  it("keeps the call digest a vacuous-verification observation is reconciled by", () => {
    const projected = AgentSession.trace(
      new AgentEvent.VacuousVerificationObserved({
        eventType: "flows.harness.vacuous-verification-observed.v1",
        flow: "bash",
        check: "{\"command\":\"run the whole check\"}",
        callDigest: "e3b0c44298fc1c14",
        nextFrame: 15
      })
    )
    // The whole judgement is that THIS call had already been watched passing.
    // Redacted, the row says a call was, and names none.
    expect(projected).toBeDefined()
    expect(Redaction.make()(projected!.payload)).toEqual({
      flow: "bash",
      check: "{\"command\":\"run the whole check\"}",
      callDigest: "e3b0c44298fc1c14",
      nextFrame: 15
    })
  })

  it("still refuses a field named after a credential, so the narrowing is this field and not the rule", () => {
    expect(Redaction.isSensitiveKey("signature")).toBe(true)
    expect(Redaction.isSensitiveKey("callDigest")).toBe(false)
  })
})

/*
 * A prompt flow's declared input is part of its task, not an appendix.
 *
 * Production run `plan:28e015f8` launched a `{ args: string }` prompt flow
 * whose body said "append the exact line given in the appended arguments".
 * The launch input reached the model only as a trailing `Input:\n{ "args":
 * … }` block, the model appended the invented line `unknown-marker`, and the
 * run reported success. The rendering below is what makes that impossible to
 * misread, and the record is what makes an ignored argument detectable after
 * the fact instead of only in the diff of a file the run was asked to edit.
 */
describe("prompt-flow arguments", () => {
  it("gives every declared field its own heading, with the value verbatim", () => {
    const rendered = AgentSession.prompt("Append the exact line given in the arguments.", { args: "s16-marker" })
    expect(rendered.fields).toEqual(["args"])
    expect(rendered.arguments).toBe("## args\n\ns16-marker")
    // The body still opens the task, and the arguments follow under a heading
    // naming the field, so "the appended arguments" resolves to one value.
    expect(rendered.text.startsWith("Append the exact line given in the arguments.\n\n# Arguments\n")).toBe(true)
    expect(rendered.text.endsWith("## args\n\ns16-marker")).toBe(true)
    // Verbatim: no quoting, no JSON envelope, nothing for the model to strip.
    expect(rendered.text).not.toContain("\"args\"")
    expect(rendered.text).not.toContain("Input:")
  })

  it("names each field of a multi-field input in declaration order", () => {
    const rendered = AgentSession.prompt("Body.", { marker: "s16", count: 2, nested: { deep: true } })
    expect(rendered.fields).toEqual(["marker", "count", "nested"])
    expect(rendered.arguments).toBe(
      "## marker\n\ns16\n\n## count\n\n2\n\n## nested\n\n{\n  \"deep\": true\n}"
    )
  })

  it("renders a field whose value is absent as the JSON null it decodes back to", () => {
    // `decodedInput` is decoded JSON, so this cannot arrive from a launch; the
    // rendering still has to answer rather than print `undefined` at a model.
    expect(AgentSession.prompt("Body.", { args: undefined }).arguments).toBe("## args\n\nnull")
  })

  it("names a scalar or array input `input`, because it has no field to name", () => {
    expect(AgentSession.prompt("Body.", "s16-marker")).toMatchObject({
      fields: ["input"],
      arguments: "## input\n\ns16-marker"
    })
    expect(AgentSession.prompt("Body.", [1, 2])).toMatchObject({ fields: ["input"] })
  })

  it("leaves a flow that carries no input byte-identical, so its prompt cache still hits", () => {
    for (const empty of [undefined, null, {}]) {
      const rendered = AgentSession.prompt("  Body.  ", empty)
      expect(rendered.text).toBe("Body.")
      expect(rendered.fields).toEqual([])
      expect(rendered.arguments).toBe("")
    }
  })

  it("projects the rendered arguments onto a journal record an auditor can read back", () => {
    const rendered = AgentSession.prompt("Body.", { args: "s16-marker" })
    expect(AgentSession.promptRendered(rendered)).toEqual({
      eventType: "control.agent.prompt-rendered",
      payload: { fields: ["args"], arguments: "## args\n\ns16-marker" }
    })
  })

  it("bounds an argument the size of a file the way every other trail field is bounded", () => {
    const rendered = AgentSession.prompt("Body.", { args: "x".repeat(AgentSession.maxTracedBytes + 1) })
    const payload = AgentSession.promptRendered(rendered).payload as { readonly arguments: unknown }
    expect(payload.arguments).toMatchObject({ truncated: true })
  })
})

/*
 * The two records a reader reopens one step from.
 *
 * `model-settled` holds an answer and `claim-demanded` holds three numbers,
 * and until these two records nothing in the trail held what either was an
 * answer TO. The projection is what bounds them and what keeps them readable
 * through the journal's own redaction, so both are pinned here rather than in
 * the harness, which carries the request whole.
 */
describe("the request and the decision behind a step", () => {
  const request = (overrides: Partial<ConstructorParameters<typeof ModelRequest.ModelRequest>[0]> = {}) =>
    ModelRequest.ModelRequest.make({
      modelId: "test-model",
      system: [ModelRequest.SystemPart.make({ text: "cell contract" }), ModelRequest.SystemPart.make({ text: "task" })],
      messages: [
        ModelRequest.Message.user("start"),
        ModelRequest.Message.assistant("```cell\nctx.done(1)\n```", { stopReason: "stop" })
      ],
      tools: [],
      toolChoice: "none",
      params: ModelRequest.GenerationParams.make({ maxTokens: 2048, temperature: 0.2, reasoningEffort: "high" }),
      ...overrides
    })
  const requested = (overrides: Partial<ConstructorParameters<typeof AgentEvent.ModelRequested>[0]> = {}) =>
    new AgentEvent.ModelRequested({
      eventType: "flows.harness.model-requested.v1",
      scope: "run-1/step@abc:1#0",
      frame: 3,
      attempt: 2,
      purpose: "frame",
      seat: "anthropic:test-model",
      binding: new EngineLike.Binding({ routeId: "anthropic-direct", protocolId: "anthropic-messages" }),
      request: request(),
      ...overrides
    })

  const digestOf = (value: unknown): string => Digest.digest(CanonicalJson.stringify(value))

  it("projects everything a composer rebuilds the call from, under the keys that join it to its turn", () => {
    const messages = [{ role: "user", text: "start" }, { role: "assistant", text: "```cell\nctx.done(1)\n```" }]
    const params = { maxOutput: 2048, temperature: 0.2, reasoningEffort: "high" }
    expect(AgentSession.trace(requested())).toEqual({
      eventType: "control.agent.model-requested",
      payload: {
        scope: "run-1/step@abc:1#0",
        frame: 3,
        attempt: 2,
        purpose: "frame",
        seat: "anthropic:test-model",
        modelId: "test-model",
        routeId: "anthropic-direct",
        protocolId: "anthropic-messages",
        system: ["cell contract", "task"],
        systemDigest: digestOf(["cell contract", "task"]),
        messages,
        messagesDigest: digestOf(messages),
        prefixCount: 0,
        params,
        paramsDigest: digestOf(params),
        toolCount: 0
      }
    })
  })

  it("names no route where the host resolved none", () => {
    const payload = AgentSession.trace(requested({ binding: undefined }))!.payload as Record<string, unknown>
    expect(Object.hasOwn(payload, "routeId")).toBe(false)
    expect(Object.hasOwn(payload, "protocolId")).toBe(false)
  })

  it("marks an oversized message truncated, leaves its text out, and keeps the messages beside it", () => {
    const huge = "x".repeat(AgentSession.maxTracedBytes + 1)
    const messages = [ModelRequest.Message.user("start"), ModelRequest.Message.user(huge)]
    const oversized = AgentSession.trace(requested({ request: request({ messages }) }))!
    const payload = oversized.payload as Record<string, unknown>

    // A reader says "unavailable" off one flag, and finds no text to prefill a
    // partial request from: the message holds its size and digest, never a
    // prefix. The bound is per message, so the one that fits is still read.
    expect(payload.truncated).toBe(true)
    const projected = { role: "user", text: huge }
    const journaled = [{ role: "user", text: "start" }, {
      truncated: true,
      bytes: new TextEncoder().encode(CanonicalJson.stringify(projected)).byteLength,
      digest: digestOf(projected)
    }]
    expect(payload.messages).toEqual(journaled)
    expect(payload.messagesDigest).toBe(digestOf(journaled))
    expect(JSON.stringify(payload)).not.toContain("xxxx")
    // What fits is still there, so the record says what was truncated and not
    // only that something was.
    expect(payload.system).toEqual(["cell contract", "task"])
    // A request that fits carries no flag at all.
    expect(Object.hasOwn(AgentSession.trace(requested())!.payload as object, "truncated")).toBe(false)
  })

  it("gives a field's digest as its marker's digest when the field is left out", () => {
    const system = [ModelRequest.SystemPart.make({ text: "s".repeat(AgentSession.maxTracedBytes + 1) })]
    const payload = AgentSession.trace(requested({ request: request({ system }) }))!.payload as Record<string, unknown>
    expect(payload.truncated).toBe(true)
    expect(payload.system).toEqual({
      truncated: true,
      bytes: expect.any(Number),
      digest: payload.systemDigest
    })
    expect(payload.systemDigest).toBe(digestOf(system.map((part) => part.text)))
  })

  it("keeps the whole record inside the step-fact payload bound, however many messages one call adds", () => {
    // Three bounded fields and a handful of names stay inside the
    // 262,144-byte step-fact payload, so the durable sink never replaces the
    // record, and with it the join keys, by a bare marker. The messages share
    // one field's bound between them: past it a message is a marker, and a
    // field of nothing but markers that still overflows is one marker.
    const system = [ModelRequest.SystemPart.make({ text: "s".repeat(AgentSession.maxTracedBytes - 16) })]
    const bytesOf = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload)).byteLength
    const many = Array.from(
      { length: 40 },
      (_, index) => ModelRequest.Message.user(`${index}:${"\u0000".repeat(4_000)}`)
    )
    const crowded = AgentSession.trace(requested({ request: request({ system, messages: many }) }))!
      .payload as Record<string, unknown>
    expect(bytesOf(crowded)).toBeLessThan(262_144)
    expect(crowded.truncated).toBe(true)
    expect((crowded.messages as ReadonlyArray<unknown>).length).toBe(40)

    const flood = Array.from({ length: 2_000 }, (_, index) => ModelRequest.Message.user(`${index}:${"y".repeat(100)}`))
    const flooded = AgentSession.trace(requested({ request: request({ system, messages: flood }) }))!
      .payload as Record<string, unknown>
    expect(bytesOf(flooded)).toBeLessThan(262_144)
    expect(flooded.messages).toEqual({ truncated: true, bytes: expect.any(Number), digest: flooded.messagesDigest })
  })

  describe("what one call adds to the call before it", () => {
    const message = (index: number, bytes = 16) => ModelRequest.Message.user(`${index}:${"m".repeat(bytes)}`)
    const calls = (transcripts: ReadonlyArray<ReadonlyArray<ModelRequest.Message>>) => {
      const project = AgentSession.tracer()
      return transcripts.map((messages, frame) =>
        JSON.parse(JSON.stringify(
          project(requested({ frame, attempt: 1, request: request({ messages }) }))!.payload
        )) as Record<string, unknown>
      )
    }
    /** The reader's walk, as `docs/api.md` states it. */
    const rebuilt = (rows: ReadonlyArray<Record<string, unknown>>) => {
      let transcript: ReadonlyArray<unknown> = []
      let system: unknown
      for (const row of rows) {
        if (row.truncated === true) return undefined
        const prefix = transcript.slice(0, row.prefixCount as number)
        if (prefix.length !== row.prefixCount) return undefined
        if (prefix.length > 0 && digestOf(prefix.map(digestOf)) !== row.prefixDigest) return undefined
        if (digestOf(row.messages) !== row.messagesDigest) return undefined
        transcript = [...prefix, ...(row.messages as ReadonlyArray<unknown>)]
        if (Object.hasOwn(row, "system")) system = row.system
        if (digestOf(system) !== row.systemDigest) return undefined
      }
      return { system, messages: transcript }
    }

    it("writes the system text once and the transcript's new messages only, so the trail grows linearly", () => {
      const teaching = "t".repeat(20_000)
      const system = [ModelRequest.SystemPart.make({ text: teaching })]
      // 200 KiB of transcript across four calls, each adding 50 KiB.
      const transcript = Array.from({ length: 40 }, (_, index) => message(index, 5_120))
      const project = AgentSession.tracer()
      const rows = [10, 20, 30, 40].map((upto, frame) =>
        JSON.parse(JSON.stringify(
          project(requested({ frame, attempt: 1, request: request({ system, messages: transcript.slice(0, upto) }) }))!
            .payload
        )) as Record<string, unknown>
      )

      expect(rows.map((row) => row.prefixCount)).toEqual([0, 10, 20, 30])
      expect(rows.map((row) => (row.messages as ReadonlyArray<unknown>).length)).toEqual([10, 10, 10, 10])
      expect(rows.map((row) => Object.hasOwn(row, "system"))).toEqual([true, false, false, false])
      expect(new Set(rows.map((row) => row.systemDigest)).size).toBe(1)
      expect(rows.some((row) => Object.hasOwn(row, "truncated"))).toBe(false)
      // One transcript, one system text, and a constant per record.
      const spoken = transcript.map((entry) => ({ role: "user", text: (entry.content[0] as { text: string }).text }))
      const journaled = new TextEncoder().encode(JSON.stringify(rows)).byteLength
      const once = new TextEncoder().encode(JSON.stringify(spoken) + teaching).byteLength
      expect(journaled).toBeLessThan(once + rows.length * 1_024)
      // And the last call is still the call that was made.
      expect(rebuilt(rows)).toEqual({ system: [teaching], messages: spoken })
    })

    it("keeps what the two calls share where the transcript was rewritten, and says how much that is", () => {
      const [first, reasked, next, compacted] = calls([
        [message(0), message(1)],
        // An in-frame re-ask extends the call it follows.
        [message(0), message(1), message(2), message(3)],
        // The next frame dropped the refusal: two shared, one new.
        [message(0), message(1), message(4)],
        // A compaction shares nothing with what it replaced.
        [message(9), message(4)]
      ])
      expect([first, reasked, next, compacted].map((row) => row!.prefixCount)).toEqual([0, 2, 2, 0])
      expect(Object.hasOwn(first!, "prefixDigest")).toBe(false)
      expect(Object.hasOwn(compacted!, "prefixDigest")).toBe(false)
      expect(reasked!.prefixDigest).toBe(
        digestOf(
          [{ role: "user", text: `0:${"m".repeat(16)}` }, { role: "user", text: `1:${"m".repeat(16)}` }].map(digestOf)
        )
      )
      expect(rebuilt([first!, reasked!, next!])?.messages).toHaveLength(3)
      expect(rebuilt([first!, reasked!, next!, compacted!])?.messages).toHaveLength(2)
    })

    it("writes the system text again when it changes, and folds each scope and purpose on its own", () => {
      const project = AgentSession.tracer()
      const row = (overrides: Parameters<typeof requested>[0]) =>
        project(requested(overrides))!.payload as Record<string, unknown>
      const messages = [message(0)]
      const rewritten = request({ messages, system: [ModelRequest.SystemPart.make({ text: "another contract" })] })
      expect(Object.hasOwn(row({ request: request({ messages }) }), "system")).toBe(true)
      expect(Object.hasOwn(row({ request: request({ messages }) }), "system")).toBe(false)
      expect(row({ request: rewritten }).system).toEqual(["another contract"])
      // A compaction call and another step's call start from nothing.
      expect(row({ purpose: "compaction", request: rewritten })).toMatchObject({
        system: ["another contract"],
        prefixCount: 0
      })
      expect(row({ scope: "run-1/other", request: rewritten })).toMatchObject({
        system: ["another contract"],
        prefixCount: 0
      })
    })

    it("reports the walk unavailable through a record that was truncated", () => {
      const rows = calls([
        [message(0, AgentSession.maxTracedBytes)],
        [message(0, AgentSession.maxTracedBytes), message(1)]
      ])
      expect(rows[0]!.truncated).toBe(true)
      // The second call is whole and small, and still cannot be rebuilt: the
      // message it builds on was never written.
      expect(Object.hasOwn(rows[1]!, "truncated")).toBe(false)
      expect(rows[1]!.prefixCount).toBe(1)
      expect(rebuilt(rows)).toBeUndefined()
    })

    it("regenerates the same records and the same identities on a replayed incarnation", () => {
      const transcripts = [[message(0)], [message(0), message(1)], [message(0), message(1), message(2)]]
      const identities = (rows: ReadonlyArray<Record<string, unknown>>) =>
        rows.map((row, frame) => AgentSession.traceIdentity(frame, 0, "", "control.agent.model-requested", row))
      const original = calls(transcripts)
      const replayed = calls(transcripts)
      expect(replayed).toEqual(original)
      expect(identities(replayed)).toEqual(identities(original))
      expect(new Set(identities(original)).size).toBe(3)
    })
  })

  describe("what survives the journal's own redaction", () => {
    it("survives with every field a composer needs", () => {
      const projected = AgentSession.trace(requested())!.payload
      // `maxTokens` is a credential by the journal's naming rule, and a row that
      // read `"maxTokens": "[REDACTED]"` would prefill a composer with a lie. The
      // projection names the same number `maxOutput`; `scope` and not `session`
      // for the same reason.
      expect(Redaction.isSensitiveKey("maxTokens")).toBe(true)
      expect(Redaction.isSensitiveKey("session")).toBe(true)
      expect(Redaction.make()(projected)).toEqual(projected)
    })

    it("lets a reader tell a request the journal rewrote from the one that was sent", () => {
      // The journal's textual rules read `apiKey: abc` and `maxTokens: 4096`
      // as credentials wherever they occur, and a coding transcript is full of
      // both. The row carries no mark of its own, so each rebuildable field
      // travels with the digest of what it was before the journal saw it.
      const spoken = request({
        system: [ModelRequest.SystemPart.make({ text: "Use maxTokens: 4096 for the summary." })],
        messages: [ModelRequest.Message.user("set apiKey: abc and rerun")]
      })
      const projected = JSON.parse(JSON.stringify(AgentSession.trace(requested({ request: spoken }))!.payload))
      const journaled = Redaction.make()(projected) as Record<string, unknown>

      expect(journaled.messages).not.toEqual(projected.messages)
      expect(journaled.system).not.toEqual(projected.system)
      expect(Object.hasOwn(journaled, "truncated")).toBe(false)
      // The digests come through untouched, and each disagrees with what is
      // now beside it: redacted, not re-askable.
      expect(journaled.messagesDigest).toBe(projected.messagesDigest)
      expect(digestOf(journaled.messages)).not.toBe(journaled.messagesDigest)
      expect(digestOf(journaled.system)).not.toBe(journaled.systemDigest)
      // A field the journal left alone still agrees.
      expect(digestOf(journaled.params)).toBe(journaled.paramsDigest)
      // And every field of a request it left alone agrees, read back as JSON.
      const clean = Redaction.make()(
        JSON.parse(JSON.stringify(AgentSession.trace(requested())!.payload))
      ) as Record<string, unknown>
      for (const field of ["system", "messages", "params"]) {
        expect(digestOf(clean[field])).toBe(clean[`${field}Digest`])
      }
    })
  })

  it("derives one identity for a replayed request and another for the next call of the frame", () => {
    const identity = (event: AgentEvent.ModelRequested) => {
      const projected = AgentSession.trace(event)!
      return AgentSession.traceIdentity(
        3,
        0,
        "",
        projected.eventType,
        JSON.parse(JSON.stringify(projected.payload)) as Record<string, unknown>
      )
    }
    expect(identity(requested())).toBe(identity(requested()))
    expect(identity(requested({ attempt: 3 }))).not.toBe(identity(requested()))
    expect(identity(requested({ purpose: "compaction" }))).not.toBe(identity(requested()))
  })

  const decided = (overrides: Partial<ConstructorParameters<typeof AgentEvent.DecisionSettled>[0]> = {}) =>
    new AgentEvent.DecisionSettled({
      eventType: "flows.harness.decision-settled.v1",
      scope: "run-1",
      frame: 4,
      classifier: "completion/claim",
      digest: "classifier-digest",
      state: { task: "Say hello.", claim: "hello" },
      questions: {
        invented: Evaluator.BooleanQuestion.of({ instructions: "Invented?", criteria: { true: "yes", false: "no" } })
      },
      answers: { invented: { kind: "boolean", p: 0.02 } },
      latencyMs: 412,
      acted: false,
      decidedBy: "jev",
      ...overrides
    })

  it("projects a decision with its state, its wire questions and its answers", () => {
    const questions = [{
      id: "invented",
      type: "boolean",
      instructions: "Invented?",
      criteria: { true: "yes", false: "no" }
    }]
    const answers = [{ id: "invented", kind: "boolean", p: 0.02 }]
    expect(AgentSession.trace(decided())).toEqual({
      eventType: "control.agent.decision-settled",
      payload: {
        scope: "run-1",
        frame: 4,
        classifier: "completion/claim",
        digest: "classifier-digest",
        state: { task: "Say hello.", claim: "hello" },
        stateDigest: digestOf({ task: "Say hello.", claim: "hello" }),
        questions,
        questionsDigest: digestOf(questions),
        answers,
        answersDigest: digestOf(answers),
        latencyMs: 412,
        acted: false,
        decidedBy: "jev"
      }
    })
  })

  it("marks an oversized state truncated and leaves it out", () => {
    const state = { task: "t".repeat(AgentSession.maxTracedBytes + 1) }
    const payload = AgentSession.trace(decided({ state }))!.payload as Record<string, unknown>
    expect(payload.truncated).toBe(true)
    expect(payload.state).toEqual({
      truncated: true,
      bytes: new TextEncoder().encode(CanonicalJson.stringify(state)).byteLength,
      digest: Digest.digest(CanonicalJson.stringify(state))
    })
    expect(payload.stateDigest).toBe(digestOf(state))
    expect(payload.answers).toEqual([{ id: "invented", kind: "boolean", p: 0.02 }])
  })

  it("writes names a caller chose as values, so the journal redacts none of them by name", () => {
    // A question id and an option are the caller's words, and the journal
    // replaces whatever sits under a key it reads as a credential name.
    // `maxTokens` was renamed for this; a caller's names cannot be, so they
    // are never keys.
    expect(Redaction.isSensitiveKey("auth")).toBe(true)
    expect(Redaction.isSensitiveKey("needsAuth")).toBe(true)
    const routed = decided({
      questions: {
        needsAuth: Evaluator.BooleanQuestion.of({ instructions: "Does it need a sign-in?" }),
        route: Evaluator.ChoiceQuestion.of({
          instructions: "Which desk?",
          criteria: { auth: "sign-in trouble", billing: "an invoice", session: "a dropped connection" }
        })
      },
      answers: {
        needsAuth: { kind: "boolean", p: 0.5 },
        route: {
          kind: "choice",
          value: "auth",
          probabilities: { auth: 0.8, billing: 0.1, session: 0.1 },
          confidence: 0.7
        }
      }
    })
    const payload = JSON.parse(JSON.stringify(AgentSession.trace(routed)!.payload)) as Record<string, unknown>
    expect(payload.questions).toEqual([
      { id: "needsAuth", type: "boolean", instructions: "Does it need a sign-in?" },
      {
        id: "route",
        type: "choice",
        instructions: "Which desk?",
        criteria: [
          { option: "auth", description: "sign-in trouble" },
          { option: "billing", description: "an invoice" },
          { option: "session", description: "a dropped connection" }
        ]
      }
    ])
    const journaled = Redaction.make()(payload) as typeof payload
    expect(journaled).toEqual(payload)
    const route = (journaled.answers as ReadonlyArray<Record<string, unknown>>).find((answer) => answer.id === "route")
    expect(route).toEqual({
      id: "route",
      kind: "choice",
      value: "auth",
      probabilities: [{ option: "auth", p: 0.8 }, { option: "billing", p: 0.1 }, { option: "session", p: 0.1 }],
      confidence: 0.7
    })
  })

  it("lets a reader tell a decision's state the journal rewrote from the one that was judged", () => {
    const evidence = { task: "Say hello.", claim: "hello", output: "secret = hunter2" }
    const projected = JSON.parse(JSON.stringify(AgentSession.trace(decided({ state: evidence }))!.payload))
    const journaled = Redaction.make()(projected) as Record<string, unknown>
    expect(journaled.state).not.toEqual(evidence)
    expect(Object.hasOwn(journaled, "truncated")).toBe(false)
    expect(digestOf(journaled.state)).not.toBe(journaled.stateDigest)
    expect(journaled.stateDigest).toBe(digestOf(evidence))
    expect(digestOf(journaled.questions)).toBe(journaled.questionsDigest)
    expect(digestOf(journaled.answers)).toBe(journaled.answersDigest)
  })
})

describe("Jev receipts", () => {
  const item = { kind: "flow", id: "auth", digest: "item-digest", p: 0.95 } as const
  const receipts = [
    [
      new AgentEvent.DecisionUnjudged({
        eventType: "flows.harness.decision-unjudged.v1",
        scope: "run-1",
        frame: 0,
        classifier: "relevance/unnecessary",
        reason: "timeout",
        detail: "The gateway did not answer",
        items: 3
      }),
      {
        eventType: "control.agent.decision-unjudged",
        payload: {
          scope: "run-1",
          frame: 0,
          classifier: "relevance/unnecessary",
          reason: "timeout",
          detail: "The gateway did not answer",
          items: 3
        }
      }
    ],
    [
      new AgentEvent.RelevanceSettled({
        eventType: "flows.harness.relevance-settled.v1",
        scope: "run-1",
        frame: 0,
        source: "run",
        withholdAt: 0.9,
        kept: [{ ...item, id: "session", p: 0.1 }],
        withheld: [item],
        latencyMs: 80,
        usage: { inputTokens: 200, outputTokens: 2 }
      }),
      {
        eventType: "control.agent.relevance-settled",
        payload: {
          scope: "run-1",
          frame: 0,
          source: "run",
          withholdAt: 0.9,
          kept: [{ ...item, id: "session", p: 0.1 }],
          withheld: [item],
          latencyMs: 80,
          usage: { inputTokens: 200, outputTokens: 2 }
        }
      }
    ],
    [
      new AgentEvent.RelevanceSettled({
        eventType: "flows.harness.relevance-settled.v1",
        scope: "run-1",
        frame: 2,
        source: "supervisor",
        withholdAt: 0.9,
        kept: [],
        withheld: [],
        latencyMs: 0
      }),
      {
        eventType: "control.agent.relevance-settled",
        payload: {
          scope: "run-1",
          frame: 2,
          source: "supervisor",
          withholdAt: 0.9,
          kept: [],
          withheld: [],
          latencyMs: 0
        }
      }
    ],
    [
      new AgentEvent.RelevanceRestored({
        eventType: "flows.harness.relevance-restored.v1",
        scope: "run-1",
        frame: 4,
        flow: "auth"
      }),
      { eventType: "control.agent.relevance-restored", payload: { scope: "run-1", frame: 4, flow: "auth" } }
    ],
    [
      new AgentEvent.SeatRouted({
        eventType: "flows.harness.seat-routed.v1",
        scope: "run-1",
        declared: "auto",
        seat: "auth",
        modelId: "model-a",
        variant: "terse",
        candidates: ["auth", "session"],
        decidedBy: "jev",
        latencyMs: 60,
        backups: ["session"]
      }),
      {
        eventType: "control.agent.seat-routed",
        payload: {
          scope: "run-1",
          declared: "auto",
          seat: "auth",
          modelId: "model-a",
          variant: "terse",
          candidates: ["auth", "session"],
          decidedBy: "jev",
          latencyMs: 60,
          backups: ["session"]
        }
      }
    ],
    [
      // A panel route: every member with its own failover, and the merger.
      new AgentEvent.SeatRouted({
        eventType: "flows.harness.seat-routed.v1",
        scope: "run-1",
        declared: "auto",
        seat: "fable",
        modelId: "model-c",
        variant: "review",
        candidates: ["opus", "fable", "astra"],
        decidedBy: "jev",
        latencyMs: 75,
        backups: ["astra"],
        panel: {
          seats: [{ seat: "opus", backups: ["astra"] }, { seat: "fable", backups: [] }],
          merger: "fable"
        }
      }),
      {
        eventType: "control.agent.seat-routed",
        payload: {
          scope: "run-1",
          declared: "auto",
          seat: "fable",
          modelId: "model-c",
          variant: "review",
          candidates: ["opus", "fable", "astra"],
          decidedBy: "jev",
          latencyMs: 75,
          backups: ["astra"],
          panel: {
            seats: [{ seat: "opus", backups: ["astra"] }, { seat: "fable", backups: [] }],
            merger: "fable"
          }
        }
      }
    ],
    [
      new AgentEvent.SeatRouted({
        eventType: "flows.harness.seat-routed.v1",
        scope: "run-1",
        declared: "auto",
        seat: "only",
        modelId: "model-b",
        variant: null,
        candidates: ["only"],
        decidedBy: "only",
        latencyMs: 0
      }),
      {
        eventType: "control.agent.seat-routed",
        payload: {
          scope: "run-1",
          declared: "auto",
          seat: "only",
          modelId: "model-b",
          variant: null,
          candidates: ["only"],
          decidedBy: "only",
          latencyMs: 0
        }
      }
    ]
  ] as const

  it.each(receipts)("projects %s with every name as a value", (event, expected) => {
    const projected = AgentSession.trace(event)
    expect(projected).toEqual(expected)
    // `auth` is a name the journal redacts under as a key; as a value it survives.
    const payload = JSON.parse(JSON.stringify(projected!.payload)) as Record<string, unknown>
    expect(Redaction.make()(payload)).toEqual(payload)
  })

  it("takes no ordinal for any Jev receipt", () => {
    for (const [event] of receipts) {
      expect(unordered.has(AgentSession.trace(event)!.eventType)).toBe(true)
    }
  })

  it("projects the Jev fields of the events that gained them", () => {
    const monitor = {
      id: "mood/frustrated",
      kind: "mood",
      at: 0.8,
      consecutive: 2,
      cooldownFrames: 5,
      limit: 3
    } as const
    expect(
      AgentSession.trace(
        new AgentEvent.DisciplineArmed({
          eventType: "flows.harness.discipline-armed.v1",
          readOnlyCap: 1,
          maxFrames: 2,
          approvalChannel: false,
          modelCallMs: 0,
          repeatCap: 0,
          narrowingCap: 0,
          unmovedCap: 0,
          unresolvedCap: 0,
          judged: true,
          relevance: { withholdAt: 0.9, pinned: ["jev"] },
          monitors: [monitor],
          stance: "careful"
        })
      )!.payload
    ).toMatchObject({
      judged: true,
      relevance: { withholdAt: 0.9, pinned: ["jev"] },
      monitors: [monitor],
      stance: "careful"
    })

    const reading = AgentSession.trace(
      new AgentEvent.SupervisorSettled({
        eventType: "flows.harness.supervisor-settled.v1",
        scope: "run-1",
        frame: 2,
        thrashing: 0,
        onTarget: 1,
        suspect: 0,
        frustrated: "none",
        anxious: "none",
        scared: "none",
        confused: "none",
        confident: "strong",
        needsHelp: "none",
        crossed: false,
        nudged: false,
        latencyMs: 5,
        monitors: [{ id: "mood/frustrated", kind: "mood", p: 0.2, crossed: false }]
      })
    )!.payload as Record<string, unknown>
    expect(Object.hasOwn(reading, "inserted")).toBe(false)
    expect(reading.monitors).toEqual([{ id: "mood/frustrated", kind: "mood", p: 0.2, crossed: false }])

    expect(
      AgentSession.trace(
        new AgentEvent.CompactionSettled({
          eventType: "flows.harness.compaction-settled.v1",
          replacedPrefixDigest: "prefix",
          retainedMessageCount: 1,
          kept: [ModelRequest.Message.user("kept")],
          marks: [
            { digest: "a", mark: "keep" },
            { digest: "b", mark: "squash" },
            { digest: "c", mark: "remove" },
            { digest: "d", mark: "remove" }
          ],
          removedTokens: 900
        })
      )
    ).toEqual({
      eventType: "control.agent.compaction-settled",
      payload: { replacedPrefixDigest: "prefix", marks: { kept: 1, squashed: 1, removed: 2 }, removedTokens: 900 }
    })
    expect(
      AgentSession.trace(
        new AgentEvent.CompactionSettled({
          eventType: "flows.harness.compaction-settled.v1",
          replacedPrefixDigest: "prefix",
          unaligned: true
        })
      )
    ).toEqual({
      eventType: "control.agent.compaction-settled",
      payload: { replacedPrefixDigest: "prefix", unaligned: true }
    })

    expect(
      AgentSession.trace(
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [],
          supervisor: [ModelRequest.Message.user("Slow down.")],
          monitor: "mood/frustrated",
          suppressed: [{ id: "lint/any", reason: "cooldown" }],
          memory: ["row-1"]
        })
      )!.payload
    ).toEqual({
      messages: [],
      supervisor: [{ role: "user", text: "Slow down." }],
      monitor: "mood/frustrated",
      suppressed: [{ id: "lint/any", reason: "cooldown" }],
      memory: ["row-1"]
    })
  })

  it("keeps a pre-Jev record on the identity it was journaled under", () => {
    const armed = {
      eventType: "flows.harness.discipline-armed.v1",
      readOnlyCap: 1,
      maxFrames: 2,
      approvalChannel: false,
      modelCallMs: 0,
      repeatCap: 0,
      narrowingCap: 0,
      unmovedCap: 0,
      unresolvedCap: 0
    } as const
    const decision = {
      eventType: "flows.harness.decision-settled.v1",
      scope: "run-1",
      frame: 4,
      classifier: "completion/claim",
      digest: "classifier-digest",
      state: { claim: "done" },
      questions: { done: Evaluator.BooleanQuestion.of({ instructions: "Done?" }) },
      answers: { done: { kind: "boolean", p: 0.9 } },
      latencyMs: 12,
      acted: false,
      decidedBy: "jev"
    } as const
    const reading = {
      eventType: "flows.harness.supervisor-settled.v1",
      scope: "run-1",
      frame: 2,
      thrashing: 0,
      onTarget: 1,
      suspect: 0,
      frustrated: "none",
      anxious: "none",
      scared: "none",
      confused: "none",
      confident: "strong",
      needsHelp: "none",
      crossed: false,
      nudged: false,
      latencyMs: 5
    } as const
    const pairs: ReadonlyArray<readonly [AgentEvent.AgentEvent, AgentEvent.AgentEvent]> = [
      [
        new AgentEvent.DisciplineArmed(armed),
        new AgentEvent.DisciplineArmed({
          ...armed,
          judged: true,
          relevance: { withholdAt: 0.9, pinned: [] },
          monitors: [],
          stance: "paranoid"
        })
      ],
      [
        new AgentEvent.DecisionSettled(decision),
        new AgentEvent.DecisionSettled({ ...decision, usage: { inputTokens: 1, outputTokens: 1 } })
      ],
      [
        new AgentEvent.CompactionSettled({
          eventType: "flows.harness.compaction-settled.v1",
          replacedPrefixDigest: "prefix",
          summary: ModelRequest.Message.user("summary")
        }),
        new AgentEvent.CompactionSettled({
          eventType: "flows.harness.compaction-settled.v1",
          replacedPrefixDigest: "prefix",
          marks: [{ digest: "a", mark: "remove" }],
          removedTokens: 10
        })
      ],
      [
        new AgentEvent.SupervisorSettled(reading),
        new AgentEvent.SupervisorSettled({ ...reading, monitors: [{ id: "m", kind: "lint", p: 1, crossed: true }] })
      ],
      [
        new AgentEvent.SteeringDrained({ eventType: "flows.harness.steering-drained.v1", messages: [] }),
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [],
          monitor: "mood/anxious",
          suppressed: [],
          memory: []
        })
      ]
    ]
    const identity = (event: AgentEvent.AgentEvent) => {
      const projected = AgentSession.trace(event)!
      return AgentSession.traceIdentity(
        1,
        0,
        cell.digest,
        projected.eventType,
        JSON.parse(JSON.stringify(projected.payload)) as Record<string, unknown>
      )
    }
    for (const [before, after] of pairs) {
      expect(identity(after)).toBe(identity(before))
    }
  })
})
