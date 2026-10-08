/** T-REL-04: the existing FaultSuite also runs the production Go boundaries. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { requireReachedGoFaultMatrix } from "./harness/durability.ts"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
const backend = `${root}packages/backend`
const cases = [
  ["C-DUR-01", "internal/compose/todo_pause_delivery_fault_test.go", "TestTodoStopResumeDeliveryCrashComposed", ["stop-pre-delivery", "stop-delivery", "resume-pre-delivery", "resume-delivery"]],
  ["C-DUR-01", "internal/compose/todo_pause_fault_test.go", "TestTodoStartCrashThroughRoute", ["start"]],
  ["C-DUR-01", "internal/services/todo_pause_fault_test.go", "TestTodoStartPauseResumeCrashThroughRoutes", ["stop", "resume"]],
  ["C-DUR-01", "internal/compose/postgres_kill_fault_test.go", "TestTodoPostgresCrashThroughRoute", ["postgres-transition"]],
  ["C-DUR-03", "internal/compose/todo_merge_fault_test.go", "TestTodoMergeCrashThroughRoute", ["merge-pre-land", "merge-post-land", "merge-post-call"]],
  ["C-DUR-03", "internal/compose/github_outbound_kill_test.go", null, ["github-push", "github-open", "github-body", "github-merge", "github-close", "github-production-propose"]],
  ["C-DUR-04", "internal/machined/fault_test.go", null, []],
  ["C-DUR-04", "internal/machined/rebase_fault_test.go", "TestRebaseCrashThroughDispatcher", ["rebase-post-capture", "rebase-mid", "rebase-post-apply"]]
] as const

// These TypeScript siblings are automatically executed by FaultSuite once
// present. Absence must fail rather than reduce the matrix silently.
for (const file of ["host/case40-host-kill-todo-run.test.ts", "engine/case39-kill-crossing.test.ts"]) {
  test(`required fault sibling: ${file}`, () => {
    expect(existsSync(`${root}packages/smithers/test/faults/${file}`), `Missing production fault case: ${file}`).toBe(true)
  })
}

// The retained-disk transport control alone cannot qualify C-DUR-02.
// Keep requiring the composed TODO kill marker until that reference case lands.
const selected = process.env.SMITHERS_FAULT_HOST === "reference"
  ? [...cases,
    ["C-DUR-02", "flowhost/machine_kill_fault_test.go", null, ["machine-mid-command"]] as const,
    ["C-DUR-02", "internal/compose/todo_machine_kill_fault_test.go", "TestTodoMachineKillThroughInstall", ["machine-mid-todo"]] as const]
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
    // Candidate controls exercise outbound recovery without qualifying the
    // sandboxed native proposal binding. They cannot satisfy the production
    // propose marker, even when every outbound crossing passes.
    const githubControl = file === "internal/compose/github_outbound_kill_test.go"
    const referenceMachine = check === "C-DUR-02"
    const timeout = referenceMachine ? 2_700_000 : githubControl ? 750_000 : 150_000
    const evidenceNames = githubControl
      ? ["push", "open", "body", "merge", "close"].map(kind => `TestGitHubOutboundKillComposedCandidateControl/${kind}/crossing`)
      : names
    const result = spawnSync("go", ["test", "-json", "-count=1", `./${pkg}`, "-run", `^(${names.join("|")})$`,
      "-timeout", referenceMachine ? "44m" : githubControl ? "12m" : "2m"], {
      cwd: backend,
      env: githubControl ? { ...process.env, SMITHERS_GITHUB_OUTBOUND_KILL: "1" } : process.env,
      encoding: "utf8", timeout, maxBuffer: 32 << 20
    })
    // Preserve partial JSON and stderr before checking exit status: crashes,
    // compile errors and timeouts are precisely the failures this tier needs.
    console.log(result.stdout ?? "")
    console.error(result.stderr ?? "")
    expect(result.error, "Go fault process failed to execute").toBeUndefined()
    expect(result.signal, "Go fault process terminated by a signal").toBeNull()
    expect(result.status, "Go fault process exited unsuccessfully").toBe(0)
    requireReachedGoFaultMatrix(result.stdout, evidenceNames, points,
      name === "TestRebaseCrashThroughDispatcher" ? ["people-present", "people-absent"] : [])
  }, check === "C-DUR-02" ? 2_730_000 : file === "internal/compose/github_outbound_kill_test.go" ? 780_000 : 180_000)
}
