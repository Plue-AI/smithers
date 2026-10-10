import { expect, test } from "vitest"
import { CardSchema } from "../src/Cards.ts"

const card = { id: "agents", kind: "agents", title: "Agents", status: "active", createdAt: 1, ordinal: 1 }
const payload = { native: false, agents: [] }
const request = {
  requestId: "probe-request",
  model: { id: "reviewer", protocol: "openai-chat", modelId: "model-a", credential: "PROBE_KEY" }
}

test("old persisted Agent cards decode without fabricating a pending probe", () => {
  const decoded = CardSchema.parse({ ...card, payload })
  expect(decoded.payload).toEqual(payload)
})

test("persisted probe identity and its original model survive Agent-card decoding", () => {
  const pending = { ...payload, testing: ["reviewer"], testRequests: { reviewer: request } }
  expect(CardSchema.parse({ ...card, payload: pending }).payload).toEqual(pending)
})

test.each([
  { ...request, requestId: 4 },
  { ...request, model: { ...request.model, protocol: "unknown" } },
  { ...request, model: { ...request.model, credential: "provider-secret-with-spaces" } },
  { ...request, model: { ...request.model, apiKey: "never-persist-a-secret" } }
])("invalid probe snapshots cannot enter persisted Agent cards: %j", (invalid) => {
  expect(CardSchema.safeParse({ ...card, payload: { ...payload, testRequests: { reviewer: invalid } } }).success).toBe(
    false
  )
})
