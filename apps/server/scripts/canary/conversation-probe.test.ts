import { expect, test } from "bun:test"
import { conversationProbe } from "./conversation-probe"

test("admission does not finish the probe; it follows the same host turn through the shared read", async () => {
  const requests: Array<{ path: string; method: string; body?: unknown }> = []
  let phase = 0
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    requests.push({ path, method: request.method, ...(request.method === "POST" ? { body: await request.json() } : {}) })
    if (path.endsWith("/prompt")) return Response.json({ turnId: "turn-1", runId: "host-1" }, { status: 202 })
    return Response.json({ id: "main", entries: phase === 0 ? [] : [{ id: "turn-1", runId: "host-1", state: phase === 1 ? "running" : "completed", frames: phase === 1 ? [] : [{ runId: "host-1", type: "done", reason: "stop" }] }] })
  } })
  try {
    const result = await conversationProbe({ origin: server.url.origin, key: "probe-key", headers: {}, signal: AbortSignal.timeout(5_000), fetch, sleep: async () => { phase++ } })
    expect(result.state).toBe("completed")
    expect(phase).toBe(2)
    expect(requests).toEqual([
      { path: "/api/conversations/main/prompt", method: "POST", body: { prompt: "Say the word ok and nothing else.", idempotencyKey: "probe-key" } },
      { path: "/api/conversations/main", method: "GET" },
      { path: "/api/conversations/main", method: "GET" },
      { path: "/api/conversations/main", method: "GET" }
    ])
  } finally { server.stop(true) }
})

test("cancelling a probe stops observation without cancelling the host turn", async () => {
  const abort = new AbortController(), paths: string[] = []
  const pending = conversationProbe({ origin: "http://fixture.invalid", key: "probe", headers: {}, signal: abort.signal,
    fetch: async path => { paths.push(path); return Response.json(path.endsWith("/prompt") ? { turnId: "turn-1", runId: "host-1" } : { id: "main", entries: [] }, { status: path.endsWith("/prompt") ? 202 : 200 }) },
    sleep: async () => { abort.abort() }
  })
  await expect(pending).rejects.toThrow("timed out")
  expect(paths).toEqual(["http://fixture.invalid/api/conversations/main/prompt", "http://fixture.invalid/api/conversations/main"])
})
