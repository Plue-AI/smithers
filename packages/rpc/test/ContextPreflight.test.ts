import { expect, test } from "vitest"
import { composeAgentInstructions } from "../src/AgentContext.ts"
import type { AgentRuntimeContext } from "../src/AgentContext.ts"
import { ContextLineCardSchema } from "../src/ContextLineCard.ts"
import { ContextPreflightInputSchema, ContextCandidateSchema, SelectedContextItemSchema } from "../src/ContextPreflight.ts"
const context: AgentRuntimeContext = {
  version: 1, product: "smithers", capturedAt: 1786223000000, revision: 7, surface: "chat", theme: "dark",
  selectedWorldDocument: null, connectors: [], github: { connected: false, login: null, repositories: null },
  worldState: { documentCount: 1, documents: [{ path: "private.md", title: "canary-private", confidence: 1, body: "canary-private" }] },
  capabilities: [], limitations: []
}
test("explicit empty selection excludes every browser-provided document", () => {
  expect(composeAgentInstructions("Answer", context, [])).toBe("Answer\n\nSelected context:\n[]")
})
test("historical lines without reasons remain decodable", () => {
  expect(ContextLineCardSchema.parse({ count: 1, expanded: false, items: [{ kind: "file", label: "old", ref: "old.ts" }] }).items[0]?.reason).toBeUndefined()
  expect(SelectedContextItemSchema.safeParse({ kind: "file", label: "old", ref: "old.ts" }).success).toBe(false)
})
test("file and wiki candidates require revisions and preflight excludes issue candidates", () => {
  for (const kind of ["file", "page", "issue"] as const) expect(ContextCandidateSchema.safeParse({ item: { kind, label: "Source", ref: "source" }, text: "data" }).success).toBe(false)
})
test("owner budget defaults to 24000 and can exceed it without changing recall's byte contract", () => {
  const base = { prompt: "Retry?", author: "ben", branch: "main", state: "synced", recent: [], candidates: [] }
  expect(ContextPreflightInputSchema.parse(base).tokenBudget).toBe(24000)
  expect(ContextPreflightInputSchema.parse({ ...base, tokenBudget: 32000 }).tokenBudget).toBe(32000)
})
