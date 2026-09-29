/**
 * A fork assesses the boundary it carries past and restores the frame's tree.
 *
 * `docs/guides/fork-a-run.md`: the assessment runs but is
 * normalized to warnings — the fork never reverts a parent effect — and the
 * child gets its own worktree restored from the frame's jj pointer. These cases
 * pin the disclosure wording, the paging of a long suffix, and what a fork says
 * when the frame has no pointer to restore.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Fork from "../src/internal/Fork.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const frame = { lineageId: "parent/root", seq: 0 } as const

/**
 * The lane every case here provisions: the memory store mints
 * `parent:fork:0:1` for the first fork off frame 0, exactly as the SQL store
 * does, and the workspace is named after that child rather than after the
 * parent frame.
 */
const lane = Fork.workspaceNameFor("parent:fork:0:1")

const row = (): RunStore.RunRow => ({
  runId: "parent",
  status: "suspended",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{}"
})

const boundaryEntry = (seq: number, id: string, kind: string): JournalEvent.Entry =>
  ({
    runId: "parent",
    seq,
    eventId: `e${seq}`,
    sourceId: "test",
    sourceSeq: seq,
    emittedAtMs: 0,
    eventType: EffectBoundary.eventType,
    payload: {
      version: 1,
      effect: {
        id,
        kind,
        tier: "irreversible",
        status: "succeeded",
        runId: "parent",
        lineageId: frame.lineageId,
        residue: `${id} stands.`
      }
    },
    meta: { lineageId: frame.lineageId }
  }) as unknown as JournalEvent.Entry

const noise = (seq: number): JournalEvent.Entry =>
  ({
    runId: "parent",
    seq,
    eventId: `e${seq}`,
    sourceId: "test",
    sourceSeq: seq,
    emittedAtMs: 0,
    eventType: "flows.engine.attempt-finished",
    payload: {},
    meta: { lineageId: frame.lineageId }
  }) as unknown as JournalEvent.Entry

/** Pages the suffix one entry at a time, so the read loop actually loops. */
const journalOf = (entries: ReadonlyArray<JournalEvent.Entry>, pageSize: number) =>
  Layer.succeed(
    Journal.Journal,
    Journal.makeNoop({
      entries: (options) => {
        const after = options.after
        const remaining = entries.filter((entry) => after === undefined || entry.seq > after)
        const page = remaining.slice(0, pageSize)
        return Effect.succeed({ entries: page, hasMore: remaining.length > page.length })
      }
    })
  )

const runFork = (options: {
  readonly entries: ReadonlyArray<JournalEvent.Entry>
  readonly snapshots?: ReadonlyArray<{ readonly changeId: string }>
  readonly restore?: (changeId: string) => Effect.Effect<void, never>
  readonly journal?: Layer.Layer<Journal.Journal>
  readonly handlers?: ReadonlyArray<EffectHandlerRegistry.Handler>
}) => {
  const calls: Array<string> = []
  const store = MemoryTimeTravelStore.make({
    snapshots: (options.snapshots ?? []).map((snapshot) => ({
      runId: "parent",
      frame,
      changeId: snapshot.changeId
    }))
  })
  return Effect.scoped(
    Fork.fork({
      parentRunId: "parent",
      frame,
      workspaceRoot: "/tmp/lanes",
      pageSize: 1
    }).pipe(
      Effect.map((result) => ({ result, calls })),
      Effect.provide(Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))),
      Effect.provide(Layer.succeed(TimeTravelStore, store)),
      Effect.provide(
        Layer.succeed(
          Jj.Jj,
          Jj.makeNoop({
            workspaceAdd: (name, _path, revision) =>
              Effect.sync(() => void calls.push(`add:${name}${revision === undefined ? "" : `@${revision}`}`)),
            workspaceForget: (name) => Effect.sync(() => void calls.push(`forget:${name}`)),
            restore: (changeId) =>
              options.restore === undefined
                ? Effect.sync(() => void calls.push(`restore:${changeId}`))
                : options.restore(changeId)
          })
        )
      ),
      Effect.provide(options.journal ?? journalOf(options.entries, 1)),
      Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop({ get: () => Effect.succeedNone }))),
      Effect.provide(EffectHandlerRegistry.layer(options.handlers ?? []))
    )
  )
}

describe("fork boundary assessment", () => {
  it.effect("normalizes every crossed effect to a warning and never touches the parent's tree", () =>
    Effect.gen(function*() {
      const handler: EffectHandlerRegistry.Handler = {
        kind: "billing/Charge",
        tier: "irreversible",
        requiresIdempotencyKey: false,
        residue: () => "The charge stands.",
        revert: () => Effect.succeed({}),
        rollback: () => Effect.void
      }
      const { calls, result } = yield* runFork({
        // Two pages of suffix, one revertible (a handler resolves) and one
        // blocking (none does). A fork reverts neither.
        entries: [
          boundaryEntry(1, "charge-1", "billing/Charge"),
          noise(2),
          boundaryEntry(3, "email-1", "mail/Send")
        ],
        snapshots: [{ changeId: "change-at-frame" }],
        handlers: [handler]
      })

      expect(result.warnings).toEqual([
        "billing/Charge (charge-1) was classified revertible for rewind; on a fork it is never reverted and may " +
        "execute again on the child. The charge stands.",
        "mail/Send (email-1) was classified blocking for rewind; on a fork it is never reverted and may " +
        "execute again on the child. email-1 stands."
      ])
      // `Jj.restore` acts on the ONE working copy the layer is rooted at — the
      // parent's. A fork never restores it, so the child lane is pinned at the frame's pointer at
      // provisioning time instead: `workspaceAdd` carries the revision.
      expect(calls).toEqual([`add:${lane}@change-at-frame`, `forget:${lane}`])
    }))

  it.effect("keeps a `warning` classification's own disclosure verbatim", () =>
    Effect.gen(function*() {
      const { result } = yield* runFork({
        entries: [boundaryEntry(1, "charge-1", "billing/Charge")],
        snapshots: [{ changeId: "change-at-frame" }],
        handlers: [{
          kind: "billing/Charge",
          tier: "irreversible",
          requiresIdempotencyKey: false,
          residue: () => "unused",
          assess: () =>
            Effect.succeed({
              classification: "warning" as const,
              reason: "policy allows it",
              residue: "The charge stands and will not be refunded."
            }),
          revert: () => Effect.succeed({}),
          rollback: () => Effect.void
        }]
      })

      expect(result.warnings).toEqual([
        "billing/Charge (charge-1): The charge stands and will not be refunded."
      ])
    }))

  // The suffix read fails closed exactly as the rewind's does: an empty page
  // that still claims more would otherwise let the fork commit with only the
  // boundary records it happened to see, and disclose an incomplete list of
  // effects that may execute again on the child.
  it.effect("refuses an empty continuation page instead of committing an incomplete disclosure", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      let pages = 0
      const journal = Layer.succeed(
        Journal.Journal,
        Journal.makeNoop({
          entries: () =>
            Effect.sync(() => {
              pages += 1
              return pages === 1
                ? { entries: [boundaryEntry(1, "charge-1", "billing/Charge")], hasMore: true }
                : { entries: [], hasMore: true }
            })
        })
      )
      const store = MemoryTimeTravelStore.make({
        snapshots: [{ runId: "parent", frame, changeId: "change-at-frame" }]
      })

      const failure = yield* Effect.flip(
        Effect.scoped(
          Fork.fork({ parentRunId: "parent", frame, workspaceRoot: "/tmp/lanes", pageSize: 1 }).pipe(
            Effect.provide(Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))),
            Effect.provide(Layer.succeed(TimeTravelStore, store)),
            Effect.provide(
              Layer.succeed(
                Jj.Jj,
                Jj.makeNoop({
                  workspaceAdd: (name) => Effect.sync(() => void calls.push(`add:${name}`)),
                  workspaceForget: (name) => Effect.sync(() => void calls.push(`forget:${name}`))
                })
              )
            ),
            Effect.provide(journal),
            Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())),
            Effect.provide(EffectHandlerRegistry.layerNoop)
          )
        )
      )

      expect(pages).toBe(2)
      expect(failure).toMatchObject({
        code: "invalid",
        message: "journal fork returned an empty continuation page for parent"
      })
      // Refused before anything was minted or provisioned.
      expect(calls).toEqual([])
      expect(store.state().forkIntents).toEqual([])
      expect(store.state().edges).toEqual([])
    }))

  it.effect("says so, rather than restoring a wrong tree, when the frame has no pointer", () =>
    Effect.gen(function*() {
      const { calls, result } = yield* runFork({ entries: [noise(1)] })

      expect(result.warnings).toEqual([
        `Frame parent/root@0 has no recorded jj pointer; the fork workspace ${lane} starts from the lane ` +
        "default rather than the frame."
      ])
      expect(calls).toEqual([`add:${lane}`, `forget:${lane}`])
    }))

  it.effect("maps a suffix read failure and a workspace-add failure to typed errors", () =>
    Effect.gen(function*() {
      const readFailure = yield* (
        Effect.flip(
          Effect.scoped(
            Fork.fork({
              parentRunId: "parent",
              frame,
              workspaceRoot: "/tmp/lanes"
            }).pipe(
              Effect.provide(
                Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))
              ),
              Effect.provide(Layer.succeed(TimeTravelStore, MemoryTimeTravelStore.make())),
              Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({}))),
              Effect.provide(Layer.succeed(Journal.Journal, Journal.makeNoop())),
              Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())),
              Effect.provide(EffectHandlerRegistry.layerNoop)
            )
          )
        )
      )
      const workspaceFailure = yield* (
        Effect.flip(
          Effect.scoped(
            Fork.fork({
              parentRunId: "parent",
              frame,
              workspaceRoot: "/tmp/lanes"
            }).pipe(
              Effect.provide(
                Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))
              ),
              Effect.provide(
                Layer.succeed(
                  TimeTravelStore,
                  MemoryTimeTravelStore.make({
                    snapshots: [{ runId: "parent", frame, changeId: "change-at-frame" }]
                  })
                )
              ),
              // `workspaceAdd` is left unimplemented, so the noop's
              // `not_installed` failure is what has to arrive typed.
              Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({ workspaceForget: () => Effect.void }))),
              Effect.provide(journalOf([], 1)),
              Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())),
              Effect.provide(EffectHandlerRegistry.layerNoop)
            )
          )
        )
      )

      expect(readFailure.message).toBe("could not read fork suffix for parent")
      expect(workspaceFailure.message).toBe("could not add fork workspace")
    }))

  // The fork provisions the workspace BEFORE the store commits, so a failed
  // provision leaves nothing durable — no child run, no edge, no copied rows.
  it.effect("leaves no child run, lineage edge, or copied records when workspace creation fails", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [{ runId: "parent", seq: 0, eventId: "parent-0", lineageId: frame.lineageId, payload: {} }]
      })
      const before = store.state()

      const failure = yield* (
        Effect.flip(
          Effect.scoped(
            Fork.fork({
              parentRunId: "parent",
              frame,
              workspaceRoot: "/tmp/lanes"
            }).pipe(
              Effect.provide(
                Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))
              ),
              Effect.provide(Layer.succeed(TimeTravelStore, store)),
              Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({ workspaceForget: () => Effect.void }))),
              Effect.provide(journalOf([], 1)),
              Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())),
              Effect.provide(EffectHandlerRegistry.layerNoop)
            )
          )
        )
      )

      expect(failure).toMatchObject({ code: "unknown", message: "could not add fork workspace" })
      expect(store.state().edges).toEqual(before.edges)
      expect(store.state().records).toEqual(before.records)
    }))

  // The other half of the provision-then-commit protocol: a commit that fails
  // AFTER the workspace exists compensates by forgetting the lane it added.
  it.effect("forgets the provisioned workspace when the store commit fails", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const store = MemoryTimeTravelStore.make({ failAt: "createFork:start" })

      const failure = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const failure = yield* Effect.flip(
              Fork.fork({
                parentRunId: "parent",
                frame,
                workspaceRoot: "/tmp/lanes"
              })
            )
            // Compensation, not scope cleanup: the lane is already forgotten
            // while the fork's scope is still open.
            expect(calls).toEqual([`add:${lane}`, `forget:${lane}`])
            return failure
          }).pipe(
            Effect.provide(
              Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))
            ),
            Effect.provide(Layer.succeed(TimeTravelStore, store)),
            Effect.provide(
              Layer.succeed(
                Jj.Jj,
                Jj.makeNoop({
                  workspaceAdd: (name) => Effect.sync(() => void calls.push(`add:${name}`)),
                  workspaceForget: (name) => Effect.sync(() => void calls.push(`forget:${name}`))
                })
              )
            ),
            Effect.provide(journalOf([], 1)),
            Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())),
            Effect.provide(EffectHandlerRegistry.layerNoop)
          )
        )
      )

      expect(failure).toMatchObject({ code: "unknown", message: "injected failure at createFork:start" })
      expect(store.state().records).toEqual([])
      expect(store.state().edges).toEqual([])
    }))

  // The SQL fork commits its child, edge, copied journal prefix, copied
  // attempts, and copied anchors in one transaction that only runs once the
  // workspace exists; a typed workspace failure therefore commits nothing.
  it.effect("rolls back every SQL fork row when workspace creation fails", () =>
    Effect.gen(function*() {
      const migrated = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
      const services = Layer.mergeAll(
        RunStore.layer,
        SqlJournal.layer({ capacity: 32, overflow: "reject" }),
        CacheStore.layer,
        SqlTimeTravelStore.layer
      ).pipe(Layer.provideMerge(migrated))

      const result = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* Effect.service(SqlClient.SqlClient)
            yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('parent', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "ForkParent", payload: {} })})
          `
            yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('parent', 0, 'parent-attempt', 'fork-boundary', 0, 0,
                    'flows.engine.attempt-started',
                    ${JSON.stringify({ stepKeyDigest: "parent-step", attempt: 1 })},
                    ${JSON.stringify({ lineageId: frame.lineageId })})
          `
            yield* sql`
            INSERT INTO flows_attempts
              (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
            VALUES ('parent', 'parent-step', 1, 'succeeded', 0, '{}')
          `
            const failure = yield* Effect.flip(
              Fork.fork({
                parentRunId: "parent",
                frame,
                workspaceRoot: "/tmp/lanes"
              }).pipe(
                Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({ workspaceForget: () => Effect.void }))),
                Effect.provide(EffectHandlerRegistry.layerNoop)
              )
            )
            const children = yield* sql<{ readonly run_id: string }>`
            SELECT run_id FROM flows_runs WHERE run_id <> 'parent'
          `
            const edges = yield* sql<{ readonly child_run_id: string }>`
            SELECT child_run_id FROM flows_time_travel_edges
          `
            const copiedJournal = yield* sql<{ readonly run_id: string; readonly seq: number }>`
            SELECT run_id, seq FROM flows_journal_events WHERE run_id <> 'parent'
          `
            const copiedAttempts = yield* sql<{ readonly run_id: string }>`
            SELECT run_id FROM flows_attempts WHERE run_id <> 'parent'
          `
            const copiedSnapshots = yield* sql<{ readonly run_id: string }>`
            SELECT run_id FROM flows_time_travel_snapshots WHERE run_id <> 'parent'
          `
            return { children, copiedAttempts, copiedJournal, copiedSnapshots, edges, failure }
          }).pipe(Effect.provide(services))
        )
      )

      expect(result.failure).toMatchObject({ code: "unknown", message: "could not add fork workspace" })
      expect(result.children).toEqual([])
      expect(result.edges).toEqual([])
      expect(result.copiedJournal).toEqual([])
      expect(result.copiedAttempts).toEqual([])
      expect(result.copiedSnapshots).toEqual([])
    }))
})

describe("the compensation descriptor on a boundary record", () => {
  it.effect("omits an absent idempotency key from sealed boundary records", () =>
    Effect.gen(function*() {
      const emitted: Array<JournalEvent.Input> = []
      yield* EffectBoundary.guard({
        id: "sealed-read-1",
        kind: "storage/read",
        tier: "sealed",
        runId: "parent",
        lineageId: frame.lineageId,
        sourceId: "test",
        sourceSeq: 0,
        owner: { hostId: "test-host", pid: 1, nonce: "test-owner" }
      }, Effect.succeed("value")).pipe(
        Effect.provide(
          Layer.succeed(
            Journal.Journal,
            Journal.makeNoop({
              emitDurable: (input) =>
                Effect.sync(() => {
                  emitted.push(input)
                  return { _tag: "Accepted", seq: emitted.length, sourceSeq: input.sourceSeq } as never
                })
            })
          )
        )
      )

      expect(emitted).toHaveLength(2)
      for (const entry of emitted) {
        expect((entry.payload as { effect: Record<string, unknown> }).effect).not.toHaveProperty("idempotencyKey")
      }
    }))

  it.effect("survives the round trip a rewind's handler preflight reads it through", () =>
    Effect.gen(function*() {
      const emitted: Array<JournalEvent.Input> = []
      yield* (
        EffectBoundary.guard({
          id: "charge-1",
          kind: "billing/Charge",
          tier: "irreversible",
          runId: "parent",
          lineageId: frame.lineageId,
          sourceId: "test",
          sourceSeq: 0,
          owner: { hostId: "test-host", pid: 1, nonce: "test-owner" },
          idempotencyKey: "charge-1",
          compensation: "billing/refund@v2",
          residue: "The charge stands."
        }, Effect.succeed("ok")).pipe(
          Effect.provide(
            Layer.succeed(
              Journal.Journal,
              Journal.makeNoop({
                emitDurable: (input) =>
                  Effect.sync(() => {
                    emitted.push(input)
                    return { _tag: "Accepted", seq: emitted.length, sourceSeq: 0 } as never
                  })
              })
            )
          )
        )
      )
      const decoded = Effect.runSync(EffectBoundary.decodeEntry({
        ...emitted[1],
        seq: 1
      } as unknown as JournalEvent.Entry))

      expect(decoded?.compensation).toBe("billing/refund@v2")
      expect(decoded?.status).toBe("succeeded")
    }))
})

/**
 * The store commit and the lane's forget-on-close finalizer are one unit. An
 * interrupt that lands while the commit finishes used to be observed before
 * the finalizer was registered, so a committed child either lost its lane at
 * once or kept one nothing would ever forget.
 */
describe("fork commit boundary", () => {
  it.effect("keeps a committed child's lane until the scope closes when interrupted at commit", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const base = MemoryTimeTravelStore.make()
      const committed = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
      const release = yield* Deferred.make<void>()
      const store: TimeTravelStore["Service"] = {
        ...base,
        // Hold the real commit's result in an uninterruptible region, as
        // SqlClient does while it finalizes COMMIT.
        createFork: (...args) =>
          Effect.uninterruptible(
            base.createFork(...args).pipe(
              Effect.tap(() => Deferred.succeed(committed, Fiber.getCurrent()!)),
              Effect.tap(() => Deferred.await(release))
            )
          )
      }
      const scope = yield* Scope.make()
      const fiber = yield* Fork.fork({ parentRunId: "parent", frame, workspaceRoot: "/tmp/lanes" }).pipe(
        Effect.provide(Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))),
        Effect.provide(Layer.succeed(TimeTravelStore, store)),
        Effect.provide(
          Layer.succeed(
            Jj.Jj,
            Jj.makeNoop({
              workspaceAdd: (name) => Effect.sync(() => void calls.push(`add:${name}`)),
              workspaceForget: (name) => Effect.sync(() => void calls.push(`forget:${name}`))
            })
          )
        ),
        Effect.provide(journalOf([], 1)),
        Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())),
        Effect.provide(EffectHandlerRegistry.layerNoop),
        Effect.provideService(Scope.Scope, scope),
        Effect.forkChild
      )
      const committing = yield* Deferred.await(committed)
      // Request cancellation while the commit is masked, then let it return.
      yield* Effect.sync(() => committing.interruptUnsafe())
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(base.state().edges.map((edge) => edge.childRunId)).toEqual(["parent:fork:0:1"])
      // The child committed, so its lane stays registered while the scope is open.
      expect(calls).toEqual([`add:${lane}`])
      yield* Scope.close(scope, Exit.void)
      expect(calls).toEqual([`add:${lane}`, `forget:${lane}`])
    }))
})
