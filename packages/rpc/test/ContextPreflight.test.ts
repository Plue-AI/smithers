import { expect, test } from "vitest"
import { composeAgentInstructions } from "../src/AgentContext.ts"
import type { AgentRuntimeContext } from "../src/AgentContext.ts"
import { ContextLineCardSchema } from "../src/ContextLineCard.ts"
import {
  ContextCandidateSchema,
  ContextPreflightInputSchema,
  SelectedContextItemSchema
} from "../src/ContextPreflight.ts"
const context: AgentRuntimeContext = {
  version: 1,
  product: "smithers",
  capturedAt: 1786223000000,
  revision: 7,
  surface: "chat",
  theme: "dark",
  selectedWorldDocument: null,
  connectors: [],
  github: { connected: false, login: null, repositories: null },
  worldState: {
    documentCount: 1,
    documents: [{ path: "private.md", title: "canary-private", confidence: 1, body: "canary-private" }]
  },
  capabilities: [],
  limitations: []
}
test("explicit empty selection excludes every browser-provided document", () => {
  expect(composeAgentInstructions("Answer", context, [])).toBe("Answer\n\nSelected context:\n[]")
})
test("historical lines without reasons remain decodable", () => {
  expect(
    ContextLineCardSchema.parse({ count: 1, expanded: false, items: [{ kind: "file", label: "old", ref: "old.ts" }] })
      .items[0]?.reason
  ).toBeUndefined()
  expect(SelectedContextItemSchema.safeParse({ kind: "file", label: "old", ref: "old.ts" }).success).toBe(false)
})
test("file and wiki candidates require revisions and preflight excludes issue candidates", () => {
  for (const kind of ["file", "page", "issue"] as const) {
    expect(ContextCandidateSchema.safeParse({ item: { kind, label: "Source", ref: "source" }, text: "data" }).success)
      .toBe(false)
  }
})
test("owner budget defaults to 24000 and can exceed it without changing recall's byte contract", () => {
  const base = { prompt: "Retry?", author: "ben", branch: "main", state: "synced", recent: [], candidates: [] }
  expect(ContextPreflightInputSchema.parse(base).tokenBudget).toBe(24000)
  expect(ContextPreflightInputSchema.parse({ ...base, tokenBudget: 32000 }).tokenBudget).toBe(32000)
})

test("paged preflight survives serialization and publishes only complete phases", async () => {
  const { projectContextPreflight, ContextPreflightProgressSchema } = await import("../src/ContextPreflight.ts")
  const first = {
    runId: "r",
    type: "context.preflight" as const,
    phase: "completed" as const,
    page: { index: 0, total: 2 },
    result: {
      model: "fast",
      durationMs: 12,
      candidates: [{ kind: "todo" as const, label: "T1", ref: "T1" }],
      context: [{ kind: "todo" as const, label: "T1", ref: "T1", reason: "One" }]
    }
  }
  const partial = projectContextPreflight({}, first)
  expect(partial.preflightPhase).toBe("started")
  const restored = ContextPreflightProgressSchema.parse(JSON.parse(JSON.stringify(partial)))
  const second = {
    ...first,
    page: { index: 1, total: 2 },
    result: {
      ...first.result,
      candidates: [],
      context: [{ kind: "todo" as const, label: "T2", ref: "T2", reason: "Two" }]
    }
  }
  const complete = projectContextPreflight(restored, second)
  expect(complete.preflightPhase).toBe("completed")
  expect(complete.preflightPage).toBeUndefined()
  expect(complete.preflight?.context).toEqual([...first.result.context, ...second.result.context])
  expect(complete.preflight?.candidates).toEqual(first.result.candidates)
  for (const invalid of [second, { ...first, page: { index: 2, total: 2 } }, { ...first, phase: undefined }]) {
    expect(() => projectContextPreflight({}, invalid)).toThrow()
  }
  for (
    const invalid of [{ ...second, page: { index: 1, total: 3 } }, { ...second, phase: "started" as const }, {
      ...second,
      result: { ...second.result, model: "other" }
    }, { ...second, result: { ...second.result, durationMs: 13 } }]
  ) {
    expect(() => projectContextPreflight(restored, invalid)).toThrow()
  }
  expect(projectContextPreflight(restored, { ...first, phase: "started" }).preflightPage?.next).toBe(1)
  const { page: _page, phase: _phase, ...legacy } = first
  expect(projectContextPreflight(restored, legacy)).toEqual({
    preflight: first.result,
    preflightPhase: "completed",
    preflightPage: undefined
  })
})
