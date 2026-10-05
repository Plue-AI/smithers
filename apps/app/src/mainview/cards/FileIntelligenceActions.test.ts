import { expect, test } from "bun:test"
import { fileIntelligenceActions } from "./FileCards"
const payload = { repo: "team/repo", path: "src/b.ts", content: "add(1, 2)", language: "typescript", truncated: false }
test("absent catalog rows keep persisted intelligence dark", () => {
  const calls: unknown[] = []
  const actions = fileIntelligenceActions(payload, (...args) => { calls.push(args) }, () => false)
  expect(actions.gestures).toEqual({})
  actions.onAction("code.hover", { line: "5", col: "3" })
  expect(calls).toEqual([])
})
test("available gestures dispatch the scoped path with one-based command columns", () => {
  const calls: unknown[] = []
  const actions = fileIntelligenceActions(payload, (...args) => { calls.push(args) }, () => true)
  actions.onAction("code.hover", { line: "5", col: "3" })
  actions.onAction("code.definition", { path: "foreign.ts", line: "3", col: "0" })
  expect(calls).toEqual([["code.hover", "src/b.ts:5:4 team/repo"], ["code.definition", "src/b.ts:3:1 team/repo"]])
})
test("each gesture needs its own catalog row", () => {
  const actions = fileIntelligenceActions(payload, () => {}, tag => tag === "code.hover")
  expect(Object.keys(actions.gestures)).toEqual(["hover"])
})
