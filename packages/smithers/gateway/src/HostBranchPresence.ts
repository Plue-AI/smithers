/** Host-only adapter of the existing branch protocol and lease roster.
 * The Go authorizer resolves branch, actor and socket session before forwarding.
 * The runtime bearer is required on every RPC; participant IDs confer no rights.
 */
import * as BranchPresence from "@smthrs/sync/BranchPresence"
import type { Announcement, LeaveRequest, RosterRequest } from "@smthrs/sync/BranchProtocol"
import { BranchRpcs } from "@smthrs/sync/BranchRpcs"
import * as BranchShare from "@smthrs/sync/BranchShare"
import { SyncError } from "@smthrs/sync/SyncError"
import { SyncAuth } from "@smthrs/sync/SyncRpcs"
import { Effect, Layer, Redacted, Stream } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import type { Config } from "./RuntimeBridge.ts"

/**
 * Mount only on authenticated native runtime hosts, never anonymous gateways.
 *
 * @category layers
 * @since 1.0.0-rc.1
 */
export const layer = (config: Config) =>
  Layer.unwrap(Effect.gen(function*() {
    const share = yield* BranchShare.makeHmac({
      activeKid: "host",
      keys: [{ kid: "host", secret: Redacted.make(crypto.randomUUID() + crypto.randomUUID()) }]
    })
    // The authorizing Go host re-checks all source readiness on every health
    // call. The handler below refuses missing assertions before the lease
    // registry, whose own startup window still applies. No readiness cache.
    const presence = yield* BranchPresence.makeMemory({
      sourcesReady: () => Effect.succeed(true)
    }).pipe(Effect.provideService(BranchShare.BranchShare, share))
    // Capability fields on this host-only mount are transport metadata, replaced
    // with an internal signed capability after the runtime bearer is verified.
    const authorize = <A extends RosterRequest>(request: A, actor = "roster") =>
      share.mint({
        branchId: request.branchId,
        capabilityId: actor,
        access: "write",
        ttlMs: 60_000
      }).pipe(Effect.map((capability) => ({ ...request, capability })))
    const unsupported = new SyncError({ code: "unsupported", message: "This mount serves presence only" })
    const handlers = BranchRpcs.toLayer(Effect.succeed(BranchRpcs.of({
      "Branch.CreateBranch": () => Effect.fail(unsupported),
      "Branch.MintShare": () => Effect.fail(unsupported),
      "Branch.Submit": () => Effect.fail(unsupported),
      "Branch.Announce": (request: Announcement) =>
        authorize(request, request.participantId).pipe(Effect.flatMap(presence.announce)),
      "Branch.Leave": (request: LeaveRequest) =>
        authorize(request, request.participantId).pipe(Effect.flatMap(presence.leave), Effect.as(null)),
      "Branch.Roster": (request) => authorize(request).pipe(Effect.flatMap(presence.list)),
      "Branch.PresenceOn": (request) =>
        authorize(request).pipe(Effect.flatMap((authorized) =>
          request.sourcesReady === true ? presence.presenceOn(authorized) : Effect.succeed("unknown" as const)
        )),
      "Branch.WatchRoster": () =>
        Stream.fail(unsupported)
    })))
    const auth = Layer.succeed(SyncAuth)((effect, options) =>
      Effect.gen(function*() {
        yield* config.authenticate(options.headers).pipe(
          Effect.mapError(() => new SyncError({ code: "unauthorized", message: "Host authentication required" }))
        )
        return yield* effect
      })
    )
    return RpcServer.layer(BranchRpcs, { disableFatalDefects: true }).pipe(
      Layer.provide(handlers),
      Layer.provide(auth),
      Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/branch" }))
    )
  }))
