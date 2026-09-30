import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import * as Diagnostics from "../src/Diagnostics.ts"
import * as Rpc from "../src/internal/Rpc.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import * as Transport from "../src/internal/Transport.ts"
import * as McpClient from "../src/McpClient.ts"
import { McpError } from "../src/McpError.ts"
import { fakeServer, respondToEcho, respondWithStructured, TOOLS, withFakeServer } from "./fixtures/FakeServer.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const typedFailure = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) throw new Error("expected the effect to fail")
  expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false)
  const failure = exit.cause.reasons.find(Cause.isFailReason)
  if (failure === undefined) throw new Error("expected a typed failure")
  return failure.error
}

describe("McpClient.connect", () => {
  it("sends the frozen Smithers initialize payload using the package version", async () => {
    const requests: Array<Rpc.Outbound> = []
    await withFakeServer(
      (request) => {
        requests.push(request)
        return respondToEcho(request)
      },
      McpClient.connect({ server: "handshake", command: "echo-mcp", args: [] })
    )
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { readonly version: string }

    expect(McpClient.clientInfo).toEqual({ name: "smithers", version: manifest.version })
    expect(requests[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smithers", version: manifest.version }
      }
    })
  })

  it("freezes the exported wire identity constants", () => {
    expect(Object.isFrozen(McpClient.clientInfo)).toBe(true)
    expect(Object.isFrozen(McpClient.supportedProtocolVersions)).toBe(true)

    expect(() => {
      ;(McpClient.clientInfo as { name: string }).name = "mutated"
    }).toThrow(TypeError)
    expect(() => {
      ;(McpClient.supportedProtocolVersions as Array<string>)[0] = "mutated"
    }).toThrow(TypeError)

    expect(McpClient.clientInfo.name).toBe("smithers")
    expect(McpClient.supportedProtocolVersions[0]).toBe("2025-06-18")
  })

  it("completes the handshake and fetches the tool catalog", async () => {
    const client = await withFakeServer(
      respondToEcho,
      McpClient.connect({ server: "echo", command: "echo-mcp", args: [] })
    )
    expect(client.server).toBe("echo")
    expect(client.tools).toEqual([{
      name: "add",
      description: "Adds two numbers",
      inputSchema: TOOLS[0]!.inputSchema,
      outputSchema: undefined
    }])
  })

  it("calls a remote tool and decodes its result", async () => {
    const result = await withFakeServer(
      respondToEcho,
      Effect.flatMap(
        McpClient.connect({ server: "echo", command: "echo-mcp", args: [] }),
        (client) => client.callTool("add", { a: 2, b: 3 })
      )
    )
    expect(result).toEqual({
      content: [{ type: "text", text: "5" }],
      isError: false,
      structuredContent: undefined
    })
  })

  it("fails with invalid_response when tools/list is malformed", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const spawner = yield* fakeServer((request) =>
        request.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
          : { notTools: [] }
      )
      return yield* Effect.provide(
        Effect.flip(McpClient.connect({ server: "broken", command: "broken-mcp", args: [] })),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)
      )
    })))
    expect(error).toMatchObject({
      code: "invalid_response",
      server: "broken",
      message: "MCP server \"broken\" returned a tools/list result with no tools array"
    })
  })

  it("exports every documented default from the public client module", () => {
    expect(McpClient.defaultHandshakeTimeoutMs).toBe(10_000)
    expect(McpClient.defaultRequestTimeoutMs).toBe(Transport.defaultRequestTimeoutMs)
    expect(McpClient.defaultQueueCapacity).toBe(StdioTransport.defaultQueueCapacity)
    expect(McpClient.defaultMaxFrameBytes).toBe(Transport.defaultMaxFrameBytes)
    expect(McpClient.defaultMaxOutboundFrameBytes).toBe(Transport.defaultMaxOutboundFrameBytes)
    expect(McpClient.defaultMaxStderrBytes).toBe(StdioTransport.defaultMaxStderrBytes)
    expect(McpClient.defaultMaxTools).toBe(256)
    expect(McpClient.defaultMaxToolNameBytes).toBe(128)
    expect(McpClient.defaultMaxToolDocumentBytes).toBe(65_536)
    expect(McpClient.defaultMaxCatalogPages).toBe(32)
  })

  it("preserves tool outputSchema objects", async () => {
    const client = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") {
          return {
            tools: [{
              name: "typed",
              inputSchema: { type: "object" },
              outputSchema: { type: "object", properties: { answer: { type: "number" } } }
            }]
          }
        }
        return undefined
      },
      McpClient.connect({ server: "schemas", command: "schema-mcp", args: [] })
    )

    expect(client.tools[0]?.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "number" } }
    })
  })

  it.each([
    {
      label: "missing inputSchema",
      tool: { name: "bad" },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "null inputSchema",
      tool: { name: "bad", inputSchema: null },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "array inputSchema",
      tool: { name: "bad", inputSchema: [] },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "non-object inputSchema type",
      tool: { name: "bad", inputSchema: { type: "string" } },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "missing inputSchema type",
      tool: { name: "bad", inputSchema: {} },
      message: "MCP server \"catalog\" returned a tool whose inputSchema is not a JSON Schema object of type \"object\""
    },
    {
      label: "null outputSchema",
      tool: { name: "bad", inputSchema: { type: "object" }, outputSchema: null },
      message: "MCP server \"catalog\" returned a tool whose outputSchema is not a JSON object"
    },
    {
      label: "array outputSchema",
      tool: { name: "bad", inputSchema: { type: "object" }, outputSchema: [] },
      message: "MCP server \"catalog\" returned a tool whose outputSchema is not a JSON object"
    },
    {
      label: "scalar outputSchema",
      tool: { name: "bad", inputSchema: { type: "object" }, outputSchema: true },
      message: "MCP server \"catalog\" returned a tool whose outputSchema is not a JSON object"
    },
    {
      label: "slash in the name",
      tool: { name: "bad/name", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "C0 control in the name",
      tool: { name: "bad\nname", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "DEL in the name",
      tool: { name: "bad\u007fname", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "C1 control in the name",
      tool: { name: "bad\u0085name", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "the name \".\"",
      tool: { name: ".", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "the name \"..\"",
      tool: { name: "..", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a zero-width space in the name",
      tool: { name: "bad\u200bname", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a zero-width joiner in the name",
      tool: { name: "bad\u200dname", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a left-to-right mark in the name",
      tool: { name: "bad\u200ename", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a right-to-left override in the name",
      tool: { name: "bad\u202ename", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a first-strong isolate in the name",
      tool: { name: "bad\u2068name", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a word joiner in the name",
      tool: { name: "bad\u2060name", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a byte-order mark in the name",
      tool: { name: "bad\ufeffname", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a soft hyphen in the name",
      tool: { name: "bad\u00adname", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a line separator in the name",
      tool: { name: "bad\u2028name", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a paragraph separator in the name",
      tool: { name: "bad\u2029name", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    },
    {
      label: "a lone surrogate in the name",
      tool: { name: "bad\ud800name", inputSchema: { type: "object" } },
      message:
        "MCP server \"catalog\" returned a tool name that is \".\" or \"..\", or contains \"/\" or an invisible or control character"
    }
  ])("rejects a catalog tool with $label", async ({ message, tool }) => {
    const error = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") return { tools: [tool] }
        return undefined
      },
      Effect.flip(McpClient.connect({ server: "catalog", command: "catalog-mcp", args: [] }))
    )

    expect(error).toMatchObject({ code: "invalid_response", server: "catalog", message })
  })

  it("accepts each catalog bound exactly at its configured limit", async () => {
    const client = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") {
          return {
            tools: [
              { name: "éé", description: "éééé" + "x", inputSchema: { type: "object" } },
              { name: "okay", inputSchema: { type: "object" } }
            ]
          }
        }
        return undefined
      },
      McpClient.connect({
        server: "catalog-boundary",
        command: "catalog-mcp",
        args: [],
        maxTools: 2,
        maxToolNameBytes: 4,
        maxToolDocumentBytes: 26,
        maxCatalogPages: 1
      })
    )

    expect(client.tools.map((tool) => tool.name)).toEqual(["éé", "okay"])
  })

  it.each([
    {
      options: { maxTools: 1 },
      tools: [
        { name: "one", inputSchema: { type: "object" } },
        { name: "two", inputSchema: { type: "object" } }
      ],
      message: "MCP server \"catalog-limit\" returned more than 1 tools"
    },
    {
      options: { maxToolNameBytes: 3 },
      tools: [{ name: "éé", inputSchema: { type: "object" } }],
      message: "MCP server \"catalog-limit\" returned a tool name longer than 3 bytes"
    },
    {
      // 17 bytes of JSON schema plus a 9-byte description is 26 bytes.
      options: { maxToolDocumentBytes: 25 },
      tools: [{ name: "long", description: "éééé" + "x", inputSchema: { type: "object" } }],
      message: "MCP server \"catalog-limit\" returned a tool description and inputSchema longer than 25 bytes"
    }
  ])("rejects a catalog one past $options", async ({ message, options, tools }) => {
    const error = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") return { tools }
        return undefined
      },
      Effect.flip(McpClient.connect({
        server: "catalog-limit",
        command: "catalog-mcp",
        args: [],
        ...options
      }))
    )

    expect(error).toMatchObject({ code: "invalid_response", server: "catalog-limit", message })
  })

  it.each(
    [
      ["handshakeTimeoutMs", 0],
      ["maxTools", 0],
      ["maxToolNameBytes", -1],
      ["maxCatalogPages", 1.5],
      ["maxToolDocumentBytes", 0],
      ["handshakeTimeoutMs", Number.MAX_SAFE_INTEGER + 1],
      ["maxTools", Number.MAX_SAFE_INTEGER + 1],
      ["maxToolNameBytes", Number.MAX_SAFE_INTEGER + 1],
      ["maxCatalogPages", Number.MAX_SAFE_INTEGER + 1],
      ["requestTimeoutMs", Number.MAX_SAFE_INTEGER + 1],
      ["queueCapacity", Number.MAX_SAFE_INTEGER + 1],
      ["maxFrameBytes", Number.MAX_SAFE_INTEGER + 1],
      ["maxOutboundFrameBytes", Number.MAX_SAFE_INTEGER + 1],
      ["maxStderrBytes", Number.MAX_SAFE_INTEGER + 1]
    ] as const
  )("rejects an invalid public limit %s", async (name, value) => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.flip(McpClient.connect({
        server: "client-limit",
        command: "mcp",
        args: [],
        [name]: value
      }))
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "client-limit",
      message: `MCP option "${name}" must be a positive integer`
    })
  })

  it("bounds every numeric ConnectOptionsSchema field before spawning", async () => {
    const nonNumeric = ["server", "command", "args", "cwd", "env"]
    const numeric = Object.keys(McpClient.ConnectOptionsSchema.fields).filter((name) => !nonNumeric.includes(name))
    expect(numeric).toHaveLength(10)

    for (const name of numeric) {
      const error = await withFakeServer(
        respondToEcho,
        Effect.flip(McpClient.connect({ server: "schema-limit", command: "mcp", args: [], [name]: 0 }))
      )

      expect(error).toMatchObject({
        code: "protocol_error",
        server: "schema-limit",
        message: `MCP option "${name}" must be a positive integer`
      })
    }
  })

  it("treats an explicit undefined nextCursor as the end of the catalog", async () => {
    const client = await withFakeServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        }
        if (request.method === "tools/list") return { tools: TOOLS, nextCursor: undefined }
        return undefined
      },
      McpClient.connect({ server: "undefined-cursor", command: "mcp", args: [] })
    )

    expect(client.tools).toHaveLength(1)
  })

  it("fails an unknown tool before writing a tools/call frame", async () => {
    const methods: Array<string> = []
    const error = await withFakeServer(
      (request) => {
        methods.push(request.method)
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "known-tools", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("nope", {}))
      })
    )

    expect(error).toMatchObject({
      code: "tool_not_found",
      server: "known-tools",
      message: "MCP server \"known-tools\" has no requested tool"
    })
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"])
  })

  it.each([
    {
      label: "BigInt",
      value: 1n,
      path: "arguments.value",
      reason: "a bigint"
    },
    {
      label: "NaN",
      value: Number.NaN,
      path: "arguments.value",
      reason: "a non-finite number"
    },
    {
      label: "Infinity",
      value: Number.POSITIVE_INFINITY,
      path: "arguments.value",
      reason: "a non-finite number"
    },
    {
      label: "undefined",
      value: undefined,
      path: "arguments.value",
      reason: "undefined"
    },
    {
      label: "function",
      value: () => undefined,
      path: "arguments.value",
      reason: "a function"
    },
    {
      label: "symbol",
      value: Symbol("value"),
      path: "arguments.value",
      reason: "a symbol"
    },
    {
      label: "Date",
      value: new Date(0),
      path: "arguments.value",
      reason: "an object with a non-plain prototype"
    },
    {
      label: "inherited prototype",
      value: Object.create({ inherited: 1 }) as Record<string, unknown>,
      path: "arguments.value",
      reason: "an object with a non-plain prototype"
    },
    {
      label: "enumerable symbol key",
      value: Object.defineProperty({}, Symbol("hidden"), { enumerable: true, value: 1 }),
      path: "arguments.value",
      reason: "a symbol-keyed property"
    }
  ])("rejects a non-JSON $label tool argument", async ({ reason, value }) => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { value }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "arguments",
      message: `MCP server "arguments" was sent a tool argument that is not JSON: ${reason}; property path withheld`
    })
  })

  it("keeps the exact invalid-argument path in redacted host diagnostics only", async () => {
    const diagnostics: Array<Diagnostics.Event> = []
    const longKey = "x".repeat(140)
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", {
          nested: { items: [0, { [longKey]: undefined }] }
        }))
      }).pipe(Effect.provide(Diagnostics.layer((event) => diagnostics.push(event))))
    )

    expect(error.code).toBe("protocol_error")
    expect(error.server).toBe("arguments")
    expect(error.message).not.toContain(longKey)
    expect(JSON.stringify(diagnostics)).not.toContain(longKey)
    expect(Redacted.value(diagnostics[0]!.detail)).toContain(`arguments.nested.items[1].${longKey}`)
  })

  it("rejects cyclic arguments without a serialization defect", async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", cyclic))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "arguments",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: a cyclic reference; property path withheld"
    })
  })

  it("rejects an accessor argument without invoking it or writing tools/call", async () => {
    const methods: Array<string> = []
    let invoked = false
    const args = Object.defineProperty({}, "lazy", {
      enumerable: true,
      get() {
        invoked = true
        return "invoked"
      }
    })
    const exit = await withFakeServer(
      (request) => {
        methods.push(request.method)
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", args))
      })
    )

    const error = typedFailure(exit)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: an accessor property; property path withheld"
    })
    expect(invoked).toBe(false)
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"])
  })

  it("turns a throwing accessor into an McpError instead of a defect", async () => {
    let invoked = false
    const args = Object.defineProperty({}, "lazy", {
      enumerable: true,
      get() {
        invoked = true
        throw new Error("must not run")
      }
    })
    const exit = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", args))
      })
    )

    expect(typedFailure(exit)).toBeInstanceOf(McpError)
    expect(invoked).toBe(false)
  })

  it("turns a throwing proxy get trap into an McpError instead of a defect", async () => {
    const value = new Proxy([1], {
      get() {
        throw new Error("get trap")
      }
    })
    const exit = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", { value }))
      })
    )

    const error = typedFailure(exit)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: a property that threw when read; property path withheld"
    })
  })

  it("turns a throwing proxy reflection trap into an McpError instead of a defect", async () => {
    const value = new Proxy({ okay: true }, {
      ownKeys() {
        throw new Error("ownKeys trap")
      }
    })
    const exit = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", { value }))
      })
    )

    expect(typedFailure(exit)).toBeInstanceOf(McpError)
  })

  it("rejects a toJSON method instead of executing JSON customization", async () => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { toJSON: () => ({ hidden: true }) }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"arguments\" was sent a tool argument that is not JSON: a function; property path withheld"
    })
  })

  it("omits non-enumerable own arguments from the wire frame", async () => {
    let sent: unknown
    const hiddenSymbol = Symbol("hidden")
    const target = Object.defineProperties({ visible: true }, {
      hidden: {
        enumerable: false,
        value: "omit"
      },
      [hiddenSymbol]: {
        enumerable: false,
        value: "omit"
      }
    })
    const args = new Proxy(target, {
      ownKeys(value) {
        return [...Reflect.ownKeys(value), "missing-descriptor"]
      },
      getOwnPropertyDescriptor(value, key) {
        return key === "missing-descriptor" ? undefined : Reflect.getOwnPropertyDescriptor(value, key)
      }
    })
    await withFakeServer(
      (request) => {
        if (request.method === "tools/call") {
          sent = (request.params as { readonly arguments: unknown }).arguments
          return { content: [], isError: false }
        }
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        yield* client.callTool("add", args)
      })
    )

    expect(sent).toEqual({ visible: true })
  })

  it.each([
    {
      label: "revoked proxy",
      make: () => {
        const revocable = Proxy.revocable({}, {})
        revocable.revoke()
        return revocable.proxy
      }
    },
    {
      label: "throwing getPrototypeOf trap",
      make: () =>
        new Proxy({}, {
          getPrototypeOf() {
            throw new Error("getPrototypeOf trap")
          }
        })
    },
    {
      label: "throwing propertyIsEnumerable reflection",
      make: () => {
        const key = Symbol("key")
        return new Proxy({ [key]: true }, {
          getOwnPropertyDescriptor(target, property) {
            if (typeof property === "symbol") throw new Error("descriptor trap")
            return Reflect.getOwnPropertyDescriptor(target, property)
          }
        })
      }
    },
    {
      label: "throwing getOwnPropertyNames reflection",
      make: () => {
        let calls = 0
        return new Proxy({}, {
          ownKeys() {
            calls += 1
            if (calls === 1) return []
            throw new Error("second ownKeys trap")
          }
        })
      }
    },
    {
      label: "throwing object descriptor reflection",
      make: () =>
        new Proxy({ value: true }, {
          getOwnPropertyDescriptor() {
            throw new Error("descriptor trap")
          }
        })
    },
    {
      label: "throwing array descriptor reflection",
      make: () =>
        new Proxy([1], {
          get(target, key, receiver) {
            return Reflect.get(target, key, receiver)
          },
          getOwnPropertyDescriptor() {
            throw new Error("descriptor trap")
          }
        })
    }
  ])("turns a $label into an McpError", async ({ make }) => {
    const exit = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.exit(client.callTool("add", { value: make() }))
      })
    )

    const error = typedFailure(exit)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ code: "protocol_error" })
  })

  it("rejects an invalid proxied array length without iterating it", async () => {
    const value = new Proxy([1], {
      get(target, key, receiver) {
        return key === "length" ? "invalid" : Reflect.get(target, key, receiver)
      }
    })
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { value }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: a property that threw when read; property path withheld"
    })
  })

  it("rejects an accessor array element without invoking it", async () => {
    let invoked = false
    const value: Array<unknown> = []
    Object.defineProperty(value, "0", {
      configurable: true,
      enumerable: true,
      get() {
        invoked = true
        return "must not run"
      }
    })
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { value }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: an accessor property; property path withheld"
    })
    expect(invoked).toBe(false)
  })

  it("keeps sparse array holes on the typed undefined rejection path", async () => {
    const value = new Array<unknown>(1)
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { value }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"arguments\" was sent a tool argument that is not JSON: undefined; property path withheld"
    })
  })

  it("reports the bounded path to a nested accessor", async () => {
    const nested = Object.defineProperty({}, "inner", {
      enumerable: true,
      get() {
        return "must not run"
      }
    })
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "arguments", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", { outer: nested }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      message:
        "MCP server \"arguments\" was sent a tool argument that is not JSON: an accessor property; property path withheld"
    })
  })

  it("snapshots valid JSON arguments before the returned effect runs", async () => {
    let sent: unknown
    const arguments_: { a: number; nested: Array<unknown> } = {
      a: 2,
      nested: [null, true, "text", { value: 3 }]
    }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { okay: true })
    arguments_.nested.push(nullPrototype)
    await withFakeServer(
      (request) => {
        if (request.method === "tools/call") {
          sent = (request.params as { readonly arguments: unknown }).arguments
          return { content: [], isError: false }
        }
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "snapshot", command: "mcp", args: [] })
        const call = client.callTool("add", arguments_)
        arguments_.a = 99
        ;(arguments_.nested[3] as { value: number }).value = 99
        yield* call
      })
    )

    expect(sent).toEqual({
      a: 2,
      nested: [null, true, "text", { value: 3 }, { okay: true }]
    })
  })

  it("snapshots the 1 MiB probe argument with one descriptor batch per container", async () => {
    const args = {
      rows: Array.from({ length: 12_000 }, (_, i) => ({
        id: i,
        name: `row-${i}`,
        ok: i % 2 === 0,
        tags: ["a", "b"],
        score: i / 7
      }))
    }
    const encoded = JSON.stringify(args)
    expect(encoded.length).toBe(985_531)
    let sent: unknown
    await withFakeServer(
      (request) => {
        if (request.method === "tools/call") {
          sent = (request.params as { arguments: unknown }).arguments
          return { content: [] }
        }
        return respondToEcho(request)
      },
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "snapshot-budget", command: "mcp", args: [] })
        const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor")
        const batches = vi.spyOn(Object, "getOwnPropertyDescriptors")
        descriptors.mockClear()
        let call: ReturnType<typeof client.callTool>
        let perMemberCalls: number
        let batchCalls: number
        try {
          call = client.callTool("add", args)
          perMemberCalls = descriptors.mock.calls.length
          batchCalls = batches.mock.calls.length
        } finally {
          descriptors.mockRestore()
          batches.mockRestore()
        }
        expect(perMemberCalls).toBe(0)
        expect(batchCalls).toBe(24_002)
        yield* call
      })
    )
    expect(JSON.stringify(sent)).toBe(encoded)
  })

  it("bounds large enum membership across a long result array", async () => {
    const count = 10_000
    const rows = Array(count).fill(count - 1)
    const outputSchema = {
      type: "object",
      properties: {
        rows: { type: "array", items: { enum: Array.from({ length: count }, (_, i) => i) } }
      }
    }
    await withFakeServer(
      respondWithStructured(outputSchema, { rows }),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "enum-budget", command: "mcp", args: [] })
        const start = performance.now()
        const result = yield* client.callTool("add", {})
        expect(result.structuredContent).toEqual({ rows })
        expect(performance.now() - start).toBeLessThan(1_000)
      })
    )
  })

  it.each([
    { value: { z: [1, null, true], a: { b: "x" } }, member: { a: { b: "x" }, z: [1, null, true] }, accepts: true },
    { value: { a: [1, 2] }, member: { a: [2, 1] }, accepts: false },
    { value: { a: "1" }, member: { a: 1 }, accepts: false },
    { value: { a: 0 }, member: { a: -0 }, accepts: true },
    { value: { a: {} }, member: { a: [] }, accepts: false },
    { value: { a: { b: 1 } }, member: { "a\":{\"b": 1 }, accepts: false }
  ])("preserves composite enum equality: $accepts ($value)", async ({ value, member, accepts }) => {
    await withFakeServer(
      respondWithStructured({ enum: [member] }, value),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "enum-json", command: "mcp", args: [] })
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const exit = yield* Effect.exit(client.callTool("add", {}))
          expect(Exit.isSuccess(exit)).toBe(accepts)
          if (!accepts) expect(typedFailure(exit)).toMatchObject({ code: "invalid_response" })
        }
      })
    )
  })

  it("ignores a proxy symbol that disappears during descriptor collection", async () => {
    const symbol = Symbol("gone")
    const args = new Proxy({}, { ownKeys: () => [symbol] })
    await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "snapshot-symbol", command: "mcp", args: [] })
        yield* client.callTool("add", args)
      })
    )
  })

  it("lets a host timer interrupt structured validation", async () => {
    const rows = Array(100_000).fill(999)
    const outputSchema = {
      required: ["validationStart"],
      properties: {
        rows: { items: { enum: Array.from({ length: 1_000 }, (_, i) => i) } }
      }
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let started = 0
    const hasOwn = Object.hasOwn
    try {
      await withFakeServer(
        respondWithStructured(outputSchema, { validationStart: true, rows }),
        Effect.gen(function*() {
          const client = yield* McpClient.connect({ server: "enum-interrupt", command: "mcp", args: [] })
          // Arm only when the validator checks required, after transport parsing.
          const reflection = vi.spyOn(Object, "hasOwn").mockImplementation((value, key) => {
            if (key === "validationStart" && started === 0) {
              started = performance.now()
              timer = setTimeout(() => controller.abort(), 25)
            }
            return hasOwn(value, key)
          })
          const exit = yield* Effect.promise(() =>
            Effect.runPromiseExit(client.callTool("add", {}), {
              signal: controller.signal
            })
          ).pipe(Effect.ensuring(Effect.sync(() => reflection.mockRestore())))
          expect(started).toBeGreaterThan(0)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(performance.now() - started).toBeLessThan(1_000)
        })
      )
    } finally {
      clearTimeout(timer)
    }
  })

  it("supports every documented outputSchema type and type arrays", async () => {
    const structuredContent = {
      nullValue: null,
      booleanValue: true,
      objectValue: {},
      arrayValue: [1],
      numberValue: 1.5,
      integerValue: 2,
      stringValue: "accepted",
      ignoredSchema: "accepted"
    }
    const result = await withFakeServer(
      respondWithStructured({
        type: "object",
        required: [42],
        properties: {
          nullValue: { type: "null" },
          booleanValue: { type: "boolean" },
          objectValue: { type: "object" },
          arrayValue: { type: "array" },
          numberValue: { type: "number" },
          integerValue: { type: "integer" },
          stringValue: { type: ["unsupported", 42, "null", "string"] },
          optionalMissing: { type: "string" },
          ignoredSchema: true
        }
      }, structuredContent),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "schema-types", command: "mcp", args: [] })
        return yield* client.callTool("add", {})
      })
    )

    expect(result.structuredContent).toEqual(structuredContent)
  })

  it("retains unsafe integers and ignored keywords in compiled output schemas", async () => {
    const structuredContent = { value: Number.MAX_SAFE_INTEGER + 1, extra: "" }
    const result = await withFakeServer(
      respondWithStructured({
        type: ["object", "constructor", "__proto__"],
        additionalProperties: false,
        $ref: "#/unresolved",
        oneOf: [{ type: "null" }],
        properties: {
          value: { type: "integer", maximum: 0 },
          extra: { type: "string", minLength: 10, pattern: "^required$" }
        }
      }, structuredContent),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "schema-compatibility", command: "mcp", args: [] })
        return yield* client.callTool("add", {})
      })
    )
    expect(result.structuredContent).toEqual(structuredContent)
  })

  it.each([1.5, "not-an-integer"])("rejects %j against the integer outputSchema type", async (value) => {
    const error = await withFakeServer(
      respondWithStructured({
        type: "object",
        properties: { value: { type: "integer" } }
      }, { value }),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "schema-integer", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", {}))
      })
    )

    expect(error).toMatchObject({
      code: "invalid_response",
      message:
        "MCP server \"schema-integer\" returned structuredContent that its own outputSchema rejects: expected integer; property path withheld"
    })
  })

  it("exposes an immutable catalog so callers cannot change later validation or dispatch", async () => {
    const result = await withFakeServer(
      respondWithStructured({ type: "object", properties: { value: { type: "number" } } }, { value: "wrong" }),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "catalog-snapshot", command: "mcp", args: [] })
        const tool = client.tools[0]!
        expect(Reflect.set(client.tools, "length", 0)).toBe(false)
        expect(Reflect.set(tool, "name", "changed")).toBe(false)
        expect(Reflect.set(tool.inputSchema, "type", "array")).toBe(false)
        const properties = tool.outputSchema!.properties as Record<string, unknown>
        expect(Reflect.set(properties, "value", {})).toBe(false)
        expect(Reflect.set(properties.value as object, "type", "string")).toBe(false)
        return yield* Effect.flip(client.callTool("add", {}))
      })
    )
    expect(result.code).toBe("invalid_response")
  })

  it("bounds error prose when a schema repeats a supported type", async () => {
    const error = await withFakeServer(
      respondWithStructured({ type: Array.from({ length: 2_000 }, () => "number") }, {}),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "schema-types", command: "mcp", args: [] })
        return yield* Effect.flip(client.callTool("add", {}))
      })
    )
    expect(error.message).toBe(
      "MCP server \"schema-types\" returned structuredContent that its own outputSchema rejects: expected number; property path withheld"
    )
  })

  it("compares structured enum values by JSON value", async () => {
    const structuredContent = {
      scalar: "ok",
      array: [1, 2],
      object: { target: { nested: [1, 2] } }
    }
    const result = await withFakeServer(
      respondWithStructured({
        type: "object",
        properties: {
          scalar: { enum: ["ok"] },
          array: { enum: [[0], [1, 2]] },
          object: {
            enum: [
              ["not-an-object"],
              { extra: true, other: true },
              { wrong: { nested: [1, 2] } },
              { target: { nested: [1, 3] } },
              { target: { nested: [1, 2] } }
            ]
          }
        }
      }, structuredContent),
      Effect.gen(function*() {
        const client = yield* McpClient.connect({ server: "schema-enum", command: "mcp", args: [] })
        return yield* client.callTool("add", {})
      })
    )

    expect(result.structuredContent).toEqual(structuredContent)
  })
})

describe("McpClient.ConnectOptionsSchema", () => {
  it("decodes a minimal persisted server entry", () => {
    expect(
      Schema.decodeUnknownSync(McpClient.ConnectOptionsSchema)({
        server: "fixture",
        command: "node",
        args: []
      })
    ).toEqual({ server: "fixture", command: "node", args: [] })
  })

  it("decodes every supported persisted server option", () => {
    const entry = {
      server: "fixture",
      command: "node",
      args: ["server.mjs"],
      cwd: "/workspace",
      env: { TOKEN: "redacted" },
      handshakeTimeoutMs: 1,
      requestTimeoutMs: 2,
      queueCapacity: 3,
      maxFrameBytes: 4,
      maxOutboundFrameBytes: 5,
      maxStderrBytes: 6,
      maxTools: 7,
      maxToolNameBytes: 8,
      maxCatalogPages: 9
    }

    expect(Schema.decodeUnknownSync(McpClient.ConnectOptionsSchema)(entry)).toEqual(entry)
  })

  it.each([
    ["an array environment", { server: "fixture", command: "node", args: [], env: ["A", "B"] }],
    ["an empty server", { server: "", command: "node", args: [] }],
    ["an empty command", { server: "fixture", command: "", args: [] }],
    ["a non-integer limit", { server: "fixture", command: "node", args: [], handshakeTimeoutMs: 1.5 }],
    ["a zero limit", { server: "fixture", command: "node", args: [], requestTimeoutMs: 0 }],
    ["a negative limit", { server: "fixture", command: "node", args: [], maxStderrBytes: -1 }]
  ])("rejects %s", (_label, entry) => {
    expect(() => Schema.decodeUnknownSync(McpClient.ConnectOptionsSchema)(entry)).toThrow()
  })
})

describe("McpClient.HttpConnectOptionsSchema", () => {
  it("decodes every supported persisted Streamable HTTP option", () => {
    const entry = {
      server: "remote",
      url: "https://mcp.example.test/mcp",
      bearerTokenEnv: "REMOTE_MCP_TOKEN",
      handshakeTimeoutMs: 1,
      requestTimeoutMs: 2,
      maxFrameBytes: 3,
      maxOutboundFrameBytes: 4,
      maxTools: 5,
      maxToolNameBytes: 6,
      maxToolDocumentBytes: 7,
      maxCatalogPages: 8
    }
    expect(Schema.decodeUnknownSync(McpClient.HttpConnectOptionsSchema)(entry)).toEqual(entry)
    expect(Schema.decodeUnknownSync(McpClient.HttpConnectOptionsSchema)({ server: "open", url: "http://127.0.0.1:9/" }))
      .toEqual({ server: "open", url: "http://127.0.0.1:9/" })
  })

  it.each([
    ["a relative url", { server: "remote", url: "/mcp" }],
    ["a non-http scheme", { server: "remote", url: "ws://mcp.example.test/mcp" }],
    ["a url with a password", { server: "remote", url: "https://user:secret@mcp.example.test/" }],
    ["a url with a username", { server: "remote", url: "https://token@mcp.example.test/" }],
    ["an empty server", { server: "", url: "https://mcp.example.test/" }],
    ["a credential variable that is not a name", { server: "remote", url: "https://mcp.example.test/", bearerTokenEnv: "A B" }],
    ["a zero limit", { server: "remote", url: "https://mcp.example.test/", maxTools: 0 }]
  ])("rejects %s", (_label, entry) => {
    expect(() => Schema.decodeUnknownSync(McpClient.HttpConnectOptionsSchema)(entry)).toThrow()
  })
})
