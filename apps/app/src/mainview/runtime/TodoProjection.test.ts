import { expect, test } from "bun:test"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { projectTodoCard } from "./TodoProjection"

test("committed TODO facts project their historical cards without inheriting old controls", () => {
  const before = { ...fixtures.working.model, n: 12 }
  const card = { ...fixtures.failed.model, n: 12 }
  const source = { Type: "todo.run_updated", State: "failed", Data: { card } }
  const projected = projectTodoCard(before, source)
  expect(projected).toEqual(card)
  expect(before.state).toBe("working")
  expect(projected.failure).toEqual(card.failure)
})
test("old, foreign and malformed source facts request resync instead of inventing a card", () => {
  const before = { ...fixtures.working.model, n: 12 }
  for (const event of [null, {}, { Type: "todo.run_updated", State: "failed", Data: { to: "failed" } },
    { Type: "todo.run_updated", State: "failed", Data: { card: { ...fixtures.failed.model, n: 13 } } },
    { Type: "todo.run_updated", State: "working", Data: { card: { ...fixtures.failed.model, n: 12 } } },
    { Type: "private.answer", State: "failed", Data: { card: { ...fixtures.failed.model, n: 12 } } }]) {
    expect(() => projectTodoCard(before, event)).toThrow()
  }
  expect(before.state).toBe("working")
})
