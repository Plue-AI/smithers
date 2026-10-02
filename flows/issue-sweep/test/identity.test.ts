import { FlowRuntime } from "@smthrs/flow"
import { Effect, Exit } from "effect"
import assert from "node:assert/strict"
import test from "node:test"
import { terminalIdentityConflict } from "../identity.ts"

for (const status of ["pending", "running", "suspended", "completed", "failed", "cancelled", "unknown"] as const) {
  test(`terminal identity recovery: ${status}`, async () => {
    const conflict = new FlowRuntime.ExecutionIdentityConflict({
      executionId: "child",
      field: "capabilities",
      expected: "wide",
      actual: "narrow",
      status,
      message: "changed ceiling"
    })
    let fresh = 0
    const exit = await Effect.runPromiseExit(
      Effect.fail(conflict).pipe(Effect.catchIf(terminalIdentityConflict, () =>
        Effect.sync(() => {
          fresh++
          return "fresh"
        })))
    )
    const terminal = status === "completed" || status === "failed" || status === "cancelled"
    assert.equal(fresh, Number(terminal))
    assert.deepEqual(exit, terminal ? Exit.succeed("fresh") : Exit.fail(conflict))
  })
}
test("terminal-looking foreign errors never trigger fresh work", () => {
  for (
    const error of [null, { status: "completed" }, new Error("completed"), {
      _tag: "@smthrs/engine/ExecutionIdentityConflict",
      status: "completed"
    }]
  ) assert.equal(terminalIdentityConflict(error), false)
})
