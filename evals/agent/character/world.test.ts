import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import * as World from "./world.ts"

const example = join(import.meta.dirname, "example", "world")

describe("World.load", () => {
  test("applies remove before add, so a case can replace an issue by removing and re-adding it", () => {
    const world = World.load(example, {
      remove: { issues: [7] },
      add: { issues: [{ number: 7, kind: "issue", title: "Signup button does nothing on Safari", state: "closed" }] }
    })
    const sevens = world.data.issues.filter((issue) => issue.number === 7)
    expect(sevens).toHaveLength(1)
    expect(sevens[0]!.state).toBe("closed")
    expect(world.data.issues.some((issue) => issue.number === 8)).toBe(true)
  })

  test("set replaces a key, remove drops by id or number, add appends and merges", () => {
    const world = World.load(example, {
      now: "2026-10-06T09:00:00-07:00",
      set: { notes: { likes: "short answers" } },
      remove: { issues: [8], calendar: ["ev-none"] },
      add: { issues: [{ number: 9, kind: "issue", title: "New", state: "open" }], answers: { engineering: [] } }
    })
    expect(world.data.now).toBe("2026-10-06T09:00:00-07:00")
    expect(world.data.notes).toEqual({ likes: "short answers" })
    expect(world.data.issues.map((issue) => issue.number)).toEqual([7, 9])
    expect(world.data.answers.engineering).toEqual([])
  })
})
