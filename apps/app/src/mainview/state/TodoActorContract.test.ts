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

test("seeded actor decoding fuzz preserves extra fields and rejects every missing-field combination", () => {
 const fields = ["login", "name", "avatar_url", "color_index"] as const
 let seed = 0x37202026
 const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
 for (let iteration = 0; iteration < 512; iteration++) {
  const mask = iteration % 16
  const by: Record<string, unknown> = {
   kind: "person", login: `member-${next()}`, name: `Member ${next()}`,
   avatar_url: `https://github.com/member-${next()}.png`, color_index: next() % 6
  }
  for (let extra = 0; extra < next() % 8; extra++) by[`extra_${extra}_${next()}`] = {
   value: next(), nested: [null, Boolean(next() % 2), `text-${next()}`]
  }
  fields.forEach((field, bit) => { if (mask & (1 << bit)) delete by[field] })
  const model = structuredClone(fixtures.in_review.model) as any
  model.prompt_revisions[0].by = JSON.parse(JSON.stringify(by))
  const decoded = TodoCardSchema.safeParse(todoActors(model))
  expect(decoded.success).toBe(mask === 0)
  if (!decoded.success) expect(decoded.error.issues.some(issue => issue.path.includes("by"))).toBe(true)
 }
})

test("streaming rehearsal decoder reports fields, recovers after invalid JSON, and checks duplicate responses", async () => {
 const script = new URL("../../../scripts/check-todo-contract.ts", import.meta.url).pathname
 const child = Bun.spawn(["bun", script, "--stream"], {stdin:"pipe", stdout:"pipe", stderr:"pipe"})
 const valid = JSON.stringify(fixtures.in_review.model)
 const missing = structuredClone(fixtures.in_review.model) as any
 missing.prompt_revisions[0].by = {kind:"person",login:"ben"}
 child.stdin.write([valid, "{", JSON.stringify(missing), valid, valid].join("\n") + "\n")
 child.stdin.end()
 const lines = (await new Response(child.stdout).text()).trim().split("\n").map(line => JSON.parse(line))
 expect(await child.exited).toBe(0)
 expect(lines).toHaveLength(5)
 expect(lines[0]).toEqual({ok:true})
 expect(lines[1].error).toBeString()
 expect(lines[2].error).toContain("name")
 expect(lines[2].error).toContain("by")
 expect(lines[3]).toEqual({ok:true})
 expect(lines[4]).toEqual({ok:true})
}, 120_000)

test("an idle rehearsal decoder can be cancelled", async () => {
 const script = new URL("../../../scripts/check-todo-contract.ts", import.meta.url).pathname
 const child = Bun.spawn(["bun", script, "--stream"], {stdin:"pipe", stdout:"pipe", stderr:"pipe"})
 child.kill("SIGTERM")
 expect(await child.exited).not.toBe(0)
}, 120_000)
