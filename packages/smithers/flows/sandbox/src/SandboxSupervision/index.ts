/**
 * Sandbox session supervision.
 *
 * `RemoteChildProcessSpawner` opens a session and runs commands in it. It has
 * no opinion about the session dying, and a dead remote session is quiet: the
 * provider's streams stop producing, its exit codes never arrive, and the
 * action that was waiting for them keeps waiting. This module is the heartbeat
 * that turns that silence into a failure.
 *
 * Supervision holds one session at a time and probes it on a fixed cadence
 * (`SandboxHealth`). An unhealthy verdict retires the session: everything
 * running in it fails with a `NotFound` `PlatformError` — the same reason the
 * adapter already maps a provider's `unavailable` onto — the provider's own
 * finalizer runs, and the next command opens a fresh session. The failure is
 * what makes the difference: a retry policy can act on it, and the action it
 * retries lands on a session that is alive.
 *
 * A provider without `ping` is never probed, so wrapping one in supervision
 * costs nothing and changes nothing.
 *
 * @since 0.1.0
 */

export * from "./layer.ts"
export * from "./make.ts"
export * from "./Options.ts"
export * from "./Reporter.ts"
export * from "./SandboxUnhealthy.ts"
