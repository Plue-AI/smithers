import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { requireReachedGoFault } from "../harness/durability.ts"

// Reuse the composed install rehearsal rather than a second engine harness.
// A missing installed helper or database is a failed qualification, never skip.
test("C-DUR-01: packaged TODO host kill, pinned Retry and retained evidence", () => {
  expect(process.env.SMITHERS_TEST_DATABASE_URL, "Real PostgreSQL is required").toBeTruthy()
  const result = spawnSync("go", ["test", "-json", "-count=1", "./internal/compose", "-run", "^TestTodoHostKillThroughInstall$", "-timeout", "12m"], {
    cwd: fileURLToPath(new URL("../../../../backend/", import.meta.url)),
    env: { ...process.env, SMITHERS_TODO_HOST_KILL: "1", SMITHERS_REQUIRE_DATABASE_TESTS: "1" },
    encoding: "utf8", timeout: 750_000, maxBuffer: 32 << 20
  })
  console.log(result.stdout ?? "")
  console.error(result.stderr ?? "")
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(0)
  requireReachedGoFault(result.stdout, "TestTodoHostKillThroughInstall", ["host-keyless-crossing"])
}, 780_000)
