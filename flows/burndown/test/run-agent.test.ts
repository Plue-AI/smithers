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

for (const tool of ["codex", "claude"] as const) {
  const report = (text: string) => tool === "codex" ? codex(text) : claude(text)
  test(`${tool} reserves explicit mappings before assigning implicit commits`, () => {
    const result = parse(report(`READY ${first}\nREADY #2956 ${second}\nREADY ${first}`), 0, tool)
    assert.equal(result.status, "ready")
    assert.deepEqual(result.commits, [{ issue: 2955, commit: first }, { issue: 2956, commit: second }])
    const reordered = parse(report(`READY #2956 ${second}\nREADY ${first}\nREADY #2956 ${second}`), 0, tool)
    assert.equal(reordered.status, "ready")
    assert.deepEqual([...reordered.commits].sort((a, b) => a.issue - b.issue), result.commits)
  })
  test(`${tool} rejects unassigned BLOCKED and CLOSED results`, () => {
    for (const text of ["BLOCKED #9999 waiting", "CLOSED #9999", `READY ${first}\nBLOCKED #9999 waiting`]) {
      const result = parse(report(text), 0, tool)
      assert.equal(result.status, "failed")
      assert.deepEqual(result.commits, [])
    }
  })
  test(`${tool} requires full commit identifiers`, () => {
    for (const commit of ["abcdef0", "a".repeat(39), "a".repeat(41), "a".repeat(65), "g".repeat(40)]) {
      const result = parse(report(`READY ${commit}`), 0, tool)
      assert.equal(result.status, "failed")
      assert.deepEqual(result.commits, [])
    }
    assert.deepEqual(parse(report(`READY ${"d".repeat(64)}`), 0, tool).commits, [
      { issue: 2955, commit: "d".repeat(64) }
    ])
  })
  test(`${tool} retains separate stderr diagnostics without parsing them as results`, () => {
    const result = parseReport({ ...assignment, tool }, 0, report("BLOCKED #2955 dependency"), 1.25,
      `READY ${first}\nCLOSED #2955\nprivate diagnostic`)
    assert.equal(result.status, "blocked")
    assert.deepEqual(result.commits, [])
    assert.match(result.notes, /private diagnostic/)
    const limited = parseReport({ ...assignment, tool }, 1, report(`READY ${first}`), 1.25, "429 Too Many Requests")
    assert.equal(limited.status, "limited")
    assert.deepEqual(limited.commits, [])
    assert.match(limited.notes, /429 Too Many Requests/)
  })
  test(`${tool} accepts limit words in a successful report without marking it limited`, () => {
    const result = parse(report(`READY ${first}\nNotes: rate limit regression tested`), 0, tool)
    assert.equal(result.status, "ready")
  })
}

test("Codex requires a completed final turn after the last assistant report", () => {
  for (const events of [
    [{ type: "turn.completed" }, { type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } }],
    [{ type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } }, { type: "turn.failed", error: { message: "failure" } }],
    [{ type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } }, { type: "turn.completed" }, { type: "turn.started" }],
    [{ type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } }, { type: "turn.completed" }, { type: "item.completed", item: { type: "agent_message", text: `READY ${second}` } }]
  ]) {
    const result = parse(jsonl(...events))
    assert.equal(result.status, "failed")
    assert.deepEqual(result.commits, [])
  }
})

test("Codex rejects malformed report payloads and ignores nested diagnostic events", () => {
  for (const output of [
    jsonl({ type: "item.completed", item: { type: "agent_message", text: { text: `READY ${first}` } } }, { type: "turn.completed" }),
    jsonl({ type: "item.completed", item: { type: "command_execution", aggregated_output: codex(`READY ${first}`) } }, { type: "turn.completed" }),
    jsonl({ type: "item.updated", item: { type: "agent_message", text: `READY ${first}` } }, { type: "turn.completed" }),
    `{broken json\n${jsonl({ type: "turn.completed" })}`
  ]) {
    const result = parse(output)
    assert.equal(result.status, "failed")
    assert.deepEqual(result.commits, [])
  }
})

test("Claude rejects malformed final results and selects the last result", () => {
  for (const overrides of [{ result: null }, { result: { text: `READY ${first}` } }, { type: "assistant" }, { subtype: "success", is_error: true }]) {
    const result = parse(claude(`READY ${first}`, overrides), 0, "claude")
    assert.equal(result.status, "failed")
    assert.deepEqual(result.commits, [])
  }
  const final = parse(`${claude(`READY ${first}`)}\n${claude("BLOCKED #2955 dependency")}`, 0, "claude")
  assert.equal(final.status, "blocked")
  assert.deepEqual(final.commits, [])
})

for (const tool of ["codex", "claude"] as const) {
  test(`${tool} reserves a later explicit lead before assigning an implicit extra`, () => {
    const text = `READY ${second}\nREADY #2955 ${first}\nREADY ${second}`
    const result = parse(tool === "codex" ? codex(text) : claude(text), 0, tool)
    assert.equal(result.status, "ready")
    assert.deepEqual(result.commits, [{ issue: 2955, commit: first }, { issue: 2956, commit: second }])
  })
}

test("rejects duplicate and cross-repository assigned issues", () => {
  for (const extras of [
    [assignment.lead],
    [{ ...assignment.extras[0]!, repo: "smithersai/plue" }]
  ]) {
    const result = parseReport({ ...assignment, extras }, 0, codex(`READY ${first}`), 1.25)
    assert.equal(result.status, "failed")
    assert.deepEqual(result.commits, [])
  }
})

for (const event of ["turn.failed", "error"] as const) {
  test(`Codex ${event} retains rate-limit status with a zero process exit`, () => {
    const output = jsonl(
      { type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } },
      { type: event, error: { message: "Rate limit reached for this account" } }
    )
    const result = parse(output)
    assert.equal(result.status, "limited")
    assert.deepEqual(result.commits, [])
    assert.match(result.notes, /Rate limit reached/)
  })
}

test("Claude structured rate-limit errors stay limited with a zero process exit", () => {
  const result = parse(claude("You've hit your limit; try again later", {
    subtype: "error_during_execution", is_error: true,
    errors: ["Rate limit reached for this account"]
  }), 0, "claude")
  assert.equal(result.status, "limited")
  assert.deepEqual(result.commits, [])
  assert.match(result.notes, /hit your limit|Rate limit reached/)
})

test("Codex does not reuse an earlier READY after an empty completed turn", () => {
  const result = parse(jsonl(
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } },
    { type: "turn.completed" },
    { type: "turn.started" },
    { type: "turn.completed" }
  ))
  assert.equal(result.status, "failed")
  assert.deepEqual(result.commits, [])
})

for (const message of ["Transient connection error", "429 Too Many Requests"]) {
  test(`Codex recovers a transient error before its successful final report: ${message}`, () => {
    const result = parse(jsonl(
      { type: "turn.started" },
      { type: "error", message },
      { type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } },
      { type: "turn.completed" }
    ))
    assert.equal(result.status, "ready")
    assert.deepEqual(result.commits, [{ issue: 2955, commit: first }])
  })
}

test("Codex cannot recover a failed turn merely by emitting a later completion", () => {
  const result = parse(jsonl(
    { type: "turn.started" },
    { type: "turn.failed", error: { message: "Fatal execution failure" } },
    { type: "item.completed", item: { type: "agent_message", text: `READY ${first}` } },
    { type: "turn.completed" }
  ))
  assert.equal(result.status, "failed")
  assert.deepEqual(result.commits, [])
})

for (const tool of ["codex", "claude"] as const) {
  test(`${tool} queues only an explicitly ready extra when the lead is blocked`, () => {
    for (const text of [
      `BLOCKED #2955 dependency\nREADY #2956 ${second}`,
      `READY #2956 ${second}\nBLOCKED #2955 dependency`,
      `BLOCKED #2955 dependency\nREADY #2956 ${second}\nBLOCKED #2955 dependency`
    ]) {
      const output = tool === "codex" ? codex(text) : claude(text)
      const result = parse(output, 0, tool)
      assert.equal(result.status, "ready")
      assert.deepEqual(result.commits, [{ issue: 2956, commit: second }])
      assert.match(result.notes, /BLOCKED #2955 dependency/)
    }
  })
}

for (const tool of ["codex", "claude"] as const) {
  test(`${tool} does not classify failed exits from quota words in tool output`, () => {
    const toolOutput = tool === "codex"
      ? { type: "item.completed", item: { type: "command_execution", aggregated_output: "rate limit regression" } }
      : { type: "user", message: { content: [{ type: "tool_result", content: "rate limit regression" }] } }
    const final = tool === "codex" ? codex(`READY ${first}`) : claude(`READY ${first}`)
    const result = parse(`${jsonl(toolOutput)}\n${final}`, 1, tool)
    assert.equal(result.status, "failed")
    assert.deepEqual(result.commits, [])
  })
}

for (const tool of ["codex", "claude"] as const) {
  const report = (text: string) => tool === "codex" ? codex(text) : claude(text)
  for (const [name, text] of [
    ["explicit READY then BLOCKED", `READY #2955 ${first}\nBLOCKED #2955 dependency`],
    ["BLOCKED then explicit READY", `BLOCKED #2955 dependency\nREADY #2955 ${first}`],
    ["implicit READY then BLOCKED", `READY ${first}\nBLOCKED #2955 dependency`],
    ["BLOCKED then implicit READY", `BLOCKED #2955 dependency\nREADY ${first}`],
    ["CLOSED then BLOCKED", "CLOSED #2955\nBLOCKED #2955 dependency"],
    ["BLOCKED then CLOSED", "BLOCKED #2955 dependency\nCLOSED #2955"]
  ]) {
    test(`${tool} rejects contradictory ${name} for the same assigned issue`, () => {
      const result = parse(report(text!), 0, tool)
      assert.equal(result.status, "failed")
      assert.deepEqual(result.commits, [])
    })
  }
  test(`${tool} preserves a ready lead when a different assigned issue is blocked`, () => {
    for (const text of [
      `READY #2955 ${first}\nBLOCKED #2956 dependency`,
      `BLOCKED #2956 dependency\nREADY ${first}`
    ]) {
      const result = parse(report(text), 0, tool)
      assert.equal(result.status, "ready")
      assert.deepEqual(result.commits, [{ issue: 2955, commit: first }])
      assert.match(result.notes, /BLOCKED #2956 dependency/)
    }
  })
}

for (const tool of ["codex", "claude"] as const) {
  const report = (text: string) => tool === "codex" ? codex(text) : claude(text)
  for (const [name, opener, nested, closer] of [
    ["different fence marker", "~~~text", "```", "~~~"],
    ["shorter fence marker", "````text", "```", "````"]
  ]) {
    test(`${tool} keeps quoted READY inside a ${name}`, () => {
      const quoted = `${opener}\n${nested}\nREADY ${first}\n${closer}`
      const result = parse(report(quoted), 0, tool)
      assert.equal(result.status, "failed")
      assert.deepEqual(result.commits, [])
      const closed = parse(report(`${quoted}\nREADY ${second}`), 0, tool)
      assert.equal(closed.status, "ready")
      assert.deepEqual(closed.commits, [{ issue: 2955, commit: second }])
    })
  }
}
