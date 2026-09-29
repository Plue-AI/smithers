/**
 * The transcript miner: its core over rows, and the one run-end reading
 * `Agent.run` takes of its own transcript when `supervisor.remember` is on.
 *
 * The core cases run over the real `@smthrs/memory` store (`TestMemory`,
 * in-memory SQLite). The `Agent.run` cases drive the production agent on the
 * real durable engine; only the model and Jev are scripted.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as EngineLike from "@smthrs/harness/EngineLike"
import { HarnessError } from "@smthrs/harness/HarnessError"
import type * as Supervisor from "@smthrs/harness/Supervisor"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Deferred, Effect, Exit, Layer, Metric, Option, Schema, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as MemoryMine from "../src/MemoryMine.ts"
import { answererFor } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as Safety from "./Safety.ts"

const bank = "project-0123456789abcdef"
const build = "The tests run with `pnpm vitest` from packages/foo."
const plan = "I will now edit the file."
const output = "Build output lands in dist/esm."

type Answers = Readonly<Record<string, Evaluator.ScriptedAnswer>>

/** Jev for `memory/mine`: each item's `durable` from `durable`, its `issue` from `issue`, every request recorded. */
const mining = (
  durable: Readonly<Record<string, number>>,
  asked: Array<ReadonlyArray<string>>,
  issue: Readonly<Record<string, number>> = {}
) =>
(request: Evaluator.Request): Answers => {
  const items = (request.state as { readonly items: ReadonlyArray<{ readonly text: string }> }).items
  asked.push(items.map((item) => item.text))
  return Object.fromEntries(items.flatMap((item, index) => [
    [`durable_${index}`, { probability: durable[item.text] ?? 0 }],
    [`issue_${index}`, { probability: issue[item.text] ?? 0 }]
  ]))
}

const isMine = (request: Evaluator.Request): boolean => Object.hasOwn(request.questions, "durable_0")

const failing = (code: Evaluator.EvaluatorErrorCode) =>
  Effect.fail(new Evaluator.EvaluatorError({ code, message: `jev ${code}` }))

describe("sentences", () => {
  it("offers the first four prose paragraphs, never a fenced block, each clipped", () => {
    expect(MemoryMine.sentences("")).toEqual([])
    expect(MemoryMine.sentences("one\n\n```\ncode\n```\n\ntwo\n\n  \n\nthree\n\nfour\n\nfive")).toEqual([
      "one",
      "two",
      "three",
      "four"
    ])
    const long = "x".repeat(MemoryMine.candidateChars + 5)
    const [clipped] = MemoryMine.sentences(long)
    expect(clipped).toHaveLength(MemoryMine.candidateChars)
    expect(clipped!.endsWith("…")).toBe(true)
    expect(MemoryMine.sentences("x".repeat(MemoryMine.candidateChars))[0]).toHaveLength(MemoryMine.candidateChars)
  })

  it("strips every fenced block before splitting, a blank line inside one included", () => {
    const prose = [
      "Set it up:",
      "```bash\nexport DB_HOST=prod-db.internal\n\nrun migrate\n```",
      "~~~\nsecond block\n\nstill code\n~~~",
      "````md\n```\nnested\n\n```\n````",
      "Done.",
      "```python\nunclosed\n\nruns to the end"
    ].join("\n\n")
    expect(MemoryMine.sentences(prose)).toEqual(["Set it up:", "Done."])
  })

  it("redacts the whole reply before a clip can cut a secret in two", () => {
    const token = `ghp_${"A1b2C3d4".repeat(5)}`
    const straddling = `${"a".repeat(MemoryMine.candidateChars - 10)} ${token} trailing words`
    const [clipped] = MemoryMine.sentences(straddling)
    // Clipped in the redaction's marker, never in the token.
    expect(clipped).toBe(`${"a".repeat(MemoryMine.candidateChars - 10)} [REDACTE…`)

    const body = Array.from(
      { length: 12 },
      (_, line) => `MIIEpAIBAAKCAQEA${String(line).padStart(2, "0")}${"q".repeat(46)}`
    )
    const pem = `The deploy key is\n-----BEGIN RSA PRIVATE KEY-----\n${body.join("\n")}\n-----END RSA PRIVATE KEY-----`
    const [key] = MemoryMine.sentences(pem)
    expect(key).toContain("The deploy key is")
    expect(key).not.toContain("MIIEpAIBAAKCAQEA")
    expect(key).not.toContain("BEGIN RSA PRIVATE KEY")
  })
})

describe("extract", () => {
  const rows: ReadonlyArray<MemoryMine.Row> = [
    {
      seq: 9,
      eventType: "flows.harness.model-settled.v1",
      payload: { message: { content: [{ type: "text", text: output }] } }
    },
    {
      seq: 3,
      eventType: "control.agent.model-settled",
      payload: { text: `${build}\n\n${plan}\n\n\`\`\`cell\nctx.call("bash", { cmd: "ls" })\n\`\`\`` }
    },
    {
      seq: 5,
      eventType: "control.agent.steering-drained",
      payload: {
        messages: [
          { role: "user", text: "Use SQLite, not Postgres." },
          { role: "user", text: "   " },
          { role: "assistant", text: "Continuing." }
        ]
      }
    },
    {
      seq: 8,
      eventType: "flows.harness.model-settled.v1",
      payload: {
        content: [{ type: "text", text: "The  tests run with `pnpm vitest`   from packages/foo." }, {
          type: "tool-call"
        }, "x"]
      }
    },
    {
      seq: 10,
      eventType: "flows.harness.steering-drained.v1",
      payload: {
        messages: [{ role: "user", content: [{ type: "text", text: "Ship it with key sk-live-abcdefghijklmnop." }] }]
      }
    },
    { seq: 11, eventType: "flows.harness.steering-drained.v1", payload: { messages: "none" } },
    { seq: 12, eventType: "flows.harness.model-settled.v1", payload: { message: { content: "none" } } },
    { seq: 13, eventType: "flows.harness.model-settled.v1", payload: null },
    { seq: 14, eventType: "control.agent.cell-produced", payload: { text: "ignored" } }
  ]

  it("reads prose candidates and human decisions in sequence order, distinct and redacted", () => {
    const { candidates, decisions } = MemoryMine.extract(rows)
    expect(candidates).toEqual([{ text: build, seq: 3 }, { text: plan, seq: 3 }, { text: output, seq: 9 }])
    expect(decisions).toEqual([
      { text: "Use SQLite, not Postgres.", seq: 5 },
      { text: "Ship it with key [REDACTED_API_KEY].", seq: 10 }
    ])
  })

  it("keeps at most the candidate and decision limits, first seen first", () => {
    const many: Array<MemoryMine.Row> = Array.from({ length: MemoryMine.candidateLimit + 3 }, (_, seq) => ({
      seq,
      eventType: "control.agent.model-settled",
      payload: { text: `Fact number ${seq}.` }
    }))
    many.push({
      seq: 1_000,
      eventType: "control.agent.steering-drained",
      payload: {
        messages: Array.from(
          { length: MemoryMine.decisionLimit + 2 },
          (_, index) => ({ role: "user", text: `d${index}` })
        )
      }
    })
    const { candidates, decisions } = MemoryMine.extract(many)
    expect(candidates).toHaveLength(MemoryMine.candidateLimit)
    expect(candidates.at(-1)).toEqual({ text: `Fact number ${MemoryMine.candidateLimit - 1}.`, seq: 63 })
    expect(decisions).toHaveLength(MemoryMine.decisionLimit)
  })

  it("clips a decision to its bound after redacting the whole message", () => {
    const token = `sk-live-${"k".repeat(40)}`
    const long = `${"s".repeat(MemoryMine.decisionChars - 30)} ${token} ${"t".repeat(100_000)}`
    const { decisions } = MemoryMine.extract([{
      seq: 1,
      eventType: "control.agent.steering-drained",
      payload: { messages: [{ role: "user", text: long }] }
    }])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.text).toHaveLength(MemoryMine.decisionChars)
    expect(decisions[0]!.text).not.toContain("sk-live")
    expect(decisions[0]!.text).toContain("[REDACTED_API_KEY]")
  })
})

describe("judge", () => {
  it("accepts a fact or an issue at 0.70 and not at 0.69, in one request", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const candidates = [{ text: build, seq: 3 }, { text: plan, seq: 3 }, { text: output, seq: 8 }]
    const judged = await Effect.runPromise(
      MemoryMine.judge("fix it", candidates).pipe(
        Effect.provide(Evaluator.layerScripted(mining({ [build]: 0.7, [output]: 0.69 }, asked, { [plan]: 0.7 })))
      )
    )
    expect(asked).toEqual([[build, plan, output]])
    expect(judged.facts).toEqual([candidates[0]])
    expect(judged.issues).toEqual([candidates[1]])
    expect(judged.asked).toHaveLength(1)
    expect(judged.asked[0]!.classifier).toBe("memory/mine")
  })

  it("fails whole with the transport's reason", async () => {
    const result = await Effect.runPromise(
      Effect.flip(MemoryMine.judge("fix it", [{ text: build, seq: 1 }])).pipe(
        Effect.provide(Evaluator.layerScripted(() => failing("refused")))
      )
    )
    expect(result.reason).toBe("refused")
  })
})

describe("write", () => {
  it("writes one redacted, accepted note per fact however it is cased or spaced", async () => {
    const notes = await Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const first = yield* MemoryMine.write(store, { bank, runId: "run-1", text: build })
      const again = yield* MemoryMine.write(store, {
        bank,
        runId: "run-2",
        text: build.replace("pnpm vitest", "PNPM  Vitest")
      })
      yield* MemoryMine.write(store, { bank, runId: "run-1", text: "Deploys use sk-live-abcdefghijklmnop." })
      expect(again.id).toBe(first.id)
      expect(first.id).toBe(MemoryMine.noteId(bank, build))
      return yield* store.listNotes({ namespace: bank })
    }).pipe(Effect.provide(TestMemory.layer), Effect.runPromise)
    // The first run to learn a fact keeps it.
    expect(notes.map((note) => [note.text, note.provenance.runId]).sort()).toEqual([
      ["Deploys use [REDACTED_API_KEY].", "run-1"],
      [build, "run-1"]
    ])
    expect(notes.every((note) => note.status === "accepted" && note.tags.includes("source:transcript"))).toBe(true)
  })

  it("refuses a bank that names no namespace", async () => {
    const error = await Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      return yield* Effect.flip(MemoryMine.write(store, { bank: "", runId: "run-1", text: build }))
    }).pipe(Effect.provide(TestMemory.layer), Effect.runPromise)
    expect(error._tag).toBe("flows/memory/MemoryError")
  })
})

describe("settle", () => {
  /** A port that records every write, refusing the texts in `refuse`. */
  const port = (refuse: ReadonlyArray<string> = []) => {
    const written: Array<string> = []
    const memory: Supervisor.Memory = {
      bound: true,
      recall: () => Effect.succeed([]),
      remember: (text) =>
        refuse.includes(text) ? Effect.fail({ detail: "notes locked" }) : Effect.sync(() => void written.push(text))
    }
    return { memory, written }
  }

  /** An engine whose `record` keeps each value by boundary, and serves it on a second attempt. */
  const recording = () => {
    const records = new Map<string, unknown>()
    return EngineLike.makeNoop({
      record: (boundary) => {
        const key = `${boundary.identity.session}:${boundary.identity.frame}:${boundary.identity.boundary}`
        return records.has(key)
          ? Effect.succeed(records.get(key) as never)
          : Effect.tap(boundary.execute, (value) => Effect.sync(() => void records.set(key, value)))
      }
    })
  }

  const candidates = [{ text: build, seq: 1 }, { text: plan, seq: 1 }, { text: "Refused fact.", seq: 2 }]
  const settle = (
    engine: EngineLike.EngineLike,
    memory: Supervisor.Memory,
    evaluator: (request: Evaluator.Request) => Answers | Effect.Effect<Answers, Evaluator.EvaluatorError>,
    offered = candidates
  ) =>
    MemoryMine.settle({ engine, session: "run-1", frame: 4, task: "fix it", candidates: offered, memory }).pipe(
      Effect.provide(Evaluator.layerScripted(evaluator)),
      Effect.runPromise
    )

  it("writes what Jev accepts, journals the reading and each refused write, and asks nothing on replay", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const engine = recording()
    const { memory, written } = port(["Refused fact."])
    const answer = mining({ [build]: 0.9, "Refused fact.": 0.9 }, asked)
    const events = await settle(engine, memory, answer)
    expect(written).toEqual([build])
    expect(events.map((event) => event._tag)).toEqual(["decision-settled", "supervisor-memory-failed"])
    expect(events[0]).toMatchObject({ scope: "run-1", frame: 4, classifier: "memory/mine", acted: true })
    expect(events[1]).toMatchObject({ scope: "run-1", frame: 4, operation: "remember", detail: "notes locked" })
    const replayed = await settle(engine, memory, answer)
    expect(asked).toHaveLength(1)
    expect(replayed).toEqual(events)
    expect(written).toEqual([build, build])
  })

  it("an engine that cannot record the reading writes nothing and journals the failure", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const { memory, written } = port()
    const engine = EngineLike.makeNoop({
      record: () => Effect.fail(new HarnessError({ code: "engine_failed", message: "journal store locked" }))
    })
    const events = await settle(engine, memory, mining({ [build]: 0.9 }, asked))
    expect(written).toEqual([])
    expect(events).toEqual([
      expect.objectContaining({
        _tag: "supervisor-memory-failed",
        scope: "run-1",
        frame: 4,
        operation: "remember",
        detail: "engine_failed: journal store locked"
      })
    ])
  })

  it("asks nothing and journals nothing with no candidates", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    expect(await settle(recording(), port().memory, mining({}, asked), [])).toEqual([])
    expect(asked).toEqual([])
  })

  it("journals a reading that accepted nothing as not acted on", async () => {
    const { memory, written } = port()
    const events = await settle(recording(), memory, mining({}, []))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ _tag: "decision-settled", acted: false })
    expect(written).toEqual([])
  })

  it.each(["unreachable", "timeout", "refused"] as const)(
    "a %s Jev writes nothing and journals decision-unjudged",
    async (code) => {
      const { memory, written } = port()
      const events = await settle(recording(), memory, () => failing(code))
      expect(written).toEqual([])
      expect(events).toEqual([
        expect.objectContaining({
          _tag: "decision-unjudged",
          scope: "run-1",
          frame: 4,
          classifier: "memory/mine",
          reason: code,
          items: 3
        })
      ])
    }
  )
})

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

/** A model whose first reply writes `prose` around a cell and whose second completes. */
const replies = (prose: string, calls: { count: number }): Model.Model =>
  Model.make({
    stream: () =>
      Stream.suspend(() => {
        const first = calls.count++ === 0
        const text = first
          ? `${prose}\n\n\`\`\`cell\nconsole.log("observed")\n\`\`\``
          : "```cell\nctx.done(\"done\")\n```"
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "t" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "t" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

/** A store that keeps notes by id, the way the durable one does. */
const noteStore = () => {
  const notes = new Map<string, MemoryStore.PutNoteInput>()
  const note = (input: MemoryStore.PutNoteInput): MemoryStore.Note => ({
    ...input,
    namespace: { kind: "flow", id: bank },
    status: "accepted",
    createdAtMs: 1
  })
  const store = MemoryStore.makeNoop({
    getNote: ({ id }) =>
      Effect.sync(() => Option.getOrUndefined(Option.map(Option.fromNullishOr(notes.get(id)), note))),
    putNote: (input) => Effect.sync(() => (notes.set(input.id, input), note(input)))
  })
  return { store, notes }
}

const runFlow = Flow.make("agent/test/memory-mine", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

type Outcome = { readonly _tag: "completed" } | { readonly _tag: "failed"; readonly error: unknown } | {
  readonly _tag: "suspended"
}

/**
 * One `Agent.run` as the whole of one durable execution. With `parkOnce`, the
 * first attempt parks after the run and the resumed attempt replays it.
 */
const agentRun = (input: {
  readonly remember: boolean
  readonly store: MemoryStore.Service
  readonly evaluator: (request: Evaluator.Request) => Answers | Effect.Effect<Answers, Evaluator.EvaluatorError>
  readonly parkOnce?: boolean
}) => {
  const events: Array<Array<AgentEvent.AgentEvent>> = []
  const model = { count: 0 }
  let parked = input.parkOnce !== true
  const body = Effect.gen(function*() {
    const agent = yield* Agent.Agent
    const seen: Array<AgentEvent.AgentEvent> = []
    events.push(seen)
    yield* agent.run({
      session: "session-1",
      seat: Seat.make({
        id: "anthropic:test-model",
        modelId: "test-model",
        model: replies(build, model),
        route: { prepare: () => Effect.succeed(prepared) },
        contextWindowTokens: 0
      }),
      prompt: "make the suite pass",
      registry: Registry.makeNoop({
        list: () => Effect.succeed([]),
        visible: () => Effect.succeed([]),
        getOption: () => Effect.succeed(Option.none())
      }),
      supervisor: { banks: [bank], remember: input.remember },
      maxFrames: 3
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => void seen.push(event))),
      Effect.provide(Layer.merge(
        Agent.layerDefaults,
        Evaluator.layerScripted((request) =>
          isMine(request) ? input.evaluator(request) : answererFor(Object.keys(request.questions))!(request)
        )
      )),
      Effect.provideService(MemoryStore.MemoryStore, input.store)
    )
    if (!parked) {
      parked = true
      return yield* Flow.suspend(yield* FlowRuntime.FlowInstance)
    }
  }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))
  return Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    let settled = Deferred.makeUnsafe<Outcome>()
    const classify = (exit: Exit.Exit<unknown, unknown>): Outcome =>
      Exit.isSuccess(exit)
        ? { _tag: "completed" }
        : Cause.hasInterruptsOnly(exit.cause)
        ? { _tag: "suspended" }
        : { _tag: "failed", error: Cause.squash(exit.cause) }
    yield* engine.register(
      runFlow,
      () => Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit))))
    ).pipe(
      Scope.provide(scope)
    )
    yield* engine.execute(runFlow, { executionId: "exec-1", payload: {}, discard: true })
    const first = yield* Deferred.await(settled)
    if (first._tag !== "suspended") return { outcome: first, events, model: model.count }
    for (let attempt = 0; attempt < 100; attempt++) {
      const polled = yield* engine.poll(runFlow, "exec-1")
      if (Option.isSome(polled) && polled.value._tag === "Suspended") break
      yield* Effect.yieldNow
    }
    settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.resume(runFlow, "exec-1")
    return { outcome: yield* Deferred.await(settled), events, model: model.count }
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer)),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.scoped,
    Effect.runPromise
  )
}

const tags = (events: ReadonlyArray<AgentEvent.AgentEvent>) => events.map((event) => event._tag)
const mineRows = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  events.filter((event) =>
    (event._tag === "decision-settled" || event._tag === "decision-unjudged") && event.classifier === "memory/mine"
  )

describe("Agent.run mines its transcript at run end", () => {
  it("stores a durable sentence the model wrote once, after the run resolved", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const { notes, store } = noteStore()
    const { events, outcome } = await agentRun({ remember: true, store, evaluator: mining({ [build]: 0.9 }, asked) })
    expect(outcome._tag).toBe("completed")
    expect(asked).toEqual([[build]])
    expect([...notes.values()]).toEqual([{
      namespace: { kind: "flow", id: bank },
      id: MemoryMine.noteId(bank, build),
      text: build,
      tags: ["source:transcript"],
      provenance: { runId: "session-1" },
      status: "accepted"
    }])
    const run = events[0]!
    const mined = run.indexOf(mineRows(run)[0]!)
    expect(mined).toBeGreaterThan(tags(run).lastIndexOf("resolved"))
    expect(mineRows(run)).toEqual([expect.objectContaining({ _tag: "decision-settled", frame: 1, acted: true })])
  })

  it("with remember off writes nothing and never asks Jev to mine", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const { notes, store } = noteStore()
    const { events, outcome } = await agentRun({ remember: false, store, evaluator: mining({ [build]: 0.9 }, asked) })
    expect(outcome._tag).toBe("completed")
    expect(asked).toEqual([])
    expect(notes.size).toBe(0)
    expect(mineRows(events[0]!)).toEqual([])
  })

  it.each(["unreachable", "refused"] as const)(
    "a %s Jev at run end leaves the run's outcome unchanged",
    async (code) => {
      const { notes, store } = noteStore()
      const failed = await agentRun({ remember: true, store, evaluator: () => failing(code) })
      const off = await agentRun({ remember: false, store: noteStore().store, evaluator: () => failing(code) })
      expect(failed.outcome).toEqual(off.outcome)
      expect(failed.outcome._tag).toBe("completed")
      expect(tags(failed.events[0]!).filter((tag) => tag === "resolved")).toEqual(["resolved"])
      expect(notes.size).toBe(0)
      expect(mineRows(failed.events[0]!)).toEqual([
        expect.objectContaining({ _tag: "decision-unjudged", reason: code, items: 1 })
      ])
    }
  )

  it("a replayed run is served the recorded reading and never asks Jev again", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const { notes, store } = noteStore()
    const { events, model, outcome } = await agentRun({
      remember: true,
      store,
      evaluator: mining({ [build]: 0.9 }, asked),
      parkOnce: true
    })
    expect(outcome._tag).toBe("completed")
    expect(events).toHaveLength(2)
    expect(model).toBe(2)
    expect(asked).toHaveLength(1)
    expect(mineRows(events[1]!)).toEqual(mineRows(events[0]!))
    expect([...notes.keys()]).toEqual([MemoryMine.noteId(bank, build)])
  })
})
