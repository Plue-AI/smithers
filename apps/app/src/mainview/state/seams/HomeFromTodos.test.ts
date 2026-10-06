import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { HomeCardSchema } from "@smthrs/rpc/HomeCard"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { TodoStateSchema } from "@smthrs/rpc/CardPrimitives"
import { homeFromTodos } from "./HomeFromTodos"

/* The install's `home` topic (packages/backend/internal/compose/live.go) pins its model for these TODO cards in a golden file. */
const testdata = new URL("../../../../../../packages/backend/internal/compose/testdata/live/", import.meta.url)
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, testdata), "utf8"))

test("Home counts every state and keeps only open rows", () => {
  const base = TodoCardSchema.parse((read("home-todos.json") as unknown[])[0])
  const todos = TodoStateSchema.options.map((state, index) => ({ ...base, n: index + 1, state }))
  const home = homeFromTodos("rehearsal-owner/app", todos)
  expect(Object.values(home.counts)).toEqual(TodoStateSchema.options.map(() => 1))
  expect(home.items.map(row => row.state)).toEqual(TodoStateSchema.options.filter(state => state !== "merged" && state !== "dropped"))
})

test("the install's home topic serves the Home this browser builds from the same TODOs", () => {
  const todos = (read("home-todos.json") as unknown[]).map(todo => TodoCardSchema.parse(todo))
  const served = HomeCardSchema.parse(read("home.json"))
  const projected = homeFromTodos("rehearsal-owner/app", todos, "owner")
  expect({ ...served, items: served.items.map(({ actions, ...row }) => row) }).toEqual({ ...projected, items: projected.items.map(({ actions, ...row }) => row) })
  expect(projected.items[0]!.actions.at(-1)).toEqual({ tag: "merge", label: "Merge", args: { n: "1" }, primary: true })
  expect(served.items.map(item => item.n)).toEqual([1, 2, 3, 4, 6])
})

test("Home uses the recorded wait kind and leaves missing-kind bugs without a primary", () => {
  const base = TodoCardSchema.parse((read("home-todos.json") as unknown[])[0])
  for (const [kind, tag, label] of [["question", "todo.answer", "Answer"], ["approval", "todo.answer", "Answer"], ["conflict", "branch", "Resolve"], ["moved_off", "branch", "Resolve"], ["foreign_push", "todo", "Review"]] as const) {
    const todo = { ...base, state: "needs_you" as const, waits: [{ id: "w", kind, prompt: "Act", since: "2026-10-06T00:00:00Z", actions: [] }] }
    const row = homeFromTodos("owner/repo", [todo], "owner").items[0]!
    expect(row.actions.filter(action => action.primary)).toEqual([{ tag, label, args: tag === "branch" ? { name: todo.branch?.name ?? `T${todo.n}` } : { n: String(todo.n) }, primary: true }])
  }
  const broken = homeFromTodos("owner/repo", [{ ...base, state: "needs_you", waits: [] }], "owner").items[0]!
  expect(broken.needs_you).toBeUndefined() // BUG: the host omitted the primary kind.
  expect(broken.actions.filter(action => action.primary)).toEqual([])
  expect(broken.actions).toEqual([{ tag: "todo", label: base.title, args: { n: String(base.n), door: "title" } }])
})
