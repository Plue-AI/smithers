import assert from "node:assert/strict"
import { test } from "node:test"
import * as Cases from "./cases.ts"

const page = (lines: string) =>
  `---
id: probe
principal: builder
kind: accepted
${lines}
---
`

const task = `task:
  objective: Fix the bug.
  inputs: [the issue]
  acceptance: [A regression test fails before and passes after]
  evidence: [revision]`

const role = (source: string): Cases.RoleCase => {
  const parsed = Cases.parse("Org/Cases/probe.md", source)
  assert.equal(parsed.mode, "role", parsed.mode === "invalid" ? parsed.reason : parsed.mode)
  return parsed as Cases.RoleCase
}

const answer = (summary: string, status = "blocked"): Cases.RoleOutcome => ({
  answer: {
    result: { status, summary, fields: {}, evidence: [], handoffs: [], escalations: [], decisions: [] } as never,
    valid: true,
    violations: []
  }
})

test("a mustMention term given as a list is met by any one of its spellings", () => {
  const entry = role(page(`${task}
expect:
  status: blocked
  mustMention:
    - fixture
    - [not-connected, not connected]`))
  assert.deepEqual(entry.expect.mustMention, [["fixture"], ["not-connected", "not connected"]])
  assert.deepEqual(Cases.scoreRole(entry, answer("Fixture passes only; Slack is not connected.")), [])
  assert.deepEqual(Cases.scoreRole(entry, answer("Fixture passes only; Slack status not-connected.")), [])
  assert.deepEqual(Cases.scoreRole(entry, answer("Fixture passes only; Slack is down.")), [
    `does not mention "not-connected" or "not connected"`
  ])
  assert.deepEqual(Cases.scoreRole(entry, answer("Slack is not connected.")), [`does not mention "fixture"`])
})

test("an empty mustMention alternative list is not a case", () => {
  const parsed = Cases.parse(
    "Org/Cases/probe.md",
    page(`${task}
expect:
  status: done
  mustMention: [[]]`)
  )
  assert.deepEqual(parsed, {
    mode: "invalid",
    id: "probe",
    path: "Org/Cases/probe.md",
    reason: "expect.mustMention[0] is empty"
  })
})

test("a workspace case names the revision its workspace starts at", () => {
  const entry = role(page(`requires: [workspace]
revision: 2b70a16cf22202b52b29ab6078c90b3df997569e
${task}
expect:
  status: done`))
  assert.equal(entry.revision, "2b70a16cf22202b52b29ab6078c90b3df997569e")
  assert.equal(Cases.pending(entry), undefined)
  assert.equal(role(page(`requires: [workspace]\n${task}\nexpect:\n  status: done`)).revision, undefined)
})

test("a revision without a workspace is not a case", () => {
  const parsed = Cases.parse(
    "Org/Cases/probe.md",
    page(`revision: main
${task}
expect:
  status: done`)
  )
  assert.equal(parsed.mode, "invalid")
  assert.equal((parsed as Cases.Invalid).reason, "revision needs requires: [workspace]")
})

test("an all-digit revision must be quoted, or YAML would drop its leading zeros", () => {
  const parsed = Cases.parse(
    "Org/Cases/probe.md",
    page(`requires: [workspace]
revision: 0000000000000000000000000000000000000001
${task}
expect:
  status: done`)
  )
  assert.equal((parsed as Cases.Invalid).reason, "revision reads as a number; quote it")
  const quoted = role(page(`requires: [workspace]
revision: "0000000000000000000000000000000000000001"
${task}
expect:
  status: done`))
  assert.equal(quoted.revision, "0000000000000000000000000000000000000001")
})

test("host commands parse into argument lists confined to the drill directory", () => {
  const entry = role(page(`requires: [host-commands]
commands:
  - backup {drill}/backup
  - restore {drill}/backup  --state-dir {drill}/restored --relocate
${task}
expect:
  status: done`))
  assert.deepEqual(entry.commands, [
    ["backup", "{drill}/backup"],
    ["restore", "{drill}/backup", "--state-dir", "{drill}/restored", "--relocate"]
  ])
  assert.equal(Cases.pending(entry), undefined)
  const reason = (lines: string) => {
    const parsed = Cases.parse("Org/Cases/probe.md", page(`${lines}\n${task}\nexpect:\n  status: done`))
    return parsed.mode === "invalid" ? parsed.reason : undefined
  }
  assert.equal(
    reason("requires: [host-commands]\ncommands: [serve]"),
    "commands[0] runs serve, not one of backup, restore"
  )
  assert.equal(
    reason("requires: [host-commands]\ncommands: [backup /tmp/x]"),
    "commands[0] names /tmp/x outside {drill}"
  )
  assert.equal(reason("commands:\n  - backup {drill}/b"), "commands and requires: [host-commands] go together")
  assert.equal(reason("requires: [host-commands]"), "commands and requires: [host-commands] go together")
})

test("a workspace case that checks its change is scored on the diff and the check receipts, not the answer", () => {
  const entry = role(page(`requires: [workspace]
checks:
  - name: refuses the bug
    run: node repro.mjs
${task}
expect:
  status: done
  files: [src/a.ts]
  checks: passed`))
  assert.deepEqual(entry.checks, [{ name: "refuses the bug", argv: ["sh", "-c", "node repro.mjs"] }])
  const done = answer("Fixed; all checks exit 0.", "done")
  const receipt = (name: string, exitCode: number | null, timedOut = false) => ({ name, exitCode, timedOut })
  assert.deepEqual(
    Cases.scoreRole(entry, {
      ...done,
      change: { files: [{ path: "src/a.ts" }] },
      checks: { passed: true, receipts: [receipt("tests", 0), receipt("refuses the bug", 0)] }
    }),
    []
  )
  assert.deepEqual(Cases.scoreRole(entry, done), ["src/a.ts not changed", "no checks ran"])
  assert.deepEqual(
    Cases.scoreRole(entry, {
      ...done,
      change: { files: [{ path: "src/b.ts" }] },
      checks: {
        passed: false,
        receipts: [receipt("tests", 0), receipt("refuses the bug", 1), receipt("slow", null, true)]
      }
    }),
    ["src/a.ts not changed", "checks failed: refuses the bug exit 1, slow timed out"]
  )
  // A case that does not check its change runs no checks.
  assert.equal(role(page(`requires: [workspace]\n${task}\nexpect:\n  status: done`)).checks, undefined)
  const unchecked = Cases.parse("Org/Cases/probe.md", page(`${task}\nexpect:\n  status: done\n  checks: passed`))
  assert.equal((unchecked as Cases.Invalid).reason, "checks and expect.files need requires: [workspace]")
  const wrong = Cases.parse(
    "Org/Cases/probe.md",
    page(`requires: [workspace]\n${task}\nexpect:\n  status: done\n  checks: failed`)
  )
  assert.equal((wrong as Cases.Invalid).reason, "expect.checks is passed")
})
