import * as Channels from "@smthrs/control/Channels"
import * as Control from "@smthrs/control/Control"
import { Unauthorized } from "@smthrs/control/ControlError"
import { Effect, Layer, Redacted, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Core from "../src/core/Channel.ts"
import { readHeader } from "../src/core/JsonPath.ts"
import { computeHmacSha256Hex, GITHUB_SIGNATURE_PREFIX, verifySignature } from "../src/core/Signature.ts"

const SECRET = "shared-secret-correct"
const WRONG_SECRET = "shared-secret-wrong"
const CREDENTIAL = Redacted.make({ id: "signed-webhook", name: "signed-webhook" })
const accepted = { _tag: "Accepted" as const, receiptId: "receipt" }

/** A real `Channels` coordinator over a Control that records what it is asked. */
const controlLayer = (calls: Array<string>) =>
  Layer.succeed(
    Control.Control,
    Control.make({
      plan: () => {
        calls.push("plan")
        return Effect.succeed({
          planId: "plan",
          flowId: "flow",
          digest: "digest",
          inputSummary: "input",
          envelope: { capabilities: [], flows: [], budget: {} },
          deployClass: false,
          nodes: [],
          approval: {
            target: {
              _tag: "Plan",
              planId: "plan",
              digest: "digest",
              envelope: { capabilities: [], flows: [], budget: {} }
            },
            scope: "run",
            idempotencyKey: "approve:plan"
          }
        })
      },
      run: () => {
        calls.push("run")
        return Effect.succeed(accepted)
      },
      signal: () => {
        calls.push("signal")
        return Effect.succeed(accepted)
      },
      approve: () => Effect.die("unused"),
      deny: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      watch: () => Stream.empty
    })
  )

const ingest = (
  channel: Channels.Channel,
  raw: Channels.RawInbound,
  calls: Array<string> = []
): Promise<{ readonly _tag: "Success" | "Failure" }> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const channels = yield* Channels.Channels
      yield* channels.register(channel)
      return yield* Effect.exit(channels.ingest({ channel: channel.name, raw }))
    }).pipe(
      Effect.provide(Channels.layerMemory.pipe(Layer.provide(controlLayer(calls))))
    )
  )

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  const body = Effect.flatMap(Channels.Channels, (channels) => channels.register(signedChannel()))
  // @ts-expect-error Channels.layerMemory needs Control, which only controlLayer provides
  Effect.runPromise(body.pipe(Effect.provide(Channels.layerMemory)))
  Effect.runPromise(body.pipe(Effect.provide(Channels.layerMemory.pipe(Layer.provide(controlLayer([]))))))
}

/**
 * Ingests the same delivery twice through ONE `Channels` instance.
 *
 * Building the layer per call would give each ingest its own replay set, which
 * is exactly the thing this helper exists to not do.
 */
const ingestTwice = (
  channel: Channels.Channel,
  raw: Channels.RawInbound,
  calls: Array<string> = []
): Promise<ReadonlyArray<{ readonly _tag: string }>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const channels = yield* Channels.Channels
      yield* channels.register(channel)
      const first = yield* channels.ingest({ channel: channel.name, raw })
      const second = yield* channels.ingest({ channel: channel.name, raw })
      return [first, second]
    }).pipe(
      Effect.provide(Channels.layerMemory.pipe(Layer.provide(controlLayer(calls)))),
      // Both deliveries verify, so a control failure here is a defect in the
      // test rather than an outcome worth asserting on.
      Effect.orDie
    )
  ) as Promise<ReadonlyArray<{ readonly _tag: string }>>

const bytes = (value: string) => new TextEncoder().encode(value)

// A channel over the package's `sha256=` HMAC verifier, keyed by its own
// delivery header: the shape every signed webhook channel here shares.
const signedChannel = (secret = SECRET, route = Core.startFlow("triage")) =>
  Core.make({
    name: "signed",
    credential: CREDENTIAL,
    secret: Core.constantSecret(Redacted.make(secret)),
    fingerprintHeaders: ["x-delivery"],
    verify: (raw, value) =>
      verifySignature({
        payload: raw.body,
        secret: value,
        signature: readHeader(raw, "x-signature-256"),
        prefix: GITHUB_SIGNATURE_PREFIX
      }),
    decode: (raw, payload) => ({
      source: "signed",
      eventName: "integration:signed:issues.opened",
      correlationId: null,
      payload: payload as never,
      dedupeKey: readHeader(raw, "x-delivery") ?? "",
      receivedAtMs: 1
    }),
    route
  })

const signedHeaders = (signature: string, deliveryId = "delivery-1") => ({
  "x-delivery": deliveryId,
  "x-signature-256": signature
})

const signedDelivery = (body: string, signature: string, deliveryId = "delivery-1"): Channels.RawInbound => ({
  body: bytes(body),
  headers: signedHeaders(signature, deliveryId),
  idempotencyKey: `signed:${deliveryId}`
})

const ISSUE_BODY = JSON.stringify({
  action: "opened",
  issue: { number: 12 },
  repository: { full_name: "smithersai/smithers" }
})

// This is the requirement the 0.x end-to-end fault case `case17-webhook-bad-signature`
// pinned against the deleted gateway. The gateway is gone; the requirement is
// not, so it is re-pinned here against the channel that replaced it.
describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects a Channels layer whose control provider was removed", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})

describe("case 17: a WebhookChannel bound with the sha256 verifier rejects a bad signature", () => {
  it("refuses a sha256= signature computed with a different secret", async () => {
    const calls: Array<string> = []
    const signature = `sha256=${computeHmacSha256Hex(ISSUE_BODY, WRONG_SECRET)}`
    const exit = await ingest(signedChannel(), signedDelivery(ISSUE_BODY, signature), calls)
    expect(exit._tag).toBe("Failure")
    // Verification is the amplification guard: nothing downstream ran.
    expect(calls).toEqual([])
  })

  it("reports the refusal as Unauthorized and names no digest", async () => {
    const exit = await ingest(
      signedChannel(),
      signedDelivery(ISSUE_BODY, `sha256=${computeHmacSha256Hex(ISSUE_BODY, WRONG_SECRET)}`)
    )
    const failure = JSON.stringify(exit)
    expect(failure).toContain("unauthorized")
    expect(failure).not.toContain(computeHmacSha256Hex(ISSUE_BODY, SECRET))
  })

  // The near-miss case: a digest correct except for its last character is what
  // a byte-at-a-time timing attack produces, and the constant-time compare in
  // `core/Signature` is what makes it indistinguishable from any other miss.
  it("refuses a digest that differs only in its final character", async () => {
    const digest = computeHmacSha256Hex(ISSUE_BODY, SECRET)
    const tampered = `sha256=${digest.slice(0, -1)}${digest.endsWith("a") ? "b" : "a"}`
    const exit = await ingest(signedChannel(), signedDelivery(ISSUE_BODY, tampered))
    expect(exit._tag).toBe("Failure")
  })

  it("refuses a delivery with no signature header at all", async () => {
    const exit = await ingest(signedChannel(), {
      body: bytes(ISSUE_BODY),
      headers: { "x-delivery": "delivery-1" },
      idempotencyKey: "delivery-1"
    })
    expect(exit._tag).toBe("Failure")
  })

  it("accepts the correctly signed delivery and starts the flow", async () => {
    const calls: Array<string> = []
    const signature = `sha256=${computeHmacSha256Hex(ISSUE_BODY, SECRET)}`
    const exit = await ingest(signedChannel(), signedDelivery(ISSUE_BODY, signature), calls)
    expect(exit._tag).toBe("Success")
    expect(calls).toEqual(["plan", "run"])
  })
})

// The 0.x `deliverEvents` pinned "dedupes redeliveries by (source,
// dedupeKey)". `deliverEvents` is gone; a webhook provider still retries a
// delivery it did not see acknowledged, so the requirement moved to the
// channel and is pinned here rather than assumed.
describe("redelivery", () => {
  it("applies a correctly signed delivery once and reports the retry as AlreadyApplied", async () => {
    const calls: Array<string> = []
    const signature = `sha256=${computeHmacSha256Hex(ISSUE_BODY, SECRET)}`
    const receipts = await ingestTwice(signedChannel(), signedDelivery(ISSUE_BODY, signature), calls)
    // The second delivery carries the same delivery id, so it is the same
    // key and must not start a second run.
    expect(calls).toEqual(["plan", "run"])
    expect(receipts[0]?._tag).toBe("Accepted")
    expect(receipts[1]?._tag).toBe("AlreadyApplied")
  })

  // The second delivery differs only in its delivery id, so the two keys
  // differ.
  it("treats a different delivery id as a new delivery", async () => {
    const calls: Array<string> = []
    const signature = `sha256=${computeHmacSha256Hex(ISSUE_BODY, SECRET)}`
    const channel = signedChannel()
    const first = signedDelivery(ISSUE_BODY, signature)
    const second = signedDelivery(ISSUE_BODY, signature, "delivery-2")
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    const receipts = await Effect.runPromise(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        const accepted = yield* channels.ingest({ channel: channel.name, raw: first })
        const next = yield* channels.ingest({ channel: channel.name, raw: second })
        return [accepted, next]
      }).pipe(
        Effect.provide(Channels.layerMemory.pipe(Layer.provide(controlLayer(calls)))),
        Effect.orDie
      )
    )
    expect(calls).toEqual(["plan", "run", "plan", "run"])
    expect(receipts.map((receipt) => receipt._tag)).toEqual(["Accepted", "Accepted"])
  })
})

describe("secret resolution", () => {
  it("resolves through the control plane's credential store", async () => {
    const resolver = Core.credentialSecret({
      list: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      resolve: (reference) => Effect.succeed(Redacted.make(`secret-for-${reference.id}`)),
      rotate: () => Effect.die("unused"),
      revoke: () => Effect.die("unused")
    })
    const secret = await Effect.runPromise(resolver(CREDENTIAL))
    expect(Redacted.value(secret)).toBe("secret-for-signed-webhook")
  })

  it("reports an unresolvable credential as Unauthorized", async () => {
    const resolver = Core.credentialSecret({
      list: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      resolve: () => Effect.fail(new Unauthorized({ message: "denied" })),
      rotate: () => Effect.die("unused"),
      revoke: () => Effect.die("unused")
    })
    const failure = await Effect.runPromise(Effect.flip(resolver(CREDENTIAL)))
    expect(failure.message).toBe("denied")
  })
})

describe("a channel refuses rather than dies", () => {
  const raw = (): Channels.RawInbound => ({
    body: bytes(ISSUE_BODY),
    headers: signedHeaders(`sha256=${computeHmacSha256Hex(ISSUE_BODY, SECRET)}`),
    idempotencyKey: "delivery-1"
  })

  const custom = (config: Partial<Core.Config>) =>
    Core.make({
      name: "custom",
      credential: CREDENTIAL,
      secret: Core.constantSecret(Redacted.make(SECRET)),
      verify: () => true,
      decode: (_raw, payload) => ({
        source: "custom",
        eventName: "integration:custom:thing",
        correlationId: null,
        payload: payload as never,
        dedupeKey: "d1",
        receivedAtMs: 1
      }),
      route: Core.startFlow("triage"),
      ...config
    })

  // An application-supplied verifier is ordinary code. A throw is a refusal,
  // not a defect that kills the ingress fiber.
  it("treats a throwing verifier as a failed verification", async () => {
    const exit = await ingest(
      custom({
        verify: () => {
          throw new TypeError("verifier bug")
        }
      }),
      raw()
    )
    expect(exit._tag).toBe("Failure")
    // The internal message does not cross to the control plane.
    expect(JSON.stringify(exit)).not.toContain("verifier bug")
  })

  it("reports a decoder that throws a plain error without quoting it", async () => {
    const exit = await ingest(
      custom({
        decode: () => {
          throw new TypeError("cannot read properties of undefined")
        }
      }),
      raw()
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("custom webhook payload could not be decoded")
    expect(JSON.stringify(exit)).not.toContain("cannot read properties")
  })

  // `ExternalEvent.decode` was documented as the ingress validator and called
  // by nothing, so a decoder bug surfaced as a malformed signal three hops on.
  it("refuses an event the decoder built wrong", async () => {
    const calls: Array<string> = []
    const exit = await ingest(
      custom({
        decode: (_raw, payload) => ({
          source: "",
          eventName: "integration:custom:thing",
          correlationId: null,
          payload: payload as never,
          dedupeKey: "d1",
          receivedAtMs: 1
        })
      }),
      raw(),
      calls
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("malformed event")
    expect(calls).toEqual([])
  })
})
