import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * The durable runtime against rows it did not write.
 *
 * `SqlControlRuntime.test.ts` drives the adapter through its own API, which is
 * the only way to reach the states the adapter itself produces. Everything
 * here is the other half: a row a second process rewrote, an identity column
 * that no longer matches the JSON beside it, an idempotency key claimed
 * between this call's read and its write, a journal row written by the engine.
 * Those states are what a shared `.flows/control.db` actually contains, and no
 * sequence of calls on one runtime can produce them.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Migrations } from "@smthrs/journal"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import { type Crypto, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import {
  AlreadyResolved,
  ClaimLost,
  type ControlError,
  EnvelopeMismatch,
  InvalidInput,
  PersistenceError,
  PlanDigestMismatch,
  PlanNotFound,
  RunNotFound
} from "../src/ControlError.ts"
import { ControlRuntime, type Service as ControlRuntimeService } from "../src/ControlRuntime.ts"
import type { Envelope, Principal } from "../src/ControlSchema.ts"
import { canonical } from "../src/internal/planning.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const principal: Principal = { id: "operator", kind: "test", stampedAt: 3 }

const flows: ReadonlyArray<SqlControlRuntime.DurableFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope }
]

/** The journal, run store, and database one durable runtime is built over. */
const database = (): Layer.Layer<
  RunStore.RunStore | DurableWriter | SqlClient.SqlClient
> =>
  RunStore.layer.pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        DatabaseMigrations.layer([Migrations.set, RunStoreMigrations.set]),
        TestDatabase.layer
      )
    )
  ) as Layer.Layer<RunStore.RunStore | DurableWriter | SqlClient.SqlClient>

/**
 * Runs a body against a durable runtime and the raw SQL client under it.
 *
 * The client is the point: these cases write the rows a second process would
 * have written.
 */
const withRuntime = <A, E>(
  use: (
    runtime: ControlRuntimeService,
    sql: SqlClient.SqlClient
  ) => Effect.Effect<A, E, RunStore.RunStore | SqlClient.SqlClient | DurableWriter | Crypto.Crypto>,
  options: SqlControlRuntime.Options = { flows }
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* SqlControlRuntime.make({ approvalAuthority: delegateApproval(principal), ...options })
      const sql = yield* SqlClient.SqlClient
      return yield* use(runtime, sql)
    }).pipe(
      Effect.provide(Layer.merge(database(), NodeCrypto.layer)),
      Effect.scoped,
      Effect.orDie
    )
  )

/** Plans, approves, and launches one run through the durable port itself. */
const start = (runtime: ControlRuntimeService, suite: string) =>
  Effect.gen(function*() {
    const { card } = yield* runtime.plan({ flowId: "system/test", input: { suite } })
    const token = yield* runtime.lookupApproval(card.approval.target)
    yield* runtime.resolveApproval(token, "approved", principal)
    const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
    if (launched._tag !== "Started") return yield* Effect.die("expected a started run")
    return { card, runId: launched.run.runId }
  })

const nodeTarget = (runId: string) => ({
  _tag: "Node" as const,
  runId,
  requestId: "ask/edges",
  digest: "ask-digest",
  envelope
})

describe("SqlControlRuntime against a rewritten row", () => {
  it("round trips an explicit null plan input through non-null persisted JSON", async () => {
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const planned = yield* runtime.plan({ flowId: "system/test", input: null })
        const stored = yield* runtime.getPlan(planned.card.planId)
        const rows = yield* sql<{ readonly json: string }>`
          SELECT decoded_input_json AS "json" FROM control_plans WHERE plan_id = ${planned.card.planId}
        `
        return { planned, stored, rows }
      })
    )
    expect(observed.planned.created).toBe(true)
    expect(observed.planned.card.inputSummary).toBe("null")
    expect(observed.stored.decodedInput).toBeNull()
    expect(observed.stored.card).toEqual(observed.planned.card)
    expect(observed.rows).toEqual([{ json: "null" }])
  })

  it.each(["plan", "run", "resume"] as const)("refuses a %s sequence removed by storage and recovers", async (name) => {
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const allocate: Effect.Effect<string, ControlError> = yield* Effect.gen(function*() {
          if (name === "plan") {
            return runtime.plan({ flowId: "system/test", input: { fault: "sequence" } }).pipe(
              Effect.map(({ card }) => card.planId)
            )
          }
          if (name === "resume") {
            const { runId } = yield* start(runtime, "resume-sequence")
            return runtime.requestResume(runId).pipe(Effect.map((sequence) => `resume-${sequence}`))
          }
          const { card } = yield* runtime.plan({ flowId: "system/test", input: { fault: "run-sequence" } })
          const token = yield* runtime.lookupApproval(card.approval.target)
          yield* runtime.resolveApproval(token, "approved", principal)
          return runtime.launch(card.planId, card.digest, card.envelope).pipe(
            Effect.flatMap((result) =>
              result._tag === "Started"
                ? Effect.succeed(result.run.runId)
                : Effect.die("expected a started run")
            )
          )
        })
        const pg = sql.onDialectOrElse({ pg: () => true, orElse: () => false })
        if (pg) {
          yield* sql.unsafe(`CREATE FUNCTION remove_new_sequence() RETURNS trigger AS $$
            BEGIN
              DELETE FROM control_sequences WHERE name = NEW.name;
              RETURN NEW;
            END;
          $$ LANGUAGE plpgsql`)
          yield* sql.unsafe(`CREATE TRIGGER remove_new_sequence AFTER INSERT ON control_sequences
            FOR EACH ROW EXECUTE FUNCTION remove_new_sequence()`)
        } else {
          yield* sql.unsafe(`CREATE TRIGGER remove_new_sequence AFTER INSERT ON control_sequences BEGIN
            DELETE FROM control_sequences WHERE name = NEW.name;
          END`)
        }
        const failure = yield* Effect.flip(allocate)
        const table = { plan: "control_plans", run: "control_runs", resume: "control_run_resumes" }[name]
        const stored = yield* sql.unsafe(`SELECT * FROM ${table}`)
        yield* sql.unsafe(
          pg ? "DROP TRIGGER remove_new_sequence ON control_sequences" : "DROP TRIGGER remove_new_sequence"
        )
        const recovered = yield* allocate
        return { failure, stored, recovered }
      })
    )
    expect(observed.failure).toBeInstanceOf(PersistenceError)
    expect(observed.failure).toMatchObject({ operation: "allocate a sequence" })
    expect(observed.stored).toEqual([])
    expect(observed.recovered).toBe(`${name}-1`)
  })

  it.each([-2, -1, Number.MAX_SAFE_INTEGER])("rolls back a rejected sequence increment from %s", async (value) => {
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        yield* sql`INSERT INTO control_sequences (name, value) VALUES ('plan', ${value})`
        const failure = yield* Effect.flip(runtime.plan({ flowId: "system/test", input: {} }))
        const counters = yield* sql<{ value: number }>`SELECT value FROM control_sequences WHERE name = 'plan'`
        const plans = yield* sql`SELECT plan_id FROM control_plans`
        yield* sql`UPDATE control_sequences SET value = 40 WHERE name = 'plan'`
        const recovered = yield* runtime.plan({ flowId: "system/test", input: {} })
        return { failure, counters, plans, recovered }
      })
    )
    expect(observed.failure).toBeInstanceOf(PersistenceError)
    expect(observed.failure).toMatchObject({ operation: "allocate a sequence" })
    expect((observed.failure as PersistenceError).cause).toEqual(
      new Error("Sequence plan did not return a positive safe integer")
    )
    expect(observed.counters.map((row) => Number(row.value))).toEqual([value])
    expect(observed.plans).toEqual([])
    expect(observed.recovered.card.planId).toBe("plan-41")
  })

  it("allocates the largest exact sequence once and refuses exhaustion without committing", async () => {
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        yield* sql`INSERT INTO control_sequences (name, value) VALUES ('plan', ${Number.MAX_SAFE_INTEGER - 1})`
        const last = yield* runtime.plan({ flowId: "system/test", input: {} })
        const failure = yield* Effect.flip(runtime.plan({ flowId: "system/test", input: {} }))
        const counters = yield* sql<{ value: number }>`SELECT value FROM control_sequences WHERE name = 'plan'`
        const plans = yield* sql`SELECT plan_id FROM control_plans`
        return { last, failure, counters, plans }
      })
    )
    expect(observed.last.card.planId).toBe("plan-9007199254740991")
    expect(observed.failure).toBeInstanceOf(PersistenceError)
    expect(observed.failure).toMatchObject({ operation: "allocate a sequence" })
    expect(observed.counters.map((row) => Number(row.value))).toEqual([Number.MAX_SAFE_INTEGER])
    expect(observed.plans).toEqual([{ plan_id: "plan-9007199254740991" }])
  })

  it("refuses an approval row removed by storage before readback and recovers after repair", async () => {
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "approval-readback")
        const target = nodeTarget(runId)
        // A real database trigger stages a faulty persistence boundary without
        // replacing the SQL client or fabricating an impossible client result.
        const pg = sql.onDialectOrElse({ pg: () => true, orElse: () => false })
        if (pg) {
          yield* sql.unsafe(`CREATE FUNCTION remove_new_approval() RETURNS trigger AS $$
            BEGIN
              DELETE FROM control_tokens WHERE target_tag = NEW.target_tag
                AND run_id = NEW.run_id AND target_id = NEW.target_id;
              RETURN NEW;
            END;
          $$ LANGUAGE plpgsql`)
          yield* sql.unsafe(`CREATE TRIGGER remove_new_approval AFTER INSERT ON control_tokens
            FOR EACH ROW EXECUTE FUNCTION remove_new_approval()`)
        } else {
          yield* sql.unsafe(`CREATE TRIGGER remove_new_approval AFTER INSERT ON control_tokens BEGIN
            DELETE FROM control_tokens WHERE target_tag = NEW.target_tag
              AND run_id = NEW.run_id AND target_id = NEW.target_id;
          END`)
        }
        const failure = yield* Effect.flip(runtime.registerApproval(target))
        yield* sql.unsafe(
          pg ? "DROP TRIGGER remove_new_approval ON control_tokens" : "DROP TRIGGER remove_new_approval"
        )
        const recovered = yield* runtime.registerApproval(target)
        const readback = yield* runtime.lookupApproval(target)
        return { failure, recovered, readback }
      })
    )
    expect(observed.failure).toBeInstanceOf(PersistenceError)
    expect(observed.failure).toMatchObject({
      operation: "register an approval token",
      message: "A registered approval token could not be read back"
    })
    expect(observed.recovered._tag).toBe("Pending")
    expect(observed.readback).toEqual(observed.recovered)
  })

  it("refuses a run claim removed by storage before readback and recovers after repair", async () => {
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const pg = sql.onDialectOrElse({ pg: () => true, orElse: () => false })
        if (pg) {
          yield* sql.unsafe(`CREATE FUNCTION remove_new_run_claim() RETURNS trigger AS $$
            BEGIN
              DELETE FROM control_run_keys WHERE idempotency_key = NEW.idempotency_key;
              RETURN NEW;
            END;
          $$ LANGUAGE plpgsql`)
          yield* sql.unsafe(`CREATE TRIGGER remove_new_run_claim AFTER INSERT ON control_run_keys
            FOR EACH ROW EXECUTE FUNCTION remove_new_run_claim()`)
        } else {
          yield* sql.unsafe(`CREATE TRIGGER remove_new_run_claim AFTER INSERT ON control_run_keys BEGIN
            DELETE FROM control_run_keys WHERE idempotency_key = NEW.idempotency_key;
          END`)
        }
        const failure = yield* Effect.flip(runtime.claimRunKey("run:readback", "fingerprint"))
        const missing = yield* sql`SELECT idempotency_key FROM control_run_keys WHERE idempotency_key = 'run:readback'`
        yield* sql.unsafe(
          pg ? "DROP TRIGGER remove_new_run_claim ON control_run_keys" : "DROP TRIGGER remove_new_run_claim"
        )
        const recovered = yield* runtime.claimRunKey("run:readback", "fingerprint")
        return { failure, missing, recovered }
      })
    )
    expect(observed.failure).toBeInstanceOf(PersistenceError)
    expect(observed.failure).toMatchObject({
      operation: "claim a run key",
      message: "Run key run:readback disappeared while it was being claimed"
    })
    expect(observed.missing).toEqual([])
    expect(observed.recovered).toEqual({ _tag: "Claimed" })
  })

  it("refuses unavailable flow catalogs without storing a plan and recovers on the next read", async () => {
    let unavailable = true
    const failure = new PersistenceError({ operation: "load flows", message: "Registry unavailable" })
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const planFailure = yield* Effect.flip(runtime.plan({ flowId: "system/test", input: {} }))
        const listFailure = yield* Effect.flip(runtime.listFlows)
        unavailable = false
        const listed = yield* runtime.listFlows
        const planned = yield* runtime.plan({ flowId: "system/test", input: {} })
        return { planFailure, listFailure, listed, planned }
      }), {
      loadFlows: () => unavailable ? Effect.fail(failure) : Effect.succeed(flows)
    })
    expect(observed.planFailure).toBe(failure)
    expect(observed.listFailure).toBe(failure)
    expect(observed.listed).toEqual([{ flowId: "system/test", description: "Reserved test system flow" }])
    expect(observed.planned.card.planId).toBe("plan-1")
  })

  it("refuses a token whose stored target no longer matches the identity columns", async () => {
    // The composite columns select the token; the JSON beside them is what the
    // decision is made against. A process that rewrote only the blob could
    // otherwise smuggle a foreign target through a lookup that selected this
    // run's row.
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "rewritten")
        const target = nodeTarget(runId)
        yield* runtime.registerApproval(target)
        yield* sql`
          UPDATE control_tokens
          SET target_json = ${JSON.stringify({ ...target, runId: "run-elsewhere" })}
          WHERE target_tag = 'Node' AND run_id = ${runId}
        `
        return {
          looked: yield* Effect.flip(runtime.lookupApproval(target)),
          registered: yield* Effect.flip(runtime.registerApproval(target))
        }
      })
    )

    for (const error of [observed.looked, observed.registered]) {
      expect(error).toBeInstanceOf(PersistenceError)
      expect((error as PersistenceError).operation).toBe("validate an approval token")
    }
  })

  it("names the run or the plan a missing token was asked about", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        return {
          node: yield* Effect.flip(runtime.lookupApproval(nodeTarget("run-never-registered"))),
          plan: yield* Effect.flip(
            runtime.lookupApproval({ _tag: "Plan", planId: "plan-absent", digest: "d", envelope })
          )
        }
      })
    )

    expect(observed.node).toBeInstanceOf(RunNotFound)
    expect((observed.node as RunNotFound).runId).toBe("run-never-registered")
    expect(observed.plan).toBeInstanceOf(PlanNotFound)
    expect((observed.plan as PlanNotFound).planId).toBe("plan-absent")
  })

  it("refuses a re-registration whose digest or envelope moved, and a decision already made", async () => {
    // One request id names one ask. A second registration under it that
    // carries a different digest or a wider envelope is a different ask, and
    // approving it would approve something the operator never read.
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "re-registered")
        const target = nodeTarget(runId)
        const token = yield* runtime.registerApproval(target)
        const digest = yield* Effect.flip(runtime.registerApproval({ ...target, digest: "another-digest" }))
        const widened = yield* Effect.flip(
          runtime.registerApproval({ ...target, envelope: { ...envelope, capabilities: ["fs:write"] } })
        )
        yield* runtime.resolveApproval(token, "approved", principal)
        const twice = yield* Effect.flip(runtime.resolveApproval(token, "denied", principal))
        return { digest, twice, widened }
      })
    )

    expect(observed.digest).toBeInstanceOf(PlanDigestMismatch)
    expect(observed.widened).toBeInstanceOf(EnvelopeMismatch)
    // The token is spent, and the second decision is refused rather than
    // overwriting the first one's principal.
    expect(observed.twice).toBeInstanceOf(AlreadyResolved)
  })

  it("refuses a launch whose digest or envelope disagrees with the stored card", async () => {
    // The card is what was approved. A launch that names the plan but not the
    // card an operator read is a different program.
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { card } = yield* start(runtime, "launch-mismatch")
        return {
          digest: yield* Effect.flip(runtime.launch(card.planId, "another-digest", card.envelope)),
          envelope: yield* Effect.flip(
            runtime.launch(card.planId, card.digest, { ...card.envelope, capabilities: ["fs:write"] })
          )
        }
      })
    )

    expect(observed.digest).toBeInstanceOf(PlanDigestMismatch)
    expect(observed.envelope).toBeInstanceOf(EnvelopeMismatch)
  })
})

describe("SqlControlRuntime and a key another process claimed", () => {
  it("reports the plan a winning key names but no longer stores", async () => {
    // The pre-check found the key and fell through because the plan it names is
    // gone; the conditional insert then lost to the same row. A key pointing at
    // a plan nobody can read is corruption, and it is reported as such rather
    // than answered with a freshly built card the key does not name.
    const error = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const fingerprint = canonical({ flowId: "system/test", input: { suite: "ghost" } })
        yield* sql`
          INSERT INTO control_plan_keys (idempotency_key, fingerprint, plan_id)
          VALUES ('plan:ghost', ${fingerprint}, 'plan-ghost')
        `
        return yield* Effect.flip(
          runtime.plan({ flowId: "system/test", input: { suite: "ghost" }, idempotencyKey: "plan:ghost" })
        )
      })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("read a plan")
    expect((error as PersistenceError).message).toContain("plan-ghost")
  })

  it("answers with the winner's card when a peer claims the key mid-plan", async () => {
    // The insert is a conditional claim followed by a read of whoever holds it.
    // The peer's row is written from inside this plan's own graph hook, which
    // is the one point between this call's key read and its key write.
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const winner = yield* runtime.plan({ flowId: "system/test", input: { suite: "raced" } })
        const claim = sql`
          INSERT INTO control_plan_keys (idempotency_key, fingerprint, plan_id)
          VALUES ('plan:raced', ${
          canonical({ flowId: "system/raced", input: { suite: "raced" } })
        }, ${winner.card.planId})
        `.pipe(Effect.orDie)
        const runtimeWithPeer = yield* SqlControlRuntime.make({
          flows: [
            {
              flowId: "system/raced",
              description: "A flow whose planning is interrupted by a peer",
              deployClass: false,
              envelope,
              // Runs after the key read and before the key write.
              plan: () => Effect.as(claim, { plan: undefined as never })
            }
          ]
        })
        const raced = yield* runtimeWithPeer.plan({
          flowId: "system/raced",
          input: { suite: "raced" },
          idempotencyKey: "plan:raced"
        })
        return { raced, winner }
      })
    )

    // The card the key already names, and no claim that this call created it.
    expect(observed.raced.created).toBe(false)
    expect(observed.raced.card.planId).toBe(observed.winner.card.planId)
  })

  it("refuses the loser of a race whose peer claimed the key for another plan", async () => {
    // Same race, different intent. The key promises one operation, and the
    // caller that lost must be told its plan was not the one stored rather
    // than handed a stranger's card.
    const error = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const winner = yield* runtime.plan({ flowId: "system/test", input: { suite: "loser" } })
        const claim = sql`
          INSERT INTO control_plan_keys (idempotency_key, fingerprint, plan_id)
          VALUES ('plan:loser', 'another-plans-fingerprint', ${winner.card.planId})
        `.pipe(Effect.orDie)
        const runtimeWithPeer = yield* SqlControlRuntime.make({
          flows: [
            {
              flowId: "system/raced",
              description: "A flow whose planning is interrupted by a peer",
              deployClass: false,
              envelope,
              plan: () => Effect.as(claim, { plan: undefined as never })
            }
          ]
        })
        return yield* Effect.flip(
          runtimeWithPeer.plan({ flowId: "system/raced", input: { suite: "loser" }, idempotencyKey: "plan:loser" })
        )
      })
    )

    expect(error).toBeInstanceOf(InvalidInput)
    expect((error as InvalidInput).issue).toBe("idempotency key plan:loser was used for another plan")
  })

  it("lays a planner's budget over the flow's, and keys it into the plan's identity", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const plain = yield* runtime.plan({ flowId: "system/test", input: {}, idempotencyKey: "plan:budget" })
        const budgeted = yield* runtime.plan({
          flowId: "system/test",
          input: {},
          budget: { tokens: 50, onExceeded: "park" }
        })
        const reused = yield* Effect.flip(runtime.plan({
          flowId: "system/test",
          input: {},
          idempotencyKey: "plan:budget",
          budget: { tokens: 50 }
        }))
        return { plain, budgeted, reused }
      })
    )

    expect(observed.budgeted.card.envelope.budget).toEqual({
      ...observed.plain.card.envelope.budget,
      tokens: 50,
      onExceeded: "park"
    })
    expect(observed.reused).toBeInstanceOf(InvalidInput)
    expect((observed.reused as InvalidInput).issue).toBe("idempotency key plan:budget was used for another plan")
  })

  it("refuses a key that already names a different plan", async () => {
    const error = await withRuntime((runtime) =>
      Effect.gen(function*() {
        yield* runtime.plan({ flowId: "system/test", input: { suite: "first" }, idempotencyKey: "plan:reused" })
        return yield* Effect.flip(
          runtime.plan({ flowId: "system/test", input: { suite: "second" }, idempotencyKey: "plan:reused" })
        )
      })
    )

    expect(error).toBeInstanceOf(InvalidInput)
    expect((error as InvalidInput).issue).toBe("idempotency key plan:reused was used for another plan")
  })

  it("refuses an input the flow's own decoder rejects, and one with no canonical form", async () => {
    const observed = await withRuntime(
      (runtime) =>
        Effect.gen(function*() {
          return {
            decoded: yield* Effect.flip(runtime.plan({ flowId: "system/decoded", input: { ok: false } })),
            // The wrapper `{ flowId, input }` drops an absent member, so this
            // one has a canonical form until the INPUT itself is canonicalized
            // by the flow-less decode path.
            fallback: yield* Effect.flip(runtime.plan({ flowId: "system/test", input: undefined })),
            uncanonical: yield* Effect.flip(runtime.plan({ flowId: "system/test", input: Number.NaN }))
          }
        }),
      {
        flows: [
          ...flows,
          {
            flowId: "system/decoded",
            description: "A flow that decodes its own input",
            deployClass: false,
            envelope,
            decode: (input) =>
              (input as { readonly ok?: unknown }).ok === true
                ? Effect.succeed(input)
                : Effect.fail(new InvalidInput({ issue: "$.ok: must be true" }))
          }
        ]
      }
    )

    expect(observed.decoded).toBeInstanceOf(InvalidInput)
    expect((observed.decoded as InvalidInput).issue).toBe("$.ok: must be true")
    expect(observed.fallback).toBeInstanceOf(InvalidInput)
    expect((observed.fallback as InvalidInput).issue).toBe("$: canonical_unsupported_value")
    expect(observed.uncanonical).toBeInstanceOf(InvalidInput)
    expect((observed.uncanonical as InvalidInput).issue).toBe("$.input: canonical_nan")
  })

  it("refuses a raced run-key claim whose settled receipt names another fingerprint", async () => {
    // The claim row and the receipt row are two tables. A process that
    // rewrote only the receipt's fingerprint leaves a key whose claim agrees
    // and whose record does not, and answering that with a launch would run
    // the other mutation's intent under this caller's key.
    const error = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const receipt = { _tag: "Accepted", receiptId: "run:edge", runId: "run-1" } as const
        expect(yield* runtime.claimRunKey("run:edge", "fingerprint-a")).toEqual({ _tag: "Claimed" })
        yield* runtime.recordMutation("run:edge", "fingerprint-a", receipt)
        yield* sql`UPDATE control_mutations SET fingerprint = 'rewritten' WHERE mutation_key = 'run:edge'`
        return yield* Effect.flip(runtime.claimRunKey("run:edge", "fingerprint-a"))
      })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("claim a run key")
  })

  it("reports a raced run-key claim whose settled receipt no longer decodes", async () => {
    const error = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const receipt = { _tag: "Accepted", receiptId: "run:edge", runId: "run-1" } as const
        expect(yield* runtime.claimRunKey("run:edge", "fingerprint-a")).toEqual({ _tag: "Claimed" })
        yield* runtime.recordMutation("run:edge", "fingerprint-a", receipt)
        yield* sql`UPDATE control_mutations SET receipt_json = 'not json' WHERE mutation_key = 'run:edge'`
        return yield* Effect.flip(runtime.claimRunKey("run:edge", "fingerprint-a"))
      })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toContain("control_mutations.receipt_json")
  })
})

describe("SqlControlRuntime reading rows the engine wrote", () => {
  it("attributes a cancel request that names neither a principal nor a reason", async () => {
    // The engine's own cancel writes the column and journals nothing about who
    // asked. The projection still has to report WHEN, because that is the
    // evidence an operator has.
    const summary = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "anonymous-cancel")
        yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES (${runId}, 1, ${`event:${runId}:1`}, '/engine', 1, 1700, 'control.run.cancel-requested', '{}', '{}')
        `
        yield* sql`UPDATE flows_runs SET cancel_requested_at_ms = 1700 WHERE run_id = ${runId}`
        return yield* runtime.getRun(runId)
      })
    )

    expect(summary.cancellation).toMatchObject({ requestedAt: 1700 })
    expect(summary.cancellation?.principal).toBeUndefined()
    expect(summary.cancellation?.reason).toBeUndefined()
  })

  it("ignores an engine interruption that was not a cancellation", async () => {
    // `flows.engine.interrupted` is written for every interruption. Only the
    // cancelled outcome is evidence of a cancellation; reading the rest as one
    // would report a run that failed as a run somebody stopped.
    const summary = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "interrupted")
        yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES (
            ${runId}, 1, ${`event:${runId}:1`}, '/engine', 1, 1700, 'flows.engine.interrupted',
            '{"outcome":"failed","interruptedAtMs":1700}', '{}'
          )
        `
        return yield* runtime.getRun(runId)
      })
    )

    expect(summary.cancellation).toBeUndefined()
  })

  it("attributes an interruption that named no moment to the run all the same", async () => {
    // An older engine wrote the outcome and no timestamp. The run was still
    // cancelled, and reporting nothing would lose that.
    const summary = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "timeless")
        yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES (
            ${runId}, 1, ${`event:${runId}:1`}, '/engine', 1, 1700, 'flows.engine.interrupted',
            '{"outcome":"cancelled"}', '{}'
          )
        `
        return yield* runtime.getRun(runId)
      })
    )

    expect(summary.cancellation).toMatchObject({ source: "engine", requestedAt: 0 })
  })

  it("terminates an ancestry walk on a cycle and on an edge naming a run that is gone", async () => {
    // Ancestry is written by the engine across two tables, and neither is
    // constrained to a tree. A cycle must end the walk instead of taking the
    // control plane down with it, and an edge naming a collected run is one
    // more id in the chain rather than a failure.
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const first = yield* start(runtime, "cycle-a")
        const second = yield* start(runtime, "cycle-b")
        yield* sql`UPDATE flows_runs SET parent_run_id = ${second.runId} WHERE run_id = ${first.runId}`
        yield* sql`UPDATE flows_runs SET parent_run_id = ${first.runId} WHERE run_id = ${second.runId}`
        const spawned = yield* start(runtime, "spawned")
        // The spawn table belongs to `@smthrs/engine-store`; a control-only
        // database has the edges without the engine's own rows, which is what
        // a collected parent looks like from here.
        yield* sql`
          CREATE TABLE IF NOT EXISTS flows_run_parents (
            child_id TEXT NOT NULL,
            parent_id TEXT NOT NULL,
            seq BIGINT NOT NULL,
            PRIMARY KEY (child_id, parent_id)
          )
        `
        yield* sql`
          INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES (${spawned.runId}, 'run-collected', 0)
        `
        return {
          cycled: yield* runtime.getRun(first.runId),
          spawnedRun: yield* runtime.getRun(spawned.runId)
        }
      })
    )

    // The walk ended: a summary came back at all.
    expect(observed.cycled.runId).toBeDefined()
    expect(observed.spawnedRun.parentRunId).toBe("run-collected")
  })

  it("terminates a walk whose spawn edge leads back into the chain it already read", async () => {
    // A trampoline chain that ends at a root, whose root was itself spawned by
    // a run already in the chain. Following the edge re-reads rows the walk
    // has seen, and the visited set is what makes that end.
    const summary = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const root = yield* start(runtime, "back-edge-root")
        const branch = yield* start(runtime, "back-edge-branch")
        yield* sql`UPDATE flows_runs SET parent_run_id = ${root.runId} WHERE run_id = ${branch.runId}`
        yield* sql`
          CREATE TABLE IF NOT EXISTS flows_run_parents (
            child_id TEXT NOT NULL,
            parent_id TEXT NOT NULL,
            seq BIGINT NOT NULL,
            PRIMARY KEY (child_id, parent_id)
          )
        `
        yield* sql`
          INSERT INTO flows_run_parents (child_id, parent_id, seq)
          VALUES (${root.runId}, ${branch.runId}, 0)
        `
        return { branch: branch.runId, root: yield* runtime.getRun(root.runId) }
      })
    )

    // The walk followed the edge, read rows it had already seen, and ended:
    // the root's parent is the spawn edge's own run.
    expect(summary.root.parentRunId).toBe(summary.branch)
  })
})

describe("SqlControlRuntime when the run store answers about another row", () => {
  /** The durable runtime over a run store whose one method is replaced. */
  const withStore = <A, E>(
    override: (store: RunStore.Service) => Partial<RunStore.Service>,
    use: (
      runtime: ControlRuntimeService
    ) => Effect.Effect<A, E, RunStore.RunStore | SqlClient.SqlClient | Crypto.Crypto>
  ): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* SqlControlRuntime.make({ flows, approvalAuthority: delegateApproval(principal) })
        return yield* use(runtime)
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeCrypto.layer,
            Layer.effect(
              RunStore.RunStore,
              Effect.map(RunStore.RunStore, (store) => ({ ...store, ...override(store) }))
            ).pipe(Layer.provideMerge(database()))
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

  it("reports a store failure that is not a missing row as a persistence failure", async () => {
    // `not_found_row` is the one store code this adapter translates. Every
    // other one is storage failing, and reporting it as a missing run would
    // send an operator looking for a run that is right there.
    const error = await withStore(
      () => ({
        get: (runId: string) =>
          Effect.fail(
            new RunStore.RunStoreError({
              code: "persistence_failed",
              method: "get",
              message: `the database refused to read ${runId}`,
              cause: null
            })
          )
      }),
      (runtime) => Effect.flip(runtime.getRun("run-1"))
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("read a run")
  })

  it("answers about the run when a fenced write finds no row and when it loses the fence", async () => {
    // The row is read, then written, and the two are separate statements. A
    // row deleted in between is `RunNotFound`; a row a peer took is
    // `ClaimLost`. Both are answers about the run, never defects.
    const refusedTransition = <A, E>(
      outcome: "NotFound" | "GuardFailed",
      use: (
        runtime: ControlRuntimeService,
        armed: () => void
      ) => Effect.Effect<A, E, RunStore.RunStore | SqlClient.SqlClient>
    ) => {
      let armed = false
      return withStore(
        (store) => ({
          transitionOwned: (runId, guard, status, stateJson) =>
            armed ? Effect.succeed({ _tag: outcome }) : store.transitionOwned(runId, guard, status, stateJson)
        }),
        (runtime) => use(runtime, () => void (armed = true))
      )
    }

    const observed = await refusedTransition("NotFound", (runtime, arm) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "vanishing")
        const fence = yield* runtime.claimFence(runId)
        arm()
        return {
          released: yield* Effect.flip(runtime.releasePending(runId, fence)),
          status: yield* Effect.flip(runtime.writeStatus(runId, fence, "running"))
        }
      }))

    const lost = await refusedTransition("GuardFailed", (runtime, arm) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "guarded")
        const fence = yield* runtime.claimFence(runId)
        arm()
        return yield* Effect.flip(runtime.releasePending(runId, fence))
      }))

    expect(observed.status).toBeInstanceOf(RunNotFound)
    expect(observed.released).toBeInstanceOf(RunNotFound)
    expect(lost).toBeInstanceOf(ClaimLost)
  })

  it("answers about the run when a claim finds no row and when a peer already holds it", async () => {
    // Armed after the first launch, because starting a run needs the very
    // claim these then refuse. A second launch of the same approved plan takes
    // the claim path again, against a store that has moved on.
    const refusedClaim = (outcome: "NotFound" | "AlreadyClaimed") => {
      let armed = false
      return withStore(
        (store) => ({
          claimAndOwn: (runId, snapshot, claimant, nowMs) =>
            armed
              ? Effect.succeed({ _tag: outcome })
              : store.claimAndOwn(runId, snapshot, claimant, nowMs)
        }),
        (runtime) =>
          Effect.gen(function*() {
            const { card } = yield* start(runtime, `claim-${outcome}`)
            armed = true
            return yield* Effect.flip(runtime.launch(card.planId, card.digest, card.envelope))
          })
      )
    }

    expect(await refusedClaim("NotFound")).toBeInstanceOf(ClaimLost)
    expect(await refusedClaim("AlreadyClaimed")).toBeInstanceOf(ClaimLost)
  })

  it("answers about the run when a resume's claim finds no row and when a peer takes it first", async () => {
    // Resuming a parked run re-claims it. The row can be gone by then, and a
    // peer sweep can have claimed it first; the two are different answers and
    // an operator acts differently on each.
    const refusedResume = (outcome: "NotFound" | "HeartbeatFresh") => {
      let armed = false
      return withStore(
        (store) => ({
          claimAndOwn: (runId, snapshot, claimant, nowMs) =>
            armed
              ? Effect.succeed({ _tag: outcome })
              : store.claimAndOwn(runId, snapshot, claimant, nowMs)
        }),
        (runtime) =>
          Effect.gen(function*() {
            const { runId } = yield* start(runtime, `resume-${outcome}`)
            const fence = yield* runtime.claimFence(runId)
            yield* runtime.writeStatus(runId, fence, "parked")
            armed = true
            return yield* Effect.flip(runtime.resume(runId))
          })
      )
    }

    expect(await refusedResume("NotFound")).toBeInstanceOf(RunNotFound)
    expect(await refusedResume("HeartbeatFresh")).toBeInstanceOf(ClaimLost)
  })

  it("answers a settled run's own summary from interrupt", async () => {
    // Terminality is asked first. A settled run released its owner, so asking
    // ownership first answered `ClaimLost` — "somebody else has it" — about a
    // run that had simply finished.
    const summary = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "settled-interrupt")
        const fence = yield* runtime.claimFence(runId)
        yield* runtime.writeStatus(runId, fence, "completed")
        return yield* runtime.interrupt(runId)
      })
    )

    expect(summary.status).toBe("completed")
  })
})

describe("SqlControlRuntime layers and stores", () => {
  it("provides a runtime and its run store over the ambient database", async () => {
    // `layerWithStore` is what a host with a database but no run store
    // composes, and it is the only place the run store's own layer is built
    // from inside this package.
    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        return yield* runtime.listRuns
      }).pipe(
        Effect.provide(
          SqlControlRuntime.layerWithStore().pipe(
            Layer.orDie,
            Layer.provideMerge(
              Layer.merge(
                NodeCrypto.layer,
                Layer.provideMerge(
                  DatabaseMigrations.layer([Migrations.set, RunStoreMigrations.set]),
                  TestDatabase.layer
                )
              )
            )
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(listed).toEqual([])
  })

  it("omits a run whose row vanished between the id index and the read", async () => {
    // Retention and `smithers gc` delete rows while a listing is in flight.
    // One missing row is one row missing from the answer: catching the failure
    // around the whole listing reported no runs at all.
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* SqlControlRuntime.make({ flows, approvalAuthority: delegateApproval(principal) })
        const kept = yield* start(runtime, "kept")
        const collected = yield* start(runtime, "collected")
        const listed = yield* runtime.listRuns
        return { collected: collected.runId, kept: kept.runId, listed }
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeCrypto.layer,
            Layer.effect(
              RunStore.RunStore,
              Effect.map(RunStore.RunStore, (store) => ({
                ...store,
                get: (runId: string) =>
                  runId.endsWith("2")
                    ? Effect.fail(
                      new RunStore.RunStoreError({
                        code: "not_found_row",
                        method: "get",
                        message: `run ${runId} was collected`,
                        cause: null
                      })
                    )
                    : store.get(runId)
              }))
            ).pipe(Layer.provideMerge(database()))
          )
        ),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.listed.map((run) => run.runId)).toEqual([observed.kept])
  })
})

describe("SqlControlRuntime when the tables are gone", () => {
  it("reports a missing relation referenced by the spawn view instead of treating the view as absent", async () => {
    const error = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "broken-spawn-view")
        if (sql.onDialectOrElse({ pg: () => true, orElse: () => false })) {
          // PostgreSQL validates a view's static dependencies at creation. A
          // dynamic query delays the missing-relation failure until the read.
          yield* sql.unsafe(`
            CREATE FUNCTION broken_spawn_edges()
            RETURNS TABLE (child_id TEXT, parent_id TEXT, seq BIGINT)
            LANGUAGE plpgsql AS $$ BEGIN
              RETURN QUERY EXECUTE 'SELECT child_id, parent_id, seq FROM flows_run_parents_archive';
            END $$
          `)
          yield* sql`CREATE VIEW flows_run_parents AS SELECT * FROM broken_spawn_edges()`
        } else {
          yield* sql`
            CREATE VIEW flows_run_parents AS
            SELECT child_id, parent_id, seq FROM flows_run_parents_archive
          `
        }
        return yield* Effect.flip(runtime.getRun(runId))
      })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("read spawn edges")
  })

  it("reports a spawn table whose shape it does not recognize instead of reading no edges", async () => {
    // The engine's tables are optional here: a control-only database has none
    // of them, and an absent one means "no edges". A table that EXISTS and
    // cannot be read is the opposite, and reporting it as no edges would list
    // every child of every run as an orphan.
    const error = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "shapeless-edges")
        yield* sql`CREATE TABLE flows_run_parents (child_id TEXT NOT NULL, parent_id TEXT NOT NULL)`
        return yield* Effect.flip(runtime.getRun(runId))
      })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("read spawn edges")
  })

  it("refuses a run state that is neither a control summary nor an engine state", async () => {
    // `state_json` is one column carrying two shapes, and a row written by
    // something else is neither. The refusal has to be typed and name the
    // column, because a defect here would surface over RPC as an opaque
    // transport failure.
    const error = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "foreign-state")
        yield* sql`UPDATE flows_runs SET state_json = '[]' WHERE run_id = ${runId}`
        return yield* Effect.flip(runtime.getRun(runId))
      })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toContain("flows_runs.state_json")
  })

  it("reports a storage failure rather than a defect for every write it owns", async () => {
    // A dropped table is a half-migrated database. Each operation names itself
    // so an operator reads which durable write failed.
    const failures = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "dropped")
        yield* sql`DROP TABLE control_mutations ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`
        yield* sql`DROP TABLE control_run_messages ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`
        return {
          signals: yield* Effect.flip(runtime.deliveredSignals(runId)),
          recorded: yield* Effect.flip(
            runtime.recordMutation("cancel:dropped", "fingerprint", { _tag: "Accepted", receiptId: "r" })
          )
        }
      })
    )

    expect(failures.recorded).toBeInstanceOf(PersistenceError)
    expect((failures.recorded as PersistenceError).operation).toBe("record a mutation")
    expect(failures.signals).toBeInstanceOf(PersistenceError)
    expect((failures.signals as PersistenceError).operation).toBe("read run messages")
  })

  it("reports a claim on a row another process deleted", async () => {
    // The control row and the run row are two tables. A run row deleted under a
    // live control row is what a partial `gc` leaves, and every fenced write
    // has to answer about the run rather than throw.
    const observed = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "deleted")
        const fence = yield* runtime.claimFence(runId)
        yield* sql`DELETE FROM flows_runs WHERE run_id = ${runId}`
        return {
          released: yield* Effect.flip(runtime.releasePending(runId, fence)),
          status: yield* Effect.flip(runtime.writeStatus(runId, fence, "running"))
        }
      })
    )

    expect(observed.status).toBeInstanceOf(RunNotFound)
    expect(observed.released).toBeInstanceOf(RunNotFound)
  })

  it("refuses a fenced release a peer's claim has already moved past", async () => {
    const error = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { runId } = yield* start(runtime, "fenced")
        const fence = yield* runtime.claimFence(runId)
        // What a peer's claim leaves behind: the row is owned by somebody else.
        yield* Effect.asVoid(sql`
          UPDATE flows_runs
          SET owner_host_id = 'peer', owner_pid = 99, owner_nonce = 'peer-nonce'
          WHERE run_id = ${runId}
        `)
        return yield* Effect.flip(runtime.releasePending(runId, fence))
      })
    )

    expect(error).toBeInstanceOf(ClaimLost)
  })

  it("reports a plan row that is gone as a missing plan", async () => {
    const error = await withRuntime((runtime, sql) =>
      Effect.gen(function*() {
        const { card } = yield* start(runtime, "planless")
        yield* Effect.asVoid(sql`DELETE FROM control_plans WHERE plan_id = ${card.planId}`)
        return yield* Effect.flip(runtime.getPlan(card.planId))
      })
    )

    expect(error).toBeInstanceOf(PlanNotFound)
  })
})
