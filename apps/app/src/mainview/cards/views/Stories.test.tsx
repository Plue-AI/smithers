import { expect, test } from "bun:test"
import { fixtureStories } from "./stories"

test("fixture adapter preserves supplied models, gestures, view and callbacks", () => {
  const fixture = { name: "example", model: { n: 12 }, actions: [{ tag: "todo.stop", label: "Stop", args: { n: "12" } }], gestures: { open: { tag: "todo", label: "Open", args: { n: "12" } } }, view: { maximized: false }, expect: ["Example"] }
  const callbacks = { onAction: () => {}, onView: () => {} }
  const seen: unknown[] = []
  const [story] = fixtureStories({ example: fixture }, (input, handlers) => { seen.push(input, handlers); return null })
  story!.render(callbacks)
  expect(seen).toEqual([fixture, callbacks])
  seen.length = 0
  story!.render(callbacks, [])
  expect(seen).toEqual([{ ...fixture, actions: [] }, callbacks])
  expect(fixture.actions).toHaveLength(1)
})
