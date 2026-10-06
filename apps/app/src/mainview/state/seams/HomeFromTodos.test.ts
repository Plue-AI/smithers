import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { HomeCardSchema } from "@smthrs/rpc/HomeCard"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { homeFromTodos } from "./HomeFromTodos"

/* The install's `home` topic (packages/backend/internal/compose/live.go) pins its model for these TODO cards in a golden file. */
const testdata = new URL("../../../../../../packages/backend/internal/compose/testdata/live/", import.meta.url)
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, testdata), "utf8"))

test("the install's home topic serves the Home this browser builds from the same TODOs", () => {
  const todos = (read("home-todos.json") as unknown[]).map(todo => TodoCardSchema.parse(todo))
  const served = HomeCardSchema.parse(read("home.json"))
  expect(served).toEqual(homeFromTodos("rehearsal-owner/app", todos))
  expect(served.items.map(item => item.n)).toEqual([1, 2, 3, 4, 6])
})

test("Home derives Answer, Resolve and Review from the same shared wait kind as the rail", () => {
  const base = (read("home-todos.json") as unknown[]).map(todo => TodoCardSchema.parse(todo))[0]!
  for (const [kind, tag, label] of [
    ["question", "todo.answer", "Answer"], ["approval", "todo.answer", "Answer"],
    ["conflict", "branch", "Resolve"], ["moved_off", "branch", "Resolve"], ["foreign_push", "todo", "Review"]
  ] as const) {
    const todo = { ...base, state: "needs_you" as const, branch: { id: "branch", name: "todo/24", machine: { state: "waiting" as const, position: 1 } },
      waits: [{ id: "wait", kind, prompt: "Choose", since: "2026-10-05T10:00:00Z", actions: [] }] }
    const item = homeFromTodos("owner/repo", [todo]).items[0]!
    expect(item.actions.at(-1)).toEqual({ tag, label, args: tag === "branch" ? { name: "todo/24" } : { n: String(base.n) }, primary: true })
  }
  expect(homeFromTodos("owner/repo", [{ ...base, state: "needs_you", waits: [] }]).items[0]!.actions).toHaveLength(1)
})
