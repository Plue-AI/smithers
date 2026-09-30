/**
 * Every Jev gate armed in one judged run, interrupted after its compaction
 * and resumed from its checkpointed state.
 *
 * The run withholds a flow and an instruction chunk at run start, restores
 * the flow on a call, delivers a recalled memory row and a monitor from the
 * supervisor's readings, and compacts by Jev's marks. The resume replays
 * every recorded boundary without asking Jev again and ends exactly as the
 * uninterrupted run does.
 */
import { ModelRequest } from "@smthrs/model"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Deferred, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type * as AgentEvent from "../src/AgentEvent.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as Monitor from "../src/Monitor.ts"
import type * as Relevance from "../src/Relevance.ts"
import * as Steering from "../src/Steering.ts"
import * as Supervisor from "../src/Supervisor.ts"
import { descriptor, emits, of, pattern, prose, run } from "./fixtures/cellTurn.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const read = descriptor("read", { capabilities: ["fs:read:**"] })
const search = descriptor("mcp.search")
const catalog = [read, search]

const instructions: ReadonlyArray<Relevance.Document> = [{
  path: "AGENTS.md",
  text: "- Run the parser tests with pnpm test.\n- Deploy only from the release branch.\n- Keep commits small.\n"
}]

const layout: Supervisor.Recalled = { key: "layout", text: "Sources live under src/." }

const noTestEdits = Monitor.make({
  _tag: "Questioned",
  id: "no_test_edits",
  kind: "lint",
  question: Classifier.boolean({
    instructions: "Did the newest frames edit a test?",
    criteria: { true: "a test file was edited", false: "no test file was edited" }
  }),
  say: () => "Leave the tests alone."
})

/** What Jev was asked, one entry per request: the gate and, for a supervisor reading, its frame. */
type Asked = "completion" | "relevance" | "memory" | "marks" | `supervisor:${number}`

/**
 * One Jev for every classifier the run asks. Run start withholds
 * `mcp.search` and the deploy chunk; the recalled row is kept; the marks
 * remove the oldest prefix frame and squash the rest; the reading of frame 1
 * crosses the lint.
 */
const jev = () => {
  const asked: Array<Asked> = []
  const layer = Evaluator.layerScripted((request) => {
    const ids = Object.keys(request.questions)
    if (ids.includes("complete")) {
      asked.push("completion")
      return {
        complete: { probability: 0.99 },
        overclaims: { probability: 0.01 },
        invented: { probability: 0.01 },
        requiresWorkspaceChange: { probability: 0.5 },
        reportsLimitation: { probability: 0 }
      }
    }
    if (ids.includes("unnecessary_0")) {
      const items = (request.state as { readonly items: ReadonlyArray<Relevance.Item> }).items
      asked.push(items.every((item) => item.kind === "memory") ? "memory" : "relevance")
      const withheld = new Set(["mcp.search", "AGENTS.md#1"])
      return Object.fromEntries(
        items.map((item, index) => [`unnecessary_${index}`, { probability: withheld.has(item.id) ? 0.95 : 0.3 }])
      )
    }
    if (ids.includes("remove_0")) {
      asked.push("marks")
      return Object.fromEntries(
        ids.map((id) => [id, { probability: id === "remove_0" ? 0.95 : 0.05 }])
      )
    }
    const frame = (request.state as { readonly frames: ReadonlyArray<{ readonly frame: number }> }).frames.at(-1)!
      .frame
    asked.push(`supervisor:${frame}`)
    return Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        question.type === "boolean"
          ? {
            probability: id === "on_target"
              ? 0.95
              : id === `${Supervisor.monitorPrefix}no_test_edits` && frame === 1
              ? 0.9
              : 0.05
          }
          : question.type === "score"
          ? { score: 0 }
          : { choice: "none" }
      ])
    )
  })
  return { asked, layer }
}

/**
 * Holds each boundary open until the supervisor has read the frame before
 * it, so what a boundary delivers does not depend on scheduling. A boundary
 * at or before `live` does not wait, because a resume replays the frame
 * before it and never reads it again; the boundary at `interrupt` is
 * interrupted once that reading is recorded.
 */
const untilRead = (live: number, interrupt: number | undefined) => {
  const gates = new Map<number, Deferred.Deferred<void>>()
  const gate = (frame: number) => {
    const held = gates.get(frame)
    if (held !== undefined) return held
    const made = Effect.runSync(Deferred.make<void>())
    gates.set(frame, made)
    return made
  }
  return {
    observer: (event: AgentEvent.AgentEvent) =>
      event._tag === "supervisor-settled" || event._tag === "supervisor-unjudged"
        ? Effect.asVoid(Deferred.succeed(gate(event.frame), undefined))
        : Effect.void,
    steering: Steering.layer({
      read: () => Effect.succeed(Steering.empty()),
      drain: (input) => {
        const frame = Number(input.boundary.split(":")[0])
        return (frame <= live ? Effect.void : Deferred.await(gate(frame - 1))).pipe(
          Effect.andThen(frame === interrupt ? Effect.interrupt : Effect.void),
          Effect.as({
            inserts: [],
            seatChanges: [],
            remaining: Steering.empty(),
            queued: false,
            duplicate: false
          })
        )
      }
    })
  }
}

const opening = CellTurn.teach(
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "host safety rules" })] },
      CellTurn.instructionsSegment(instructions, new Set()),
      {
        kind: "instructions",
        zone: "prefix",
        content: [ModelRequest.SystemPart.make({ text: "The task for this run:\n\nFix the parser." })]
      },
      { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("Begin.")] }
    ]
  }),
  catalog
)

/** The state every attempt starts from, which a checkpoint holds encoded. */
const checkpointed = (): CellTurn.State =>
  Schema.decodeUnknownSync(CellTurn.State)(
    Schema.encodeUnknownSync(CellTurn.State)(CellTurn.make({
      session: "session-1",
      seat: "anthropic:test-model",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: ["layer-a"],
      capabilityEnvelope: [pattern("fs:read:**")],
      placement: Option.none(),
      contextWindow: opening,
      contextWindowTokens: 30_000,
      maxFrames: 12,
      repeatCap: 0,
      narrowingCap: 0,
      unmovedCap: 0,
      unresolvedCap: 0
    }))
  )

const big = `console.log("${"x".repeat(15_000)}")`

/** Two calls to the withheld flow, frames large enough to compact, the summary, and the completion. */
const script: ScriptedModel.Script = [
  emits(`var withheld = await ctx.call("mcp.search", {}); console.log(withheld.error.code)`),
  emits(`console.log(await ctx.call("mcp.search", {}))`),
  ...Array.from({ length: 4 }, () => emits(big)),
  prose("the compacted summary"),
  emits(`ctx.done("done")`)
]

/** The completing frame, which follows the compaction. */
const completing = 6

const attempt = async (
  records: Map<string, unknown>,
  steering: { readonly live: number; readonly interrupt?: number } = { live: 0 }
) => {
  const judge = jev()
  const reading = untilRead(steering.live, steering.interrupt)
  const outcome = await run({
    script,
    state: checkpointed(),
    flows: catalog,
    calls: [{ _tag: "Success", value: "hits" }],
    evaluator: judge.layer,
    judged: true,
    instructions,
    pinned: ["read"],
    monitors: [noTestEdits],
    memory: { bound: true, recall: () => Effect.succeed([layout]), remember: () => Effect.void },
    steering: reading.steering,
    observer: reading.observer,
    records
  })
  return { ...outcome, asked: judge.asked }
}

/**
 * The loop's own events from the `n`th opened turn on. Supervisor readings,
 * and the compaction marks they carry, settle off the hot path, and neither a model step's wall-clock duration nor
 * a reading's latency is part of what it settled: a resumed run replays the
 * interrupted run's latency, which the uninterrupted run measured afresh.
 */
const suffix = (events: ReadonlyArray<AgentEvent.AgentEvent>, n: number) => {
  const opened = events.flatMap((event, index) => event._tag === "turn-opened" ? [index] : [])
  return events.slice(opened[n]).flatMap((event) =>
    event._tag === "supervisor-settled" ||
      (event._tag === "decision-settled" &&
        (event.classifier.startsWith("supervisor/") || event.classifier === "compaction/marks"))
      ? []
      : [
        event._tag === "model-settled"
          ? { ...event, durationMillis: 0 }
          : "latencyMs" in event
          ? { ...event, latencyMs: 0 }
          : event
      ]
  )
}

describe("every gate armed in one run", () => {
  it("resumes after compaction from its checkpoint without asking Jev for anything it recorded", async () => {
    const whole = await attempt(new Map())
    expect(whole.failure).toBeUndefined()
    expect(whole.interrupted).toBe(false)

    const records = new Map<string, unknown>()
    const first = await attempt(records, { live: 0, interrupt: completing })
    expect(first.interrupted).toBe(true)

    // Each gate did its work before the interruption.
    const settled = of(first.events, "relevance-settled").find((event) => event.source === "run")!
    expect(settled.withheld.map((item) => item.id)).toEqual(["mcp.search", "AGENTS.md#1"])
    expect(first.model.recorder.requests[0]!.system.map((part) => part.text).join("\n")).not.toContain(
      "Deploy only from the release branch"
    )
    expect(of(first.events, "cell-printed")[0]!.text).toContain("flow_withheld")
    expect(of(first.events, "relevance-restored")).toEqual([
      expect.objectContaining({ scope: "session-1", frame: 0, flow: "mcp.search" })
    ])
    const drained = of(first.events, "steering-drained")
    expect(drained.flatMap((event) => event.memory ?? [])).toEqual(["layout"])
    expect(drained.flatMap((event) => event.monitor === undefined ? [] : [event.monitor])).toEqual(["no_test_edits"])
    const compacted = of(first.events, "compaction-settled")
    expect(compacted).toHaveLength(1)
    expect(compacted[0]!.marks?.[0]?.mark).toBe("remove")
    expect(first.asked).toContain("marks")

    // The gates' boundaries never share a key, so none can serve another's record.
    const gated = first.engine.recorder.records.filter((boundary) =>
      boundary.name === "relevance" || boundary.name === "compaction-marks" || boundary.name === "supervisor"
    ).map((boundary) =>
      `${boundary.identity.session}\u0000${boundary.identity.frame}\u0000${boundary.identity.boundary}`
    )
    expect(gated.filter((key) => key.includes("\u0000relevance"))).toHaveLength(1)
    // Every segment was marked from a supervisor reading before the budget
    // fired, so the compaction took no reading of its own.
    expect(gated.filter((key) => key.includes("\u0000compaction-marks:"))).toEqual([])
    expect(gated.filter((key) => key.includes("\u0000supervisor:")).length).toBeGreaterThanOrEqual(2)
    expect(new Set(gated).size).toBe(gated.length)

    // The resume replays every recorded reading and asks only about frames it runs live.
    const interruptedAt = of(first.events, "turn-opened").length - 1
    expect(interruptedAt).toBe(completing)
    const resumed = await attempt(records, { live: completing })
    expect(resumed.failure).toBeUndefined()
    expect(first.asked).toEqual(whole.asked.slice(0, first.asked.length))
    expect(resumed.asked).toEqual(["completion"])
    expect(suffix(resumed.events, interruptedAt)).toEqual(suffix(whole.events, interruptedAt))
    expect(of(suffix(resumed.events, interruptedAt), "resolved")).toHaveLength(1)
    expect(resumed.model.recorder.requests).toEqual(whole.model.recorder.requests)

    // What a checkpoint after the interruption carries survives its codec.
    const drains = [...records].filter(([key]) => key.startsWith("steering-drain\u0000"))
      .map(([, held]) => Schema.decodeUnknownSync(Steering.DrainRecord)(held))
    const ledger = drains.map((record) => record.monitorLedger).filter((carried) => carried !== undefined).at(-1)!
    const answer = drains.flatMap((record) => record.marks ?? [])[0]!
    const carried = new CellTurn.State({
      ...checkpointed(),
      withheldFlows: settled.withheld.filter((item) => item.kind === "flow").map((item) => item.id),
      memoryShown: drained.flatMap((event) => event.memory ?? []),
      monitorLedger: ledger,
      segmentFacts: [{
        frame: 3,
        person: false,
        mutated: true,
        checks: ["parser"],
        answer: { remove: answer.remove, keep: answer.keep }
      }]
    })
    const decoded = Schema.decodeUnknownSync(CellTurn.State)(Schema.encodeUnknownSync(CellTurn.State)(carried))
    expect(decoded.withheldFlows).toEqual(["mcp.search"])
    expect(decoded.memoryShown).toEqual(["layout"])
    expect(decoded.monitorLedger["no_test_edits"]).toMatchObject({ delivered: 1 })
    expect(decoded.segmentFacts).toEqual(carried.segmentFacts)
    expect(decoded).toEqual(carried)
  })
})
