/**
 * Journal-to-transcript projection: what a resumed run rebuilds from what the
 * loop journaled, and what it refuses to rebuild from a payload that no longer
 * decodes. See `../docs/concepts.md#durable-cell-loop`.
 */
import type { JournalEvent } from "@smthrs/journal"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import { Effect, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as Cell from "../src/Cell.ts"
import * as Compaction from "../src/Compaction.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as FailedCall from "../src/FailedCall.ts"
import * as DemandText from "../src/internal/demandText.ts"
import { printsObservation } from "../src/internal/printsObservation.ts"
import * as UnobservedCall from "../src/internal/unobservedCall.ts"
import * as Transcript from "../src/Transcript.ts"
import { entry, journal } from "./fixtures/journal.ts"

const project = (entries: ReadonlyArray<JournalEvent.Entry>): ReadonlyArray<ModelRequest.Message> =>
  Result.getOrThrow(Transcript.projectResult(entries))

it("validates current session journals while leaving unrelated control history alone", () => {
  expect(Result.isSuccess(Transcript.validateJournal([
    entry(1, "control.run.started", {}),
    entry(2, "control.agent.discipline-armed", { journalVersion: Transcript.journalVersion })
  ]))).toBe(true)
})

it("selects the entries it validates through the prefix the writer is typed against", () => {
  // `@smthrs/agent` writes these entries and types every event type it emits
  // as `Transcript.ControlEventType`, so the two sides cannot drift: renaming
  // the constant fails that package's typecheck instead of silently emptying
  // the set this filter selects.
  expect(Transcript.controlEventPrefix).toBe("control.agent.")

  const stale = { journalVersion: Transcript.journalVersion - 1 }
  expect(Result.isFailure(
    Transcript.validateJournal([entry(1, `${Transcript.controlEventPrefix}turn-opened`, stale)])
  )).toBe(true)
  expect(Result.isSuccess(
    Transcript.validateJournal([entry(1, "control.run.turn-opened", stale)])
  )).toBe(true)
})

it.each([null, "invalid", {}, { journalVersion: 1 }, { journalVersion: 999 }])(
  "refuses incompatible session payload %j",
  (payload) => {
    const result = Transcript.validateJournal([entry(1, "control.agent.compaction-settled", payload)])
    expect(Result.isFailure(result) && result.failure.code).toBe("incompatible_journal")
  }
)

it("renders a historical assistant summary as user context", () => {
  const projected = Result.getOrThrow(
    Transcript.projectResult([entry(
      1,
      "flows.harness.compaction-settled.v1",
      new AgentEvent.CompactionSettled({
        eventType: "flows.harness.compaction-settled.v1",
        replacedPrefixDigest: "old-prefix",
        summary: ModelRequest.Message.assistant([
          ModelRequest.ThinkingPart.make({ text: "internal thought" }),
          ModelRequest.TextPart.make({ text: "Earlier work" })
        ], { stopReason: "stop" })
      })
    )])
  )
  expect(projected).toEqual([ModelRequest.Message.user("Earlier work")])
})

describe("Transcript", () => {
  it("orders entries and ignores journal-only events", () => {
    const entries = [
      ...journal().filter((item) => item.seq < 8),
      entry(10, "denial", {}),
      entry(11, "flows.harness.turn-opened.v1", {}),
      entry(12, "unknown-event", {})
    ].reverse()
    expect(project(entries).map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant"
    ])
  })

  it("projects only drained steering in sequence order", () => {
    const entries = [
      entry(2, "steering", { messages: ["not drained"] }),
      entry(
        1,
        "flows.harness.steering-drained.v1",
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [ModelRequest.Message.user("one"), ModelRequest.Message.user("two")]
        })
      )
    ]
    expect(project(entries)).toEqual([ModelRequest.Message.user("one"), ModelRequest.Message.user("two")])
  })

  it("omits empty assistant turns, preserves failed partial content, and strips its continuation metadata", () => {
    const messages = project([
      entry(
        1,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant([], {
            stopReason: "error",
            responseId: "empty-response"
          }),
          usage: ModelEvent.Usage.make({ inputTokens: 0, outputTokens: 0 })
        })
      ),
      entry(2, "flows.harness.model-delta.v1", {
        responseId: "failed-partial-response"
      }),
      entry(
        3,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant([
            ModelRequest.ThinkingPart.make({
              text: "Partial thought",
              signature: "provider-signature"
            }),
            ModelRequest.TextPart.make({ text: "Partial answer" })
          ], {
            stopReason: "error",
            responseId: "failed-response",
            itemIds: ["failed-item"]
          }),
          usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 2 })
        })
      ),
      entry(
        4,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant("complete", {
            stopReason: "stop",
            responseId: "settled-response"
          }),
          usage: ModelEvent.Usage.make({ inputTokens: 0, outputTokens: 0 })
        })
      )
    ])

    expect(messages).toEqual([
      ModelRequest.Message.assistant([
        ModelRequest.ThinkingPart.make({
          text: "Partial thought"
        }),
        ModelRequest.TextPart.make({ text: "Partial answer" })
      ], {
        stopReason: "error"
      }),
      ModelRequest.Message.assistant("complete", {
        stopReason: "stop",
        responseId: "settled-response"
      })
    ])
  })

  it("renders a compaction summary plus suffix without changing journal entries", () => {
    const entries = journal()
    const before = entries.map((entry) => entry.seq)
    const state = Result.getOrThrow(Transcript.projectStateResult(entries))
    expect(state.replaced).toBe("prefix-digest")
    expect(state.messages.map(({ kind }) => kind)).toEqual([
      "summary",
      "transcript"
    ])
    expect(entries.map((entry) => entry.seq)).toEqual(before)
  })

  it("keeps the live retained suffix across partial and repeated compactions", () => {
    const messages = ["old", "recent one", "recent two"].map((text) => ModelRequest.Message.user(text))
    let live = ContextWindow.make({
      modelId: "test",
      segments: [
        {
          kind: "transcript",
          zone: "tail",
          content: messages.slice(0, 1),
          tokens: { value: 30_000, estimated: false }
        },
        { kind: "transcript", zone: "tail", content: messages.slice(1), tokens: { value: 20_000, estimated: false } }
      ]
    })
    const entries = [entry(
      1,
      AgentEvent.eventType.steeringDrained,
      new AgentEvent.SteeringDrained({
        eventType: AgentEvent.eventType.steeringDrained,
        messages
      })
    )]
    for (const round of [1, 2]) {
      const prefixLength = Compaction.selectPrefix(live)
      expect(prefixLength).toBe(1)
      const step = Effect.runSync(Compaction.declare(live, prefixLength, { identity: "summary" }))
      const summary = ModelRequest.Message.user(`summary ${round}`)
      live = Effect.runSync(Compaction.apply(live, step, summary))
      entries.push(entry(round + 1, AgentEvent.eventType.compactionSettled, {
        _tag: "compaction-settled",
        eventType: AgentEvent.eventType.compactionSettled,
        replacedPrefixDigest: step.replacedPrefixDigest,
        retainedMessageCount: 2,
        summary
      }))
      expect(project(entries)).toEqual(ContextWindow.render(live).messages)
      expect(Result.getOrThrow(Transcript.projectStateResult(entries)).replaced).toBe(step.replacedPrefixDigest)
    }
  })

  it("replaces the whole prefix when the retained message count is zero", () => {
    expect(project([
      ...journal(),
      entry(10, AgentEvent.eventType.compactionSettled, {
        _tag: "compaction-settled",
        eventType: AgentEvent.eventType.compactionSettled,
        replacedPrefixDigest: "all",
        retainedMessageCount: 0,
        summary: ModelRequest.Message.user("all summarized")
      })
    ])).toEqual([ModelRequest.Message.user("all summarized")])
  })

  describe("marked compaction", () => {
    const [first, second, third] = ["first", "second", "third"].map((text) => ModelRequest.Message.user(text))
    const drained = entry(1, AgentEvent.eventType.steeringDrained, {
      _tag: "steering-drained",
      eventType: AgentEvent.eventType.steeringDrained,
      messages: [first, second, third]
    })
    const compacted = (fields: Record<string, unknown>) =>
      Result.getOrThrow(Transcript.projectStateResult([
        drained,
        entry(2, AgentEvent.eventType.compactionSettled, {
          _tag: "compaction-settled",
          eventType: AgentEvent.eventType.compactionSettled,
          replacedPrefixDigest: "marked",
          ...fields
        })
      ])).messages

    it.each([
      {
        name: "summary and kept",
        fields: { retainedMessageCount: 1, summary: ModelRequest.Message.user("squashed"), kept: [second] },
        expected: [["summary", ModelRequest.Message.user("squashed")], ["transcript", second], ["steering", third]]
      },
      {
        name: "kept only",
        fields: { retainedMessageCount: 1, kept: [first] },
        expected: [["transcript", first], ["steering", third]]
      },
      {
        name: "summary only",
        fields: { retainedMessageCount: 2, summary: ModelRequest.Message.user("squashed") },
        expected: [["summary", ModelRequest.Message.user("squashed")], ["steering", second], ["steering", third]]
      },
      {
        name: "a legacy entry without a boundary",
        fields: { summary: ModelRequest.Message.user("legacy"), kept: [first] },
        expected: [["summary", ModelRequest.Message.user("legacy")], ["transcript", first]]
      }
    ])("projects $name in place of the replaced prefix", ({ expected, fields }) => {
      expect(compacted(fields).map(({ kind, message }) => [kind, message])).toEqual(expected)
    })
  })

  it("retains messages after a legacy summary when a later compaction supplies a boundary", () => {
    const entries = [...journal()]
    const recent = project(entries)[1]!
    entries.push(entry(10, AgentEvent.eventType.compactionSettled, {
      _tag: "compaction-settled",
      eventType: AgentEvent.eventType.compactionSettled,
      replacedPrefixDigest: "new-prefix",
      retainedMessageCount: 1,
      summary: ModelRequest.Message.user("updated summary")
    }))
    entries.push(entry(11, AgentEvent.eventType.steeringDrained, {
      _tag: "steering-drained",
      eventType: AgentEvent.eventType.steeringDrained,
      messages: [ModelRequest.Message.user("next instruction")]
    }))
    const state = Result.getOrThrow(Transcript.projectStateResult(entries))
    expect(state.messages.map(({ message }) => message)).toEqual([
      ModelRequest.Message.user("updated summary"),
      recent,
      ModelRequest.Message.user("next instruction")
    ])
    expect(state.messages.map(({ kind }) => kind)).toEqual(["summary", "transcript", "steering"])
    expect(state.replaced).toBe("new-prefix")
  })

  it.each([-1, 0.5, null, "2"])("rejects an invalid retained message count %j", (retainedMessageCount) => {
    const result = Transcript.projectResult([entry(1, AgentEvent.eventType.compactionSettled, {
      _tag: "compaction-settled",
      eventType: AgentEvent.eventType.compactionSettled,
      replacedPrefixDigest: "prefix",
      retainedMessageCount,
      summary: ModelRequest.Message.user("summary")
    })])
    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
  })

  it("decodes old compaction journals without a boundary and replaces all preceding messages", () => {
    const payload = JSON.parse(JSON.stringify(
      new AgentEvent.CompactionSettled({
        eventType: AgentEvent.eventType.compactionSettled,
        replacedPrefixDigest: "legacy",
        summary: ModelRequest.Message.user("legacy summary")
      })
    ))
    expect(Result.isSuccess(Schema.decodeUnknownResult(AgentEvent.CompactionSettled)(payload))).toBe(true)
    expect(project([...journal(), entry(10, AgentEvent.eventType.compactionSettled, payload)])).toEqual([
      ModelRequest.Message.user("legacy summary")
    ])
  })

  it("returns a typed failure for malformed known payloads without throwing", () => {
    const result = Transcript.projectResult([entry(1, "flows.harness.model-settled.v1", { message: "bad" })])

    expect(Result.isFailure(result)).toBe(true)
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(Transcript.TranscriptError)
    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
  })

  it("keeps the projection error code stable", () => {
    const result = Transcript.projectStateResult([
      entry(1, "flows.harness.compaction-settled.v1", { summary: "bad" })
    ])

    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(Transcript.TranscriptError)
  })

  it("consumes versioned cell evidence and rebuilds the cell-selected context", () => {
    const source = Cell.source("console.log(\"keep exactly this\")")
    const call = new Cell.Call({
      flowName: "fs/list",
      input: { path: "." },
      capabilities: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      placement: Option.none(),
      identity: new Cell.CallIdentity({
        session: "lineage-1",
        frame: 1,
        cell: source.digest,
        ordinal: 0,
        declaration: "declaration-1",
        layers: ["composition-1"]
      })
    })
    const transition = new Cell.Continue({})
    const reason = new EngineLike.SuspendReason({
      code: "waiting-input",
      message: "choose a branch"
    })
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.CompactionSettled({
        eventType: "flows.harness.compaction-settled.v1",
        replacedPrefixDigest: "old-prefix",
        summary: ModelRequest.Message.assistant("compacted", { stopReason: "stop" })
      }),
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: ModelRequest.Message.assistant("cell source", { stopReason: "stop" }),
        usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
      }),
      new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell: source }),
      new AgentEvent.CellCallStarted({ eventType: "flows.harness.cell-call-started.v1", call }),
      new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: call.flowName,
        identity: call.identity,
        result: new Cell.CallResult({ outcome: "success", value: ["alpha"] })
      }),
      new AgentEvent.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: source.digest,
        outcome: new Cell.Settled({ transition })
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition
      }),
      new AgentEvent.SteeringDrained({
        eventType: "flows.harness.steering-drained.v1",
        messages: [ModelRequest.Message.user("then steer")]
      }),
      new AgentEvent.Suspended({ eventType: "flows.harness.suspended.v1", reason }),
      new AgentEvent.Aborted({ eventType: "flows.harness.aborted.v1", reason: "host interrupted" })
    ]

    for (const event of events) {
      expect(event.eventType).toMatch(/\.v1$/)
      expect(Schema.decodeUnknownResult(AgentEvent.AgentEvent)(event)._tag).toBe("Success")
    }

    const projected = Result.getOrThrow(
      Transcript.projectStateResult(events.map((event, index) => entry(index + 1, event.eventType, event)))
    )
    // The transcript grows: the compaction summary leads, the model's own reply
    // follows, and the steer lands after it. A `continue` replaces nothing.
    expect(projected.messages.map(({ message }) => message)).toEqual([
      ModelRequest.Message.user("compacted"),
      ModelRequest.Message.assistant("cell source", { stopReason: "stop" }),
      ModelRequest.Message.user("then steer")
    ])
    expect(projected.cell.produced).toEqual([source])
    expect(projected.cell.callsStarted).toEqual([call])
    expect(projected.cell.callsSettled).toHaveLength(1)
    expect(projected.cell.settled).toHaveLength(1)
    expect(projected.cell.transitions).toEqual([transition])
    expect(projected.cell.suspensions).toEqual([reason])
    expect(projected.cell.aborts).toEqual(["host interrupted"])
  })

  it("merges a cell's print and rejection into one user turn", () => {
    const cell = "cell-rejected"

    expect(project([
      entry(
        1,
        AgentEvent.eventType.cellPrinted,
        new AgentEvent.CellPrinted({ eventType: AgentEvent.eventType.cellPrinted, cell, text: "before failing" })
      ),
      entry(
        2,
        AgentEvent.eventType.cellSettled,
        new AgentEvent.CellSettled({
          eventType: AgentEvent.eventType.cellSettled,
          cell,
          outcome: new Cell.Rejected({ code: "invalid_transition", message: "emit a corrected cell" })
        })
      )
    ])).toEqual([
      ModelRequest.Message.user(`${printsObservation("before failing")}\n\nemit a corrected cell`)
    ])
  })

  it("merges an empty print observation and raise into one user turn", () => {
    const cell = "cell-raised"

    expect(project([
      entry(
        1,
        AgentEvent.eventType.cellPrinted,
        new AgentEvent.CellPrinted({ eventType: AgentEvent.eventType.cellPrinted, cell, text: "" })
      ),
      entry(
        2,
        AgentEvent.eventType.cellSettled,
        new AgentEvent.CellSettled({
          eventType: AgentEvent.eventType.cellSettled,
          cell,
          outcome: new Cell.Raised({ name: "RangeError", message: "off by one" })
        })
      )
    ])).toEqual([
      ModelRequest.Message.user(
        "Your cell printed nothing, so this turn opens with nothing new to read. Everything it bound is still in the realm; print what you need to look at.\n\n" +
          "The cell threw RangeError: off by one. Emit a corrected cell."
      )
    ])
  })

  it("keeps a rejected settlement standalone without a preceding print", () => {
    const rejected = new AgentEvent.CellSettled({
      eventType: "flows.harness.cell-settled.v1",
      cell: "",
      outcome: new Cell.Rejected({ code: "no_cell", message: "emit a cell" })
    })
    const raised = new AgentEvent.CellSettled({
      eventType: "flows.harness.cell-settled.v1",
      cell: "cell-1",
      outcome: new Cell.Raised({ name: "RangeError", message: "off by one" })
    })
    const complete = new AgentEvent.TransitionApplied({
      eventType: "flows.harness.transition-applied.v1",
      transition: new Cell.Complete({ output: "done" })
    })
    expect(
      project([
        entry(1, rejected.eventType, rejected),
        entry(2, raised.eventType, raised),
        entry(3, complete.eventType, complete)
      ])
    )
      .toEqual([
        ModelRequest.Message.user("emit a cell"),
        ModelRequest.Message.user("The cell threw RangeError: off by one. Emit a corrected cell.")
      ])
  })

  it("rebuilds every journaled demand as the exact user message issued live", () => {
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.ReadOnlyDemandIssued({
        eventType: AgentEvent.eventType.readOnlyDemandIssued,
        streak: 12,
        cap: 12,
        nextFrame: 13
      }),
      new AgentEvent.RepeatDemanded({
        eventType: AgentEvent.eventType.repeatDemanded,
        frames: 4,
        cap: 4,
        nextFrame: 14
      }),
      new AgentEvent.UnmovedDemanded({
        eventType: AgentEvent.eventType.unmovedDemanded,
        openedDigest: "opened",
        currentDigest: "opened",
        nextFrame: 15
      }),
      new AgentEvent.UnresolvedDemanded({
        eventType: AgentEvent.eventType.unresolvedDemanded,
        flow: "bash",
        failed: "pytest tests",
        instead: "pytest tests -k one",
        currentDigest: "current",
        nextFrame: 16
      }),
      new AgentEvent.FailedCallDemanded({
        eventType: AgentEvent.eventType.failedCallDemanded,
        failures: [{ flow: "agent.delegate", message: "Flow agent.delegate failed: Three workers are active" }],
        nextFrame: 16
      }),
      new AgentEvent.UnobservedDemanded({
        eventType: AgentEvent.eventType.unobservedDemanded,
        calls: [{ flow: "bash", ordinal: 2, ok: true, summary: "{\"stdout\":\"README\"}" }],
        nextFrame: 16
      }),
      new AgentEvent.OutputDemanded({
        eventType: AgentEvent.eventType.outputDemanded,
        note: "## Your previous answer did not validate",
        nextFrame: 16
      }),
      new AgentEvent.NarrowedDemanded({
        eventType: AgentEvent.eventType.narrowedDemanded,
        flow: "bash",
        broader: "pytest tests",
        narrower: "pytest tests -k one",
        broaderDigest: "before",
        currentDigest: "after",
        nextFrame: 17
      }),
      new AgentEvent.NarrowOnlyDemanded({
        eventType: AgentEvent.eventType.narrowOnlyDemanded,
        flow: "bash",
        check: "pytest tests/a.py tests/b.py -k one",
        targets: ["tests/a.py", "tests/b.py"],
        currentDigest: "after",
        nextFrame: 18
      }),
      // The reading that let a completion through is journaled and put
      // nothing in front of the model, so the replay must skip it.
      new AgentEvent.ClaimDemanded({
        eventType: AgentEvent.eventType.claimDemanded,
        complete: 0.92,
        overclaims: 0.06,
        invented: 0.04,
        latencyMs: 310,
        demanded: false,
        currentDigest: "after",
        nextFrame: 19
      }),
      new AgentEvent.ClaimDemanded({
        eventType: AgentEvent.eventType.claimDemanded,
        complete: 0.14,
        overclaims: 0.2,
        invented: 0.88,
        latencyMs: 402,
        demanded: true,
        currentDigest: "after",
        nextFrame: 20
      })
    ]

    expect(project(events.map((event, index) => entry(index + 1, event.eventType, event)))).toEqual([
      ModelRequest.Message.user(DemandText.readOnly(12, 12)),
      ModelRequest.Message.user(DemandText.repeat(4, 4)),
      ModelRequest.Message.user(DemandText.unmoved("opened", "opened")),
      ModelRequest.Message.user(DemandText.unresolved("bash", "pytest tests", "pytest tests -k one")),
      ModelRequest.Message.user(
        FailedCall.demand([{ flow: "agent.delegate", message: "Flow agent.delegate failed: Three workers are active" }])
      ),
      ModelRequest.Message.user(
        UnobservedCall.demand([{ flow: "bash", ordinal: 2, ok: true, summary: "{\"stdout\":\"README\"}" }])
      ),
      ModelRequest.Message.user("## Your previous answer did not validate"),
      ModelRequest.Message.user(DemandText.narrowed("bash", "pytest tests", "pytest tests -k one")),
      ModelRequest.Message.user(
        DemandText.narrowOnly("bash", "pytest tests/a.py tests/b.py -k one", ["tests/a.py", "tests/b.py"])
      ),
      ModelRequest.Message.user(DemandText.claim())
    ])
  })

  it("does not merge a settlement with the immediately preceding print from another cell", () => {
    const print = (seq: number, cell: string, text: string) =>
      entry(
        seq,
        AgentEvent.eventType.cellPrinted,
        new AgentEvent.CellPrinted({ eventType: AgentEvent.eventType.cellPrinted, cell, text })
      )
    const settled = new AgentEvent.CellSettled({
      eventType: AgentEvent.eventType.cellSettled,
      cell: "cell-a",
      outcome: new Cell.Rejected({ code: "invalid_transition", message: "try cell-a again" })
    })

    expect(project([
      print(1, "cell-a", "from a"),
      print(2, "cell-b", "from b"),
      entry(3, settled.eventType, settled)
    ])).toEqual([
      ModelRequest.Message.user(printsObservation("from a")),
      ModelRequest.Message.user(printsObservation("from b")),
      ModelRequest.Message.user("try cell-a again")
    ])
  })

  it("projects an empty journal as an empty transcript", () => {
    const state = Result.getOrThrow(Transcript.projectStateResult([]))

    expect(state.messages).toEqual([])
    expect(state.replaced).toBeUndefined()
    expect(state.cell).toEqual({
      produced: [],
      printed: [],
      callsStarted: [],
      callsSettled: [],
      settled: [],
      transitions: [],
      suspensions: [],
      aborts: []
    })
    expect(Result.getOrThrow(Transcript.projectResult([]))).toEqual([])
  })

  it("rebuilds the window the next turn read, prints included", () => {
    // `CellPrinted` was journaled and never projected, so a transcript rebuilt
    // from a harness-native journal was missing the entire context channel:
    // what a cell printed IS what the next model turn reads.
    //
    // The journal carries the raw buffer and the controller sends
    // `printsObservation` of it, so the projection has to render the same way
    // or it rebuilds a window the run never had. An empty buffer is a message
    // too: the turn it opened told the model the realm still holds what the
    // cell bound. Replaying the raw text, or dropping the empty one, is a
    // window that differs from the one the model was actually sent.
    const source = Cell.source("console.log(\"found it\")")
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.ModelSettled({
        eventType: AgentEvent.eventType.modelSettled,
        message: ModelRequest.Message.assistant("here is the cell", { stopReason: "stop" }),
        usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
      }),
      new AgentEvent.CellProduced({ eventType: AgentEvent.eventType.cellProduced, cell: source }),
      new AgentEvent.CellPrinted({
        eventType: AgentEvent.eventType.cellPrinted,
        cell: source.digest,
        text: "found it"
      }),
      new AgentEvent.CellSettled({
        eventType: AgentEvent.eventType.cellSettled,
        cell: source.digest,
        outcome: new Cell.Settled({ transition: new Cell.Continue({}) })
      }),
      new AgentEvent.CellPrinted({
        eventType: AgentEvent.eventType.cellPrinted,
        cell: source.digest,
        text: ""
      })
    ]
    const entries = events.map((event, index) =>
      entry(index + 1, event.eventType, Schema.encodeSync(AgentEvent.AgentEvent)(event))
    )

    const state = Result.getOrThrow(Transcript.projectStateResult(entries))

    expect(state.messages.map((item) => item.message.role)).toEqual(["assistant", "user", "user"])
    expect(state.messages[1]?.message).toEqual(
      ModelRequest.Message.user(printsObservation("found it"))
    )
    expect(state.messages[2]?.message).toEqual(
      ModelRequest.Message.user(
        "Your cell printed nothing, so this turn opens with nothing new to read. Everything it bound is still in the realm; print what you need to look at."
      )
    )
    expect(state.cell.printed.map((event) => event.text)).toEqual(["found it", ""])
  })

  it("refuses a malformed print buffer rather than projecting a window without it", () => {
    const result = Transcript.projectStateResult([
      entry(1, AgentEvent.eventType.cellPrinted, { eventType: AgentEvent.eventType.cellPrinted, cell: 7 })
    ])

    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
  })

  it("keeps the journal event-type table in step with the event union", () => {
    // The literal used to be written three times: on the class, in the
    // controller's emitter, and again in this projection's decoder. A decoder
    // reading a literal the emitter no longer writes returns an empty
    // transcript and fails nothing.
    const declared = Object.values(AgentEvent.eventType)

    expect(new Set(declared).size).toBe(declared.length)
    for (const value of declared) expect(value).toMatch(/^flows\.harness\.[a-z-]+\.v1$/)
  })

  it("rejects malformed drained steering rather than projecting a partial turn", () => {
    const result = Transcript.projectStateResult([
      entry(1, "flows.harness.steering-drained.v1", { eventType: "flows.harness.steering-drained.v1" })
    ])

    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
    expect(Result.isFailure(result) && result.failure.message).toBe(
      "Invalid flows.harness.steering-drained.v1 payload at journal sequence 1"
    )
  })

  it("returns a typed failure when a payload cannot be decoded", () => {
    const state = Transcript.projectStateResult([
      entry(1, "flows.harness.model-settled.v1", { message: "bad" }),
      entry(2, "flows.harness.compaction-settled.v1", { replacedPrefixDigest: "prefix", summary: "bad" })
    ])

    expect(Result.isFailure(state)).toBe(true)
    if (Result.isFailure(state)) expect(state.failure.code).toBe("projection_failed")
  })

  it("keeps only the last compaction and everything sequenced after it", () => {
    const compaction = (seq: number, digest: string, summary: string) =>
      entry(
        seq,
        "flows.harness.compaction-settled.v1",
        new AgentEvent.CompactionSettled({
          eventType: "flows.harness.compaction-settled.v1",
          replacedPrefixDigest: digest,
          summary: ModelRequest.Message.user(summary)
        })
      )
    const settled = (seq: number, text: string) =>
      entry(
        seq,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant(text, { stopReason: "stop" }),
          usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
        })
      )

    const state = Result.getOrThrow(Transcript.projectStateResult([
      settled(1, "before the first"),
      compaction(2, "first-prefix", "first summary"),
      settled(3, "between"),
      compaction(4, "second-prefix", "second summary"),
      settled(5, "after the second")
    ]))

    expect(state.replaced).toBe("second-prefix")
    expect(state.messages).toEqual([
      { kind: "summary", message: ModelRequest.Message.user("second summary") },
      { kind: "transcript", message: ModelRequest.Message.assistant("after the second", { stopReason: "stop" }) }
    ])
  })

  it("projects only the summary when compaction is the last entry", () => {
    const entries = [
      ...journal().filter((item) => item.seq <= 8)
    ]

    const state = Result.getOrThrow(Transcript.projectStateResult(entries))

    expect(state.messages).toEqual([
      { kind: "summary", message: ModelRequest.Message.user("First turn summary") }
    ])
  })

  it("strips continuation metadata from an aborted turn as well as a failed one", () => {
    const messages = project([
      entry(
        1,
        "flows.harness.model-settled.v1",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: ModelRequest.Message.assistant([
            ModelRequest.ThinkingPart.make({ text: "half a thought", signature: "provider-signature" }),
            ModelRequest.TextPart.make({ text: "half an answer" })
          ], {
            stopReason: "aborted",
            responseId: "aborted-response",
            itemIds: ["aborted-item"]
          }),
          usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 0 })
        })
      )
    ])

    expect(messages).toEqual([
      ModelRequest.Message.assistant([
        ModelRequest.ThinkingPart.make({ text: "half a thought" }),
        ModelRequest.TextPart.make({ text: "half an answer" })
      ], { stopReason: "aborted" })
    ])
  })

  it("keeps the transcript whatever the transition was", () => {
    const settled = entry(
      1,
      "flows.harness.model-settled.v1",
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: ModelRequest.Message.assistant("kept", { stopReason: "stop" }),
        usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
      })
    )
    const applied = (seq: number, transition: Cell.Transition) =>
      entry(
        seq,
        "flows.harness.transition-applied.v1",
        new AgentEvent.TransitionApplied({ eventType: "flows.harness.transition-applied.v1", transition })
      )

    const parked = project([
      settled,
      applied(2, new Cell.Park({ reason: "waiting-event", message: "waiting on CI" }))
    ])
    const continued = project([settled, applied(2, new Cell.Continue({}))])
    // The decode-only half, replayed. A journal from the r90–r96 waves carries
    // a `continue` that filed state and chose its successor's whole context,
    // and it is the one input that could still make this projection behave like
    // the deleted surface. It decodes, and the entries are not read: without
    // this case every transition under test is empty, so the branch that used
    // to replace the prefix could come back unnoticed.
    const filed = project([
      settled,
      applied(
        2,
        Schema.decodeUnknownSync(Cell.Transition)({
          _tag: "continue",
          state: { step: 2 },
          context: [{ role: "assistant", text: "only this" }],
          render: ["step"],
          recall: [1]
        })
      )
    ])

    // No transition replaces the transcript: what the model said stays said,
    // whichever way the frame ended.
    expect(parked).toEqual([ModelRequest.Message.assistant("kept", { stopReason: "stop" })])
    expect(continued).toEqual([ModelRequest.Message.assistant("kept", { stopReason: "stop" })])
    expect(filed).toEqual([ModelRequest.Message.assistant("kept", { stopReason: "stop" })])
  })

  it("projects a cell that settled cleanly without adding a correction message", () => {
    const settled = new AgentEvent.CellSettled({
      eventType: "flows.harness.cell-settled.v1",
      cell: "cell-1",
      outcome: new Cell.Settled({ transition: new Cell.Complete({ output: "done" }) })
    })

    const state = Result.getOrThrow(Transcript.projectStateResult([entry(1, settled.eventType, settled)]))

    expect(state.messages).toEqual([])
    expect(state.cell.settled).toHaveLength(1)
  })

  it.each([
    "flows.harness.cell-produced.v1",
    "flows.harness.cell-call-started.v1",
    "flows.harness.cell-call-settled.v1",
    "flows.harness.cell-settled.v1",
    "flows.harness.transition-applied.v1",
    "flows.harness.suspended.v1",
    "flows.harness.aborted.v1",
    "flows.harness.read-only-demand-issued.v1",
    "flows.harness.repeat-demanded.v1",
    "flows.harness.narrowed-demanded.v1",
    "flows.harness.narrow-only-demanded.v1",
    "flows.harness.unmoved-demanded.v1",
    "flows.harness.unresolved-demanded.v1",
    "flows.harness.failed-call-demanded.v1",
    "flows.harness.unobserved-demanded.v1",
    "flows.harness.output-demanded.v1",
    "flows.harness.claim-demanded.v1"
  ])("rejects malformed %s evidence", (eventType) => {
    const result = Transcript.projectStateResult([entry(1, eventType, { eventType })])
    expect(Result.isFailure(result) && result.failure.code).toBe("projection_failed")
  })
})
