/**
 * The argv-prefix sandbox provider.
 *
 * A `Sandbox.Provider` over a command that reaches a machine: nothing (this
 * machine), `ssh <args>` (a remote host, such as a Smithers Cloud workspace),
 * or `docker exec -i <container>` (a running container). The session's
 * commands, reads, and writes all travel through that prefix.
 *
 * @since 0.1.0
 */

export * from "./make.ts"
