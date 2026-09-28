/**
 * Non-blocking forwarding of bounded operational logs to the durable journal.
 *
 * @since 0.1.0
 */

import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Redaction from "@smthrs/journal/Redaction"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import type * as LogLevel from "effect/LogLevel"
import * as EffectMetric from "effect/Metric"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import { schemaIssuePath } from "./internal/schemaIssuePath.ts"
import { droppedLogRecords } from "./Metric.ts"

/**
 * Largest queue accepted by the forwarding logger.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumCapacity = 65_536

/**
 * Largest detached log payload admitted to the asynchronous queue.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumSnapshotBytes = 1024 * 1024

/**
 * Largest number of container members copied into one detached log payload.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumSnapshotMembers = 4_096

/**
 * Deepest container path copied into one detached log payload.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumSnapshotDepth = 64

/**
 * What a hostile or unreadable logged value becomes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const unrenderableMarker = "[Unrenderable]"

/**
 * What a value beyond a logger resource ceiling becomes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const truncatedMarker = "[Truncated]"

/**
 * Options for the journal forwarding logger.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  /** The run every forwarded record is attributed to. */
  readonly runId: JournalEvent.RunId
  /** Queue depth, 1 through {@link maximumCapacity}. Defaults to 256. */
  readonly capacity?: number | undefined
  /**
   * Pins `References.MinimumLogLevel` for the whole application. Omitted, the
   * layer leaves that reference alone and Effect's own `Info` default applies.
   */
  readonly minimumLogLevel?: LogLevel.LogLevel | undefined
  /**
   * Keeps the ambient loggers alongside the forwarder. Defaults to `false`,
   * which replaces the ambient logger set.
   */
  readonly mergeWithExisting?: boolean | undefined
}

/**
 * A stable logger configuration refusal.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class InvalidJournalLoggerOptions extends Schema.TaggedError<InvalidJournalLoggerOptions>()(
  "@smthrs/observability/InvalidJournalLoggerOptions",
  {
    code: Schema.Literal("invalid_journal_logger_options"),
    path: Schema.String,
    message: Schema.String
  }
) {}

/**
 * One typed failure retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryFail = Schema.Struct({
  _tag: Schema.Literal("Fail"),
  error: Schema.Unknown
})

/**
 * One unexpected defect retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryDie = Schema.Struct({
  _tag: Schema.Literal("Die"),
  defect: Schema.Unknown
})

/**
 * One interruption retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryInterrupt = Schema.Struct({
  _tag: Schema.Literal("Interrupt"),
  fiberId: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * One reason in a persisted telemetry cause.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryCauseReason = Schema.Union([TelemetryFail, TelemetryDie, TelemetryInterrupt])

/**
 * One reason in a persisted telemetry cause.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryCauseReason = typeof TelemetryCauseReason.Type

/**
 * A versioned structural Effect cause.
 *
 * Effect 4 stores composed failures as an ordered reason list. The projection
 * preserves that order and each fail, defect, or interrupt discriminator.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryCause = Schema.Struct({
  version: Schema.Literal(1),
  reasons: Schema.Array(TelemetryCauseReason)
})

/**
 * A versioned structural Effect cause.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryCause = typeof TelemetryCause.Type

/**
 * Runtime schema for the operational log payload written to the journal.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryLog = Schema.Struct({
  version: Schema.Literal(1),
  level: Schema.Literals(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]),
  message: Schema.Unknown,
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  cause: TelemetryCause,
  fiberId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String),
  timestamp: Schema.String
})

/**
 * Versioned operational log payload written to the journal.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryLog = typeof TelemetryLog.Type

const sourceId = "flows/observability/logger" as JournalEvent.SourceId
const encoder = new TextEncoder()

const OptionsSchema = Schema.Struct({
  runId: JournalEvent.RunId,
  capacity: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(maximumCapacity)
    )
  ),
  minimumLogLevel: Schema.optional(
    Schema.Literals(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"])
  ),
  mergeWithExisting: Schema.optional(Schema.Boolean)
})

const validateOptions = (options: Options) =>
  Schema.decodeUnknownEffect(OptionsSchema)(options).pipe(
    Effect.mapError((cause) => {
      const path = schemaIssuePath(cause, "options")
      return new InvalidJournalLoggerOptions({
        code: "invalid_journal_logger_options",
        path,
        message: `journal logger ${path} is invalid`
      })
    })
  )

interface SnapshotBudget {
  bytes: number
  members: number
}

const reserve = (budget: SnapshotBudget, bytes: number): boolean => {
  if (bytes > budget.bytes) return false
  budget.bytes -= bytes
  return true
}

const textBytes = (value: string): number => encoder.encode(JSON.stringify(value)).byteLength

const quoteBytes = 2
const shortEscapes = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

/** Bytes one non-surrogate code unit occupies inside a JSON string body. */
const unitBytes = (code: number): number => {
  if (code === 0x22 || code === 0x5c) return 2
  if (code < 0x20) return shortEscapes.has(code) ? 2 : 6
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  return 3
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * The longest prefix whose JSON string body fits `limit` bytes, measured in one
 * forward pass. A surrogate pair is admitted or refused whole, so the retained
 * text is well formed whenever the input is.
 */
const boundedPrefix = (value: string, limit: number): { readonly text: string; readonly bytes: number } => {
  let bytes = 0
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    let width = 1
    let cost: number
    if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(value.charCodeAt(index + 1))) {
      width = 2
      cost = 4
    } else if (code >= 0xd800 && code <= 0xdfff) {
      cost = 6
    } else {
      cost = unitBytes(code)
    }
    if (bytes + cost > limit) break
    bytes += cost
    index += width
  }
  return { text: value.slice(0, index), bytes }
}

const boundedText = (value: string, budget: SnapshotBudget): string => {
  if (value.length <= maximumSnapshotBytes && reserve(budget, textBytes(value))) return value
  const markerBytes = textBytes(truncatedMarker)
  const prefix = boundedPrefix(value, Math.max(0, budget.bytes - markerBytes - quoteBytes))
  budget.bytes = Math.max(0, budget.bytes - (prefix.bytes + quoteBytes) - markerBytes)
  return `${prefix.text}${truncatedMarker}`
}

/**
 * Error fields read through the prototype chain, in the order the snapshot
 * projects them before any own data property the error added.
 */
const standardErrorKeys = ["name", "message", "stack", "cause"] as const

const snapshotValue = (
  value: unknown,
  budget: SnapshotBudget,
  ancestors: WeakSet<object>,
  depth = 0
): unknown => {
  if (budget.bytes <= 0) return truncatedMarker
  if (depth > maximumSnapshotDepth) return Redaction.depthMarker
  if (typeof value === "string") return boundedText(value, budget)
  if (typeof value === "number") {
    const projected = Number.isFinite(value) ? value : String(value)
    reserve(budget, String(projected).length)
    return projected
  }
  if (typeof value === "boolean" || value === null) {
    reserve(budget, value === null ? 4 : value ? 4 : 5)
    return value
  }
  if (typeof value === "bigint") return boundedText(`${value}n`, budget)
  if (value === undefined) return boundedText("[Undefined]", budget)
  if (typeof value === "function") return boundedText(Redaction.functionMarker, budget)
  if (typeof value === "symbol") return boundedText(Redaction.symbolMarker, budget)
  try {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return boundedText(Redaction.binaryMarker, budget)
    }
  } catch {
    return boundedText(unrenderableMarker, budget)
  }
  if (ancestors.has(value)) return boundedText("[Circular]", budget)
  ancestors.add(value)
  try {
    if (value instanceof Date) {
      try {
        return boundedText(value.toISOString(), budget)
      } catch {
        return boundedText(unrenderableMarker, budget)
      }
    }
    if (value instanceof Error) {
      const record: Record<string, unknown> = Object.create(null)
      for (const key of standardErrorKeys.slice(0, budget.members)) {
        budget.members--
        try {
          record[key] = snapshotValue(value[key], budget, ancestors, depth + 1)
        } catch {
          record[key] = unrenderableMarker
        }
      }
      // Tagged failures (`_tag`, domain fields) and system errors (`code`,
      // `path`, `syscall`) keep their diagnostics as own data properties, so
      // the walk that projects plain records runs over the remaining keys.
      let names: ReadonlyArray<string>
      try {
        names = Object.getOwnPropertyNames(value).filter((key) =>
          !(standardErrorKeys as ReadonlyArray<string>).includes(key)
        )
      } catch {
        return record
      }
      let projected = 0
      let collided = false
      for (; projected < names.length && budget.members > 0; projected++) {
        budget.members--
        const key = names[projected]!
        const boundedKey = boundedText(key, budget)
        if (Object.hasOwn(record, boundedKey)) {
          collided = true
          continue
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        record[boundedKey] = descriptor !== undefined && "value" in descriptor
          ? snapshotValue(descriptor.value, budget, ancestors, depth + 1)
          : unrenderableMarker
      }
      if (collided || projected < names.length) record[truncatedMarker] = truncatedMarker
      return record
    }
    if (Array.isArray(value)) {
      const output: Array<unknown> = []
      const length = value.length
      for (let index = 0; index < length && budget.members > 0; index++) {
        budget.members--
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        output.push(
          descriptor === undefined || !("value" in descriptor)
            ? unrenderableMarker
            : snapshotValue(descriptor.value, budget, ancestors, depth + 1)
        )
      }
      if (output.length < length) output.push(truncatedMarker)
      return output
    }
    const record: Record<string, unknown> = Object.create(null)
    const names = Object.getOwnPropertyNames(value)
    for (let index = 0; index < names.length && budget.members > 0; index++) {
      budget.members--
      const key = names[index]!
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      const boundedKey = boundedText(key, budget)
      // A key truncated to fit the budget can read exactly like one already
      // copied. The first member keeps its slot; the later one is dropped and
      // the record is marked truncated below rather than silently overwritten.
      if (Object.hasOwn(record, boundedKey)) continue
      record[boundedKey] = descriptor !== undefined && "value" in descriptor
        ? snapshotValue(descriptor.value, budget, ancestors, depth + 1)
        : unrenderableMarker
    }
    if (Object.keys(record).length < names.length) record[truncatedMarker] = truncatedMarker
    return record
  } catch {
    return boundedText(unrenderableMarker, budget)
  } finally {
    ancestors.delete(value)
  }
}

const snapshotCause = (cause: Cause.Cause<unknown>, budget: SnapshotBudget): TelemetryCause => ({
  version: 1,
  reasons: cause.reasons.slice(0, maximumSnapshotMembers).map((reason): TelemetryCauseReason => {
    switch (reason._tag) {
      case "Fail":
        return { _tag: "Fail", error: snapshotValue(reason.error, budget, new WeakSet()) }
      case "Die":
        return { _tag: "Die", defect: snapshotValue(reason.defect, budget, new WeakSet()) }
      case "Interrupt":
        return { _tag: "Interrupt", fiberId: reason.fiberId ?? null }
    }
  })
})

const isTelemetryLog = Schema.is(TelemetryLog)

/**
 * Annotations are a container in the durable schema, so a snapshot that spent
 * the budget names the loss inside a record instead of replacing the record
 * with a scalar the schema refuses.
 */
const snapshotAnnotations = (value: unknown, budget: SnapshotBudget): Readonly<Record<string, unknown>> => {
  const snapshot = snapshotValue(value, budget, new WeakSet())
  return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
    ? snapshot as Readonly<Record<string, unknown>>
    : { [truncatedMarker]: truncatedMarker }
}

const snapshotLog = (options: Logger.Options<unknown>): TelemetryLog => {
  const budget: SnapshotBudget = {
    bytes: maximumSnapshotBytes,
    members: maximumSnapshotMembers
  }
  try {
    const span = Option.getOrUndefined(Context.getOption(options.fiber.context, Tracer.ParentSpan))
    const candidate: TelemetryLog = {
      version: 1,
      level: options.logLevel,
      message: snapshotValue(options.message, budget, new WeakSet()),
      annotations: snapshotAnnotations(options.fiber.getRef(References.CurrentLogAnnotations), budget),
      cause: snapshotCause(options.cause, budget),
      fiberId: options.fiber.id,
      ...(span === undefined ? {} : { traceId: span.traceId, spanId: span.spanId }),
      timestamp: options.date.toISOString()
    }
    const redacted = Redaction.redact(candidate, { onTooDeep: "name" }) as TelemetryLog
    // The durable row is only useful if the exported schema decodes it, so an
    // oversized or schema-invalid projection degrades to the total record
    // rather than to a payload every consumer throws on.
    return encoder.encode(JSON.stringify(redacted)).byteLength <= maximumSnapshotBytes && isTelemetryLog(redacted)
      ? redacted
      : { ...candidate, message: truncatedMarker, annotations: {}, cause: { version: 1, reasons: [] } }
  } catch {
    return {
      version: 1,
      level: options.logLevel,
      message: unrenderableMarker,
      annotations: {},
      cause: { version: 1, reasons: [] },
      fiberId: options.fiber.id,
      timestamp: options.date.toISOString()
    }
  }
}

const makeLog = (options: Logger.Options<unknown>, runId: JournalEvent.RunId): JournalEvent.Input =>
  new JournalEvent.Input({
    runId,
    sourceId,
    // The journal owns the durable per-run/source allocation. A local counter
    // starts over when a layer is rebuilt and makes distinct records collide.
    eventType: "telemetry.log",
    payload: snapshotLog(options),
    meta: {
      version: 1,
      source: "/observability"
    }
  })

/**
 * Installs a bounded, drop-on-overflow logger forwarder for one explicit run.
 *
 * Configuration is decoded before a worker starts. The callback reads the
 * queue's remaining room first, snapshots and redacts a bounded DTO
 * synchronously only when a slot is free, then performs only non-blocking
 * queue admission. A record a saturated queue cannot take is counted and
 * discarded without being snapshotted. Queue overflow, journal `Dropped` receipts, delivery failures,
 * and journal defects each advance `Metric.droppedLogRecords`. The two failure
 * paths also warn through the ambient loggers with a fixed code and run id,
 * and the worker keeps draining. `Accepted` and `Duplicate` do not advance the
 * counter. Admission receipts cannot identify later drop-oldest evictions of
 * these records or report asynchronous persistence failures or shutdown losses.
 * Closing the scope interrupts the worker and may drop records still queued
 * behind an in-flight write without advancing the counter.
 *
 * The layer replaces the ambient logger set unless `mergeWithExisting` is
 * `true`, and provides `MinimumLogLevel` only when `minimumLogLevel` is given,
 * so an application that set that reference elsewhere keeps it.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerJournalForwarding = (
  options: Options
): Layer.Layer<never, InvalidJournalLoggerOptions, Journal.Journal> =>
  Layer.unwrap(
    Effect.map(validateOptions(options), (configured) =>
      Layer.merge(
        Layer.effect(
          Logger.CurrentLoggers,
          Effect.gen(function*() {
            const journal = yield* Journal.Journal
            const queue = yield* Queue.bounded<JournalEvent.Input>(configured.capacity ?? 256)
            const dropped = EffectMetric.update(droppedLogRecords, 1)
            // This worker is forked before the logger it feeds is installed, so
            // its ambient logger set cannot contain that logger and a warning
            // here cannot enqueue itself. Delivery stays lossy; the loss is
            // reported and counted instead of vanishing. Warning annotations
            // use fixed codes so ambient sinks never receive raw failures.
            const forward = Effect.fn("JournalLogger.forward")((input: JournalEvent.Input) =>
              journal.emitLossy(input).pipe(
                Effect.tap((receipt) => receipt._tag === "Dropped" ? dropped : Effect.void),
                Effect.catch(() =>
                  dropped.pipe(
                    Effect.andThen(
                      Effect.annotateLogs(Effect.logWarning("A telemetry log record could not be forwarded"), {
                        runId: configured.runId,
                        code: "journal_forwarding_failed"
                      })
                    )
                  )
                )
              )
            )
            yield* Effect.forever(
              Queue.take(queue).pipe(
                Effect.flatMap(forward),
                // A defect from a journal implementation would otherwise end
                // this fiber for the rest of the run, silently, while the layer
                // still looks installed. Interruption stays fatal.
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : dropped.pipe(
                      Effect.andThen(
                        Effect.annotateLogs(
                          Effect.logWarning("The telemetry forwarding worker recovered from a defect"),
                          { runId: configured.runId, code: "journal_forwarding_defect" }
                        )
                      )
                    )
                )
              )
            ).pipe(Effect.forkScoped)

            const logger = Logger.make<unknown, void>((logOptions) => {
              // Snapshotting and redacting the record is the expensive half of
              // admission, and saturation is exactly when that work is thrown
              // away, so a queue with no room refuses before the record is
              // built. Nothing else runs between this read and the offer, so
              // the check cannot refuse a record the queue would have taken,
              // and the offer still reports a queue that closed underneath it.
              const accepted = !Queue.isFullUnsafe(queue)
                && Queue.offerUnsafe(queue, makeLog(logOptions, configured.runId))
              if (!accepted) droppedLogRecords.updateUnsafe(1, logOptions.fiber.context)
            })
            const current = yield* Effect.withFiber((fiber) => Effect.sync(() => fiber.getRef(Logger.CurrentLoggers)))
            return new Set(configured.mergeWithExisting === true ? current : []).add(logger)
          })
        ),
        configured.minimumLogLevel === undefined
          ? Layer.empty
          : Layer.succeed(References.MinimumLogLevel, configured.minimumLogLevel)
      ))
  )
