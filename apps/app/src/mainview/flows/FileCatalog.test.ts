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
