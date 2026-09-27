/**
 * The conformance suite a sandbox provider must pass.
 *
 * A provider lives in a plugin package, and the seam it implements is small
 * enough to satisfy by accident and wide enough to get wrong in ways only a
 * running flow discovers: output that arrives decoded, an exit code swallowed
 * into a failure, a `kill` that is declared and refuses. This module is the
 * contract in executable form. An adapter author supplies three fixture
 * commands, runs {@link check}, and asserts that it reports nothing.
 *
 * @since 0.1.0
 */

export * from "./check.ts"
export * from "./Commands.ts"
export * from "./Violation.ts"
