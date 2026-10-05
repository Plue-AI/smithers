import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

interface Seen {
  readonly method: string
  readonly url: string
  readonly via: string | undefined
  readonly body: unknown
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/**
 * A real HTTP backend serving the install's TODOs the way `GET /api/todos/{n}`
 * and `POST /api/todos/{n}/answer` do: each TODO has its open waits, and an
 * answer is accepted once for an open question, 409 with who answered after.
 */
const backend = async (
  todos: Record<number, Array<{ id: string; kind: string }>>,
  refusal?: { status: number; body: object }
) => {
  const seen: Array<Seen> = []
  const answered = new Map<string, string>()
  const server = createServer((req: IncomingMessage, res) => {
    let text = ""
    req.on("data", (chunk) => text += chunk)
    req.on("end", () => {
      const body = text ? JSON.parse(text) : undefined
      const via = req.headers["smithers-via"]
      seen.push({ method: req.method!, url: req.url!, via: typeof via === "string" ? via : undefined, body })
      res.setHeader("content-type", "application/json")
      const read = /^\/api\/todos\/(\d+)$/.exec(req.url!)
      const answer = /^\/api\/todos\/(\d+)\/answer$/.exec(req.url!)
      const waits = todos[Number((read ?? answer)?.[1])]
      if (waits === undefined) {
        res.statusCode = 404
        res.end(JSON.stringify({ code: "todo_not_found", class: "user", message: "TODO not found" }))
        return
      }
      if (req.method === "GET" && read) {
        res.end(
          JSON.stringify({
            n: Number(read[1]),
            title: "T",
            state: "needs_you",
            waits: waits.filter((wait) => !answered.has(wait.id))
          })
        )
        return
      }
      if (req.method === "POST" && answer) {
        if (refusal) {
          res.statusCode = refusal.status
          res.end(JSON.stringify(refusal.body))
          return
        }
        const prior = answered.get(body.wait)
        if (prior !== undefined && prior !== body.answer) {
          res.statusCode = 409
          res.end(JSON.stringify({ code: "answered", class: "conflict", message: "ben answered", answered_by: "ben" }))
          return
        }
        answered.set(body.wait, body.answer)
        res.statusCode = 202
        res.end(JSON.stringify({ state: "accepted" }))
        return
      }
      res.statusCode = 405
      res.end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = await mkdtemp(join(tmpdir(), "todo-cli-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const base = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
  }
  await writeFile(
    base.SMITHERS_AUTH_FILE,
    JSON.stringify({ api_url: origin, host: "127.0.0.1", token: "terminal-token" }),
    { mode: 0o600 }
  )
  const run = async (args: Array<string>, extra: Record<string, string> = {}) => {
    const env = { ...base, ...extra }
    let output = "", code = 0
    const cli = makeCli({ environment: env, exit: (value) => void (code = value) })
    const previous = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = env.XDG_DATA_HOME
    try {
      await cli.serve([...args, "--json"], {
        env,
        stdout: (text) => void (output += text),
        exit: (value) => void (code = value)
      })
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previous
    }
    return { output, code }
  }
  return { seen, run }
}

describe("smthrs todo answer", () => {
  it("answers the one question the TODO asks, as the agent working in the terminal", async () => {
    const b = await backend({ 3: [{ id: "q-approval", kind: "approval" }, { id: "q-1", kind: "question" }] })
    const result = await b.run(["todo", "answer", "T3", "Use backoff"], { CLAUDECODE: "1" })
    expect(result.code, result.output).toBe(0)
    expect(JSON.parse(result.output)).toEqual({ todo: 3, wait: "q-1", state: "accepted" })
    expect(b.seen).toEqual([
      { method: "GET", url: "/api/todos/3", via: "claude-code", body: undefined },
      { method: "POST", url: "/api/todos/3/answer", via: "claude-code", body: { wait: "q-1", answer: "Use backoff" } }
    ])
  })

  it("answers the named question without reading the TODO, and names no agent outside one", async () => {
    const b = await backend({ 3: [{ id: "q-1", kind: "question" }, { id: "q-2", kind: "question" }] })
    const result = await b.run(["todo", "answer", "3", "Fixed delay", "--wait", "q-2"])
    expect(result.code, result.output).toBe(0)
    expect(b.seen).toEqual([{
      method: "POST",
      url: "/api/todos/3/answer",
      via: undefined,
      body: { wait: "q-2", answer: "Fixed delay" }
    }])
  })

  it("asks for --wait when the TODO asks several questions, and refuses one that asks nothing", async () => {
    const b = await backend({ 3: [{ id: "q-1", kind: "question" }, { id: "q-2", kind: "question" }], 4: [] })
    const several = await b.run(["todo", "answer", "3", "x"])
    expect(several.code).not.toBe(0)
    expect(several.output).toContain("T3 asks 2 questions; name one with --wait (q-1, q-2)")
    const none = await b.run(["todo", "answer", "4", "x"])
    expect(none.code).not.toBe(0)
    expect(none.output).toContain("T4 asks nothing")
    expect(b.seen.map((seen) => `${seen.method} ${seen.url}`)).toEqual(["GET /api/todos/3", "GET /api/todos/4"])
  })

  it("refuses a malformed TODO number or an empty answer before any request", async () => {
    const b = await backend({ 3: [{ id: "q-1", kind: "question" }] })
    for (
      const [todo, answer, message] of [["three", "x", "Expected a TODO number (3 or T3)"], [
        "T0",
        "x",
        "Expected a TODO number"
      ], ["3", "  ", "An answer is required"]]
    ) {
      const result = await b.run(["todo", "answer", todo!, answer!])
      expect(result.code).not.toBe(0)
      expect(result.output).toContain(message)
    }
    expect(b.seen).toEqual([])
  })

  it("surfaces the backend's refusal: another branch's TODO, or a question someone answered", async () => {
    const refused = await backend({ 3: [{ id: "q-1", kind: "question" }] }, {
      status: 403,
      body: { class: "permission", code: "permission", message: "A terminal acts only on its own branch's TODO" }
    })
    const result = await refused.run(["todo", "answer", "3", "x", "--wait", "q-1"])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("A terminal acts only on its own branch's TODO")
    const b = await backend({ 3: [{ id: "q-1", kind: "question" }] })
    expect((await b.run(["todo", "answer", "3", "first", "--wait", "q-1"])).code).toBe(0)
    const later = await b.run(["todo", "answer", "3", "second", "--wait", "q-1"])
    expect(later.code).not.toBe(0)
    expect(later.output).toContain("ben answered")
  })
})
