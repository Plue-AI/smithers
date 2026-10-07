import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema, SessionSchema, initialSession } from "../state/AppState"
import { FLOW_NAMES } from "./FlowName"
test("saved repository reads retain source, revision and anchor under the canonical file door", () => {
 const args = '"docs/Meeting Notes.md:3:2" owner/repo --ref abc'
 const saved = JSON.stringify({ path: "docs/Meeting Notes.md", repo: "owner/repo", line: 3, column: 2, ref: "abc", operation: "repository" })
 for (const schema of [MessageSchema.shape.action, ToastSchema.shape.action]) {
   expect(JSON.parse(schema.parse({ flow: "files.read", args, label: "Open" })!.args!)).toEqual(JSON.parse(saved))
   expect(schema.parse({ flow: "files.read", args, label: "Open" })!.flow).toBe("file")
 }
 expect(JSON.parse(SessionSchema.parse({ ...initialSession("light"), pendingCommand: { name: "files.read", args, requirement: "repo-source", requestedAt: 1 } }).pendingCommand!.args!)).toEqual(JSON.parse(saved))
 expect(FLOW_NAMES.includes("files.read" as never)).toBe(false)
})

test("saved directory and workspace navigation keeps its scope on the canonical doors", () => {
 const cases = [
  ["files.list", '"docs/Meeting Notes" owner/repo', "files", { path: "docs/Meeting Notes", repo: "owner/repo", operation: "repository" }],
  ["box.files", '"docs/Meeting Notes" ws-1', "files", { path: "docs/Meeting Notes", workspaceId: "ws-1", operation: "workspace" }],
  ["box.file", '{"path":"docs/guide.md","workspaceId":"ws-1"}', "file", { path: "docs/guide.md", workspaceId: "ws-1", operation: "workspace" }],
  ["repo.tree", "ws-1#docs/Meeting Notes", "files", { copy: "ws-1", path: "docs/Meeting Notes", operation: "tree" }]
 ] as const
 for (const [flow, args, name, payload] of cases) {
  for (const schema of [MessageSchema.shape.action, ToastSchema.shape.action]) {
   const saved = schema.parse({ flow, args, label: "Open" })!
   expect(saved.flow).toBe(name)
   expect(JSON.parse(saved.args!)).toEqual(payload)
  }
  const pending = SessionSchema.parse({ ...initialSession("light"), pendingCommand: { name: flow, args, requirement: "signed-in", requestedAt: 1 } }).pendingCommand!
  expect(pending.name).toBe(name)
  expect(JSON.parse(pending.args!)).toEqual(payload)
  expect(FLOW_NAMES.includes(flow as never)).toBe(false)
 }
})

test("saved JSON file reads retain their source fields", () => {
 const payload = { path: "src/answer.ts", repo: "owner/repo", ref: "abc", line: 3 }
 const saved = MessageSchema.shape.action.parse({ flow: "files.read", args: JSON.stringify(payload), label: "Open" })!
 expect(saved.flow).toBe("file")
 expect(JSON.parse(saved.args!)).toEqual({ ...payload, operation: "repository" })
})
