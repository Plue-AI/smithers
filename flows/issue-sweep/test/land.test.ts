import assert from "node:assert/strict"
import test from "node:test"
import { blocking, isDocsSource, packageOf, packagesOf, readChecks, testTargets } from "../land.ts"

const index = [
  { label: "//:backendGo", kinds: ["test"] },
  { label: "//flows:test", kinds: ["test"] },
  { label: "//flows:lint", kinds: ["lint"] },
  { label: "//packages/smithers:test", kinds: ["test"] },
  { label: "//packages/smithers/flows/patterns:test", kinds: ["test"] },
  { label: "//packages/smithers/flows/patterns:circular", kinds: ["test"] },
  { label: "//packages/smithers/flows/patterns:lib", kinds: ["build"] }
]

test("packageOf reads the package directory of a label, the root as empty", () => {
  assert.equal(packageOf("//packages/smithers/flows/patterns:test"), "packages/smithers/flows/patterns")
  assert.equal(packageOf("//:backendGo"), "")
})

test("packagesOf picks the deepest package containing each file and never the root", () => {
  const packages = ["", "flows", "packages/smithers", "packages/smithers/flows/patterns"]
  assert.deepEqual(
    packagesOf([
      "packages/smithers/flows/patterns/src/Burndown.ts",
      "packages/smithers/src/CloudSandbox.ts",
      "packages/smithers-other/x.ts",
      "README.md",
      "flows/issue-sweep/flow.ts"
    ], packages),
    ["flows", "packages/smithers", "packages/smithers/flows/patterns"]
  )
  assert.deepEqual(packagesOf(["README.md", "scripts/x.mjs"], packages), [])
})

test("testTargets runs only the test targets of the touched packages", () => {
  assert.deepEqual(testTargets(["packages/smithers/flows/patterns/src/Burndown.ts"], index), [
    "//packages/smithers/flows/patterns:circular",
    "//packages/smithers/flows/patterns:test"
  ])
  assert.deepEqual(testTargets(["flows/issue-sweep/land.ts", "docs/blog/x.md"], index), ["//flows:test"])
  assert.deepEqual(testTargets(["WORKSPACE.ts"], index), [])
})

const app = [
  {
    label: "//apps/app:unitTests",
    kinds: ["test"],
    inputs: [{ kind: "glob", pattern: "apps/app/src/**/*.ts", exclude: [] }]
  },
  { label: "//apps/app:check", kinds: ["build"], inputs: [] },
  {
    label: "//apps/app:browserE2e",
    kinds: ["test"],
    exclusive: true,
    inputs: [
      { kind: "file", path: "apps/app/scripts/run-pr-e2e.mjs" },
      { kind: "glob", pattern: "apps/app/src/**/*.ts", exclude: [] },
      { kind: "glob", pattern: "apps/app/e2e/**/*", exclude: ["apps/app/e2e/fixtures/**"] },
      { kind: "file", path: "apps/app/playwright.config.ts" },
      { kind: "git-diff" }
    ]
  },
  { label: "//apps/app:noInputs", kinds: ["test"], exclusive: true }
]

test("testTargets skips an exclusive tier for a change outside its e2e inputs", () => {
  assert.deepEqual(testTargets(["apps/app/src/mainview/App.ts"], app), ["//apps/app:unitTests"])
  // Declared, but not under an e2e directory.
  assert.deepEqual(testTargets(["apps/app/playwright.config.ts", "apps/app/scripts/run-pr-e2e.mjs"], app), [
    "//apps/app:unitTests"
  ])
})

test("testTargets keeps an exclusive tier when the change touches its e2e inputs", () => {
  assert.deepEqual(testTargets(["apps/app/src/mainview/App.ts", "apps/app/e2e/playwright/runs.spec.ts"], app), [
    "//apps/app:browserE2e",
    "//apps/app:unitTests"
  ])
  assert.deepEqual(testTargets(["apps/app/e2e/fixtures/burndown/empty.json"], app), ["//apps/app:unitTests"])
})

test("readChecks: an ok report is green", () => {
  assert.deepEqual(readChecks({ code: 0, stdout: JSON.stringify({ ok: true, results: [] }), stderr: "" }), {
    _tag: "Green"
  })
})

test("readChecks: a targets_failed refusal is red with the targets the known-red list does not excuse", () => {
  const stderr = [
    "newly red, no matching failure in .github/ci-known-red.json: //packages/smithers/flows/patterns:lib",
    "observed failure: //packages/smithers/flows/patterns:lib sha256:5b86",
    "newly red, no matching failure in .github/ci-known-red.json: //flows:test",
    "newly red, no matching failure in .github/ci-known-red.json: //flows:test",
    "not run, a dependency is red: //packages/smithers/flows/patterns:test"
  ].join("\n")
  const stdout = JSON.stringify({ code: "targets_failed", message: "2 of 3 targets failed" })
  assert.deepEqual(readChecks({ code: 1, stdout, stderr }), {
    _tag: "Red",
    labels: ["//flows:test", "//packages/smithers/flows/patterns:lib"]
  })
})

test("readChecks: a failure it cannot attribute, or a refusal to plan, means the checks never ran", () => {
  assert.deepEqual(
    readChecks({
      code: 1,
      stdout: JSON.stringify({ code: "targets_failed", message: "1 of 1 targets failed" }),
      stderr: ""
    }),
    { _tag: "Broken", message: "1 of 1 targets failed" }
  )
  assert.deepEqual(
    readChecks({
      code: 1,
      stdout: JSON.stringify({ code: "test_failed", message: "declaration_dependency_mismatch" }),
      stderr: ""
    }),
    { _tag: "Broken", message: "test_failed: declaration_dependency_mismatch" }
  )
  assert.deepEqual(readChecks({ code: 137, stdout: "", stderr: "Killed\n" }), {
    _tag: "Broken",
    message: "exit 137: Killed"
  })
  // A zero exit whose report says not ok is not green.
  assert.equal(readChecks({ code: 0, stdout: JSON.stringify({ ok: false }), stderr: "" })._tag, "Broken")
})

test("blocking keeps only the reds main does not share", () => {
  assert.deepEqual(blocking(["//a:test", "//b:test"], ["//b:test", "//c:test"]), ["//a:test"])
  assert.deepEqual(blocking(["//a:test"], ["//a:test"]), [])
  assert.deepEqual(blocking([], ["//a:test"]), [])
})

test("isDocsSource picks package docs that docs:sync generates from, never the generated mirrors", () => {
  assert.equal(isDocsSource("packages/smithers/agent/registry/docs/api.md"), true)
  assert.equal(isDocsSource("docs/blog/building-burndown-notes.md"), true)
  assert.equal(isDocsSource("apps/docs/registry/src/content/docs/reference/api.md"), false)
  assert.equal(isDocsSource("packages/smithers/src/Docs.ts"), false)
})

test("readChecks: infrastructure refusals block even with newly-red labels", () => {
  for (
    const diagnostic of [
      "listen EPERM: operation not permitted 127.0.0.1",
      "Error: listen EACCES: permission denied",
      "spawn node ENOENT",
      "Error: ENOSPC: no space left on device",
      "Error: EMFILE: too many open files"
    ]
  ) {
    const checked = readChecks({
      code: 1,
      stdout: JSON.stringify({ code: "targets_failed", message: "1 of 1 targets failed" }),
      stderr: `${diagnostic}\nnewly red, no matching failure in list.json: //control:test`
    })
    assert.equal(checked._tag, "Broken", diagnostic)
  }
})
