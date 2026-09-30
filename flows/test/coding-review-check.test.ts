import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import {
  capture,
  finish,
  Lenses,
  MAX_LENSES,
  MAX_REVIEW_BYTES,
  reviewCheckDelegate,
  ReviewLens,
  reviewRole
} from "../coding/review-check.ts"
import {
  type Check,
  checkInputDigest,
  CodingError,
  type Implementation,
  receiptMatches,
  type Revision
} from "../coding/schema.ts"

const revision = (commit: string): Revision => ({
  changeId: "k".repeat(32),
  commitId: commit.repeat(40),
  treeId: "t".repeat(40),
  operationId: "o".repeat(64),
  parentCommitIds: []
})
const implementation: Implementation = {
  change: "change-1",
  parent: revision("a"),
  atoms: [revision("b")],
  head: revision("b"),
  reads: [],
  writes: ["src/a.ts"]
}
const check: Check = {
  id: "review",
  target: ".",
  flow: "checks/review",
  flowDigest: "sha256:review",
  tier: "slow",
  required: false
}
const body = {
  lenses: [
    { id: "tests", focus: "A behavior change without a test." },
    { id: "errors", focus: "An error swallowed instead of surfaced." },
    { id: "names", focus: "A name that says less than the code does." }
  ]
}
const invocation = (lenses: unknown = body, flow = "checks/review") => ({
  flow,
  input: { implementation, check } as never,
  prompt: `${JSON.stringify(lenses)}\n\nresource trailer`,
  model: null,
  placement: null,
  placementOptions: null,
  capabilities: ["fs:read:**"],
  flows: ["coding/ReviewCheck"]
})
const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1
+try { run() } catch {}
 const b = 2
diff --git a/.smithers/repository-jobs/secret.json b/.smithers/repository-jobs/secret.json
index 3333333..4444444 100644
--- a/.smithers/repository-jobs/secret.json
+++ b/.smithers/repository-jobs/secret.json
@@ -1 +1 @@
-{}
+{"token":"never sent"}
`

const run = (text = diff, lenses?: unknown, flow?: string) => {
  const diffs: Array<[string, string]> = []
  const jj = Layer.succeed(
    Jj.Jj,
    Jj.makeNoop({
      diff: (from, to) =>
        Effect.sync(() => {
          diffs.push([from, to])
          return text
        })
    })
  )
  return Effect.runPromise(Effect.result(capture(invocation(lenses, flow))).pipe(Effect.provide(jj)))
    .then((result) => ({ result, diffs }))
}

test("the review check reads the immutable parent..head diff once, drops private paths and keeps every lens", async () => {
  const { result, diffs } = await run()
  assert.deepEqual(diffs, [["a".repeat(40), "b".repeat(40)]], "only the immutable parent..head diff is read")
  assert.equal(result._tag, "Success")
  const captured = result._tag === "Success" ? result.success : undefined
  assert.ok(captured)
  assert.equal(captured.refused, null)
  assert.deepEqual(captured.lenses.map((lens) => lens.id), ["tests", "errors", "names"], "N declared lenses")
  assert.ok(captured.diff.includes("catch {}"))
  assert.ok(!captured.diff.includes("never sent"), "a private repository-jobs path never reaches the reviewer")
  assert.equal(captured.implementation.change, "change-1")
})

test("the receipt binds the Change and commit, and aggregates every lens's findings", async () => {
  const { result } = await run()
  assert.equal(result._tag, "Success")
  const captured = result._tag === "Success" ? result.success : undefined
  assert.ok(captured)
  const receipt = finish(captured, {
    tests: { verdict: "approve", findings: [] },
    errors: {
      verdict: "request-changes",
      findings: [{ path: "src/a.ts", line: 2, message: "Surface the failure instead of swallowing it." }]
    },
    names: { verdict: "request-changes", findings: [] }
  })
  assert.ok(!(receipt instanceof CodingError))
  assert.equal(receipt.status, "failed")
  assert.equal(receipt.change, "change-1")
  assert.equal(receipt.commitId, "b".repeat(40))
  assert.equal(receipt.treeId, "t".repeat(40))
  assert.equal(receipt.checkId, "review")
  assert.equal(receipt.tier, "slow")
  assert.equal(receipt.inputDigest, checkInputDigest(implementation, check))
  assert.ok(receiptMatches(implementation, check, receipt))
  assert.deepEqual(receipt.findings, [
    {
      owner: "change-1",
      sourceCommitId: "b".repeat(40),
      message: "src/a.ts:2 errors: Surface the failure instead of swallowing it."
    },
    { owner: "change-1", sourceCommitId: "b".repeat(40), message: "names: changes requested without a finding" }
  ])
  const evidence = JSON.parse(receipt.evidence)
  assert.equal(evidence.kind, "coding/review-check/v1")
  assert.equal(evidence.seat, reviewRole)
  assert.deepEqual(evidence.lenses, [
    { id: "tests", verdict: "approve", findings: 0 },
    { id: "errors", verdict: "request-changes", findings: 1 },
    { id: "names", verdict: "request-changes", findings: 0 }
  ])
  const clean = finish(captured, {
    tests: { verdict: "approve", findings: [] },
    errors: { verdict: "approve", findings: [] },
    names: { verdict: "approve", findings: [] }
  })
  assert.ok(!(clean instanceof CodingError))
  assert.equal(clean.status, "passed")
  assert.deepEqual(clean.findings, [])
  // An approval that still names a finding never passes: the finding stands.
  const contradicted = finish(captured, {
    tests: { verdict: "approve", findings: [{ path: "src/a.ts", line: 3, message: "Cover the new branch." }] },
    errors: { verdict: "approve", findings: [] },
    names: { verdict: "approve", findings: [] }
  })
  assert.ok(!(contradicted instanceof CodingError))
  assert.equal(contradicted.status, "failed")
  assert.deepEqual(contradicted.findings, [
    { owner: "change-1", sourceCommitId: "b".repeat(40), message: "src/a.ts:3 tests: Cover the new branch." }
  ])
})

test("a missing or extra lens answer is an invalid receipt, never a pass", async () => {
  const { result } = await run()
  const captured = result._tag === "Success" ? result.success : undefined
  assert.ok(captured)
  const approve = { verdict: "approve" as const, findings: [] }
  const missing = finish(captured, { tests: approve, errors: approve })
  assert.ok(missing instanceof CodingError)
  assert.equal(missing.code, "invalid_receipt")
  const renamed = finish(captured, { tests: approve, errors: approve, other: approve })
  assert.ok(renamed instanceof CodingError)
})

test("an oversized or unreadable diff fails without asking any lens, and an unrelated flow is refused", async () => {
  const large = await run(
    `diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1 +1 @@\n-a\n+${
      "b".repeat(MAX_REVIEW_BYTES)
    }\n`
  )
  const refused = large.result._tag === "Success" ? large.result.success : undefined
  assert.ok(refused)
  assert.match(refused.refused ?? "", /too large/)
  assert.equal(refused.diff, "")
  const receipt = finish(refused, {})
  assert.ok(!(receipt instanceof CodingError))
  assert.equal(receipt.status, "failed")
  assert.equal(receipt.findings.length, 1)
  assert.match(receipt.findings[0]!.message, /too large/)
  assert.equal(JSON.parse(receipt.evidence).refused, refused.refused)
  const answered = finish(refused, { tests: { verdict: "approve", findings: [] } })
  assert.ok(answered instanceof CodingError, "a refused capture accepts no lens answer")
  const unreadable = await run("not a diff at all\n")
  assert.equal(unreadable.result._tag === "Success" && unreadable.result.success.refused !== null, true)
  const mismatch = await run(diff, body, "checks/other")
  assert.equal(mismatch.result._tag === "Failure" && mismatch.result.failure.code, "invalid_receipt")
})

test("the lens declaration is bounded: 1 to MAX_LENSES unique lenses with a focus", async () => {
  const empty = await run(diff, { lenses: [] })
  assert.equal(empty.result._tag === "Failure" && empty.result.failure.code, "invalid_receipt")
  const many = await run(diff, {
    lenses: Array.from({ length: MAX_LENSES + 1 }, (_, index) => ({ id: `lens-${index}`, focus: "x" }))
  })
  assert.equal(many.result._tag === "Failure" && many.result.failure.code, "invalid_receipt")
  const exact = await run(diff, {
    lenses: Array.from({ length: MAX_LENSES }, (_, index) => ({ id: `lens-${index}`, focus: "x" }))
  })
  assert.equal(exact.result._tag === "Success" && exact.result.success.lenses.length, MAX_LENSES)
  const duplicate = await run(diff, { lenses: [{ id: "tests", focus: "x" }, { id: "tests", focus: "y" }] })
  assert.equal(duplicate.result._tag === "Failure" && duplicate.result.failure.code, "invalid_receipt")
  const prose = await run(diff, "Review the working copy")
  assert.equal(prose.result._tag === "Failure" && prose.result.failure.code, "invalid_receipt")
})

test("every lens runs on the coding/review role, and the delegate is the registered check flow", () => {
  assert.equal(reviewRole, "coding/review")
  assert.equal(ReviewLens.name, "coding/review-lens")
  assert.equal(reviewCheckDelegate._tag, "coding/ReviewCheck")
})

test("the repository's review flow declares valid lenses and pins no model", async () => {
  const text = await readFile(new URL("../checks/review/flow.mdx", import.meta.url), "utf8")
  const [, frontmatter = "", rest = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? []
  assert.match(frontmatter, /flows: \[coding\/ReviewCheck\]/)
  assert.doesNotMatch(frontmatter, /^model:/m, "the role, not a provider literal, selects the reviewer")
  const lenses = Schema.decodeUnknownSync(Lenses)(JSON.parse(rest.split("\n", 1)[0]!))
  assert.ok(lenses.lenses.length >= 1)
  const project = JSON.parse(
    await readFile(new URL("../../.smithers/coding-project.json", import.meta.url), "utf8")
  ) as { checks: ReadonlyArray<{ id: string; flow: string; tier: string }> }
  assert.deepEqual(project.checks.filter((entry) => entry.flow === "checks/review").map((entry) => entry.tier), [
    "slow"
  ])
})
