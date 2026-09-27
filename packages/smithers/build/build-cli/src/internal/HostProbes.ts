/**
 * One plan invocation's host-probe cache.
 *
 * Every native planner (Docker, Foundry, Anvil, mise) needs host facts that
 * do not change between the targets of one plan: which executable a name
 * resolves to, what version it reports, whether a daemon answers. Without a
 * shared memo, N targets of one rule ran N copies of each probe subprocess
 * before a single cache lookup. This cache keys each fact by the executable
 * identity, the probe arguments, and a digest of the environment the probe
 * runs under, and stores the in-flight promise so concurrent targets share
 * one subprocess. Project-specific queries (`forge config` under one cwd,
 * config path, and profile) key on those facts too, so a project fact never
 * aliases a global one.
 *
 * @since 1.0.0
 */

import * as Text from "./Text.ts"

/**
 * Memoizes host probes for one plan invocation.
 *
 * @category models
 * @since 1.0.0
 */
export interface HostProbes {
  /**
   * Runs `probe` once per distinct `key`, sharing the in-flight promise with
   * every later caller. `key` must be JSON-serializable; environment records
   * belong in the key through {@link environmentKey}.
   */
  readonly once: <A>(key: ReadonlyArray<unknown>, probe: () => Promise<A>) => Promise<A>
}

/**
 * A short, order-independent digest of an environment record, for use as a
 * key member. Two targets with the same declared lookup environment share a
 * probe; a target env override that changes PATH or a tool variable does not.
 *
 * @category keys
 * @since 1.0.0
 */
export const environmentKey = (environment: Readonly<Record<string, string | undefined>> | undefined): string =>
  environment === undefined
    ? "ambient"
    : Text.sha256Hex(
      JSON.stringify(
        Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string").sort((
          [left],
          [right]
        ) => Text.byCodeUnit(left, right))
      )
    )

/**
 * A fresh cache: one per plan invocation, never across invocations, because
 * probe results are key material for that plan alone.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (): HostProbes => {
  const inFlight = new Map<string, Promise<unknown>>()
  return {
    once: <A>(key: ReadonlyArray<unknown>, probe: () => Promise<A>): Promise<A> => {
      const serialized = JSON.stringify(key)
      const known = inFlight.get(serialized)
      if (known !== undefined) return known as Promise<A>
      const pending = probe()
      inFlight.set(serialized, pending)
      return pending
    }
  }
}

/**
 * The cache used when a caller supplies none: a fresh one, so a direct call
 * to a planner keeps its original one-shot behavior.
 *
 * @category constructors
 * @since 1.0.0
 */
export const none = (): HostProbes => make()
