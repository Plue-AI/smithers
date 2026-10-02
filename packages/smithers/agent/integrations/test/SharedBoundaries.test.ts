import { Effect, Redacted } from "effect"
import { afterEach, expect, it, vi } from "vitest"
import * as AccessToken from "../src/core/AccessToken.ts"
import * as Channel from "../src/core/Channel.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import { readHeader } from "../src/core/JsonPath.ts"
import { computeHmacSha256Hex, verifySignature } from "../src/core/Signature.ts"

afterEach(() => vi.restoreAllMocks())
const event = {
  source: "example",
  eventName: "integration:example:opened",
  correlationId: null,
  payload: {},
  dedupeKey: "one",
  receivedAtMs: 1
}

it("invalidating a fixed access token retains its exact redacted identity", async () => {
  const secret = Redacted.make("private token")
  const source = AccessToken.fixed(secret)
  expect(await Effect.runPromise(source.token)).toBe(secret)
  await Effect.runPromise(source.invalidate)
  expect(await Effect.runPromise(source.token)).toBe(secret)
  expect(String(secret)).not.toContain("private token")
})

it("matches transport-neutral header names case insensitively", () => {
  expect(readHeader({ headers: { "X-DELIVERY": "upper" } }, "x-delivery")).toBe("upper")
  expect(readHeader({ headers: { "x-delivery": "lower", "X-DELIVERY": "upper" } }, "X-Delivery")).toBe("lower")
  expect(readHeader({ headers: {} }, "x-delivery")).toBeUndefined()
})

it("maps a validated shared event to the explicitly selected waiting run", async () => {
  expect(await Effect.runPromise(Channel.signalRun("run-one")(event))).toMatchObject({
    _tag: "Signal",
    runId: "run-one",
    signal: { name: event.eventName }
  })
})

it("preserves a provider-safe decoder refusal through the shared channel", async () => {
  const channel = Channel.make({
    name: "signed",
    credential: Redacted.make({ id: "one", name: "one" }),
    secret: Channel.constantSecret(Redacted.make("secret")),
    verify: () => true,
    decode: () => {
      throw new IntegrationError("decode-failed", "invalid event")
    },
    route: Channel.startFlow("triage")
  })
  const failure = await Effect.runPromise(
    Effect.flip(channel.decode({ body: new TextEncoder().encode("{}"), headers: {}, idempotencyKey: "one" }))
  )
  expect(failure).toMatchObject({ _tag: "/control/InvalidInput", issue: "invalid event" })
})

it("refuses a signature if the byte decoder fails instead of killing the ingress", () => {
  const signature = Buffer.from(computeHmacSha256Hex("body", "secret"), "hex").toString("base64")
  const from = Buffer.from
  vi.spyOn(Buffer, "from").mockImplementation(
    ((value: any, encoding: any) => {
      if (encoding === "base64") throw new Error("decoder unavailable")
      return from(value, encoding)
    }) as typeof Buffer.from
  )
  expect(verifySignature({ payload: "body", secret: "secret", signature })).toBe(false)
})

it("projects nothing by default while preserving a stable run cursor", () => {
  const channel = Channel.make({
    name: "signed",
    credential: Redacted.make({ id: "one", name: "one" }),
    secret: Channel.constantSecret(Redacted.make("secret")),
    verify: () => true,
    decode: () => event,
    route: Channel.startFlow("triage")
  })
  expect(channel.project({ updatedAt: 123 } as Parameters<typeof channel.project>[0], { cursor: "old" }))
    .toEqual({ cursor: "123", operation: "noop", message: null })
})
