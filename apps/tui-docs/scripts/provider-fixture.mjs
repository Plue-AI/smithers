/** Local network boundary for monitor demonstrations; no live credentials or paid requests. */
import { once } from "node:events"
import { createServer } from "node:http"
export async function providerFixture({ judge = false } = {}) {
  const server = createServer(async (request, response) => {
    if (request.url === "/routes") {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ routes: ["chatgpt"] }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    let content
    if (judge && body.instructions?.startsWith("Judge the supplied evidence")) {
      const { questions } = JSON.parse(body.input.find((item) => item.role === "user").content[0].text)
      const passing = new Set(["on_target", "complete", "notable"])
      content = JSON.stringify({
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            q.type === "boolean"
              ? { type: "boolean", probability: passing.has(id) ? 0.99 : 0.01 }
              : q.type === "choice"
              ? { type: "choice", choice: q.options?.[0] ?? Object.keys(q.criteria ?? {})[0] ?? "" }
              : { type: "score", score: 0 }
          ])
        )
      })
    } else {
      content = JSON.stringify(body).includes("You estimate how long")
        ? JSON.stringify({ minutes: 0.1, tokens: 800, low_minutes: 0.05, high_minutes: 0.3 })
        : "Addition checks passed."
    }
    response.setHeader("Content-Type", "text/event-stream")
    response.end([
      { type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: content },
      { type: "response.completed", response: { id: "response", status: "completed", usage: {} } }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    env: {
      SMITHERS_ACCOUNT_POOL_URL: url,
      SMITHERS_ACCOUNT_POOL_KEY: "docs-fixture",
      SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
      CODEX_HOME: "/nonexistent",
      NO_PROXY: "*"
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      })
  }
}
