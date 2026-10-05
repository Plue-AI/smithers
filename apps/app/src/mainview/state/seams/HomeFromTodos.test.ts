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


test("failed background rows survive Home projection and use the same served ids", () => {
 const background = [{ id: "flow-load:3", title: "flow-load", state: "failed" as const, detail: "import failed", actions: [
  { tag: "background.retry" as const, label: "Retry", args: { id: "flow-load:3" } }, { tag: "background.dismiss" as const, label: "Dismiss", args: { id: "flow-load:3" } }
 ] }]
 expect(HomeCardSchema.parse(homeFromTodos("owner/repo", [], background)).background_runs).toEqual(background)
 expect(homeFromTodos("owner/repo", []).background_runs).toEqual([])
})
