import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { HomeCardSchema } from "@smthrs/rpc/HomeCard"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { NeedsYouKindSchema, TodoStateSchema } from "@smthrs/rpc/CardPrimitives"
import type { Action } from "@smthrs/rpc/CardAction"
import { homeFromTodos } from "./HomeFromTodos"

/* The install's `home` topic (packages/backend/internal/compose/live.go) pins its model for these TODO cards in a golden file. */
const testdata = new URL("../../../../../../packages/backend/internal/compose/testdata/live/", import.meta.url)
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, testdata), "utf8"))

// Home's list projection has no viewer input: all three roles receive the same
// row actions here; HomeContainer applies command-provider/role filtering later.
for (const role of ["owner", "maintainer", "member"] as const) {
  for (const state of TodoStateSchema.options) {
    for (const ready of [false, true]) {
      for (const kind of [undefined, ...NeedsYouKindSchema.options]) {
        test(`Home row actions: ${role}, ${state}, merge ${ready ? "ready" : "waiting"}, wait ${kind ?? "absent"}`, () => {
          const base = TodoCardSchema.parse((read("home-todos.json") as unknown[])[0])
          const todo = TodoCardSchema.parse({
            ...base, state,
            merge: ready ? { state: "ready", on_github: true } : { state: "waiting", reason: "state", on_github: false },
            waits: kind === undefined ? [] : [{ id: "wait-1", kind, prompt: "Act", since: "2026-10-05T00:00:00Z", actions: [] }]
          })
          const args = { n: String(todo.n) }
          const byState: Record<typeof state, Action[]> = {
            queued: [], starting: [], working: [],
            needs_you: [{ tag: "todo.answer", label: "Answer", args, primary: true }],
            paused: [{ tag: "todo.resume", label: "Resume", args }],
            failed: [{ tag: "todo.retry", label: "Retry", args }],
            in_review: [ready ? { tag: "merge", label: "Merge", args, primary: true } : { tag: "todo", label: "Review", args }],
            merged: [], dropped: []
          }
          const home = homeFromTodos("rehearsal-owner/app", [todo])
          if (state === "merged" || state === "dropped") {
            expect(home.items).toEqual([])
          } else {
            expect(home.items.map(item => item.actions)).toEqual([[
              { tag: "todo", label: todo.title, args: { ...args, door: "title" } },
              ...byState[state]
            ]])
          }
          expect(home.counts[state]).toBe(1)
        })
      }
    }
  }
}

test("the install's home topic serves the Home this browser builds from the same TODOs", () => {
  const todos = (read("home-todos.json") as unknown[]).map(todo => TodoCardSchema.parse(todo))
  const served = HomeCardSchema.parse(read("home.json"))
  expect(served).toEqual(homeFromTodos("rehearsal-owner/app", todos))
  expect(served.items.map(item => item.n)).toEqual([1, 2, 3, 4, 6])
})
