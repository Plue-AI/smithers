import type { FlowDescriptor } from "@smthrs/registry/Descriptor"
import { describe, expect, test } from "vitest"
import {
  durationWords,
  isTraceFilter,
  phaseBandGeometry,
  phaseExtent,
  spanMatches,
  spanPath,
  traceFiltersFor,
  traceFromJournal,
  turnNarratives,
  waterfallGeometry
} from "../src/RunTrace.js"
import type { JournalRecord } from "../src/RunTrace.js"

/*
 * The trace model over a journal in the agent's own shapes (AgentSession's
 * journal projection): frames nest cells, cells nest calls, calls pair with
 * their settlement by flow name, open work stays open, and the waterfall's
 * bars sit where the stamps put them. An empty journal is the run root alone.
 */

const at = (sequence: number, kind: string, payload: Record<string, unknown>, stamp: number): JournalRecord => ({
  sequence,
  kind,
  occurredAt: stamp + 7,
  // The agent stamps `at` itself; the journal's occurredAt is later and must not win.
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
  at(12, "control.agent.cell-produced", {
    language: "ts",
    digest: "c2",
    text: "await ctx.call(\"files.edit\", { path: \"src/x.ts\", patch })"
  }, 5500),
  at(13, "control.agent.cell-call-started", { flowName: "files.edit", input: { path: "src/x.ts" } }, 5600),
  at(
    14,
    "control.approval.requested",
    { requestId: "req-1", question: "write src/x.ts?", payload: {}, runId: "run-1" },
    6000
  )
]

const RUN = { runId: "run-1", flowId: "implement", status: "running", kind: "implement" }

/** A single recorded call, with settlement omitted while it is pending. */
const oneCall = (
  flowName: string,
  input: unknown,
  settlement?: Record<string, unknown>,
  descriptor?: Pick<FlowDescriptor, "name" | "activity" | "presentation">
): ReadonlyArray<JournalRecord> => [
  at(1, "control.agent.turn-opened", {}, 1000),
  at(
    2,
    "control.agent.cell-call-started",
    { flowName, input, ...(descriptor === undefined ? {} : { descriptor }) },
    1100
  ),
  ...(settlement === undefined ? [] : [at(3, "control.agent.cell-call-settled", { flowName, ...settlement }, 1200)])
]

describe("descriptor-backed activity and presentation", () => {
  test("structured tests and narrowed checks are testing independently of a plan's coverage", () => {
    for (const input of [{ selection: ["//ui:browser"] }, { selection: ["tests/a.ts", "--grep", "one case"] }, {}]) {
      for (const checkTargets of [[], ["//ui:browser"], ["tests"]]) {
        expect(traceFromJournal(RUN, oneCall("test", input), { checkTargets }).bands[0]?.phase).toBe("testing")
      }
    }
    for (const command of ["pytest tests/admin_views/one.py", "bun test tests/a.ts --test-name-pattern one"]) {
      expect(traceFromJournal(RUN, oneCall("bash", { command }), { checkTargets: ["tests"] }).bands[0]?.phase).toBe(
        "testing"
      )
    }
  })

  test("mentioning a check target does not execute it, and unknown activity stays unknown", () => {
    for (const command of ["echo //ui:browser", "cat //ui:browser", "printf 'pytest tests'", "custom //ui:browser"]) {
      expect(traceFromJournal(RUN, oneCall("bash", { command }), CHECKS).bands[0]?.phase).toBe("unrecorded")
    }
    for (const flow of ["custom", "constructor", "toString", "__proto__"]) {
      expect(traceFromJournal(RUN, oneCall(flow, { path: "a.ts" })).bands[0]?.phase).toBe("unrecorded")
    }
  })

  test("unrecognized recorded metadata does not fall back to a familiar flow name", () => {
    const records = oneCall("write", { path: "a.ts" }).map((record) =>
      record.kind === "control.agent.cell-call-started"
        ? {
          ...record,
          payload: { ...(record.payload as object), descriptor: { name: "write", activity: "future-activity" } }
        }
        : record
    )
    const model = traceFromJournal(RUN, records)
    expect(model.bands[0]?.phase).toBe("unrecorded")
    expect(model.lines[0]?.verb).toBe("write pending")
  })

  test("descriptor activity and presentation override standard names and support custom flows", () => {
    const inspects = {
      name: "write",
      activity: "reads",
      presentation: {
        verb: { pending: "inspecting", success: "inspected", failure: "failed to inspect" },
        subject: "pattern",
        result: "text"
      }
    } as const
    const model = traceFromJournal(
      RUN,
      oneCall("write", { path: "a.ts", pattern: "needle" }, { outcome: "success", value: "found" }, inspects)
    )
    expect(model.bands[0]?.phase).toBe("researching")
    expect(model.lines[0]).toMatchObject({ verb: "inspected", subject: "needle", result: "found", wrote: false })
    expect(model.milestones).toEqual([])
    expect(
      traceFromJournal(RUN, oneCall("custom.test", {}, undefined, { name: "custom.test", activity: "tests" })).bands[0]
        ?.phase
    ).toBe("testing")
    expect(traceFromJournal(RUN, oneCall("read", {}, undefined, { name: "read", activity: "other" })).bands[0]?.phase)
      .toBe("unrecorded")
  })

  test.each(
    [
      ["reads", "researching"],
      ["writes", "implementing"],
      ["checks", "testing"],
      ["tests", "testing"],
      ["other", "unrecorded"]
    ] as const
  )("recorded descriptor activity %s is authoritative and survives journal serialization", (activity, phase) => {
    const journal = oneCall("custom", { path: "a.ts" }, { outcome: "success", value: "done" }).map((record) =>
      record.kind === "control.agent.cell-call-started" ?
        {
          ...record,
          payload: {
            ...(record.payload as object),
            descriptor: {
              name: "custom",
              activity,
              presentation: {
                verb: { pending: "working on", success: "handled", failure: "failed to handle" },
                subject: "path",
                result: "text"
              }
            }
          }
        } :
        record
    )
    const model = traceFromJournal(RUN, JSON.parse(JSON.stringify(journal)))
    expect(model.bands[0]?.phase).toBe(phase)
    expect(model.lines[0]).toMatchObject({ verb: "handled", subject: "a.ts", result: "done" })
  })

  test.each([
    "pytest tests/a.py",
    "vitest run a.test.ts",
    "jest a.test.ts",
    "python -m pytest a.py",
    "python3 -m unittest a",
    "bun test a.test.ts",
    "pnpm test --filter a",
    "npm run test -- a",
    "pnpm exec vitest run",
    "go test ./one",
    "cargo test one",
    "tsc --noEmit",
    "bun run check //ui:browser --grep one",
    "npm run typecheck",
    "pnpm run lint"
  ])("recognizes a direct legacy check invocation: %s", (command) => {
    expect(traceFromJournal(RUN, oneCall("bash", { command })).bands[0]?.phase).toBe("testing")
  })

  test.each([
    "echo pytest",
    "printf 'bun test'",
    "cat test-output",
    "my-pytest tests",
    "bun test-more",
    "python3 script.py pytest",
    "echo ok && pytest tests",
    "pytest tests | cat",
    "pytest $TARGET",
    "'pytest' tests",
    "pytest tests\necho done"
  ])("leaves unsupported shell activity unknown: %s", (command) => {
    expect(traceFromJournal(RUN, oneCall("bash", { command }), CHECKS).bands[0]?.phase).toBe("unrecorded")
  })

  test("write summaries distinguish pending, rejected and successful settlements", () => {
    const cases = [
      [undefined, "writing", "", false, false],
      [{ outcome: "failure", message: "permission denied" }, "failed to write", "permission denied", true, false],
      [
        { outcome: "success", value: { path: "a.ts", bytesWritten: 12, created: false } },
        "wrote",
        "12 bytes",
        false,
        true
      ]
    ] as const
    for (const [settlement, verb, result, failed, wrote] of cases) {
      const model = traceFromJournal(RUN, oneCall("write", { path: "a.ts" }, settlement))
      expect(model.lines[0]).toMatchObject({ verb, subject: "a.ts", result, failed, wrote })
    }
  })

  test("supported result formats use recorded facts and leave unsupported JSON in the selected call", () => {
    const cases = [
      ["read", { content: "a\nb", startLine: 3, endLine: 4, totalLines: 20, truncated: true }, "2 lines"],
      ["read", { content: "", startLine: 1, endLine: 0, totalLines: 0, truncated: false }, "0 lines"],
      ["write", { path: "a.ts", bytesWritten: 0, created: false }, "0 bytes"],
      ["edit", { path: "a.ts", replacements: 2, startLine: 1, endLine: 2, hunk: "actual lines" }, "2 replacements"],
      ["apply_patch", { added: ["a.ts"], modified: ["b.ts"], deleted: [], output: "Success." }, "2 files"],
      ["test", { passed: 12, failed: [], parsed: true, exitCode: 0 }, "12 passed"],
      ["test", { passed: 3, failed: ["one"], parsed: true, exitCode: 1 }, "3 passed · 1 failed"],
      ["test", { passed: 0, failed: [], parsed: false, exitCode: 1 }, "exit 1"],
      ["test", { passed: 2, failed: [], parsed: true, exitCode: 1 }, "2 passed · exit 1"],
      ["bash", { exitCode: 2, stdout: "", stderr: "refused" }, "exit 2"],
      ["grep", {
        matches: [{ path: "a.ts", line: 1, text: "a" }],
        files: ["a.ts"],
        filesSearched: 1,
        skippedBinary: 0,
        truncated: false
      }, "1 match"],
      ["grep", { matches: [{ path: "a.ts" }, { path: "b.ts" }] }, "2 matches"],
      ["glob", { paths: ["a.ts", "b.ts"], total: 5, truncated: true }, "2 files"],
      ["ls", { entries: [{ name: "a.ts", kind: "file" }], total: 1, truncated: false }, "1 entry"],
      ["ls", { entries: [], total: 0, truncated: false }, "0 entries"],
      ["read", { text: "unsupported" }, ""],
      ["edit", { hunk: "+line" }, ""],
      ["test", { passed: 12, failed: [] }, ""],
      ["write", { bytesWritten: -1 }, ""],
      ["write", { truncated: true, bytes: 99999, digest: "d" }, ""],
      ["custom", { passed: 12, failed: [] }, ""]
    ] as const
    for (const [flow, value, result] of cases) {
      const model = traceFromJournal(RUN, oneCall(flow, { path: "a.ts" }, { outcome: "success", value }))
      expect(model.lines[0]?.result).toBe(result)
      expect(model.rows.find((span) => span.kind === "call")?.detail.output).toBe(JSON.stringify(value))
    }
  })

  test("presentation suppresses unrequested subjects and results and bounds plain text", () => {
    const presentation = {
      verb: { pending: "waiting", success: "finished", failure: "failed" },
      subject: "none",
      result: "none"
    } as const
    expect(
      traceFromJournal(
        RUN,
        oneCall("custom", { path: "a.ts" }, { outcome: "success", value: "private" }, {
          name: "custom",
          activity: "other",
          presentation
        })
      ).lines[0]
    ).toMatchObject({ verb: "finished", subject: "", result: "" })
    const line = traceFromJournal(RUN, oneCall("read", { path: "a" }, { outcome: "success", value: "x".repeat(500) }))
      .lines[0]!
    expect(line.result).toHaveLength(160)
    expect(line.result.endsWith("…")).toBe(true)
  })
})

describe("the trace model", () => {
  test("turn explanations use recorded prose and fall back to actual calls without presenting code or truncated metadata as intent", () => {
    const model = traceFromJournal(RUN, JOURNAL)
    expect(turnNarratives(model).map(({ number, text, source }) => ({ number, text, source }))).toEqual([
      { number: 1, text: "read the README, then run the tests.", source: "model" },
      { number: 2, text: "The agent called files.edit.", source: "calls" }
    ])
    const code = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1),
      at(2, "control.agent.model-settled", {
        text: "```ts\nconst result = 1\n```\nI’ll check the failing assertion.\nMore detail."
      }, 2),
      at(3, "control.agent.turn-opened", {}, 3),
      at(4, "control.agent.model-settled", { text: { truncated: true, bytes: 99999, digest: "d" } }, 4),
      at(5, "control.agent.turn-opened", {}, 5),
      at(6, "control.agent.model-settled", { text: "const result = await ctx.call('read')" }, 6)
    ])
    expect(turnNarratives(code).map(({ text }) => text)).toEqual([
      "I’ll check the failing assertion.",
      "The model responded; no script or flow calls were recorded in this turn.",
      "The model responded; no script or flow calls were recorded in this turn."
    ])
    expect(turnNarratives(traceFromJournal(RUN, []))).toEqual([])
  })

  test("selection ancestry is recorded, and only a successful agent/spawn result establishes a child run edge", () => {
    const model = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1),
      at(2, "control.agent.cell-produced", { text: "await ctx.call('agent/spawn')" }, 2),
      at(3, "control.agent.cell-call-started", { flowName: "agent/spawn", input: { flow: "review" } }, 3),
      at(4, "control.agent.cell-call-settled", {
        flowName: "agent/spawn",
        outcome: "success",
        value: { child: "run-1/child/review" }
      }, 4),
      at(5, "control.agent.cell-call-started", { flowName: "files.read" }, 5),
      at(6, "control.agent.cell-call-settled", {
        flowName: "files.read",
        outcome: "success",
        value: { child: "unrelated" }
      }, 6)
    ])
    expect(spanPath(model, "call-1").map((span) => span.id)).toEqual(["run:run-1", "frame-1", "cell-2", "call-1"])
    expect(model.rows.find((span) => span.id === "call-1")?.detail.childRunId).toBe("run-1/child/review")
    expect(model.rows.find((span) => span.id === "call-2")?.detail.childRunId).toBeUndefined()
    expect(spanPath(model, "unrecorded").map((span) => span.id)).toEqual(["run:run-1"])
  })
  test("nests the journal as run → frame → cell → call, pairing settlements by flow name", () => {
    const model = traceFromJournal(RUN, JOURNAL)
    const { root } = model
    expect(root.label).toBe("run run-1 · implement")
    expect(root.status).toBe("running")
    // The accepted event lands on the run itself, before any frame.
    expect(root.children.map((span) => `${span.kind}:${span.label}`)).toEqual([
      "event:run.accepted",
      "frame:frame 1 · openai:gpt-5.6-sol",
      "frame:frame 2 · openai:gpt-5.6-sol"
    ])
    const [, frame1, frame2] = root.children
    expect(frame1?.children.map((span) => span.kind)).toEqual(["model", "cell"])
    const cell1 = frame1?.children[1]
    expect(cell1?.children.map((span) => `${span.id} ${span.label} ${span.status}`)).toEqual([
      "call-1 files.read completed",
      "call-2 target.run failed"
    ])
    // A settlement pairs with the oldest open call of its flow name, so the earlier files.read settles first.
    expect(cell1?.children[0]).toMatchObject({
      startedAt: 2100,
      endedAt: 2600,
      detail: { input: { path: "README.md" }, output: "# Smithers" }
    })
    expect(cell1?.children[1]).toMatchObject({ startedAt: 2200, endedAt: 4200, detail: { message: "1 of 213 failed" } })
    // The cell carries its source and what it printed; it closes on cell-settled.
    expect(cell1).toMatchObject({ startedAt: 2000, endedAt: 4300, status: "completed" })
    expect(cell1?.detail.source).toContain("files.read")
    expect(cell1?.detail.printed).toBe("README read; unitTests: 1 failure")
    // The model call's bar runs its measured duration back from its settlement.
    expect(frame1?.children[0]).toMatchObject({
      startedAt: 1100,
      endedAt: 2000,
      detail: { usage: { inputTokens: 1200, outputTokens: 80 }, seat: "openai:gpt-5.6-sol" }
    })
    // A frame closes when the next opens.
    expect(frame1).toMatchObject({ startedAt: 1000, endedAt: 5000, status: "completed" })
    // Open work stays open: the second frame, its cell, the unsettled call, the pending approval.
    expect(frame2?.endedAt).toBeUndefined()
    expect(frame2?.status).toBe("running")
    const cell2 = frame2?.children[0]
    expect(cell2?.children[0]).toMatchObject({ id: "call-3", label: "files.edit", status: "running" })
    expect(cell2?.children[0]?.endedAt).toBeUndefined()
    expect(frame2?.children[1]).toMatchObject({
      kind: "approval",
      label: "approval · write src/x.ts?",
      status: "waiting"
    })
    expect(model.counts).toEqual({ spans: 10, running: 3, failed: 1 })
    // Rows are the tree in order, with depth.
    expect(model.rows.map((span) => `${span.depth}:${span.id}`)).toEqual([
      "0:run:run-1",
      "1:event-1",
      "1:frame-1",
      "2:model-3",
      "2:cell-4",
      "3:call-1",
      "3:call-2",
      "1:frame-2",
      "2:cell-12",
      "3:call-3",
      "2:approval-req-1"
    ])
  })

  test("the waterfall axis spans the first stamp to the last, open bars run to the axis end, instants are zero width", () => {
    const model = traceFromJournal(RUN, JOURNAL)
    expect(model.extent).toEqual({ start: 1000, end: 6000 })
    const call1 = model.rows.find((span) => span.id === "call-1")!
    expect(waterfallGeometry(call1, model.extent)).toEqual({ left: 22, width: 10 })
    const call3 = model.rows.find((span) => span.id === "call-3")!
    expect(waterfallGeometry(call3, model.extent)).toEqual({ left: 92, width: 8 })
    const accepted = model.rows.find((span) => span.id === "event-1")!
    expect(waterfallGeometry(accepted, model.extent)).toEqual({ left: 0, width: 0 })
    // A decided approval and a denied one settle where the decision lands.
    const decided = traceFromJournal(RUN, [
      ...JOURNAL,
      at(15, "control.approval.denied", { tokenId: "req-1" }, 6500)
    ])
    expect(decided.rows.find((span) => span.id === "approval-req-1")).toMatchObject({ status: "denied", endedAt: 6500 })
  })

  test("a journal read out of order folds the same trace", () => {
    const shuffled = [...JOURNAL].reverse()
    expect(traceFromJournal(RUN, shuffled).rows.map((span) => span.id)).toEqual(
      traceFromJournal(RUN, JOURNAL).rows.map((span) => span.id)
    )
  })

  test("a settled run closes its last frame where the journal ends; a call the journal never settled stays open", () => {
    const model = traceFromJournal({ ...RUN, status: "completed" }, [
      ...JOURNAL,
      at(15, "control.run.completed", {}, 7000)
    ])
    expect(model.root.endedAt).toBe(7000)
    const frame2 = model.root.children[2]
    expect(frame2).toMatchObject({ endedAt: 7000, status: "completed" })
    expect(model.rows.find((span) => span.id === "call-3")?.endedAt).toBeUndefined()
    // Without the run's own terminal event, the card's terminal phase still closes the frame at the last stamp.
    const byPhase = traceFromJournal({ ...RUN, status: "failed" }, JOURNAL)
    expect(byPhase.root.children[2]).toMatchObject({ endedAt: 6000 })
    expect(byPhase.root.status).toBe("failed")
  })

  test("no journal yet is the run root alone, wearing the run's status", () => {
    const model = traceFromJournal({ runId: "run-9", flowId: "prototype", status: "launching", kind: "prototype" }, [])
    expect(model.rows).toHaveLength(1)
    expect(model.root).toMatchObject({
      kind: "run",
      status: "launching",
      children: [],
      detail: { fields: { kind: "prototype" } }
    })
    expect(model.extent).toEqual({ start: 0, end: 0 })
    expect(model.counts).toEqual({ spans: 0, running: 0, failed: 0 })
    // Records that are not control events are not spans.
    expect(traceFromJournal(RUN, [{ sequence: 1, kind: "engine.step", occurredAt: 5, payload: {} }]).counts.spans).toBe(
      0
    )
  })

  test("filters keep a span whose subtree matches, so the tree stays a tree", () => {
    const model = traceFromJournal(RUN, JOURNAL)
    const visible = (filter: Parameters<typeof spanMatches>[1]) =>
      model.rows.filter((span) => span.kind === "run" || spanMatches(span, filter)).map((span) => span.id)
    expect(visible("failed")).toEqual(["run:run-1", "frame-1", "cell-4", "call-2"])
    expect(visible("running")).toEqual(["run:run-1", "frame-2", "cell-12", "call-3", "approval-req-1"])
    expect(visible("model")).toEqual(["run:run-1", "frame-1", "model-3"])
    expect(visible("flow")).toEqual([
      "run:run-1",
      "frame-1",
      "cell-4",
      "call-1",
      "call-2",
      "frame-2",
      "cell-12",
      "call-3"
    ])
    expect(visible("all")).toHaveLength(11)
  })

  test("a prototype offers all, messages and failed; every other run the shared six (spec 06 §2, §3)", () => {
    expect(traceFiltersFor("prototype").map(([id]) => id)).toEqual(["all", "messages", "failed"])
    expect(traceFiltersFor("implement").map(([id]) => id)).toEqual([
      "all",
      "running",
      "failed",
      "model",
      "flow",
      "forks"
    ])
    expect(traceFiltersFor(undefined).map(([id, label]) => `${id}=${label}`)).toEqual([
      "all=all",
      "running=running",
      "failed=failed",
      "model=model calls",
      "flow=flow calls",
      "forks=forks"
    ])
    expect(isTraceFilter("messages")).toBe(true)
    expect(isTraceFilter("calls")).toBe(false)
  })

  test("the messages filter keeps a prototype's agent/send and agent/await spans with their ancestors", () => {
    const model = traceFromJournal({ runId: "run-2", flowId: "prototype", status: "running", kind: "prototype" }, [
      at(1, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 1000),
      at(2, "control.agent.cell-produced", {
        language: "ts",
        digest: "c1",
        text: "await ctx.call(\"agent/send\", { to: \"w2\", text: \"edges are note→target\" })"
      }, 1100),
      at(3, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "README.md" } }, 1200),
      at(4, "control.agent.cell-call-started", {
        flowName: "agent/send",
        input: { to: "w2", text: "edges are note→target" }
      }, 1300),
      at(5, "control.agent.cell-call-started", { flowName: "agent/await", input: { from: "w4" } }, 1400)
    ])
    const visible = model.rows.filter((span) => span.kind === "run" || spanMatches(span, "messages")).map((span) =>
      span.label
    )
    expect(visible).toEqual([
      "run run-2 · prototype",
      "frame 1 · openai:gpt-5.6-sol",
      "cell · ts",
      "agent/send",
      "agent/await"
    ])
  })

  test("durations read in the trace's units", () => {
    expect(durationWords(120)).toBe("120ms")
    expect(durationWords(4400)).toBe("4.4s")
    expect(durationWords(201_000)).toBe("3m21s")
    // Rounding carries into the next unit, never to 60.
    expect(durationWords(3_119_600)).toBe("52m00s")
    expect(durationWords(59_960)).toBe("1m00s")
    expect(durationWords(59_940)).toBe("59.9s")
    // Past an hour, hours and minutes: an agent that ran 155m48s reads 2h36m; the hour boundary rounds like the minute one.
    expect(durationWords(9_348_000)).toBe("2h36m")
    expect(durationWords(3_599_400)).toBe("59m59s")
    expect(durationWords(3_599_600)).toBe("1h00m")
    expect(durationWords(3_629_000)).toBe("1h00m")
  })
})

test("identified same-flow calls settle in reverse order; unidentified output cannot consume an identified start", () => {
  const model = traceFromJournal(RUN, [
    at(1, "control.agent.cell-call-started", { flowName: "read", callId: "first", input: "a" }, 1),
    at(2, "control.agent.cell-call-started", { flowName: "read", callId: "second", input: "b" }, 2),
    at(3, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "unidentified" }, 3),
    at(4, "control.agent.cell-call-settled", { flowName: "read", callId: "second", outcome: "success", value: "B" }, 4),
    at(5, "control.agent.cell-call-settled", { flowName: "read", callId: "first", outcome: "success", value: "A" }, 5)
  ])
  expect(
    model.rows.filter((row) => row.kind === "call").map(
      (row) => [row.id, row.detail.input, row.detail.output, row.endedAt]
    )
  ).toEqual([
    ["call-1", "a", "A", 5],
    ["call-2", "b", "B", 4]
  ])
})

test("native call facts upgrade telemetry through the gateway's shared normalization without a second span", () => {
  const callId = `cell-call-v1:${"a".repeat(64)}`
  const native = (phase: "invoked" | "settled", sequence: number): JournalRecord => ({
    runId: RUN.runId,
    sequence,
    occurredAt: sequence,
    kind: "control.engine.event",
    payload: {
      version: 1,
      sequence,
      eventType: "flows.harness.call-fact.v1",
      executionId: "execution",
      generation: 0,
      emittedAtMs: sequence,
      sourceSequence: 0,
      sourceId: `call-fact-v1:${callId}:${phase}`,
      payload: {
        version: 1,
        phase,
        callId,
        identity: { runId: RUN.runId, frame: 0, cell: "cell", ordinal: 0, declaration: "read", layers: [] },
        flowName: "read",
        input: { path: "a" },
        ...(phase === "settled" ? { outcome: "success", value: "recorded" } : {})
      }
    }
  })
  const model = traceFromJournal(RUN, [
    at(1, "control.agent.cell-call-started", { callId, flowName: "read", input: { truncated: true } }, 1),
    at(2, "control.agent.cell-call-settled", { callId, flowName: "read", outcome: "success", value: "telemetry" }, 2),
    native("invoked", 3),
    native("settled", 4)
  ])
  const calls = model.rows.filter((row) => row.kind === "call")
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ id: "call-1", detail: { input: { path: "a" }, output: "recorded" } })
})

/*
 * What the frame was DOING, over the journal a code-mode run writes: the phase
 * a frame's own calls put it in, the band those phases merge into, the line a
 * person reads instead of the call tree, the moments worth scrubbing to, and
 * the discipline records the controller wrote. Every expectation below is a
 * fact some record carried; none of it is read off what the model said.
 */

/**
 * The targets a plan declares (`flows/coding/schema.ts` `Check.target`), read
 * as explicit recipe inputs: this repo's are build-target
 * LABELS. The path beside them is the other shape a plan may carry, and the
 * two are matched by different rules because they mean different things.
 */
const PLAN_TARGETS = ["//memory:typecheck", "//memory:review", "//ui:typecheck", "//ui:browser", "//ui:canary"]
const CHECKS = { checkTargets: [...PLAN_TARGETS, "tests/admin_views"] }

/** Read, search, edit, check: one frame per stretch, and the run settles. */
const CODE_MODE: ReadonlyArray<JournalRecord> = [
  at(1, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 1000),
  at(2, "control.agent.cell-call-started", { flowName: "read", input: { path: "src/admin/views.py" } }, 1100),
  at(3, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "120 lines" }, 1200),
  at(4, "control.agent.turn-opened", {}, 2000),
  at(5, "control.agent.cell-call-started", { flowName: "grep", input: { pattern: "def get_admin" } }, 2100),
  at(6, "control.agent.cell-call-settled", { flowName: "grep", outcome: "success", value: "3 hits" }, 2200),
  at(7, "control.agent.turn-opened", {}, 3000),
  at(8, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/admin/views.py" } }, 3100),
  at(9, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "+12 −2" }, 3200),
  at(10, "control.agent.mutation-observed", {
    basis: "observed",
    mutated: true,
    digest: "t2",
    paths: 1,
    declaredWrites: 1
  }, 3300),
  at(11, "control.agent.turn-opened", {}, 4000),
  at(12, "control.agent.cell-call-started", { flowName: "bash", input: { command: "pytest tests/admin_views" } }, 4100),
  at(13, "control.agent.cell-call-settled", { flowName: "bash", outcome: "success", value: "12 passed" }, 4900),
  at(14, "control.run.completed", {}, 5000)
]

describe("what the frame was doing", () => {
  test("each phase comes from the calls the frame made, and contiguous frames merge into one band", () => {
    const model = traceFromJournal(RUN, CODE_MODE, CHECKS)
    expect(model.bands).toEqual([
      { phase: "researching", startedAt: 1000, endedAt: 3000, frames: ["frame-1", "frame-2"], seq: 1 },
      { phase: "implementing", startedAt: 3000, endedAt: 4000, frames: ["frame-3"], seq: 7 },
      { phase: "testing", startedAt: 4000, endedAt: 5000, frames: ["frame-4"], seq: 11 }
    ])
  })

  test("a frame's line is its dominant call in plain English, and an unsettled call has no result yet", () => {
    const model = traceFromJournal(RUN, CODE_MODE, CHECKS)
    expect(model.lines).toEqual([
      {
        spanId: "frame-1",
        frame: 1,
        verb: "read",
        subject: "views.py",
        result: "120 lines",
        failed: false,
        wrote: false
      },
      {
        spanId: "frame-2",
        frame: 2,
        verb: "searched",
        subject: "def get_admin",
        result: "3 hits",
        failed: false,
        wrote: false
      },
      {
        spanId: "frame-3",
        frame: 3,
        verb: "edited",
        subject: "views.py",
        result: "+12 −2",
        failed: false,
        wrote: true
      },
      {
        spanId: "frame-4",
        frame: 4,
        verb: "ran",
        subject: "pytest tests/admin_views",
        result: "12 passed",
        failed: false,
        wrote: false
      }
    ])
    // The edit outranks the check in the same frame, and a flow the verb table
    // has never heard of is named by itself.
    const open = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1),
      at(2, "control.agent.cell-call-started", { flowName: "bash", input: { command: "pytest tests/admin_views" } }, 2),
      at(3, "control.agent.cell-call-started", { flowName: "edit", input: { path: "a/b/x.ts" } }, 3),
      at(4, "control.agent.turn-opened", {}, 4),
      at(5, "control.agent.cell-call-started", { flowName: "target.run", input: { label: "//apps/app:unitTests" } }, 5)
    ], CHECKS)
    expect(open.lines).toEqual([
      { spanId: "frame-1", frame: 1, verb: "editing", subject: "x.ts", result: "", failed: false, wrote: false },
      { spanId: "frame-2", frame: 2, verb: "target.run pending", subject: "", result: "", failed: false, wrote: false }
    ])
    // A frame that called nothing has no line; absence is absence.
    expect(traceFromJournal(RUN, [at(1, "control.agent.turn-opened", {}, 1)]).lines).toEqual([])
  })

  test("milestones are the moments worth scrubbing to, and every successful write is one of them", () => {
    const model = traceFromJournal(RUN, CODE_MODE, CHECKS)
    // Every moment names the frame it was recorded under, the frame a scrub to it selects.
    expect(model.milestones).toEqual([
      { seq: 9, at: 3200, label: "views.py", tone: "brand", spanId: "frame-3" },
      { seq: 14, at: 5000, label: "completed", tone: "good", spanId: "frame-4" }
    ])
    // A failed write is not a write.
    const refused = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1),
      at(2, "control.agent.cell-call-started", { flowName: "write", input: { path: "src/x.ts" } }, 2),
      at(3, "control.agent.cell-call-settled", { flowName: "write", outcome: "failure", message: "read-only tree" }, 3),
      at(4, "control.run.failed", {}, 4)
    ])
    expect(refused.milestones).toEqual([{ seq: 4, at: 4, label: "failed", tone: "bad", spanId: "frame-1" }])
    // A person's stop pins the product word, never the journal's `cancelled`.
    const stopped = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1),
      at(2, "control.run.cancelled", {}, 2)
    ])
    expect(stopped.milestones).toEqual([{ seq: 2, at: 2, label: "stopped", tone: "muted", spanId: "frame-1" }])
    expect(refused.lines).toEqual([
      {
        spanId: "frame-1",
        frame: 1,
        verb: "failed to write",
        subject: "x.ts",
        result: "read-only tree",
        failed: true,
        wrote: false
      }
    ])
  })

  test("a frame's writes are one milestone: the first file named and the rest counted", () => {
    // One frame, fifteen successful edits: the strip gets one pin for the
    // moment the frame wrote, not fifteen filenames stacked over one track.
    const writes = (frame: number, paths: ReadonlyArray<string>, from: number): ReadonlyArray<JournalRecord> => [
      at(from, "control.agent.turn-opened", {}, frame * 1000),
      ...paths.flatMap((path, index) => [
        at(
          from + 1 + index * 2,
          "control.agent.cell-call-started",
          { flowName: "edit", input: { path } },
          frame * 1000 + 10 + index * 10
        ),
        at(from + 2 + index * 2, "control.agent.cell-call-settled", {
          flowName: "edit",
          outcome: "success",
          value: "+1"
        }, frame * 1000 + 15 + index * 10)
      ])
    ]
    const fifteen = Array.from({ length: 15 }, (_unused, index) => `src/a${index}.ts`)
    const model = traceFromJournal(RUN, writes(1, fifteen, 1))
    // The pin stands where the frame started writing, which is the file it names.
    expect(model.milestones).toEqual([{ seq: 3, at: 1015, label: "a0.ts +14", tone: "brand", spanId: "frame-1" }])
    // The count is of FILES, the unit a multi-file patch already counts in: a
    // file written twice is one file, and a patch adds the files it names.
    const patch = ["*** Begin Patch", "*** Update File: src/a.ts", "*** Add File: src/c.ts", "*** End Patch"].join("\n")
    const mixed = traceFromJournal(RUN, [
      ...writes(1, ["src/a.ts", "src/a.ts", "src/b.ts"], 1),
      at(8, "control.agent.cell-call-started", { flowName: "apply_patch", input: { input: patch } }, 1100),
      at(9, "control.agent.cell-call-settled", {
        flowName: "apply_patch",
        outcome: "success",
        value: { output: "Success." }
      }, 1110),
      // The next frame's write is its own moment.
      ...writes(2, ["src/a.ts"], 10)
    ])
    expect(mixed.milestones).toEqual([
      { seq: 3, at: 1015, label: "a.ts +2", tone: "brand", spanId: "frame-1" },
      { seq: 12, at: 2015, label: "a.ts", tone: "brand", spanId: "frame-2" }
    ])
  })

  test("a narrowed check is still testing and reports only the narrower command", () => {
    const journal = (command: string): ReadonlyArray<JournalRecord> => [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "bash", input: { command } }, 1100),
      at(3, "control.agent.cell-call-settled", { flowName: "bash", outcome: "success", value: "ok" }, 1500)
    ]
    expect(traceFromJournal(RUN, journal("pytest tests/admin_views"), CHECKS).bands.map((band) => band.phase)).toEqual([
      "testing"
    ])
    const narrowed = traceFromJournal(RUN, journal("pytest tests/admin_views/tests.py"), CHECKS)
    expect(narrowed.bands.map((band) => band.phase)).toEqual(["testing"])
    expect(narrowed.lines[0]?.subject).toBe("pytest tests/admin_views/tests.py")
    expect(traceFromJournal(RUN, journal("pytest tests/admin_views")).bands.map((band) => band.phase)).toEqual([
      "testing"
    ])
  })

  test("a stall streak names the frame it repeats; a check re-run after an edit does not", () => {
    const check = (sequence: number, stamp: number): ReadonlyArray<JournalRecord> => [
      at(sequence, "control.agent.cell-call-started", {
        flowName: "bash",
        input: { command: "pytest tests/admin_views" }
      }, stamp),
      at(
        sequence + 1,
        "control.agent.cell-call-settled",
        { flowName: "bash", outcome: "failure", message: "1 failed" },
        stamp + 700
      )
    ]
    const stalled = traceFromJournal({ ...RUN, status: "running" }, [
      at(1, "control.agent.turn-opened", {}, 1000),
      ...check(2, 1100),
      at(4, "control.agent.turn-opened", {}, 2000),
      ...check(5, 2100),
      at(7, "control.agent.turn-opened", {}, 3000),
      ...check(8, 3100),
      at(10, "control.agent.repeat-demanded", { frames: 3, cap: 4, nextFrame: 4 }, 3900)
    ], CHECKS)
    expect(stalled.lines.map(({ frame, repeatOf }) => ({ frame, repeatOf }))).toEqual([
      { frame: 1, repeatOf: undefined },
      { frame: 2, repeatOf: 1 },
      { frame: 3, repeatOf: 1 }
    ])
    expect(stalled.bands.map((band) => `${band.phase} ${band.frames.join(",")}`)).toEqual([
      "testing frame-1",
      "stuck frame-2,frame-3"
    ])
    // The cap is the run's own armed number, read off the payload.
    expect(stalled.notes).toEqual([
      { seq: 10, spanId: "frame-3", tone: "warn", title: "repeat", body: "3 of 4 frames repeated calls. Frame 4." }
    ])
    // Re-running the same check after an edit is the OPPOSITE of a stall: the
    // frame repeats a call, but no frame beside it does, so nothing is flagged.
    const fixed = traceFromJournal({ ...RUN, status: "running" }, [
      at(1, "control.agent.turn-opened", {}, 1000),
      ...check(2, 1100),
      at(4, "control.agent.turn-opened", {}, 2000),
      at(5, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/admin/views.py" } }, 2100),
      at(6, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "+1 −1" }, 2200),
      at(7, "control.agent.turn-opened", {}, 3000),
      at(
        8,
        "control.agent.cell-call-started",
        { flowName: "bash", input: { command: "pytest tests/admin_views" } },
        3100
      ),
      at(9, "control.agent.cell-call-settled", { flowName: "bash", outcome: "success", value: "12 passed" }, 3900)
    ], CHECKS)
    expect(fixed.lines.every((line) => line.repeatOf === undefined)).toBe(true)
    expect(fixed.bands.map((band) => band.phase)).toEqual(["testing", "implementing", "testing"])
  })

  test("a parked frame and a refused ask both read as blocked", () => {
    const parked = traceFromJournal({ ...RUN, status: "waiting-approval" }, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "write", input: { path: "src/x.ts" } }, 1100),
      at(3, "control.agent.permission-required", { request: { requestId: "req-1" } }, 1200),
      at(4, "control.agent.suspended", { reason: { code: "permission-required" } }, 1300)
    ], CHECKS)
    expect(parked.bands.map((band) => band.phase)).toEqual(["blocked"])
    expect(parked.milestones).toEqual([{ seq: 3, at: 1200, label: "permission", tone: "warn", spanId: "frame-1" }])
    // `ask` settles SUCCESSFULLY with the person's answer, so a refusal is a denial and not a failure.
    const denied = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "ask", input: { question: "write src/x.ts?" } }, 1100),
      at(3, "control.agent.cell-call-settled", {
        flowName: "ask",
        outcome: "success",
        value: { answer: "denied", approved: false }
      }, 1200),
      at(4, "control.agent.turn-opened", {}, 2000),
      at(5, "control.agent.cell-call-started", { flowName: "ask", input: { question: "write src/y.ts?" } }, 2100),
      at(6, "control.agent.cell-call-settled", {
        flowName: "ask",
        outcome: "success",
        value: { answer: "approved", approved: true }
      }, 2200)
    ], CHECKS)
    expect(denied.bands.map((band) => `${band.phase} ${band.frames.join(",")}`)).toEqual([
      "blocked frame-1",
      "unrecorded frame-2"
    ])
  })

  test("a demand's note quotes the payload's own fields, and mutation is noted only when the tree moved", () => {
    const model = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.mutation-observed", {
        basis: "declared",
        mutated: false,
        digest: "t1",
        paths: 0,
        declaredWrites: 0
      }, 1100),
      at(3, "control.agent.narrowed-demanded", {
        flow: "bash",
        broader: "pytest tests/admin_views",
        narrower: "pytest tests/admin_views/tests.py",
        broaderDigest: "t0",
        currentDigest: "t1",
        nextFrame: 2
      }, 1200),
      at(4, "control.agent.unresolved-demanded", {
        flow: "bash",
        failed: "pytest tests/admin_views",
        instead: "ls tests",
        currentDigest: "t1",
        nextFrame: 2
      }, 1300),
      at(5, "control.agent.unmoved-demanded", { openedDigest: "t1", currentDigest: "t1", nextFrame: 2 }, 1400),
      at(
        6,
        "control.agent.checkpoint-minted",
        { id: "cp-1-0", ref: "refs/smithers/cp-1-0", cell: "c1", ordinal: 0 },
        1500
      )
    ], CHECKS)
    expect(model.notes).toEqual([
      {
        seq: 3,
        spanId: "frame-1",
        tone: "bad",
        title: "narrowed",
        body: "bash ran narrower than the reading it stands in for. Frame 2.",
        evidence: ["pytest tests/admin_views", "pytest tests/admin_views/tests.py"]
      },
      {
        seq: 4,
        spanId: "frame-1",
        tone: "bad",
        title: "unresolved",
        body: "bash failed and was not answered. Frame 2.",
        evidence: ["pytest tests/admin_views", "ls tests"]
      },
      {
        seq: 5,
        spanId: "frame-1",
        tone: "bad",
        title: "unmoved",
        body: "The tree the run opened on is the tree it closed on. Frame 2.",
        evidence: ["t1", "t1"]
      },
      { seq: 6, spanId: "frame-1", tone: "good", title: "checkpoint", body: "refs/smithers/cp-1-0" }
    ])
    // The one that moved the tree carries its basis, because a declared answer is paperwork.
    const moved = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1),
      at(2, "control.agent.mutation-observed", {
        basis: "declared",
        mutated: true,
        digest: "",
        paths: 0,
        declaredWrites: 1
      }, 2)
    ])
    expect(moved.notes).toEqual([{ seq: 2, spanId: "frame-1", tone: "warn", title: "changed", body: "declared" }])
    expect(moved.bands.map((band) => band.phase)).toEqual(["implementing"])
  })

  test("a legacy journal's fieldless kinds are read by presence alone, and a drain it cannot show is no steer", () => {
    const model = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      // AgentSession's `default` arm journaled each of these as `payload: {}`.
      at(2, "control.agent.read-only-demand-issued", {}, 1100),
      at(3, "control.agent.narrow-only-demanded", {}, 1200),
      at(4, "control.agent.steering-drained", {}, 1300),
      at(5, "control.agent.sufficiency-observed", {}, 1400),
      at(6, "control.agent.cell-rejected-in-frame", {}, 1500),
      // These two do carry fields, and only a firing is a moment.
      at(7, "control.agent.claim-demanded", {
        complete: 0.4,
        overclaims: 0.9,
        latencyMs: 300,
        demanded: false,
        currentDigest: "t1",
        nextFrame: 2
      }, 1600),
      at(8, "control.agent.claim-demanded", {
        complete: 0.3,
        overclaims: 0.95,
        latencyMs: 310,
        demanded: true,
        currentDigest: "t1",
        nextFrame: 2
      }, 1700),
      at(9, "control.agent.read-only-demanded", { streak: 7, cap: 7, nextFrame: 2, nextAction: "write" }, 1800),
      // The third way a reading comes out: it refused, the run is over, and
      // `demanded` is false. Reading only `demanded` skipped this one.
      at(10, "control.agent.claim-demanded", {
        complete: 0.05,
        overclaims: 0.93,
        invented: 0.89,
        latencyMs: 380,
        demanded: false,
        refused: true,
        currentDigest: "t1",
        nextFrame: 2
      }, 1900)
    ], CHECKS)
    // No steering moment at seq 4: the record does not say a message was delivered.
    expect(model.milestones).toEqual([
      { seq: 2, at: 1100, label: "read-only", tone: "warn", spanId: "frame-1" },
      { seq: 3, at: 1200, label: "narrow-only", tone: "warn", spanId: "frame-1" },
      { seq: 5, at: 1400, label: "sufficiency", tone: "good", spanId: "frame-1" },
      { seq: 8, at: 1700, label: "claim", tone: "bad", spanId: "frame-1" },
      { seq: 9, at: 1800, label: "read-only", tone: "warn", spanId: "frame-1" },
      { seq: 10, at: 1900, label: "claim refused", tone: "bad", spanId: "frame-1" }
    ])
    // A fieldless record has nothing to put in a note, so it writes none.
    expect(model.notes.map(({ seq, title, body }) => ({ seq, title, body }))).toEqual([
      { seq: 8, title: "claim", body: "complete 0.3, overclaims 0.95. Frame 2." },
      // 7, not a constant: a host arms its own read-only cap.
      { seq: 9, title: "read-only", body: "7 of 7 frames changed nothing. Frame 2: write." },
      { seq: 10, title: "claim refused", body: "complete 0.05, overclaims 0.93. Frame 2." }
    ])
  })

  test("the five enriched payloads are read into notes, and a drain that delivered nothing is no steer", () => {
    const model = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-rejected-in-frame", {
        attempt: 2,
        code: "compile_failed",
        message: "SyntaxError: unexpected }"
      }, 1100),
      at(3, "control.agent.read-only-demand-issued", { streak: 4, cap: 4, nextFrame: 2 }, 1200),
      at(4, "control.agent.narrow-only-demanded", {
        flow: "bash",
        check: "pytest tests/admin_views/tests.py",
        targets: ["tests/admin_views/tests.py"],
        currentDigest: "t1",
        nextFrame: 2
      }, 1300),
      // Written whether or not the queue held anything; this one held nothing.
      at(5, "control.agent.steering-drained", { messages: [] }, 1400),
      at(6, "control.agent.steering-drained", { messages: [{ role: "user", text: "stop rewriting the test" }] }, 1500),
      at(7, "control.agent.sufficiency-observed", {
        flow: "bash",
        failed: "pytest tests/admin_views/tests.py",
        passed: "pytest tests/admin_views",
        epoch: 1,
        nextFrame: 2
      }, 1600),
      // A steer too large to trace was still delivered; the record says so, the words are gone.
      at(8, "control.agent.steering-drained", {
        messages: [{ role: "user", text: { truncated: true, bytes: 99_999, digest: "d1" } }]
      }, 1700)
    ], CHECKS)
    expect(model.milestones).toEqual([
      { seq: 3, at: 1200, label: "read-only", tone: "warn", spanId: "frame-1" },
      { seq: 4, at: 1300, label: "narrow-only", tone: "warn", spanId: "frame-1" },
      { seq: 6, at: 1500, label: "steering", tone: "warn", spanId: "frame-1" },
      { seq: 7, at: 1600, label: "sufficiency", tone: "good", spanId: "frame-1" },
      { seq: 8, at: 1700, label: "steering", tone: "warn", spanId: "frame-1" }
    ])
    expect(model.notes).toEqual([
      {
        seq: 2,
        spanId: "frame-1",
        tone: "warn",
        title: "rejected",
        body: "compile_failed. Attempt 2.",
        evidence: ["SyntaxError: unexpected }"]
      },
      { seq: 3, spanId: "frame-1", tone: "warn", title: "read-only", body: "4 of 4 frames changed nothing. Frame 2." },
      {
        seq: 4,
        spanId: "frame-1",
        tone: "warn",
        title: "narrow-only",
        body: "bash ran on tests/admin_views/tests.py and nothing broader. Frame 2.",
        evidence: ["pytest tests/admin_views/tests.py"]
      },
      {
        seq: 6,
        spanId: "frame-1",
        tone: "warn",
        title: "steering",
        body: "1 steer.",
        evidence: ["stop rewriting the test"]
      },
      {
        seq: 7,
        spanId: "frame-1",
        tone: "good",
        title: "sufficiency",
        body: "bash failed before the change and passed after it. Frame 2.",
        evidence: ["pytest tests/admin_views/tests.py", "pytest tests/admin_views"]
      },
      { seq: 8, spanId: "frame-1", tone: "warn", title: "steering", body: "1 steer." }
    ])
    // Nothing the payload carried is dropped: the details pane holds the whole record.
    expect(model.rows.find((span) => span.detail.event === "control.agent.sufficiency-observed")?.detail.fields)
      .toEqual({
        flow: "bash",
        failed: "pytest tests/admin_views/tests.py",
        passed: "pytest tests/admin_views",
        epoch: 1,
        nextFrame: 2
      })
  })

  test("the two-argument call folds the same trace and derives nothing the third argument would have", () => {
    const two = traceFromJournal(RUN, CODE_MODE)
    const three = traceFromJournal(RUN, CODE_MODE, {})
    expect(two.rows.map((span) => `${span.depth}:${span.id}:${span.status}`))
      .toEqual(three.rows.map((span) => `${span.depth}:${span.id}:${span.status}`))
    expect(two.counts).toEqual(three.counts)
    expect(two.extent).toEqual(three.extent)
    expect(two.lines).toEqual(three.lines)
    // The whole existing fixture folds unchanged, and its own frames still read.
    const legacy = traceFromJournal(RUN, JOURNAL)
    expect(legacy.rows.map((span) => span.id)).toEqual(
      traceFromJournal(RUN, JOURNAL, CHECKS).rows.map((span) => span.id)
    )
    expect(legacy.counts).toEqual({ spans: 10, running: 3, failed: 1 })
    // `files.edit` is not a flow the verb table knows, so nothing here is
    // edit-like and both frames merge into the one honest band.
    expect(legacy.bands.map((band) => `${band.phase} ${band.frames.join(",")}`)).toEqual(["unrecorded frame-1,frame-2"])
    expect(legacy.lines.map((line) => `${line.frame} ${line.verb} ${line.subject}`))
      .toEqual(["1 files.read README.md", "2 files.edit pending x.ts"])
    expect(traceFromJournal(RUN, [])).toMatchObject({ bands: [], milestones: [], lines: [], notes: [] })
  })
})

/*
 * The readings an adversarial review probed and found asserted rather than
 * recorded: a re-check after an edit called a stall, a check target matched as
 * raw text, a flow's whole Output rendered into one row, two standard flows
 * whose input this fold could not read, a moment with no axis to sit on, a run
 * with no measured duration, and a phase word put on a frame the journal says
 * nothing about.
 */
describe("what the journal did not say", () => {
  test("fresh file reads beside a repeated listing are not redundant frames", () => {
    const journal = ["a.ts", "b.ts", "c.ts"].flatMap((path, index) => {
      const seq = index * 6 + 1
      return [
        at(seq, "control.agent.turn-opened", {}, seq),
        at(seq + 1, "control.agent.cell-call-started", { flowName: "read", input: { path } }, seq + 1),
        at(seq + 2, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: path }, seq + 2),
        at(seq + 3, "control.agent.cell-call-started", { flowName: "ls", input: { path: "src" } }, seq + 3),
        at(seq + 4, "control.agent.cell-call-settled", {
          flowName: "ls",
          outcome: "success",
          value: ["a.ts", "b.ts", "c.ts"]
        }, seq + 4),
        at(seq + 5, "control.agent.mutation-observed", { basis: "observed", mutated: false, digest: "tree" }, seq + 5)
      ]
    })
    const model = traceFromJournal(RUN, journal)
    expect(model.bands.map((band) => band.phase)).toEqual(["researching"])
    expect(model.lines.map((line) => [line.subject, line.repeatOf])).toEqual([
      ["a.ts", undefined],
      ["b.ts", undefined],
      ["c.ts", undefined]
    ])
  })

  test("an observed unchanged tree outranks successful no-op writes in a stall streak", () => {
    const journal = [0, 1, 2].flatMap((index) => {
      const seq = index * 4 + 1
      return [
        at(seq, "control.agent.turn-opened", {}, seq),
        at(
          seq + 1,
          "control.agent.cell-call-started",
          { flowName: "write", input: { path: "a.ts", content: "same" } },
          seq + 1
        ),
        at(seq + 2, "control.agent.cell-call-settled", {
          flowName: "write",
          outcome: "success",
          value: { path: "a.ts", bytes: 4 }
        }, seq + 2),
        at(seq + 3, "control.agent.mutation-observed", { basis: "observed", mutated: false, digest: "tree" }, seq + 3)
      ]
    })
    const model = traceFromJournal(RUN, journal)
    expect(model.bands.at(-1)).toMatchObject({ phase: "stuck", frames: ["frame-2", "frame-3"] })
    expect(model.lines.map((line) => line.repeatOf)).toEqual([undefined, 1, 1])
  })

  test("a repeat reference belongs to the headline call, not an earlier different call", () => {
    const inputs = [["other"], ["headline"], ["headline", "other"], ["headline", "other"]]
    let seq = 0
    const journal = inputs.flatMap((paths) => [
      at(++seq, "control.agent.turn-opened", {}, seq),
      ...paths.flatMap((path) => [
        at(++seq, "control.agent.cell-call-started", { flowName: "read", input: { path } }, seq),
        at(++seq, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: path }, seq)
      ])
    ])
    expect(traceFromJournal(RUN, journal).lines.map((line) => line.repeatOf)).toEqual([undefined, undefined, 2, 2])
  })

  test("new results and unresolved calls do not establish redundant work", () => {
    for (const pending of [false, true]) {
      let seq = 0
      const journal = ["first", "second", "third"].flatMap((value) => [
        at(++seq, "control.agent.turn-opened", {}, seq),
        at(++seq, "control.agent.cell-call-started", { flowName: "read", input: { path: "a.ts" } }, seq),
        ...(pending
          ? []
          : [at(++seq, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value }, seq)])
      ])
      const model = traceFromJournal(RUN, journal)
      expect(model.bands.some((band) => band.phase === "stuck")).toBe(false)
      expect(model.lines.every((line) => line.repeatOf === undefined)).toBe(true)
    }
  })

  /** One frame per element: a check, an edit, then checks again. */
  const check = (sequence: number, stamp: number): ReadonlyArray<JournalRecord> => [
    at(sequence, "control.agent.cell-call-started", {
      flowName: "bash",
      input: { command: "pytest tests/admin_views" }
    }, stamp),
    at(
      sequence + 1,
      "control.agent.cell-call-settled",
      { flowName: "bash", outcome: "failure", message: "1 failed" },
      stamp + 700
    )
  ]

  test("a check re-run after an edit is not a stall, and a stall that starts after the edit still is", () => {
    // The reviewer's probe: run the check, edit, run the SAME check, repeat.
    // The repeat two frames later must not drag the answering frame in with it.
    const model = traceFromJournal({ ...RUN, status: "running" }, [
      at(1, "control.agent.turn-opened", {}, 1000),
      ...check(2, 1100),
      at(4, "control.agent.turn-opened", {}, 2000),
      at(5, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/admin/views.py" } }, 2100),
      at(6, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "+1 −1" }, 2200),
      at(7, "control.agent.turn-opened", {}, 3000),
      ...check(8, 3100),
      at(10, "control.agent.turn-opened", {}, 4000),
      ...check(11, 4100),
      at(13, "control.agent.turn-opened", {}, 5000),
      ...check(14, 5100)
    ], CHECKS)
    // Frame 3 answers the edit, so it repeats nothing; frames 4 and 5 repeat
    // frame 3, on a tree that has not moved since.
    expect(model.lines.map(({ frame, repeatOf }) => ({ frame, repeatOf }))).toEqual([
      { frame: 1, repeatOf: undefined },
      { frame: 2, repeatOf: undefined },
      { frame: 3, repeatOf: undefined },
      { frame: 4, repeatOf: 3 },
      { frame: 5, repeatOf: 3 }
    ])
    expect(model.bands.map((band) => `${band.phase} ${band.frames.join(",")}`)).toEqual([
      "testing frame-1",
      "implementing frame-2",
      "testing frame-3",
      "stuck frame-4,frame-5"
    ])
  })

  test("check activity is independent of whether its target matches the plan", () => {
    const journal = (command: string): ReadonlyArray<JournalRecord> => [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "bash", input: { command } }, 1100),
      at(3, "control.agent.cell-call-settled", { flowName: "bash", outcome: "success", value: "ok" }, 1500)
    ]
    const phases = (command: string, options = CHECKS) =>
      traceFromJournal(RUN, journal(command), options).bands.map((band) => band.phase)
    // The shape the recipe fixture actually declares.
    expect(PLAN_TARGETS).toContain("//memory:typecheck")
    // A runner puts its own arguments after the label, so the command it ran
    // the check with does not end with it.
    expect(phases("bun run check //memory:typecheck --reporter=dot")).toEqual(["testing"])
    expect(phases("bun run check //memory:typecheck")).toEqual(["testing"])
    expect(phases("bun run check //ui:browser_only")).toEqual(["testing"])
  })

  test("a test invocation stays testing for unrelated, narrow and multiword plan targets", () => {
    const journal = (command: string): ReadonlyArray<JournalRecord> => [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "bash", input: { command } }, 1100),
      at(3, "control.agent.cell-call-settled", { flowName: "bash", outcome: "success", value: "ok" }, 1500)
    ]
    const phases = (command: string, targets: ReadonlyArray<string>) =>
      traceFromJournal(RUN, journal(command), { checkTargets: targets }).bands.map((band) => band.phase)
    // The reviewer's probe: `admin_views` ends with `views` and is not it.
    expect(phases("pytest admin_views", ["views"])).toEqual(["testing"])
    expect(phases("pytest views", ["views"])).toEqual(["testing"])
    expect(phases("pytest tests/admin_views/tests.py", ["tests/admin_views"])).toEqual(["testing"])
    expect(phases("pytest a b", ["a b"])).toEqual(["testing"])
  })

  test("a frame line leaves unsupported structured output in the selected call", () => {
    const model = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "read", input: { path: "src/x.ts" } }, 1100),
      at(3, "control.agent.cell-call-settled", {
        flowName: "read",
        outcome: "success",
        value: { text: "x".repeat(5000) }
      }, 1200)
    ], CHECKS)
    expect(model.lines[0]!.result).toBe("")
    // The span still carries everything the journal carried.
    expect(model.rows.find((span) => span.id === "call-1")?.detail.output?.length).toBeGreaterThan(5000)
  })

  test("apply_patch and test name what they touched, and a write the journal gave no subject mints no pin", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/admin/views.py",
      "@@ def get_admin",
      "-    return None",
      "+    return admin",
      "*** Add File: src/admin/urls.py",
      "+urlpatterns = []",
      "*** End Patch"
    ].join("\n")
    const model = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "apply_patch", input: { input: patch } }, 1100),
      at(3, "control.agent.cell-call-settled", {
        flowName: "apply_patch",
        outcome: "success",
        value: { output: "Success.", added: ["src/admin/urls.py"], modified: ["src/admin/views.py"], deleted: [] }
      }, 1200),
      at(4, "control.agent.turn-opened", {}, 2000),
      at(5, "control.agent.cell-call-started", {
        flowName: "test",
        input: { selection: ["tests/admin_views"], against: "base", timeoutMs: 600_000 }
      }, 2100),
      at(6, "control.agent.cell-call-settled", {
        flowName: "test",
        outcome: "success",
        value: { passed: 12, failed: [] }
      }, 2200)
    ], CHECKS)
    // The patch is not the subject; the files it patches are, the first named and the rest counted.
    expect(model.lines.map((line) => `${line.verb} ${line.subject}`)).toEqual([
      "patched views.py +1",
      "ran tests/admin_views"
    ])
    expect(model.milestones).toEqual([{ seq: 3, at: 1200, label: "views.py +1", tone: "brand", spanId: "frame-1" }])
    // A string that is not a patch names no file, and a pin is its label.
    const blank = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "apply_patch", input: { input: "not a patch" } }, 1100),
      at(
        3,
        "control.agent.cell-call-settled",
        { flowName: "apply_patch", outcome: "success", value: { output: "" } },
        1200
      )
    ], CHECKS)
    expect(blank.milestones).toEqual([])
    expect(blank.lines.map((line) => line.subject)).toEqual([""])
  })

  test("milestones survive a journal that opened no frame; the strip's axis is then the run's own", () => {
    const model = traceFromJournal({ ...RUN, status: "completed" }, [
      at(1, "control.agent.read-only-demanded", { streak: 7, cap: 7, nextFrame: 1, nextAction: "write" }, 1000),
      at(2, "control.agent.sufficiency-observed", {}, 3000)
    ], CHECKS)
    expect(model.bands).toEqual([])
    expect(model.milestones.map((milestone) => milestone.label)).toEqual(["read-only", "sufficiency"])
    expect(phaseExtent(model)).toEqual({ start: 1000, end: 3000 })
    // With bands, the bands are the axis.
    const banded = traceFromJournal(RUN, CODE_MODE, CHECKS)
    expect(phaseExtent(banded)).toEqual({ start: banded.bands[0]!.startedAt, end: banded.bands.at(-1)!.endedAt })
  })

  test("a run with no measured duration lays its bands out by ordinal instead of stacking them at zero", () => {
    const model = traceFromJournal({ ...RUN, status: "completed" }, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "read", input: { path: "src/x.ts" } }, 1000),
      at(3, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "ok" }, 1000),
      at(4, "control.agent.turn-opened", {}, 1000),
      at(5, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/x.ts" } }, 1000),
      at(6, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "+1" }, 1000)
    ], CHECKS)
    const extent = phaseExtent(model)
    expect(extent).toEqual({ start: 1000, end: 1000 })
    expect(model.bands.map((band, index) => phaseBandGeometry(band, extent, index, model.bands.length))).toEqual([
      { left: 0, width: 50 },
      { left: 50, width: 50 }
    ])
    // A measured run is still measured.
    const measured = traceFromJournal(RUN, CODE_MODE, CHECKS)
    const axis = phaseExtent(measured)
    expect(phaseBandGeometry(measured.bands[0]!, axis, 0, measured.bands.length)).toEqual({ left: 0, width: 50 })
  })

  test("a frame the journal says nothing about is not asserted to have been researching", () => {
    const model = traceFromJournal({ ...RUN, status: "completed" }, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.turn-opened", {}, 2000),
      at(3, "control.agent.cell-call-started", { flowName: "read", input: { path: "src/x.ts" } }, 2100),
      at(4, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "ok" }, 2200),
      at(5, "control.run.completed", {}, 3000)
    ], CHECKS)
    // The fold writes no line for frame 1, so it names no phase for it either.
    expect(model.lines.map((line) => line.frame)).toEqual([2])
    expect(model.bands.map((band) => `${band.phase} ${band.frames.join(",")}`)).toEqual([
      "unrecorded frame-1",
      "researching frame-2"
    ])
    // A frame whose only call is the checkpoint mint is the same silence.
    const bookkeeping = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1000),
      at(2, "control.agent.cell-call-started", { flowName: "checkpoint", input: {} }, 1100)
    ], CHECKS)
    expect(bookkeeping.lines).toEqual([])
    expect(bookkeeping.bands.map((band) => band.phase)).toEqual(["unrecorded"])
  })
})
