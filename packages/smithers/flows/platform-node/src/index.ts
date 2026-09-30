/**
 * `@smthrs/platform-node`, the Node.js Host bundle.
 *
 * `@effect/platform-node` already ships `FileSystem`, `Path`,
 * `ChildProcessSpawner`, and an Undici-backed `HttpClient` for Node, and
 * `NodeHost.layer` composes the complete closed five-tag Host surface out of
 * them plus the Node `Jj` adapter, which lives in `@smthrs/jj`.
 *
 * The host adapters add guarantees beyond Effect's base services.
 * `AtomicFileSystem` performs every filesystem operation relative to
 * a pinned directory descriptor, so a symlink swapped in after authorization
 * cannot redirect it; `ProcessReaper` kills the process groups a crashed
 * incarnation of this host abandoned; `HostLiveness` answers whether a recorded
 * run owner is still running here. `ScopedProcess` runs transient commands with
 * supervised process cleanup and owns their input and output pipes.
 *
 * `AtomicFileSystem` is `NodeHost`'s filesystem slot. It executes operations
 * through the packaged `smithers-jj-export --atomic-fs` helper, selected by
 * `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` or `layerWith({ executable })`.
 * A missing helper fails guarded operations closed. Windows is unsupported.
 *
 * @since 0.1.0
 */

/** The complete closed Host bundle for Node. */
export * as NodeHost from "./NodeHost.ts"

/** The outbound HTTP client a Node process should use, read off its environment. */
export * as EgressHttpClient from "./EgressHttpClient.ts"

/** Whether a recorded run owner is still alive on this host. */
export * as HostLiveness from "./HostLiveness.ts"

/** Reaping the process groups a dead incarnation of this host abandoned. */
export * as ProcessReaper from "./ProcessReaper.ts"

/** Transient pipe-based commands with supervised process cleanup. */
export * as ScopedProcess from "./ScopedProcess.ts"

/** Native confinement of approved processes under the kernel grants. */
export * as ProcessConfinement from "./ProcessConfinement.ts"

/** Shared operating-system sandbox for build and agent processes. */
export * as ProcessSandbox from "./ProcessSandbox.ts"
