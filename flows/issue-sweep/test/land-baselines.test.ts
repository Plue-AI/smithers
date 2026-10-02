import { Effect } from "effect"
import assert from "node:assert/strict"
import test from "node:test"
import { type Checked, LandFailed, makeBaselines } from "../land.ts"

const labels = ["//a:test", "//b:test"]

for (
  const outcome of [
    { _tag: "Broken", message: "PostgreSQL unavailable" } as const,
    new LandFailed({ message: "baseline process failed" })
  ]
) {
  test(`baseline ${outcome._tag} blocks concurrent callers and retries on a later ask`, async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Checked>()
    let attempts = 0
    const baseline = makeBaselines({
      measure: (_commit, requested) => {
        attempts++
        assert.deepEqual(requested, labels)
        if (attempts > 1) return Effect.succeed({ _tag: "Green" } as const)
        started.resolve()
        return Effect.promise(() => release.promise).pipe(
          Effect.flatMap((checked) => outcome instanceof LandFailed ? Effect.fail(outcome) : Effect.succeed(checked))
        )
      }
    })
    const first = Effect.runPromise(Effect.result(baseline("main", labels)))
    await started.promise
    const second = Effect.runPromise(Effect.result(baseline("main", [labels[1]!])))
    // Let the second caller subscribe while the first measurement remains unresolved.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(attempts, 1)
    release.resolve(outcome instanceof LandFailed ? { _tag: "Green" } : outcome)
    const results = await Promise.all([first, second])
    for (const result of results) {
      assert.equal(result._tag, "Failure", "an unavailable baseline must never excuse a red")
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "issue-sweep/LandFailed")
        assert.match(result.failure.message, /PostgreSQL unavailable|baseline process failed/)
      }
    }
    assert.deepEqual(await Effect.runPromise(baseline("main", labels)), [])
    assert.equal(attempts, 2)
    assert.deepEqual(await Effect.runPromise(baseline("main", [labels[1]!])), [])
    assert.equal(attempts, 2, "the successful retry should be cached")
  })
}

test("baseline caches genuine red and green labels separately for each main commit", async () => {
  const measurements: Array<[string, ReadonlyArray<string>]> = []
  const baseline = makeBaselines({
    measure: (commit, requested) => {
      measurements.push([commit, requested])
      return Effect.succeed<Checked>(
        commit === "old-main"
          ? { _tag: "Red", labels: [labels[0]!] }
          : { _tag: "Green" }
      )
    }
  })
  assert.deepEqual(await Effect.runPromise(baseline("old-main", labels)), [labels[0]])
  assert.deepEqual(await Effect.runPromise(baseline("old-main", [labels[1]!])), [])
  assert.deepEqual(await Effect.runPromise(baseline("old-main", [labels[0]!, labels[0]!])), [labels[0], labels[0]])
  assert.equal(measurements.length, 1)
  assert.deepEqual(await Effect.runPromise(baseline("new-main", labels)), [])
  assert.deepEqual(await Effect.runPromise(baseline("new-main", labels)), [])
  assert.deepEqual(measurements, [["old-main", labels], ["new-main", labels]])
})
