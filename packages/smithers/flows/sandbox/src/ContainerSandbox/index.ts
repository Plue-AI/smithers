/**
 * The container-lifecycle sandbox provider.
 *
 * A `Sandbox.Provider` that creates, reattaches, and removes containers
 * through a Docker-compatible CLI running on an injected spawner. This is the
 * in-repository isolation backend: the machine boundary is the container's,
 * and the session's commands, reads, and writes all travel over `exec`.
 *
 * @since 0.1.0
 */

export * from "./make.ts"
