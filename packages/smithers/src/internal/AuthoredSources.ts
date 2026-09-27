/**
 * Which discovered flows a native execution actually wrote the entry file of.
 *
 * The engine journals copy-back in two halves, and only the pair is evidence.
 * `flows.engine.diff-bundle-captured` says what an isolated attempt PROPOSED
 * to change; `flows.engine.copy-back-settled` says that proposal reached the
 * host. A capture on its own is speculative — the attempt may still fail, its
 * bundle may lose every rebase — so acting on one would refresh a catalog from
 * source bytes no run ever applied.
 *
 * The two are matched on the identity both carry: the execution and generation
 * the projection read them under, plus the attempt's own `runId`,
 * `stepKeyDigest`, `attempt` and `bundleIdentity`. That is the same rule the
 * app applies to the projected control rows
 * (`apps/app/src/mainview/state/FlowAuthoringReceipts.ts`); this one runs on
 * the host, over the engine's own entries, because the host has to act before
 * any client reads them.
 *
 * @since 1.0.0
 * @private
 */

/**
 * A registry entry path, which names its flow by the directory it sits in.
 *
 * Nested directories are part of the name (`flows/coding/request/flow.ts` is
 * `coding/request`), which is why the capture is greedy.
 */
const entry = /^flows\/(.+)\/(?:flow\.ts|flow\.mdx|SKILL\.md)$/

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * A path a host may act on: relative, no traversal, no control characters.
 *
 * A bundle's paths are attacker-influenced — an agent chooses what it writes —
 * and this rule is what keeps a refresh addressed to a flow of this project
 * rather than to whatever `../` reaches.
 */
const flowOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  // eslint-disable-next-line no-control-regex -- a control character in a path is the thing being refused
  if (/[\\\u0000-\u001f]/.test(value)) return undefined
  if (value.split("/").some((part) => part === "." || part === ".." || part === "")) return undefined
  return entry.exec(value)?.[1]
}

/**
 * One native record, as the projection reads it off the engine journal.
 *
 * @since 1.0.0
 * @private
 */
export interface Entry {
  readonly runId: string
  readonly eventType: string
  readonly payload: unknown
}

/**
 * The matcher's state: one open capture per attempt, until its copy-back
 * settles or the projection is done with the run.
 *
 * @since 1.0.0
 * @private
 */
export interface Matcher {
  /** The flow ids this record applied the entry file of. Empty for everything else. */
  readonly observe: (entry: Entry, generation: number) => ReadonlyArray<string>
}

/**
 * Matches settled copy-backs to their captured bundles.
 *
 * One matcher per observed execution: the projection follows a run and its
 * descendants, and a bundle captured under one attempt can only settle under
 * the same one.
 *
 * @since 1.0.0
 * @private
 */
export const make = (): Matcher => {
  /** Open captures, by the attempt that made them and then by bundle. */
  const captured = new Map<string, Map<string, ReadonlyArray<string>>>()
  const attemptOf = (entry: Entry, generation: number, payload: Record<string, unknown>): string | undefined => {
    if (
      typeof payload.runId !== "string" || typeof payload.stepKeyDigest !== "string" ||
      !Number.isSafeInteger(payload.attempt)
    ) return undefined
    return JSON.stringify([entry.runId, generation, payload.runId, payload.stepKeyDigest, payload.attempt])
  }
  return {
    observe: (entry, generation) => {
      const payload = record(entry.payload)
      if (payload === undefined) return []
      const attempt = attemptOf(entry, generation, payload)
      if (attempt === undefined) return []
      // An ATTEMPT is what opens a capture and what closes it. The engine
      // journals a settled copy-back inside the attempt that produced it and
      // finishes that attempt afterwards, and a failed attempt returns before
      // the settlement block runs at all, so by the time this record exists
      // every copy-back the attempt was going to record already has. A
      // capture still open here is one that lost — the bundle was proposed
      // and never applied — and holding it would keep a busy host's bundles
      // for the life of the observation.
      if (entry.eventType === "flows.engine.attempt-finished") {
        captured.delete(attempt)
        return []
      }
      if (typeof payload.bundleIdentity !== "string") return []
      const bundle = payload.bundleIdentity
      if (entry.eventType === "flows.engine.diff-bundle-captured") {
        const paths = Array.isArray(payload.changedPaths) ? payload.changedPaths : []
        const flows = paths.map(flowOf).filter((flow): flow is string => flow !== undefined)
        // Only a capture that touched a registry entry is worth holding: every
        // other bundle on a busy host would otherwise accumulate here for the
        // life of the observation.
        if (flows.length === 0) return []
        const open = captured.get(attempt) ?? new Map<string, ReadonlyArray<string>>()
        open.set(bundle, [...new Set(flows)])
        captured.set(attempt, open)
        return []
      }
      if (entry.eventType !== "flows.engine.copy-back-settled") return []
      const open = captured.get(attempt)
      const flows = open?.get(bundle)
      open?.delete(bundle)
      if (open?.size === 0) captured.delete(attempt)
      return flows ?? []
    }
  }
}
