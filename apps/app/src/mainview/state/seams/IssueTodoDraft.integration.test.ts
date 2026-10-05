import { expect, test } from "bun:test"
import { createWebAgent } from "../../native/WebAgent"
import { draftIssueWithAgent } from "./IssueTodoDraft"
import { launchModelProvider } from "../../../../e2e/real/support/model-provider-process"
import { INSTALL_MODEL } from "../../../../e2e/real/support/model-provider-behaviors"

// Real TCP + the shared provider process: exercise streamed structured output
// through WebAgent. The bundle browser spec additionally covers the installed backend.
test("issue drafting integrates with the model stand-in over HTTP, refuses failure and retries", async () => {
  const key = "issue-draft-loopback-credential"
  const provider = await launchModelProvider({ key })
  const requests: unknown[] = []; let fail = true
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/cancel")) return Response.json({ ok: true })
    const body = await request.json(); requests.push(body)
    if (fail) return new Response("Unavailable", { status: 503 })
    const upstream = await fetch(`${provider.origin}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: INSTALL_MODEL.fast, stream: true, messages: [{ role: "system", content: body.instructions }, ...body.messages] }) })
    expect(upstream.status).toBe(200)
    const frames: unknown[] = []
    for (const line of (await upstream.text()).split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      const content = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content
      if (content) frames.push({ runId: body.runId, type: "delta", kind: "text", text: content })
    }
    frames.push({ runId: body.runId, type: "done" })
    return new Response(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } })
  } })
  try {
    const agent = createWebAgent({ baseUrl: `http://127.0.0.1:${host.port}` })
    const source = { number: 42, title: "Retry webhooks", body: "Retry forever", url: "https://github.com/acme/app/issues/42", comments: [{ author: "maya", body: "Stop after five attempts with jitter." }] }
    await expect(draftIssueWithAgent(agent, source, new AbortController().signal)).rejects.toThrow()
    fail = false
    expect(await draftIssueWithAgent(agent, source, new AbortController().signal)).toEqual({ title: source.title, prompt: source.comments[0]!.body, acceptance: [source.comments[0]!.body] })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ tools: [], role: "orchestrator" })
    expect(requests[1]).not.toHaveProperty("model")
    expect(await provider.journal()).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: INSTALL_MODEL.fast, step: "todo/draft", authorized: true, status: 200 })]))
  } finally { host.stop(true); await provider.close() }
}, 30_000)
