import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Jj from "@smthrs/jj"
import { Journal, SqlJournal } from "@smthrs/journal"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import { RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { error } from "../src/TimeTravelError.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const owner = { hostId: "test-host", pid: 20, nonce: "commit-owner" }
const frame = { lineageId: "run/root", seq: 0 }
const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
const persistence = SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(Layer.provideMerge(database))

describe("Rewind archive commit boundary", () => {
  for (
    const scenario of [
      "interrupt",
      "post-commit failure",
      "journal evidence failure",
      "archive evidence failure"
    ] as const
  ) {
    it.effect(`preserves the committed archive after ${scenario}`, () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const base = yield* SqlTimeTravelStore.make
        const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
        const journal = yield* Journal.Journal
        yield* sql`
          INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES ('run', 'suspended', 0, '{"cursor":9}')
        `
        const effect: Omit<EffectBoundary.EffectRecord, "seq"> = {
          id: "send",
          kind: "send",
          tier: "irreversible",
          status: "succeeded",
          runId: "run",
          lineageId: frame.lineageId,
          idempotencyKey: "send-key",
          durableBoundary: true,
          providerStream: false
        }
        const workspaceEffect: Omit<EffectBoundary.EffectRecord, "seq"> = {
          ...effect,
          id: "workspace",
          kind: "fs-write",
          tier: "compensable",
          changeId: "target"
        }
        for (const seq of [0, 1, 2]) {
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('run', ${seq}, ${`event-${seq}`}, 'commit-test', ${seq}, 0,
              ${seq === 0 ? "baseline" : EffectBoundary.eventType},
              ${JSON.stringify(seq === 0 ? {} : { version: 1, effect: seq === 1 ? effect : workspaceEffect })},
              ${JSON.stringify({ lineageId: frame.lineageId })})
          `
        }
        yield* base.recordSnapshot({ runId: "run", frame, changeId: "target" })
        const committed = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
        const release = yield* Deferred.make<void>()
        let archiveReturned = false
        const store: TimeTravelStore["Service"] = {
          ...base,
          archivedAt: (...args) =>
            scenario === "archive evidence failure"
              ? Effect.fail(error("unknown", "archive evidence unreadable"))
              : base.archivedAt(...args),
          archiveAndTruncate: (...args) =>
            // Hold the real SQL store's result in an uninterruptible region,
            // as SqlClient does while finalizing COMMIT. Cancellation must not
            // escape between that durable write and Rewind's local flag.
            Effect.uninterruptible(
              base.archiveAndTruncate(...args).pipe(
                Effect.tap(() => Deferred.succeed(committed, Fiber.getCurrent()!)),
                Effect.tap(() => Deferred.await(release)),
                Effect.tap(() =>
                  Effect.sync(() => {
                    archiveReturned = true
                  })
                ),
                Effect.tap(() =>
                  scenario !== "interrupt"
                    ? Effect.fail(error("unknown", "publication failed after commit"))
                    : Effect.void
                )
              )
            )
        }
        let pointer = "current"
        const external = ["sent"]
        const rollbacks: Array<string> = []
        const registry = yield* EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message remains sent",
          revert: () => Effect.sync(() => ({ value: external.pop() })),
          rollback: (_effect, receipt) =>
            Effect.sync(() => {
              rollbacks.push("send")
              external.push((receipt as { readonly value: string }).value)
            })
        }])
        const fiber = yield* Rewind.rewind({ runId: "run", frame, owner, auditId: "audit" }).pipe(
          Effect.provideService(TimeTravelStore, store),
          Effect.provideService(Journal.Journal, {
            ...journal,
            entries: (options) =>
              archiveReturned && scenario === "journal evidence failure"
                ? Effect.fail(new Journal.JournalError({ code: "read_failed", message: "journal evidence unreadable" }))
                : journal.entries(options)
          }),
          Effect.provideService(RunStore.RunStore, runs),
          Effect.provideService(EffectHandlerRegistry.EffectHandlerRegistry, registry),
          Effect.provide(CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })),
          Effect.provideService(
            Jj.Jj,
            Jj.makeNoop({
              snapshot: () => Effect.succeed({ commitId: pointer, changeId: pointer }),
              restore: (changeId) =>
                Effect.sync(() => {
                  pointer = changeId
                })
            })
          ),
          Effect.forkChild
        )
        const committingFiber = yield* Deferred.await(committed)
        if (scenario === "interrupt") {
          // Request cancellation without awaiting the masked fiber, then let
          // its commit return. No timing or scheduler sleeps are involved.
          yield* Effect.sync(() => committingFiber.interruptUnsafe())
        }
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (scenario === "interrupt") {
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        } else {
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("publication failed after commit")
        }
        const live = yield* sql<{ readonly seq: number }>`SELECT seq FROM flows_journal_events WHERE run_id = 'run'`
        expect(live.map((row) => row.seq)).toEqual([0])
        expect(yield* base.archivedAt("run", 2)).toBe(true)
        expect(rollbacks).toEqual([])
        expect(external).toEqual([])
        expect(pointer).toBe("target")
        expect(yield* runs.get("run")).toMatchObject({ status: "running", owner })
        expect(yield* base.pendingAudits()).toMatchObject([{
          id: "audit",
          status: "in_progress",
          detail: {
            phase: scenario === "journal evidence failure" || scenario === "archive evidence failure"
              ? "compensated"
              : "archive_committed"
          }
        }])
      }).pipe(Effect.provide(persistence)))
  }
})
