/**
 * Named Microsandbox disk snapshots: capture a prepared machine, ask whether
 * one exists, and prune a family down to its newest members.
 *
 * A snapshot is the machine's whole root disk. A machine booted from it with
 * the provider's `snapshot` option starts with everything the captured
 * machine had installed, so an expensive preparation runs once per snapshot
 * rather than once per machine.
 *
 * Every snapshot this module captures is named `<family>.<member>` by
 * {@link snapshotName}: the family is the preparation the snapshot repeats
 * (one per repository, say) and the member distinguishes its captures. The
 * member never contains the separator, so a name belongs to exactly one
 * family and pruning one family cannot reach another whose name extends it.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import { attemptIn } from "../internal/attempt.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Sdk } from "./Sdk.ts"

const attempt = attemptIn("microsandbox")

/** How long the captured machine's graceful stop may take. */
const defaultStopTimeoutMs = 30_000

const isMissingSnapshot = (cause: unknown): boolean =>
  /\[SnapshotNotFound\]/.test(cause instanceof Error ? cause.message : String(cause))

/**
 * The character between a snapshot's family and its member.
 *
 * @category constants
 * @since 1.0.0
 */
export const snapshotSeparator = "."

/**
 * The name of `family`'s `member` snapshot, or `undefined` when the pair
 * cannot name exactly one family's snapshot: an empty part, or a member that
 * contains {@link snapshotSeparator} (it would read as a longer family).
 *
 * @category snapshots
 * @since 1.0.0
 */
export const snapshotName = (family: string, member: string): string | undefined =>
  family.length === 0 || member.length === 0 || member.includes(snapshotSeparator)
    ? undefined
    : `${family}${snapshotSeparator}${member}`

/**
 * The family a snapshot name belongs to: everything before its last
 * {@link snapshotSeparator}. `undefined` for a name this module did not
 * shape.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const snapshotFamily = (name: string): string | undefined => {
  const at = name.lastIndexOf(snapshotSeparator)
  return at <= 0 || at === name.length - 1 ? undefined : name.slice(0, at)
}

/**
 * What {@link captureSnapshot} captures and names.
 *
 * @category models
 * @since 1.0.0
 */
export interface CaptureOptions {
  /** The injected Microsandbox SDK module. */
  readonly sdk: Sdk
  /** The machine's Microsandbox name (a session's `remoteId`). */
  readonly machine: string
  /** The family the snapshot joins; {@link pruneSnapshots} prunes by it. */
  readonly family: string
  /** What tells this capture from the family's others; never contains {@link snapshotSeparator}. */
  readonly member: string
  /** How long the machine's graceful stop may take. Default 30000. */
  readonly stopTimeoutMs?: number | undefined
}

/**
 * Stops a machine, captures its root disk as the snapshot
 * {@link snapshotName} names, removes the machine, and returns that name.
 * The machine is removed whether or not the capture succeeded. A family and
 * member that cannot name a snapshot fail with `unavailable` before any
 * vendor call, and the machine stays.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const captureSnapshot = (options: CaptureOptions): Effect.Effect<string, ProviderError> => {
  const name = snapshotName(options.family, options.member)
  if (name === undefined) {
    return Effect.fail(
      new ProviderError({
        code: "unavailable",
        message: `microsandbox: family ${JSON.stringify(options.family)} and member ${
          JSON.stringify(options.member)
        } do not name a snapshot; both are non-empty and the member has no ${JSON.stringify(snapshotSeparator)}`
      })
    )
  }
  return attempt(
    async () => {
      const handle = await options.sdk.Sandbox.get(options.machine)
      try {
        if (handle.status === "running") {
          await handle.stop()
        }
        await handle.snapshot(name)
      } finally {
        await handle.destroy({ timeoutMs: options.stopTimeoutMs ?? defaultStopTimeoutMs, force: true })
      }
      return name
    },
    "unavailable",
    `the microVM ${options.machine} could not be captured as ${name}`
  )
}

/**
 * Whether a snapshot of that name exists.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const hasSnapshot = (sdk: Sdk, name: string): Effect.Effect<boolean, ProviderError> =>
  Effect.tryPromise({
    try: () => sdk.Snapshot.get(name),
    catch: (cause) => cause
  }).pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      isMissingSnapshot(cause)
        ? Effect.succeed(false)
        : Effect.fail(
          new ProviderError({ code: "unavailable", message: `microsandbox: snapshot ${name} could not be read`, cause })
        )
    )
  )

/**
 * Removes `family`'s snapshots (those {@link snapshotFamily} places in it,
 * exactly), except the `keep` newest and any named in `retain` (snapshots a
 * machine is about to boot from), and returns the removed names. Another
 * family whose name extends this one is never touched.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const pruneSnapshots = (
  sdk: Sdk,
  family: string,
  keep: number,
  retain: ReadonlyArray<string> = []
): Effect.Effect<ReadonlyArray<string>, ProviderError> =>
  attempt(
    async () => {
      const members = (await sdk.Snapshot.list())
        .flatMap((entry) =>
          entry.name !== null && snapshotFamily(entry.name) === family
            ? [{ name: entry.name, createdAt: entry.createdAt }]
            : []
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      const removed: Array<string> = []
      for (const { name } of members.slice(Math.max(0, keep))) {
        if (retain.includes(name)) continue
        await sdk.Snapshot.remove(name, { force: true })
        removed.push(name)
      }
      return removed
    },
    "unavailable",
    `the snapshot family ${family} could not be pruned`
  )

/**
 * Removes the named snapshot; one that is already gone is not an error.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const removeSnapshot = (sdk: Sdk, name: string): Effect.Effect<void, ProviderError> =>
  Effect.tryPromise({ try: () => sdk.Snapshot.remove(name, { force: true }), catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      isMissingSnapshot(cause)
        ? Effect.void
        : Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: `microsandbox: snapshot ${name} could not be removed`,
            cause
          })
        )
    )
  )
