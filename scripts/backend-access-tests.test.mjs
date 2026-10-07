import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { collect, packages, runPattern, selectsFile, testNames } from "./backend-access-tests.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

test("selects access files by name, not by test keyword", () => {
  assert.equal(selectsFile("member_poll_test.go"), true)
  assert.equal(selectsFile("install_workspace_head_authorization_integration_test.go"), true)
  assert.equal(selectsFile("install_owner_scope_test.go"), true)
  assert.equal(selectsFile("my_install_owner_scope_test.go"), false)
  assert.equal(selectsFile("member_poll.go"), false)
  assert.equal(selectsFile("github_sync_test.go"), false)
})

test("takes only top-level testing.T funcs", () => {
  const source = [
    "func TestMain(m *testing.M) {}",
    "func TestAlpha(t *testing.T) {}",
    "func testHelper(t *testing.T) {}",
    "func BenchmarkX(b *testing.B) {}",
    "func TestBeta(tt *testing.T) {",
    "\tt.Run(\"TestNested\", func(t *testing.T) {})"
  ].join("\n")
  assert.deepEqual(testNames(source), ["TestAlpha", "TestBeta"])
  assert.equal(runPattern(["TestAlpha", "TestBeta"]), "^(TestAlpha|TestBeta)$")
})

test("collect drops matching files that declare no test", () => {
  const dir = mkdtempSync(join(tmpdir(), "access-tests-"))
  for (const pkg of packages) mkdirSync(join(dir, pkg), { recursive: true })
  writeFileSync(join(dir, packages[0], "member_a_test.go"), "func TestA(t *testing.T) {}\n")
  writeFileSync(join(dir, packages[0], "member_fixture_test.go"), "func helper() {}\n")
  assert.deepEqual(collect(dir), [{ package: packages[0], file: "member_a_test.go", tests: ["TestA"] }])
})

test("the committed list matches the backend test files", () => {
  execFileSync(process.execPath, [join(root, "scripts/backend-access-tests.mjs"), "--check"], { stdio: "pipe" })
})

test("--runs selects from the files on disk even when the committed list is stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "access-runs-"))
  for (const pkg of packages) mkdirSync(join(dir, pkg), { recursive: true })
  mkdirSync(join(dir, "scripts"))
  copyFileSync(join(root, "scripts/backend-access-tests.mjs"), join(dir, "scripts/backend-access-tests.mjs"))
  writeFileSync(join(dir, "scripts/backend-access-tests.json"), "[]\n")
  writeFileSync(join(dir, packages[1], "member_new_test.go"), "func TestNew(t *testing.T) {}\n")
  const script = join(dir, "scripts/backend-access-tests.mjs")
  const runs = spawnSync(process.execPath, [script, "--runs"], { encoding: "utf8" })
  assert.equal(runs.status, 0)
  assert.equal(runs.stdout, `${packages[1]}\t^(TestNew)$\n`)
  assert.match(runs.stderr, /^warning: .*drifted/)
  assert.equal(spawnSync(process.execPath, [script, "--check"]).status, 1)
})
