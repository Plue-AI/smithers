/** T-REL-04: the existing FaultSuite also runs the production Go boundaries. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { requireReachedGoFault } from "./harness/durability.ts"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
const backend = `${root}packages/backend`
const cases = [
  ["C-DUR-01", "internal/compose/todo_pause_fault_test.go", "TestTodoStartCrashThroughRoute", ["start"]],
  ["C-DUR-01", "internal/services/todo_pause_fault_test.go", "TestTodoStartPauseResumeCrashThroughRoutes", ["stop", "resume"]],
  ["C-DUR-01", "internal/compose/postgres_kill_fault_test.go", "TestTodoPostgresCrashThroughRoute", ["postgres-transition"]],
  ["C-DUR-03", "internal/compose/todo_merge_fault_test.go", "TestTodoMergeCrashThroughRoute", ["merge-pre-land", "merge-post-land", "merge-post-call"]],
  ["C-DUR-03", "internal/compose/github_outbound_kill_test.go", null, []],
  ["C-DUR-04", "internal/machined/fault_test.go", null, []],
  ["C-DUR-04", "internal/machined/rebase_fault_test.go", "TestRebaseCrashThroughDispatcher", ["rebase-post-capture", "rebase-mid", "rebase-post-apply"]]
] as const

// These TypeScript siblings are automatically executed by FaultSuite once
// present. Absence must fail rather than reduce the matrix silently.
for (const file of ["host/case40-host-kill-todo-run.test.ts", "github-step-kill.test.ts"]) {
  test(`required production sibling: ${file}`, () => {
    expect(existsSync(`${root}packages/smithers/test/faults/${file}`), `Missing production fault case: ${file}`).toBe(true)
  })
}

const selected = process.env.SMITHERS_FAULT_HOST === "reference"
  ? [...cases, ["C-DUR-02", "flowhost/machine_kill_fault_test.go", null, []] as const]
  : cases
for (const [check, file, name, points] of selected) {
  test(`${check}: ${name ?? file}`, () => {
    expect(existsSync(`${backend}/${file}`), `Missing production fault case: ${file}`).toBe(true)
    expect(process.env.SMITHERS_TEST_DATABASE_URL, "Real PostgreSQL is required").toBeTruthy()
    const pkg = file.slice(0, file.lastIndexOf("/"))
    // Sibling tickets own their test names. Select only the functions in
    // their declared case file, never the entire package's unrelated tests.
    const names = name ? [name] : [...readFileSync(`${backend}/${file}`, "utf8")
      .matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)]
      .map((match) => match[1]!).filter((entry) => !entry.includes("Child"))
    expect(names.length, `No acceptance tests in ${file}`).toBeGreaterThan(0)
    const result = spawnSync("go", ["test", "-json", "-count=1", `./${pkg}`, "-run", `^(${names.join("|")})$`], {
      cwd: backend, env: process.env, encoding: "utf8", timeout: 150_000, maxBuffer: 32 << 20
    })
    // Preserve partial JSON and stderr before checking exit status: crashes,
    // compile errors and timeouts are precisely the failures this tier needs.
    console.log(result.stdout ?? "")
    console.error(result.stderr ?? "")
    expect(result.error, "Go fault process failed to execute").toBeUndefined()
    expect(result.signal, "Go fault process terminated by a signal").toBeNull()
    expect(result.status, "Go fault process exited unsuccessfully").toBe(0)
    for (const entry of names) requireReachedGoFault(result.stdout, entry, points)
  })
}
