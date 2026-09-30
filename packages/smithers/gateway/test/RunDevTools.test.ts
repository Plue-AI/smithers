import { describe, expect, test } from "vitest"
import { defaultFrameLimit, devTools, framesOf, inspect, lines } from "../src/RunDevTools.js"
import { type JournalRecord, traceFromJournal } from "../src/RunTrace.js"

/*
 * The DevTools projection is a view over the trace model: one node per span
 * with its measured timing, and for the selection its recorded detail plus
 * the journal frames written while it was open. Every value here is read off
 * the same fold the run card and the terminal use, so the tree the CLI prints
 * is the tree the pane draws.
 */

const at = (sequence: number, kind: string, payload: Record<string, unknown>, stamp: number): JournalRecord => ({
  sequence,
  kind,
  occurredAt: stamp + 7,
  payload: { ...payload, at: stamp, journalVersion: 1 }
})

const JOURNAL: ReadonlyArray<JournalRecord> = [
  at(1, "control.run.accepted", {}, 1000),
  at(2, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol", contextDigest: "d1" }, 1000),
  at(3, "control.agent.model-settled", {
    text: "read the README, then run the tests",
    usage: { inputTokens: 1200, outputTokens: 80 },
    durationMillis: 900
  }, 2000),
  at(4, "control.agent.cell-produced", {
    language: "ts",
    digest: "c1",
    text: "const readme = await ctx.call(\"files.read\", { path: \"README.md\" })"
  }, 2000),
  at(5, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "README.md" } }, 2100),
  at(6, "control.agent.cell-call-started", { flowName: "target.run", input: { label: "//apps/app:unitTests" } }, 2200),
  at(7, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: "# Smithers" }, 2600),
  at(
    8,
    "control.agent.cell-call-settled",
    { flowName: "target.run", outcome: "failure", message: "1 of 213 failed" },
    4200
  ),
  at(9, "control.agent.cell-printed", { cell: "c1", text: "README read; unitTests: 1 failure" }, 4300),
  at(10, "control.agent.cell-settled", { outcome: "success" }, 4300),
  at(11, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol", contextDigest: "d2" }, 5000),
  at(12, "control.agent.cell-call-started", { flowName: "files.edit", input: { path: "src/x.ts" } }, 5600)
]

const RUN = { runId: "run-1", flowId: "implement", status: "running" }
const model = () => traceFromJournal(RUN, JOURNAL)
const span = (label: string, kind?: string) =>
  model().rows.find((row) => row.label === label && (kind === undefined || row.kind === kind))!

describe("the tree", () => {
  test("is one node per span in tree order, with depth, children and the opening sequence", () => {
    const tree = devTools(model())
    expect(tree.runId).toBe("run-1")
    expect(tree.label).toBe("run run-1 · implement")
    expect(tree.status).toBe("running")
    expect(tree.nodes.map((node) => [node.depth, node.kind, node.label])).toEqual(
      model().rows.map((row) => [row.depth, row.kind, row.label])
    )
    expect(tree.nodes[0]).toMatchObject({ id: "run:run-1", depth: 0, kind: "run", children: 3 })
    const read = tree.nodes.find((node) => node.label === "files.read")!
    expect(read).toMatchObject({ kind: "call", status: "completed", sequence: 5, children: 0 })
    expect(tree.counts).toEqual(model().counts)
    expect(tree.wallMs).toBe(model().extent.end - model().extent.start)
  })

  test("measures a settled span to its settlement and an open span to the trace's end", () => {
    const tree = devTools(model())
    const read = tree.nodes.find((node) => node.label === "files.read")!
    expect(read.durationMs).toBe(500)
    expect(read.endedAt).toBe(2600)
    const edit = tree.nodes.find((node) => node.label === "files.edit")!
    expect(edit.status).toBe("running")
    expect(edit.endedAt).toBeUndefined()
    expect(edit.durationMs).toBe(model().extent.end - 5600)
  })

  test("a span nothing measured has no duration, and a root without a run prefix keeps its id", () => {
    const empty = traceFromJournal({ ...RUN, status: "completed" }, [])
    const tree = devTools(empty)
    expect(tree.nodes).toHaveLength(1)
    expect(tree.nodes[0]!.durationMs).toBeUndefined()
    expect(tree.wallMs).toBe(0)
    expect(devTools({ ...empty, root: { ...empty.root, id: "bare" } }).runId).toBe("bare")
  })
})

describe("frames", () => {
  test("the root owns every sequenced record", () => {
    const frames = framesOf(model(), model().root)
    expect(frames.map((frame) => frame.sequence)).toEqual(JOURNAL.map((record) => record.sequence))
    expect(frames[1]).toEqual({
      sequence: 2,
      at: 1000,
      kind: "control.agent.turn-opened",
      payload: JOURNAL[1]!.payload
    })
  })

  test("a settled span owns the records from its opening to its settlement", () => {
    expect(framesOf(model(), span("files.read")).map((frame) => frame.sequence)).toEqual([5, 6, 7])
    expect(framesOf(model(), span("target.run")).map((frame) => frame.sequence)).toEqual([6, 7, 8])
  })

  test("an open span owns every record since its opening", () => {
    expect(framesOf(model(), span("files.edit")).map((frame) => frame.sequence)).toEqual([12])
    const frame = model().rows.filter((row) => row.kind === "frame").at(-1)!
    expect(framesOf(model(), frame).map((each) => each.sequence)).toEqual([11, 12])
  })

  test("a record without a sequence or a kind is read by what it carries", () => {
    const records: ReadonlyArray<JournalRecord> = [
      { kind: "control.agent.turn-opened", payload: { at: 10 } },
      { sequence: 2, occurredAt: 20, payload: {} },
      { sequence: 3, kind: "control.agent.cell-printed", occurredAt: 30, payload: { text: "x" } },
      { sequence: 4, kind: "control.agent.cell-printed", payload: { text: "y" } }
    ]
    const frames = framesOf(traceFromJournal(RUN, records), traceFromJournal(RUN, records).root)
    expect(frames).toEqual([
      { sequence: 2, at: 20, kind: "", payload: {} },
      { sequence: 3, at: 30, kind: "control.agent.cell-printed", payload: { text: "x" } },
      { sequence: 4, at: 0, kind: "control.agent.cell-printed", payload: { text: "y" } }
    ])
  })

  test("a span the journal never opened with a sequence has no frames", () => {
    const record = { ...model().rows[1]!, detail: {} }
    expect(framesOf(model(), record)).toEqual([])
  })
})

describe("frames of engine and instantaneous spans", () => {
  const wrap = (
    sequence: number,
    executionId: string,
    eventType: string,
    payload: unknown,
    generation = 0
  ): JournalRecord => ({
    sequence,
    // Ingested well after it happened: the journal's own stamp must not decide ownership.
    occurredAt: 100_000 + sequence,
    kind: "control.engine.event",
    payload: {
      version: 1,
      executionId,
      generation,
      sequence,
      eventId: `${executionId}/${generation}/${sequence}`,
      sourceId: "engine",
      sourceSequence: sequence,
      emittedAtMs: sequence + 100,
      eventType,
      payload,
      meta: { lineageId: executionId }
    }
  })
  const decision = (sequence: number, executionId: string, status?: string, generation = 0) =>
    wrap(sequence, executionId, "flows.engine.run-decision", {
      decision: status === undefined ? "created" : "transitioned",
      ...(status === undefined ? {} : { status }),
      state: {
        version: 1,
        flowName: "coding/Check",
        payload: { target: "typecheck" },
        ...(status === "completed" ? { result: { _tag: "Complete", exit: { _tag: "Success", value: 1 } } } : {})
      }
    }, generation)
  const engineJournal: ReadonlyArray<JournalRecord> = [
    decision(1, "native"),
    decision(2, "other"),
    wrap(3, "native", "flows.engine.custom", { note: "x" }),
    decision(4, "native", "completed"),
    decision(5, "other", "completed")
  ]

  test("an execution owns every native record of its execution and generation, by native time", () => {
    const engine = traceFromJournal(RUN, engineJournal)
    const execution = engine.rows.find((row) => row.id === "engine:native:0")!
    expect(execution.endedAt).toBe(104)
    expect(framesOf(engine, execution).map((frame) => [frame.sequence, frame.at])).toEqual([[1, 101], [3, 103], [
      4,
      104
    ]])
    const other = engine.rows.find((row) => row.id === "engine:other:0")!
    expect(framesOf(engine, other).map((frame) => frame.sequence)).toEqual([2, 5])
    // Another generation of the same execution is another span with its own records.
    const regenerated = traceFromJournal(RUN, [...engineJournal, decision(6, "native", undefined, 1)])
    const second = regenerated.rows.find((row) => row.id === "engine:native:1")!
    expect(framesOf(regenerated, second).map((frame) => frame.sequence)).toEqual([6])
    expect(
      framesOf(regenerated, regenerated.rows.find((row) => row.id === "engine:native:0")!).map((frame) =>
        frame.sequence
      )
    ).toEqual([1, 3, 4])
  })

  test("an engine event owns its own record, and every engine span is inspectable by its printed id", () => {
    const engine = traceFromJournal(RUN, engineJournal)
    const event = engine.rows.find((row) => row.id.startsWith("engine-event:"))!
    expect(framesOf(engine, event).map((frame) => frame.sequence)).toEqual([3])
    const printed = lines(engine)
    const line = printed.find((each) => each.endsWith(" engine:native:0"))!
    expect(line).toMatch(/coding\/Check\s+3ms\s+engine:native:0$/)
    expect(printed.some((each) => each.endsWith(` ${event.id}`))).toBe(true)
    const selected = lines(engine, line.trim().split(/\s+/).at(-1))
    expect(selected).toContain("Frames 3")
  })

  test("a record another kind or a malformed envelope carries is not an execution's", () => {
    const engine = traceFromJournal(RUN, [
      ...engineJournal,
      at(6, "control.agent.cell-printed", { text: "aside" }, 200),
      { sequence: 7, kind: "control.engine.event", occurredAt: 300, payload: { version: 1, generation: 0 } }
    ])
    const execution = engine.rows.find((row) => row.id === "engine:native:0")!
    expect(framesOf(engine, execution).map((frame) => frame.sequence)).toEqual([1, 3, 4])
    const root = inspect(engine)
    expect(root.frameCount).toBe(7)
  })

  test("a printed line is its own record, not the turns that followed it", () => {
    const printed = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-printed", { text: "note" }, 1100),
      at(3, "control.agent.turn-opened", {}, 2000),
      at(4, "control.agent.cell-printed", { text: "later" }, 2100)
    ])
    const events = printed.rows.filter((row) => row.kind === "event")
    expect(events.map((row) => row.endedAt)).toEqual([undefined, undefined])
    expect(framesOf(printed, events[0]!).map((frame) => frame.sequence)).toEqual([2])
    expect(inspect(printed, events[1]!.id).frameCount).toBe(1)
  })
})

describe("the inspection", () => {
  test("reads the selected call's input, output, seat, tokens and fields off its records", () => {
    const read = inspect(model(), span("files.read").id)
    expect(read.node.label).toBe("files.read")
    expect(read.path).toEqual(["run run-1 · implement", "frame 1 · openai:gpt-5.6-sol", "cell · ts", "files.read"])
    expect(read.input).toEqual({ path: "README.md" })
    expect(read.output).toBe("# Smithers")
    expect(read.event).toBe("control.agent.cell-call-started")
    expect(read.frames.map((frame) => frame.sequence)).toEqual([5, 6, 7])
    expect(read.frameCount).toBe(3)
    expect(read.failure).toBeUndefined()
    const turn = inspect(model(), "frame-1")
    expect(turn.seat).toBe("openai:gpt-5.6-sol")
    expect(turn.fields).toContainEqual(["contextDigest", "d1"])
    const settled = inspect(model(), span("target.run").id)
    expect(settled.failure).toBe("1 of 213 failed")
    expect(settled.node.status).toBe("failed")
    const answer = inspect(model(), span("model", "model").id)
    expect(answer.tokens).toEqual({ input: 1200, output: 80 })
  })

  test("tokens read one side when only one was recorded, and none when usage carried neither", () => {
    const only = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.model-settled", { text: "a", usage: { outputTokens: 5 } }, 1100)
    ])
    expect(inspect(only, only.rows.find((row) => row.kind === "model")!.id).tokens).toEqual({ input: 0, output: 5 })
    const input = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.model-settled", { text: "a", usage: { inputTokens: 7 } }, 1100)
    ])
    expect(inspect(input, input.rows.find((row) => row.kind === "model")!.id).tokens).toEqual({ input: 7, output: 0 })
    const none = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.model-settled", { text: "a", usage: {} }, 1100)
    ])
    expect(inspect(none, none.rows.find((row) => row.kind === "model")!.id).tokens).toBeUndefined()
  })

  test("an unknown or absent selection inspects the run itself", () => {
    for (const id of [undefined, "nope"]) {
      const root = inspect(model(), id)
      expect(root.node.kind).toBe("run")
      expect(root.path).toEqual(["run run-1 · implement"])
      expect(root.frameCount).toBe(JOURNAL.length)
    }
  })

  test("keeps the newest frames within the bound and says how many there were", () => {
    const bounded = inspect(model(), undefined, { frames: 2 })
    expect(bounded.frames.map((frame) => frame.sequence)).toEqual([11, 12])
    expect(bounded.frameCount).toBe(12)
    expect(inspect(model(), undefined, { frames: 0 }).frames).toEqual([])
    expect(inspect(model(), undefined, { frames: -3 }).frames).toEqual([])
    expect(defaultFrameLimit).toBe(100)
    const long = Array.from(
      { length: 130 },
      (_, index) => at(index + 1, "control.agent.cell-printed", { text: `${index}` }, index)
    )
    const many = inspect(traceFromJournal(RUN, long))
    expect(many.frames).toHaveLength(100)
    expect(many.frames[0]!.sequence).toBe(31)
    expect(many.frameCount).toBe(130)
  })

  test("a detached child's recorded run id is carried", () => {
    const spawned = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "agent/spawn", input: { prompt: "go" } }, 1100),
      at(3, "control.agent.cell-call-settled", {
        flowName: "agent/spawn",
        outcome: "success",
        value: { child: "child-1" }
      }, 1200)
    ])
    const call = spawned.rows.find((row) => row.kind === "call")!
    expect(inspect(spawned, call.id).childRunId).toBe(call.detail.childRunId)
    expect(call.detail.childRunId).toBe("child-1")
  })
})

describe("the text lines", () => {
  test("print the run line, the tree with the selection marked, and the inspection", () => {
    const text = lines(model(), span("target.run").id, { width: 80 })
    expect(text[0]).toBe("run run-1 · implement · running · 8 spans · 2 running · 1 failed · t = 4.6s")
    expect(text[1]).toBe("  ◐ run run-1 · implement                            running    4.6s    run:run-1")
    expect(text.find((line) => line.startsWith(">"))).toBe(
      ">       ✗ target.run                                 failed     2.0s    call-2"
    )
    const detail = text.indexOf("")
    expect(text.slice(detail + 1, detail + 7)).toEqual([
      "call · run run-1 · implement / frame 1 · openai:gpt-5.6-sol / cell · ts / target.run · failed",
      "started   1970-01-01T00:00:02.200Z",
      "duration  2.0s",
      "journal   control.agent.cell-call-started · #6",
      "Input",
      "  {"
    ])
    expect(text).toContain("Failure")
    expect(text).toContain("  1 of 213 failed")
    expect(text).toContain("Frames 3")
    expect(text.at(-1)).toMatch(/^  #8 control\.agent\.cell-call-settled \{"flowName":"target\.run"/)
  })

  test("an open node says so, a frame shows its seat and children, and a bounded list says what it left out", () => {
    const text = lines(model(), "frame-1", { frames: 1 })
    expect(text).toContain("frame · run run-1 · implement / frame 1 · openai:gpt-5.6-sol · completed")
    expect(text).toContain("seat      openai:gpt-5.6-sol")
    expect(text).toContain("children  2")
    expect(text).toContain("Fields")
    expect(text).toContain("  contextDigest d1")
    expect(text).toContain("Frames 1 of 10")
    const open = lines(model(), span("files.edit").id)
    expect(open).toContain("duration  0ms · open")
    const answer = lines(model(), span("model", "model").id)
    expect(answer).toContain("tokens    1200 in / 80 out")
    expect(answer).toContain("Output")
    expect(answer).toContain("  read the README, then run the tests")
    const cell = lines(model(), model().rows.find((row) => row.kind === "cell")!.id)
    expect(cell).toContain("Script")
    expect(cell).toContain("Printed")
    expect(cell).toContain("  README read; unitTests: 1 failure")
  })

  test("a stopped frame, a waiting approval and a record without a sequence keep their own words", () => {
    const one = traceFromJournal({ ...RUN, status: "failed" }, [at(1, "control.agent.turn-opened", {}, 1000)])
    expect(lines(one)[0]).toBe("run run-1 · implement · failed · 1 span · t = 0ms")
    // Native evidence wears `recorded`: neither open nor settled, so neither glyph.
    const recorded = {
      ...one,
      rows: one.rows.map((row) => row.id === "frame-1" ? { ...row, status: "recorded" } : row)
    }
    expect(lines(recorded, "frame-1")[2]).toMatch(/^>   ○ frame 1 +recorded +0ms +frame-1$/)
    const waiting = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.approval.requested", { requestId: "req-1", question: "write?", payload: {}, runId: "run-1" }, 1100)
    ])
    const approval = waiting.rows.find((row) => row.kind === "approval")!
    expect(lines(waiting, approval.id).find((line) => line.startsWith(">"))).toMatch(/^> +◐ /)
    const unsequenced = traceFromJournal(RUN, [{ kind: "control.agent.turn-opened", payload: { at: 10 } }])
    expect(lines(unsequenced, "frame-1")).toContain("journal   control.agent.turn-opened")
    const fn = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "f", input: () => 1 }, 1100)
    ])
    expect(lines(fn, fn.rows.find((row) => row.kind === "call")!.id)).toContain("  () => 1")
    const text = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "bash", input: "ls -la" }, 1100)
    ])
    expect(lines(text, text.rows.find((row) => row.kind === "call")!.id)).toContain("  ls -la")
  })

  test("an empty journal is the root alone with no facts it never measured", () => {
    const empty = traceFromJournal({ ...RUN, status: "completed" }, [])
    const text = lines(empty)
    expect(text[1]).toMatch(/^> ● run run-1 · implement +run:run-1$/)
    expect([text[0], ...text.slice(2)]).toEqual([
      "run run-1 · implement · completed · 0 spans",
      "",
      "run · run run-1 · implement · completed",
      "Frames 0"
    ])
  })

  test("clips long labels and payloads to the width, never below a readable floor", () => {
    const long = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "x".repeat(200), input: { text: "y".repeat(300) } }, 1100)
    ])
    const narrow = lines(long, undefined, { width: 10 })
    const call = narrow.find((line) => line.includes("xxx"))!
    // The label column floors at 20 of a 40-column width; the id follows it unclipped.
    expect(call.indexOf("…")).toBeLessThan(24)
    expect(call).toMatch(/ call-1$/)
    const frame = narrow.find((line) => line.startsWith("  #2 "))!
    // The width floors at 40 columns: the frame keeps 32 for its kind and payload after the `  #n ` lead.
    expect(frame.length).toBe(5 + 32)
    const wide = lines(long, undefined, { width: 400 })
    expect(wide.find((line) => line.includes("xxx"))).toContain("x".repeat(200))
  })

  test("a child run id and a payload JSON cannot serialise are printed as what they are", () => {
    const spawned = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "agent/spawn", input: { prompt: "go" } }, 1100),
      at(3, "control.agent.cell-call-settled", {
        flowName: "agent/spawn",
        outcome: "success",
        value: { child: "child-1" }
      }, 1200)
    ])
    const call = spawned.rows.find((row) => row.kind === "call")!
    expect(lines(spawned, call.id)).toContain("child     child-1")
    const cyclic: Record<string, unknown> = { flowName: "loop" }
    cyclic.self = cyclic
    const broken = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      {
        sequence: 2,
        kind: "control.agent.cell-call-started",
        occurredAt: 1100,
        payload: { ...cyclic, input: cyclic, at: 1100 }
      },
      { sequence: 3, kind: "control.agent.cell-printed", occurredAt: 1150, payload: undefined }
    ])
    const text = lines(broken, broken.rows.find((row) => row.kind === "call")!.id)
    expect(text).toContain("Input")
    expect(text).toContain("  [object Object]")
    expect(text.some((line) => /^  #2 control\.agent\.cell-call-started \[object Object\]/.test(line))).toBe(true)
    const root = lines(broken)
    expect(root.some((line) => line === "  #3 control.agent.cell-printed undefined")).toBe(true)
  })
})
