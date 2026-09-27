/**
 * Sweeps one owner's Microsandbox machines whose holder is gone.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { attemptIn } from "../internal/attempt.ts"
import { removeMachine } from "../internal/microsandboxRemove.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { holderLabel, ownerLabel, providerLabel, providerName } from "./labels.ts"
import type { Sdk } from "./Sdk.ts"

type Handle = Awaited<ReturnType<Sdk["Sandbox"]["get"]>>

const attempt = attemptIn("microsandbox")

/** How long a reaped machine's graceful stop may take before its removal is forced. */
const defaultStopTimeoutMs = 3_000

/**
 * Names whose machines to sweep and how to tell a live holder from a dead one.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReapOptions {
  /** The injected Microsandbox SDK module. */
  readonly sdk: Sdk
  /** The `smithers.owner` label value whose machines are swept; no other owner's are touched. */
  readonly owner: string
  /**
   * Whether the process a machine's `smithers.holder` label names is still
   * running. A machine whose holder answers `false` is removed.
   */
  readonly isAlive: (holder: string) => Effect.Effect<boolean>
  /**
   * Whether a machine whose holder is dead is still wanted, from the labels
   * its configuration records: a sticky machine a durable run will reattach
   * when it resumes. A retained machine is left alone. Default: none is.
   */
  readonly retain?: ((labels: Readonly<Record<string, string>>) => Effect.Effect<boolean>) | undefined
  /** How long each removed machine's graceful stop may take before its removal is forced. Default 3000. */
  readonly stopTimeoutMs?: number | undefined
}

/**
 * One machine `reap` removed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reaped {
  /** The machine's Microsandbox name. */
  readonly name: string
  /** The dead holder its label named. */
  readonly holder: string
  /** The status the listing reported before removal, such as `running` or `crashed`. */
  readonly status: string
}

/** The string labels a machine's persisted configuration records, or `undefined` when it is unreadable. */
const labelsOf = (handle: Handle): Readonly<Record<string, string>> | undefined => {
  try {
    const labels: unknown = Reflect.get(Object(JSON.parse(handle.configJson)), "labels")
    return Object.fromEntries(
      Object.entries(Object(labels)).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    )
  } catch {
    // An unreadable configuration names no holder, and a machine nobody can
    // name the holder of is left alone rather than guessed at.
    return undefined
  }
}

/** The holder label a machine's persisted configuration records, if it carries one. */
const holderOf = (handle: Handle): string | undefined => labelsOf(handle)?.[holderLabel]

const isNotFound = (error: ProviderError): boolean => Reflect.get(Object(error.cause), "code") === "sandboxNotFound"

/**
 * Removes this owner's machines whose holder is no longer alive.
 *
 * Microsandbox's own database is the registry: machines are listed by the
 * `smithers.provider` and `smithers.owner` labels every `MicrosandboxSandbox`
 * machine carries, page by page, and each one's `smithers.holder` label is put
 * to `isAlive`. A machine whose holder is dead is stopped and removed under a
 * bounded graceful window, with a forced removal when that fails, whatever its
 * persistence: a sticky machine outlives its holder by design, and reaping is
 * how a host decides that holder is not coming back. Machines of other owners,
 * machines without a readable holder label, and machines this package did not
 * create are never touched.
 *
 * A caller's `retain` keeps a dead holder's machine it still wants, such as a
 * sticky workspace of a run that resumes after the restart; the resumed run
 * reattaches it and relabels it to the new holder.
 *
 * Just before a removal the machine is read again, and a machine whose holder
 * label changed since the listing is skipped: acquiring an existing machine
 * relabels it to the new holder, so a machine a live holder reattached in the
 * meantime survives. A reattach that lands between that second read and the
 * removal is not caught, so a host reaps at startup, before it acquires. A
 * machine that disappears on its own in between is skipped too.
 *
 * Every candidate is attempted. When any removal fails, the effect fails with
 * `unavailable` naming those machines, after the others have been removed.
 *
 * @category constructors
 * @since 0.1.0
 */
export const reap = (options: ReapOptions): Effect.Effect<ReadonlyArray<Reaped>, ProviderError> =>
  Effect.gen(function*() {
    const listed: Array<Handle> = []
    let cursor: string | undefined
    do {
      const after = cursor
      const page = yield* attempt(
        () =>
          options.sdk.Sandbox.listWith((list) => {
            const scoped = list.label(providerLabel, providerName).label(ownerLabel, options.owner)
            return after === undefined ? scoped : scoped.cursor(after)
          }),
        "unavailable",
        `the microVMs of owner ${options.owner} could not be listed`
      )
      listed.push(...page.sandboxes)
      cursor = page.nextCursor
    } while (cursor !== undefined)

    const reaped: Array<Reaped> = []
    const failed: Array<{ readonly name: string; readonly error: ProviderError }> = []
    for (const handle of listed) {
      const labels = labelsOf(handle)
      const holder = labels?.[holderLabel]
      if (labels === undefined || holder === undefined || (yield* options.isAlive(holder))) continue
      if (options.retain !== undefined && (yield* options.retain(labels))) continue
      const outcome = yield* Effect.gen(function*() {
        const current = yield* attempt(() => handle.refresh(), "unavailable", `${handle.name} could not be read`)
        if (holderOf(current) !== holder) return "skipped" as const
        yield* attempt(
          () => removeMachine(current, options.stopTimeoutMs ?? defaultStopTimeoutMs),
          "unavailable",
          `${handle.name} could not be removed`
        )
        return "removed" as const
      }).pipe(Effect.catch((error) => Effect.succeed(isNotFound(error) ? "skipped" as const : error)))
      if (outcome === "removed") reaped.push({ name: handle.name, holder, status: handle.status })
      else if (outcome !== "skipped") failed.push({ name: handle.name, error: outcome })
    }
    if (failed.length > 0) {
      return yield* Effect.fail(
        new ProviderError({
          code: "unavailable",
          message: `microsandbox: ${failed.length} orphaned microVM(s) could not be reaped: ${
            failed.map(({ name }) => name).join(", ")
          }`,
          cause: failed.map(({ error }) => error)
        })
      )
    }
    return reaped
  })
