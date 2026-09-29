/**
 * A body failure outside the flow's declared error schema is a defect either
 * way, but `orDie` alone reports only the schema mismatch and never the error
 * that actually occurred — for a flow declaring no error at all, the whole
 * report was `InvalidType(<Never>)`. The log line below is the one place that
 * error is named, so it is pinned here, including for an error that cannot be
 * rendered as JSON.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Logger, References, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"

const Undeclared = Flow.make("UndeclaredFlowFailure/flow", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("unused")
})

interface Captured {
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
}

/** Runs a registered handler that fails, capturing what the engine logged. */
const failWith = (error: unknown, executionId: string) =>
  Effect.gen(function*() {
    const logs: Array<Captured> = []
    const capture = Logger.make((options) =>
      logs.push({
        message: options.message,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations)
      })
    )
    const exit = yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(Undeclared, () => Effect.fail(error as never))
      return yield* Effect.exit(Undeclared.execute({}, { executionId }))
    })).pipe(
      Effect.provide(FlowEngine.layerMemory),
      Effect.provideService(Logger.CurrentLoggers, new Set([capture]))
    )
    return { exit, logs }
  })

describe("a flow body failure outside the declared error schema", () => {
  effect("dies, and logs the flow and the error that could not be declared", () =>
    Effect.gen(function*() {
      const { exit, logs } = yield* failWith({ code: "outside-contract" }, "undeclared-json")

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const line = logs.find((entry) => String(entry.message).includes("outside its declared error schema"))
      expect(line?.annotations).toMatchObject({
        flow: "UndeclaredFlowFailure/flow",
        error: "{\"code\":\"outside-contract\"}"
      })
    }))

  effect("still names the flow when the error cannot be rendered as JSON", () =>
    Effect.gen(function*() {
      // A cause chain that points back at itself also has a hostile coercion
      // hook. Diagnostics must invoke neither and must preserve the defect.
      const circular: { self?: unknown; toString: () => string } = {
        toString: () => "circular-failure"
      }
      circular.self = circular
      const { exit, logs } = yield* failWith(circular, "undeclared-circular")

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const line = logs.find((entry) => String(entry.message).includes("outside its declared error schema"))
      expect(line?.annotations).toMatchObject({
        flow: "UndeclaredFlowFailure/flow",
        error: "[object]"
      })
    }))

  effect("renders only inert bounded fields without replacing the original cause", () =>
    Effect.gen(function*() {
      let hooks = 0
      const sparse = new Array<unknown>(10)
      sparse[0] = true
      sparse[1] = undefined
      sparse[2] = 12n
      sparse[3] = Symbol("hidden")
      sparse[4] = () => "hidden"
      sparse[5] = null
      sparse[6] = Number.POSITIVE_INFINITY
      Object.defineProperty(sparse, "7", {
        enumerable: true,
        get: () => {
          hooks++
          throw new Error("must not run")
        }
      })
      const error = {
        code: "outside-contract",
        message: "Bearer operator-secret",
        value: Number.NEGATIVE_INFINITY,
        failures: sparse,
        token: "operator-secret",
        toJSON: () => {
          hooks++
          throw new Error("must not run")
        },
        toString: () => {
          hooks++
          throw new Error("must not run")
        }
      }
      Object.defineProperty(error, "cause", {
        enumerable: true,
        get: () => {
          hooks++
          throw new Error("must not run")
        }
      })

      const { exit, logs } = yield* failWith(error, "undeclared-inert")

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(hooks).toBe(0)
      const line = logs.find((entry) => String(entry.message).includes("outside its declared error schema"))
      expect(line?.annotations.error).toContain("[REDACTED]")
      expect(line?.annotations.error).toContain("[2 more]")
      expect(line?.annotations.error).not.toContain("operator-secret")
    }))

  effect("redacts a credential the upstream response body quotes inside a message", () =>
    Effect.gen(function*() {
      // An HTTP client error embeds the response body verbatim, so the key
      // reaches the sanitizer quoted (`"apiKey":"..."`) or escaped, never as
      // the bare `apiKey=...` pair the object-field redaction already covers.
      const secret = "sk-live-9f8e7d6c5b4a"
      const error = {
        code: "upstream_failed",
        message: `POST /v1/keys failed 401: {"error":"unauthorized","apiKey":"${secret}",`
          + `"token":"${secret}","authorization":"Bearer ${secret}",`
          + `"body":"{\\"secret\\":\\"${secret}\\"}"}`
      }

      const { exit, logs } = yield* failWith(error, "undeclared-json-body")

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const line = logs.find((entry) => String(entry.message).includes("outside its declared error schema"))
      expect(line?.annotations.error).not.toContain(secret)
      expect(line?.annotations.error).toContain("[REDACTED]")
      expect(line?.annotations.error).toContain("upstream_failed")
    }))

  effect("handles cycles, depth bounds, and hostile proxies without invoking user code", () =>
    Effect.gen(function*() {
      const cycle: { cause?: unknown } = {}
      cycle.cause = cycle
      const deep = { cause: { cause: { cause: { cause: { cause: { message: "too deep" } } } } } }
      const hostile = new Proxy({}, {
        getOwnPropertyDescriptor: () => {
          throw new Error("hostile proxy")
        }
      })

      const cyclic = yield* failWith(cycle, "undeclared-cycle")
      const bounded = yield* failWith(deep, "undeclared-depth")
      const refused = yield* failWith(hostile, "undeclared-proxy")

      const annotation = (captured: typeof cyclic) =>
        captured.logs.find((entry) => String(entry.message).includes("outside its declared error schema"))
          ?.annotations.error
      expect(annotation(cyclic)).toContain("[circular]")
      expect(annotation(bounded)).toContain("[object]")
      // The proxy is named without its trap running.
      expect(annotation(refused)).toBe("[proxy]")
      for (const captured of [cyclic, bounded, refused]) {
        expect(Exit.isFailure(captured.exit) && Cause.hasDies(captured.exit.cause)).toBe(true)
      }
    }))
})
