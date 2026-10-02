import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Models from "../src/models.ts"

test("real HTTP pool discovery permits only served routes and actual TUI startup uses its seat", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "tui-pool-startup-"))
  let routes: string[] = ["chatgpt"], status = 200, modelCalls = 0, judgeCalls = 0
  let cancelled = false
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe("Bearer fixture-pool-key")
    requests.push(request.url!)
    if (request.url === "/routes") {
      if (status === 0) {
        response.once("close", () => {
          cancelled = true
        })
        return
      }
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ routes }))
      return
    }
    const parts: Buffer[] = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    let text = "```cell\nctx.done(\"Pool answer.\");\n```"
    if (body.instructions?.startsWith("Judge the supplied evidence")) {
      judgeCalls++
      const { questions } = JSON.parse(body.input.find((row: { role: string }) => row.role === "user").content[0].text)
      text = JSON.stringify({
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => {
            // Route the one-step tool request to the pool's available Luna seat.
            // Every reply must match the evaluator's requested question type.
            if ((question as { type: string }).type === "choice") {
              const choices: Record<string, string> = {
                phase: "tool",
                size: "trivial",
                clarity: "clear",
                system: "answer"
              }
              const choice = choices[id]!
              expect(choice).toBeDefined()
              expect((question as { criteria: unknown }).criteria).toHaveProperty(choice)
              return [id, { type: "choice", choice }]
            }
            expect((question as { type: string }).type).toBe("boolean")
            return [id, {
              type: "boolean",
              probability: ["binary", "on_target", "complete"].includes(id) ? 0.99 : 0.01
            }]
          })
        )
      })
    } else {
      expect(body.model).toBe("gpt-6-luna")
      modelCalls++
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.end(
      [
        { type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: text },
        { type: "response.completed", response: { id: "response", status: "completed", usage: {} } }
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Fixture has no TCP address")
  const environment = {
    PATH: "",
    HOME: scratch,
    CODEX_HOME: join(scratch, "codex"),
    SMITHERS_ACCOUNT_POOL_URL: `http://127.0.0.1:${address.port}`,
    SMITHERS_ACCOUNT_POOL_KEY: "fixture-pool-key",
    SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
    NO_PROXY: "*"
  }
  const start = async () => {
    const child = spawn(
      "bun",
      [resolve(import.meta.dir, "../src/main.tsx"), scratch, "--print", "Reply Pool answer."],
      {
        env: {
          ...environment,
          PATH: process.env.PATH,
          ...(process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY ?
            {
              SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
            } :
            {})
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    let stdout = "", stderr = ""
    child.stdout.on("data", (data) => {
      stdout += data
    })
    child.stderr.on("data", (data) => {
      stderr += data
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
    try {
      const [code] = await once(child, "close")
      return { code, stdout, stderr }
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const discovered = await Models.detect(environment)
    expect(discovered.models.map((model) => model.seat)).toEqual(["openai:gpt-6-luna"])
    const answer = await start()
    expect(answer.code, answer.stderr).toBe(0)
    expect(answer.stdout.trim()).toBe("Pool answer.")
    expect(modelCalls).toBeGreaterThan(0)
    expect(judgeCalls).toBeGreaterThan(0)
    routes = []
    const empty = await start()
    expect(empty.code).toBe(1)
    expect(empty.stderr).toContain("No model is available")
    routes = ["anthropic"]
    expect((await Models.detect(environment)).models).toEqual([])
    routes = ["chatgpt"]
    status = 403
    const forbidden = await start()
    expect(forbidden.code).toBe(1)
    expect(forbidden.stderr).toContain("No model is available")
    status = 503
    expect((await Models.detect(environment)).models).toEqual([])
    status = 0
    const started = Date.now()
    expect((await Models.detect(environment)).models).toEqual([])
    expect(Date.now() - started).toBeLessThan(9000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(cancelled).toBe(true)
    const before = requests.length
    expect((await Models.detect({ ...environment, SMITHERS_ACCOUNT_POOL_KEY: "" })).models).toEqual([])
    expect(requests.length).toBe(before)
    expect(requests.filter((url) => url === "/routes").length).toBeGreaterThanOrEqual(5)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  }
}, 45_000)
