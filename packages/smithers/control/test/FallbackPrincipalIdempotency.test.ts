/**
 * A direct `Control` call that names no principal acts as the runtime's
 * configured principal, and its idempotency key is that actor's key.
 *
 * Two hosts configured with different identities over one control database
 * are two actors: one's caller key must not collide with the other's, and a
 * caller naming its own configured identity explicitly is the same actor as
 * one that named none.
 */
import { Effect, type Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type * as ApprovalAuthority from "../src/ApprovalAuthority.ts"
import { Control } from "../src/Control.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { PlanCard } from "../src/ControlSchema.ts"
import { durable, type DurableStack, fileBundle } from "./DurableStack.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-control-fallback-principal-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The host policy delegates every decision to both configured identities. */
const approvalAuthority: ApprovalAuthority.Service = { authorize: () => Effect.void }

const alpha = { id: "alpha", kind: "operator" }
const beta = { id: "beta", kind: "operator" }

const host = (filename: string, principal: typeof alpha): Layer.Layer<DurableStack> =>
  durable({ database: fileBundle(filename), approvalAuthority, principal })

const on = <A, E>(stack: Layer.Layer<DurableStack>, body: Effect.Effect<A, E, DurableStack>): Promise<A> =>
  Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped))

/** Plans every suite through one host, so each plan has its own id. */
const plans = (stack: Layer.Layer<DurableStack>, suites: ReadonlyArray<string>) =>
  on(
    stack,
    Effect.flatMap(
      Control,
      (control) => Effect.forEach(suites, (suite) => control.plan({ flowId: "system/test", input: { suite } }))
    )
  )

describe("idempotency keys bind the configured fallback principal", () => {
  it("keeps independent configured hosts apart and treats an omitted principal as the configured one", async () => {
    const filename = join(directory, "approve.sqlite")
    const alphaHost = host(filename, alpha)
    const betaHost = host(filename, beta)

    const [alphaCard, betaCard] = await plans(alphaHost, ["alpha", "beta"]) as [PlanCard, PlanCard]

    await on(
      alphaHost,
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        expect(yield* runtime.stampPrincipal()).toMatchObject(alpha)
        const input = { ...alphaCard.approval, idempotencyKey: "review:shared" }
        expect((yield* control.approve(input))._tag).toBe("Accepted")
        // Same actor, equal retry.
        expect((yield* control.approve(input))._tag).toBe("AlreadyApplied")
        // Naming the configured identity explicitly, at any clock, is the same actor.
        expect((yield* control.approve({ ...input, principal: { ...alpha, stampedAt: 0 } }))._tag).toBe(
          "AlreadyApplied"
        )
        expect((yield* control.approve({ ...input, principal: { ...alpha, stampedAt: 99 } }))._tag).toBe(
          "AlreadyApplied"
        )
        // A different intent under one actor's key is still refused.
        expect(yield* control.approve({ ...betaCard.approval, idempotencyKey: "review:shared" })).toMatchObject({
          _tag: "Conflict"
        })
        expect((yield* runtime.getPlan(betaCard.planId)).decision).toBe("pending")
      })
    )

    await on(
      betaHost,
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        expect(yield* runtime.stampPrincipal()).toMatchObject(beta)
        const input = { ...betaCard.approval, idempotencyKey: "review:shared" }
        // Beta is its own actor: alpha's key does not collide with it.
        expect((yield* control.approve(input))._tag).toBe("Accepted")
        expect((yield* runtime.getPlan(betaCard.planId)).decision).toBe("approved")
        expect((yield* control.approve({ ...input, principal: { ...beta, stampedAt: 0 } }))._tag).toBe(
          "AlreadyApplied"
        )
        // Beta naming alpha is alpha's key, and alpha used it for another plan.
        expect(yield* control.approve({ ...input, principal: { ...alpha, stampedAt: 0 } })).toMatchObject({
          _tag: "Conflict"
        })
      })
    )
  })

  it("binds run and cancel keys to the configured principal the same way", async () => {
    const filename = join(directory, "run.sqlite")
    const alphaHost = host(filename, alpha)
    const betaHost = host(filename, beta)

    const planned = (await plans(alphaHost, ["first", "second", "third"])).map((card) => ({
      card,
      input: { _tag: "Plan" as const, planId: card.planId, digest: card.digest, envelope: card.envelope }
    }))
    const [first, second, third] = planned as [Planned, Planned, Planned]
    type Planned = (typeof planned)[number]
    const launch = (planned: Planned) =>
      Effect.gen(function*() {
        const control = yield* Control
        yield* control.approve({ ...planned.card.approval, idempotencyKey: `approve:${planned.card.planId}` })
        return planned.input
      })

    const alphaRuns = await on(
      alphaHost,
      Effect.gen(function*() {
        const control = yield* Control
        const firstRun = yield* launch(first)
        const accepted = yield* control.run({ ...firstRun, idempotencyKey: "launch:shared" })
        expect(accepted._tag).toBe("Accepted")
        const replayed = yield* control.run({
          ...firstRun,
          idempotencyKey: "launch:shared",
          principal: { ...alpha, stampedAt: 7 }
        })
        expect(replayed).toMatchObject({ _tag: "AlreadyApplied", runId: (accepted as { runId: string }).runId })
        const secondRun = yield* launch(second)
        expect(yield* control.run({ ...secondRun, idempotencyKey: "launch:shared" })).toMatchObject({
          _tag: "Conflict"
        })
        const other = yield* control.run({ ...secondRun, idempotencyKey: "launch:second" })
        const runs = [(accepted as { runId: string }).runId, (other as { runId: string }).runId] as const
        expect((yield* control.cancel({ runId: runs[0], idempotencyKey: "stop:shared" }))._tag).not.toBe("Conflict")
        expect(yield* control.cancel({ runId: runs[1], idempotencyKey: "stop:shared" })).toMatchObject({
          _tag: "Conflict"
        })
        return { runs }
      })
    )

    await on(
      betaHost,
      Effect.gen(function*() {
        const control = yield* Control
        // Beta's launch and cancel keys are its own, not alpha's.
        const thirdRun = yield* launch(third)
        expect((yield* control.run({ ...thirdRun, idempotencyKey: "launch:shared" }))._tag).toBe("Accepted")
        expect((yield* control.cancel({ runId: alphaRuns.runs[1], idempotencyKey: "stop:shared" }))._tag).not.toBe(
          "Conflict"
        )
      })
    )
  })
})
