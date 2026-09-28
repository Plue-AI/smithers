import * as ControlChannels from "@smthrs/control/Channels"
import * as Control from "@smthrs/control/Control"
import { InvalidInput } from "@smthrs/control/ControlError"
import type { CredentialRef } from "@smthrs/control/Credential"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { describe, expect, it } from "vitest"
import { TriggerError } from "../src/TriggerError.ts"
import * as Webhook from "../src/Webhook.ts"

const Payload = Schema.Union([
  Schema.TaggedStruct("start", {
    flowId: Schema.String,
    input: Schema.Unknown
  }),
  Schema.TaggedStruct("signal", {
    runId: Schema.String,
    stepId: Schema.String,
    value: Schema.Json
  })
])

type Payload = typeof Payload.Type

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

// Every `Uint8Array` shape a host hands a webhook. A Node `Buffer` is the one
// that matters: its `slice` is an alias of `subarray`, so a copy taken with
// `slice()` still shares the caller's memory. The offset view checks that a
// copy takes only the viewed range, and the shared view that it leaves shared
// memory.
const bodyKinds: ReadonlyArray<readonly [name: string, bytes: (text: string) => Uint8Array]> = [
  ["Uint8Array", encode],
  ["Buffer", (text) => Buffer.from(text)],
  ["offset Buffer view", (text) => {
    const padded = Buffer.from(`<<<<${text}>>>>`)
    return padded.subarray(4, 4 + Buffer.byteLength(text))
  }],
  ["SharedArrayBuffer view", (text) => {
    const bytes = encode(text)
    const view = new Uint8Array(new SharedArrayBuffer(bytes.length))
    view.set(bytes)
    return view
  }]
]

const raw = (
  body: unknown,
  idempotencyKey: string,
  signature = "valid",
  bytes: (text: string) => Uint8Array = encode
) => ({
  body: bytes(JSON.stringify(body)),
  headers: { "x-signature": signature },
  idempotencyKey
})

const credential = Redacted.make<CredentialRef>({ id: "events-secret", name: "events" })

const declaration = (
  calls: Array<string>,
  onInbound: () => void = () => undefined
) => ({
  name: "events",
  schema: Payload,
  credential,
  verify: Webhook.makeSignatureVerifier({
    header: "x-signature",
    expected: (body: Uint8Array, ref: Redacted.Redacted<CredentialRef>) => {
      calls.push(`verify:${Redacted.value(ref).id}:${new TextDecoder().decode(body)}`)
      return Effect.succeed(new TextEncoder().encode("valid"))
    }
  }),
  inbound: (payload: Payload) => {
    onInbound()
    return payload._tag === "start"
      ? { start: { flowId: payload.flowId, input: payload.input } }
      : {
        signal: {
          runId: payload.runId,
          stepId: payload.stepId,
          value: payload.value
        }
      }
  }
})

const controlLayer = (calls: Array<string>) =>
  Layer.succeed(
    Control.Control,
    Control.make({
      plan: (input) =>
        Effect.sync(() => {
          calls.push(`plan:${input.flowId}`)
          return {
            planId: "plan-1",
            flowId: input.flowId,
            digest: "digest",
            inputSummary: "input",
            envelope: { capabilities: [], flows: [], budget: {} },
            deployClass: false,
            nodes: [],
            approval: {
              target: {
                _tag: "Plan" as const,
                planId: "plan-1",
                digest: "digest",
                envelope: { capabilities: [], flows: [], budget: {} }
              },
              scope: "run" as const,
              idempotencyKey: "approval"
            }
          }
        }),
      run: () =>
        Effect.sync(() => {
          calls.push("run")
          return {
            _tag: "Accepted" as const,
            receiptId: "started",
            runId: "run-1"
          }
        }),
      approve: () => Effect.die("unused"),
      deny: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      signal: (input) =>
        Effect.sync(() => {
          calls.push(`signal:${input.runId}:${input.signal.name}`)
          return { _tag: "Accepted" as const, receiptId: "signalled" }
        }),
      cancel: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      watch: () => Stream.empty
    })
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, ControlChannels.Channels>,
  calls: Array<string>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(ControlChannels.layerMemory.pipe(Layer.provide(controlLayer(calls))))
    )
  )

describe("Webhook", () => {
  it("rejects an invalid signature as verification_failed before decode or planning", async () => {
    const calls: Array<string> = []
    let inbound = false
    const webhook = Webhook.make(declaration(calls, () => {
      inbound = true
    }))
    const exit = await run(
      Effect.exit(
        webhook.register.pipe(Effect.andThen(webhook.ingest({
          body: new TextEncoder().encode("{not-json"),
          headers: { "x-signature": "invalid" },
          idempotencyKey: "delivery-1"
        })))
      ),
      calls
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause)
      expect(failure).toMatchObject({ code: "verification_failed" })
    }
    expect(inbound).toBe(false)
    expect(calls.some((call) => call.startsWith("plan:"))).toBe(false)
  })

  it("returns a typed decode failure after a valid signature", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    const exit = await run(
      Effect.exit(
        webhook.register.pipe(
          Effect.andThen(webhook.ingest(raw({ _tag: "start", flowId: 42, input: {} }, "delivery-2")))
        )
      ),
      calls
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(InvalidInput)
    }
    expect(calls.some((call) => call.startsWith("plan:"))).toBe(false)
  })

  it("deduplicates repeated deliveries and maps starts and signals through Control", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    await run(
      Effect.gen(function*() {
        yield* webhook.register
        yield* webhook.ingest(
          raw({ _tag: "start", flowId: "review", input: { pr: 42 } }, "start-1")
        )
        const replay = yield* webhook.ingest(
          raw({ _tag: "start", flowId: "review", input: { pr: 42 } }, "start-1")
        )
        expect(replay._tag).toBe("AlreadyApplied")
        yield* webhook.ingest(
          raw(
            {
              _tag: "signal",
              runId: "run-1",
              stepId: "approval",
              value: true
            },
            "signal-1"
          )
        )
      }),
      calls
    )

    expect(calls.filter((call) => call === "plan:review")).toHaveLength(1)
    expect(calls.filter((call) => call === "run")).toHaveLength(1)
    expect(calls.filter((call) => call === "signal:run-1:approval")).toHaveLength(1)
  })

  it("dedups a replayed signed body only when the key comes from the signed bytes", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    const body = { _tag: "start", flowId: "review", input: { pr: 7 } }
    const bodyKey = async (bytes: Uint8Array) =>
      Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex")
    await run(
      Effect.gen(function*() {
        yield* webhook.register
        // A delivery-id header is unsigned: a replay with a fresh id starts again.
        yield* webhook.ingest(raw(body, "delivery-a"))
        const headerReplay = yield* webhook.ingest(raw(body, "delivery-b"))
        expect(headerReplay._tag).toBe("Accepted")
        // A key derived from the signed body sends the replay to the original receipt.
        const signed = raw(body, "unused")
        const key = yield* Effect.promise(() => bodyKey(signed.body))
        yield* webhook.ingest({ ...signed, idempotencyKey: key })
        const bodyReplay = yield* webhook.ingest({ ...raw(body, "unused"), idempotencyKey: key })
        expect(bodyReplay._tag).toBe("AlreadyApplied")
      }),
      calls
    )
    expect(calls.filter((call) => call === "run")).toHaveLength(3)
  })

  it("exposes no direct execution method", () => {
    const webhook = Webhook.make(declaration([]))
    expect(Object.keys(webhook).sort()).toEqual(["ingest", "name", "register"])
    expect("run" in webhook).toBe(false)
    expect("start" in webhook).toBe(false)
  })

  it("compares over the expected signature's length, never the supplied one", () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    expect(Webhook.constantTimeEqual(bytes("abc"), bytes("abc"))).toBe(true)
    expect(Webhook.constantTimeEqual(bytes("abc"), bytes("abd"))).toBe(false)
    expect(Webhook.constantTimeEqual(bytes("abc"), bytes("abcd"))).toBe(false)
    expect(Webhook.constantTimeEqual(bytes("abcd"), bytes("abc"))).toBe(false)
    expect(Webhook.constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true)
    expect(Webhook.constantTimeEqual(new Uint8Array(), bytes("a"))).toBe(false)
  })

  it("refuses an absent header and a header longer than the expected signature", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    for (
      const headers of [
        {},
        { "x-signature": "valid-and-then-some" },
        { "X-Signature": "wrong" }
      ]
    ) {
      const exit = await run(
        Effect.exit(
          webhook.register.pipe(Effect.andThen(webhook.ingest({
            body: new TextEncoder().encode("{}"),
            headers,
            idempotencyKey: `absent-${JSON.stringify(headers)}`
          })))
        ),
        calls
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toMatchObject({ code: "verification_failed" })
      }
    }
  })

  it("refuses an absent or empty header before the secret is resolved", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make({
      ...declaration(calls),
      verify: Webhook.makeSignatureVerifier({
        header: "x-signature",
        expected: () => {
          calls.push("expected")
          return Effect.succeed(new TextEncoder().encode("valid"))
        }
      })
    })
    for (const headers of [{}, { "x-signature": "" }]) {
      const exit = await run(
        Effect.exit(
          webhook.register.pipe(Effect.andThen(webhook.ingest({
            body: new TextEncoder().encode(JSON.stringify({ _tag: "start", flowId: "review", input: {} })),
            headers,
            idempotencyKey: `unsigned-${JSON.stringify(headers)}`
          })))
        ),
        calls
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toMatchObject({ code: "verification_failed" })
      }
    }
    expect(calls).not.toContain("expected")
  })

  it("refuses every request when the expected signature is empty", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make({
      ...declaration(calls),
      verify: Webhook.makeSignatureVerifier({
        header: "x-signature",
        expected: () => Effect.succeed(new Uint8Array())
      })
    })
    for (
      const headers of [
        {},
        { "x-signature": "" },
        { "x-signature": "valid" }
      ]
    ) {
      const exit = await run(
        Effect.exit(
          webhook.register.pipe(Effect.andThen(webhook.ingest({
            body: new TextEncoder().encode(JSON.stringify({ _tag: "start", flowId: "review", input: {} })),
            headers,
            idempotencyKey: `empty-expected-${JSON.stringify(headers)}`
          })))
        ),
        calls
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toMatchObject({ code: "verification_failed" })
      }
    }
    expect(calls).not.toContain("plan:review")
    expect(calls).not.toContain("run")
  })

  it("accepts the signature header under its declared casing", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make({
      ...declaration(calls),
      verify: Webhook.makeSignatureVerifier({
        header: "X-Signature",
        expected: () => Effect.succeed(new TextEncoder().encode("valid"))
      })
    })
    const receipt = await run(
      webhook.register.pipe(
        Effect.andThen(
          webhook.ingest({
            body: new TextEncoder().encode(JSON.stringify({ _tag: "start", flowId: "review", input: {} })),
            headers: { "X-Signature": "valid" },
            idempotencyKey: "cased-1"
          })
        )
      ),
      calls
    )
    expect(receipt._tag).toBe("Accepted")
  })

  // A verifier that cannot resolve its credential used to throw out of a
  // synchronous callback, which `Effect.suspend` turns into a defect that kills
  // the fiber rather than a refusal the caller can read. Its message used to be
  // forwarded verbatim, which sent the resolver's own words toward the sender
  // on the same error that answers a bad signature.
  it("reports a failing expected() as a typed refusal with a fixed message, never a defect", async () => {
    const calls: Array<string> = []
    const hostDetail = "credential events-secret could not be resolved at /secrets/events"
    const webhook = Webhook.make({
      ...declaration(calls),
      verify: Webhook.makeSignatureVerifier({
        header: "x-signature",
        expected: () => Effect.fail(new TriggerError({ code: "verification_failed", message: hostDetail }))
      })
    })
    const exit = await run(
      Effect.exit(
        webhook.register.pipe(
          Effect.andThen(webhook.ingest(raw({ _tag: "start", flowId: "review", input: {} }, "unresolved-1")))
        )
      ),
      calls
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(TriggerError)
      expect(failure).toMatchObject({
        code: "verification_failed",
        message: "webhook events did not verify the request",
        cause: { _tag: "/control/Unauthorized", message: "webhook events did not verify the request" }
      })
      expect(JSON.stringify(failure)).not.toContain(hostDetail)
    }
  })

  it("keeps the host's resolver failure in the verifier's cause, out of its message", async () => {
    const host = new TriggerError({ code: "store", message: "resolver /secrets/events is unreachable" })
    const verify = Webhook.makeSignatureVerifier({
      header: "x-signature",
      expected: () => Effect.fail(host)
    })
    const exit = await Effect.runPromise(
      Effect.exit(
        verify({ body: encode("{}"), headers: { "x-signature": "valid" }, idempotencyKey: "host-1" }, credential)
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(TriggerError)
      expect(failure).toMatchObject({
        code: "verification_failed",
        message: "webhook signature in x-signature did not verify"
      })
      expect((failure as TriggerError).cause).toBe(host)
    }
  })

  it("answers a custom verifier's refusal with the channel's fixed message", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make({
      ...declaration(calls),
      verify: () => Effect.fail(new TriggerError({ code: "verification_failed", message: "hmac key file missing" }))
    })
    const exit = await run(
      Effect.exit(
        webhook.register.pipe(
          Effect.andThen(webhook.ingest(raw({ _tag: "start", flowId: "review", input: {} }, "custom-1")))
        )
      ),
      calls
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause)
      expect(failure).toMatchObject({
        code: "verification_failed",
        message: "webhook events did not verify the request"
      })
      expect(JSON.stringify(failure)).not.toContain("hmac key file missing")
    }
  })

  it("hands the declared credential to the verifier on every request", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    await run(
      webhook.register.pipe(
        Effect.andThen(webhook.ingest(raw({ _tag: "start", flowId: "review", input: {} }, "credential-1")))
      ),
      calls
    )
    expect(calls.filter((call) => call.startsWith("verify:events-secret:"))).toHaveLength(1)
  })

  // `ingest` no longer registers: a channel nobody registered used to
  // self-register on first traffic, which defeats the failure that reports an
  // unknown door.
  it("refuses traffic to a channel that was never registered", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    const exit = await run(
      Effect.exit(webhook.ingest(raw({ _tag: "start", flowId: "review", input: {} }, "unregistered-1"))),
      calls
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "/control/Unavailable" })
    }
    expect(calls).toHaveLength(0)
  })

  // Verification, delivery fingerprinting, and decoding must all read one
  // private snapshot. Without it a verifier that edits the bytes it was handed
  // authenticates one payload and has another decoded.
  it.each(bodyKinds)(
    "decodes the bytes it authenticated even when the verifier rewrites them (%s)",
    async (_, bytes) => {
      const calls: Array<string> = []
      const webhook = Webhook.make({
        ...declaration(calls),
        verify: Webhook.makeSignatureVerifier({
          header: "x-signature",
          expected: (body) =>
            Effect.sync(() => {
              body.fill(0)
              return encode("valid")
            })
        })
      })
      const payload = { _tag: "start", flowId: "review", input: { pr: 7 } }
      const request = raw(payload, "mutating-1", "valid", bytes)
      await run(webhook.register.pipe(Effect.andThen(webhook.ingest(request))), calls)
      expect(calls).toContain("plan:review")
      expect(new TextDecoder().decode(request.body)).toBe(JSON.stringify(payload))
    }
  )

  it.each(bodyKinds)(
    "ignores a caller mutating its own request between building and running ingest (%s)",
    async (_, bytes) => {
      const calls: Array<string> = []
      const webhook = Webhook.make(declaration(calls))
      const payload = { _tag: "start", flowId: "review", input: { pr: 7 } }
      const request = raw(payload, "swapped-1", "valid", bytes)
      const pending = webhook.ingest(request)
      request.body.fill(0)
      request.headers["x-signature"] = "tampered"
      await run(webhook.register.pipe(Effect.andThen(pending)), calls)
      expect(calls).toContain(`verify:events-secret:${JSON.stringify(payload)}`)
      expect(calls).toContain("plan:review")
    }
  )

  it.each(bodyKinds)("hands expected() a copy that owns its memory (%s)", async (_, bytes) => {
    const text = JSON.stringify({ _tag: "start", flowId: "review", input: {} })
    const body = bytes(text)
    let copy: Uint8Array | undefined
    const verify = Webhook.makeSignatureVerifier({
      header: "x-signature",
      expected: (handed) =>
        Effect.sync(() => {
          copy = handed
          handed.fill(120)
          return encode("valid")
        })
    })
    await Effect.runPromise(
      verify({ body, headers: { "x-signature": "valid" }, idempotencyKey: "owned-1" }, credential)
    )
    expect(new TextDecoder().decode(body)).toBe(text)
    expect(copy?.length).toBe(body.length)
    expect(copy?.buffer).not.toBeInstanceOf(SharedArrayBuffer)
    expect(Buffer.isBuffer(copy)).toBe(false)
  })

  it("reports a signal payload that is not JSON as invalid input", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make({
      ...declaration(calls),
      schema: Schema.Struct({ runId: Schema.String }),
      inbound: (payload: { readonly runId: string }) => ({
        signal: { runId: payload.runId, stepId: "approval", value: () => undefined }
      })
    })
    const exit = await run(
      Effect.exit(
        webhook.register.pipe(Effect.andThen(webhook.ingest(raw({ runId: "run-1" }, "unserializable-1"))))
      ),
      calls
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(InvalidInput)
    }
    expect(calls.some((call) => call.startsWith("signal:"))).toBe(false)
  })

  it("projects run state outbound only when the declaration asks for it", async () => {
    const calls: Array<string> = []
    const summary = { runId: "run-1", status: "running", updatedAt: 42 } as never
    const projections = await run(
      Effect.gen(function*() {
        const channels = yield* ControlChannels.Channels
        const silent = Webhook.make(declaration(calls))
        const speaking = Webhook.make({
          ...declaration(calls),
          name: "loud",
          outbound: (projected: { readonly status: string }) => `status:${projected.status}`
        })
        yield* silent.register
        yield* speaking.register
        return {
          silent: yield* channels.project({ channel: "events", run: summary }),
          speaking: yield* channels.project({ channel: "loud", run: summary })
        }
      }),
      calls
    )
    expect(projections.silent).toMatchObject({ cursor: "42", operation: "noop", message: null })
    expect(projections.speaking).toMatchObject({
      cursor: "42",
      operation: "post",
      message: "status:running"
    })
  })

  it("registers the declared schema rather than an unknown one", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    const registered = await run(
      Effect.gen(function*() {
        const channels = yield* ControlChannels.Channels
        yield* webhook.register
        return yield* channels.lookup("events")
      }),
      calls
    )
    expect(registered.schema).toBe(Payload)
  })
})
