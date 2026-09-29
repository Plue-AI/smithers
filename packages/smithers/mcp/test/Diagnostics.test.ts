import { NodeServices } from "@effect/platform-node"
import { Effect, Redacted, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Diagnostics from "../src/Diagnostics.ts"
import * as Reporter from "../src/internal/DiagnosticReporter.ts"
import * as McpClient from "../src/McpClient.ts"
import { McpError } from "../src/McpError.ts"
import * as FixtureServer from "./fixtures/FixtureServer.ts"

const secret = "synthetic-private-value-DO-NOT-PUBLISH"

describe("MCP diagnostic privacy", () => {
  it.each(
    [
      ["stderr", "connection_closed"],
      ["version", "protocol_error"],
      ["duplicate", "invalid_response"],
      ["cursor", "invalid_response"],
      ["schema", "invalid_response"],
      ["remote", "tool_failed"]
    ] as const
  )(
    "does not expose %s details through a typed/encoded error or ordinary observer serialization",
    async (mode, expectedCode) => {
      const events: Array<Diagnostics.Event> = []
      const error = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          return yield* Effect.flip(Effect.gen(function*() {
            const client = yield* McpClient.connect({
              server: "private-test",
              command: process.execPath,
              args: ["-e", FixtureServer.source, `private-${mode}`],
              env: { MCP_DIAGNOSTIC_TEST_SECRET: secret },
              // A cap shorter than the credential's line. The transport redacts
              // the line before capping, so the cap cannot strip the prefix
              // that makes the credential recognizable.
              maxStderrBytes: secret.length + 1,
              handshakeTimeoutMs: McpClient.defaultHandshakeTimeoutMs,
              requestTimeoutMs: McpClient.defaultHandshakeTimeoutMs
            })
            return yield* client.callTool("probe", {})
          }))
        }).pipe(Effect.provide(NodeServices.layer), Effect.provide(Diagnostics.layer((event) => events.push(event))))
      ))
      expect(error).toBeInstanceOf(McpError)
      const encoded = Schema.encodeSync(McpError)(error)
      expect(error.code, JSON.stringify(encoded)).toBe(expectedCode)
      for (const display of [String(error), JSON.stringify(error), JSON.stringify(encoded), JSON.stringify(events)]) {
        expect(display).not.toContain(secret)
        expect(display).not.toContain("short-private-pin")
      }
      expect(events.length).toBeGreaterThan(0)
      if (mode === "stderr") {
        expect(events.map((event) => Redacted.value(event.detail))).toEqual(["API_TOKEN=[REDACTED]"])
      } else {
        expect(events.some((event) => Redacted.value(event.detail).includes(secret))).toBe(true)
      }
    }
  )

  it("bounds private details, preserves UTF-8, and isolates observer and serialization defects", async () => {
    const events: Array<Diagnostics.Event> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const report = yield* Reporter.make("host")
        report("stderr", "x".repeat(16_383) + "😀" + secret)
        const circular: Record<string, unknown> = {}
        circular.self = circular
        report("invalid-response", circular)
        // BigInt has no JSON form: a serialization defect drops only this event.
        report("invalid-arguments", { count: 1n, message: secret })
        report("remote-error", { code: -32_000, message: secret })
      }).pipe(Effect.provide(Diagnostics.layer((event) => {
        events.push(event)
        if (event.source === "remote-error") throw new Error(secret)
      })))
    )
    expect(events.map((event) => event.source)).toEqual(["stderr", "invalid-response", "remote-error"])
    expect(events[0]!.truncated).toBe(true)
    expect(Redacted.value(events[0]!.detail)).toBe("x".repeat(16_383))
    expect(events[1]!.truncated).toBe(false)
    expect(Redacted.value(events[1]!.detail)).toBe(JSON.stringify({ self: "[Circular]" }))
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it.each(["spawn", "remote-error", "invalid-response", "invalid-arguments"] as const)(
    "redacts diagnostic credential spellings in a %s detail",
    async (source) => {
      const pin = "ZqSynthetic7Secret4Value9"
      const events: Array<Diagnostics.Event> = []
      await Effect.runPromise(
        Effect.gen(function*() {
          const report = yield* Reporter.make("host")
          report(source, `mysql -u root -p ${pin} db`)
          report(source, `password: correct horse ${pin}`)
          report(source, { argv: ["sshpass", "-p", pin] })
        }).pipe(Effect.provide(Diagnostics.layer((event) => events.push(event))))
      )
      expect(events).toHaveLength(3)
      for (const event of events) {
        expect(Redacted.value(event.detail)).not.toContain(pin)
        expect(Redacted.value(event.detail)).toContain("[REDACTED]")
      }
    }
  )

  // StdioTransport redacts stderr before its cap; RealServer.integration covers it.
  it.each(["spawn", "remote-error", "invalid-response", "invalid-arguments"] as const)(
    "redacts credentials in a %s detail before a trusted observer unwraps it",
    async (source) => {
      const token = "ghp_" + "A".repeat(36)
      const events: Array<Diagnostics.Event> = []
      await Effect.runPromise(
        Effect.gen(function*() {
          const report = yield* Reporter.make("host")
          report(source, { message: `echoed Bearer ${token}`, data: { apiKey: "plain-private-key-value" } })
          report(source, `echoed ${token}`)
        }).pipe(Effect.provide(Diagnostics.layer((event) => events.push(event))))
      )
      expect(events).toHaveLength(2)
      for (const event of events) {
        const detail = Redacted.value(event.detail)
        expect(detail).not.toContain(token)
        expect(detail).not.toContain("plain-private-key-value")
        expect(detail).toContain("REDACTED")
      }
    }
  )

  it("discards details when no trusted host receiver is configured", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const report = yield* Reporter.make("host")
      report("stderr", secret)
    }))
  })
})
