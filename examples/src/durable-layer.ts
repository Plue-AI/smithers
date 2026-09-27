/**
 * The durable engine composition every persistence example reuses.
 *
 * `EngineStore.layer` needs the journal and its three state stores, the
 * durable deferred/clock state, a kernel `Jj`, a `StepBoundary`, and (to make
 * sealed results shareable) a `WorkspaceSandbox`. This module wires them over
 * one SQLite file so a restart in a later example reads the same rows a
 * previous one wrote.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Jj } from "@smthrs/kernel"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Ownership } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { dirname } from "node:path"

/**
 * A Jujutsu service that records nothing. The engine calls it for compensable
 * snapshots; the examples use sealed actions, so a stub keeps the wiring
 * honest without requiring a jj binary.
 */
export const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "examples-snapshot" as never, commitId: "examples-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * Everything `EngineStore` requires, minus the engine itself.
 *
 * The boundary and the sandbox are the PRODUCTION layers: `StepBoundary.layer`
 * and `WorkspaceSandbox.layerFileSystem`, not `StepBoundary.layerTest`. That
 * pairing is what makes a sealed action's result eligible for the shared
 * step cache: the sandbox runs the body in an isolated workspace and observes
 * the whole tree, so the boundary evidence can honestly claim
 * `wholeTreeWritesVerified`. With `layerTest` the claim was a test fixture and
 * nothing composed this way ever reached the cache.
 *
 * `isAlive` is the liveness probe the store consults before stealing a run
 * from a stale owner. `Ownership.sameHostPidProbe` asks this machine's process
 * table, so a second process over the same file cannot take a run out of a
 * live one; a run recorded on another host is left to the lease. A stub that
 * returns `false` without asking is the one thing a real deployment must not
 * do: it says "that owner is gone" about an owner it never looked at.
 *
 * `OwnerIdentity.layer` is the default owner minter: the process id plus a
 * fresh nonce. It is listed here rather than assumed because it is the seam a
 * host with a better answer replaces.
 */
export const requirements = (filename: string) =>
  Layer.mergeAll(
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    stubJj
  ).pipe(
    Layer.provideMerge(NodeRuntime.storage(filename)),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.merge(AtomicFileSystem.layer, NodePath.layer))
  )

/**
 * A durable `FlowEngine` over the SQLite file at `filename`.
 *
 * The stores are merged into the output rather than hidden, so an example can
 * read the journal or a run row back after executing a flow.
 */
export const durableEngine = (filename: string, hostId: string) =>
  NodeRuntime.layer(
    {
      filename,
      workspaceRoot: dirname(filename),
      owner: { hostId },
      isAlive: Ownership.sameHostPidProbe
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    // Each example provides this layer beneath its action implementations and
    // Interpreter registrations. The public composition accepts the
    // registration phase here; `Layer.empty` keeps this helper compatible with
    // those focused examples while preserving their same outer startup order.
    Layer.empty
  ).pipe(
    Layer.provideMerge(stubJj),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(AtomicFileSystem.layer)
  )
