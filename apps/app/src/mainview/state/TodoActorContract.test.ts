import { expect, test } from "bun:test"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { todoActors } from "./ProductActor"
test("actor decoder property: missing required fields reject, extra fields remain readable", () => {
 for (const field of ["name", "avatar_url", "color_index", "login"]) {
  const model = structuredClone(fixtures.in_review.model) as any
  model.prompt_revisions[0].by = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0, extra: "ignored" }
  expect(TodoCardSchema.safeParse(todoActors(model)).success).toBe(true)
  delete model.prompt_revisions[0].by[field]
  expect(TodoCardSchema.safeParse(todoActors(model)).success).toBe(false)
 }
 for (const by of [null, 1, "ben", {}, {kind:"unknown"}, {kind:"person",login:"ben",color_index:99}]) {
  const model = structuredClone(fixtures.in_review.model) as any; model.prompt_revisions[0].by=by
  let passed=false;try{passed=TodoCardSchema.safeParse(todoActors(model)).success}catch{}
  expect(passed).toBe(false)
 }
})
