/**
 * The provisioned-machine contract and its projections.
 *
 * `RemoteChildProcessSpawner` carries commands to a machine something else
 * provisioned. This module owns the other half: `Provider.acquire` turns a
 * session key into a held {@link Session} — a machine with byte-typed file
 * transfer beside the same spawn — and every richer surface derives from that
 * one contract rather than being asked of each adapter:
 *
 * - {@link commandProvider} projects the lifecycle onto the spawner-level
 *   provider, so the spawner adapter, the health probe, supervision, and the
 *   provider conformance suite compose with a lifecycle provider unchanged.
 * - {@link fileSystem} serves Effect's `FileSystem` from a session: native
 *   reads and writes, everything else through strictly POSIX `sh` probes an
 *   adapter may override.
 * - {@link fanOut} forks a bounded set of child machines from a session that
 *   declares `fork`, each released with the scope that forked it.
 * - {@link layerHost} holds one machine for a layer's lifetime and provides
 *   `ChildProcessSpawner | FileSystem | Path` from it — the host surface a
 *   flow body or an agent's standard tools consume, placed on the machine.
 * - {@link run} holds one machine for one unit of work and returns the
 *   body's result with the {@link Work} its checkout gained, captured as a
 *   diff from a host-resolvable base before the machine is released;
 *   `SandboxMerge.apply` lands that work on the host.
 *
 * `SandboxConformance` states the session contract as behavior;
 * `DirectorySandbox` and `ContainerSandbox` are the two in-repository
 * implementations, and vendor machines live in plugin packages built on the
 * same seam.
 *
 * @since 0.1.0
 */

export * from "./commandProvider.ts"
export * from "./fanOut.ts"
export * from "./fileSystem.ts"
export * from "./layerHost.ts"
export type { NetworkPolicy } from "./NetworkPolicy.ts"
export * from "./Provider.ts"
export type { ResourceLimits } from "./ResourceLimits.ts"
export * from "./run.ts"
export * from "./Session.ts"
export * from "./TestSession.ts"
export * from "./TestSessionProvider.ts"
export * from "./TestSessionState.ts"
export * from "./Work.ts"
