import * as Dialect from "@smthrs/database/Dialect"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import {
  ApprovalDecision,
  ApprovalDenied,
  ApprovalPending,
  ControlRuntime,
  requireApproved
} from "../src/ControlRuntime.ts"
import { initial } from "../src/migrations/0001_control_tables.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import { durable as baseDurable, fileBundle } from "./DurableStack.ts"
import { live as baseLive, memoryRuntime } from "./TestStack.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-approval-decision-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const principal = { id: "reviewer", kind: "operator", stampedAt: 5 }
const approvalAuthority = delegateApproval(principal, { id: "another-reviewer", kind: "operator" })
const durable = (options: Parameters<typeof baseDurable>[0] = {}) => baseDurable({ ...options, approvalAuthority })
const live = () => baseLive({ runtime: memoryRuntime({ approvalAuthority }) })

const pendingRequest = Effect.gen(function*() {
  const control = yield* Control
  const runtime = yield* ControlRuntime
  const card = yield* control.plan({ flowId: "system/test", input: {} })
  yield* control.approve(card.approval)
  const launched = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "decision:launch"
  })
  if (launched._tag !== "Accepted" || launched.runId === undefined) {
    return yield* Effect.die("expected a run")
  }
  const target = {
    _tag: "Node" as const,
    runId: launched.runId,
    requestId: "clearance",
    digest: "clearance-v1",
    envelope: card.envelope
  }
  return { target, token: yield* runtime.registerApproval(target) }
})

describe("approval decisions are not merely resolutions", () => {
  it("bounds terminal decision times to nonnegative safe integer milliseconds", () => {
    const accepts = Schema.is(ApprovalDecision)
    for (const _tag of ["Approved", "Denied"] as const) {
      for (const decidedAt of [0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
        expect(accepts({ _tag, decisionPrincipal: principal, decidedAt, scope: "once" })).toBe(true)
      }
      for (const decidedAt of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "0", null]) {
        expect(accepts({ _tag, decisionPrincipal: principal, decidedAt, scope: "once" })).toBe(false)
      }
    }
  })

  for (const adapter of ["memory", "sql"] as const) {
    for (const decision of ["approved", "denied"] as const) {
      it(`${adapter}: returns ${decision} explicitly when an in-run request is read again`, async () => {
        const observed = await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control
            const runtime = yield* ControlRuntime
            const { target, token: before } = yield* pendingRequest
            const input = { target, scope: "remembered" as const, idempotencyKey: "decision:resolve", principal }
            yield* (decision === "approved" ? control.approve(input) : control.deny(input))
            const after = yield* runtime.registerApproval(target)
            const duplicate = yield* (decision === "approved" ? control.approve(input) : control.deny(input))
            const opposite = yield* Effect.flip(
              runtime.resolveApproval(before, decision === "approved" ? "denied" : "approved", {
                ...principal,
                id: "another-reviewer"
              })
            )
            const final = yield* runtime.registerApproval(target)
            const invalid = yield* Effect.flip(
              runtime.resolveApproval(before, "approved", principal, "invalid" as never)
            )
            return { before, after, duplicate, opposite, final, invalid }
          }).pipe(Effect.provide(adapter === "memory" ? live() : durable()), Effect.scoped)
        )

        expect(observed.before).toMatchObject({ _tag: "Pending", tokenId: "clearance" })
        expect(observed.after).toMatchObject({
          _tag: decision === "approved" ? "Approved" : "Denied",
          tokenId: "clearance",
          decisionPrincipal: { kind: "operator" },
          decidedAt: expect.any(Number),
          ...(decision === "approved" ? { scope: "remembered" } : {})
        })
        expect(observed.after).not.toHaveProperty("resolved")
        expect(observed.duplicate._tag).toBe("AlreadyApplied")
        expect(observed.opposite._tag).toBe("/control/AlreadyResolved")
        expect(observed.final).toEqual(observed.after)
        expect(observed.invalid._tag).toBe("/control/PersistenceError")
      })
    }
  }

  it("only the approved tag opens the helper", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const { target, token } = yield* pendingRequest
        const pending = yield* Effect.flip(requireApproved(token))
        expect(pending).toBeInstanceOf(ApprovalPending)
        expect(pending.message).toContain("still pending")
        const denied = yield* Effect.flip(requireApproved({
          tokenId: token.tokenId,
          target,
          _tag: "Denied",
          decisionPrincipal: principal,
          decidedAt: 0
        }))
        expect(denied).toBeInstanceOf(ApprovalDenied)
        expect(denied.message).toContain("denied")
        const approved = {
          tokenId: token.tokenId,
          target,
          _tag: "Approved" as const,
          decisionPrincipal: principal,
          decidedAt: 0,
          scope: "once" as const
        }
        expect(yield* requireApproved(approved)).toEqual(approved)
      }).pipe(Effect.provide(live()), Effect.scoped)
    )
  })

  for (const decision of ["pending", "approved", "denied"] as const) {
    it(`preserves ${decision} across independent SQLite service/connection reopen`, async () => {
      const filename = join(directory, `${decision}.sqlite`)
      const before = await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const { target, token } = yield* pendingRequest
          if (decision !== "pending") yield* runtime.resolveApproval(token, decision, principal, "run")
          return { target, token: yield* runtime.registerApproval(target) }
        }).pipe(Effect.provide(durable({ database: fileBundle(filename) })), Effect.scoped)
      )
      const after = await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          return yield* runtime.registerApproval(before.target)
        }).pipe(Effect.provide(durable({ database: fileBundle(filename) })), Effect.scoped)
      )
      expect(after).toEqual(before.token)
    })
  }

  it("rolls a decision back with its enclosing transaction, then retries", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const writer = yield* DurableWriter
        const { target, token } = yield* pendingRequest
        const rolledBack = yield* Effect.flip(writer.write(Effect.gen(function*() {
          yield* runtime.resolveApproval(token, "approved", principal, "remembered")
          expect((yield* runtime.registerApproval(target))._tag).toBe("Approved")
          return yield* Effect.fail("rollback")
        })))
        expect(rolledBack).toBe("rollback")
        expect(yield* runtime.registerApproval(target)).toEqual(token)
        yield* runtime.resolveApproval(token, "denied", principal)
        expect((yield* runtime.registerApproval(target))._tag).toBe("Denied")
      }).pipe(Effect.provide(durable()), Effect.scoped)
    )
  })

  it("captures the deciding principal before the writer boundary", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const writer = yield* DurableWriter
        const { target, token } = yield* pendingRequest
        const actor = { ...principal }
        const intercepted: typeof writer = {
          ...writer,
          write: (effect) => {
            actor.id = "changed-after-validation"
            return writer.write(effect)
          }
        }
        const deciding = yield* SqlControlRuntime.make({ approvalAuthority }).pipe(
          Effect.provideService(DurableWriter, intercepted)
        )
        yield* deciding.resolveApproval(token, "approved", actor)
        expect(yield* runtime.registerApproval(target)).toMatchObject({
          _tag: "Approved",
          decisionPrincipal: principal
        })
      }).pipe(Effect.provide(durable()), Effect.scoped)
    )
  })

  it("cannot redirect a plan decision by mutating the token while the writer is entered", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const writer = yield* DurableWriter
        const first = yield* runtime.plan({ flowId: "system/test", input: { plan: 1 } })
        const second = yield* runtime.plan({ flowId: "system/test", input: { plan: 2 } })
        const token = yield* runtime.lookupApproval(first.card.approval.target)
        const intercepted: typeof writer = {
          ...writer,
          write: (effect) => {
            Object.assign(token.target, { planId: second.card.planId })
            return writer.write(effect)
          }
        }
        const deciding = yield* SqlControlRuntime.make({ approvalAuthority }).pipe(
          Effect.provideService(DurableWriter, intercepted)
        )
        yield* deciding.resolveApproval(token, "approved", principal)
        expect((yield* runtime.getPlan(first.card.planId)).decision).toBe("approved")
        expect((yield* runtime.getPlan(second.card.planId)).decision).toBe("pending")
      }).pipe(Effect.provide(durable()), Effect.scoped)
    )
  })

  it("does not leave a grant, receipt, resume, or decision event after resolution storage fails", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const sql = yield* SqlClient.SqlClient
        const journal = yield* Journal.Journal
        const { target, token } = yield* pendingRequest
        yield* Dialect.trigger(sql, {
          name: `refuse_node_decision`,
          table: `control_tokens`,
          event: `BEFORE UPDATE OF decision_json`,
          when: `NEW.target_tag = 'Node'`,
          reject: "injected decision failure"
        })
        const input = { target, scope: "remembered" as const, idempotencyKey: "decision:storage-fault", principal }
        const error = yield* Effect.flip(control.approve(input))
        expect(error._tag).toBe("/control/PersistenceError")
        expect(yield* runtime.registerApproval(target)).toEqual(token)
        expect((yield* runtime.grants).filter((grant) => grant.tokenId === token.tokenId)).toEqual([])
        expect(yield* runtime.pendingResumes).toEqual([])
        yield* journal.flush
        expect((yield* journal.entries({ runId: JournalEvent.RunId.make(target.runId), limit: 100 })).entries
          .filter((entry) => entry.eventType.startsWith("control.approval."))).toEqual([])
        yield* TestDatabase.dropTrigger(sql, "refuse_node_decision")
        expect((yield* control.approve(input))._tag).toBe("Accepted")
        expect((yield* runtime.registerApproval(target))._tag).toBe("Approved")
        expect((yield* runtime.grants).filter((grant) => grant.tokenId === token.tokenId)).toHaveLength(1)
      }).pipe(Effect.provide(durable()), Effect.scoped)
    )
  })

  const corruptions = [
    { name: "legacy terminal without an answer", resolved: 1, json: null, principal: null },
    { name: "malformed JSON", resolved: 1, json: "{\"RAW-SECRET\":", principal: null },
    { name: "unknown tag", resolved: 1, json: "{\"_tag\":\"RAW-SECRET\"}", principal: null },
    { name: "approved without metadata", resolved: 1, json: "{\"_tag\":\"Approved\"}", principal: null },
    { name: "pending under a resolved marker", resolved: 1, json: "{\"_tag\":\"Pending\"}", principal: null },
    { name: "invalid resolution integer", resolved: 2, json: "{\"_tag\":\"Pending\"}", principal: null },
    {
      name: "principal on a pending token",
      resolved: 0,
      json: "{\"_tag\":\"Pending\"}",
      principal: JSON.stringify(principal)
    },
    { name: "invalid principal JSON", resolved: 0, json: null, principal: "\"RAW-SECRET\"" },
    {
      name: "terminal answer under pending marker",
      resolved: 0,
      json: JSON.stringify({ _tag: "Denied", decisionPrincipal: principal, decidedAt: 0 }),
      principal: JSON.stringify(principal)
    },
    {
      name: "missing terminal principal",
      resolved: 1,
      json: JSON.stringify({ _tag: "Denied", decisionPrincipal: principal, decidedAt: 0 }),
      principal: null
    }
  ]
  for (const corruption of corruptions) {
    it(`refuses ${corruption.name} without leaking stored content`, async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const sql = yield* SqlClient.SqlClient
          const { target } = yield* pendingRequest
          yield* sql`UPDATE control_tokens SET resolved = ${corruption.resolved}, decision_json = ${corruption.json},
          decision_principal_json = ${corruption.principal}
          WHERE target_tag = 'Node' AND run_id = ${target.runId} AND target_id = ${target.requestId}`
          const read = yield* Effect.flip(runtime.registerApproval(target))
          const lookup = yield* Effect.flip(runtime.lookupApproval(target))
          for (const failure of [read, lookup]) {
            expect(failure._tag).toBe("/control/PersistenceError")
            expect(failure.message).not.toContain("RAW-SECRET")
          }
        }).pipe(Effect.provide(durable()), Effect.scoped)
      )
    })
  }

  it("upgrades legacy columns without guessing old terminal decisions or rewriting evidence", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* initial
        const sql = yield* SqlClient.SqlClient
        for (const resolved of [0, 1]) {
          yield* sql`INSERT INTO control_tokens
          (target_tag, run_id, target_id, token_id, target_json, resolved, decision_principal_json)
          VALUES ('Plan', '', ${`old-${resolved}`}, ${`old-${resolved}`}, '{}', ${resolved}, NULL)`
        }
        yield* SqlControlRuntime.migrate
        yield* SqlControlRuntime.migrate
        expect(yield* sql`SELECT token_id, resolved, decision_json FROM control_tokens ORDER BY token_id`).toEqual([
          { token_id: "old-0", resolved: 0, decision_json: null },
          { token_id: "old-1", resolved: 1, decision_json: null }
        ])
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
    )
  })
})
