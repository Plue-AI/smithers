import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { EntryRowCardSchema } from "@smthrs/rpc/EntryRowCard"
import { MonitorCardSchema } from "@smthrs/rpc/MonitorCard"
import { TimelineLineSchema } from "@smthrs/rpc/TimelineCard"
import { clip, plain, projectSession, readRollout, sentence, type CodexEvent } from "./CodexRollout"

const session = readRollout(readFileSync(new URL("./fixtures/rollout.jsonl", import.meta.url), "utf8"))
const seqOf = (match: (event: CodexEvent) => boolean): number => session.events.find(match)!.seq

describe("readRollout", () => {
  test("keeps the session's identity and skips malformed lines", () => {
    expect(session.id).toBe("0199aaaa-1111-7222-8333-444455556666")
    expect(session.cwd).toBe("/repo")
    expect(session.cli).toBe("0.160.0")
    expect(session.started).toBe(Date.parse("2026-10-05T18:00:00.000Z"))
    expect(session.events.map(event => event.seq)).toEqual(session.events.map((_, index) => index))
  })

  test("drops reasoning and instructions, and classifies commands as reads or runs", () => {
    expect(JSON.stringify(session)).not.toContain("dropped")
    const commands = session.events.filter((event): event is Extract<CodexEvent, { kind: "command" }> => event.kind === "command")
    expect(commands.map(command => [command.command, command.reads, command.failed])).toEqual([
      ["sed -n 1,80p .specs/product/mvp.md", ["Read mvp.md"], false],
      ["go test ./retry", [], true], ["go test ./retry", [], true], ["go test ./retry", [], true],
      ["go test ./retry", [], false],
      ["jj status", [], false]
    ])
    expect(commands[0]!.ms).toBe(40)
  })

  test("clips long output to its start and end", () => {
    const failing = session.events.find(event => event.kind === "command" && event.failed) as Extract<CodexEvent, { kind: "command" }>
    expect(failing.output.startsWith("--- FAIL: TestRetry\n")).toBe(true)
    expect(failing.output).toContain("lines omitted")
    expect(failing.output.length).toBeLessThan(4_100)
    expect(clip("short")).toBe("short")
  })
})

describe("projectSession at the latest position", () => {
  const model = projectSession(session)

  test("every entry, line and the run decode with the app's schemas", () => {
    for (const entry of model.entries) EntryRowCardSchema.parse(entry)
    for (const line of model.lines) TimelineLineSchema.parse(line)
    MonitorCardSchema.parse(model.run)
  })

  test("the conversation reads prompt, answer, goal, interrupted note, prompt, live note", () => {
    expect(model.entries.map(entry => [entry.kind, entry.title, entry.tone])).toEqual([
      ["prompt", "Read the specs and fix the retry bug", "quiet"],
      ["answer", "Fixed the retry bug.", "done"],
      ["prompt", "Goal: finish the spec", "quiet"],
      ["answer", "Auditing the stack service.", "attention"],
      ["prompt", "are you still blocked", "quiet"],
      ["answer", "Checking jj status.", "live"]
    ])
    expect(model.entries[1]!.summary).toBe("Tests pass in retry.")
    expect(model.entries.at(-1)!.state).toBe("working")
  })

  test("one timeline line per entry; turns name their work and glyph their state", () => {
    expect(model.lines.map(line => line.entry_id)).toEqual(model.entries.map(entry => entry.id))
    expect(model.lines.map(line => [line.title, line.glyph])).toEqual([
      ["Read the specs and fix the retry bug", { actor: model.entries[0]!.author }],
      ["Turn 1 · 4 runs · 1 read · 1 edit · 3 failed", { event: "attention" }],
      ["Goal: finish the spec", { actor: model.entries[0]!.author }],
      ["Turn 2 · 1 helper step", { event: "attention" }],
      ["are you still blocked", { actor: model.entries[0]!.author }],
      ["Turn 3 · 1 run", { event: "running" }]
    ])
  })

  test("the run groups turns under the prompt or goal that started them", () => {
    const attempt = model.run.attempts[0]!
    expect(model.run.state).toBe("running")
    expect(attempt.graph.map(node => [node.id, node.label, node.state, node.deps])).toEqual([
      ["ask-1", "Read the specs…", "done", []],
      ["goal", "Goal", "done", ["ask-1"]],
      ["ask-2", "are you still b…", "current", ["goal"]]
    ])
    expect(attempt.steps.map(step => step.key)).toEqual(["ask-1#1", "goal#1", "ask-2#1"])
    expect(attempt.phases.map(phase => [phase.step, phase.tone, phase.indicator, phase.took_s])).toEqual([
      ["ask-1#1", "thrash", "Same command failed 3× with no edit", 11],
      ["goal#1", "fail", "Interrupted", 59],
      ["ask-2#1", "live", undefined, 3]
    ])
  })

  test("cells keep each act's words, code, output, failure and cost", () => {
    const cells = model.run.attempts[0]!.phases[0]!.cells
    expect(cells.map(cell => [cell.kind, cell.label, cell.tone])).toEqual([
      ["steer", "Read the specs and fix the retry bug", undefined],
      ["think", "I'll read the spec first.", undefined],
      ["read", "Read mvp.md", undefined],
      ["run", "Ran go test ./retry · exit 1", "fail"], ["run", "Ran go test ./retry · exit 1", "fail"], ["run", "Ran go test ./retry · exit 1", "fail"],
      ["edit", "Edited retry.go", undefined],
      ["run", "Ran go test ./retry", undefined],
      ["read", "Searched the web: go retry backoff", undefined],
      ["answer", "Fixed the retry bug.", undefined]
    ])
    expect(cells[3]!.took_s).toBe(2.5)
    expect(cells[6]!.code).toContain("+b")
    expect(cells.at(-1)!.tokens).toBe(1500)
    expect(cells.at(-1)!.quote).toContain("**Fixed the retry bug.**")
  })

  test("settings, tokens, time and the journal follow the session", () => {
    expect(model.settings).toEqual({ model: "gpt-6-astra", effort: "high", tier: "ultrafast", sandbox: "workspace-write" })
    expect(model.run.tokens).toBe(2200)
    expect(model.run.time_s).toBe(123)
    expect(model.run.replay).toEqual({ at: session.events.length - 1, last: session.events.length - 1 })
    expect(model.run.journal!.some(entry => entry.type === "tokens")).toBe(false)
    expect(model.run.journal!.find(entry => entry.type === "command")!.step).toBe("ask-1#1")
  })
})

describe("projectSession at an earlier position", () => {
  test("before the first answer, turn 1 is live and nothing after it exists", () => {
    const at = seqOf(event => event.kind === "edit")
    const model = projectSession(session, at)
    expect(model.at).toBe(at)
    expect(model.clock).toBe(Date.parse("2026-10-05T18:00:10.000Z"))
    expect(model.entries.map(entry => [entry.kind, entry.tone])).toEqual([["prompt", "quiet"], ["answer", "live"]])
    expect(model.entries[1]!.title).toBe("I'll read the spec first.")
    expect(model.run.state).toBe("running")
    // Live wins over the flag while the turn works; the flag still shows.
    expect(model.run.attempts[0]!.phases[0]!.tone).toBe("live")
    expect(model.run.attempts[0]!.phases[0]!.indicator).toBe("Same command failed 3× with no edit")
    expect(model.run.attempts[0]!.phases[0]!.cells.at(-1)!.kind).toBe("edit")
    expect(model.run.journal!.at(-1)!.seq).toBe(session.events.length - 1)
    expect(model.run.journal!.find(entry => entry.seq > at)!.step).toBe("ask-1#1")  // turn 1 already exists
    expect(model.run.journal!.find(entry => entry.type === "prompt" && entry.seq > at)!.step).toBeUndefined()  // turn 3 does not
  })

  test("a turn that has said nothing yet works below its prompt", () => {
    const model = projectSession(session, seqOf(event => event.kind === "prompt"))
    expect(model.entries.map(entry => [entry.kind, entry.title, entry.tone])).toEqual([["prompt", "Read the specs and fix the retry bug", "quiet"], ["answer", "Working", "live"]])
    expect(model.lines.at(-1)!.glyph).toEqual({ event: "running" })
  })

  test("between turns the session waits for a person", () => {
    const model = projectSession(session, seqOf(event => event.kind === "done"))
    expect(model.run.state).toBe("waiting")
    expect(model.run.attempts[0]!.graph.map(node => node.state)).toEqual(["done"])
    expect(model.lines.at(-1)!.glyph).toEqual({ event: "attention" })  // turn 1 thrashed
  })

  test("a goal update with the same objective adds no entry", () => {
    const model = projectSession(session, seqOf(event => event.kind === "goal" && event.seq > 20))
    expect(model.entries.filter(entry => entry.title.startsWith("Goal:"))).toHaveLength(1)
  })

  test("positions clamp to the session", () => {
    expect(projectSession(session, -5).at).toBe(0)
    expect(projectSession(session, 10_000).at).toBe(session.events.length - 1)
    expect(projectSession(session, 0).entries).toEqual([])
  })
})

describe("text helpers", () => {
  test("plain drops Markdown; sentence keeps the first sentence within its limit", () => {
    expect(plain("**Bold** [link](https://x.test) `code`\n- item")).toBe("Bold link code item")
    expect(plain("before\n```sh\nrm -rf /\n```\nafter")).toBe("before after")
    expect(sentence("One. Two.")).toBe("One.")
    expect(sentence("No stop at all")).toBe("No stop at all")
    expect(sentence("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`)
  })
})
