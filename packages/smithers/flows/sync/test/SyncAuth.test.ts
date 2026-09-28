/**
 * Connection authentication end to end: the launch invariant is that an
 * unauthenticated workspace read over the wire is refused, a verified
 * workspace capability in the request headers grants it, and a branch share
 * capability alone still reads exactly its branch.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Encoding, Layer, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcTest from "effect/unstable/rpc/RpcTest"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncAuth from "../src/SyncAuth.ts"
import { SyncError } from "../src/SyncError.ts"
import { SyncRpcs } from "../src/SyncRpcs.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSync from "../src/test/TestSync.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"

const engineRun = "flows/engine/run-1" as JournalEvent.RunId
const branchId = "auth-branch" as BranchProtocol.BranchId
const branchRun = BranchProtocol.branchRunId(branchId)

const keyring: WorkspaceShare.Keyring = {
  activeKid: "k1",
  keys: [{ kid: "k1", secret: Redacted.make("auth-suite-secret-0123456789abcd") }]
}

/**
 * The production serving stack: real handlers, real header-verifying
 * middleware, a real workspace share authority, and a journal holding one
 * engine run and one branch run.
 */
const stack = Layer.mergeAll(SyncServer.layerHandlers, SyncAuth.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(SyncServer.layer, WorkspaceShare.layerHmac(keyring))
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      TestJournal.layer(),
      RunCatalog.layerStatic([engineRun, branchRun]),
      BranchShare.layerHmac({
        activeKid: "primary",
        keys: [{ kid: "primary", secret: Redacted.make("auth-branch-secret-0123456789abc") }]
      })
    )
  )
)

const writeEntry = (runId: JournalEvent.RunId, text: string) =>
  Effect.flatMap(Journal.Journal, (journal) =>
    journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId,
        sourceId: "flows/participant/auth" as JournalEvent.SourceId,
        eventType: "event",
        payload: { text },
        meta: null
      })
    ))

const workspaceRead = { protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 10 } as const

const program = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(stack),
    Effect.provide(TestClock.layer()),
    Effect.scoped
  )

describe("SyncAuth", () => {
  it.effect("refuses an unauthenticated workspace read over the wire", () =>
    Effect.gen(function*() {
      const [readError, subscribeError] = yield* program(
        Effect.gen(function*() {
          yield* writeEntry(engineRun, "engine")
          const client = yield* RpcTest.makeClient(SyncRpcs)
          const read = yield* Effect.flip(client["Sync.Read"](workspaceRead))
          const subscribed = yield* Effect.flip(
            Stream.runCollect(
              client["Sync.Subscribe"]({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 1 })
            )
          )
          return [read, subscribed] as const
        })
      )

      expect(readError).toBeInstanceOf(SyncError)
      expect((readError as SyncError).code).toBe("unauthorized")
      expect((subscribeError as SyncError).code).toBe("unauthorized")
    }))

  it.effect("serves a workspace read to a client presenting a verified capability header", () =>
    Effect.gen(function*() {
      const texts = yield* program(
        Effect.gen(function*() {
          yield* writeEntry(engineRun, "visible to the workspace principal")
          const share = yield* WorkspaceShare.WorkspaceShare
          const capability = yield* share.mint({ capabilityId: "cap-e2e", access: "read", ttlMs: 60_000 })
          const client = yield* RpcTest.makeClient(SyncRpcs).pipe(
            Effect.provide(SyncAuth.layerClient(capability))
          )
          const response = yield* client["Sync.Read"](workspaceRead)
          return response.entries.map((entry) => (entry.payload as { readonly text: string }).text)
        })
      )

      expect(texts).toEqual(["visible to the workspace principal"])
    }))

  it.effect("refuses tampered, expired, and malformed capability headers outright", () =>
    Effect.gen(function*() {
      const codes = yield* program(
        Effect.gen(function*() {
          const share = yield* WorkspaceShare.WorkspaceShare
          const minted = yield* share.mint({ capabilityId: "cap-tamper", access: "read", ttlMs: 1_000 })
          const forged = new WorkspaceShare.WorkspaceCapability({
            claims: new WorkspaceShare.WorkspaceClaims({ ...minted.claims, capabilityId: "cap-other" }),
            signature: minted.signature
          })
          const client = yield* RpcTest.makeClient(SyncRpcs)
          const withHeader = (header: string) =>
            Effect.flip(
              RpcClient.withHeaders(
                client["Sync.Read"](workspaceRead),
                { [SyncAuth.capabilityHeader]: header }
              )
            )
          const forgedError = yield* withHeader(yield* SyncAuth.encodeCapability(forged))
          const expiredHeader = yield* SyncAuth.encodeCapability(minted)
          yield* TestClock.adjust(1_000)
          const expiredError = yield* withHeader(expiredHeader)
          const garbage = yield* withHeader("!!!not-base64url!!!")
          const notJson = yield* withHeader(Encoding.encodeBase64Url("not json"))
          const notCapability = yield* withHeader(Encoding.encodeBase64Url(JSON.stringify({ nope: true })))
          return [forgedError, expiredError, garbage, notJson, notCapability].map((error) => (error as SyncError).code)
        })
      )

      expect(codes).toEqual(["unauthorized", "unauthorized", "unauthorized", "unauthorized", "unauthorized"])
    }))

  it.effect("still serves a branch read to an anonymous connection with a branch capability", () =>
    Effect.gen(function*() {
      const [texts, engineRefused] = yield* program(
        Effect.gen(function*() {
          yield* writeEntry(branchRun, "branch text")
          yield* writeEntry(engineRun, "engine text")
          const share = yield* BranchShare.BranchShare
          const capability = yield* share.mint({
            branchId,
            capabilityId: "branch-cap",
            access: "read",
            ttlMs: 60_000
          })
          const client = yield* RpcTest.makeClient(SyncRpcs)
          const branch = yield* client["Sync.Read"]({
            protocolVersion: 1,
            scope: { _tag: "Run", runId: branchRun },
            cursors: [],
            limit: 10,
            capability
          })
          const refused = yield* Effect.flip(
            client["Sync.Read"]({
              protocolVersion: 1,
              scope: { _tag: "Run", runId: engineRun },
              cursors: [],
              limit: 10,
              capability
            })
          )
          return [
            branch.entries.map((entry) => (entry.payload as { readonly text: string }).text),
            (refused as SyncError).code
          ] as const
        })
      )

      expect(texts).toEqual(["branch text"])
      expect(engineRefused).toBe("unauthorized")
    }))

  it.effect("propagates a share-authority infrastructure fault instead of reporting unauthorized", () =>
    Effect.gen(function*() {
      const error = yield* Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(SyncRpcs)
        const share = yield* WorkspaceShare.WorkspaceShare
        const capability = yield* share.mint({ capabilityId: "cap-fault", access: "read", ttlMs: 60_000 })
        const header = yield* SyncAuth.encodeCapability(capability)
        return yield* Effect.flip(
          RpcClient.withHeaders(client["Sync.Read"](workspaceRead), {
            [SyncAuth.capabilityHeader]: header
          })
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(SyncServer.layerHandlers, SyncAuth.layer).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                SyncServer.layer,
                // The verifier itself is broken — not a refused capability.
                Layer.effect(
                  WorkspaceShare.WorkspaceShare,
                  Effect.map(WorkspaceShare.makeHmac(keyring), (real) =>
                    WorkspaceShare.WorkspaceShare.of({
                      mint: real.mint,
                      verify: () =>
                        Effect.fail(
                          new SyncError({ code: "unknown", message: "Web Crypto could not sign the share claims" })
                        )
                    }))
                )
              )
            ),
            Layer.provideMerge(Layer.mergeAll(TestJournal.layer(), RunCatalog.layerStatic([engineRun])))
          )
        ),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )

      expect((error as SyncError).code).toBe("unknown")
    }))

  it.effect("round trips a capability through its header encoding", () =>
    Effect.gen(function*() {
      const [roundTripped, original] = yield* Effect.gen(function*() {
        const share = yield* WorkspaceShare.makeHmac(keyring)
        const capability = yield* share.mint({ capabilityId: "cap-codec", access: "read", ttlMs: 60_000 })
        const header = yield* SyncAuth.encodeCapability(capability)
        return [yield* SyncAuth.decodeCapability(header), capability] as const
      }).pipe(Effect.provide(TestClock.layer()))

      expect(roundTripped).toEqual(original)
    }))

  it.effect("fails encoding for a value that is not a capability", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        SyncAuth.encodeCapability(
          { claims: { kid: 1 } } as unknown as WorkspaceShare.WorkspaceCapability
        )
      )

      expect(error.code).toBe("invalid_request")
    }))

  it.effect("keeps TestSync.layerNoop anonymous with a closed noop server", () =>
    Effect.gen(function*() {
      const response = yield* Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(SyncRpcs)
        return yield* client["Sync.Read"](workspaceRead)
      }).pipe(
        Effect.provide(SyncServer.layerHandlers.pipe(Layer.provideMerge(TestSync.layerNoop))),
        Effect.scoped
      )

      expect(response).toEqual({ entries: [], cursors: [], done: true })
    }))
})
