import { spawnSync } from "node:child_process"
import { expect, test } from "vitest"
import { requireReachedGoFault } from "../harness/durability.ts"
import { goFaultEnvironment, requireFaultHost, workspaceRoot } from "../harness/goFaultRun.ts"
import { requireTodoRecoveryObservations } from "../harness/todoFaultMatrix.ts"

// Reuse the composed install rehearsal rather than a second engine harness.
// A missing installed helper or database is a failed qualification, never skip.
// Long tier: the case is budgeted at 72 minutes.
test("C-DUR-01: packaged TODO host kill, pinned Retry and retained evidence", () => {
  requireFaultHost()
  expect(process.env.SMITHERS_TEST_DATABASE_URL, "Real PostgreSQL is required").toBeTruthy()
  const result = spawnSync("go", [
    "test",
    "-json",
    "-count=1",
    "./internal/compose",
    "-run",
    "^(TestTodoHostKillThroughInstall|TestTodoHostRecordedKillThroughInstall)$",
    "-timeout",
    "72m"
  ], {
    cwd: `${workspaceRoot}packages/backend/`,
    env: goFaultEnvironment({ SMITHERS_TODO_HOST_KILL: "1", SMITHERS_REQUIRE_DATABASE_TESTS: "1" }),
    encoding: "utf8",
    timeout: 4_350_000,
    maxBuffer: 32 << 20
  })
  console.log(result.stdout ?? "")
  console.error(result.stderr ?? "")
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(0)
  requireTodoRecoveryObservations(result.stdout, "host")
  requireReachedGoFault(result.stdout, "TestTodoHostKillThroughInstall/host-keyless-crossing", [
    "host-keyless-crossing"
  ])
}, 4_380_000)
