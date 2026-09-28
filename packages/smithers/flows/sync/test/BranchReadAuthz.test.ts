/**
 * The read-path authorization invariant, along both boundaries. A branch run
 * is visible only through a capability that verifies for that branch —
 * scoped reads fail, workspace listings and change-follows exclude what the
 * caller's capability does not cover, and a server without a share authority
 * closes every branch run. A non-branch run and the workspace scope itself
 * are visible only to the workspace principal: an unauthenticated caller is
 * refused outright, branch capability or not.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Fiber, Layer, Redacted, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { type BranchId, branchRunId, type ShareCapability } from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"

const branchId = "guarded-branch" as BranchId
const branchRun = branchRunId(branchId)
const engineRun = "flows/engine/run-1" as JournalEvent.RunId

const layer = Layer.mergeAll(
  TestJournal.layer(),
  BranchShare.layerHmac({
    activeKid: "primary",
    keys: [{ kid: "primary", secret: Redacted.make("authz-secret-0123456789abcdefghi") }]
  })
)

const program = <A, E>(effect: Effect.Effect<A, E, Journal.Journal | BranchShare.BranchShare | Scope.Scope>) =>
  effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped)

const writeEntry = (runId: JournalEvent.RunId, text: string) =>
  Effect.flatMap(Journal.Journal, (journal) =>
    journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId,
        sourceId: "flows/participant/alice" as JournalEvent.SourceId,
        eventType: "authorization-test-message",
        payload: { text },
        meta: null
      })
    ))

interface Rig {
  readonly server: SyncServer.Service
  readonly bare: SyncServer.Service
  readonly capability: ShareCapability
  readonly foreign: ShareCapability
  readonly register: (runId: JournalEvent.RunId) => Effect.Effect<void>
}

/** A server with a share authority, one without, and capabilities for two branches. */
const rig: Effect.Effect<Rig, SyncError, Journal.Journal | BranchShare.BranchShare> = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const share = yield* BranchShare.BranchShare
  const memory = yield* RunCatalog.makeMemory()
  const server = yield* SyncServer.makeLive.pipe(
    Effect.provideService(Journal.Journal, journal),
    Effect.provideService(RunCatalog.RunCatalog, memory.catalog),
    Effect.provideService(BranchShare.BranchShare, share)
  )
  const bare = yield* SyncServer.makeLive.pipe(
    Effect.provideService(Journal.Journal, journal),
    Effect.provideService(RunCatalog.RunCatalog, memory.catalog)
  )
  const capability = yield* share.mint({ branchId, capabilityId: "cap", access: "read", ttlMs: 600_000 })
  const foreign = yield* share.mint({
    branchId: "other-branch" as BranchId,
    capabilityId: "foreign",
    access: "read",
    ttlMs: 600_000
  })
  return { server, bare, capability, foreign, register: memory.register }
})

const readBranch = (server: SyncServer.Service, capability?: ShareCapability) =>
  server.read({
    protocolVersion: 1,
    scope: { _tag: "Run", runId: branchRun },
    cursors: [],
    limit: 10,
    ...(capability === undefined ? {} : { capability })
  })

/** Runs an effect as the authenticated workspace principal. */
const asWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provide(effect, SyncPrincipal.layerWorkspace("authz-suite"))

describe("branch read authorization", () => {
  it.effect("fails a scoped branch read without a capability, with a foreign one, and without a share authority", () =>
    Effect.gen(function*() {
      const codes = yield* program(
        Effect.gen(function*() {
          const { server, bare, foreign } = yield* rig
          yield* writeEntry(branchRun, "secret")
          const missing = yield* Effect.flip(readBranch(server))
          const wrong = yield* Effect.flip(readBranch(server, foreign))
          const closed = yield* Effect.flip(readBranch(bare))
          return [missing.code, wrong.code, closed.code]
        })
      )

      expect(codes).toEqual(["unauthorized", "unauthorized", "unauthorized"])
    }))

  it.effect("fails a scoped branch subscription without a capability", () =>
    Effect.gen(function*() {
      const error = yield* program(
        Effect.gen(function*() {
          const { server } = yield* rig
          return yield* Effect.flip(
            Stream.runCollect(
              server.subscribe({ protocolVersion: 1, scope: { _tag: "Run", runId: branchRun }, cursors: [], credit: 1 })
            )
          )
        })
      )

      expect((error as SyncError).code).toBe("unauthorized")
    }))

  it.effect("propagates a share-authority infrastructure fault instead of reporting unauthorized", () =>
    Effect.gen(function*() {
      const error = yield* program(
        Effect.gen(function*() {
          const { capability } = yield* rig
          const journal = yield* Journal.Journal
          const memory = yield* RunCatalog.makeMemory()
          // The signer itself is broken — not a refused capability.
          const broken = BranchShare.makeNoop({
            verify: () =>
              Effect.fail(new SyncError({ code: "unknown", message: "Web Crypto could not sign the share claims" }))
          })
          const server = yield* SyncServer.makeLive.pipe(
            Effect.provideService(Journal.Journal, journal),
            Effect.provideService(RunCatalog.RunCatalog, memory.catalog),
            Effect.provideService(BranchShare.BranchShare, broken)
          )
          return yield* Effect.flip(readBranch(server, capability))
        })
      )

      expect((error as SyncError).code).toBe("unknown")
    }))

  it.effect("serves a scoped branch read to a capability that verifies for the branch", () =>
    Effect.gen(function*() {
      const texts = yield* program(
        Effect.gen(function*() {
          const { server, capability } = yield* rig
          yield* writeEntry(branchRun, "visible to the link holder")
          const response = yield* readBranch(server, capability)
          return response.entries.map((entry) => (entry.payload as { readonly text: string }).text)
        })
      )

      expect(texts).toEqual(["visible to the link holder"])
    }))

  it.effect("refuses an unauthenticated workspace read outright, branch capability or not", () =>
    Effect.gen(function*() {
      const codes = yield* program(
        Effect.gen(function*() {
          const { capability, register, server } = yield* rig
          yield* register(engineRun)
          yield* writeEntry(engineRun, "engine")
          const bare = yield* Effect.flip(
            server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 10 })
          )
          // A branch share link authorizes exactly its branch's run — it never
          // upgrades a caller to workspace listings.
          const withLink = yield* Effect.flip(
            server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 10, capability })
          )
          const subscribed = yield* Effect.flip(
            Stream.runCollect(
              server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 1 })
            )
          )
          return [bare.code, withLink.code, (subscribed as SyncError).code]
        })
      )

      expect(codes).toEqual(["unauthorized", "unauthorized", "unauthorized"])
    }))

  it.effect("refuses an unauthenticated scoped read of a non-branch run and serves the workspace principal", () =>
    Effect.gen(function*() {
      const [code, texts] = yield* program(
        Effect.gen(function*() {
          const { register, server } = yield* rig
          yield* register(engineRun)
          yield* writeEntry(engineRun, "engine")
          const scoped = {
            protocolVersion: 1,
            scope: { _tag: "Run", runId: engineRun },
            cursors: [],
            limit: 10
          } as const
          const refused = yield* Effect.flip(server.read(scoped))
          const served = yield* asWorkspace(server.read(scoped))
          return [
            refused.code,
            served.entries.map((entry) => (entry.payload as { readonly text: string }).text)
          ]
        })
      )

      expect(code).toBe("unauthorized")
      expect(texts).toEqual(["engine"])
    }))

  it.effect("excludes unreadable branch runs from an owner's workspace read and includes them with a capability", () =>
    Effect.gen(function*() {
      const [withoutLink, withLink] = yield* program(
        asWorkspace(Effect.gen(function*() {
          const { capability, register, server } = yield* rig
          yield* register(engineRun)
          yield* register(branchRun)
          yield* writeEntry(engineRun, "engine")
          yield* writeEntry(branchRun, "branch")
          const denied = yield* server.read({
            protocolVersion: 1,
            scope: { _tag: "Workspace" },
            cursors: [],
            limit: 10
          })
          const granted = yield* server.read({
            protocolVersion: 1,
            scope: { _tag: "Workspace" },
            cursors: [],
            limit: 10,
            capability
          })
          return [
            denied.entries.map((entry) => entry.runId),
            granted.entries.map((entry) => entry.runId)
          ]
        }))
      )

      expect(withoutLink).toEqual([engineRun])
      expect(withLink).toEqual([branchRun, engineRun])
    }))

  it.effect("filters branch runs out of workspace change-follows without a capability", () =>
    Effect.gen(function*() {
      const frames = yield* program(
        asWorkspace(Effect.gen(function*() {
          const { register, server } = yield* rig
          const followed = yield* Stream.runCollect(
            Stream.take(
              server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 4 }),
              1
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))
          // Let the subscription attach to the catalog change feed first.
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          // The branch change is advertised first; if it leaked, it would win
          // the race to the one frame this subscription takes.
          yield* writeEntry(branchRun, "must not leak")
          yield* register(branchRun)
          yield* writeEntry(engineRun, "engine change")
          yield* register(engineRun)
          return yield* Effect.map(Fiber.join(followed), (chunk) => Array.from(chunk))
        }))
      )

      expect(frames).toHaveLength(1)
      expect(frames[0]?._tag).toBe("Entries")
      expect(frames[0]?._tag === "Entries" ? frames[0].runId : null).toBe(engineRun)
    }))
})
