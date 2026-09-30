/**
 * The cell loop armed for the persistent realm.
 *
 * These cases fix what REPL mode changes about a *run*: what the frame block
 * says, how the transcript grows, which arm the journal records, and — the one
 * that has to be proved rather than argued — that a killed run restored from its
 * own journal rebuilds a realm byte-identical to the one it lost.
 */
import { CanonicalJson, ModelRequest } from "@smthrs/model"
import { Effect, Option, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as Cell from "../src/Cell.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"
import * as Steering from "../src/Steering.ts"
import { confidentEvaluator, descriptor, emits, of, pattern } from "./fixtures/cellTurn.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const flows = [
  descriptor("fs/list", { capabilities: ["fs:read:**"] }),
  descriptor("fs/write", { capabilities: ["fs:read:**"], writes: ["**"] })
]

const window = ContextWindow.make({
  modelId: "test-model",
  segments: [
    { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "task" })] },
    { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("Begin.")] }
  ]
})

const state = (
  overrides: {
    readonly maxFrames?: number
    readonly readOnlyCap?: number
    readonly repeatCap?: number
  } = {}
): CellTurn.State =>
  CellTurn.make({
    session: "session-repl",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["layer-a"],
    capabilityEnvelope: [pattern("fs:read:**")],
    placement: Option.none(),
    contextWindow: CellTurn.teach(window, flows),
    maxFrames: overrides.maxFrames ?? 6,
    readOnlyCap: overrides.readOnlyCap ?? 0,
    repeatCap: overrides.repeatCap ?? 0,
    narrowingCap: 0,
    unmovedCap: 0,
    unresolvedCap: 0
  })

/**
 * A durable engine double: settled boundaries are journaled and replayed.
 *
 * The one property the realm's durability rests on is that a re-executed cell
 * reaches the same call identity and is served the recorded result rather than
 * running again, so the double keys exactly the way `EngineLike.call` promises
 * to — on `Cell.CallIdentity` — and records every identity it actually executed
 * so a test can prove nothing ran twice.
 */
interface Journal {
  readonly calls: Map<string, { readonly value: unknown }>
  readonly records: Map<string, unknown>
  readonly executed: Array<string>
}

const journal = (): Journal => ({ calls: new Map(), records: new Map(), executed: [] })

const durableEngine = (model: ScriptedModel.Fixture, kept: Journal): EngineLike.EngineLike =>
  EngineLike.make({
    sealStep: (step) => model.model.stream(step.request),
    splice: () => Stream.empty,
    call: (call) =>
      Effect.sync(() => {
        const key = CanonicalJson.stringify({
          session: call.identity.session,
          frame: call.identity.frame,
          cell: call.identity.cell,
          ordinal: call.identity.ordinal,
          declaration: call.identity.declaration,
          layers: [...call.identity.layers]
        })
        const recorded = kept.calls.get(key)
        if (recorded !== undefined) {
          return new Cell.CallResult({ outcome: "success", value: recorded.value as never })
        }
        kept.executed.push(key)
        const value = { flow: call.flowName, input: call.input, ran: kept.executed.length }
        kept.calls.set(key, { value })
        return new Cell.CallResult({ outcome: "success", value })
      }),
    record: (boundary) =>
      Effect.suspend(() => {
        const key = `${boundary.name}:${boundary.identity.frame}:${boundary.identity.boundary}`
        const recorded = kept.records.get(key)
        if (recorded !== undefined) return Effect.succeed(recorded as never)
        return Effect.tap(boundary.execute, (value) => Effect.sync(() => kept.records.set(key, value)))
      }),
    observe: Effect.succeed(Option.none()),
    capture: () => Effect.succeed(Option.none()),
    suspend: (reason) => Effect.fail(new HarnessError({ code: "suspended", message: reason.message, cause: reason }))
  })

interface Run {
  readonly events: ReadonlyArray<AgentEvent.AgentEvent>
  readonly model: ScriptedModel.Fixture
  readonly failure?: unknown
}

const run = async (options: {
  readonly script: ScriptedModel.Script
  readonly state?: CellTurn.State
  readonly journal?: Journal
  readonly sandbox?: Sandbox.Sandbox
  /** Stops the stream once this many cells have settled, as a kill would. */
  readonly killAfterCells?: number
}): Promise<Run> => {
  const model = ScriptedModel.make(options.script)
  const events: Array<AgentEvent.AgentEvent> = []
  let cells = 0
  const outcome = await CellTurn.run({
    state: options.state ?? state(),
    flows
  }).pipe(
    options.killAfterCells === undefined ? (stream) => stream : Stream.takeWhile((event) => {
      if (event._tag === "cell-settled") cells = cells + 1
      return cells < options.killAfterCells!
    }),
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.provide(EngineLike.layer(durableEngine(model, options.journal ?? journal()))),
    options.sandbox === undefined
      ? Effect.provide(QuickJSSandbox.layer)
      : Effect.provide(Sandbox.layer(options.sandbox)),
    Effect.provide(Steering.layerNoop()),
    Effect.provide(confidentEvaluator),
    Effect.result,
    Effect.runPromise
  )
  return { events, model, failure: outcome._tag === "Failure" ? outcome.failure : undefined }
}

/** The one trailing user message the controller appends after the transcript. */
const frameBlock = (request: ModelRequest.ModelRequest | undefined): string =>
  request?.messages.at(-1)?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? ""

const conversation = (request: ModelRequest.ModelRequest | undefined): string =>
  (request?.messages ?? [])
    .flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []))
    .join("\n---\n")

describe("CellTurn in repl mode", () => {
  it("journals the armed budgets once, before the run's first frame", async () => {
    const { events } = await run({ script: [emits("ctx.done('finished')")] })
    expect(of(events, "discipline-armed")).toHaveLength(1)
    expect(events[0]?._tag).toBe("discipline-armed")
  })

  it("does not re-arm a resumed REPL run that re-enters past its first frame", async () => {
    // The realm is opened on the way in either way; the arming is not
    // re-journaled, because a resumed run replays the record it already wrote.
    const resumed = CellTurn.make({
      session: "session-repl",
      seat: "anthropic:test-model",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: ["layer-a"],
      capabilityEnvelope: [],
      placement: Option.none(),
      contextWindow: CellTurn.teach(window, flows),
      frame: 2,
      maxFrames: 6
    })
    const { events } = await run({ script: [emits("ctx.done('ok')")], state: resumed })
    expect(of(events, "discipline-armed")).toHaveLength(0)
    expect(of(events, "resolved")).toHaveLength(1)
  })

  it("teaches the realm contract, and nothing about a returned transition", async () => {
    const { model } = await run({ script: [emits("ctx.done('finished')")] })
    const system = (model.recorder.requests[0]?.system ?? []).map((part) => part.text).join("\n")
    expect(system).toContain("a JavaScript REPL that stays alive for the whole run")
    expect(system).toContain("ctx.done(output)")
    expect(system).not.toContain("Return a transition")
  })

  it("carries a completion out of ctx.done", async () => {
    const { events } = await run({ script: [emits("ctx.done('the suite is green')")] })
    const resolved = of(events, "resolved")[0]?.message.content[0]
    expect(resolved?.type === "text" ? resolved.text : "").toBe("the suite is green")
  })

  it("opens the next frame with what the last cell printed", async () => {
    const { model } = await run({
      script: [emits("const found = 2\nconsole.log('found', found)"), emits("ctx.done('ok')")]
    })
    expect(conversation(model.recorder.requests[1])).toContain("What your cell printed:\nfound 2")
  })

  it("says so plainly when a cell printed nothing", async () => {
    const { model } = await run({
      script: [emits("const quiet = 1"), emits("ctx.done('ok')")]
    })
    expect(conversation(model.recorder.requests[1])).toContain("Your cell printed nothing")
  })

  it("journals the print buffer as its own durable event", async () => {
    const { events } = await run({
      script: [emits("console.log({ b: 2, a: 1 })"), emits("ctx.done('ok')")]
    })
    expect(of(events, "cell-printed").map((event) => event.text)).toEqual([`{"a":1,"b":2}`, ""])
  })

  it("names what the realm holds in the frame block instead of a state manifest", async () => {
    const { model } = await run({
      script: [emits("const region = 'abcd'\nconst counts = [1, 2, 3]"), emits("ctx.done('ok')")]
    })
    const block = frameBlock(model.recorder.requests[1])
    expect(block).toContain("Names your realm holds (2)")
    expect(block).toContain("- region (string, 4 chars) — new this frame")
    expect(block).toContain("- counts (array, 3 items) — new this frame")
    expect(block).not.toContain("Durable state for this frame")
  })

  it("ages a binding the next frame does not touch, and marks one it changes", async () => {
    const { model } = await run({
      script: [
        emits("const kept = 'abcd'\nlet moving = 1"),
        emits("moving = [1, 2]"),
        emits("ctx.done('ok')")
      ]
    })
    const block = frameBlock(model.recorder.requests[2])
    expect(block).toContain("- kept (string, 4 chars) — bound at frame 0, 1 frame ago")
    expect(block).toContain("- moving (array, 2 items) — changed this frame")
  })

  it("indexes settled calls without offering a recall that does not exist", async () => {
    const { model } = await run({
      script: [emits(`const listed = await ctx.call("fs/list", { path: "." })`), emits("ctx.done('ok')")]
    })
    const block = frameBlock(model.recorder.requests[1])
    expect(block).toContain("Calls this run has settled (1)")
    expect(block).not.toContain("recall 1")
    expect(block).toContain("still under the name your cell bound it to")
  })

  it("appends to the transcript instead of replacing it", async () => {
    const { model } = await run({
      script: [emits("console.log('one')"), emits("console.log('two')"), emits("ctx.done('ok')")]
    })
    const second = model.recorder.requests[1]!.messages
    const third = model.recorder.requests[2]!.messages
    // Every message the second frame was shown, except its own trailing frame
    // block, is the head of what the third frame is shown — byte for byte,
    // which is exactly what a provider's prefix cache needs.
    expect(third.slice(0, second.length - 1)).toEqual(second.slice(0, second.length - 1))
    expect(third.length).toBeGreaterThan(second.length)
  })

  it("names the realm's bindings when a cell throws reading a property", async () => {
    const { model } = await run({
      script: [
        emits("const held = { a: 1 }\nconst missing = undefined\nmissing.field"),
        emits("ctx.done('ok')")
      ]
    })
    const said = conversation(model.recorder.requests[1])
    expect(said).toContain("was meant to come from a name an earlier cell bound")
    expect(said).toContain("held")
  })

  it("says the realm holds nothing when the first cell throws before binding anything", async () => {
    const { model } = await run({
      script: [emits("ctx.flows.absent.name"), emits("ctx.done('ok')")]
    })
    expect(conversation(model.recorder.requests[1])).toContain("your realm holds no names yet")
  })

  it("shows a cell's prints before the throw that ended it", async () => {
    const { model } = await run({
      script: [emits("console.log('read the file')\nthrow new Error('boom')"), emits("ctx.done('ok')")]
    })
    const said = conversation(model.recorder.requests[1])
    expect(said.indexOf("read the file")).toBeLessThan(said.indexOf("The cell threw"))
  })

  it("holds a run to the read-only cap and takes ctx.justify as the answer", async () => {
    const { events, model } = await run({
      script: [
        emits("const one = 1"),
        emits("ctx.justify('the failing assertion is still unread; fs/list next')"),
        emits("ctx.done('ok')")
      ],
      state: state({ readOnlyCap: 1, maxFrames: 4 })
    })
    expect(conversation(model.recorder.requests[1])).toContain("Read-only discipline")
    const demanded = of(events, "read-only-demanded")
    expect(demanded.map((event) => event.nextAction)).toEqual(["justification"])
  })

  it("redirects a run that keeps issuing the calls it has already issued", async () => {
    const { events } = await run({
      script: [
        emits(`await ctx.call("fs/list", { path: "." })`),
        emits(`await ctx.call("fs/list", { path: "." })`),
        emits(`await ctx.call("fs/list", { path: "." })`),
        emits("ctx.done('ok')")
      ],
      state: state({ repeatCap: 2, maxFrames: 5 })
    })
    expect(of(events, "repeat-demanded")).toHaveLength(1)
  })

  it("fails visibly when nobody can answer a required park", async () => {
    const { events, model, failure } = await run({
      script: [emits("ctx.park('waiting-input', 'which branch?')"), emits("ctx.done('ok')")]
    })
    expect(of(events, "transition-applied")[0]?.transition._tag).toBe("park")
    expect(failure).toMatchObject({ code: "approval_unavailable", message: expect.stringContaining("which branch?") })
    expect(model.recorder.requests).toHaveLength(1)
  })

  it("refuses to run at all on a binding with no persistent realm", async () => {
    const { failure } = await run({
      script: [emits("ctx.done('ok')")],
      sandbox: Sandbox.makeNoop()
    })
    expect(failure).toBeInstanceOf(HarnessError)
    expect((failure as HarnessError).message).toContain("persistent realm could not be opened")
  })

  it("answers an unparseable cell inside the same frame", async () => {
    const { events } = await run({
      script: [emits("const broken = ("), emits("ctx.done('ok')")]
    })
    expect(of(events, "cell-rejected-in-frame")).toHaveLength(1)
    expect(of(events, "resolved")[0]?.message.content[0]).toEqual(
      ModelRequest.TextPart.make({ text: "ok" })
    )
  })

  it("refuses a returned transition and names the call that replaces it", async () => {
    // The scripted cells keep the old filing surface on purpose: this is the
    // shape the sandbox rejects, so aligning them to ctx.done would delete the
    // rejection this test exists to pin.
    const { events } = await run({
      script: [
        emits(`return { intent: "complete", output: "done" }`),
        emits(`return { intent: "complete", output: "done" }`),
        emits("ctx.done('ok')")
      ],
      state: state({ maxFrames: 3 })
    })
    const rejected = of(events, "cell-rejected-in-frame")[0]
    expect(rejected?.message).toContain("ctx.done(output)")
  })
})

describe("CellTurn repl completion, behind the check that decides it", () => {
  /**
   * The guard shape the contract teaches, run end to end.
   *
   * One cell: the probe that must fail, the write, the identical probe replayed,
   * and `ctx.done` behind a check of both. The engine double answers the second
   * probe differently from the first because the write happened in between,
   * which is the whole point — the completion is decided by a result the cell
   * just took rather than by what the model remembers about it.
   */
  const proving = (report: (path: string) => number): EngineLike.EngineLike => {
    let written = false
    return EngineLike.make({
      sealStep: () => Stream.empty,
      splice: () => Stream.empty,
      call: (call) =>
        Effect.sync(() => {
          if (call.flowName === "fs/write") {
            written = true
            return new Cell.CallResult({ outcome: "success", value: { ok: true, wrote: 12 } })
          }
          return new Cell.CallResult({
            outcome: "success",
            value: { exitCode: written ? report("after") : report("before") }
          })
        }),
      record: (boundary) => boundary.execute,
      observe: Effect.succeed(Option.none()),
      capture: () => Effect.succeed(Option.none()),
      suspend: (reason) => Effect.fail(new HarnessError({ code: "suspended", message: reason.message, cause: reason }))
    })
  }

  const guarded = `const verification = { flow: "fs/list", input: { path: "tests/test_widen.py" } }\n` +
    `const before = await ctx.call(verification.flow, verification.input)\n` +
    `const applied = await ctx.call("fs/write", { path: "src/widen.ts", content: "widen(value)" })\n` +
    `const after = await ctx.call(verification.flow, verification.input)\n` +
    `console.log("exit", before.exitCode, after.exitCode)\n` +
    `if (before.exitCode !== 0 && after.exitCode === 0) ctx.done("tests/test_widen.py failed before the write and exits 0 after it")`

  const drive = async (
    script: ScriptedModel.Script,
    engine: EngineLike.EngineLike
  ): Promise<Run> => {
    const model = ScriptedModel.make(script)
    const events: Array<AgentEvent.AgentEvent> = []
    const outcome = await CellTurn.run({ state: state({ maxFrames: 4 }), flows }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.provide(
        EngineLike.layer(
          EngineLike.make({ ...engine, sealStep: (step) => model.model.stream(step.request) })
        )
      ),
      Effect.provide(QuickJSSandbox.layer),
      Effect.provide(Steering.layerNoop()),
      Effect.provide(confidentEvaluator),
      Effect.result,
      Effect.runPromise
    )
    return { events, model, failure: outcome._tag === "Failure" ? outcome.failure : undefined }
  }

  it("completes in the cell that took the check, when the check passes", async () => {
    const { events } = await drive([emits(guarded)], proving((phase) => phase === "before" ? 1 : 0))

    expect(of(events, "transition-applied")[0]?.transition._tag).toBe("complete")
    const resolved = of(events, "resolved")[0]?.message.content[0]
    expect(resolved?.type === "text" ? resolved.text : "").toContain("failed before the write and exits 0 after it")
    expect(of(events, "cell-printed")[0]?.text).toBe("exit 1 0")
  })

  it("carries on, in the same cell, when the check does not pass", async () => {
    // Nothing else about the cell changes. The guard is the whole difference
    // between a run that answers and a run that gets another frame, which is
    // what makes it worth teaching over an attestation.
    const { events } = await drive(
      [emits(guarded), emits(`ctx.done("gave up")`)],
      proving(() => 1)
    )

    expect(of(events, "transition-applied")[0]?.transition._tag).toBe("continue")
    expect(of(events, "cell-printed")[0]?.text).toBe("exit 1 1")
  })

  it("stops dispatching the calls after a completion and says why in the print", async () => {
    const { events } = await drive(
      [emits(
        `ctx.done("early")\nconst extra = await ctx.call("fs/write", { path: "a", content: "b" })\nconsole.log(extra.ok, extra.error.code)`
      )],
      proving(() => 0)
    )

    expect(of(events, "transition-applied")[0]?.transition._tag).toBe("complete")
    expect(of(events, "cell-printed")[0]?.text).toBe("false run_completed")
    // The call never reached the boundary, so it is not in the run's record of
    // what it asked: a call that did not run is not a call.
    expect(of(events, "cell-call-settled")).toHaveLength(0)
  })
})

describe("CellTurn repl and a write the run has already made", () => {
  it("shows the second application of one patch as the write it repeats", async () => {
    // `sympy__sympy-13878`, in the shape the loop can reproduce: apply, revert,
    // apply the identical thing again. Both succeed, nothing is refused, and the
    // frame that follows opens with a ledger that says the second is the first.
    const patch = `*** Begin Patch\n${"d".repeat(200)}`
    const { model } = await run({
      script: [
        emits(`var applied = await ctx.call("fs/write", { content: ${JSON.stringify(patch)}, path: "crv_types.py" })`),
        emits(`var again = await ctx.call("fs/write", { content: ${JSON.stringify(patch)}, path: "crv_types.py" })`),
        emits("ctx.done('ok')")
      ],
      state: state({ maxFrames: 4 })
    })

    // Each frame's section stays in the window, so the first write was listed
    // one frame earlier and the newest section lists only the second.
    expect(frameBlock(model.recorder.requests[1])).toContain("1. fs/write crv_types.py — WROTE 216b, ok")
    const block = frameBlock(model.recorder.requests[2])
    expect(block).not.toContain("1. fs/write")
    expect(block).toContain("2. fs/write crv_types.py — WROTE 216b, ok — the same write as 1, which succeeded")
    expect(conversation(model.recorder.requests[2])).toContain("1. fs/write crv_types.py — WROTE 216b, ok")
    expect(block).toContain("A line marked `WROTE` changed the tree")
  })

  it("says nothing about writes to a run that has only read", async () => {
    const { model } = await run({
      script: [emits(`var listed = await ctx.call("fs/list", { path: "." })`), emits("ctx.done('ok')")]
    })
    expect(frameBlock(model.recorder.requests[1])).not.toContain("WROTE")
  })
})

describe("CellTurn repl durability", () => {
  /**
   * Five cells that bind, print, call and derive — every mechanism the realm
   * has to reproduce — then one more frame whose prompt is the thing compared.
   */
  const script: ScriptedModel.Script = [
    emits(`var opened = await ctx.call("fs/list", { path: "src" })\nconsole.log("opened", opened.ran)`),
    emits(`var anchor = opened.input.path + "/unit.ts"\nconsole.log(anchor)`),
    emits(`var read = await ctx.call("fs/list", { path: anchor })\nvar excerpt = read.input.path.slice(0, 3)`),
    emits(`var checks = [anchor, excerpt]\nconsole.log(checks)`),
    emits(`var verification = { flow: "fs/list", input: { path: anchor } }\nconsole.log(verification)`),
    emits(`ctx.done("rebuilt from " + checks.join(","))`)
  ]

  it("rebuilds a killed run's realm from the journal, byte for byte", async () => {
    const unkilled = journal()
    const control = await run({ script, journal: unkilled, state: state({ maxFrames: 7 }) })
    const kept = journal()
    const killed = await run({ script, journal: kept, state: state({ maxFrames: 7 }), killAfterCells: 5 })
    const restored = await run({ script, journal: kept, state: state({ maxFrames: 7 }) })

    // The killed attempt really did die mid-run, holding a realm nobody kept.
    expect(of(killed.events, "cell-settled").length).toBeLessThan(6)
    expect(of(killed.events, "resolved")).toHaveLength(0)

    // The prompt the sixth frame opens with — the panel of every binding, the
    // call index, the whole appended transcript — is what a rebuilt realm has
    // to reproduce, and it is reproduced exactly.
    expect(restored.model.recorder.requests[5]).toEqual(control.model.recorder.requests[5])
    expect(frameBlock(restored.model.recorder.requests[5]))
      .toEqual(frameBlock(control.model.recorder.requests[5]))
    expect(of(restored.events, "cell-printed").map((event) => event.text))
      .toEqual(of(control.events, "cell-printed").map((event) => event.text))
    expect(of(restored.events, "resolved")[0]?.message.content)
      .toEqual(of(control.events, "resolved")[0]?.message.content)

    // Nothing ran twice. Every settled boundary the killed attempt reached was
    // served to the restored one from its record, which is the whole of why a
    // re-executed realm is cheap enough to be the restore path.
    expect(new Set(kept.executed).size).toBe(kept.executed.length)
    expect(kept.executed).toEqual(unkilled.executed)
  })

  /**
   * The same proof over the paths a happy run never takes.
   *
   * A restore is only worth the name if it reproduces the frames that went
   * wrong, because those are the frames whose effect on the realm is least
   * obvious: a cell that mutates a name an earlier cell bound and then throws
   * leaves the mutation and loses nothing else, a cell that does not parse
   * never reaches the realm at all, and both change the counters the next
   * prompt is built from.
   */
  const rough: ScriptedModel.Script = [
    emits(`var seen = await ctx.call("fs/list", { path: "src" })\nvar log = [seen.ran]\nconsole.log("first", log)`),
    emits(
      `log.push("mutated")\nvar half = await ctx.call("fs/list", { path: "src/half" })\nlog.push(half.ran)\nundefinedName.reach()`
    ),
    emits(`console.log("log survived as", log)`),
    emits(`var broken = (`),
    emits(`var recovered = log.join("|")\nconsole.log(recovered)`),
    emits(`ctx.done("rough run ends at " + recovered)`)
  ]

  it("reproduces a throw, a mutation and an unparseable cell across a restore", async () => {
    const unkilled = journal()
    const control = await run({ script: rough, journal: unkilled, state: state({ maxFrames: 8 }) })
    const kept = journal()
    const killed = await run({ script: rough, journal: kept, state: state({ maxFrames: 8 }), killAfterCells: 4 })
    const restored = await run({ script: rough, journal: kept, state: state({ maxFrames: 8 }) })

    // The control really did take every rough path: a throw, and a cell that
    // never parsed and was re-asked inside its own frame.
    expect(of(control.events, "cell-settled").map((event) => event.outcome._tag))
      .toEqual(["settled", "raised", "settled", "settled", "settled"])
    expect(of(control.events, "cell-rejected-in-frame")).toHaveLength(1)
    expect(killed.events.filter((event) => event._tag === "resolved")).toHaveLength(0)

    // Every prompt after the kill, not only the last: the mutation the throwing
    // cell made is in the realm, the throw's own notice is in the transcript,
    // and the unparseable cell's re-ask is in the frame it was asked in.
    for (const frame of [4, 5]) {
      expect(conversation(restored.model.recorder.requests[frame]))
        .toEqual(conversation(control.model.recorder.requests[frame]))
      expect(frameBlock(restored.model.recorder.requests[frame]))
        .toEqual(frameBlock(control.model.recorder.requests[frame]))
    }
    expect(of(restored.events, "cell-printed").map((event) => event.text))
      .toEqual(of(control.events, "cell-printed").map((event) => event.text))
    expect(of(restored.events, "resolved")[0]?.message.content)
      .toEqual(of(control.events, "resolved")[0]?.message.content)

    // The mutation is the thing at risk: `log` was bound in frame 0, appended
    // to in a frame that threw after appending, and read in frame 2. A realm
    // rebuilt by re-execution carries all three, and the frame that read it
    // back reads the same array on both runs.
    expect(conversation(control.model.recorder.requests[3])).toContain(`log survived as [1,"mutated",2]`)
    expect(conversation(restored.model.recorder.requests[3]))
      .toEqual(conversation(control.model.recorder.requests[3]))

    // The call the throwing cell had already settled before it threw is a
    // recorded boundary like any other, so the restore is served it rather than
    // running it again.
    expect(new Set(kept.executed).size).toBe(kept.executed.length)
    expect(kept.executed).toEqual(unkilled.executed)
  })
})
