import { Effect } from "effect"
import { expect, test } from "vitest"
import * as Recall from "../src/Recall.ts"
import { selectRecall } from "../src/Source.ts"
import { MemoryError } from "../src/MemoryError.ts"

const rows = [
  { bank: "flow-main", key: "file", text: "literal retry file", score: 4 },
  { bank: "flow-main", key: "page", text: "literal wiki policy", score: 3 },
  { bank: "flow-main", key: "todo", text: "literal TODO", score: 2 },
  { bank: "flow-main", key: "run", text: "literal run", score: 1 }
]
const run = (budget: number, choices = [0, 1, 2, 3], cost = () => 5) => Effect.runPromise(selectRecall(
  { banks: ["flow-main"], query: "retry", maxTokens: 2048 }, () => Effect.succeed(choices), cost, budget
).pipe(Effect.provide(Recall.layer({ recall: () => Effect.succeed(rows) }))))

test.each([[0, []], [4, []], [5, ["file"]], [10, ["file", "page"]], [19, ["file", "page", "todo"]], [20, ["file", "page", "todo", "run"]]] as const)("budget %i drops lowest-ranked whole items", async (budget, expected) => {
  expect((await run(budget)).map(row => row.key)).toEqual(expected)
})
test("invalid and duplicate indexes cannot invent rows or consume budget", async () => {
  expect((await run(10, [-1, 99, 0, 0, 1, 1.5])).map(row => row.key)).toEqual(["file", "page"])
})
test.each([NaN, Infinity, -1])("unknown or negative budget %s fails closed", async budget => {
  expect(await run(budget)).toEqual([])
})
test.each([NaN, Infinity, -1])("unknown or negative row cost %s fails closed", async cost => {
  expect(await run(20, [0, 1], () => cost)).toEqual([])
})
test("namespace refusal propagates before the model is called", async () => {
  let called = false
  const refusal = new MemoryError({ code: "invalid_namespace", message: "Denied namespace" })
  await expect(Effect.runPromise(selectRecall({ banks: ["user-other"], query: "retry" }, () => {
    called = true; return Effect.succeed([0])
  }, () => 1, 24000).pipe(Effect.provide(Recall.layer({ recall: () => Effect.fail(refusal) }))))).rejects.toThrow("Denied namespace")
  expect(called).toBe(false)
})
