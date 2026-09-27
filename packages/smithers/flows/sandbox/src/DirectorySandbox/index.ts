/**
 * The scratch-directory sandbox provider.
 *
 * A `Sandbox.Provider` whose machines are directories on this host, served
 * from an injected filesystem and spawner. It is the trusted local backend
 * and the conformance reference: real processes and real files with no
 * container runtime, and explicitly not a security boundary.
 *
 * @since 0.1.0
 */

export * from "./make.ts"
