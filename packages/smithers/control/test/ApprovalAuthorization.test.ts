import { Deferred, Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as ApprovalAuthority from "../src/ApprovalAuthority.ts"
import { Control } from "../src/Control.ts"
import { PersistenceError, Unauthorized } from "../src/ControlError.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import { durable } from "./DurableStack.ts"
import { live, memoryRuntime } from "./TestStack.ts"

const principal = { id: "untrusted-agent", kind: "agent", stampedAt: 0 }
const stack = (adapter: "memory" | "sql", approvalAuthority: ApprovalAuthority.Service) =>
  adapter === "memory" ? live({ runtime: memoryRuntime({ approvalAuthority }) }) : durable({ approvalAuthority })

describe("approval mutations require independent authority", () => {
  it("SQL refuses an uncapturable direct request without changing the token", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
        const token = yield* runtime.lookupApproval(card.approval.target)
        const invalid = { ...token, target: { ...token.target, invalid: () => "do not retain or reveal" } }
        const refused = yield* Effect.flip(
          runtime.resolveApproval(invalid, "approved", yield* runtime.stampPrincipal())
        )
        expect(refused).toBeInstanceOf(PersistenceError)
        expect(refused.message).not.toContain("do not retain")
        expect(yield* runtime.lookupApproval(card.approval.target)).toEqual(token)
      }).pipe(Effect.provide(durable()), Effect.scoped)
    )
  })
  for (const adapter of ["memory", "sql"] as const) {
    it(`${adapter}: retains a policy method's host receiver`, async () => {
      const policy = {
        allowed: true,
        authorize() {
          return this.allowed ? Effect.void : Effect.fail(new Unauthorized({ message: "revoked" }))
        }
      }
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          expect((yield* control.approve(card.approval))._tag).toBe("Accepted")
          policy.allowed = false
          expect(yield* Effect.flip(control.approve(card.approval))).toBeInstanceOf(Unauthorized)
        }).pipe(Effect.provide(stack(adapter, policy)), Effect.scoped)
      )
    })
    it(`${adapter}: refuses direct resolution and does not grant authority through a matching kind`, async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
          const token = yield* runtime.lookupApproval(card.approval.target)
          for (const kind of ["agent", "operator", "test", "bearer"]) {
            for (const decision of ["approved", "denied"] as const) {
              expect(yield* Effect.flip(runtime.resolveApproval(token, decision, { ...principal, kind }, "remembered")))
                .toBeInstanceOf(Unauthorized)
            }
          }
          expect(yield* runtime.lookupApproval(card.approval.target)).toEqual(token)
          expect((yield* runtime.getPlan(card.planId)).decision).toBe("pending")
          expect(yield* runtime.grants).toEqual([])
        }).pipe(Effect.provide(adapter === "memory" ? live() : durable()), Effect.scoped)
      )
    })

    for (const failure of ["revoked", "unavailable"] as const) {
      it(`${adapter}: ${failure} authority at the resolution frontier leaves no decision, grant, event, or receipt`, async () => {
        let calls = 0
        let refuse = true
        const policy: ApprovalAuthority.Service = {
          authorize: () =>
            Effect.suspend(() => {
              calls++
              return !refuse || calls === 1 ? Effect.void : Effect.fail(
                failure === "revoked" ?
                  new Unauthorized({ message: "revoked" }) :
                  new PersistenceError({ operation: "authorize approval", message: "policy unavailable" })
              )
            })
        }
        await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control
            const runtime = yield* ControlRuntime
            const card = yield* control.plan({ flowId: "system/test", input: {} })
            const input = { ...card.approval, principal }
            const before = yield* runtime.lookupApproval(input.target)
            const history = yield* Stream.runCollect(control.watch({ follow: false }))
            const refused = yield* Effect.flip(control.approve(input))
            expect(refused._tag).toBe(failure === "revoked" ? "/control/Unauthorized" : "/control/PersistenceError")
            expect(calls).toBe(2)
            expect(yield* runtime.lookupApproval(input.target)).toEqual(before)
            expect((yield* runtime.getPlan(card.planId)).decision).toBe("pending")
            expect(yield* runtime.grants).toEqual([])
            const after = yield* Stream.runCollect(control.watch({ follow: false }))
            expect(after.slice(0, history.length)).toEqual(history)
            const added = after.slice(history.length)
            if (failure === "unavailable") {
              expect(added).toEqual([])
            } else {
              expect(added).toHaveLength(1)
              expect(added[0]).toMatchObject({
                kind: "control.approval.refused",
                runId: `plan:${card.planId}`,
                occurredAt: expect.any(Number),
                payload: {
                  decision: "approved",
                  principal: { id: principal.id, kind: principal.kind },
                  scope: input.scope,
                  target: input.target
                }
              })
            }
            refuse = false
            expect((yield* control.approve(input))._tag).toBe("Accepted")
            expect((yield* control.approve(input))._tag).toBe("AlreadyApplied")
          }).pipe(Effect.provide(stack(adapter, policy)), Effect.scoped)
        )
      })
    }

    it(`${adapter}: revocation is checked before an idempotent receipt is replayed`, async () => {
      let allowed = true
      const policy: ApprovalAuthority.Service = {
        authorize: () =>
          Effect.suspend(() => allowed ? Effect.void : Effect.fail(new Unauthorized({ message: "revoked" })))
      }
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          const input = { ...card.approval, principal }
          yield* control.approve(input)
          allowed = false
          expect(yield* Effect.flip(control.approve(input))).toBeInstanceOf(Unauthorized)
          expect(
            yield* Effect.flip(
              control.deny({
                ...input,
                target: { _tag: "Plan", planId: "absent", digest: card.digest, envelope: card.envelope }
              })
            )
          )
            .toBeInstanceOf(Unauthorized)
        }).pipe(Effect.provide(stack(adapter, policy)), Effect.scoped)
      )
    })

    it(`${adapter}: host delegation grants exactly its scope and is not an actor-supplied role`, async () => {
      const policy = await Effect.runPromise(ApprovalAuthority.make([
        { principal: { id: principal.id, kind: principal.kind }, targets: ["Plan"], scopes: ["once"] }
      ]))
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          const input = { ...card.approval, principal }
          for (const scope of ["run", "remembered"] as const) {
            expect(yield* Effect.flip(control.approve({ ...input, scope }))).toBeInstanceOf(Unauthorized)
          }
          yield* control.approve({ ...input, scope: "once" })
          expect((yield* runtime.grants).map((grant) => grant.scope)).toEqual(["once"])
          expect((yield* runtime.getPlan(card.planId)).decision).toBe("approved")
        }).pipe(Effect.provide(stack(adapter, policy)), Effect.scoped)
      )
    })

    it(`${adapter}: captures the request across a suspended authority check`, async () => {
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const seen: Array<ApprovalAuthority.Request> = []
      const policy: ApprovalAuthority.Service = {
        authorize: (request) =>
          Effect.gen(function*() {
            seen.push(structuredClone(request))
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          })
      }
      await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
          const { card: other } = yield* runtime.plan({ flowId: "system/test", input: { other: true } })
          const token = yield* runtime.lookupApproval(card.approval.target)
          const actor = { ...principal }
          const fiber = yield* runtime.resolveApproval(token, "approved", actor, "once").pipe(Effect.forkChild())
          yield* Deferred.await(entered)
          Object.assign(token.target, { planId: other.planId, digest: other.digest })
          actor.id = "spoofed"
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(fiber)
          expect(seen).toEqual([{ principal, target: card.approval.target, scope: "once", decision: "approved" }])
          expect((yield* runtime.getPlan(card.planId)).decision).toBe("approved")
          expect((yield* runtime.getPlan(other.planId)).decision).toBe("pending")
        }).pipe(Effect.provide(stack(adapter, policy)), Effect.scoped)
      )
    })

    for (const targetKind of ["Plan", "Node"] as const) {
      for (const decision of ["approved", "denied"] as const) {
        for (const scope of ["once", "run", "remembered"] as const) {
          it(`${adapter}: refuses agent ${decision} for ${targetKind}/${scope} without changing the request`, async () => {
            await Effect.runPromise(
              Effect.gen(function*() {
                const control = yield* Control
                const runtime = yield* ControlRuntime
                const card = yield* control.plan({ flowId: "system/test", input: {} })
                let target = card.approval.target
                if (targetKind === "Node") {
                  yield* control.approve(card.approval)
                  const launched = yield* control.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: "authority:launch"
                  })
                  if (launched._tag !== "Accepted" || launched.runId === undefined) {
                    return yield* Effect.die("expected a run")
                  }
                  target = {
                    _tag: "Node",
                    runId: launched.runId,
                    requestId: "ask",
                    digest: "ask",
                    envelope: card.envelope
                  }
                  yield* runtime.registerApproval(target)
                }
                const before = yield* runtime.lookupApproval(target)
                const grants = yield* runtime.grants
                const input = { target, scope, principal, idempotencyKey: "authority:decision" }
                const result = yield* Effect.exit(
                  decision === "approved" ? control.approve(input) : control.deny(input)
                )
                expect(result._tag).toBe("Failure")
                if (result._tag === "Success") return
                const error = yield* Effect.flip(Effect.failCause(result.cause))
                expect(error._tag).toBe("/control/Unauthorized")
                expect(yield* runtime.lookupApproval(target)).toEqual(before)
                expect(yield* runtime.grants).toEqual(grants)
                const refusals = (yield* Stream.runCollect(control.watch({ follow: false })))
                  .filter((event) => event.kind === "control.approval.refused")
                expect(refusals).toHaveLength(1)
                expect(refusals[0]).toMatchObject({
                  runId: target._tag === "Plan" ? `plan:${target.planId}` : target.runId,
                  payload: { decision, principal: { id: principal.id, kind: principal.kind }, scope, target }
                })
              }).pipe(Effect.provide(adapter === "memory" ? live() : durable()), Effect.scoped)
            )
          })
        }
      }
    }
  }
})
