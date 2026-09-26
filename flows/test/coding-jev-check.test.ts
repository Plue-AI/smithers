import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { files, judge, MAX_QUESTIONS, Rules } from "../coding/jev-check.ts"
import type { Check, Implementation, Revision } from "../coding/schema.ts"

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
  id: "lint",
  target: ".",
  flow: "checks/lint",
  flowDigest: "sha256:lint",
  tier: "fast",
  required: false
}
const body = {
  rules: [{ id: "no-console", rule: "The changed lines add no console.log call.", paths: ["src/**"] }, {
    id: "copy",
    rule: "Changed copy is minimal.",
    paths: ["apps/**"]
  }]
}
const invocation = (rules: unknown = body) => ({
  flow: "checks/lint",
  input: { implementation, check } as never,
  prompt: `${JSON.stringify(rules)}\n\nresource trailer`,
  model: null,
  placement: null,
  placementOptions: null,
  capabilities: ["fs:read:**"],
  flows: ["coding/JevCheck"]
})

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1
+console.log(a)
 const b = 2
@@ -10,2 +11,3 @@
 const j = 10
+const k = 11
 const l = 12
diff --git a/.smithers/repository-jobs/secret.json b/.smithers/repository-jobs/secret.json
index 3333333..4444444 100644
--- a/.smithers/repository-jobs/secret.json
+++ b/.smithers/repository-jobs/secret.json
@@ -1 +1 @@
-{}
+{"token":"never sent"}
`

const run = (script: Evaluator.Script, text = diff, rules?: unknown) => {
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
  return Effect.runPromise(
    Effect.result(judge(invocation(rules))).pipe(Effect.provide(jj), Effect.provide(Evaluator.layerScripted(script)))
  ).then((result) => ({ result, diffs }))
}

test("the Jev lint check judges each in-scope hunk of the implementation diff and cites a flagged one", async () => {
  const asked: Array<string> = []
  const { result, diffs } = await run((request) => {
    const state = request.state as { rule: string; hunk: string }
    asked.push(state.hunk)
    return { violates: { probability: state.hunk.includes("console.log") ? 0.97 : 0.03 } }
  })
  assert.deepEqual(diffs, [["a".repeat(40), "b".repeat(40)]], "only the immutable parent..head diff is read")
  assert.equal(result._tag, "Success")
  const receipt = result._tag === "Success" ? result.success : undefined
  assert.ok(receipt)
  assert.equal(receipt.status, "failed")
  assert.equal(receipt.commitId, "b".repeat(40))
  assert.deepEqual(receipt.findings.map((finding) => finding.message), [
    "src/a.ts:2 no-console: The changed lines add no console.log call."
  ])
  assert.equal(asked.length, 2, "two src hunks for one rule; the app rule has nothing in scope")
  assert.ok(asked.every((hunk) => !hunk.includes("never sent")), "a private repository-jobs path is never sent to Jev")
  assert.equal(JSON.parse(receipt.evidence).judge, "jev")
})

test("a clean change passes, an indecisive answer fails as uncertain, and Jev down is an error", async () => {
  const clean = await run(() => ({ violates: { probability: 0.01 } }))
  assert.equal(clean.result._tag === "Success" && clean.result.success.status, "passed")
  const unsure = await run(() => ({ violates: { probability: 0.5 } }))
  assert.equal(unsure.result._tag === "Success" && unsure.result.success.status, "failed")
  assert.match(
    unsure.result._tag === "Success" ? unsure.result.success.findings[0]!.message : "",
    /no-console: Jev was unsure/
  )
  const down = await run(() =>
    Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "gateway down" }))
  )
  assert.equal(down.result._tag, "Failure")
  assert.match(down.result._tag === "Failure" ? down.result.failure.message : "", /Jev could not judge no-console/)
})

test("an oversized change is refused without asking Jev, and a malformed body is an invalid receipt", async () => {
  const many = Array.from(
    { length: MAX_QUESTIONS + 1 },
    (_, index) =>
      `diff --git a/src/f${index}.ts b/src/f${index}.ts\n--- a/src/f${index}.ts\n+++ b/src/f${index}.ts\n@@ -1 +1 @@\n-a\n+b\n`
  ).join("")
  let calls = 0
  const large = await run(() => {
    calls++
    return { violates: { probability: 0.01 } }
  }, many)
  assert.equal(calls, 0)
  assert.equal(large.result._tag === "Success" && large.result.success.status, "failed")
  const malformed = await run(() => ({ violates: { probability: 0.01 } }), diff, { rules: [] })
  assert.equal(malformed.result._tag === "Failure" && malformed.result.failure.code, "invalid_receipt")
})

test("the repository's lint check body declares valid Jev rules", async () => {
  const text = await readFile(new URL("../checks/lint/flow.mdx", import.meta.url), "utf8")
  const [, frontmatter = "", rest = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? []
  assert.match(frontmatter, /flows: \[coding\/JevCheck\]/)
  const rules = Schema.decodeUnknownSync(Rules)(JSON.parse(rest.split("\n", 1)[0]!))
  assert.ok(rules.rules.length >= 1)
})

test("a filename spelling another path, a clipped hunk and a binary change are never judged clean", async () => {
  const smuggled = `diff --git a/.smithers/repository-jobs/x b/src/a.ts b/.smithers/repository-jobs/x b/src/a.ts
--- a/.smithers/repository-jobs/x b/src/a.ts
+++ b/.smithers/repository-jobs/x b/src/a.ts
@@ -1 +1 @@
-{}
+{"token":"never sent"}
`
  const parsed = files(smuggled)
  assert.ok(typeof parsed !== "string")
  assert.deepEqual(parsed.map((file) => file.path), [".smithers/repository-jobs/x b/src/a.ts"])
  let asked = 0
  const privateOnly = await run(() => {
    asked++
    return { violates: { probability: 0.01 } }
  }, smuggled)
  assert.equal(asked, 0, "the private file is dropped whole, whatever its name spells")
  assert.equal(privateOnly.result._tag === "Success" && privateOnly.result.success.status, "passed")
  assert.equal(
    typeof files("diff --git a/src/a.ts b/src/b.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n"),
    "string"
  )
  // A newline in a private filename cannot forge a public file's headers.
  assert.equal(
    typeof files(
      "diff --git a/.smithers/repository-jobs/x b/src/a.ts\n--- a/.smithers/repository-jobs/x\n+++ b/src/a.ts\nend b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"
    ),
    "string"
  )
  // A hunk body holding more lines than its counts declare is refused.
  assert.equal(
    typeof files(
      "diff --git a/src/z.ts b/src/z.ts\n--- a/src/z.ts\n+++ b/src/z.ts\n@@ -0,0 +1 @@\n+a\nnew file mode 100644\n@@ -0,0 +1 @@\n+secret\n"
    ),
    "string"
  )
  assert.equal(
    typeof files(
      "diff --git a/src/z.ts b/src/z.ts\n--- a/src/z.ts\n+++ b/src/z.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n\\ No newline at end of file\n@@ -9 +9 @@\n-x\n+y\n"
    ),
    "object"
  )
  // A private file renamed to a public path is still private.
  asked = 0
  const renamed = await run(
    () => {
      asked++
      return { violates: { probability: 0.01 } }
    },
    "diff --git a/.smithers/repository-jobs/s.ts b/src/a.ts\nsimilarity index 90%\nrename from .smithers/repository-jobs/s.ts\nrename to src/a.ts\n--- a/.smithers/repository-jobs/s.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-secret\n+public\n"
  )
  assert.equal(asked, 0)
  assert.equal(renamed.result._tag === "Success" && renamed.result.success.status, "passed")
  // Git's trailing tab after a path with a space, a deletion, a mode change and a pure rename all parse.
  const ok = files(
    "diff --git a/src/a b.ts b/src/a b.ts\n--- a/src/a b.ts\t\n+++ b/src/a b.ts\t\n@@ -1 +1 @@\n-a\n+b\n" +
      "diff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\nindex 1..0\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n" +
      "diff --git a/bin/x b/bin/x\nold mode 100644\nnew mode 100755\n" +
      "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts\n"
  )
  assert.ok(typeof ok !== "string", String(ok))
  assert.deepEqual(ok.map((file) => file.sides), [["src/a b.ts"], ["src/gone.ts"], ["bin/x"], [
    "src/new.ts",
    "src/old.ts"
  ]])

  const long = `diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -0,0 +1,2001 @@\n` +
    Array.from({ length: 2000 }, (_, index) => `+const line${index} = "${"x".repeat(20)}"`).join("\n") +
    "\n+console.log(1)\n"
  asked = 0
  const clipped = await run(() => {
    asked++
    return { violates: { probability: 0.01 } }
  }, long)
  assert.equal(asked, 0)
  assert.equal(clipped.result._tag === "Success" && clipped.result.success.status, "failed")
  assert.equal(
    clipped.result._tag === "Success" && JSON.parse(clipped.result.success.evidence).refused,
    "hunk_too_large"
  )

  const binary = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\nBinary files a/src/a.ts and b/src/a.ts differ\n"
  const judged = await run(() => ({ violates: { probability: 0.01 } }), binary)
  assert.equal(judged.result._tag === "Success" && judged.result.success.status, "failed")
  assert.match(
    judged.result._tag === "Success" ? judged.result.success.findings[0]!.message : "",
    /cannot judge binary/
  )
})
