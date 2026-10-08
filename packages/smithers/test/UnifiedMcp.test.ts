import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

type Reply = {
  id?: number
  error?: unknown
  result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }>; isError?: boolean }
}

/** A real `smthrs --mcp` child in `root`, past its initialize handshake. */
const serve = async (root: string, environment: Record<string, string> = {}) => {
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--import",
    new URL("./fixtures/scripted-native-host.ts", import.meta.url).href,
    fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
    "--mcp"
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SMITHERS_REMOTE: "", ...environment }
  })
  let stderr = ""
  let buffer = ""
  let nextId = 0
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (cause: Error) => void }>()
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf("\n")
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line.trim() === "") continue
      const reply = JSON.parse(line) as Reply
      if (reply.id !== undefined) pending.get(reply.id)?.resolve(reply)
    }
  })
  child.once("error", (cause) => {
    for (const waiting of pending.values()) waiting.reject(cause)
  })
  const request = async (method: string, params: unknown) => {
    const id = ++nextId
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<Reply>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 90_000)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    try {
      const value = await reply
      expect(value.error, stderr).toBeUndefined()
      return value.result
    } finally {
      clearTimeout(timer)
      pending.delete(id)
    }
  }
  const stop = async () => {
    child.kill("SIGKILL")
    await exited
  }
  try {
    await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cli-test", version: "1" }
    })
  } catch (cause) {
    await stop()
    throw cause
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  const call = (name: string, args: unknown) => request("tools/call", { name, arguments: args })
  return { child, exited, request, call, stop, stderr: () => stderr }
}

type Listed = { name: string; annotations?: { readOnlyHint?: unknown } }

/** Every tool the server serves, paged through `search_tools` with an empty query. */
const servedTools = async (server: Awaited<ReturnType<typeof serve>>) => {
  const tools: Array<Listed> = []
  let offset: number | undefined = 0
  while (offset !== undefined) {
    const page = await server.call("search_tools", { query: "", limit: 20, offset })
    const document = JSON.parse(page?.content?.[0]?.text.split("\n\n")[0] ?? "{}") as {
      tools: Array<Listed>
      nextOffset?: number
    }
    tools.push(...document.tools)
    offset = document.nextOffset
  }
  return tools
}

/** Script only the remote install; command discovery and MCP dispatch run in a real CLI. */
const install = async () => {
  const seen: Array<
    {
      method: string | undefined
      path: string | undefined
      authorization: string | undefined
      body: unknown
      idempotency: string | undefined
    }
  > = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    seen.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : null,
      idempotency: request.headers["idempotency-key"] as string | undefined
    })
    response.setHeader("content-type", "application/json")
    if (request.method === "POST" && request.url === "/api/todos") {
      response.statusCode = 202
      response.end(JSON.stringify({ confirmation: "confirm-fixture", state: "pending" }))
    } else {
      response.end(JSON.stringify({ items: [{ name: "fixture" }] }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    seen,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
const hostEnvironment = (root: string, origin: string) => ({
  HOME: root,
  XDG_CONFIG_HOME: root,
  SMITHERS_AUTH_FILE: join(root, "auth.json"),
  SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
  SMITHERS_API_ORIGIN: origin,
  SMITHERS_TOKEN: "host-synthetic-credential"
})

it(
  "discovers canonical MCP tools, reads the install catalog, and exits cleanly on SIGTERM",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-unified-mcp-"))
    const host = await install()
    const server = await serve(root, hostEnvironment(root, host.origin))
    try {
      // The documented raw API CLI remains available; the UI-only playground
      // has no CLI alias and stays absent from MCP below.
      expect(await readFile(new URL("../../../apps/site/src/data/help/api.txt", import.meta.url), "utf8"))
        .toContain("Usage: smthrs api")
      const listed = await server.request("tools/list", {})
      expect(listed?.tools?.map((tool) => tool.name)).toContain("search_tools")
      for (
        const name of [
          "flows",
          "flow_show",
          "agent",
          "todo_show",
          "todo_stop",
          "todo_new"
        ]
      ) {
        const tool = await server.call("get_tool_details", { name })
        expect(tool?.isError, JSON.stringify(tool)).not.toBe(true)
        expect(tool?.content?.[0]?.text).toContain(`"name":"${name}"`)
      }
      for (
        const name of [
          "approvals_approve",
          "approvals_deny",
          "flow_start",
          "debug_api",
          "settings",
          "members",
          "secrets",
          "auth_status",
          "auth_token",
          "runs_fork",
          "runs_rewind"
        ]
      ) {
        const details = await server.call("get_tool_details", { name })
        expect(details?.isError, `${name}: ${JSON.stringify(details)}`).toBe(true)
        const refused = await server.call("call_write_tool", { name, arguments: {} })
        expect(refused?.isError, JSON.stringify(refused)).toBe(true)
      }
      expect(host.seen).toEqual([])
      expect(await readdir(root)).toEqual([])
      const catalog = await server.call("call_read_tool", { name: "flows", arguments: {} })
      expect(catalog?.isError, JSON.stringify(catalog)).not.toBe(true)
      expect(catalog?.content?.[0]?.text).toContain("fixture")
      expect(host.seen).toEqual([{
        method: "GET",
        path: "/api/flows",
        authorization: "token host-synthetic-credential",
        body: null,
        idempotency: undefined
      }])
      server.child.kill("SIGTERM")
      expect(await server.exited, server.stderr()).toBe(143)
    } finally {
      await server.stop()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)

/** An unclassified tool forces reads through the write wrapper. Check the entire served set. */
it(
  "classifies every served tool and routes catalog reads and writes through their respective wrappers",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-unified-mcp-read-"))
    const host = await install()
    const server = await serve(root, hostEnvironment(root, host.origin))
    try {
      const tools = await servedTools(server)
      expect(tools.length).toBeGreaterThan(50)
      expect(tools.filter((tool) => typeof tool.annotations?.readOnlyHint !== "boolean").map((tool) => tool.name))
        .toEqual([])
      const readOnly = new Set(tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name))
      for (
        const name of [
          "flows",
          "flow_show",
          "todo_show",
          "branch_show",
          "runs_list",
          "runs_show"
        ]
      ) {
        expect(readOnly.has(name), name).toBe(true)
      }
      const names = new Set(tools.map((tool) => tool.name))
      for (
        const name of [
          "flow_plan",
          "flow_run",
          "flow_edit",
          "todo_stop",
          "todo_new",
          "todo_amend",
          "branch_rebase"
        ]
      ) {
        expect(names.has(name), name).toBe(true)
        expect(readOnly.has(name), name).toBe(false)
        const refused = await server.call("call_read_tool", { name, arguments: {} })
        expect(refused?.isError, `${name}: ${JSON.stringify(refused)}`).toBe(true)
      }
      for (const name of readOnly) {
        const refused = await server.call("call_write_tool", { name, arguments: {} })
        expect(refused?.content?.[0]?.text, name).toContain(`Tool is read-only: ${name}`)
      }
      expect(host.seen).toEqual([])
      for (
        const [name, args] of [["flows", {}], ["flow_show", { flow: "team/todo" }], ["todo_show", { n: "T2" }], ["agent", { name: "reviewer" }]] as const
      ) {
        const result = await server.call("call_read_tool", { name, arguments: args })
        expect(result?.isError, JSON.stringify(result)).not.toBe(true)
        expect(result?.content?.[0]?.text).toContain("fixture")
      }
      const stopped = await server.call("call_write_tool", { name: "todo_stop", arguments: { n: "T2" } })
      expect(stopped?.isError, JSON.stringify(stopped)).not.toBe(true)
      const pending = await server.call("call_write_tool", {
        name: "todo_new",
        arguments: { text: "Fix it", idempotencyKey: "request-fixture" }
      })
      expect(pending?.content?.[0]?.text).toContain("confirm-fixture")
      expect(pending?.content?.[0]?.text).toContain("Waiting for you to confirm")
      expect(host.seen.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
        { method: "GET", path: "/api/flows", body: null },
        { method: "GET", path: "/api/flows/team%2Ftodo", body: null },
        { method: "GET", path: "/api/todos/2", body: null },
        { method: "GET", path: "/api/agents/reviewer", body: null },
        { method: "POST", path: "/api/todos/2", body: { op: "stop" } },
        { method: "POST", path: "/api/todos", body: { prompt: "Fix it", place: { mode: "append" } } }
      ])
      expect(host.seen.every((request) => request.authorization === "token host-synthetic-credential")).toBe(true)
      expect(host.seen[4]!.idempotency).toBeTruthy()
      expect(host.seen[5]!.idempotency).toBe("request-fixture")
      expect(await readdir(root)).toEqual([])
    } finally {
      await server.stop()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)

/** MCP callers cannot redirect the host's credential through command options or path input. */
it(
  "never sends the host's backend login to a caller-selected server over MCP",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-unified-mcp-auth-"))
    const host = await install(), attacker = await install()
    const server = await serve(root, hostEnvironment(root, host.origin))
    try {
      for (const flag of ["hostname", "host", "apiUrl", "origin"]) {
        const result = await server.call("call_read_tool", { name: "flows", arguments: { [flag]: attacker.origin } })
        expect(result?.isError, JSON.stringify(result)).not.toBe(true)
        expect(result?.content?.[0]?.text).toContain("fixture")
        expect(result?.content?.[0]?.text).not.toContain("host-synthetic-credential")
      }
      const result = await server.call("call_read_tool", { name: "flow_show", arguments: { flow: attacker.origin } })
      expect(result?.isError, JSON.stringify(result)).not.toBe(true)
      expect(result?.content?.[0]?.text).toContain("fixture")
      expect(result?.content?.[0]?.text).not.toContain("host-synthetic-credential")
      expect(attacker.seen).toEqual([])
      expect(host.seen).toHaveLength(5)
      expect(
        host.seen.every((request) =>
          request.method === "GET" && request.authorization === "token host-synthetic-credential"
        )
      ).toBe(true)
      expect(host.seen.at(-1)?.path).toBe(`/api/flows/${encodeURIComponent(attacker.origin)}`)
      expect(host.seen.slice(0, -1).every((request) => request.path === "/api/flows")).toBe(true)
    } finally {
      await server.stop()
      await host.close()
      await attacker.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)
