/**
 * The conformance suite a sandbox session provider must pass.
 *
 * States the `Sandbox` session contract as behavior — byte round-trips,
 * `not_found` for absence, parent creation, the workdir default, environment
 * delivery, reacquire — and delegates the spawn obligations to
 * `ProviderConformance` through `commandProvider`, so passing here means the
 * provider also holds up everywhere the spawner-level seam is consumed.
 *
 * @since 0.1.0
 */

export * from "./check.ts"
export * from "./posixCommands.ts"
