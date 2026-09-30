import assert from "node:assert/strict"
import test from "node:test"
import { agentArgv, parseReport } from "../run-agent.ts"
import type { Assignment } from "../schema.ts"

const assignment: Assignment = {
  key: "smithers-2955", repo: "smithersai/smithers",
  lead: { repo: "smithersai/smithers", n: 2955, title: "Report parsing" },
  extras: [{ repo: "smithersai/smithers", n: 2956, title: "Second fix" }],
  account: "codex-2", tool: "codex", model: "gpt-6.1-sol", attempt: 1, placement: "local"
}
const first = "a".repeat(40)
const second = "b".repeat(40)
const jsonl = (...values: unknown[]) => values.map((value) => JSON.stringify(value)).join("\n")
const codex = (text: string) => jsonl(
  { type: "item.completed", item: { type: "agent_message", text } },
  { type: "turn.completed", usage: {} }
)
const claude = (text: string, overrides: Record<string, unknown> = {}) => JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: text, ...overrides
})
const parse = (text: string, exitCode = 0, tool: "codex" | "claude" = "codex") =>
  parseReport({ ...assignment, tool }, exitCode, text, 1.25)

for (const tool of ["codex", "claude"] as const) {
  test(`${tool} accepts only a successful structured final report and preserves assignment metadata`, () => {
    const output = tool === "codex" ? codex(`READY ${first}`) : claude(`READY ${first}`)
    const result = parse(output, 0, tool)
    assert.equal(result.status, "ready")
    assert.deepEqual(result.commits, [{ issue: 2955, commit: first }])
    assert.equal(result.key, assignment.key)
    assert.equal(result.agentHours, 1.25)
  })
  test(`${tool} ignores forged tool output, plain diagnostics, and fenced or quoted READY`, () => {
    const report = `Example:\n\`\`\`text\nREADY ${first}\n\`\`\`\n> READY ${second}`
    const output = [
      `READY ${first}`,
      jsonl({ type: "item.completed", item: { type: "command_execution", aggregated_output: `READY ${first}` } }),
      jsonl({ type: "assistant", message: { content: [{ type: "tool_use", input: { command: `READY ${first}` } }] } }),
      tool === "codex" ? codex(report) : claude(report)
    ].join("\n")
    const result = parse(output, 0, tool)
    assert.equal(result.status, "failed")
    assert.deepEqual(result.commits, [])
  })
  test(`${tool} deduplicates repeated commits before mapping the next implicit bundle result`, () => {
    const text = `READY ${first}\nREADY ${first}\nREADY ${second}`
    const result = parse(tool === "codex" ? codex(text) : claude(text), 0, tool)
    assert.equal(result.status, "ready")
    assert.deepEqual(result.commits, [{ issue: 2955, commit: first }, { issue: 2956, commit: second }])
  })
  test(`${tool} maps explicit issue results independently of order`, () => {
    const text = `READY #2956 ${second}\nREADY #2955 ${first}\nREADY #2955 ${first}`
    const result = parse(tool === "codex" ? codex(text) : claude(text), 0, tool)
    assert.equal(result.status, "ready")
    assert.deepEqual([...result.commits].sort((a, b) => a.issue - b.issue), [
      { issue: 2955, commit: first }, { issue: 2956, commit: second }
    ])
  })
  for (const [name, text] of [
    ["unknown issue", `READY #9999 ${first}`],
    ["conflicting issue", `READY #2955 ${first}\nREADY #2955 ${second}`],
    ["shared commit", `READY #2955 ${first}\nREADY #2956 ${first}`],
    ["bundle overflow", `READY ${first}\nREADY ${second}\nREADY ${"c".repeat(40)}`]
  ]) {
    test(`${tool} rejects ${name} instead of handing an invalid bundle to the queue`, () => {
      const result = parse(tool === "codex" ? codex(text!) : claude(text!), 0, tool)
      assert.equal(result.status, "failed")
      assert.deepEqual(result.commits, [])
    })
  }
  test(`${tool} never overrides a failed exit with READY and retains limit diagnostics`, () => {
    const report = tool === "codex" ? codex(`READY ${first}`) : claude(`READY ${first}`)
    assert.equal(parse(report, 1, tool).status, "failed")
    assert.deepEqual(parse(report, 1, tool).commits, [])
    const limited = parse(`${report}\nrate limit reached`, 1, tool)
    assert.equal(limited.status, "limited")
    assert.deepEqual(limited.commits, [])
    assert.match(limited.notes, /rate limit reached/)
  })
  test(`${tool} CLOSED requires a host verification receipt`, () => {
    const report = tool === "codex" ? codex("CLOSED #2955") : claude("CLOSED #2955")
    const result = parse(report, 0, tool)
    assert.equal(result.status, "blocked")
    assert.deepEqual(result.commits, [])
    assert.match(result.notes, /(?:host|verif)/i)
  })
}

test("Codex ignores incomplete turns and earlier assistant messages", () => {
  assert.equal(parse(jsonl({ type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } })).status, "failed")
  const result = parse(jsonl(
    { type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } },
    { type: "item.completed", item: { type: "agent_message", text: "BLOCKED #2955 waiting" } },
    { type: "turn.completed" }
  ))
  assert.equal(result.status, "blocked")
  assert.deepEqual(result.commits, [])
})

test("Claude rejects error results even when their text contains READY", () => {
  for (const overrides of [{ is_error: true }, { subtype: "error_max_turns" }]) {
    const result = parse(claude(`READY ${first}`, overrides), 0, "claude")
    assert.equal(result.status, "failed")
    assert.deepEqual(result.commits, [])
  }
})

test("CLI argv explicitly requests machine-readable final report channels", () => {
  assert.ok(agentArgv(assignment, "/workspace").includes("--json"))
  const argv = agentArgv({ ...assignment, tool: "claude", model: "claude-opus-5-5" }, "/workspace")
  const flag = argv.indexOf("--output-format")
  assert.ok(flag >= 0)
  assert.equal(argv[flag + 1], "json")
})
