import * as Model from "@smthrs/model/Model"
import type { ModelRequest } from "@smthrs/model/ModelRequest"
import { SelectedContextItemSchema } from "@smthrs/rpc/ContextPreflight"
import type { ContextPreflightInput } from "@smthrs/rpc/ContextPreflight"
import { Effect, Stream } from "effect"
import { expect, test } from "vitest"
import { runContextPreflight } from "../src/ContextPreflight.ts"
import { providerRequest } from "../src/ModelTurnHost.ts"

const input: ContextPreflightInput = {
  prompt: "where do we retry webhooks?", author: "ben", branch: "main", state: "synced",
  recent: Array.from({ length: 500 }, (_, i) => ({ title: `Shared ${i}`, text: `shared-${i}` })),
  candidates: [
    { item: { kind: "file", label: "retry.ts", ref: "src/webhooks/retry.ts", revision: "abc123" }, text: "export const retry = 3" },
    { item: { kind: "page", label: "Retries", ref: "retries", revision: "4" }, text: "Retry webhooks three times" },
    { item: { kind: "todo", label: "T10", ref: "T10", revision: "2" }, text: "Improve webhook retries" },
    { item: { kind: "run", label: "T10 run", ref: "run-10", revision: "1" }, text: "Webhook retry test passed" }
  ], tokenBudget: 24000, wikiOnly: false
}
const fake = (output: string, requests: ModelRequest[]) => Model.make({ stream: request => {
  requests.push(request)
  return Stream.fromIterable([
    { type: "text-delta" as const, id: "s", text: output },
    { type: "settle" as const, stopReason: "stop" as const }
  ])
} })

test("one fast call selects pinned data and the production request excludes the other 497 texts", async () => {
  const requests: ModelRequest[] = []
  // Recall's literal ranking: file, page, run, TODO (ties by key).
  const answer = await Effect.runPromise(runContextPreflight(input, fake('[{"index":0,"reason":"Retry implementation"}]', requests), { modelId: "owner-fast" }))
  expect(requests).toHaveLength(1)
  expect(answer.result.context).toEqual([{ kind: "file", label: "retry.ts", ref: "src/webhooks/retry.ts", revision: "abc123", reason: "Retry implementation" }])
  expect(answer.result.model).toBe("owner-fast")
  expect(answer.result.durationMs).toBeGreaterThanOrEqual(0)
  expect(answer.messages).toEqual([
    { role: "assistant", content: "shared-497" }, { role: "assistant", content: "shared-498" },
    { role: "assistant", content: "shared-499" }, { role: "user", content: "where do we retry webhooks?" }
  ])
  const request = providerRequest({ runId: "r", instructions: "Answer", messages: answer.messages, selectedContext: answer.selectedContext }, { modelId: "coding" })
  expect(request.system[0]?.text).toBe('Answer\n\nSelected context:\n[{"item":{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123","reason":"Retry implementation"},"text":"export const retry = 3"}]')
  expect(JSON.stringify(request)).not.toContain('"shared-496"')
  expect(JSON.stringify(request)).not.toContain("Retry webhooks three times")
})

test.each([0, 159, 160])("whole-item conservative token budget %i", async budget => {
  const candidate = input.candidates[0]!
  const answer = await Effect.runPromise(runContextPreflight({ ...input, candidates: [candidate], tokenBudget: budget }, fake('[{"index":0,"reason":"Retry implementation"}]', []), { modelId: "coding-fallback" }))
  // Independently committed JSON rendering above is 159 UTF-8 bytes plus a conservative separator byte.
  expect(answer.result.context).toHaveLength(budget < 160 ? 0 : 1)
  expect(answer.result.model).toBe("coding-fallback")
})

test("wiki-only recall excludes files, TODOs and runs and pins page revision", async () => {
  const requests: ModelRequest[] = []
  const answer = await Effect.runPromise(runContextPreflight({ ...input, wikiOnly: true }, fake('[{"index":0,"reason":"Wiki policy"}]', requests), { modelId: "fast" }))
  expect(answer.result.context).toEqual([{ kind: "page", label: "Retries", ref: "retries", revision: "4", reason: "Wiki policy" }])
  expect(JSON.stringify(requests)).not.toContain("src/webhooks/retry.ts")
  expect(JSON.stringify(requests)).not.toContain("run-10")
})

test.each(['[{"index":0}]', '[{"index":99,"reason":"unknown"}]', 'not JSON', '[{"index":0,"reason":""}]'])("invalid selection refuses %s", async output => {
  await expect(Effect.runPromise(runContextPreflight(input, fake(output, []), { modelId: "fast" }))).rejects.toThrow()
})

test("new context items require label and reason", () => {
  expect(SelectedContextItemSchema.safeParse({ kind: "file", ref: "a.ts", reason: "Read" }).success).toBe(false)
  expect(SelectedContextItemSchema.safeParse({ kind: "file", ref: "a.ts", label: "a.ts" }).success).toBe(false)
})
