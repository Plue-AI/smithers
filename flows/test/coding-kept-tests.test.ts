import { NodeServices } from "@effect/platform-node"
import { Action } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Effect, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as TestMemory from "../../packages/smithers/agent/memory/src/test/TestMemory.ts"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { correctionLayers, CorrectPlan } from "../coding/correction.ts"
import {
  ChangeDiff,
  changeDiffLayer,
  guardFindings,
  keepTests,
  removalAsked,
  removedTests
} from "../coding/kept-tests.ts"
import { NativeCoding } from "../coding/native.ts"
import {
  checkInputDigest,
  type Implementation,
  type Plan,
  type Receipt,
  type Result,
  type Revision
} from "../coding/schema.ts"
import { Implement, policyLayers, RunCheck } from "../coding/workflow.ts"

/** One file's unified diff, as `jj diff --git` writes it. */
const diffOf = (path: string, hunks: string, from = `a/${path}`, to = `b/${path}`) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- ${from}\n+++ ${to}\n${hunks}`

// The M3 re-walk's merged change (defect 3): the agent rewrote the repository's
// only test file for its new greet function and dropped the existing "adds" test.
const dropsAdds = diffOf(
  "test/smoke.test.mjs",
  `@@ -1,7 +1,10 @@
 import { test } from "node:test"
 import assert from "node:assert/strict"
-import { add } from "../src/index.mjs"
+import { greet } from "../greet.mjs"

-test("adds", () => {
-  assert.equal(add(1, 2), 3)
+test("greets", () => {
+  assert.equal(greet("Ada"), "Hello, Ada!")
+})
+
+test("greets the world", () => {
+  assert.equal(greet(), "Hello, world!")
 })
`
)

test("a rewrite that drops an existing test names it as deleted", () => {
  assert.deepEqual(removedTests(dropsAdds), [{ path: "test/smoke.test.mjs", name: "adds", how: "deleted" }])
})

test("adding a test, or rewriting a test's declaration line, removes nothing", () => {
  const adds = diffOf(
    "test/smoke.test.mjs",
    `@@ -5,3 +5,7 @@ test("adds", () => {
   assert.equal(add(1, 2), 3)
 })
+
+test("subtracts", () => {
+  assert.equal(sub(3, 2), 1)
+})
`
  )
  assert.deepEqual(removedTests(adds), [])
  const asynced = diffOf(
    "test/smoke.test.mjs",
    `@@ -1,3 +1,3 @@
-test("adds", () => {
-  assert.equal(add(1, 2), 3)
+test("adds", async () => {
+  assert.equal(await add(1, 2), 3)
 })
`
  )
  assert.deepEqual(removedTests(asynced), [])
})

test("an emptied body, a skip and a deleted file each take a test away", () => {
  const emptied = diffOf(
    "src/math.test.ts",
    `@@ -3,6 +3,5 @@ import { add } from "./math"

 it("adds", () => {
-  expect(add(1, 2)).toBe(3)
+  // covered elsewhere
 })
 it("keeps", () => { expect(1).toBe(1) })
`
  )
  assert.deepEqual(removedTests(emptied), [{ path: "src/math.test.ts", name: "adds", how: "emptied" }])
  const skipped = diffOf(
    "test/smoke.test.mjs",
    `@@ -1,3 +1,3 @@
-test("adds", () => {
+test.skip("adds", () => {
   assert.equal(add(1, 2), 3)
 })
`
  )
  assert.deepEqual(removedTests(skipped), [{ path: "test/smoke.test.mjs", name: "adds", how: "skipped" }])
  const deleted = diffOf(
    "tests/test_math.py",
    `@@ -1,6 +0,0 @@
-from math_lib import add
-
-def test_adds():
-    assert add(1, 2) == 3
-
-async def test_awaits(): assert True
`,
    "a/tests/test_math.py",
    "/dev/null"
  )
  assert.deepEqual(removedTests(deleted), [
    { path: "tests/test_math.py", name: "test_adds", how: "deleted" },
    { path: "tests/test_math.py", name: "test_awaits", how: "deleted" }
  ])
})

test("Go and Python bodies emptied in place are caught; a body that keeps a statement is not", () => {
  const go = diffOf(
    "math_test.go",
    `@@ -5,7 +5,6 @@ import "testing"

 func TestAdd(t *testing.T) {
-\tif Add(1, 2) != 3 {
-\t\tt.Fatal("1 + 2")
-\t}
+\t// TODO
 }

 func TestMain(m *testing.M) {}
`
  )
  assert.deepEqual(removedTests(go), [{ path: "math_test.go", name: "TestAdd", how: "emptied" }])
  const python = diffOf(
    "test_math.py",
    `@@ -1,5 +1,5 @@
 def test_adds():
-    assert add(1, 2) == 3
+    pass

 def test_subtracts():
     assert sub(3, 2) == 1
`
  )
  assert.deepEqual(removedTests(python), [{ path: "test_math.py", name: "test_adds", how: "emptied" }])
  const changed = diffOf(
    "test/smoke.test.mjs",
    `@@ -1,3 +1,3 @@
 test("adds", () => {
-  assert.equal(add(1, 2), 3)
+  assert.equal(add(2, 2), 4)
 })
`
  )
  assert.deepEqual(removedTests(changed), [])
})

test("only test files count", () => {
  const source = diffOf(
    "src/runner.mjs",
    `@@ -1,3 +1,0 @@
-test("adds", () => {
-  assert.equal(add(1, 2), 3)
-})
`
  )
  assert.deepEqual(removedTests(source), [])
  assert.deepEqual(removedTests(source.replaceAll("src/runner.mjs", "spec/runner.mjs")).map((test) => test.name), [
    "adds"
  ])
})

const adds = { path: "test/smoke.test.mjs", name: "adds", how: "deleted" } as const

test("the person's words ask for a removal only with a removal verb and the test, its file or tests", () => {
  for (
    const words of [
      "Delete the adds test.",
      "Rewrite the smoke tests for greet and drop the adds case",
      "Remove test/smoke.test.mjs",
      "Replace smoke.test.mjs with a greet test",
      "Remove the flaky tests"
    ]
  ) assert.equal(removalAsked(words, adds), true, words)
  for (
    const words of [
      "Add a greet function that adds a greeting, with a test",
      "Remove the greeting and update tests",
      "Remove the unused import",
      "Keep the adds test",
      "No, don't remove the adds test",
      "Never delete tests"
    ]
  ) assert.equal(removalAsked(words, adds), false, words)
})

const revision = (name: string, parent?: string): Revision => ({
  changeId: `jj-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: `op-${name}`,
  parentCommitIds: parent ? [`commit-${parent}`] : []
})
const planOf = (prompt: string, ids: ReadonlyArray<string> = ["greet"]): Plan => ({
  prompt,
  memoryRevision: "fixture",
  base: revision("base"),
  changes: ids.map((id) => ({
    id,
    title: `Title ${id}`,
    intent: id,
    implementation: "implementation",
    implementationDigest: "0".repeat(64),
    atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [] }],
    checks: [{ id: "test", target: "test", flow: "test", flowDigest: "0".repeat(64), tier: "fast", required: true }]
  }))
})
const implemented = (id: string, parent: Revision, writes: ReadonlyArray<string>): Implementation => {
  const head = revision(id, parent.changeId.slice(3))
  return { change: id, parent, atoms: [head], head, reads: [], writes }
}
const validated = (...changes: ReadonlyArray<Implementation>): Result => ({
  status: "validated",
  changes: changes.map((implementation) => ({ implementation, receipts: [] })),
  findings: []
})
const diffs = (diff: string) => Layer.succeed(ChangeDiff, { read: () => Effect.succeed(diff) })

test("a removed test is a finding owned by the first Change that wrote its file", () => {
  const plan = planOf("Add a greet function", ["greet", "docs"])
  const greet = implemented("greet", plan.base, ["greet.mjs", "test/smoke.test.mjs"])
  const result = validated(greet, implemented("docs", greet.head, ["README.md"]))
  assert.deepEqual(guardFindings(plan, result, dropsAdds), [{
    owner: "greet",
    sourceCommitId: "commit-greet",
    message:
      "Restore the existing test \"adds\" in test/smoke.test.mjs: this change deletes it, and the request does not ask for its removal."
  }])
  const unlisted = validated(implemented("greet", plan.base, ["greet.mjs"]), implemented("docs", greet.head, []))
  assert.equal(
    guardFindings(plan, unlisted, dropsAdds)[0]!.owner,
    "docs",
    "no Change listed the file: the last owns it"
  )
})

test("keepTests turns a validated result into changes-requested unless the prompt or feedback asks", async () => {
  const run = (plan: Plan, diff: string) => {
    const result = validated(implemented("greet", plan.base, ["test/smoke.test.mjs"]))
    return Effect.runPromise(keepTests(plan, result).pipe(Effect.provide(diffs(diff))))
  }
  const caught = await run(planOf("Add a greet function"), dropsAdds)
  assert.equal(caught.status, "changes-requested")
  assert.match(caught.findings[0]!.message, /"adds" in test\/smoke\.test\.mjs/)
  assert.equal((await run(planOf("Add a greet function"), "")).status, "validated", "an empty diff keeps the result")
  assert.equal((await run(planOf("Add a greet function and delete the adds test"), dropsAdds)).status, "validated")
  const answered = { ...planOf("Add a greet function"), feedback: "Q: Keep the adds test?\nA: No, drop the adds test." }
  assert.equal((await run(answered, dropsAdds)).status, "validated", "a carried answer asks for it")
})

test("the correction loop reports the guard's finding for a repair", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-kept-tests-"))
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  const plan = planOf("Add a greet function")
  const runtime = NodeRuntime.layerHost(
    { filename: join(root, ".flows", "engine.db"), workspaceRoot: root, owner: { hostId: "kept-tests" }, signals: [] },
    Layer.mergeAll(
      policyLayers,
      correctionLayers,
      Implement.toLayer(({ parent }) => Effect.succeed(implemented("greet", parent, ["test/smoke.test.mjs"]))),
      RunCheck.toLayer(({ implementation, check }) =>
        Effect.succeed<Receipt>({
          change: implementation.change,
          checkId: check.id,
          target: check.target,
          tier: check.tier,
          commitId: implementation.head.commitId,
          treeId: implementation.head.treeId,
          inputDigest: checkInputDigest(implementation, check),
          status: "passed",
          evidence: "scripted check",
          findings: []
        })
      )
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provide(diffs(dropsAdds)),
      Layer.provide(Layer.succeed(NativeCoding, {
        sourcePublication: "local-only",
        read: () => Effect.die("one round never reads native history"),
        apply: () => Effect.die("one round never edits"),
        publishOriginalSource: () => Effect.die("never publishes")
      }))
    )
  ).pipe(Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)), Layer.provideMerge(TestMemory.layer))
  const host = ManagedRuntime.make(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const outcome = await host.runPromise(CorrectPlan.execute({ plan, maxRounds: 1 }, { executionId: "kept-tests" }))
  assert.equal(outcome.status, "changes-requested", "every check passed; the guard alone requests the repair")
  assert.deepEqual(outcome.result?.findings.map((finding) => finding.owner), ["greet"])
  assert.match(outcome.result!.findings[0]!.message, /Restore the existing test "adds"/)
})

/** A seeded generator, so a failing seed reproduces (mulberry32). */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const fates = ["kept", "changed", "deleted", "emptied", "skipped"] as const

/**
 * Property: for a test file whose cases are each kept, changed, deleted,
 * emptied or skipped, the diff git writes between the two versions names
 * exactly the deleted, emptied and skipped cases. The Go mirror
 * (TestMythicalRemovedTestsProperty) draws the same kinds of files.
 */
test("property: git's diff of a randomly edited test file names exactly the cases it takes away", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-kept-tests-property-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "a", "test"), { recursive: true })
  await mkdir(join(root, "b", "test"), { recursive: true })
  for (let seed = 1; seed <= 150; seed++) {
    const next = random(seed)
    const count = 1 + Math.floor(next() * 6)
    const before = ["import { test } from \"node:test\"", "import assert from \"node:assert/strict\"", ""]
    const after = [...before]
    const expected: Array<string> = []
    for (let index = 0; index < count; index++) {
      const name = `case ${seed}-${index}`
      const fate = fates[Math.floor(next() * fates.length)]!
      const body = Array.from(
        { length: 1 + Math.floor(next() * 3) },
        (_, line) => `  assert.equal(f(${index}, ${line}), ${seed})`
      )
      before.push(`test("${name}", () => {`, ...body, "})", "")
      if (fate === "deleted") expected.push(`deleted ${name}`)
      else if (fate === "emptied") {
        after.push(`test("${name}", () => {`, "})", "")
        expected.push(`emptied ${name}`)
      } else if (fate === "skipped") {
        after.push(`test.skip("${name}", () => {`, ...body, "})", "")
        expected.push(`skipped ${name}`)
      } else after.push(`test("${name}", () => {`, ...(fate === "changed" ? [`  assert.ok(${seed})`] : body), "})", "")
    }
    await writeFile(join(root, "a", "test", "smoke.test.mjs"), before.join("\n"))
    await writeFile(join(root, "b", "test", "smoke.test.mjs"), after.join("\n"))
    let diff = ""
    try {
      execFileSync("git", ["diff", "--no-index", "--no-color", "a/test/smoke.test.mjs", "b/test/smoke.test.mjs"], {
        cwd: root,
        stdio: "pipe"
      })
    } catch (error) {
      diff = String((error as { stdout?: Buffer }).stdout ?? "")
    }
    const found = removedTests(diff).map((test) => `${test.how} ${test.name}`).sort()
    assert.deepEqual(found, expected.sort(), `seed ${seed}`)
  }
})

/**
 * Integration on a real jj repository: the host's ChangeDiff reads `jj diff
 * --git` between the plan base and the round's head, so a commit that
 * rewrites the test file turns the round into changes-requested, and a
 * commit that only adds a test does not.
 */
test("the host's jj diff reader feeds the guard the round's real change", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-kept-tests-jj-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const jj = (...args: Array<string>) =>
    execFileSync("jj", ["--no-pager", "--color=never", ...args], {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, JJ_USER: "Fixture", JJ_EMAIL: "fixture@example.test" }
    }).toString().trim()
  const commitOf = () => jj("log", "--no-graph", "-r", "@-", "-T", "commit_id")
  jj("git", "init")
  await mkdir(join(root, "test"), { recursive: true })
  const smoke = "import { test } from \"node:test\"\n\ntest(\"adds\", () => {\n  assert.equal(1 + 2, 3)\n})\n"
  await writeFile(join(root, "test", "smoke.test.mjs"), smoke)
  jj("commit", "-m", "base")
  const base = commitOf()
  await writeFile(
    join(root, "test", "smoke.test.mjs"),
    "import { test } from \"node:test\"\n\ntest(\"greets\", () => {})\n"
  )
  jj("commit", "-m", "rewrite")
  const rewrite = commitOf()
  await writeFile(
    join(root, "test", "smoke.test.mjs"),
    smoke + "\ntest(\"subtracts\", () => {\n  assert.equal(3 - 2, 1)\n})\n"
  )
  jj("commit", "-m", "addition")
  const addition = commitOf()
  const platform = changeDiffLayer.pipe(
    Layer.provide(NodeJj.layerSpawnerAt(root)),
    Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)),
    Layer.provide(NodeServices.layer)
  )
  const round = (head: string) => {
    const plan = { ...planOf("Add a greet function"), base: { ...revision("base"), commitId: base } }
    const implementation = implemented("greet", plan.base, ["test/smoke.test.mjs"])
    const result = validated({ ...implementation, head: { ...implementation.head, commitId: head } })
    return Effect.runPromise(keepTests(plan, result).pipe(Effect.provide(platform)))
  }
  const rewritten = await round(rewrite)
  assert.equal(rewritten.status, "changes-requested")
  assert.deepEqual(rewritten.findings.map((finding) => finding.message), [
    "Restore the existing test \"adds\" in test/smoke.test.mjs: this change deletes it, and the request does not ask for its removal."
  ])
  assert.equal((await round(addition)).status, "validated", "adding a test keeps every existing one")
  const missing = await Effect.runPromiseExit(
    keepTests(planOf("Add a greet function"), validated(implemented("greet", revision("base"), []))).pipe(
      Effect.provide(platform)
    )
  )
  assert.ok(missing._tag === "Failure", "an unreadable diff is an outage, never a silent pass")
})
