import { NotificationQueue } from "@smthrs/notifications"
import { Effect, Layer, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { isControlError } from "../src/ControlClient.ts"
import { PlanDigestMismatch, RunNotFound, TransportError, Unauthorized } from "../src/ControlError.ts"
import { bearerAuthenticator, ControlRpcs, layerAuth, layerNoopAuth } from "../src/ControlRpcs.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { Envelope, Principal, RunSummary, SteerMessage } from "../src/ControlSchema.ts"
import * as ControlServer from "../src/ControlServer.ts"
import * as TestControl from "../src/test/TestControl.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import { durable, type DurableStack } from "./DurableStack.ts"

const principal = { id: "server", kind: "test", stampedAt: 1 }

const layer = Layer.merge(ControlServer.layer, layerNoopAuth(principal)).pipe(
  Layer.provide(
    TestControl.layer({
      principal: { id: principal.id, kind: principal.kind },
      now: () => 1,
      approvalAuthority: delegateApproval(principal)
    })
  )
)

const makeClient = RpcTest.makeClient(ControlRpcs)
type ControlRpcClient = Effect.Success<typeof makeClient>

const client = <A, E>(
  effect: (client: ControlRpcClient) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const rpc = yield* makeClient
      return yield* effect(rpc)
    }).pipe(Effect.provide(layer))
  )

const plan = (rpc: ControlRpcClient) =>
  rpc.Plan({ flowId: "system/release", input: { release: true }, idempotencyKey: "plan" })

describe("ControlRpcs", () => {
  it("authenticates exactly the configured bearer token", async () => {
    const authenticator = bearerAuthenticator({
      token: "alpha-secret",
      principal: { id: "alpha", kind: "bearer" },
      now: () => 42
    })

    const authenticated = await Effect.runPromise(
      authenticator.authenticate({ Authorization: "bearer alpha-secret" })
    )
    const refused = await Promise.all([
      {},
      { authorization: "Basic alpha-secret" },
      { authorization: "Bearer " },
      { authorization: "Bearer alpha-secre" },
      { authorization: "Bearer alpha-secret!" },
      { authorization: "Bearer alpha-secrEt" },
      { authorization: "Bearer 🔐" }
    ].map((headers) => Effect.runPromise(authenticator.authenticate(headers).pipe(Effect.flip))))

    expect(authenticated).toEqual({ id: "alpha", kind: "bearer", stampedAt: 42 })
    expect(refused).toHaveLength(7)
    expect(refused.every((error) => error instanceof Unauthorized)).toBe(true)
  })

  it("stamps the host clock when the composition names none", async () => {
    // `now` is a seam for deterministic suites. A host that omits it still owes
    // every authenticated principal a real stamp, because the stamp is what
    // says WHEN a decision was authorized.
    const authenticator = bearerAuthenticator({
      token: "alpha-secret",
      principal: { id: "alpha", kind: "bearer" }
    })

    const before = Date.now()
    const authenticated = await Effect.runPromise(authenticator.authenticate({ authorization: "Bearer alpha-secret" }))

    expect(authenticated.stampedAt).toBeGreaterThanOrEqual(before)
    expect(authenticated.stampedAt).toBeLessThanOrEqual(Date.now())
  })

  it("fails closed when the configured bearer token is empty", async () => {
    const authenticator = bearerAuthenticator({
      token: "",
      principal: { id: "alpha", kind: "bearer" }
    })

    const refused = await Effect.runPromise(
      authenticator.authenticate({ authorization: "Bearer anything" }).pipe(Effect.flip)
    )

    expect(refused).toBeInstanceOf(Unauthorized)
  })

  it("classifies owned failures through the control error schema union", () => {
    expect(isControlError(new RunNotFound({ runId: "missing" }))).toBe(true)
    expect(isControlError(new TransportError({ message: "offline", retryable: true }))).toBe(true)
    expect(isControlError(new Error("transport failure"))).toBe(false)
  })

  it("round-trips plan, approve, and list", async () => {
    const result = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        const approval = yield* rpc.Approve({ ...card.approval, idempotencyKey: "approve" })
        const listed = yield* rpc.List({ _tag: "flows" })
        return { approval, listed }
      })
    ))

    expect(result.approval._tag).toBe("Accepted")
    expect(result.listed._tag).toBe("flows")
  })

  it("preserves domain failure tags", async () => {
    const error = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        return yield* rpc.Run({
          _tag: "Plan",
          planId: card.planId,
          digest: "not-the-plan-digest",
          envelope: card.envelope,
          idempotencyKey: "run"
        }).pipe(Effect.flip)
      })
    ))

    expect(error).toBeInstanceOf(PlanDigestMismatch)
  })

  it("streams journal events and supports client interruption", async () => {
    const events = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        yield* rpc.Approve({ ...card.approval, idempotencyKey: "stream-approve" })
        const receipt = yield* rpc.Run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "start"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return []
        return yield* rpc.Watch({ runId: receipt.runId }).pipe(Stream.take(1), Stream.runCollect)
      })
    ))

    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("control.run.accepted")
  })

  it("carries a cancel reason across the wire and refuses a caller-named principal", async () => {
    const result = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        yield* rpc.Approve({ ...card.approval, idempotencyKey: "cancel-approve" })
        const receipt = yield* rpc.Run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "cancel-start"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("no run")
        yield* rpc.Cancel({
          runId: receipt.runId,
          reason: "budget",
          idempotencyKey: "cancel",
          // A client naming its own principal is decoded away before the
          // handler, so the server's stamped identity is the one recorded.
          principal: { id: "attacker", kind: "attacker", stampedAt: 0 }
        } as never)
        const events = yield* rpc.Watch({ runId: receipt.runId, follow: false }).pipe(Stream.runCollect)
        return events.find((event) => event.kind === "control.run.cancel-requested")
      })
    ))

    expect(result?.payload).toMatchObject({ source: "control", reason: "budget" })
    expect((result?.payload as { readonly principal: { readonly id: string } }).principal.id).toBe("server")
  })

  it("refuses an approval decision from the anonymous loopback principal and leaves the plan undecided", async () => {
    // A loopback listener with no operator token authenticates every caller as
    // `loopback`/`anonymous`; any local process could otherwise approve (#1783).
    const loopback: Principal = { id: "loopback", kind: "anonymous", stampedAt: 1 }
    const anonymous = Layer.merge(ControlServer.layer, layerNoopAuth(loopback)).pipe(
      Layer.provideMerge(
        TestControl.layer({
          principal: { id: loopback.id, kind: loopback.kind },
          now: () => 1,
          approvalAuthority: delegateApproval(loopback)
        })
      )
    )
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const rpc = yield* makeClient
        const control = yield* Control
        const card = yield* plan(rpc)
        const approve = yield* Effect.flip(rpc.Approve({ ...card.approval, idempotencyKey: "approve" }))
        const deny = yield* Effect.flip(rpc.Deny({ ...card.approval, idempotencyKey: "deny" }))
        // The plan is still pending: a run against it parks for a decision.
        const run = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "run"
        })
        return { approve, deny, run }
      }).pipe(Effect.provide(anonymous), Effect.scoped)
    )

    for (const refused of [observed.approve, observed.deny]) {
      expect(refused).toBeInstanceOf(Unauthorized)
      expect((refused as Unauthorized).message).toBe("An operator credential is required")
    }
    expect(observed.run).toMatchObject({ _tag: "Parked", status: "waiting-approval" })
  })

  it("rejects malformed payloads before handlers and ignores caller principal fields", async () => {
    const result = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const malformed = yield* Effect.exit(rpc.Plan({ flowId: 1, input: null } as never))
        const card = yield* plan(rpc)
        yield* rpc.Approve({
          ...card.approval,
          scope: "once",
          idempotencyKey: "auth",
          principal: { id: "attacker", kind: "attacker", stampedAt: 0 }
        } as never)
        return malformed
      })
    ))

    expect(result._tag).toBe("Failure")
  })
})

/**
 * Who an operator action is journaled as.
 *
 * Every case above authenticates the identity the composition already defaults
 * to, so a handler that dropped the authenticated principal and one that
 * forwarded it produced byte-identical journals. That is the gap this section
 * closes: `Approve` and `Deny` stamped the principal, `Steer`, `Cancel`, and
 * `Resume` did not, and no fixture could tell.
 *
 * So the composition here deliberately defaults to a DIFFERENT identity than
 * the one the middleware authenticates. A remote bearer operator cancels, and
 * the durable record has to say the bearer did it, not `local`.
 *
 * The stack is the durable one. What an operator reads back is a journal write
 * and a projection over it: the `control.run.cancel-requested` entry, and
 * `RunSummary.cancellation`.
 */
/** What the middleware authenticated. Never `local`, which is the default. */
const authenticated: Principal = { id: "remote-operator", kind: "bearer", stampedAt: 0 }

/** What a client would name if the wire let it. */
const spoofed: Principal = { id: "victim", kind: "human", stampedAt: 0 }

const attributed = Layer.merge(ControlServer.layer, layerNoopAuth(authenticated)).pipe(
  Layer.provideMerge(durable({ approvalAuthority: delegateApproval(authenticated) }))
)

/** The client, and everything the durable stack exposes, over one database. */
const durably = <A, E>(
  body: (rpc: ControlRpcClient) => Effect.Effect<A, E, DurableStack>,
  stack: typeof attributed = attributed
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const rpc = yield* makeClient
      return yield* body(rpc)
    }).pipe(Effect.provide(stack), Effect.scoped, Effect.orDie)
  )

/** Plans, approves, and starts one run through the authenticated boundary. */
const start = (rpc: ControlRpcClient, suffix: string) =>
  Effect.gen(function*() {
    const card = yield* rpc.Plan({ flowId: "system/test", input: { suite: suffix }, idempotencyKey: `plan:${suffix}` })
    yield* rpc.Approve({ ...card.approval, idempotencyKey: `approve:${suffix}` })
    const receipt = yield* rpc.Run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    return { runId: receipt.runId, planId: card.planId }
  })

/** The principal one journal entry recorded, whatever the entry's shape. */
const principalOf = (payload: unknown): Principal | undefined =>
  (payload as { readonly principal?: Principal | undefined } | null)?.principal

const entries = (rpc: ControlRpcClient, runId: string, kind: string) =>
  Effect.map(
    Stream.runCollect(rpc.Watch({ runId, follow: false })),
    (events) => events.filter((event) => event.kind === kind)
  )

const summaryOf = (rpc: ControlRpcClient, runId: string) =>
  Effect.map(
    rpc.List({ _tag: "runs", filters: { runId } }),
    (listed): RunSummary | undefined => listed._tag === "runs" ? listed.items[0] : undefined
  )

describe("approval identity over RPC", () => {
  it("scopes a caller-chosen request id to the run named by the node target", async () => {
    const observed = await durably((rpc) =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const firstRun = yield* start(rpc, "rpc-approval-first")
        const secondRun = yield* start(rpc, "rpc-approval-second")
        const approvalEnvelope: Envelope = { capabilities: [], flows: ["ask"], budget: {} }
        const firstTarget = {
          _tag: "Node" as const,
          runId: firstRun.runId,
          requestId: "caller-chosen",
          digest: "ask-digest",
          envelope: approvalEnvelope
        }
        const secondTarget = { ...firstTarget, runId: secondRun.runId }
        yield* runtime.registerApproval(firstTarget)
        yield* runtime.registerApproval(secondTarget)

        yield* rpc.Approve({ target: firstTarget, scope: "once", idempotencyKey: "approve:caller-chosen" })

        return {
          firstRunId: firstRun.runId,
          secondRunId: secondRun.runId,
          first: yield* runtime.registerApproval(firstTarget),
          second: yield* runtime.registerApproval(secondTarget)
        }
      })
    )

    expect(observed.first).toMatchObject({ _tag: "Approved", target: { runId: observed.firstRunId } })
    expect(observed.second).toMatchObject({ _tag: "Pending", target: { runId: observed.secondRunId } })
    expect(observed.firstRunId).not.toBe(observed.secondRunId)
  })
})

describe("the identity an authenticated control mutation is journaled under", () => {
  it("stamps the authenticated principal on an approval and on a denial", async () => {
    const observed = await durably((rpc) =>
      Effect.gen(function*() {
        const approved = yield* rpc.Plan({ flowId: "system/test", input: { a: 1 }, idempotencyKey: "plan:approve" })
        yield* rpc.Approve({ ...approved.approval, idempotencyKey: "decide:approve" })
        const denied = yield* rpc.Plan({ flowId: "system/test", input: { a: 2 }, idempotencyKey: "plan:deny" })
        yield* rpc.Deny({ ...denied.approval, idempotencyKey: "decide:deny" })
        return {
          approve: yield* entries(rpc, `plan:${approved.planId}`, "control.approval.approved"),
          deny: yield* entries(rpc, `plan:${denied.planId}`, "control.approval.denied")
        }
      })
    )

    expect(principalOf(observed.approve[0]?.payload)).toMatchObject({ id: "remote-operator", kind: "bearer" })
    expect(principalOf(observed.deny[0]?.payload)).toMatchObject({ id: "remote-operator", kind: "bearer" })
  })

  it("stamps the authenticated principal on a cancel, in the journal and in the projection", async () => {
    const observed = await durably((rpc) =>
      Effect.gen(function*() {
        const { runId } = yield* start(rpc, "cancel")
        yield* rpc.Cancel({ runId, reason: "budget", idempotencyKey: `cancel:${runId}` })
        return {
          requested: yield* entries(rpc, runId, "control.run.cancel-requested"),
          summary: yield* summaryOf(rpc, runId)
        }
      })
    )

    expect(principalOf(observed.requested[0]?.payload)).toMatchObject({ id: "remote-operator", kind: "bearer" })
    expect(observed.summary?.cancellation?.principal).toMatchObject({ id: "remote-operator", kind: "bearer" })
    expect(observed.summary?.cancellation?.reason).toBe("budget")
  })

  it("overwrites a client-named steer principal with the authenticated one", async () => {
    const observed = await durably((rpc) =>
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const { runId } = yield* start(rpc, "steer")
        const message: SteerMessage = {
          messageId: "steer-spoof",
          attribution: { person: "someone-else", via: "owner" },
          runId,
          principal: spoofed,
          createdAt: 1,
          body: "do the thing"
        }
        yield* rpc.Steer({ runId, message, idempotencyKey: "steer:spoof" })
        return yield* queue.pending(runId)
      })
    )

    expect(observed).toHaveLength(1)
    // Provenance is what a notification's reader and the run transcript show,
    // so a client that could name it could attribute its own message to anyone.
    expect(observed[0]?.provenance.sourceActor).toBe("bearer:remote-operator")
    expect(observed[0]?.provenance.attribution).toBeUndefined()
  })

  it("keeps a repeated cancel idempotent even though the principal is stamped per request", async () => {
    // The server stamps a wall clock into every principal it authenticates, so
    // no two requests carry the same one. A mutation fingerprint that included
    // it would make the second `smithers cancel` of one run look like a
    // different mutation under the same key, and answer `Conflict` instead of
    // the cancel's own receipt.
    let stampedAt = 0
    const clocked = Layer.merge(
      ControlServer.layer,
      layerAuth({ authenticate: () => Effect.succeed({ ...authenticated, stampedAt: ++stampedAt }) })
    ).pipe(Layer.provideMerge(durable({ approvalAuthority: delegateApproval(authenticated) })))

    const observed = await durably(
      (rpc) =>
        Effect.gen(function*() {
          const { runId } = yield* start(rpc, "retry")
          const first = yield* rpc.Cancel({ runId, reason: "budget", idempotencyKey: `cancel:${runId}` })
          const again = yield* rpc.Cancel({ runId, reason: "budget", idempotencyKey: `cancel:${runId}` })
          return { first, again }
        }),
      clocked
    )

    expect(observed.first._tag).not.toBe("Conflict")
    expect(observed.again._tag).not.toBe("Conflict")
  })

  it("journals the authenticated principal and stated reason on a resume", async () => {
    const observed = await durably((rpc) =>
      Effect.gen(function*() {
        const { runId } = yield* start(rpc, "resume-attribution")
        yield* rpc.Resume({
          runId,
          reason: "operator recovery",
          idempotencyKey: `resume:${runId}`
        })
        return yield* entries(rpc, runId, "control.run.resume")
      })
    )

    expect(observed).toHaveLength(1)
    expect(principalOf(observed[0]?.payload)).toMatchObject({ id: "remote-operator", kind: "bearer" })
    expect(observed[0]?.payload).toMatchObject({ reason: "operator recovery" })
  })
})
