import assert from "node:assert/strict"
import test from "node:test"
import { brief } from "../brief.ts"

const options = {
  repo: "smithersai/smithers",
  lead: { n: 42, title: "Repair selection" },
  workdir: "/workspace/smithers",
  landing: { claimBy: "dispatch-smithers-42", lockPath: "/receipts/landing.lock" }
}

test("brief carries assigned scope and safe queued landing contract", () => {
  const text = brief(options)
  for (
    const required of [
      "smithersai/smithers#42",
      "/workspace/smithers",
      "dispatch-smithers-42",
      "READY <commit-id>",
      "TDD",
      "Zero tech debt",
      "claude-fable-5-1"
    ]
  ) assert.ok(text.includes(required), required)
  assert.match(text, /one commit per issue/i)
  assert.match(text, /(?:never[^\n]*push[^\n]*main|does NOT push main)/i)
  assert.match(text, /refresh/i)
  assert.match(text, /release/i)
  assert.match(text, /keep[^\n]*claim[^\n]*(?:ready|queue)|(?:ready|queue)[^\n]*keep[^\n]*claim/i)
  for (const account of ["~/.claude", "claude-4", "claude-6", "will@codeplane.app"]) {
    assert.ok(text.includes(account), account)
  }
  assert.match(text, /(?:sol|opus)/i)
})

test("brief lists extras and other owners without assigning their work", () => {
  const text = brief({
    ...options,
    extras: [{ n: 43, title: "Shared source repair" }, { n: 44, title: "Second repair" }],
    others: [{ repo: "smithersai/plue", n: 9, title: "Deployment" }]
  })
  for (const required of ["#43", "Shared source repair", "#44", "Second repair", "smithersai/plue#9", "Deployment"]) {
    assert.ok(text.includes(required), required)
  }
  assert.match(text, /(?:lead|#42)[^\n]*first/i)
  assert.match(text, /(?:unrelated|hard|blocked)/i)
})

test("blocked brief distinguishes decisions from operator-only actions", () => {
  const text = brief({ ...options, lead: { ...options.lead, blocked: true } })
  assert.ok(text.includes("blocked-on-will"))
  assert.ok(text.includes("Decision (on Will's behalf):"))
  assert.match(text, /(?:credential|secret)/i)
  assert.match(text, /(?:payment|DNS|signup)/i)
  assert.match(text, /keep[^\n]*label/i)
})

test("brief uses canonical repo and shared default VCS lock", () => {
  const text = brief({
    ...options,
    repo: "smithers",
    landing: { claimBy: "dispatch-smithers-42" },
    others: [{ repo: "plue", n: 9, title: "Deployment" }]
  })
  assert.ok(text.includes("smithersai/smithers#42"))
  assert.ok(text.includes("smithersai/plue#9"))
  assert.ok(text.includes("python3 ~/Smithers-Ops/dispatch/vcs_lock.py smithers"))
})

test("claim instructions supply executable subcommands and preserve launcher ownership across hosts", () => {
  const text = brief(options)
  assert.ok(
    text.includes("node ~/smithers/scripts/issue-claim.mjs claim smithersai/smithers#42 --by dispatch-smithers-42")
  )
  assert.ok(
    text.includes(
      "node ~/smithers/scripts/issue-claim.mjs release smithersai/smithers#42 --by dispatch-smithers-42 --note"
    )
  )
  assert.match(text, /each assigned issue/i)
  assert.match(text, /(?:hostname|host)[^\n]*(?:differs|different)/i)
  assert.match(text, /(?:launcher|host)[^\n]*(?:refresh|release)/i)
  assert.match(text, /never[^\n]*(?:force|take over)/i)
  assert.match(text, /durable notes/i)
})

test("claim mutations require a successful mine check even after expiry", () => {
  const text = brief(options)
  assert.ok(
    text.includes("node ~/smithers/scripts/issue-claim.mjs check smithersai/smithers#42 --by dispatch-smithers-42")
  )
  assert.match(text, /(?:claim|release)[^\n]*ONLY when[^\n]*"mine":true/)
  assert.match(text, /"mine":false[^\n]*even[^\n]*expired/)
  assert.match(text, /never[^\n]*takeover/i)
})

test("Cloud brief delegates GitHub and review to launcher and commits directly", () => {
  const text = brief({
    ...options,
    execution: "cloud",
    landing: { claimBy: "cloud-42", lockPath: "/tmp/guest/vcs_lock.py" }
  })
  assert.ok(!text.includes("gh issue view"))
  assert.ok(!text.includes("~/Smithers-Ops"))
  assert.ok(!text.includes("node ~/smithers/scripts/issue-claim"))
  assert.ok(!text.includes("/tmp/guest/vcs_lock.py"))
  assert.ok(!text.includes("All jj writes"))
  assert.match(text, /run jj directly with no lock script/)
  assert.match(text, /launcher.*Fable/)
  assert.match(text, /artifact/)
  assert.match(text, /READY <commit-id>/)
})

test("Cloud prepared commits defer checks to host without claiming guest passes", () => {
  const text = brief({ ...options, execution: "cloud", tool: "claude", model: "claude-opus-5-5" })
  assert.ok(!text.includes("Do not report READY before tests pass"))
  assert.ok(!text.includes("Report READY after your tests pass"))
  assert.ok(!text.includes("If Fable is out of quota, use Opus"))
  assert.match(text, /prepared.*launcher Fable.*host queue CI/i)
  assert.match(text, /never claim guest tests passed/i)
  assert.match(text, /launcher.*hostname/i)
  assert.ok(text.includes("Co-Authored-By: Claude Opus"))
  assert.ok(!text.includes("Co-Authored-By: GPT-6.1 Sol"))
})


test("author trailer follows a nondefault assignment model", () => {
  const text = brief({ ...options, tool: "claude", model: "claude-fable-5-1" })
  assert.ok(text.includes("Co-Authored-By: Claude claude-fable-5-1 <noreply@anthropic.com>"))
  assert.ok(!text.includes("Co-Authored-By: Claude Opus"))
})


test("Cloud product bug review requires Fable without an Opus fallback", () => {
  const text = brief({ ...options, execution: "cloud" })
  assert.match(text, /Mandatory final product-bug review is Fable/)
  assert.match(text, /never[^\n]*fall back to Opus/)
})
