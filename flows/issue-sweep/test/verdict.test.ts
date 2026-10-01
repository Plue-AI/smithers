import assert from "node:assert/strict"
import test from "node:test"
import {
  evidenceOf,
  infraCaused,
  marker,
  needOf,
  noChangeLabel,
  requalifies,
  type TimelineEntry,
  verdictBody,
  verdictWrite
} from "../verdict.ts"

// infraCaused ---------------------------------------------------------------

test("reports our own infrastructure fixes are environment-caused", () => {
  for (
    const report of [
      "Could not run the tests: vitest is not installed in this checkout.",
      "`bun` unavailable in the VM, so the suite was not run.",
      "bun: command not found",
      "go build ./... failed: signal: killed",
      "The Go compilation was killed (likely OOM).",
      "compile: out of memory",
      "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1200/chrome-linux/chrome",
      "Playwright Chromium is missing, so e2e could not run.",
      "go is unavailable here",
      "cargo: command not found",
      "Go toolchain not installed in the guest."
    ]
  ) {
    assert.notEqual(infraCaused(report), undefined, report)
  }
})

test("reports that need a human are not environment-caused", () => {
  for (
    const report of [
      "No code change: this needs a live acceptance run against production with real credentials.",
      "The fix already landed in 3f2a; closing needs a receipt from the release.",
      "This is a product decision: should the card show the count or a button?",
      "Ran `pnpm vitest run packages/flow` and all 312 tests passed; nothing to change.",
      "go test ./internal/services/... passed."
    ]
  ) {
    assert.equal(infraCaused(report), undefined, report)
  }
})

// needOf ---------------------------------------------------------------------

test("classifies what a no-change verdict needs", () => {
  assert.equal(needOf("Needs a maintainer design decision on the naming."), "design decision")
  assert.equal(needOf("Which option is right is a product decision for Will."), "design decision")
  assert.equal(needOf("Requires the production deploy credentials, which the VM lacks."), "environment")
  assert.equal(needOf("Needs a GitHub App token with admin access."), "environment")
  assert.equal(needOf("Code is already in place; needs live acceptance and a receipt."), "acceptance")
  assert.equal(needOf("Nothing to change."), "acceptance")
})

// evidenceOf / verdictBody ---------------------------------------------------

test("evidence keeps a short report whole and trims a long one at a line", () => {
  assert.equal(evidenceOf("  ran `pnpm test`: 12 passed\n\n\n\nno change  "), "ran `pnpm test`: 12 passed\n\nno change")
  const long = Array.from({ length: 400 }, (_, n) => `line ${n} ran a command and it passed`).join("\n")
  const trimmed = evidenceOf(long, 1500)
  assert.ok(trimmed.length <= 1502, String(trimmed.length))
  assert.ok(trimmed.endsWith("\n…"))
  assert.ok(trimmed.startsWith("line 0 "))
  assert.ok(!trimmed.slice(0, -2).endsWith("passe"), "cut at a line boundary")
})

test("the verdict body carries the marker, the need, and the evidence", () => {
  const body = verdictBody("Ran `go test ./...`: ok.\nNeeds live acceptance on Cloud.", "2026-10-01T12:00:00.000Z")
  assert.equal(
    body,
    [
      "<!-- issue-sweep:no-change 2026-10-01T12:00:00.000Z -->",
      "**No change.** Needs: acceptance",
      "",
      "```text",
      "Ran `go test ./...`: ok.",
      "Needs live acceptance on Cloud.",
      "```"
    ].join("\n")
  )
  assert.ok(body.startsWith(marker))
})

test("a triage verdict names the need the judge chose and that no agent ran", () => {
  const body = verdictBody("asks for a deploy (confidence 0.90)", "2026-10-01T12:00:00.000Z", "operator")
  assert.equal(
    body,
    [
      "<!-- issue-sweep:no-change 2026-10-01T12:00:00.000Z triage -->",
      "**No change.** Needs: operator (triage; no agent ran)",
      "",
      "```text",
      "asks for a deploy (confidence 0.90)",
      "```"
    ].join("\n")
  )
  assert.ok(body.startsWith(marker))
  // The same marked comment an agent verdict updates in place.
  assert.deepEqual(verdictWrite("o/r", 7, [{ id: 9, body }]), { method: "PATCH", path: "repos/o/r/issues/comments/9" })
  for (const need of ["acceptance", "evidence", "design decision"] as const) {
    assert.ok(verdictBody("r", "2026-10-01T12:00:00.000Z", need).includes(`Needs: ${need} (triage; no agent ran)`))
  }
})

test("evidence cannot close the body's code fence", () => {
  const body = verdictBody("before\n```\nafter", "2026-10-01T12:00:00.000Z")
  assert.equal(body.split("\n").filter((line) => line.startsWith("```")).length, 2)
})

// verdictWrite ---------------------------------------------------------------

test("with no marked comment the verdict is added", () => {
  assert.deepEqual(
    verdictWrite("o/r", 7, [{ id: 1, body: "Claimed by issue-sweep on host at x; expires y" }]),
    { method: "POST", path: "repos/o/r/issues/7/comments" }
  )
})

test("an existing marked comment is updated in place, never added again", () => {
  assert.deepEqual(
    verdictWrite("o/r", 7, [
      { id: 1, body: "first" },
      { id: 42, body: `${marker} 2026-09-30T00:00:00Z -->\n**No change.** Needs: design decision` },
      { id: 50, body: "later human comment" }
    ]),
    { method: "PATCH", path: "repos/o/r/issues/comments/42" }
  )
})

// requalifies ----------------------------------------------------------------

const bot = { login: "smithers-issue-claim[bot]", type: "Bot" }
const will = { login: "roninjin10", type: "User" }
const labeled = (at: string, actor = will): TimelineEntry => ({
  event: "labeled",
  created_at: at,
  actor,
  label: { name: noChangeLabel }
})
const commented = (at: string, user: typeof will, body: string, updated = at): TimelineEntry => ({
  event: "commented",
  created_at: at,
  updated_at: updated,
  user,
  body
})
const verdict = (at: string) => commented(at, will, `${marker} ${at} -->\n**No change.** Needs: acceptance`)

test("a labeled issue nobody acted on stays parked", () => {
  assert.equal(requalifies([verdict("2026-10-01T10:00:00Z"), labeled("2026-10-01T10:00:01Z")]), false)
})

test("our bot's claim, release, and landing comments after the label never requalify", () => {
  assert.equal(
    requalifies([
      verdict("2026-10-01T10:00:00Z"),
      labeled("2026-10-01T10:00:01Z"),
      commented("2026-10-01T10:00:02Z", bot, "Released by issue-sweep on mini at x: failed: work: no change"),
      commented("2026-10-01T11:00:00Z", bot, "Claimed by issue-sweep on mini at x; expires y"),
      { event: "labeled", created_at: "2026-10-01T11:00:00Z", actor: bot, label: { name: "in-progress" } },
      { event: "unlabeled", created_at: "2026-10-01T11:00:05Z", actor: bot, label: { name: "in-progress" } }
    ]),
    false
  )
})

test("bookkeeping posted under a user token never requalifies", () => {
  assert.equal(
    requalifies([
      labeled("2026-10-01T10:00:01Z"),
      commented("2026-10-01T10:00:02Z", will, "Released by issue-sweep on mini at x: failed"),
      commented("2026-10-01T10:00:03Z", will, "Landed on main by issue-sweep: abc")
    ]),
    false
  )
})

test("a human comment after the label requalifies; one before it does not", () => {
  const human = { login: "someone", type: "User" }
  assert.equal(
    requalifies([commented("2026-10-01T09:00:00Z", human, "any news?"), labeled("2026-10-01T10:00:01Z")]),
    false
  )
  assert.equal(
    requalifies([labeled("2026-10-01T10:00:01Z"), commented("2026-10-01T12:00:00Z", human, "credentials added")]),
    true
  )
})

test("a human editing an older comment after the label requalifies", () => {
  const human = { login: "someone", type: "User" }
  assert.equal(
    requalifies([
      commented("2026-10-01T09:00:00Z", human, "spec", "2026-10-01T13:00:00Z"),
      labeled("2026-10-01T10:00:01Z")
    ]),
    true
  )
})

test("a human renaming the issue after the label requalifies", () => {
  assert.equal(
    requalifies([labeled("2026-10-01T10:00:01Z"), {
      event: "renamed",
      created_at: "2026-10-01T12:00:00Z",
      actor: will
    }]),
    true
  )
})

test("the label removed after it was added requalifies", () => {
  assert.equal(
    requalifies([
      labeled("2026-10-01T10:00:01Z"),
      { event: "unlabeled", created_at: "2026-10-01T12:00:00Z", actor: will, label: { name: noChangeLabel } }
    ]),
    true
  )
})

test("a later verdict re-anchors: a human comment answered by a newer verdict parks again", () => {
  const human = { login: "someone", type: "User" }
  assert.equal(
    requalifies([
      labeled("2026-10-01T10:00:01Z"),
      commented("2026-10-01T11:00:00Z", human, "try again"),
      // The verdict comment updated in place by the next run's no-change.
      commented(
        "2026-10-01T10:00:00Z",
        will,
        `${marker} 2026-10-01T12:00:00Z -->\n**No change.**`,
        "2026-10-01T12:00:00Z"
      )
    ]),
    false
  )
})

test("a label with no labeled event requalifies rather than parking forever", () => {
  assert.equal(requalifies([]), true)
})
