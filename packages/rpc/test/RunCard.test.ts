import { expect, test } from "vitest"
import { CardSchema } from "../src/Cards.ts"
import { LegacyRunTracePayloadSchema } from "../src/RunCard.ts"

const saved = {
  id: "saved-run", kind: "run-trace", title: "Recorded run", status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "acme/app", runId: "old-run", workflow: "todo", phase: "failed", steps: [], result: null, lastSeq: 3,
    filter: "forks", events: [{ sequence: 3, kind: "forked", payload: { parentRunId: "parent", runId: "old-run" } }] }
}

test("the canonical run wire decoder preserves a saved fork journal and normalizes its retired filter", () => {
  const historical = JSON.parse(JSON.stringify(saved))
  const payload = LegacyRunTracePayloadSchema.parse(historical.payload)
  expect(payload.filter).toBe("all")
  expect(payload.events).toEqual([{ sequence: 3, kind: "forked", payload: { parentRunId: "parent", runId: "old-run" } }])
  const card = CardSchema.parse(historical)
  expect(card.kind).toBe("run-trace")
  expect(card.kind === "run-trace" && card.payload).toEqual(payload)
})

test("historical run wire validation retains step-instance graph evidence and rejects an invalid cursor", () => {
  const graph = { planId: "plan", digest: "digest", nodes: [{ id: "checks", kind: "step", key: "key", dependsOn: [], tier: "sealed", action: "coding/check-command", status: "run" }],
    graph: { edges: [], nodes: [{ id: "checks", declaredAt: { path: "flows/todo/flow.ts", line: 3 } }], sourceRevision: "recorded-sha" } }
  const decoded = LegacyRunTracePayloadSchema.parse({ ...saved.payload, plan: graph, cursorSeq: 3 })
  expect(decoded.plan).toEqual(graph)
  expect(LegacyRunTracePayloadSchema.safeParse({ ...saved.payload, cursorSeq: -1 }).success).toBe(false)
})
