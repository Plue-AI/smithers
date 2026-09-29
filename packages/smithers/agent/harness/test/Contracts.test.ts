import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Cause, Effect, Exit, Option, Schema, Stream } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as Cell from "../src/Cell.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError, HarnessErrorCode } from "../src/HarnessError.ts"
import * as Plan from "../src/Plan.ts"

const assistantMessage = ModelRequest.Message.assistant("done", { stopReason: "stop" })
const cellSource = Cell.source("return { intent: \"complete\", state: null, output: \"done\" }")
const callIdentity = new Cell.CallIdentity({
  session: "session-1",
  frame: 3,
  cell: cellSource.digest,
  ordinal: 0,
  declaration: "declaration-digest",
  layers: ["composition-1"]
})
const flowCall = new Cell.Call({
  flowName: "fs/list",
  input: { path: "." },
  capabilities: ["fs:read:."],
  effects: { reads: ["."], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  placement: Option.some("local"),
  identity: callIdentity
})
const child = new Plan.Child({
  flowName: "read-pr",
  callId: "call-1",
  args: { number: 42 },
  capabilities: ["fs:read:/workspace/**"],
  effects: {
    reads: ["/workspace/**"],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  },
  placement: Option.some("local")
})
const batch = new Plan.Batch({ children: [child] })
const permissionRequest = new Permission.PermissionRequired({
  requestId: "permission-1",
  capability: new Capability.Capability({
    action: "fs:read",
    resource: "/workspace"
  }),
  tier: "sealed",
  meta: {}
})

const relevanceItem = { kind: "flow", id: "deploy", digest: "item-digest", p: 0.95 } as const

// One of each event a Jev reading writes, every optional field present.
const jevEvents: ReadonlyArray<AgentEvent.AgentEvent> = [
  new AgentEvent.DecisionUnjudged({
    eventType: "flows.harness.decision-unjudged.v1",
    scope: "session-1",
    frame: 2,
    classifier: "relevance/unnecessary",
    reason: "unconfigured",
    detail: "No evaluator is bound",
    items: 5
  }),
  new AgentEvent.RelevanceSettled({
    eventType: "flows.harness.relevance-settled.v1",
    scope: "session-1",
    frame: 0,
    source: "run",
    withholdAt: 0.9,
    kept: [{ ...relevanceItem, kind: "instruction", id: "agents-md/3", p: 0.2 }],
    withheld: [relevanceItem],
    latencyMs: 90,
    usage: { inputTokens: 300, outputTokens: 4 }
  }),
  new AgentEvent.RelevanceRestored({
    eventType: "flows.harness.relevance-restored.v1",
    scope: "session-1",
    frame: 4,
    flow: "deploy"
  }),
  new AgentEvent.SeatRouted({
    eventType: "flows.harness.seat-routed.v1",
    scope: "session-1",
    declared: "auto",
    seat: "fast",
    modelId: "model-a",
    variant: null,
    candidates: ["fast", "deep"],
    decidedBy: "jev",
    confidence: 0.8,
    latencyMs: 70
  }),
  new AgentEvent.SeatRouted({
    eventType: "flows.harness.seat-routed.v1",
    scope: "session-1",
    declared: "auto",
    seat: "fable",
    modelId: "model-f",
    variant: "review",
    candidates: ["opus", "fable", "astra", "sol"],
    decidedBy: "jev",
    latencyMs: 90,
    backups: ["astra"],
    panel: {
      seats: [{ seat: "opus", backups: ["sol"] }, { seat: "fable", backups: ["astra"] }, { seat: "astra", backups: [] }],
      merger: "fable"
    }
  }),
  new AgentEvent.CompactionSettled({
    eventType: "flows.harness.compaction-settled.v1",
    replacedPrefixDigest: "prefix-digest",
    retainedMessageCount: 1,
    kept: [ModelRequest.Message.user("keep me")],
    marks: [
      { digest: "a", mark: "keep" },
      { digest: "b", mark: "remove", pinned: "failing" },
      { digest: "c", mark: "squash" }
    ],
    removedTokens: 1200
  }),
  new AgentEvent.SupervisorSettled({
    eventType: "flows.harness.supervisor-settled.v1",
    scope: "session-1",
    frame: 3,
    thrashing: 0.1,
    onTarget: 0.9,
    suspect: 0.1,
    frustrated: "none",
    anxious: "none",
    scared: "none",
    confused: "none",
    confident: "mild",
    needsHelp: "none",
    crossed: false,
    nudged: false,
    remembered: [],
    latencyMs: 200,
    monitors: [{ id: "mood/frustrated", kind: "mood", p: 0.3, crossed: false }]
  }),
  new AgentEvent.DisciplineArmed({
    eventType: "flows.harness.discipline-armed.v1",
    readOnlyCap: 3,
    maxFrames: 100,
    approvalChannel: true,
    modelCallMs: 300_000,
    repeatCap: 4,
    narrowingCap: 1,
    unmovedCap: 1,
    unresolvedCap: 1,
    judged: true,
    relevance: { withholdAt: 0.9, pinned: ["jev", "bash"] },
    monitors: [{ id: "skill/tdd", kind: "skill", at: 0.8, consecutive: 2, cooldownFrames: 5, limit: 3 }],
    stance: "paranoid"
  }),
  new AgentEvent.SteeringDrained({
    eventType: "flows.harness.steering-drained.v1",
    messages: [],
    supervisor: [ModelRequest.Message.user("Slow down.")],
    monitor: "mood/anxious",
    suppressed: [{ id: "lint/any", reason: "cooldown" }],
    memory: ["row-1"]
  }),
  new AgentEvent.DecisionSettled({
    eventType: "flows.harness.decision-settled.v1",
    scope: "session-1",
    frame: 0,
    classifier: "relevance/unnecessary",
    digest: "classifier-digest",
    state: { task: "fix the bug" },
    questions: { deploy: Evaluator.BooleanQuestion.of({ instructions: "Unnecessary?" }) },
    answers: { deploy: { kind: "boolean", p: 0.95 } },
    latencyMs: 90,
    acted: true,
    decidedBy: "jev",
    usage: { inputTokens: 300, outputTokens: 4 }
  })
]

describe("AgentEvent", () => {
  it("round-trips every stable event variant", () => {
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.DisciplineArmed({
        eventType: "flows.harness.discipline-armed.v1",
        readOnlyCap: 3,
        maxFrames: 100,
        approvalChannel: true,
        modelCallMs: 300_000,
        repeatCap: 4,
        narrowingCap: 1,
        unmovedCap: 1,
        unresolvedCap: 1,
        calls: 8,
        memoryBytes: 1024,
        steps: 10_000,
        timeMs: 500,
        totalMs: 2_000,
        callMs: 250
      }),
      new AgentEvent.CellProduced({
        eventType: "flows.harness.cell-produced.v1",
        cell: cellSource,
        blocks: 3
      }),
      new AgentEvent.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: flowCall
      }),
      new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: flowCall.flowName,
        identity: callIdentity,
        result: new Cell.CallResult({ outcome: "success", value: ["alpha.md"] })
      }),
      new AgentEvent.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: cellSource.digest,
        outcome: new Cell.Settled({
          transition: new Cell.Complete({ output: "done" })
        })
      }),
      new AgentEvent.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: cellSource.digest,
        outcome: new Cell.Raised({ name: "TypeError", message: "x is not a function" })
      }),
      new AgentEvent.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: "",
        outcome: new Cell.Rejected({ code: "no_cell", message: "emit a cell" })
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Continue({ justification: "the workspace is still being read" })
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Park({ reason: "waiting-input", message: "choose a branch" })
      }),
      new AgentEvent.Suspended({
        eventType: "flows.harness.suspended.v1",
        reason: new EngineLike.SuspendReason({
          code: "waiting-quota",
          message: "the seat is rate limited",
          details: { retryAfterMs: 1000 }
        })
      }),
      new AgentEvent.TurnOpened({
        eventType: "flows.harness.turn-opened.v1",
        seat: "sdk:model",
        modelParams: ModelRequest.GenerationParams.make({ reasoningEffort: "low" }),
        activeToolNames: ["flow"],
        contextDigest: "context-digest"
      }),
      new AgentEvent.ModelDelta({
        eventType: "flows.harness.model-delta.v1",
        delta: ModelEvent.ModelEvent.TextDelta({
          type: "text-delta",
          id: "text-1",
          text: "hello"
        })
      }),
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: assistantMessage,
        usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 2 })
      }),
      new AgentEvent.CompactionSettled({
        eventType: "flows.harness.compaction-settled.v1",
        replacedPrefixDigest: "prefix-digest",
        summary: assistantMessage
      }),
      new AgentEvent.SteeringDrained({
        eventType: "flows.harness.steering-drained.v1",
        messages: [ModelRequest.Message.user("continue")]
      }),
      new AgentEvent.TurnClosed({
        eventType: "flows.harness.turn-closed.v1",
        stopReason: "tool-calls",
        outcome: "continue"
      }),
      new AgentEvent.PermissionRequired({
        eventType: "flows.harness.permission-required.v1",
        request: permissionRequest
      }),
      new AgentEvent.Aborted({
        eventType: "flows.harness.aborted.v1",
        reason: "interrupted"
      }),
      new AgentEvent.NarrowedDemanded({
        eventType: "flows.harness.narrowed-demanded.v1",
        flow: "bash",
        broader: "{\"command\":\"check suite\"}",
        narrower: "{\"command\":\"check suite -only one\"}",
        broaderDigest: "digest-before",
        currentDigest: "digest-after",
        nextFrame: 7
      }),
      new AgentEvent.UnmovedDemanded({
        eventType: "flows.harness.unmoved-demanded.v1",
        openedDigest: "digest-opened",
        currentDigest: "digest-opened",
        nextFrame: 7
      }),
      new AgentEvent.UnresolvedDemanded({
        eventType: "flows.harness.unresolved-demanded.v1",
        flow: "bash",
        failed: "{\"command\":\"check suite\"}",
        instead: "{\"command\":\"check suite -only one\"}",
        currentDigest: "digest-after",
        nextFrame: 7
      }),
      new AgentEvent.FailedCallDemanded({
        eventType: "flows.harness.failed-call-demanded.v1",
        failures: [{ flow: "agent.delegate", message: "Flow agent.delegate failed: Three workers are active" }],
        nextFrame: 7
      }),
      new AgentEvent.UnobservedDemanded({
        eventType: "flows.harness.unobserved-demanded.v1",
        calls: [{ flow: "bash", ordinal: 3, ok: true, summary: "{\"exitCode\":0}" }],
        nextFrame: 7
      }),
      new AgentEvent.ClaimDemanded({
        eventType: "flows.harness.claim-demanded.v1",
        complete: 0.12,
        overclaims: 0.91,
        invented: 0.93,
        latencyMs: 480,
        demanded: true,
        currentDigest: "digest-after",
        nextFrame: 7
      }),
      new AgentEvent.SupervisorSettled({
        eventType: "flows.harness.supervisor-settled.v1",
        scope: "session-1",
        frame: 3,
        thrashing: 0.62,
        onTarget: 0.4,
        suspect: 0.1,
        frustrated: "strong",
        anxious: "mild",
        scared: "none",
        confused: "none",
        confident: "none",
        needsHelp: "stuck",
        crossed: true,
        nudged: false,
        remembered: [0],
        latencyMs: 310
      }),
      new AgentEvent.SupervisorUnjudged({
        eventType: "flows.harness.supervisor-unjudged.v1",
        scope: "session-1",
        frame: 4,
        reason: "timeout",
        detail: "The gateway did not answer within 1500 ms"
      }),
      new AgentEvent.SupervisorMemoryFailed({
        eventType: "flows.harness.supervisor-memory-failed.v1",
        scope: "session-1",
        frame: 4,
        operation: "remember",
        detail: "database is locked"
      }),
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: assistantMessage
      }),
      new AgentEvent.ModelRequested({
        eventType: "flows.harness.model-requested.v1",
        scope: "session-1",
        frame: 3,
        attempt: 1,
        purpose: "frame",
        seat: "anthropic:model",
        binding: new EngineLike.Binding({ routeId: "anthropic-direct", protocolId: "anthropic-messages" }),
        request: ModelRequest.ModelRequest.make({
          modelId: "model",
          system: [ModelRequest.SystemPart.make({ text: "cell contract" })],
          messages: [ModelRequest.Message.user("start")],
          tools: [],
          toolChoice: "none",
          params: ModelRequest.GenerationParams.make({ maxTokens: 1024 })
        })
      }),
      new AgentEvent.SeatFailedOver({
        eventType: AgentEvent.eventType.seatFailedOver,
        from: "first",
        to: "second",
        code: "rate_limited",
        resetAtEpochMillis: 1000
      }),
      new AgentEvent.ModelParked({
        eventType: AgentEvent.eventType.modelParked,
        seat: "second",
        wakeAt: 1000,
        source: "reset",
        code: "rate_limited"
      }),
      new AgentEvent.ModelUnparked({
        eventType: AgentEvent.eventType.modelUnparked,
        seat: "second",
        at: 1000
      }),
      new AgentEvent.DecisionSettled({
        eventType: "flows.harness.decision-settled.v1",
        scope: "session-1",
        frame: 3,
        classifier: "triage/relevance",
        digest: "classifier-digest",
        state: { title: "a pull request" },
        questions: {
          relevant: Evaluator.BooleanQuestion.of({ instructions: "Relevant?", criteria: { true: "yes", false: "no" } }),
          role: Evaluator.ChoiceQuestion.of({
            instructions: "Which?",
            criteria: { lead: "leads", support: "supports" }
          })
        },
        answers: {
          relevant: { kind: "boolean", p: 0.8 },
          role: { kind: "choice", value: "lead", probabilities: { lead: 0.7, support: 0.3 }, confidence: 0.91 }
        },
        latencyMs: 480,
        acted: true,
        decidedBy: "jev"
      }),
      // The ten variants this list used to omit. A round-trip suite that names
      // two thirds of a union proves nothing about the third it skipped.
      new AgentEvent.CellPrinted({
        eventType: "flows.harness.cell-printed.v1",
        cell: "cell-digest",
        text: "printed output"
      }),
      new AgentEvent.CellRejectedInFrame({
        eventType: "flows.harness.cell-rejected-in-frame.v1",
        attempt: 1,
        code: "compile_failed",
        message: "SyntaxError at line 2"
      }),
      new AgentEvent.CheckpointMinted({
        eventType: "flows.harness.checkpoint-minted.v1",
        id: "cp-1",
        ref: "jj:abcdef",
        cell: "cell-digest",
        ordinal: 0
      }),
      new AgentEvent.ModelRetried({
        eventType: "flows.harness.model-retried.v1",
        attempt: 2,
        code: "overloaded",
        delayMillis: 250
      }),
      new AgentEvent.MutationObserved({
        eventType: "flows.harness.mutation-observed.v1",
        basis: "observed",
        mutated: true,
        digest: "tree-digest",
        paths: 12,
        declaredWrites: 1
      }),
      new AgentEvent.NarrowOnlyDemanded({
        eventType: "flows.harness.narrow-only-demanded.v1",
        flow: "bash",
        check: "pytest -k one",
        targets: ["tests/test_one.py"],
        currentDigest: "tree-digest",
        nextFrame: 4
      }),
      new AgentEvent.ReadOnlyDemanded({
        eventType: "flows.harness.read-only-demanded.v1",
        streak: 12,
        cap: 12,
        nextFrame: 13,
        nextAction: "write"
      }),
      new AgentEvent.ReadOnlyDemandIssued({
        eventType: "flows.harness.read-only-demand-issued.v1",
        streak: 12,
        cap: 12,
        nextFrame: 13
      }),
      new AgentEvent.RepeatDemanded({
        eventType: "flows.harness.repeat-demanded.v1",
        frames: 4,
        cap: 4,
        nextFrame: 5
      }),
      new AgentEvent.SufficiencyObserved({
        eventType: "flows.harness.sufficiency-observed.v1",
        flow: "bash",
        failed: "pytest tests",
        passed: "pytest tests",
        epoch: 0,
        nextFrame: 6
      }),
      new AgentEvent.VacuousVerificationObserved({
        eventType: "flows.harness.vacuous-verification-observed.v1",
        flow: "bash",
        check: "pytest tests",
        callDigest: "call-digest",
        nextFrame: 7
      }),
      ...jevEvents
    ]

    for (const event of events) {
      expect(
        Schema.decodeUnknownSync(AgentEvent.AgentEvent)(
          Schema.encodeSync(AgentEvent.AgentEvent)(event)
        )
      ).toEqual(event)
    }

    // Every member of the union, and every row of the one event-type table,
    // account for each other. The literal used to be written three times, and
    // a projection reading a literal the emitter no longer writes returns an
    // empty transcript with nothing failing.
    const declared = new Set<string>(Object.values(AgentEvent.eventType))
    const constructed = new Set<string>(events.map((event) => event.eventType))
    expect([...constructed].filter((value) => !declared.has(value))).toEqual([])
    expect([...declared].filter((value) => !constructed.has(value))).toEqual([])
  })

  it("pins the encoded wire shape of the events a projection reads", () => {
    // Golden vectors. Renaming an `eventType` or a payload field is a change to
    // what every stored journal decodes as, so it has to be a change to a
    // literal somebody wrote down.
    const source = Cell.source("console.log(1)")

    expect(
      Schema.encodeSync(AgentEvent.AgentEvent)(
        new AgentEvent.CellPrinted({
          eventType: AgentEvent.eventType.cellPrinted,
          cell: "cell-digest",
          text: "printed"
        })
      )
    ).toEqual({
      _tag: "cell-printed",
      eventType: "flows.harness.cell-printed.v1",
      cell: "cell-digest",
      text: "printed"
    })

    expect(
      Schema.encodeSync(AgentEvent.AgentEvent)(
        new AgentEvent.CellProduced({ eventType: AgentEvent.eventType.cellProduced, cell: source })
      )
    ).toEqual({
      _tag: "cell-produced",
      eventType: "flows.harness.cell-produced.v1",
      blocks: 1,
      cell: { text: source.text, language: source.language, digest: source.digest }
    })

    expect(
      Schema.encodeSync(AgentEvent.AgentEvent)(
        new AgentEvent.Aborted({ eventType: AgentEvent.eventType.aborted, reason: "cancelled" })
      )
    ).toEqual({ _tag: "aborted", eventType: "flows.harness.aborted.v1", reason: "cancelled" })

    // The decision is stored whole inside the recorded completion judgement, so
    // its encoding is what a replayed frame decodes: the questions in their
    // wire form, and no `confidence` key where the provider reported none.
    expect(
      Schema.encodeSync(AgentEvent.AgentEvent)(
        new AgentEvent.DecisionSettled({
          eventType: AgentEvent.eventType.decisionSettled,
          scope: "session-1",
          frame: 0,
          classifier: "completion/claim",
          digest: "digest",
          state: { claim: "done" },
          questions: { done: Evaluator.BooleanQuestion.of({ instructions: "Done?" }) },
          answers: {
            done: { kind: "boolean", p: 0.9 },
            role: { kind: "choice", value: "lead", probabilities: { lead: 1, support: 0 } }
          },
          latencyMs: 12,
          acted: false,
          decidedBy: "jev"
        })
      )
    ).toEqual({
      _tag: "decision-settled",
      eventType: "flows.harness.decision-settled.v1",
      scope: "session-1",
      frame: 0,
      classifier: "completion/claim",
      digest: "digest",
      state: { claim: "done" },
      questions: { done: { type: "boolean", instructions: "Done?" } },
      answers: {
        done: { kind: "boolean", p: 0.9 },
        role: { kind: "choice", value: "lead", probabilities: { lead: 1, support: 0 } }
      },
      latencyMs: 12,
      acted: false,
      decidedBy: "jev"
    })
  })

  it("round-trips the same variants with every optional field absent", () => {
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.DisciplineArmed({
        eventType: "flows.harness.discipline-armed.v1",
        readOnlyCap: 0,
        maxFrames: 1,
        approvalChannel: false,
        modelCallMs: 0,
        repeatCap: 0,
        narrowingCap: 0,
        unmovedCap: 0,
        unresolvedCap: 0
      }),
      new AgentEvent.Suspended({
        eventType: "flows.harness.suspended.v1",
        reason: new EngineLike.SuspendReason({ code: "permission-required", message: "fs:write is not granted" })
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Complete({ output: "" })
      })
    ]

    for (const event of events) {
      const decoded = Schema.decodeUnknownSync(AgentEvent.AgentEvent)(
        Schema.encodeSync(AgentEvent.AgentEvent)(event)
      )
      expect(decoded).toEqual(event)
      // An absent optional stays absent across the round trip: a key carrying
      // an explicit `undefined` is a different journal payload.
      expect(Object.keys(decoded)).toEqual(Object.keys(event))
    }
    expect("calls" in events[0]!).toBe(false)
    expect("verification" in events[1]!).toBe(false)
  })

  it("reuses one reason set for every unjudged reading", () => {
    expect(AgentEvent.SupervisorUnjudged.fields.reason).toBe(AgentEvent.UnjudgedReason)
    expect(AgentEvent.DecisionUnjudged.fields.reason).toBe(AgentEvent.UnjudgedReason)
    expect(AgentEvent.UnjudgedReason.literals).toEqual([
      "unconfigured",
      "interrupted",
      ...Evaluator.EvaluatorErrorCode.literals
    ])
  })

  // Journals written before the Jev fields existed must decode unchanged:
  // every added field is optional, and none is filled in on the way back.
  it.each([
    {
      _tag: "compaction-settled",
      eventType: "flows.harness.compaction-settled.v1",
      replacedPrefixDigest: "prefix",
      retainedMessageCount: 2,
      summary: { role: "user", content: [{ type: "text", text: "summary" }] }
    },
    {
      _tag: "supervisor-settled",
      eventType: "flows.harness.supervisor-settled.v1",
      scope: "session-1",
      frame: 3,
      thrashing: 0.6,
      onTarget: 0.4,
      suspect: 0.1,
      frustrated: "strong",
      anxious: "mild",
      scared: "none",
      confused: "none",
      confident: "none",
      needsHelp: "stuck",
      crossed: true,
      nudged: true,
      steer: true,
      remembered: [],
      latencyMs: 310
    },
    {
      _tag: "discipline-armed",
      eventType: "flows.harness.discipline-armed.v1",
      readOnlyCap: 3,
      maxFrames: 100,
      approvalChannel: true,
      modelCallMs: 300000,
      repeatCap: 4,
      narrowingCap: 1,
      unmovedCap: 1,
      revalidations: 1,
      unresolvedCap: 1,
      claimCap: 1
    },
    {
      _tag: "steering-drained",
      eventType: "flows.harness.steering-drained.v1",
      messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
      supervisor: [{ role: "user", content: [{ type: "text", text: "nudge" }] }]
    },
    {
      _tag: "decision-settled",
      eventType: "flows.harness.decision-settled.v1",
      scope: "session-1",
      frame: 0,
      classifier: "completion/claim",
      digest: "digest",
      state: { claim: "done" },
      questions: { done: { type: "boolean", instructions: "Done?" } },
      answers: { done: { kind: "boolean", p: 0.9 } },
      latencyMs: 12,
      acted: false,
      decidedBy: "jev"
    }
  ])("decodes a pre-Jev $_tag payload unchanged", (payload) => {
    const decoded = Schema.decodeUnknownSync(AgentEvent.AgentEvent)(payload)
    expect(decoded._tag).toBe(payload._tag)
    expect(Schema.encodeSync(AgentEvent.AgentEvent)(decoded)).toEqual(payload)
  })

  it("decodes a compaction without a summary", () => {
    const compaction = jevEvents[4]!
    const encoded = Schema.encodeSync(AgentEvent.AgentEvent)(compaction) as Record<string, unknown>
    expect("summary" in encoded).toBe(false)
    expect(Schema.decodeUnknownSync(AgentEvent.AgentEvent)(encoded)).toEqual(compaction)
  })

  it("decodes a reading journaled with the retired inserted rows and drops them", () => {
    const reading = jevEvents[5]!
    const encoded = Schema.encodeSync(AgentEvent.AgentEvent)(reading) as Record<string, unknown>
    const decoded = Schema.decodeUnknownSync(AgentEvent.AgentEvent)({ ...encoded, inserted: [0] })
    expect(decoded).toEqual(reading)
    expect("inserted" in decoded).toBe(false)
  })

  it("decodes a legacy cell settlement without inventing an execution frontier", () => {
    // Decode a historical wire payload directly: constructors must not supply
    // defaults that conceal a missing field in an older journal.
    const decoded = Schema.decodeUnknownSync(AgentEvent.AgentEvent)({
      _tag: "cell-settled",
      eventType: "flows.harness.cell-settled.v1",
      cell: "legacy-cell",
      outcome: {
        _tag: "rejected",
        code: "limit_exceeded",
        message: "This cell exceeded its wall-clock limit of 50 milliseconds"
      }
    })
    expect(decoded._tag).toBe("cell-settled")
    expect("boundary" in decoded).toBe(false)
  })

  it("defaults an absent duration to zero rather than rejecting the older payload", () => {
    const settled = new AgentEvent.ModelSettled({
      eventType: "flows.harness.model-settled.v1",
      message: assistantMessage,
      usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 2 })
    })
    const encoded = { ...Schema.encodeSync(AgentEvent.AgentEvent)(settled) as Record<string, unknown> }
    delete encoded["durationMillis"]

    const decoded = Schema.decodeUnknownSync(AgentEvent.AgentEvent)(encoded)

    expect(settled.durationMillis).toBe(0)
    expect(decoded._tag === "model-settled" ? decoded.durationMillis : undefined).toBe(0)
  })

  it("refuses a payload that is not one of the union's tags", () => {
    const decoded = Schema.decodeUnknownResult(AgentEvent.AgentEvent)({
      _tag: "not-an-event",
      eventType: "flows.harness.not-an-event.v1"
    })

    expect(decoded._tag).toBe("Failure")
  })
})

describe("HarnessError", () => {
  it("pins and round-trips exactly the codes this package raises", () => {
    const codes = [
      "assembly_failed",
      "incompatible_journal",
      "render_failed",
      "model_failed",
      "engine_failed",
      "read_only_cap",
      "completion_unjudged",
      "claim_unproven",
      "suspended"
    ] as const

    expect(HarnessErrorCode.literals).toEqual(codes)
    for (const code of codes) {
      const error = new HarnessError({ code, message: code })
      expect(
        Schema.decodeUnknownSync(HarnessError)(Schema.encodeSync(HarnessError)(error))
      ).toEqual(error)
    }
  })

  it("keeps the set closed to codes some source file actually constructs", () => {
    // A code the package cannot raise is a promise it cannot keep, so every
    // member must have a `new HarnessError({ code: "..." })` site under src,
    // and every such site must name a member.
    const constructed = new Set<string>()
    for (const file of readdirSync(new URL("../src/", import.meta.url), { recursive: true })) {
      if (!String(file).endsWith(".ts")) continue
      const text = readFileSync(new URL(`../src/${String(file)}`, import.meta.url), "utf8")
      for (const match of text.matchAll(/new HarnessError\(\{\s*code: "([a-z_]+)"/g)) constructed.add(match[1]!)
    }

    expect([...constructed].sort()).toEqual([...HarnessErrorCode.literals].sort())
  })
})

describe("EngineLike", () => {
  it("resolves its noop layer and fails unavailable operations cleanly", async () => {
    const service = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* EngineLike.EngineLike
      }).pipe(Effect.provide(EngineLike.layerNoop()))
    )
    const request = ModelRequest.ModelRequest.make({
      modelId: "model",
      system: [],
      messages: [],
      tools: [],
      params: {}
    })

    const sealExit = await Effect.runPromiseExit(
      Stream.runDrain(service.sealStep({
        request,
        keyMaterial: {
          version: "flows/key-material/v2",
          kind: "sealed",
          body: request,
          inputs: [{ _tag: "Literal", value: { contextDigest: "context-digest" } }],
          layers: ["model:test"],
          capabilities: ["model:call:provider/model"],
          effects: undefined,
          placement: undefined
        }
      }))
    )
    const spliceExit = await Effect.runPromiseExit(Stream.runDrain(service.splice(batch)))
    const suspendExit = await Effect.runPromiseExit(
      service.suspend(
        new EngineLike.SuspendReason({
          code: "engine",
          message: "test"
        })
      )
    )

    expect(sealExit._tag).toBe("Failure")
    expect(spliceExit._tag).toBe("Failure")
    expect(suspendExit._tag).toBe("Failure")
  })

  it("refuses a call and never performs a recorded read", async () => {
    const service = EngineLike.makeNoop()
    let executed = false

    const callExit = await Effect.runPromiseExit(service.call(flowCall))
    const recordExit = await Effect.runPromiseExit(
      service.record({
        name: "steering-drain",
        identity: { session: "session-1", frame: 1, boundary: "turn-1" },
        success: Schema.String,
        execute: Effect.sync(() => {
          executed = true
          return "drained"
        })
      })
    )

    // A stub that ran `execute` would perform the nondeterministic read the
    // boundary exists to journal, so refusing has to happen before it.
    expect(executed).toBe(false)
    expect(Exit.isFailure(callExit) ? Cause.squash(callExit.cause) : undefined).toMatchObject({
      _tag: "/harness/HarnessError",
      code: "engine_failed",
      message: "call is unavailable"
    })
    expect(Exit.isFailure(recordExit) ? Cause.squash(recordExit.cause) : undefined).toMatchObject({
      code: "engine_failed",
      message: "record is unavailable"
    })
  })

  it("reports a stub as pinning nothing rather than as failing to pin", async () => {
    // The same shape `observe` takes, and for the same reason: a host with no
    // workspace has nothing to pin, and the controller turns "nothing pinned"
    // into a catchable refusal the cell can route around. Failing here would
    // turn a host that simply has no tree into a failed run.
    const pinned = await Effect.runPromise(
      EngineLike.makeNoop().capture({
        id: "cp-0-0",
        identity: { session: "session-1", frame: 0, boundary: "cell-digest" }
      })
    )

    expect(Option.isNone(pinned)).toBe(true)
  })

  it("reports a refused suspend as suspended rather than as an engine failure", async () => {
    const exit = await Effect.runPromiseExit(
      EngineLike.makeNoop().suspend(new EngineLike.SuspendReason({ code: "waiting-input", message: "test" }))
    )

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
      code: "suspended",
      message: "suspend is unavailable"
    })
  })

  it("replaces only the overridden operation and leaves the rest unavailable", async () => {
    const settled = new Cell.CallResult({ outcome: "success", value: ["alpha.md"] })
    const service = EngineLike.makeNoop({ call: () => Effect.succeed(settled) })

    const called = await Effect.runPromise(service.call(flowCall))
    const recordExit = await Effect.runPromiseExit(
      service.record({
        name: "steering-drain",
        identity: { frame: 0, boundary: "turn-1" },
        success: Schema.String,
        execute: Effect.succeed("drained")
      })
    )

    expect(called).toStrictEqual(settled)
    expect(Exit.isFailure(recordExit)).toBe(true)
  })

  it("provides an overridden stub through its layer", async () => {
    const recorded = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* EngineLike.EngineLike
        return yield* engine.record({
          name: "steering-drain",
          identity: { session: "session-1", frame: 2, boundary: "turn-2" },
          success: Schema.String,
          execute: Effect.succeed("drained")
        })
      }).pipe(
        Effect.provide(EngineLike.layerNoop({ record: (boundary) => boundary.execute }))
      )
    )

    expect(recorded).toBe("drained")
  })

  it("provides a complete implementation through make and layer", async () => {
    const settled = new Cell.CallResult({ outcome: "failure", value: null, message: "no such flow" })
    const implementation = EngineLike.make({
      ...EngineLike.makeNoop(),
      call: () => Effect.succeed(settled)
    })

    const called = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* EngineLike.EngineLike
        return yield* engine.call(flowCall)
      }).pipe(Effect.provide(EngineLike.layer(implementation)))
    )

    expect(called).toStrictEqual(settled)
  })

  it("round-trips a suspension carrying a real permission request through the journal", () => {
    // `details` used to be `Schema.Unknown`, and the controller attached the
    // live `PermissionRequired` — a class extending Error — to every permission
    // park. Nothing encodes an Error to JSON, so the event that carried the park
    // died on the way into the journal, replacing the park with a schema
    // failure. This is that exact value, through the union, through JSON, and
    // back.
    const request = new Permission.PermissionRequired({
      requestId: "perm-1",
      runId: "run-1",
      capability: new Capability.Capability({ action: "fs:write", resource: "src/**" }),
      tier: "irreversible",
      meta: { path: "src/index.ts" }
    })
    const suspended = new AgentEvent.Suspended({
      eventType: "flows.harness.suspended.v1",
      reason: new EngineLike.SuspendReason({
        code: "permission-required",
        message: `Permission ${request.requestId} is required`,
        details: Schema.encodeSync(Permission.PermissionRequired)(request)
      })
    })

    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(AgentEvent.AgentEvent)(suspended)))
    const decoded = Schema.decodeUnknownSync(AgentEvent.AgentEvent)(wire)

    expect(decoded._tag).toBe("suspended")
    expect(JSON.stringify(decoded)).toContain("perm-1")
    expect(JSON.stringify(decoded)).toContain("fs:write")
    expect(JSON.stringify(decoded)).toContain("src/**")
  })

  it("refuses a suspend reason whose details are not JSON", () => {
    // The narrowing is the point: a value the journal cannot hold is refused
    // where it is constructed rather than where it is written.
    expect(() =>
      new EngineLike.SuspendReason({
        code: "engine",
        message: "park",
        details: (() => undefined) as never
      })
    ).toThrow()
  })

  it("keeps every stable suspend reason code decodable", () => {
    const codes = ["permission-required", "waiting-quota", "waiting-input", "waiting-event", "engine"] as const

    for (const code of codes) {
      const reason = new EngineLike.SuspendReason({ code, message: code })
      expect(
        Schema.decodeUnknownSync(EngineLike.SuspendReason)(Schema.encodeSync(EngineLike.SuspendReason)(reason))
      ).toEqual(reason)
    }
    expect(Schema.decodeUnknownResult(EngineLike.SuspendReason)({ code: "nope", message: "x" })._tag).toBe("Failure")
  })
})
