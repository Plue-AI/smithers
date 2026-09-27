import { ApprovalPayload } from "@smthrs/control/ControlSchema"
import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const guide = readFileSync(new URL("../docs/guides/script-the-cli.md", import.meta.url), "utf8")
const fences = (text: string) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]!)
const park = fences(guide).find((source) => source.includes("= \"Parked\""))!
const node = fences(guide).find((source) => source.includes("control.approval.requested"))!
const envelope = { budget: {}, capabilities: [], flows: [] }

describe("scripted approval examples", () => {
  it("launches a parked plan after granting the same payload and idempotency key", () => {
    const approval = {
      target: { _tag: "Plan", planId: "plan-1", digest: "digest", envelope },
      scope: "run",
      idempotencyKey: "launch-1"
    }
    const output = execFileSync("bash", [
      "-eu",
      "-c",
      `
granted=0
smthrs() {
  case "$1 $2" in
    "flow execute")
      [ "$3" = "$approval" ] || return 2
      if [ "$granted" = 1 ]; then
        printf '%s\\n' '{"_tag":"Accepted","receiptId":"launch-1","runId":"run-1"}'
      else
        printf '%s\\n' '{"_tag":"Parked","receiptId":"launch-1","planId":"plan-1","status":"waiting-approval"}'
        return 3
      fi ;;
    "approvals approve")
      [ "$3" = "$approval" ] && [ "$4 $5" = "--scope run" ] || return 2
      granted=1
      printf '%s\\n' '{"_tag":"Accepted","receiptId":"launch-1"}' ;;
    *) return 2 ;;
  esac
}
${park}
printf '%s\\n' "$receipt"
`
    ], { encoding: "utf8", timeout: 5_000, env: { ...process.env, approval: JSON.stringify(approval) } })

    expect(output.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { _tag: "Accepted", receiptId: "launch-1" },
      { _tag: "Accepted", receiptId: "launch-1", runId: "run-1" }
    ])
  })

  it("passes the latest event's nested ApprovalPayload to approve", () => {
    const approval = {
      target: { _tag: "Node", runId: "run-1", requestId: "ask-2", digest: "digest", envelope },
      scope: "once",
      idempotencyKey: "answer-2"
    }
    const events = [
      {
        kind: "control.approval.requested",
        payload: { question: "Earlier?", payload: { ...approval, idempotencyKey: "answer-1" } }
      },
      { kind: "control.approval.requested", payload: { question: "Continue?", payload: approval } },
      { kind: "control.run.waiting-approval", payload: {} }
    ]
    const output = execFileSync("bash", [
      "-eu",
      "-c",
      `
smthrs() {
  case "$1 $2" in
    "runs logs") [ "$3 $4" = "run-1 --json" ] || return 2; printf '%s\\n' "$events" ;;
    "approvals approve") [ "$4 $5 $6" = "--scope once --json" ] || return 2; printf '%s\\n' "$3" ;;
    *) return 2 ;;
  esac
}
${node}
`
    ], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        receipt: JSON.stringify({ _tag: "Accepted", runId: "run-1" }),
        events: JSON.stringify(events)
      }
    })

    expect(Schema.decodeUnknownSync(ApprovalPayload)(JSON.parse(output))).toEqual(approval)
  })
})
