import { expect, test } from "bun:test"
import { HomeCardSchema } from "@smthrs/rpc/HomeCard"
import { projectHome } from "./HomeProjection"
import home from "../../../../../packages/backend/internal/compose/testdata/live/home.json"

test("historical stack aggregates replace rows and counts while preserving other committed Home providers", () => {
  const previous = HomeCardSchema.parse(structuredClone(home))
  const patch = { items: [], counts: { queued: 0, starting: 0, working: 0, needs_you: 0, paused: 0, failed: 0, in_review: 0, merged: 0, dropped: 2 } }
  const next = projectHome(previous, { Type: "todo.dropped", Data: { home: patch } })
  expect(next.items).toEqual([])
  expect(next.counts.dropped).toBe(2)
  expect(next.main).toEqual(previous.main)
  expect(next.machines).toEqual(previous.machines)
  expect(previous.items.length).toBeGreaterThan(0)
})
test("a missing historical aggregate or non-TODO event requests a fresh Home snapshot", () => {
  for (const fact of [null, {}, { Type: "todo.moved", Data: {} }, { Type: "todo.moved", Data: { home: { items: [], counts: {} } } }, { Type: "private.confirmation", Data: { home } }]) expect(() => projectHome(home, fact)).toThrow()
})
