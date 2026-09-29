/**
 * A defect crossing `FlowProxyServer` leaves the process. The proxy logs it,
 * and an RPC server answers the caller with `Schema.Defect` of it, which
 * encodes a plain object as full JSON. Passing the raw value through therefore
 * republished whatever credential the implementation error carried — to the
 * server log and to the remote caller — defeating the bounded, redacted
 * rendering the engine had already applied to the same value one layer down.
 * Both exits are pinned here, for the engine's own undeclared-failure defect
 * and for a defect raised inside a body.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Logger, References, Schema } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { FlowEngine, FlowProxy, FlowProxyServer } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown>) => it.effect(name, () => withCrypto(body()))

const secret = "operator-secret-XYZ123"

/** The shape an HTTP or SDK client error has when it fails outside a contract. */
const upstream = {
  code: "upstream_failed",
  message: `Bearer ${secret}`,
  token: secret,
  headers: { authorization: `Bearer ${secret}` }
}

const Leaky = Flow.make("UndeclaredFailureRedaction/flow", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("unused")
})

const flows = [Leaky] as const

interface Captured {
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
}

/** Renders a captured log entry the way a default logger would print it. */
const render = (message: unknown): string =>
  (Array.isArray(message) ? message : [message])
    .map((part) =>
      Cause.isCause(part)
        ? Cause.pretty(part)
        : typeof part === "string"
        ? part
        : String(JSON.stringify(part))
    )
    .join(" ")

/** Serves one flow over RPC and returns the caller's exit with the server's log. */
const callOverRpc = (body: () => Effect.Effect<never, never>) =>
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
      yield* engine.register(Leaky, body)
      const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(flows))
      return yield* Effect.exit(
        client["UndeclaredFailureRedaction/flow"]({ payload: {}, executionId: "redaction-1" })
      )
    })).pipe(
      Effect.provide(FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provideMerge(FlowEngine.layerMemory))),
      Effect.provideService(Logger.CurrentLoggers, new Set([capture]))
    )
    const proxyLines = logs.filter((entry) => entry.annotations["module"] === "FlowProxyServer")
    return { exit, proxyLines }
  })

/** The value the caller's exit died with. */
const defectOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

const wireForm = (defect: unknown) => JSON.stringify(Schema.encodeSync(Schema.toCodecJson(Schema.Defect()))(defect))

describe("a served flow whose handler dies carrying a credential", () => {
  effect("answers the RPC caller with a coded refusal instead of the raw error", () =>
    Effect.gen(function*() {
      const { exit } = yield* callOverRpc(() => Effect.fail(upstream as never))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const refusal = defectOf(exit) as FlowProxyServer.FlowHandlerDefect
      expect(refusal).toBeInstanceOf(FlowProxyServer.FlowHandlerDefect)
      expect(refusal.code).toBe("flow_handler_defect")
      expect(refusal.flowName).toBe("UndeclaredFailureRedaction/flow")
      expect(refusal.diagnostic).toContain("[REDACTED]")
      expect(refusal.diagnostic).not.toContain(secret)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").not.toContain(secret)
    }))

  effect("keeps the credential out of the serialized defect an RPC server sends", () =>
    Effect.gen(function*() {
      const { exit } = yield* callOverRpc(() => Effect.fail(upstream as never))

      const wire = wireForm(defectOf(exit))
      expect(wire).not.toContain(secret)
      // `Schema.Defect` renders an Error as name and message, so the tag is
      // what survives for a caller to classify the refusal by.
      expect(wire).toContain("@smthrs/engine/FlowHandlerDefect")
    }))

  effect("logs a bounded rendering of the defect rather than the defect itself", () =>
    Effect.gen(function*() {
      const { proxyLines } = yield* callOverRpc(() => Effect.fail(upstream as never))

      expect(proxyLines.length).toBeGreaterThan(0)
      for (const line of proxyLines) {
        expect(render(line.message)).not.toContain(secret)
      }
      expect(proxyLines.some((line) => render(line.message).includes("[REDACTED]"))).toBe(true)
    }))

  effect("guards a defect the body raised itself, not only the engine's own", () =>
    Effect.gen(function*() {
      const { exit, proxyLines } = yield* callOverRpc(() => Effect.die(upstream))

      for (const line of proxyLines) {
        expect(render(line.message)).not.toContain(secret)
      }
      expect(defectOf(exit)).toBeInstanceOf(FlowProxyServer.FlowHandlerDefect)
      expect(wireForm(defectOf(exit))).not.toContain(secret)
    }))
})

/**
 * An HTTP client error message carries credentials in more spellings than a
 * bearer token or a `key=value` pair: a Basic authorization header, a cookie
 * header, URL userinfo, and a signed query string. Each must be redacted
 * before the diagnostic reaches the remote caller.
 */
describe("a handler defect whose message spells a credential another way", () => {
  const spellings = [
    ["a Basic authorization header", "Authorization: Basic dXNlcjpzM2NyZXQ=", "dXNlcjpzM2NyZXQ="],
    ["a lone Basic credential", "sent basic dXNlcjpzM2NyZXQ= upstream", "dXNlcjpzM2NyZXQ="],
    ["a cookie header", "cookie: session=abcSECRET; theme=dark", "abcSECRET"],
    ["a cookie pair", "cookie=session=abcSECRET", "abcSECRET"],
    ["a set-cookie header", "Set-Cookie: sid=abcSECRET; Path=/", "abcSECRET"],
    ["a quoted authorization field", "{\"authorization\":\"Token abcSECRET\"}", "abcSECRET"],
    ["URL userinfo", "GET https://user:hunter2@api.example.com/v1 failed", "hunter2"],
    ["a key query parameter", "GET https://api.example.com/v1?key=sk-live-SECRET failed", "sk-live-SECRET"],
    ["a signature query parameter", "GET https://b.example.com/o?X-Amz-Signature=abcSECRET&x=1", "abcSECRET"],
    ["a credential pair", "credential=abcSECRET", "abcSECRET"],
    ["a private key pair", "private_key: abcSECRET", "abcSECRET"]
  ] as const

  for (const [name, message, leaked] of spellings) {
    effect(`redacts ${name}`, () =>
      Effect.gen(function*() {
        const { exit, proxyLines } = yield* callOverRpc(() => Effect.die(new Error(message)))

        const refusal = defectOf(exit) as FlowProxyServer.FlowHandlerDefect
        expect(refusal).toBeInstanceOf(FlowProxyServer.FlowHandlerDefect)
        // `[REDACTED]`, or a typed marker such as `[REDACTED_TOKEN]`.
        expect(refusal.diagnostic).toContain("[REDACTED")
        expect(refusal.diagnostic).not.toContain(leaked)
        expect(wireForm(refusal)).not.toContain(leaked)
        for (const line of proxyLines) {
          expect(render(line.message)).not.toContain(leaked)
        }
      }))
  }
})
