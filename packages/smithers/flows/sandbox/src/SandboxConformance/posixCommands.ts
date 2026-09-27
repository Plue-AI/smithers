/**
 * Default conformance commands for POSIX-shell sessions.
 *
 * @since 0.1.0
 */

import type { Commands } from "../ProviderConformance/Commands.ts"

/**
 * The provider-conformance command fixture every POSIX-shell session can run.
 *
 * The session contract already pins command lines to POSIX `sh` semantics, so
 * unlike the spawner-level suite, this one can supply its own fixture; a
 * session whose machine speaks something else overrides it.
 *
 * `runs` sleeps for a duration nothing else on a shared machine is likely to
 * be sleeping for, and `survivor` looks for exactly that sleep with a pattern
 * that cannot match its own command line. A guest without `pgrep` answers 127
 * and the survivor question goes unanswered rather than wrongly answered.
 *
 * `check` does not use this value verbatim: several providers' machines are
 * the test host itself, and vitest runs suites in parallel workers, so two
 * checks sharing one duration would each find the other's fixture alive and
 * report a survivor that is not theirs. The default each check actually runs
 * is {@link uniquePosixCommands}, which keeps this shape and makes the
 * duration this process's own.
 *
 * @category models
 * @since 0.1.0
 */
export const posixCommands: Commands = {
  writes: "printf 'sandbox conformance'",
  output: "sandbox conformance",
  fails: "exit 23",
  failureCode: 23,
  runs: "sleep 3607",
  survivor: "pgrep -f 'sleep 360[7]'",
  shell: true
}

let uniqueRun = 0

/**
 * A per-process seed, read from the platform's own randomness where there is
 * any and from `Math.random` where there is not.
 *
 * It is deliberately NOT `process.pid`. This module is part of a package whose
 * contract is that it is platform-neutral and browser-bundleable, and a free
 * `process` identifier is not a bundling error — it survives the bundle and
 * throws `ReferenceError` in a browser the first time a caller runs
 * `SandboxConformance.check`, which defaults its fixture to the function
 * below. The pid bought nothing the seed does not: what the fixture needs is a
 * value two concurrent runs on one host are unlikely to share.
 */
const seed = (() => {
  const random = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto)
  /* v8 ignore next -- every runtime this package supports has Web Crypto; the fallback is for a host that does not */
  if (random === undefined) return Math.floor(Math.random() * 0xffffffff)
  return random(new Uint32Array(1))[0]!
})()

/**
 * The default fixture with a per-call sleep duration, derived from a
 * per-process seed and a counter, so concurrent conformance runs on one host
 * can never mistake each other's fixture for a survivor. The survivor pattern
 * brackets the final digit so it cannot match its own command line.
 *
 * @category constructors
 * @since 0.1.0
 */
export const uniquePosixCommands = (): Commands => {
  // Six digits give the collision space of concurrent workers room that a
  // four-digit one did not; the fixture is signalled long before it wakes.
  const duration = String(100000 + ((seed * 7919 + uniqueRun++ * 104729) % 900000))
  return {
    ...posixCommands,
    runs: `sleep ${duration}`,
    survivor: `pgrep -f 'sleep ${duration.slice(0, -1)}[${duration.slice(-1)}]'`
  }
}
