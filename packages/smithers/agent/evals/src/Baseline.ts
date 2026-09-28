/**
 * Canonical committed evaluation baselines.
 *
 * A baseline is the record of what a suite used to score, committed beside the
 * suite it belongs to. It holds only the fields a comparison reads, and
 * validation rebuilds every record from those fields, so nothing a caller
 * happened to attach to an object travels into a committed artifact.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { EvalError } from "./EvalError.ts"
import { CanonicalJson } from "./internal/CanonicalJson.ts"
import { controlCharacter } from "./internal/controlCharacters.ts"
import { tupleKey } from "./internal/tupleKey.ts"
import type { Observation, RunResult } from "./Runner.ts"

/**
 * Current committed baseline artifact version.
 *
 * @category models
 * @since 0.1.0
 */
export const version = 1 as const

/**
 * One successful score retained by a baseline.
 *
 * `scorer` is the scorer key a comparison matches on. `scorerName` is the
 * optional readable name of the same scorer.
 *
 * @category models
 * @since 0.1.0
 */
export interface BaselineRecord {
  readonly suite: string
  readonly case: string
  readonly scorer: string
  readonly scorerName?: string | undefined
  readonly stepKey: string
  readonly score: number
}

/**
 * Canonical committed evaluation baseline.
 *
 * `suite` records artifact ownership even when `records` is empty.
 *
 * @category models
 * @since 0.1.0
 */
export interface Baseline {
  readonly version: typeof version
  readonly suite: string
  readonly records: ReadonlyArray<BaselineRecord>
}

/**
 * The declared ceilings a committed baseline is validated against.
 *
 * `length` bounds the JSON text `load` will parse, so an oversized committed
 * file fails with a sentence instead of exhausting a CI runner's memory.
 *
 * @category models
 * @since 0.1.0
 */
export const limits = {
  /** Longest baseline JSON text, in UTF-16 code units. */
  length: 16 * 1024 * 1024
} as const

const fail = (message: string, path?: string): Effect.Effect<never, EvalError> =>
  Effect.fail(
    new EvalError({ code: "invalid_baseline", message, ...(path === undefined ? {} : { path }) })
  )

// A committed record is read by a gate whose summary goes to a CI log, so it
// follows the same control-character rule as a suite name: rejected where it
// enters the system, not flattened later.
const stringField = (value: unknown, field: string, path: string): Effect.Effect<string, EvalError> => {
  if (typeof value !== "string") {
    return fail(`Baseline record field '${field}' must be a string, got ${typeof value}`, path)
  }
  const control = controlCharacter(value)
  return control === undefined
    ? Effect.succeed(value)
    : fail(`Baseline record field '${field}' must not contain the control character ${control}`, path)
}

const decodeRecord = (value: unknown, index: number): Effect.Effect<BaselineRecord, EvalError> =>
  Effect.gen(function*() {
    const at = `records[${index}]`
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return yield* fail(`Baseline record must be an object, got ${value === null ? "null" : typeof value}`, at)
    }
    const source = value as { readonly [key: string]: unknown }
    const rawSuite = source.suite
    const rawCase = source.case
    const rawScorer = source.scorer
    const rawScorerName = source.scorerName
    const rawStepKey = source.stepKey
    const rawScore = source.score
    const suite = yield* stringField(rawSuite, "suite", `${at}.suite`)
    const caseName = yield* stringField(rawCase, "case", `${at}.case`)
    const scorer = yield* stringField(rawScorer, "scorer", `${at}.scorer`)
    const stepKey = yield* stringField(rawStepKey, "stepKey", `${at}.stepKey`)
    const score = rawScore
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      return yield* fail(
        `Baseline record field 'score' must be a finite number in [0, 1], got ${String(score)}`,
        `${at}.score`
      )
    }
    const scorerName = rawScorerName === undefined
      ? undefined
      : yield* stringField(rawScorerName, "scorerName", `${at}.scorerName`)
    // Every record is rebuilt field by field. Keeping the caller's object would
    // carry unknown keys, and any getter among them, straight into a committed
    // artifact.
    return {
      suite,
      case: caseName,
      scorer,
      ...(scorerName === undefined ? {} : { scorerName }),
      stepKey,
      score: Object.is(score, -0) ? 0 : score
    }
  })

const validate = (value: unknown): Effect.Effect<Baseline, EvalError> =>
  Effect.gen(function*() {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return yield* fail("Baseline must be an object")
    }
    const artifact = value as { readonly version?: unknown; readonly suite?: unknown; readonly records?: unknown }
    const rawVersion = artifact.version
    const rawSuite = artifact.suite
    const rawRecords = artifact.records
    if (rawVersion !== version) {
      return yield* fail(`Baseline version must be ${version}, got ${String(rawVersion)}`, "version")
    }
    if (rawSuite !== undefined && typeof rawSuite !== "string") {
      return yield* fail(`Baseline field 'suite' must be a string, got ${typeof rawSuite}`, "suite")
    }
    const suiteControl = rawSuite === undefined ? undefined : controlCharacter(rawSuite)
    if (suiteControl !== undefined) {
      return yield* fail(`Baseline field 'suite' must not contain the control character ${suiteControl}`, "suite")
    }
    if (!Array.isArray(rawRecords)) {
      return yield* fail("Baseline records must be an array", "records")
    }
    const records = yield* Effect.forEach(rawRecords, decodeRecord)
    let suite = rawSuite
    if (suite === undefined) {
      const first = records[0]
      if (first === undefined) {
        return yield* fail("Cannot infer baseline suite: legacy artifact has no records", "suite")
      }
      if (records.some((record) => record.suite !== first.suite)) {
        return yield* fail("Cannot infer baseline suite: legacy records name multiple suites", "suite")
      }
      suite = first.suite
    }
    return { version, suite, records: Object.freeze(records) }
  })

/**
 * Builds and validates a baseline from a run's successful observations.
 *
 * Inconclusive observations are dropped: a baseline records what was measured,
 * and an inconclusive observation measured nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromRun = (run: RunResult): Effect.Effect<Baseline, EvalError> => {
  const records: Array<BaselineRecord> = run.observations.flatMap((observation: Observation) =>
    observation.kind === "score"
      ? [{
        suite: run.suite,
        case: observation.case,
        scorer: observation.scorer,
        ...(observation.scorerName === undefined ? {} : { scorerName: observation.scorerName }),
        stepKey: observation.stepKey,
        score: observation.score
      }]
      : []
  )
  return validate({ version, suite: run.suite, records })
}

/**
 * Validates an in-memory baseline.
 *
 * The result is a snapshot: every known field is read once, then records are
 * rebuilt from those validated values and the array is frozen. Mutating the
 * array or the objects that were passed in cannot change the validated
 * baseline, and a stateful getter cannot substitute a value after validation.
 *
 * Fails with `invalid_baseline` carrying the record index and field name in
 * `path` for a wrong version, a non-array `records`, a record that is not an
 * object, an identity field that is not a string or holds a control
 * character, or a score that is not finite in `[0, 1]`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  baseline: Omit<Baseline, "version"> & { readonly version?: typeof version }
): Effect.Effect<Baseline, EvalError> => {
  const artifactVersion = baseline.version ?? version
  const records = baseline.records
  return validate({ version: artifactVersion, suite: baseline.suite, records })
}

/**
 * Serializes a baseline with recursively sorted keys and stable numbers.
 *
 * Records are ordered by an injective encoding of `(suite, case, scorer,
 * stepKey)`, so two records whose names differ only in where a separator falls
 * still sort apart. The result ends with a newline and never throws: a
 * validated baseline holds only strings and finite numbers.
 *
 * @category serialization
 * @since 0.1.0
 */
export const write = (baseline: Baseline): string => {
  const sortKey = (record: BaselineRecord): string => tupleKey(record.suite, record.case, record.scorer, record.stepKey)
  const records = baseline.records
    .map((record) => [sortKey(record), record] as const)
    .sort(([left], [right]) => CanonicalJson.compareText(left, right))
    .map(([, record]) => record)
  return CanonicalJson.stringify({
    version: baseline.version,
    suite: baseline.suite,
    records
  })
}

/**
 * Loads and validates baseline JSON.
 *
 * A version-1 artifact without a top-level `suite` is accepted only when its
 * nonempty records all name the same suite. That suite becomes the artifact's
 * owner, so writing the result includes it. Empty or ambiguous legacy artifacts
 * fail with `invalid_baseline` at `suite`. Text longer than `limits.length`
 * fails with `invalid_baseline` at `text` before any of it is parsed.
 *
 * @category serialization
 * @since 0.1.0
 */
export const load = (text: string): Effect.Effect<Baseline, EvalError> =>
  text.length > limits.length
    ? fail(`Baseline must be at most ${limits.length} characters, got ${text.length}`, "text")
    : Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => new EvalError({ code: "invalid_baseline", message: "Baseline is not valid JSON", cause })
    }).pipe(Effect.flatMap(validate))
