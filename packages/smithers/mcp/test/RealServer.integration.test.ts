/**
 * Integration coverage against a real, separately-processed MCP server.
 *
 * The fixture is the shared `node -e` server in `fixtures/FixtureServer.ts`.
 * It keeps the OS process boundary and real stdio timing while remaining
 * deterministic and offline, and exposes modes for protocol and lifecycle
 * failures that an in-memory process handle cannot faithfully reproduce.
 *
 * @since 0.1.0
 */
import { NodeServices } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Deferred, Effect, Fiber, Redacted, Schema, Sink, Stream } from "effect"
import { ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as Diagnostics from "../src/Diagnostics.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import * as McpClient from "../src/McpClient.ts"
import { McpError } from "../src/McpError.ts"
import * as McpFlows from "../src/McpFlows.ts"
import { fakeHandle } from "./fixtures/FakeProcess.ts"
import * as FixtureServer from "./fixtures/FixtureServer.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const connectNode = (
  mode = "normal",
  extraArgs: ReadonlyArray<string> = [],
  overrides: Partial<McpClient.StdioConnectOptions> = {}
) =>
  Effect.provide(
    McpClient.connect({
      server: mode,
      command: process.execPath,
      args: ["-e", FixtureServer.source, mode, ...extraArgs],
      ...overrides
    }),
    NodeServices.layer
  )

const connectTransportNode = (
  mode: string,
  overrides: Partial<StdioTransport.ConnectOptions> = {}
) =>
  Effect.provide(
    StdioTransport.connect({
      server: mode,
      command: process.execPath,
      args: ["-e", FixtureServer.source, mode],
      ...overrides
    }),
    NodeServices.layer
  )

describe("McpClient against a real MCP server", () => {
  it("answers server requests during an active tool call without confusing directional ids", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("server-requests", [], { requestTimeoutMs: 2_000 })
      return yield* client.callTool("add", { a: 2, b: 3 })
    })))
    expect(result.structuredContent).toEqual({
      replies: [
        { jsonrpc: "2.0", id: 3, result: {} },
        { jsonrpc: "2.0", id: "3", result: {} },
        { jsonrpc: "2.0", id: "probe/😀", result: {} },
        { jsonrpc: "2.0", id: "", result: {} },
        { jsonrpc: "2.0", id: "unsupported", error: { code: -32601, message: "Method not found" } }
      ]
    })
  })

  it("completes the handshake, ignores unrelated frames, and lists tools", async () => {
    const client = await execute(Effect.scoped(connectNode("malformed-frames")))
    expect(client.tools).toEqual([
      {
        name: "add",
        description: "Adds two numbers",
        inputSchema: { type: "object", properties: { a: {}, b: {} } },
        outputSchema: undefined
      },
      {
        name: "error",
        description: undefined,
        inputSchema: { type: "object" },
        outputSchema: undefined
      }
    ])
  })

  it("closes when a JSON-RPC-tagged reply carries the wrong version", async () => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode("wrong-jsonrpc-version"))))
    expect(error).toMatchObject({
      code: "protocol_error",
      server: "wrong-jsonrpc-version",
      message:
        "MCP server \"wrong-jsonrpc-version\" sent a malformed JSON-RPC reply: a JSON-RPC message must carry jsonrpc \"2.0\""
    })
  })

  it("closes when a JSON-RPC reply carries no id", async () => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode("reply-without-id"))))
    expect(error).toMatchObject({
      code: "protocol_error",
      server: "reply-without-id",
      message: "MCP server \"reply-without-id\" sent a malformed JSON-RPC reply: a reply carried no id"
    })
  })

  it("calls tools and preserves ordinary MCP isError outcomes", async () => {
    const results = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode()
      const added = yield* client.callTool("add", { a: 2, b: 3 })
      const failed = yield* client.callTool("error", {})
      return { added, failed }
    })))
    expect(results.added).toEqual({
      content: [{ type: "text", text: "5" }],
      isError: false,
      structuredContent: undefined
    })
    expect(results.failed).toEqual({ content: [], isError: true, structuredContent: undefined })
  })

  it("maps a JSON-RPC error response to tool_failed", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("call-rpc-error")
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({
      code: "tool_failed",
      message: "MCP server \"call-rpc-error\" failed tools/call (-32000); remote details withheld",
      server: "call-rpc-error"
    })
  })

  it.each([
    ["call-invalid-params-unknown-tool", -32_602],
    ["call-method-not-found-unknown-tool", -32_601]
  ])("maps a remote unknown-tool rejection in %s mode to tool_not_found", async (mode, code) => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode(mode)
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({ code: "tool_not_found", server: mode })
    if (mode === "call-invalid-params-unknown-tool") {
      expect(error.message).toBe(`MCP server "${mode}" failed tools/call (${code}); remote details withheld`)
    }
  })

  it("keeps an ordinary invalid-arguments rejection as tool_failed", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("call-invalid-params")
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({
      code: "tool_failed",
      server: "call-invalid-params",
      message: "MCP server \"call-invalid-params\" failed tools/call (-32602); remote details withheld"
    })
  })

  it.each([
    ["list-not-array", "MCP server \"list-not-array\" returned a tools/list result with no tools array"],
    [
      "list-result-not-object",
      "MCP server \"list-result-not-object\" returned a tools/list result with no tools array"
    ],
    ["list-no-name", "MCP server \"list-no-name\" returned tools[0] with no name"],
    ["list-empty-name", "MCP server \"list-empty-name\" returned tools[0] with no name"],
    ["list-null-entry", "MCP server \"list-null-entry\" returned tools[1], which is not an object"],
    ["list-number-entry", "MCP server \"list-number-entry\" returned tools[1], which is not an object"],
    ["list-array-entry", "MCP server \"list-array-entry\" returned tools[1], which is not an object"],
    ["list-duplicate-names", "MCP server \"list-duplicate-names\" returned a duplicate tool name at catalog index 1"]
  ])("rejects a malformed catalog in %s mode", async (mode, message) => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode(mode))))
    expect(error).toMatchObject({ code: "invalid_response", message, server: mode })
  })

  it.each([
    [
      "malformed-initialize-result",
      "MCP server \"malformed-initialize-result\" returned a malformed initialize result: result is not an object"
    ],
    [
      "malformed-protocol-version",
      "MCP server \"malformed-protocol-version\" returned a malformed initialize result: protocolVersion is not a string"
    ],
    [
      "malformed-capabilities",
      "MCP server \"malformed-capabilities\" returned a malformed initialize result: capabilities is not an object"
    ],
    [
      "no-tools-capability",
      "MCP server \"no-tools-capability\" does not serve tools: its initialize result declares no tools capability"
    ],
    [
      "wrong-protocol-version",
      "MCP server \"wrong-protocol-version\" speaks an unsupported protocol version; this client speaks 2025-06-18, 2025-03-26, 2024-11-05"
    ]
  ])("rejects the invalid initialize result in %s mode", async (mode, message) => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode(mode))))
    expect(error).toMatchObject({ code: "protocol_error", server: mode, message })
  })

  it("accepts an older supported protocol revision", async () => {
    const client = await execute(Effect.scoped(connectNode("older-protocol-version")))
    expect(client.tools.map((tool) => tool.name)).toEqual(["add", "error"])
  })

  it("inherits only bootstrap variables while merging configured environment values", async () => {
    const inherited = {
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
      GH_TOKEN: process.env["GH_TOKEN"],
      OPENAI_API_KEY: process.env["OPENAI_API_KEY"]
    }
    process.env["ANTHROPIC_API_KEY"] = "ambient-anthropic"
    process.env["GH_TOKEN"] = "ambient-github"
    process.env["OPENAI_API_KEY"] = "ambient-openai"
    try {
      const result = await execute(Effect.scoped(Effect.gen(function*() {
        const client = yield* connectNode("echo-env", [], {
          env: { MCP_FIXTURE_TOKEN: "fixture-token" }
        })
        return yield* client.callTool("add", {})
      })))
      expect(result.content).toEqual([expect.objectContaining({
        token: "fixture-token",
        hasPath: true
      })])
      expect(result.content[0]).not.toHaveProperty("anthropic")
      expect(result.content[0]).not.toHaveProperty("openai")
      expect(result.content[0]).not.toHaveProperty("github")
    } finally {
      for (const [name, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it("starts the child in the configured working directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-mcp-cwd-"))
    try {
      const result = await execute(Effect.scoped(Effect.gen(function*() {
        const client = yield* connectNode("echo-env", [], { cwd: directory })
        return yield* client.callTool("add", {})
      })))
      const block = result.content[0] as { readonly cwd: string }
      expect(realpathSync(block.cwd)).toBe(realpathSync(directory))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("maps a tools/list JSON-RPC error to protocol_error", async () => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode("list-rpc-error"))))
    expect(error).toMatchObject({
      code: "protocol_error",
      server: "list-rpc-error",
      message: "MCP server \"list-rpc-error\" failed tools/list (-32601); remote details withheld"
    })
  })

  it.each([
    "call-rpc-error-string-data",
    "call-rpc-error-number-data",
    "call-rpc-error-boolean-data"
  ])("withholds even short scalar error data in %s mode", async (mode) => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode(mode)
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error.message).toBe(`MCP server "${mode}" failed tools/call (-32000); remote details withheld`)
  })

  it.each([
    "call-rpc-error-long-data",
    "call-rpc-error-object-data",
    "call-rpc-error-array-data"
  ])("does not append unsafe error data in %s mode", async (mode) => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode(mode)
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error.message).toBe(`MCP server "${mode}" failed tools/call (-32000); remote details withheld`)
  })

  it("closes the connection on a malformed JSON-RPC reply", async () => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode("malformed-reply"))))
    expect(error).toMatchObject({
      code: "protocol_error",
      server: "malformed-reply",
      message:
        "MCP server \"malformed-reply\" sent a malformed JSON-RPC reply: a reply carried a malformed error object"
    })
  })

  it("correlates a reply whose id is a canonical digit string", async () => {
    const client = await execute(Effect.scoped(connectNode("string-reply-id")))
    expect(client.tools.map((tool) => tool.name)).toEqual(["add", "error"])
  })

  it.each([
    [
      "call-result-not-object",
      "MCP server \"call-result-not-object\" returned a tools/call result that is not an object"
    ],
    [
      "call-content-not-array",
      "MCP server \"call-content-not-array\" returned a tools/call result with no content array"
    ],
    [
      "call-content-bad-entry",
      "MCP server \"call-content-bad-entry\" returned a tools/call result whose content[1] is not an object"
    ],
    [
      "call-content-string-entry",
      "MCP server \"call-content-string-entry\" returned a tools/call result whose content[0] is not an object"
    ],
    [
      "call-content-number-entry",
      "MCP server \"call-content-number-entry\" returned a tools/call result whose content[0] is not an object"
    ],
    [
      "call-content-array-entry",
      "MCP server \"call-content-array-entry\" returned a tools/call result whose content[0] is not an object"
    ],
    [
      "call-is-error-not-boolean",
      "MCP server \"call-is-error-not-boolean\" returned a tools/call result whose isError is not a boolean"
    ],
    [
      "call-structured-content-not-object",
      "MCP server \"call-structured-content-not-object\" returned a tools/call result whose structuredContent is not a JSON object"
    ]
  ])("rejects a malformed tools/call result in %s mode", async (mode, message) => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode(mode)
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({ code: "invalid_response", server: mode, message })
  })

  it("preserves structured tool output", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("call-structured-content")
      return yield* client.callTool("add", {})
    })))
    expect(result.structuredContent).toEqual({ sum: 5 })
  })

  it("validates and preserves structured output through the McpFlows result schema", async () => {
    const { client, result } = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-valid")
      const result = yield* client.callTool("add", {})
      return { client, result }
    })))

    expect(client.tools[0]?.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"]
    })
    expect(Schema.decodeUnknownSync(McpFlows.Result)(result)).toEqual({
      content: [{ type: "text", text: "5" }],
      isError: false,
      structuredContent: { answer: 5 }
    })
  })

  it("rejects a structured property type without exposing its path", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-invalid-type")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      server: "structured-invalid-type",
      message:
        "MCP server \"structured-invalid-type\" returned structuredContent that its own outputSchema rejects: expected number; property path withheld"
    })
  })

  it("rejects structured output that omits a required property", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-missing-required")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      message:
        "MCP server \"structured-missing-required\" returned structuredContent that its own outputSchema rejects: required property is missing; property path withheld"
    })
  })

  it("rejects structured output outside a declared enum", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-enum-invalid")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      message:
        "MCP server \"structured-enum-invalid\" returned structuredContent that its own outputSchema rejects: expected a declared enum value; property path withheld"
    })
  })

  it("rejects an invalid structured array element without exposing its path", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-array-invalid")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      message:
        "MCP server \"structured-array-invalid\" returned structuredContent that its own outputSchema rejects: expected number; property path withheld"
    })
  })

  it("ignores unsupported outputSchema keywords", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-unsupported-keyword")
      return yield* client.callTool("add", {})
    })))

    expect(result.structuredContent).toEqual({ answer: "x" })
  })

  it("accepts arbitrary structured output when the tool declared no outputSchema", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-no-output-schema")
      return yield* client.callTool("add", {})
    })))

    expect(result.structuredContent).toEqual({ arbitrary: ["accepted"] })
  })

  it("accepts a structured-only tools/call result with empty content", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-only")
      return yield* client.callTool("add", {})
    })))

    expect(result).toEqual({ content: [], isError: false, structuredContent: { answer: 5 } })
  })

  it("still rejects a tools/call result with neither content nor structuredContent", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-neither")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      message: "MCP server \"structured-neither\" returned a tools/call result with no content array"
    })
  })

  it.each([
    ["list-two-pages", ["add", "error"]],
    ["list-three-pages", ["add", "error", "third"]],
    ["list-empty-middle-page", ["add", "error"]]
  ])("walks every tools/list page in %s mode", async (mode, names) => {
    const client = await execute(Effect.scoped(connectNode(mode)))
    expect(client.tools.map((tool) => tool.name)).toEqual(names)
  })

  it.each([
    ["list-repeated-cursor", "MCP server \"list-repeated-cursor\" repeated a tools/list cursor"],
    [
      "list-bad-cursor",
      "MCP server \"list-bad-cursor\" returned a tools/list cursor that is not a non-empty string"
    ],
    [
      "list-empty-cursor",
      "MCP server \"list-empty-cursor\" returned a tools/list cursor that is not a non-empty string"
    ],
    [
      "list-duplicate-across-pages",
      "MCP server \"list-duplicate-across-pages\" returned a duplicate tool name at catalog index 0"
    ]
  ])("rejects an invalid paginated catalog in %s mode", async (mode, message) => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode(mode))))
    expect(error).toMatchObject({ code: "invalid_response", server: mode, message })
  })

  it("caps the number of tools/list pages", async () => {
    const error = await execute(Effect.scoped(Effect.flip(
      connectNode("list-unbounded-pages", [], { maxCatalogPages: 2 })
    )))
    expect(error).toMatchObject({
      code: "invalid_response",
      server: "list-unbounded-pages",
      message: "MCP server \"list-unbounded-pages\" returned more than 2 tools/list pages"
    })
  })

  it("reports spawn failures", async () => {
    const error = await execute(Effect.scoped(Effect.flip(Effect.provide(
      McpClient.connect({ server: "missing", command: "flows-command-that-does-not-exist", args: [] }),
      NodeServices.layer
    ))))
    expect(error).toMatchObject({ code: "spawn_failed", server: "missing" })
  })

  it("keeps a startup stderr diagnostic out of the ordinary error", async () => {
    const error = await execute(Effect.scoped(Effect.flip(
      connectNode("stderr-exit", [], { handshakeTimeoutMs: McpClient.defaultHandshakeTimeoutMs })
    )))

    expect(error.code).toBe("connection_closed")
    expect(error.server).toBe("stderr-exit")
    expect(error.message).toMatch(
      /^MCP server "stderr-exit" (?:stdout closed|stdin closed|exited with code 17) \(stderr diagnostic withheld\)$/
    )
  })

  it("redacts credentials split across stderr chunks on a handshake timeout", async () => {
    const diagnostics: Array<Diagnostics.Event> = []
    const error = await execute(
      Effect.scoped(Effect.flip(
        connectNode("stderr-timeout", [], { handshakeTimeoutMs: 1_000 })
      )).pipe(Effect.provide(Diagnostics.layer((event) => diagnostics.push(event))))
    )
    expect(error.code).toBe("timeout")
    expect(error.message).toContain("stderr diagnostic withheld")
    const detail = Redacted.value(diagnostics.find((event) => event.source === "stderr")!.detail)
    expect(detail).toContain("ordinary timeout diagnostic token=[REDACTED]")
    expect(detail).not.toContain("sk-ant-")
    expect(detail).not.toContain("0123456789abcdef")
    expect(error.message).not.toContain("ordinary timeout diagnostic")
  })

  it("caps diagnostics after redaction expands a short credential", async () => {
    const diagnostics: Array<Diagnostics.Event> = []
    const error = await execute(
      Effect.scoped(Effect.flip(
        connectNode("stderr-short-exit", [], {
          handshakeTimeoutMs: McpClient.defaultHandshakeTimeoutMs,
          maxStderrBytes: 7
        })
      )).pipe(Effect.provide(Diagnostics.layer((event) => diagnostics.push(event))))
    )
    expect(error.message).toContain("stderr diagnostic withheld")
    const detail = Redacted.value(diagnostics.find((event) => event.source === "stderr")!.detail)
    expect(detail).toBe("DACTED]")
    expect(detail).not.toContain("x")
    expect(new TextEncoder().encode(detail).byteLength).toBe(7)
  })

  it("keeps only the configured tail of a large stderr diagnostic", async () => {
    const diagnostics: Array<Diagnostics.Event> = []
    const error = await execute(
      Effect.scoped(Effect.flip(
        connectNode("stderr-tail-exit", [], {
          handshakeTimeoutMs: McpClient.defaultHandshakeTimeoutMs,
          maxStderrBytes: 26
        })
      )).pipe(Effect.provide(Diagnostics.layer((event) => diagnostics.push(event))))
    )

    expect(error.code).toBe("connection_closed")
    expect(error.server).toBe("stderr-tail-exit")
    expect(error.message).toMatch(
      /^MCP server "stderr-tail-exit" (?:stdout closed|stdin closed|exited with code 18) \(stderr diagnostic withheld\)$/
    )
    const detail = diagnostics.find((event) => event.source === "stderr")!
    expect(Redacted.value(detail.detail)).toBe("KEEP-THIS-TAIL-1234567890")
    expect(JSON.stringify(diagnostics)).not.toContain("KEEP-THIS")
    expect(error.message.length).toBeLessThanOrEqual(100)
  })

  it("fails a pending call when the server exits", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("exit-mid-call")
      return yield* Effect.flip(client.callTool("add", { a: 1, b: 2 }).pipe(Effect.timeout("2 seconds")))
    })))
    expect(error).toMatchObject({ code: "connection_closed", server: "exit-mid-call" })
  })

  it("fails every request immediately after the server has exited", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("exit-after-list")
      yield* Effect.sleep("100 millis")
      const first = yield* Effect.flip(client.callTool("add", {}).pipe(Effect.timeout("1 second")))
      const second = yield* Effect.flip(client.callTool("add", {}).pipe(Effect.timeout("1 second")))
      return [first, second]
    })))
    expect(errors).toEqual([
      expect.objectContaining({ code: "connection_closed", server: "exit-after-list" }),
      expect.objectContaining({ code: "connection_closed", server: "exit-after-list" })
    ])
  })

  it("fails a pending call when the server closes stdin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-mcp-stdin-"))
    const marker = join(directory, "closed")
    try {
      const errors = await execute(Effect.scoped(Effect.gen(function*() {
        const client = yield* connectNode(
          "close-stdin",
          [marker],
          process.platform === "win32"
            ? {
              command: join(
                process.env.SystemRoot ?? "C:\\Windows",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe"
              ),
              args: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(FixtureServer.windowsCloseStdinSource, "utf16le").toString("base64")
              ],
              env: {
                ...Object.fromEntries(
                  Object.entries(process.env).filter(([name, value]) =>
                    value !== undefined && /^(SystemRoot|TEMP|TMP|USERPROFILE)$/i.test(name)
                  )
                ),
                MCP_CLOSE_STDIN_MARKER: marker
              },
              handshakeTimeoutMs: 15_000
            }
            : {}
        )
        const pending = yield* Effect.forkChild(
          Effect.flip(client.callTool("add", { a: 1, b: 2 }).pipe(Effect.timeout("5 seconds"))),
          { startImmediately: true }
        )
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            const receipt = JSON.parse(readFileSync(marker, "utf8")) as {
              method: string
              requestId: number
              pid: number
            }
            expect(receipt).toMatchObject({ method: "tools/call", requestId: 3 })
            expect(Number.isSafeInteger(receipt.pid) && receipt.pid > 1).toBe(true)
            // The fixture remains alive after closing stdin.
            expect(process.kill(receipt.pid, 0)).toBe(true)
          }, { timeout: 2_000 })
        )
        const next = yield* Effect.flip(client.callTool("add", {}).pipe(Effect.timeout("2 seconds")))
        const first = yield* Fiber.join(pending)
        const later = yield* Effect.flip(client.callTool("add", {}).pipe(Effect.timeout("2 seconds")))
        return { first, next, later }
      })))
      expect(errors.first).toMatchObject({
        code: "connection_closed",
        server: "close-stdin",
        message: "MCP server \"close-stdin\" stdin closed"
      })
      expect(errors.next).toBe(errors.first)
      expect(errors.later).toBe(errors.first)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("applies the configured request deadline", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("hang", [], { requestTimeoutMs: 50 })
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({
      code: "timeout",
      server: "hang",
      message: "MCP server \"hang\" did not answer tools/call within 50ms"
    })
    expect(error.message).not.toContain(" (stderr:")
  })

  it("delivers one cancellation to a real server after tools/call times out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-mcp-cancel-"))
    const marker = join(directory, "cancelled.ndjson")
    try {
      const error = await execute(Effect.scoped(Effect.gen(function*() {
        const client = yield* connectNode("capture-cancellation", [marker], { requestTimeoutMs: 50 })
        const failure = yield* Effect.flip(client.callTool("add", { private: "never-forward" }))
        yield* Effect.promise(() => vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 2_000 }))
        return failure
      })))
      const frames = readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown)

      expect(error).toMatchObject({
        code: "timeout",
        server: "capture-cancellation",
        message: "MCP server \"capture-cancellation\" did not answer tools/call within 50ms"
      })
      expect(frames).toEqual([{
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 3, reason: "request no longer awaited" }
      }])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("applies the configured handshake deadline", async () => {
    const error = await execute(Effect.scoped(Effect.flip(
      connectNode("hang-handshake", [], { handshakeTimeoutMs: 50 })
    )))
    expect(error).toMatchObject({ code: "timeout", server: "hang-handshake" })
  })

  it("uses the per-notification deadline when initialized is blocked behind a stopped reader", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const transport = yield* connectTransportNode("stop-reading-after-initialize", {
        queueCapacity: 1,
        requestTimeoutMs: 5_000
      })
      yield* transport.request("initialize", {}, 500)
      yield* transport.notify("fill-pipe", { value: "x".repeat(900_000) }, 1_000)
      yield* transport.notify("queued-behind-fill", {}, 1_000)
      const failure = yield* Effect.flip(transport.notify("notifications/initialized", undefined, 50))
      yield* Effect.sleep("500 millis")
      return failure
    })))

    expect(error).toMatchObject({
      code: "timeout",
      server: "stop-reading-after-initialize",
      message: "MCP server \"stop-reading-after-initialize\" did not answer notifications/initialized within 50ms"
    })
  })

  it("closes on an oversized inbound frame", async () => {
    const error = await execute(Effect.scoped(Effect.flip(
      connectNode("oversized-frame", [], { maxFrameBytes: 128 })
    )))
    expect(error).toMatchObject({ code: "protocol_error", server: "oversized-frame" })
  })

  it("tears the child process down when its scope closes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flows-mcp-scope-"))
    const marker = join(directory, "pid")
    try {
      const pid = await execute(Effect.scoped(Effect.gen(function*() {
        yield* connectNode("normal", [marker])
        const pid = Number(readFileSync(marker, "utf8"))
        expect(Number.isSafeInteger(pid) && pid > 1).toBe(true)
        expect(process.kill(pid, 0)).toBe(true)
        return pid
      })))
      // Windows termination does not deliver SIGTERM to a JavaScript handler.
      // Ask the OS whether the actual child is gone on every platform.
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      }, { timeout: 2_000 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("connects and projects tools through McpFlows.connected", async () => {
    const source = await execute(Effect.scoped(Effect.provide(
      McpFlows.connected({
        server: "connected",
        command: process.execPath,
        args: ["-e", FixtureServer.source, "normal"]
      }),
      NodeServices.layer
    )))
    const bindings = await execute(source.bindings())
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual([
      "mcp/connected/add",
      "mcp/connected/error"
    ])
  })
})

// A real pipe may coalesce writes. This process handle delivers the exact byte
// chunks to the production stdout reader, only after the request is dispatched.
const chunkedReply = (chunks: ReadonlyArray<Uint8Array>, maxFrameBytes: number) =>
  Effect.scoped(Effect.gen(function*() {
    const written = yield* Deferred.make<void>()
    const transport = yield* StdioTransport.connect({
      server: "chunked-stdout",
      command: "fixture",
      args: [],
      maxFrameBytes,
      requestTimeoutMs: 5_000
    }).pipe(Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.makeNoop({
        spawn: () =>
          Effect.succeed(fakeHandle({
            pid: ProcessId(1),
            stdin: Sink.forEach((_chunk: Uint8Array) => Deferred.succeed(written, undefined)),
            stdout: Stream.fromEffect(Deferred.await(written)).pipe(
              Stream.flatMap(() => Stream.fromIterable(chunks)),
              Stream.concat(Stream.never)
            )
          }))
      })
    ))
    return yield* transport.request("chunked")
  }))

describe("inbound byte frame boundaries", () => {
  const result = { content: [{ type: "text", text: "prefix-é-😀-suffix" }], isError: false }
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result })
  // Buffer.byteLength is independent of the transport's TextEncoder/Decoder.
  const bytes = Buffer.from(line, "utf8")
  const length = Buffer.byteLength(line, "utf8")
  const emoji = bytes.indexOf(Buffer.from("😀"))

  it.each([1, 0])("preserves a fragmented UTF-8 reply at limit minus %i", async (headroom) => {
    expect(length).toBeGreaterThan(line.length)
    const chunks = [
      bytes.subarray(0, emoji + 1),
      bytes.subarray(emoji + 1, emoji + 3),
      bytes.subarray(emoji + 3),
      Buffer.from("\n")
    ]
    expect(await execute(chunkedReply(chunks, length + headroom))).toEqual(result)
  })

  it("rejects limit plus one UTF-8 bytes before a newline arrives", async () => {
    const error = await execute(Effect.flip(chunkedReply([
      bytes.subarray(0, emoji + 2),
      bytes.subarray(emoji + 2)
    ], length - 1)))
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({
      code: "protocol_error",
      server: "chunked-stdout",
      message: `MCP frame exceeded ${length - 1} bytes`
    })
  })

  it.each([
    { label: "together", chunks: [Buffer.concat([bytes, Buffer.from("\r\n")])] },
    { label: "split after CR", chunks: [Buffer.concat([bytes, Buffer.from("\r")]), Buffer.from("\n")] },
    { label: "in three chunks", chunks: [bytes, Buffer.from("\r"), Buffer.from("\n")] }
  ])("accepts an exact-limit frame with CRLF $label", async ({ chunks }) => {
    expect(await execute(chunkedReply(chunks, length))).toEqual(result)
  })

  it("bounds encoding work for a 16 MiB frame in 64 KiB chunks", async () => {
    const largeResult = { text: "x".repeat(16 * 1024 * 1024 - 100) }
    const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: largeResult }) + "\n")
    const chunks: Array<Uint8Array> = []
    for (let offset = 0; offset < frame.byteLength; offset += 64 * 1024) {
      chunks.push(frame.subarray(offset, offset + 64 * 1024))
    }
    // Bound allocation work rather than wall time on a shared CI machine. The
    // old partial-frame re-encoding processes over 2 GiB for this single reply.
    let encodedBytes = 0
    const encode = TextEncoder.prototype.encode
    const spy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function(this: TextEncoder, input) {
      const encoded = encode.call(this, input)
      encodedBytes += encoded.byteLength
      return encoded
    })
    try {
      expect(await execute(chunkedReply(chunks, frame.byteLength - 1))).toEqual(largeResult)
      expect(encodedBytes).toBeLessThan(frame.byteLength * 2)
    } finally {
      spy.mockRestore()
    }
  })
})
