import { Effect, Layer } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import { Unauthorized } from "../src/ControlError.ts"
import { anyAuthenticator, bearerAuthenticator, ControlRpcs, layerAuth } from "../src/ControlRpcs.ts"
import * as ControlServer from "../src/ControlServer.ts"
import * as ScopedToken from "../src/ScopedToken.ts"
import * as TestControl from "../src/test/TestControl.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"

const key = "gateway-root-secret"
const scoped = { id: "gateway", kind: "scoped" }

const minted = (options: Partial<ScopedToken.MintOptions> = {}) =>
  Effect.runPromise(ScopedToken.mint({ key, scopes: ["read:runs"], ttlMillis: 60_000, now: () => 1_000, ...options }))

describe("minting and verifying", () => {
  it("round-trips the claims it signed and expires at now + ttl", async () => {
    const { claims, token } = await minted({ scopes: ["read:runs", "approve:runs"], runId: "run-1", flowId: "demo" })

    expect(token.startsWith("smt1.")).toBe(true)
    expect(token.split(".")).toHaveLength(3)
    expect(claims).toMatchObject({
      v: 1,
      procedures: ["List", "Watch", "Projection.Snapshot", "Projection.Subscribe", "Approve", "Deny", "Approval.Submit"],
      runId: "run-1",
      flowId: "demo",
      iat: 1_000,
      exp: 61_000
    })
    expect(await Effect.runPromise(ScopedToken.verify(key, token, 60_999))).toEqual(claims)
  })

  it("gives two tokens of the same grant different identities", async () => {
    const [first, second] = await Promise.all([minted(), minted()])
    expect(first.claims.id).not.toBe(second.claims.id)
    expect(first.token).not.toBe(second.token)
  })

  it("names each procedure once when scopes overlap", () => {
    expect(ScopedToken.procedures(["read:runs", "read:runs", "write:runs"])).toEqual([
      "List",
      "Watch",
      "Projection.Snapshot",
      "Projection.Subscribe",
      "Plan",
      "Run",
      "Steer",
      "Signal",
      "Cancel",
      "Resume"
    ])
    expect(ScopedToken.scopeNames).toEqual(["read:runs", "write:runs", "approve:runs"])
  })

  it("refuses an expired, forged, tampered, foreign-key, or malformed token alike", async () => {
    const { token } = await minted()
    const [head, body, signature] = token.split(".") as [string, string, string]
    const tamperedBody = Buffer.from(JSON.stringify({
      v: 1,
      id: "x",
      procedures: ["Approve"],
      iat: 1_000,
      exp: 61_000
    })).toString("base64url")
    const refusals = await Promise.all([
      ScopedToken.verify(key, token, 61_000),
      ScopedToken.verify(key, token, 100_000),
      ScopedToken.verify("another-secret", token, 2_000),
      ScopedToken.verify("", token, 2_000),
      ScopedToken.verify(key, `${head}.${tamperedBody}.${signature}`, 2_000),
      ScopedToken.verify(key, `${head}.${body}.${signature.slice(0, -2)}AA`, 2_000),
      ScopedToken.verify(key, `smt0.${body}.${signature}`, 2_000),
      ScopedToken.verify(key, `${head}.${body}`, 2_000),
      ScopedToken.verify(key, `${head}..${signature}`, 2_000),
      ScopedToken.verify(key, `${head}.${body}.%%%`, 2_000),
      ScopedToken.verify(key, "", 2_000),
      ScopedToken.verify(key, key, 2_000)
    ].map((attempt) => Effect.runPromise(Effect.flip(attempt))))

    expect(refusals).toHaveLength(12)
    expect(refusals.every((error) => error instanceof Unauthorized)).toBe(true)
    expect(refusals[0]!.message).toBe("The scoped token has expired")
    expect(refusals[2]!.message).toBe("A valid scoped token is required")
  })

  it("refuses a signed body that is not a claims document", async () => {
    // Signed under the right key, so only the claims check can refuse it.
    const sign = async (text: string) => {
      const encoder = new TextEncoder()
      const hmac = await crypto.subtle.importKey(
        "raw",
        encoder.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
      const body = Buffer.from(text).toString("base64url")
      const signature = Buffer.from(await crypto.subtle.sign("HMAC", hmac, encoder.encode(`smt1.${body}`)))
      return `smt1.${body}.${signature.toString("base64url")}`
    }
    for (const text of ["not json", "[]", JSON.stringify({ v: 2, id: "x", procedures: [], iat: 0, exp: 10 })]) {
      const refused = await Effect.runPromise(Effect.flip(ScopedToken.verify(key, await sign(text), 1)))
      expect(refused).toBeInstanceOf(Unauthorized)
    }
  })

  it("dies rather than mint a token nobody should hold", async () => {
    for (
      const options of [
        { key: "" },
        { scopes: [] as Array<ScopedToken.Scope> },
        { ttlMillis: 0 },
        { ttlMillis: -1 },
        { ttlMillis: Number.NaN }
      ]
    ) {
      await expect(minted(options)).rejects.toThrow()
    }
  })
})

describe("what claims authorize", () => {
  const claims = (overrides: Partial<ScopedToken.Claims>): ScopedToken.Claims => ({
    v: 1,
    id: "claims",
    procedures: ["List", "Cancel", "Approve", "Projection.Snapshot", "Plan"],
    iat: 0,
    exp: 1,
    ...overrides
  })

  it("admits only the named procedures", () => {
    expect(ScopedToken.authorizes(claims({}), { rpc: "List", payload: { _tag: "runs" } })).toBe(true)
    expect(ScopedToken.authorizes(claims({}), { rpc: "Watch", payload: {} })).toBe(false)
    expect(ScopedToken.authorizes(claims({ procedures: [] }), { rpc: "List", payload: {} })).toBe(false)
  })

  it("confines a run token to calls that name that run, wherever the schema puts it", () => {
    const confined = claims({ runId: "run-1" })
    expect(ScopedToken.authorizes(confined, { rpc: "Cancel", payload: { runId: "run-1" } })).toBe(true)
    expect(ScopedToken.authorizes(confined, { rpc: "Cancel", payload: { runId: "run-2" } })).toBe(false)
    expect(ScopedToken.authorizes(confined, {
      rpc: "Approve",
      payload: { target: { _tag: "Node", runId: "run-1" } }
    })).toBe(true)
    expect(ScopedToken.authorizes(confined, {
      rpc: "Approve",
      payload: { target: { _tag: "Plan", planId: "plan-1" } }
    })).toBe(false)
    expect(ScopedToken.authorizes(confined, {
      rpc: "Projection.Snapshot",
      payload: { selector: { _tag: "run-summary", runId: "run-1" } }
    })).toBe(true)
    expect(ScopedToken.authorizes(confined, {
      rpc: "Projection.Snapshot",
      payload: { selector: { _tag: "workspace-runs" } }
    })).toBe(false)
    expect(ScopedToken.authorizes(confined, { rpc: "List", payload: { _tag: "runs", filters: { runId: "run-1" } } }))
      .toBe(true)
    // An unfiltered listing is refused rather than widened.
    expect(ScopedToken.authorizes(confined, { rpc: "List", payload: { _tag: "runs" } })).toBe(false)
    expect(ScopedToken.authorizes(confined, { rpc: "List", payload: null })).toBe(false)
    expect(ScopedToken.authorizes(confined, { rpc: "List", payload: "run-1" })).toBe(false)
  })

  it("confines a flow token to calls that name that flow", () => {
    const confined = claims({ flowId: "demo" })
    expect(ScopedToken.authorizes(confined, { rpc: "Plan", payload: { flowId: "demo", input: {} } })).toBe(true)
    expect(ScopedToken.authorizes(confined, { rpc: "Plan", payload: { flowId: "other", input: {} } })).toBe(false)
    expect(ScopedToken.authorizes(confined, { rpc: "List", payload: { _tag: "runs", filters: { flowId: "demo" } } }))
      .toBe(true)
    expect(ScopedToken.authorizes(confined, { rpc: "List", payload: { _tag: "flows" } })).toBe(false)
  })

  it("requires both confinements when both are set", () => {
    const confined = claims({ runId: "run-1", flowId: "demo" })
    expect(ScopedToken.authorizes(confined, {
      rpc: "List",
      payload: { _tag: "runs", filters: { runId: "run-1", flowId: "demo" } }
    })).toBe(true)
    expect(ScopedToken.authorizes(confined, { rpc: "List", payload: { _tag: "runs", filters: { runId: "run-1" } } }))
      .toBe(false)
  })
})

describe("the authenticator", () => {
  it("admits a valid token at an edge that knows no call, and checks the call in band", async () => {
    const { token } = await minted({ runId: "run-1" })
    const authenticator = ScopedToken.authenticator({ key, principal: scoped, now: () => 5_000 })
    const headers = { authorization: `Bearer ${token}` }

    expect(await Effect.runPromise(authenticator.authenticate(headers))).toEqual({ ...scoped, stampedAt: 5_000 })
    expect(await Effect.runPromise(authenticator.authenticate(headers, { rpc: "List", payload: { runId: "run-1" } })))
      .toEqual({ ...scoped, stampedAt: 5_000 })
    const refused = await Effect.runPromise(
      Effect.flip(authenticator.authenticate(headers, { rpc: "Cancel", payload: { runId: "run-1" } }))
    )
    expect(refused).toBeInstanceOf(Unauthorized)
    expect(refused.message).toBe("The scoped token does not authorize Cancel")
  })

  it("refuses a missing credential, the root bearer itself, and an expired token", async () => {
    const { token } = await minted()
    const authenticator = ScopedToken.authenticator({ key, principal: scoped, now: () => 61_000 })
    const refusals = await Promise.all([
      authenticator.authenticate({}),
      authenticator.authenticate({ authorization: `Bearer ${key}` }),
      authenticator.authenticate({ authorization: "Basic smt1.x.y" }),
      authenticator.authenticate({ authorization: `Bearer ${token}` })
    ].map((attempt) => Effect.runPromise(Effect.flip(attempt))))
    expect(refusals.every((error) => error instanceof Unauthorized)).toBe(true)
    expect(refusals[3]!.message).toBe("The scoped token has expired")
  })

  it("stamps the host clock when the composition names none", async () => {
    const { token } = await minted({ now: () => Date.now() })
    const before = Date.now()
    const principal = await Effect.runPromise(
      ScopedToken.authenticator({ key, principal: scoped }).authenticate({ authorization: `Bearer ${token}` })
    )
    expect(principal.stampedAt).toBeGreaterThanOrEqual(before)
    expect(principal.stampedAt).toBeLessThanOrEqual(Date.now())
  })
})

describe("anyAuthenticator", () => {
  it("answers with the first authenticator that accepts, and refuses when none does", async () => {
    const { token } = await minted()
    const both = anyAuthenticator([
      bearerAuthenticator({ token: key, principal: { id: "gateway", kind: "bearer" }, now: () => 7 }),
      ScopedToken.authenticator({ key, principal: scoped, now: () => 7 })
    ])
    expect(await Effect.runPromise(both.authenticate({ authorization: `Bearer ${key}` })))
      .toEqual({ id: "gateway", kind: "bearer", stampedAt: 7 })
    expect(await Effect.runPromise(both.authenticate({ authorization: `Bearer ${token}` })))
      .toEqual({ id: "gateway", kind: "scoped", stampedAt: 7 })
    const refused = await Effect.runPromise(Effect.flip(both.authenticate({ authorization: "Bearer nope" })))
    expect(refused).toBeInstanceOf(Unauthorized)
    expect(refused.message).toBe("A valid scoped token is required")
    const empty = await Effect.runPromise(Effect.flip(anyAuthenticator([]).authenticate({ authorization: "Bearer x" })))
    expect(empty.message).toBe("A valid bearer credential is required")
  })
})

describe("a minted token on the control RPC boundary", () => {
  let now = 1_000
  const root = { id: "gateway", kind: "bearer" }
  const layer = Layer.merge(
    ControlServer.layer,
    layerAuth(anyAuthenticator([
      bearerAuthenticator({ token: key, principal: root, now: () => now }),
      ScopedToken.authenticator({ key, principal: scoped, now: () => now })
    ]))
  ).pipe(
    Layer.provide(
      TestControl.layer({
        principal: root,
        now: () => now,
        approvalAuthority: delegateApproval(root)
      })
    )
  )

  it("a minted read:runs token reads, cannot approve, and expires", async () => {
    const { token } = await minted({ now: () => now, ttlMillis: 10_000 })
    const asToken = { headers: { authorization: `Bearer ${token}` } }
    const asRoot = { headers: { authorization: `Bearer ${key}` } }
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const rpc = yield* RpcTest.makeClient(ControlRpcs)
          const listed = yield* rpc.List({ _tag: "flows" }, asToken)
          const card = yield* rpc.Plan({ flowId: "system/release", input: {}, idempotencyKey: "plan" }, asRoot)
          const approve = yield* Effect.flip(rpc.Approve({ ...card.approval, idempotencyKey: "approve" }, asToken))
          const plan = yield* Effect.flip(
            rpc.Plan({ flowId: "system/release", input: {}, idempotencyKey: "plan-2" }, asToken)
          )
          now = 11_000
          const expired = yield* Effect.flip(rpc.List({ _tag: "flows" }, asToken))
          const rootStillReads = yield* rpc.List({ _tag: "flows" }, asRoot)
          return { listed, approve, plan, expired, rootStillReads }
        }).pipe(Effect.provide(layer))
      )
    )

    expect(outcome.listed._tag).toBe("flows")
    expect(outcome.approve).toBeInstanceOf(Unauthorized)
    expect((outcome.approve as Unauthorized).message).toBe("The scoped token does not authorize Approve")
    expect(outcome.plan).toBeInstanceOf(Unauthorized)
    expect(outcome.expired).toBeInstanceOf(Unauthorized)
    expect((outcome.expired as Unauthorized).message).toBe("The scoped token has expired")
    expect(outcome.rootStillReads._tag).toBe("flows")
  })
})
