import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as JsonLimits from "../src/internal/JsonLimits.ts"
import * as McpClient from "../src/McpClient.ts"
import * as FixtureServer from "./fixtures/FixtureServer.ts"

const options = (mode: string, depth = 10_000): McpClient.StdioConnectOptions => ({
  server: "json-limits",
  command: process.execPath,
  args: ["-e", FixtureServer.source, `nested-${mode}`, "", String(depth)],
  handshakeTimeoutMs: 2_000,
  requestTimeoutMs: 2_000
})

const failWithoutDefect = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected failure")
  expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false)
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  expect(reason).toBeDefined()
  return reason!.error
}

describe("MCP JSON resource limits", () => {
  it.each([null, [], "text", 42])("refuses a non-object argument root %#", async (args) => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.gen(function*() {
        const client = yield* McpClient.connect(options("echo", 0))
        return yield* client.callTool("probe", args as unknown as Record<string, unknown>)
      })).pipe(Effect.provide(NodeServices.layer))
    )
    expect(failWithoutDefect(exit)).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"json-limits\" tool arguments must be a JSON object"
    })
  })

  it.each(["schema", "enum", "result"])("bounds deeply nested %s before recursive consumers", async (mode) => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.gen(function*() {
        const client = yield* McpClient.connect(options(mode))
        return yield* client.callTool("probe", {})
      })).pipe(Effect.provide(NodeServices.layer))
    )
    expect(failWithoutDefect(exit)).toMatchObject({ code: "protocol_error" })
  })

  it("rejects deep arguments as a typed failure, including at synchronous call construction", async () => {
    let args: Record<string, unknown> = {}
    for (let index = 0; index < 10_000; index += 1) args = { value: args }
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.gen(function*() {
        const client = yield* McpClient.connect(options("echo", 0))
        let call: ReturnType<typeof client.callTool> | undefined
        expect(() => {
          call = client.callTool("probe", args)
        }).not.toThrow()
        return yield* call!
      })).pipe(Effect.provide(NodeServices.layer))
    )
    expect(failWithoutDefect(exit)).toMatchObject({ code: "protocol_error" })
  })

  it.each([124, 125, 126])(
    "enforces the inclusive 128-container wire boundary at %i payload wrappers",
    async (depth) => {
      const args = JSON.parse("{\"value\":".repeat(depth) + "{}" + "}".repeat(depth)) as Record<string, unknown>
      for (const direction of ["inbound", "outbound"] as const) {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(Effect.gen(function*() {
            const client = yield* McpClient.connect(options(direction === "inbound" ? "result" : "echo", depth))
            return yield* client.callTool("probe", direction === "inbound" ? {} : args)
          })).pipe(Effect.provide(NodeServices.layer))
        )
        if (depth <= 125) {
          expect(Exit.isSuccess(exit)).toBe(true)
          if (!Exit.isSuccess(exit)) throw new Error("expected success")
          expect(exit.value.structuredContent).toEqual(direction === "inbound" ? args : {})
        } else {
          expect(failWithoutDefect(exit)).toMatchObject({ code: "protocol_error" })
        }
      }
    }
  )

  it("refuses non-finite values produced by JSON numeric overflow", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.gen(function*() {
        const client = yield* McpClient.connect(options("infinite", 0))
        return yield* client.callTool("probe", {})
      })).pipe(Effect.provide(NodeServices.layer))
    )
    expect(failWithoutDefect(exit)).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"json-limits\" sent invalid JSON: a JSON number is outside the finite range"
    })
  })

  it("stops shared-reference expansion before copying or stringifying the full tree", async () => {
    let reads = 0
    let value: Record<string, unknown> = new Proxy({ value: "x".repeat(128) }, {
      getOwnPropertyDescriptor(target, key) {
        reads += 1
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    for (let index = 0; index < 16; index += 1) value = { left: value, right: value }
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.gen(function*() {
        const client = yield* McpClient.connect({ ...options("echo", 0), maxOutboundFrameBytes: 2_048 })
        return yield* client.callTool("probe", value)
      })).pipe(Effect.provide(NodeServices.layer))
    )
    expect(failWithoutDefect(exit)).toMatchObject({ code: "protocol_error" })
    // The tree would contain 65,536 copies of the leaf. The snapshot should
    // stop within its encoded-size allowance, not after expanding them all.
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThan(16)
  })

  it.each(["array", "object", "mixed"])("counts nested %s containers without recursion", (kind) => {
    for (const depth of [127, 128, 129]) {
      let value: unknown = null
      for (let index = 0; index < depth; index += 1) {
        value = kind === "array" || (kind === "mixed" && index % 2 === 0) ? [value] : { value }
      }
      expect(JsonLimits.checkParsed(value)).toBe(depth <= 128 ? undefined : "JSON nesting exceeds 128 containers")
    }
    expect(JsonLimits.maxDepth).toBe(McpClient.maxJsonDepth)
  })

  it.each([
    { name: "array slots", args: { values: Array.from({ length: 2_049 }, () => null) } },
    { name: "object key", args: { ["x".repeat(2_049)]: null } }
  ])("bounds expansion of $name before copying its contents", async ({ args }) => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.gen(function*() {
        const client = yield* McpClient.connect({ ...options("echo", 0), maxOutboundFrameBytes: 2_048 })
        return yield* client.callTool("probe", args)
      })).pipe(Effect.provide(NodeServices.layer))
    )
    expect(failWithoutDefect(exit)).toMatchObject({ code: "protocol_error" })
  })
})
