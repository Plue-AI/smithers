import assert from "node:assert/strict"
import { test } from "node:test"
import { retry } from "./retry.ts"

test("a successful delivery returns its result", async () => {
  assert.equal(await retry(async () => "delivered"), "delivered")
})

test("a failed delivery preserves the original error", async () => {
  const error = new Error("delivery unavailable")
  await assert.rejects(retry(async () => { throw error }), (actual) => actual === error)
})
