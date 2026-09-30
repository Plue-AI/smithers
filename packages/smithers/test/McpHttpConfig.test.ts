/**
 * `--mcp-config` Streamable HTTP entries, end to end: the flag's decoder, the
 * `bearerTokenEnv` credential source, and the shipped executor connecting a
 * real loopback MCP server through its guarded egress client.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Control } from "@smthrs/control"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import type * as McpClient from "@smthrs/mcp/McpClient"
import { Effect, Exit, Layer, Redacted } from "effect"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as CliError from "../src/CliError.ts"
import * as NodeControl from "../src/NodeControl.ts"

interface Hit {
  readonly method: string
  readonly rpc: string | undefined
  readonly authorization: string | undefined
  readonly session: string | undefined
}

const servers = new Set<Server>()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flows-cli-mcp-http-"))
})

afterEach(async () => {
  await Promise.all([...servers].map((server) =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  ))
  servers.clear()
  await rm(root, { recursive: true, force: true })
})

const bodyOf = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

/** A minimal Streamable HTTP MCP server on loopback that records every message. */
const listen = async () => {
  const hits: Array<Hit> = []
  const server = createServer((request, response) => {
    void (async () => {
      const text = await bodyOf(request)
      const body = text === "" ? undefined : JSON.parse(text) as Record<string, unknown>
      hits.push({
        method: request.method ?? "",
        rpc: typeof body?.method === "string" ? body.method : undefined,
        authorization: request.headers.authorization,
        session: request.headers["mcp-session-id"] as string | undefined
      })
      if (body === undefined || !Object.hasOwn(body, "id")) return void response.writeHead(202).end()
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "remote", version: "1" } }
        : body.method === "tools/list"
        ? { tools: [{ name: "ping", description: "Replies pong", inputSchema: { type: "object" } }] }
        : {}
      response.writeHead(200, {
        "content-type": "application/json",
        ...(body.method === "initialize" ? { "mcp-session-id": "session-1" } : {})
      })
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
    })()
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/mcp`, origin: `http://127.0.0.1:${port}`, hits }
}

const configFile = async (entries: ReadonlyArray<unknown>) => {
  const file = join(root, "servers.json")
  await writeFile(file, JSON.stringify(entries))
  return file
}

const usage = (file: string) =>
  new CliError.UsageError({ message: `--mcp-config ${file} must contain a JSON array of MCP server entries` })

/** Boots the shipped executor with `mcpServers` and plans one flow, which requires every server connected. */
const boot = (
  mcpServers: ReadonlyArray<McpClient.ConnectOptions>,
  grants?: Layer.Layer<GrantStore.GrantStore>
) => {
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const executor = NodeControl.layerExecutor(registry, engine, root, {
    evaluator: ScriptedJudge.layer,
    environment: {},
    mcpServers,
    ...(grants === undefined ? {} : { grants })
  })
  return Effect.runPromiseExit(
    Effect.gen(function*() {
      const control = yield* Control.Control
      return (yield* control.plan({ flowId: "system/test", input: {} })).flowId
    }).pipe(
      Effect.provide(Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>),
      Effect.scoped
    )
  )
}

describe("--mcp-config Streamable HTTP entries", () => {
  it("decodes a url entry and turns bearerTokenEnv into a redacted per-message credential", async () => {
    const file = await configFile([{
      server: "remote",
      url: "https://mcp.example.test/mcp",
      bearerTokenEnv: "REMOTE_MCP_TOKEN",
      requestTimeoutMs: 5,
      maxTools: 3,
      namePrefix: "remote"
    }])
    const [server] = NodeControl.makeConfig(["--mcp-config", file], { REMOTE_MCP_TOKEN: "secret-token" }, "/work")
      .mcpServers!
    const { authProvider, ...rest } = server as McpClient.HttpConnectOptions
    expect(rest).toEqual({
      server: "remote",
      url: "https://mcp.example.test/mcp",
      requestTimeoutMs: 5,
      maxTools: 3,
      namePrefix: "remote"
    })
    const token = await Effect.runPromise(authProvider!.token)
    expect(Redacted.value(token)).toBe("secret-token")
    expect(String(token)).not.toContain("secret-token")
  })

  it("decodes a url entry without a credential source as needing none", async () => {
    const file = await configFile([{ server: "open", url: "http://127.0.0.1:9/mcp" }])
    expect(NodeControl.makeConfig([], { SMITHERS_MCP_CONFIG: file }, "/work").mcpServers)
      .toEqual([{ server: "open", url: "http://127.0.0.1:9/mcp" }])
  })

  it("keeps stdio and HTTP entries side by side in file order", async () => {
    const stdio = { server: "local", command: "local-mcp", args: [] }
    const file = await configFile([stdio, { server: "remote", url: "https://mcp.example.test/" }])
    expect(NodeControl.makeConfig(["--mcp-config", file], {}, "/work").mcpServers)
      .toEqual([stdio, { server: "remote", url: "https://mcp.example.test/" }])
  })

  it("refuses an unset or empty credential variable by name, never echoing a value", async () => {
    const file = await configFile([{ server: "remote", url: "https://mcp.example.test/", bearerTokenEnv: "REMOTE_MCP_TOKEN" }])
    const error = new CliError.UsageError({
      message: `--mcp-config ${file}: server "remote" needs REMOTE_MCP_TOKEN set to its bearer token`
    })
    expect(() => NodeControl.makeConfig(["--mcp-config", file], {}, "/work")).toThrow(error)
    expect(() => NodeControl.makeConfig(["--mcp-config", file], { REMOTE_MCP_TOKEN: "" }, "/work")).toThrow(error)
  })

  it.each([
    { url: "" },
    { url: "mcp.example.test/mcp" },
    { url: "ftp://mcp.example.test/mcp" },
    { url: "file:///etc/passwd" },
    { url: "https://user:secret@mcp.example.test/mcp" },
    { url: "https://token@mcp.example.test/mcp" },
    { server: "" },
    { bearerTokenEnv: "" },
    { bearerTokenEnv: "NOT-A-NAME" },
    { bearerTokenEnv: "1TOKEN" },
    { requestTimeoutMs: 0 },
    { maxFrameBytes: 1.5 },
    { maxCatalogPages: -1 },
    { command: "local-mcp", args: [] }
  ])("rejects an invalid HTTP entry at flag parse time: %o", async (overrides) => {
    const file = await configFile([{ server: "remote", url: "https://mcp.example.test/mcp", ...overrides }])
    expect(() => NodeControl.makeConfig(["--mcp-config", file], { NOT: "used" }, "/work")).toThrow(usage(file))
  })

  it("rejects a stdio entry that also names a url", async () => {
    const file = await configFile([{ server: "local", command: "local-mcp", args: [], url: "https://mcp.example.test/" }])
    expect(() => NodeControl.makeConfig(["--mcp-config", file], {}, "/work")).toThrow(usage(file))
  })

  it("boots the executor against a loopback Streamable HTTP server, sending the bearer token", async () => {
    const remote = await listen()
    const file = await configFile([{ server: "remote", url: remote.url, bearerTokenEnv: "REMOTE_MCP_TOKEN" }])
    const { mcpServers } = NodeControl.makeConfig(["--mcp-config", file], { REMOTE_MCP_TOKEN: "loopback-token" }, root)
    const exit = await boot(mcpServers!)
    expect(exit).toEqual(Exit.succeed("system/test"))
    const posts = remote.hits.filter((hit) => hit.method === "POST")
    expect(posts.map((hit) => hit.rpc)).toEqual(["initialize", "notifications/initialized", "tools/list"])
    expect(posts.every((hit) => hit.authorization === "Bearer loopback-token")).toBe(true)
    expect(posts.slice(1).every((hit) => hit.session === "session-1")).toBe(true)
  })

  it("fails the executor loudly, before any request, when the egress grants deny the server's host", async () => {
    const remote = await listen()
    const file = await configFile([{ server: "remote", url: remote.url }])
    const { mcpServers } = NodeControl.makeConfig(["--mcp-config", file], {}, root)
    const grants = GrantStore.layer({
      attended: false,
      rules: [
        new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "*", resource: "*" }) }),
        new Rule({ effect: "deny", pattern: new CapabilityPattern({ action: "net:post", resource: remote.origin }) })
      ]
    }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
    const exit = await boot(mcpServers!, grants)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(remote.hits).toEqual([])
  })
})
