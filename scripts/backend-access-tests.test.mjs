import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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
