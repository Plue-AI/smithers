/** T-REL-04: the existing FaultSuite also runs the production Go boundaries. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { requireReachedGoFaultMatrix, requireRebaseRecoveryObservations } from "./harness/durability.ts"
import { githubCrossings, githubPoints, requireGitHubRecoveryObservations } from "./harness/githubFaultMatrix.ts"
import { machineTodoPoints, requireTodoRecoveryObservations } from "./harness/todoFaultMatrix.ts"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
const backend = `${root}packages/backend`
// Preserve the original per-case suite allowance as the matrix grows from 16.
// Production recovery still has its independent 60-second deadline.
const githubRunMinutes = Math.ceil(44 * githubCrossings.length / 16)
const cases = [
  ["C-DUR-01", "internal/compose/todo_pause_delivery_fault_test.go", "TestTodoStopResumeDeliveryCrashComposed", [
    "stop-pre-delivery",
    "stop-delivery",
    "resume-pre-delivery",
    "resume-delivery"
  ]],
  ["C-DUR-01", "internal/compose/todo_pause_fault_test.go", "TestTodoStartCrashThroughRoute", ["start"]],
  ["C-DUR-01", "internal/compose/todo_live_pause_fault_test.go", "TestTodoStartPauseResumeCrashThroughRoutes", [
    "stop",
    "resume"
  ]],
  ["C-DUR-01", "internal/compose/postgres_kill_fault_test.go", "TestTodoPostgresCrashThroughRoute", [
    "postgres-transition"
  ]],
  ["C-DUR-03", "internal/compose/todo_merge_fault_test.go", "TestTodoMergeCrashThroughRoute", [
    "merge-pre-land",
    "merge-post-land",
    "merge-post-call"
  ]],
  ["C-DUR-03", "internal/compose/github_outbound_kill_test.go", null, [...githubPoints, "github-production-propose"]],
  ["C-DUR-04", "internal/machined/fault_test.go", null, []],
  ["C-DUR-04", "internal/compose/rebase_fault_test.go", "TestRebaseFaultRootInputsValidatedBeforeUse", []],
  ["C-DUR-04", "internal/compose/rebase_fault_test.go", "TestRebaseCrashThroughDispatcher", [
    "rebase-post-capture",
    "rebase-mid",
    "rebase-post-apply"
  ]]
] as const

// These TypeScript siblings are automatically executed by FaultSuite once
// present. Absence must fail rather than reduce the matrix silently.
for (const file of ["host/case40-host-kill-todo-run.test.ts", "engine/case39-kill-crossing.test.ts"]) {
  test(`required fault sibling: ${file}`, () => {
    expect(existsSync(`${root}packages/smithers/test/faults/${file}`), `Missing production fault case: ${file}`).toBe(
      true
    )
  })
}

// The retained-disk transport control alone cannot qualify C-DUR-02.
// Keep requiring the composed TODO kill marker until that reference case lands.
const selected = process.env.SMITHERS_FAULT_HOST === "reference"
  ? [
    ...cases,
    ["C-DUR-04", "internal/compose/rebase_fault_test.go", "TestRebaseVMCrashThroughDispatcher", [
      "rebase-post-capture",
      "rebase-mid",
      "rebase-post-apply"
    ]] as const,
    ["C-DUR-02", "flowhost/machine_kill_fault_test.go", null, ["machine-mid-command"]] as const,
    ["C-DUR-02", "internal/compose/todo_machine_kill_fault_test.go", "TestTodoMachineKillThroughInstall", [
      ...machineTodoPoints
    ]] as const
  ]
  : cases
for (const [check, file, name, points] of selected) {
  test(
    `${check}: ${name ?? file}`,
    () => {
      expect(existsSync(`${backend}/${file}`), `Missing production fault case: ${file}`).toBe(true)
      expect(process.env.SMITHERS_TEST_DATABASE_URL, "Real PostgreSQL is required").toBeTruthy()
      const pkg = file.slice(0, file.lastIndexOf("/"))
      // Sibling tickets own their test names. Select only the functions in
      // their declared case file, never the entire package's unrelated tests.
      const names = name ? [name] : [
        ...readFileSync(`${backend}/${file}`, "utf8")
          .matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)
      ]
        .map((match) => match[1]!).filter((entry) => !entry.includes("Child"))
      expect(names.length, `No acceptance tests in ${file}`).toBeGreaterThan(0)
      // The composed matrix enters the reserved production proposal route and
      // kills the claimed worker at every send/commit/response boundary.
      const githubControl = file === "internal/compose/github_outbound_kill_test.go"
      const referenceMachine = check === "C-DUR-02" || file === "internal/compose/rebase_fault_test.go"
      const rebaseFault = file === "internal/compose/rebase_fault_test.go"
      const packagedPause = name === "TestTodoStartPauseResumeCrashThroughRoutes"
      // Slow by design, not hung: K4b holds a real 30-second outage in each of
      // its 10 runs. The file took 344 s on nyc-02 (2026-10-10; K4b 329.7 s,
      // K4 12.4 s) and overran the old 2-minute budget.
      const machinedFault = file === "internal/machined/fault_test.go"
      const timeout = rebaseFault
        ? 14_500_000
        : githubControl
        ? (githubRunMinutes + 1) * 60_000
        : referenceMachine
        ? 2_700_000
        : packagedPause
        ? 750_000
        : machinedFault
        ? 630_000
        : 150_000
      const evidenceNames = githubControl
        ? githubCrossings.map((crossing) => `TestGitHubOutboundKillProductionProposal/${crossing}/crossing`)
        : name === "TestTodoMachineKillThroughInstall" ?
        machineTodoPoints.map((point) => `${name}/${point}/crossing`)
        : packagedPause
        ? ["stop", "resume"].map((point) => `${name}/${point}`)
        : names
      const result = spawnSync("go", [
        "test",
        "-json",
        "-count=1",
        `./${pkg}`,
        "-run",
        `^(${names.join("|")})$`,
        "-timeout",
        rebaseFault
          ? "4h"
          : githubControl
          ? `${githubRunMinutes}m`
          : referenceMachine
          ? "44m"
          : packagedPause
          ? "12m"
          : machinedFault
          ? "10m"
          : "2m"
      ], {
        cwd: backend,
        env: githubControl ?
          { ...process.env, SMITHERS_GITHUB_OUTBOUND_KILL: "1" }
          : packagedPause ?
          { ...process.env, SMITHERS_TODO_PAUSE_HOST_KILL: "1" }
          : rebaseFault
          ? {
            ...process.env,
            SMITHERS_REBASE_FAULT_REQUIRED: "1",
            ...(process.env.SMITHERS_FAULT_HOST === "reference" ? { SMITHERS_REBASE_FAULT_REFERENCE: "1" } : {})
          }
          : process.env,
        encoding: "utf8",
        timeout,
        maxBuffer: 32 << 20
      })
      // Preserve partial JSON and stderr before checking exit status: crashes,
      // compile errors and timeouts are precisely the failures this tier needs.
      console.log(result.stdout ?? "")
      console.error(result.stderr ?? "")
      expect(result.error, "Go fault process failed to execute").toBeUndefined()
      expect(result.signal, "Go fault process terminated by a signal").toBeNull()
      expect(result.status, "Go fault process exited unsuccessfully").toBe(0)
      if (rebaseFault) {
        requireRebaseRecoveryObservations(result.stdout, name!, name === "TestRebaseFaultRootInputsValidatedBeforeUse")
      } else requireReachedGoFaultMatrix(result.stdout, evidenceNames, points)
      if (githubControl) {
        requireGitHubRecoveryObservations(result.stdout)
      }
      if (name === "TestTodoMachineKillThroughInstall") requireTodoRecoveryObservations(result.stdout, "machine")
    },
    file === "internal/compose/rebase_fault_test.go"
      ? 14_550_000
      : file === "internal/compose/github_outbound_kill_test.go"
      ? (githubRunMinutes + 1.5) * 60_000
      : check === "C-DUR-02"
      ? 2_730_000
      : name === "TestTodoStartPauseResumeCrashThroughRoutes"
      ? 780_000
      : file === "internal/machined/fault_test.go"
      ? 660_000
      : 180_000
  )
}
