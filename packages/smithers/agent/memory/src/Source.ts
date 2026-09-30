/**
 * Advisory memory context source for an agent's opening context.
 *
 * {@link readRows} fetches primer notes and recall once, bounded to the fenced
 * byte budget, and returns the rows unrendered; {@link render} fences them.
 * A read that fails or passes its two-second timeout fails with the typed
 * cause: there is no empty-text stand-in, so the host decides what a run
 * without its memory does. Values returned by {@link declared} are accepted
 * as `Agent.Options.memory`, which renders them into the opening context and
 * lets a judged run's relevance reading withhold rows.
 *
 * The fence is a delimiter, not a trust boundary. Rows are model-written, so
 * fence tokens, attribution prefixes, and line terminators inside a row are
 * rendered as visible `\uXXXX` escapes: one row is always one line, and only
 * {@link render} writes a fence or a `[primer:bank]` / `[bank/key]` label.
 *
 * ## What "once per `(lineageId, iteration)`" actually promises
 *
 * Every source has an in-process memo. With no
 * {@link SnapshotRecorder.SnapshotRecorder} in the Effect context, that is the
 * whole guarantee: two reads through one source return the same successful
 * rows, a failed read is retried, and a second source refetches live memory.
 * This is the documented default for compositions that use `@smthrs/memory`
 * alone.
 *
 * When a recorder is present, the first read for an identity goes through its
 * boundary. A failed read is not recorded and can be retried. A second
 * source, including one built by a resumed process, receives the recorded
 * rows instead of refetching memory. The production adapter is
 * `@smthrs/agent/MemorySnapshotRecorder.layer`; it implements this package's
 * port through `@smthrs/harness` `EngineLike.record`. The dependency therefore
 * points from agent to memory and harness, while memory imports neither.
 *
 * The consequence is worth stating plainly, because it is the reason to record
 * this value rather than re-derive it. Memory text goes into an agent's OPENING
 * context, so a resumed run whose snapshot came back different has a different
 * frame-zero prefix. That re-keys every sealed model step under it, causing the
 * run to re-execute model calls it already paid for. Composing the agent adapter
 * closes that replay gap; omitting it deliberately keeps the process-local
 * fallback.
 *
 * @see https://memory.smithers.sh/reference/api/
 *
 * @since 0.1.0
 */

import type * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { canonicalJson } from "./internal/Canonical.ts"
import { digest } from "./internal/Digest.ts"
import { resolveBanks } from "./internal/ResolveNamespace.ts"
import type { MemoryError } from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Recall from "./Recall.ts"
import * as SnapshotRecorder from "./SnapshotRecorder.ts"

/**
 * Source input and retry identity.
 *
 * `lineageId` and `iteration` alone select the frozen snapshot. Banks, query,
 * tag groups, primer banks, and both budgets are honored only by the first
 * read for that identity; later differences are warned and ignored.
 * `maxTokens` caps recalled rows in conservative UTF-8 bytes, while
 * `maxBytes` caps the complete fenced snapshot {@link render} writes.
 *
 * @category models
 * @since 0.1.0
 */
export interface Input extends Recall.Input {
  readonly lineageId: string
  readonly iteration: number
  readonly primerBanks?: ReadonlyArray<string>
  readonly maxBytes?: number
}

/**
 * A memory source value consumed by the host that builds an agent's opening
 * context.
 *
 * @category models
 * @since 0.1.0
 */
export interface Source {
  readonly read: (
    input: Input
  ) => Effect.Effect<
    SnapshotRecorder.Snapshot,
    MemoryError | Cause.TimeoutError,
    MemoryStore.MemoryStore | Recall.Recall
  >
}

/**
 * Exact shape `Agent.Options.memory` accepts: a snapshot's rows and the
 * digest of their whole {@link render}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Declared extends SnapshotRecorder.Snapshot {
  readonly digest: string
}

const encoder = new TextEncoder()
const openingFence = "<flows_memory_context>"
const closingFence = "</flows_memory_context>"
const shellBytes = encoder.encode(`${openingFence}\n\n${closingFence}`).byteLength
const defaultMaxBytes = 16 * 1024

// Memory rows are model-written, so every character that could open a fence,
// start an attribution label, or end the row is replaced with its visible
// `\uXXXX` escape before rendering. `\` is in the set, so an escape written
// here can never be confused with one the row already contained.
const textEscapes = /[\\<[\r\n\u0085\u2028\u2029]/g
const textEscape = /[\\<[\r\n\u0085\u2028\u2029]/
const labelEscapes = /[\\<[\]:/\r\n\u0085\u2028\u2029]/g
const escapeUnit = (character: string): string => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
const escapeText = (text: string): string => text.replace(textEscapes, escapeUnit)
const escapeLabel = (label: string): string => label.replace(labelEscapes, escapeUnit)
const bytes = (text: string): number => encoder.encode(text).byteLength

const label = (row: SnapshotRecorder.Row): string =>
  row.origin === "primer"
    ? `[primer:${escapeLabel(row.bank)}] `
    : `[${escapeLabel(row.bank)}/${escapeLabel(row.key)}] `

/** The longest head of `text` whose escaped form fits in `limit` bytes. */
const fit = (text: string, limit: number): string => {
  let used = 0
  let end = 0
  for (const character of text) {
    used += textEscape.test(character) ? escapeUnit(character).length : bytes(character)
    if (used > limit) break
    end += character.length
  }
  return text.slice(0, end)
}

/**
 * The rows whose fenced render fits in `maxBytes`, in order. The first row
 * that does not fit whole is cut to what does, and ends the list.
 */
const bounded = (
  rows: ReadonlyArray<SnapshotRecorder.Row>,
  maxBytes: number
): ReadonlyArray<SnapshotRecorder.Row> => {
  const kept: Array<SnapshotRecorder.Row> = []
  let available = maxBytes - shellBytes
  for (const row of rows) {
    const room = available - (kept.length === 0 ? 0 : 1) - bytes(label(row))
    const text = fit(row.text, Math.max(0, room))
    if (room < 0 || (text === "" && row.text !== "")) break
    kept.push(text === row.text ? row : { ...row, text })
    if (text !== row.text) break
    available = room - bytes(escapeText(text))
  }
  return kept
}

/**
 * Fences rows as the opening memory block, one escaped line each; `""` for
 * no rows. Rows from {@link readRows} already fit its byte budget, and so
 * does any subset of them.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const render = (rows: ReadonlyArray<SnapshotRecorder.Row>): string =>
  rows.length === 0
    ? ""
    : `${openingFence}\n${rows.map((row) => `${label(row)}${escapeText(row.text)}`).join("\n")}\n${closingFence}`

/** A primer note's relevance key: its id, else the digest of its text. */
const primerKey = (row: { readonly id?: string | undefined; readonly text: string }): string =>
  row.id === undefined || row.id === "" ? digest(row.text) : row.id

/**
 * Reads primer notes and recall for `input`, unrendered, bounded to its
 * fenced byte budget. Fails with the store's or recall's typed error, or a
 * `TimeoutError` after two seconds.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const readRows = (
  input: Input
): Effect.Effect<
  SnapshotRecorder.Snapshot,
  MemoryError | Cause.TimeoutError,
  MemoryStore.MemoryStore | Recall.Recall
> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const recall = yield* Recall.Recall
    const requestedBytes = input.maxBytes ?? defaultMaxBytes
    const maxBytes = Number.isFinite(requestedBytes) ? Math.max(0, Math.floor(requestedBytes)) : defaultMaxBytes
    const available = Math.max(0, maxBytes - shellBytes)
    const primerBanks = input.primerBanks ?? input.banks
    const resolvedPrimerBanks = yield* resolveBanks(primerBanks)
    const primers = yield* Effect.all(
      resolvedPrimerBanks.map(({ bank, namespace }) => {
        // Even an empty note consumes its label and a separator. This window
        // contains enough candidates to fill the body, without reading a bank
        // in full. searchRows orders newest-first; facts use candidate slots
        // but are never rendered as primers.
        const minimumLineBytes = bytes(`[primer:${escapeLabel(bank)}] `) + 1
        return store.searchRows({
          namespace,
          status: "accepted",
          limit: Math.max(1, Math.ceil((available + 1) / minimumLineBytes))
        }).pipe(
          Effect.map((rows) =>
            rows.filter((row) => row.kind === "note").map((row): SnapshotRecorder.Row => ({
              origin: "primer",
              bank,
              key: primerKey(row),
              text: row.text
            }))
          )
        )
      }),
      { concurrency: 4 }
    )
    const recalled = yield* recall.recall(input)
    return {
      rows: bounded([
        ...primers.flat(),
        ...recalled.map((result): SnapshotRecorder.Row => ({
          origin: "recall",
          bank: result.bank,
          key: result.key,
          text: result.text
        }))
      ], maxBytes)
    }
  }).pipe(Effect.timeout("2 seconds"))

/**
 * Constructs a memoizing memory source.
 *
 * The closure memo is always present. When
 * {@link SnapshotRecorder.SnapshotRecorder} is absent, it is the process-local
 * default. When a recorder is composed, the memoized read first asks that
 * recorder for the durable value of the same `(lineageId, iteration)`
 * identity. A failed read is neither memoized nor recorded.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: { readonly capacity?: number | undefined } = {}): Source => {
  const capacity = options.capacity ?? 1_024
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError("memory source capacity must be a positive safe integer")
  }
  type Read = ReturnType<Source["read"]>
  const snapshots = new Map<string, {
    readonly effect: Read
    readonly fields: Readonly<Record<string, string>>
  }>()
  const fields = (input: Input): Readonly<Record<string, string>> => ({
    banks: canonicalJson(input.banks),
    query: canonicalJson(input.query),
    tagGroups: canonicalJson(input.tagGroups),
    maxTokens: canonicalJson(input.maxTokens),
    budget: canonicalJson(input.budget),
    primerBanks: canonicalJson(input.primerBanks),
    maxBytes: canonicalJson(input.maxBytes)
  })
  return {
    read: (input) => {
      const key = `${input.lineageId}\u0000${input.iteration}`
      const existing = snapshots.get(key)
      if (existing !== undefined) {
        snapshots.delete(key)
        snapshots.set(key, existing)
        const currentFields = fields(input)
        const changed = Object.keys(existing.fields).filter((field) => existing.fields[field] !== currentFields[field])
        return changed.length === 0
          ? existing.effect
          : Effect.logWarning(
            `memory source ignored changed fields for frozen snapshot ${key}: ${changed.join(", ")}`
          ).pipe(Effect.andThen(existing.effect))
      }
      const identity: SnapshotRecorder.Identity = {
        lineageId: input.lineageId,
        iteration: input.iteration
      }
      const current: Read = Effect.runSync(
        Effect.cached(
          Effect.gen(function*() {
            const recorder = yield* Effect.serviceOption(SnapshotRecorder.SnapshotRecorder)
            return yield* Option.match(recorder, {
              onNone: () => readRows(input),
              onSome: (recorder) =>
                Effect.gen(function*() {
                  // The recorder port accepts an infallible effect. Send typed
                  // failures outside that boundary and cancel its pending
                  // read, so a failure is never recorded.
                  const failed = yield* Deferred.make<never, MemoryError | Cause.TimeoutError>()
                  return yield* Effect.raceFirst(
                    recorder.record(
                      identity,
                      readRows(input).pipe(
                        Effect.catch((cause) => Deferred.fail(failed, cause).pipe(Effect.andThen(Effect.never)))
                      )
                    ),
                    Deferred.await(failed)
                  )
                })
            })
          }).pipe(
            // Only successful snapshots are frozen, with or without a
            // recorder, so a retry of this identity reads again.
            Effect.onError(() =>
              Effect.sync(() => {
                if (snapshots.get(key)?.effect === current) snapshots.delete(key)
              })
            )
          )
        )
      )
      snapshots.set(key, { effect: current, fields: fields(input) })
      while (snapshots.size > capacity) snapshots.delete(snapshots.keys().next().value!)
      return current
    }
  }
}

/**
 * The default source value.
 *
 * @category instances
 * @since 0.1.0
 */
export const source = make()

/**
 * Rows a host already holds as the exact {@link Declared} shape
 * `Agent.Options.memory` accepts. The rows are not bounded here; a host
 * bounds what it selects before declaring it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const ofRows = (rows: ReadonlyArray<SnapshotRecorder.Row>): Declared => ({ rows, digest: digest(render(rows)) })

/**
 * Reads a source snapshot as the exact {@link Declared} shape
 * `Agent.Options.memory` accepts.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const declared = (
  memorySource: Source,
  input: Input
): Effect.Effect<Declared, MemoryError | Cause.TimeoutError, MemoryStore.MemoryStore | Recall.Recall> =>
  memorySource.read(input).pipe(Effect.map(({ rows }) => ofRows(rows)))
