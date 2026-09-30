import * as AgentEvent from "@smthrs/harness/AgentEvent"
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Summary from "../src/summary.ts"
import * as Transcript from "../src/transcript.ts"

/** A recorded gpt-5.6-sol run that fixes `add` in a scratch repo. */
const recorded = readFileSync(join(import.meta.dir, "fixtures/fix-add.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))

const replay = (upTo = recorded.length) =>
  recorded.slice(0, upTo).reduce(
    (transcript, { at, event }) => Transcript.apply(transcript, event, at),
    Transcript.user(Transcript.empty, "node check.mjs fails. Fix it and show it passes.")
  )

const cells = (transcript: Transcript.Transcript) =>
  transcript.items.filter((item): item is Extract<Transcript.Item, { kind: "cell" }> => item.kind === "cell")

describe("replaying a recorded run", () => {
  it("drops the refused seat's streaming text before rendering the fallback", () => {
    const events = [
      { _tag: "model-requested" },
      { _tag: "model-delta", delta: { type: "text-delta", text: "seat one partial" } },
      { _tag: "model-retried", code: "rate_limited" },
      { _tag: "model-delta", delta: { type: "text-delta", text: "fallback reply" } }
    ]
    const transcript = events.reduce(
      (state, event, at) => Transcript.apply(state, event as never, at),
      Transcript.empty
    )
    expect(transcript.streaming).toBe("fallback reply")
    expect(cells(transcript).map((cell) => cell.prose)).toEqual(["fallback reply"])
    expect(transcript.items.some((item) => item.kind === "cell" && item.prose.includes("seat one"))).toBe(false)
  })
  it("shows one settled cell per produced program, then the answer", () => {
    const transcript = replay()
    const produced = recorded.filter(({ event }) => event._tag === "cell-produced").map(({ event }) => event.cell.text)
    expect(cells(transcript).map((cell) => cell.source)).toEqual(produced)
    expect(cells(transcript).every((cell) => cell.status === "done" && cell.endedAt !== undefined)).toBe(true)
    expect(transcript.items.at(-1)).toMatchObject({ kind: "answer" })
    expect(transcript.items.map((item: Transcript.Item) => item.kind).filter((kind: string) => kind !== "cell"))
      .toEqual(["user", "answer"])
  })

  it("attaches every flow call to the cell that made it, settled", () => {
    const calls = cells(replay()).flatMap((cell) => cell.calls)
    expect(calls.length).toBe(recorded.filter(({ event }) => event._tag === "cell-call-started").length)
    expect(calls.every((call) => call.status !== "running" && call.endedAt !== undefined)).toBe(true)
    expect(calls.some((call) => call.flow === "bash" && call.subject.includes("node check.mjs"))).toBe(true)
  })

  it("streams a cell's code before the harness runs it", () => {
    const produced = recorded.findIndex(({ event }) => event._tag === "cell-produced")
    const first = cells(replay(produced))[0]!
    const final = recorded[produced].event.cell.text as string
    expect(first.status).toBe("writing")
    expect(first.source.length).toBeGreaterThan(0)
    expect(final.startsWith(first.source.slice(0, 20))).toBe(true)
  })

  it("starts a cell's clock when its model call was requested", () => {
    const requested = recorded.find(({ event }) => event._tag === "model-requested")!
    expect(cells(replay())[0]!.startedAt).toBe(requested.at)
  })

  it("records every command's exit status on its call, zero included", () => {
    const calls = cells(replay()).flatMap((cell) => cell.calls)
    const exited = recorded.filter(({ event }) =>
      event._tag === "cell-call-settled" && typeof event.result.value?.exitCode === "number"
    )
    expect(exited.some(({ event }) => event.result.value.exitCode !== 0)).toBe(true)
    expect(exited.some(({ event }) => event.result.value.exitCode === 0)).toBe(true)
    expect(calls.filter((call) => call.exit !== undefined).map((call) => call.exit)).toEqual(
      exited.map(({ event }) => event.result.value.exitCode)
    )
  })
})

describe("usage", () => {
  const settled = (usage: Record<string, number>, cost: Record<string, unknown> = {}) =>
    ({ _tag: "model-settled", message: { role: "assistant", content: [] }, usage, ...cost }) as unknown as Parameters<
      typeof Transcript.apply
    >[1]

  it("sums each priced call's USD and leaves an unpriced call at zero", () => {
    const after = [
      settled({ inputTokens: 100, outputTokens: 10 }, { costUsd: 0.25, costSource: "estimated" }),
      settled({ inputTokens: 50, outputTokens: 5 }),
      settled({ inputTokens: 20, outputTokens: 2 }, { costUsd: 0.5, costSource: "reported" })
    ].reduce((transcript, event) => Transcript.apply(transcript, event, 0), Transcript.empty)
    expect(after.usage).toEqual({ input: 170, output: 17, cached: 0, context: 20, usd: 0.75 })
  })
})

describe("split", () => {
  it("separates prose from an unterminated fence while it streams", () => {
    expect(Transcript.split("Reading it.\n```cell\nconst a = 1")).toEqual({ prose: "Reading it.", code: "const a = 1" })
  })

  it("waits for the info string before showing code", () => {
    expect(Transcript.split("```ce")).toEqual({ prose: "", code: "" })
  })

  it("joins several blocks and keeps prose after them", () => {
    expect(Transcript.split("```cell\na()\n```\nthen\n```cell\nb()\n```\ndone")).toEqual({
      prose: "then\ndone",
      code: "a()\nb()"
    })
  })
})

describe("Jev context assessment", () => {
  const reading = (scope: string, frame: number, outdatedContext?: number, irrelevantContext?: number) =>
    ({
      _tag: "supervisor-settled",
      scope,
      frame,
      outdatedContext,
      irrelevantContext
    }) as never

  it("keeps outdated and irrelevant separate across replay and ignores late older frames", () => {
    const outdated = Transcript.apply(Transcript.empty, reading("run", 2, 0.8, 0.1), 0)
    expect(outdated.contextAssessment).toEqual({ scope: "run", frame: 2, outdated: true, irrelevant: false })
    const late = Transcript.apply(outdated, reading("run", 1, 0.1, 0.9), 1)
    expect(late).toBe(outdated)
    const irrelevant = Transcript.apply(late, reading("run", 3, 0.1, 0.9), 2)
    expect(irrelevant.contextAssessment).toEqual({ scope: "run", frame: 3, outdated: false, irrelevant: true })
    expect(Transcript.apply(irrelevant, reading("run", 4, 0.1, 0.1), 3).contextAssessment).toMatchObject({
      outdated: false,
      irrelevant: false
    })
  })
})

describe("memory opening availability", () => {
  const unjudged = (scope: string, classifier: string, frame = 0) =>
    new AgentEvent.DecisionUnjudged({
      eventType: AgentEvent.eventType.decisionUnjudged,
      scope,
      frame,
      classifier,
      reason: "unreachable",
      detail: "Judge unavailable",
      items: 2
    })
  const fault = (scope: string, operation: "recall" | "remember", frame = 0) =>
    new AgentEvent.SupervisorMemoryFailed({
      eventType: AgentEvent.eventType.supervisorMemoryFailed,
      scope,
      frame,
      operation,
      detail: "judge_failed: invalid answer"
    })
  const notes = (transcript: Transcript.Transcript) =>
    transcript.items.filter((item) => item.kind === "note").map((item) => item.text)

  it("shows one row for repeated unjudged memory readings in a run", () => {
    const first = Transcript.apply(Transcript.empty, unjudged("worker-1", "memory/needed"), 1)
    expect(notes(first)).toEqual(["→ memory unavailable"])
    const repeated = Transcript.apply(first, unjudged("worker-1", "memory/descend"), 2)
    expect(notes(repeated)).toEqual(["→ memory unavailable"])
    const second = Transcript.apply(repeated, unjudged("worker-2", "memory/needed"), 3)
    expect(notes(second)).toEqual(["→ memory unavailable", "→ memory unavailable"])
    const interleaved = Transcript.apply(second, unjudged("worker-1", "memory/descend"), 4)
    expect(notes(interleaved)).toEqual(["→ memory unavailable", "→ memory unavailable"])
  })

  it("shows a failed memory opening once even if an unjudged reading follows", () => {
    const failed = Transcript.apply(Transcript.empty, fault("worker-1", "recall"), 1)
    expect(notes(failed)).toEqual(["→ memory unavailable"])
    expect(notes(Transcript.apply(failed, unjudged("worker-1", "memory/needed"), 2)))
      .toEqual(["→ memory unavailable"])
  })

  it("ignores unrelated unjudged readings and memory writes", () => {
    const other = Transcript.apply(Transcript.empty, unjudged("worker-1", "relevance/unnecessary"), 1)
    expect(notes(Transcript.apply(other, fault("worker-1", "remember"), 2))).toEqual([])
  })

  it("ignores memory failures after the opening frame", () => {
    const laterReading = Transcript.apply(Transcript.empty, unjudged("worker-1", "memory/needed", 1), 1)
    const laterRecall = Transcript.apply(laterReading, fault("worker-1", "recall", 2), 2)
    expect(notes(laterRecall)).toEqual([])
  })
})

describe("failures", () => {
  it("marks the open cell failed and shows the message", () => {
    const writing = Transcript.apply(
      Transcript.empty,
      { _tag: "model-delta", delta: { type: "text-delta", id: "m", text: "```cell\nx(" } } as never,
      0
    )
    const failed = Transcript.failure(writing, "Our servers are currently overloaded.", 5)
    expect(cells(failed)[0]).toMatchObject({ status: "failed", endedAt: 5 })
    expect(failed.items.at(-1)).toMatchObject({ kind: "error", text: "Our servers are currently overloaded." })
  })
})

describe("a turn that only calls ctx.done", () => {
  const turn = (code: string, answer: string) =>
    [
      { _tag: "model-requested" },
      { _tag: "model-delta", delta: { type: "text-delta", text: `The seat is sol.\n\`\`\`cell\n${code}\n\`\`\`` } },
      { _tag: "cell-produced", cell: { language: "javascript", text: code } },
      { _tag: "cell-settled", outcome: { _tag: "settled" } },
      { _tag: "resolved", message: { role: "assistant", content: [{ type: "text", text: answer }] } }
    ].reduce(
      (transcript, event, at) => Transcript.apply(transcript, event as never, at),
      Transcript.user(Transcript.empty, "which seat?")
    )

  it("shows the answer once, without the cell that restates it", () => {
    const transcript = turn(`ctx.done("The seat is sol.")`, "The seat is sol.")
    expect(transcript.items.map((item) => item.kind)).toEqual(["user", "answer"])
  })

  it("keeps a cell that did work before finishing", () => {
    const transcript = turn(`const seat = 1\nctx.done("The seat is sol.")`, "The seat is sol.")
    expect(transcript.items.map((item) => item.kind)).toEqual(["user", "cell", "answer"])
  })
})

describe("a reply the harness re-asks inside its frame", () => {
  // Recorded 2026-09-23 (session bd2275ea, frame 1 of tui-52909-15): a
  // prose-only reply, the in-frame `no_cell` rejection, the re-ask's cell.
  const rejection =
    "No cell was found in the response. Emit a fenced ```cell block containing the JavaScript for this transition."
  const events = [
    { _tag: "model-requested", frame: 1, attempt: 1 },
    {
      _tag: "model-delta",
      delta: { type: "text-delta", text: "\n\nRequested the default-accept permissions change." }
    },
    { _tag: "model-settled", message: { role: "assistant", content: [] }, usage: {} },
    { _tag: "cell-rejected-in-frame", attempt: 1, code: "no_cell", message: rejection },
    { _tag: "model-requested", frame: 1, attempt: 2 },
    { _tag: "model-delta", delta: { type: "text-delta", text: "\n\n```cell\nctx.done(\"Requested.\")\n```" } },
    { _tag: "model-settled", message: { role: "assistant", content: [] }, usage: {} },
    {
      _tag: "cell-produced",
      cell: { language: "javascript", text: "ctx.done(\"Requested.\")", digest: "b94e" },
      blocks: 1
    },
    { _tag: "cell-printed", cell: "b94e", text: "" },
    {
      _tag: "cell-settled",
      cell: "b94e",
      outcome: { _tag: "settled", transition: { _tag: "complete", output: "Requested." } }
    },
    {
      _tag: "resolved",
      message: { role: "assistant", content: [{ type: "text", text: "Requested." }], stopReason: "stop" }
    }
  ] as unknown as ReadonlyArray<Parameters<typeof Transcript.apply>[1]>
  const fold = (upTo = events.length) =>
    events.slice(0, upTo).reduce(
      (transcript, event, at) => Transcript.apply(transcript, event, at),
      Transcript.user(Transcript.empty, "Make permissions default-accept.")
    )

  it("never shows the harness's re-ask to the user", () => {
    const shown = JSON.stringify(fold().items)
    expect(shown).not.toContain("No cell was found")
    expect(shown).not.toContain("default-accept permissions change")
    expect(fold().items.map((item) => item.kind)).toEqual(["user", "answer"])
  })

  it("numbers the re-asked cell as the attempt it replaced", () => {
    const rejected = fold(4)
    expect(cells(rejected)).toEqual([])
    expect(cells(fold(8))).toMatchObject([{ index: 1, source: "ctx.done(\"Requested.\")", status: "running" }])
  })

  it("shows a frame's final rejection by its code, never the model-facing instruction", () => {
    const settled = [
      events[0]!,
      events[1]!,
      { _tag: "cell-settled", cell: "", outcome: { _tag: "rejected", code: "no_cell", message: rejection } }
    ] as unknown as ReadonlyArray<Parameters<typeof Transcript.apply>[1]>
    const transcript = settled.reduce((current, event, at) => Transcript.apply(current, event, at), Transcript.empty)
    expect(cells(transcript)).toMatchObject([{ status: "rejected", error: "no_cell" }])
    expect(Summary.panel(transcript).rows[0]).toMatchObject({ label: "Rejected: no_cell", status: "failed" })
    expect(JSON.stringify(Summary.panel(transcript))).not.toContain("No cell was found")
  })
})

describe("cards", () => {
  const plan = {
    id: "release",
    title: "Release plan",
    summary: "Two steps left.",
    rows: [{ id: "changelog", label: "Changelog", status: "done" as const, details: [] }]
  }
  it("adds one card per panel id and updates it in place on republish", () => {
    let transcript = Transcript.user(Transcript.empty, "Plan the release", false, 1)
    transcript = Transcript.card(transcript, plan, 2)
    transcript = Transcript.note(transcript, "later", 3)
    const updated = { ...plan, summary: "One step left." }
    transcript = Transcript.card(transcript, updated, 4)
    const cards = transcript.items.filter((item) => item.kind === "card")
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: "card", panel: updated, at: 2 })
    expect(transcript.items.map((item) => item.kind)).toEqual(["user", "card", "note"])
  })
})
