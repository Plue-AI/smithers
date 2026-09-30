/**
 * Which runs `List` and `Watch` answer each authenticated principal.
 *
 * A host whose authenticator stamps several principals used to show every run
 * and every run's events to all of them. Each principal now reads only the
 * runs it launched, and the principals the host names as operators read every
 * run. The stack is the durable one, so the launcher travels through the SQL
 * launch index rather than a projection that only lives in memory.
 */
import { Effect, Layer, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { RunNotFound } from "../src/ControlError.ts"
import { ControlRpcs, layerAuth } from "../src/ControlRpcs.ts"
import type { Principal } from "../src/ControlSchema.ts"
import * as ControlServer from "../src/ControlServer.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import { durable } from "./DurableStack.ts"

const alice: Principal = { id: "alice", kind: "user", stampedAt: 0 }
const bob: Principal = { id: "bob", kind: "user", stampedAt: 0 }
/** Same id as alice, another kind: a different principal. */
const aliceService: Principal = { id: "alice", kind: "service", stampedAt: 0 }
const operator: Principal = { id: "ops", kind: "operator", stampedAt: 0 }

const makeClient = RpcTest.makeClient(ControlRpcs)
type Client = Effect.Success<typeof makeClient>

/** One durable stack whose authenticator answers as whoever `as` names. */
const withStack = <A, E>(
  body: (as: (principal: Principal) => Effect.Effect<Client, never, never>) => Effect.Effect<A, E, Control>,
  options: { readonly seesAllRuns?: (principal: Principal) => boolean } = {
    seesAllRuns: (principal) => principal.kind === "operator"
  }
): Promise<A> => {
  let caller: Principal = operator
  const auth = layerAuth({ authenticate: () => Effect.succeed(caller) }, options)
  const stack = Layer.merge(ControlServer.layer, auth).pipe(
    Layer.provideMerge(durable({ approvalAuthority: delegateApproval(operator) }))
  )
  return Effect.runPromise(
    Effect.gen(function*() {
      const rpc = yield* makeClient
      const as = (principal: Principal) =>
        Effect.sync(() => {
          caller = principal
          return rpc
        })
      return yield* body(as)
    }).pipe(Effect.provide(stack), Effect.scoped, Effect.orDie)
  )
}

/** `launcher` plans and runs; the operator approves in between. */
const launch = (as: (principal: Principal) => Effect.Effect<Client>, launcher: Principal, suffix: string) =>
  Effect.gen(function*() {
    const card = yield* (yield* as(launcher)).Plan({
      flowId: "system/test",
      input: { suite: suffix },
      idempotencyKey: `plan:${suffix}`
    })
    yield* (yield* as(operator)).Approve({ ...card.approval, idempotencyKey: `approve:${suffix}` })
    const receipt = yield* (yield* as(launcher)).Run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    return receipt.runId
  })

const listed = (rpc: Client, filters: { readonly principalId?: string; readonly runId?: string } = {}) =>
  Effect.map(
    rpc.List({ _tag: "runs", filters }),
    (page) => page._tag === "runs" ? page.items.map((run) => run.runId).sort() : []
  )

const watched = (rpc: Client) =>
  Effect.map(
    Stream.runCollect(rpc.Watch({ follow: false })),
    (events) => [...new Set(Array.from(events, (event) => event.runId ?? ""))].sort()
  )

describe("run visibility per principal", () => {
  it("lists and watches only the runs each principal launched", async () => {
    const observed = await withStack((as) =>
      Effect.gen(function*() {
        const a = yield* launch(as, alice, "alice")
        const b = yield* launch(as, bob, "bob")
        const s = yield* launch(as, aliceService, "alice-service")
        return {
          runs: { a, b, s },
          alice: { list: yield* listed(yield* as(alice)), watch: yield* watched(yield* as(alice)) },
          bob: { list: yield* listed(yield* as(bob)), watch: yield* watched(yield* as(bob)) },
          service: { list: yield* listed(yield* as(aliceService)) },
          operator: { list: yield* listed(yield* as(operator)), watch: yield* watched(yield* as(operator)) },
          summary: yield* Effect.map(
            (yield* as(alice)).List({ _tag: "runs", filters: { runId: a } }),
            (page) => page._tag === "runs" ? page.items[0] : undefined
          )
        }
      })
    )
    const { a, b, s } = observed.runs
    expect(observed.alice.list).toEqual([a])
    expect(observed.bob.list).toEqual([b])
    expect(observed.service.list).toEqual([s])
    // A restricted watch carries no plan partition and no other launcher's run.
    expect(observed.alice.watch).toEqual([a])
    expect(observed.bob.watch).toEqual([b])
    expect(observed.operator.list).toEqual([a, b, s].sort())
    expect(observed.operator.watch).toEqual(expect.arrayContaining([a, b, s]))
    expect(observed.operator.watch.some((partition) => partition.startsWith("plan:"))).toBe(true)
    expect(observed.summary).toMatchObject({ runId: a, launchedBy: { id: "alice", kind: "user" } })
  })

  it("answers another principal's run exactly as a missing one", async () => {
    const observed = await withStack((as) =>
      Effect.gen(function*() {
        const a = yield* launch(as, alice, "alice")
        const asBob = yield* as(bob)
        return {
          exact: yield* listed(asBob, { runId: a }),
          borrowed: yield* listed(asBob, { principalId: "alice" }),
          watch: yield* Effect.flip(Stream.runCollect(asBob.Watch({ runId: a, follow: false }))),
          missing: yield* Effect.flip(Stream.runCollect(asBob.Watch({ runId: "run-404", follow: false }))),
          own: yield* listed(yield* as(alice), { principalId: "alice" })
        }
      })
    )
    expect(observed.exact).toEqual([])
    expect(observed.borrowed).toEqual([])
    expect(observed.watch).toBeInstanceOf(RunNotFound)
    expect(observed.missing).toBeInstanceOf(RunNotFound)
    expect(observed.own).toHaveLength(1)
  })

  it("lets an operator narrow to one launcher, and hides unrecorded runs from everyone else", async () => {
    const observed = await withStack((as) =>
      Effect.gen(function*() {
        const a = yield* launch(as, alice, "alice")
        yield* launch(as, bob, "bob")
        // An in-process launch through Control names no reader and is recorded
        // under the composition's own principal.
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "local" } })
        yield* control.approve({ ...card.approval, idempotencyKey: "approve:local" })
        const local = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "run:local"
        })
        const inProcess = yield* control.list({ _tag: "runs" })
        return {
          a,
          local: local._tag === "Accepted" ? local.runId : undefined,
          narrowed: yield* listed(yield* as(operator), { principalId: "alice" }),
          alice: yield* listed(yield* as(alice)),
          inProcess: inProcess._tag === "runs" ? inProcess.items.length : -1
        }
      })
    )
    expect(observed.narrowed).toEqual([observed.a])
    expect(observed.alice).toEqual([observed.a])
    expect(observed.alice).not.toContain(observed.local)
    expect(observed.inProcess).toBe(3)
  })

  it("restricts every principal when the host names no operator", async () => {
    const observed = await withStack(
      (as) =>
        Effect.gen(function*() {
          yield* launch(as, alice, "alice")
          return yield* listed(yield* as(operator))
        }),
      {}
    )
    expect(observed).toEqual([])
  })
})
