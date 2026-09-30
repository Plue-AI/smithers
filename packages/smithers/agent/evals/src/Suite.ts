/**
 * Fixed evaluation suite declarations.
 *
 * A suite is the fixed input half of an evaluation: named cases, the scorer
 * bindings that grade them, and the concurrency the runner is allowed. It is
 * validated once and then never changes, because the run that produced a
 * committed baseline has to be reproducible from the suite value that was
 * validated.
 *
 * @since 0.1.0
 */

import type * as ScorerBinding from "@smthrs/scorers/Binding"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EvalError } from "./EvalError.ts"
import { controlCharacter } from "./internal/controlCharacters.ts"

/**
 * A scorer binding accepted from `@smthrs/scorers`.
 *
 * The binding's `appliesTo` flow is matched against an execution's `target` by
 * reference identity, so a binding only ever grades the exact flow value it was
 * declared against.
 *
 * @category models
 * @since 0.1.0
 */
export type Binding = ScorerBinding.Binding

/**
 * One immutable fixed-suite case.
 *
 * `input` is handed to the executor and `expected` is offered to a bound scorer
 * as ground truth. A declared `expected`, including `null`, wins over the
 * binding's `groundTruth`; only an absent one defers to the binding. Both are
 * snapshots taken by {@link make}: mutating the object a caller passed in never
 * changes the suite.
 *
 * @category models
 * @since 0.1.0
 */
export interface Case {
  readonly name: string
  readonly input: unknown
  readonly expected?: unknown | undefined
}

/**
 * Options for constructing a suite.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name: string
  readonly cases: ReadonlyArray<Case>
  readonly bindings?: ReadonlyArray<Binding> | undefined
  readonly concurrency: number
  readonly trials?: number | undefined
}

/**
 * A validated, named collection of fixed cases and scorer bindings.
 *
 * The suite, cases, bindings, and their inert data are deeply frozen snapshots.
 * Executable scorer and target identities remain unchanged.
 *
 * @category models
 * @since 0.1.0
 */
export interface Suite {
  readonly name: string
  readonly cases: ReadonlyArray<Case>
  readonly bindings: ReadonlyArray<Binding>
  readonly concurrency: number
  readonly trials?: number | undefined
}

/**
 * The declared ceilings a suite is validated against.
 *
 * They exist so a mistake fails at construction with a sentence instead of
 * exhausting memory in a runner: `concurrency` bounds the fibers a run may hold
 * open, `cases` bounds one suite, and `fixtureLength` bounds one JSON Lines
 * fixture.
 *
 * @category models
 * @since 0.1.0
 */
export const limits = {
  concurrency: 1024,
  cases: 10_000,
  /** Longest JSON Lines fixture, in UTF-16 code units. */
  fixtureLength: 8 * 1024 * 1024
} as const

const invalid = (message: string, path: string, cause?: unknown): EvalError =>
  new EvalError({ code: "invalid_suite", message, path, ...(cause === undefined ? {} : { cause }) })

const cloneMessage = "Suite data must be structured-cloneable so the suite cannot change after it is validated"

// Validate before structuredClone can erase a prototype or invoke a getter.
// Only records and arrays can be protected completely with Object.freeze.
const validateData = (value: unknown, path: string, seen = new WeakSet<object>()): void => {
  if (typeof value === "function" || typeof value === "symbol") throw invalid(cloneMessage, path)
  if (value === null || typeof value !== "object") return
  if (seen.has(value)) return
  seen.add(value)
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw invalid("Suite data must contain only plain objects, arrays, and structured-cloneable primitives", path)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue
    const childPath = typeof key === "string" && array && /^(0|[1-9]\d*)$/.test(key)
      ? `${path}[${key}]`
      : `${path}.${String(key)}`
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key === "symbol" || !descriptor.enumerable || !("value" in descriptor)) {
      throw invalid("Suite data properties must be enumerable string-keyed data fields", childPath)
    }
    validateData(descriptor.value, childPath, seen)
  }
}

const freezeData = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value === null || typeof value !== "object" || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) freezeData(child, seen)
  return Object.freeze(value)
}

const clone = (value: unknown, path: string): Effect.Effect<unknown, EvalError> =>
  Effect.try({
    try: () => {
      validateData(value, path)
      return freezeData(structuredClone(value))
    },
    catch: (cause) => cause instanceof EvalError ? cause : invalid(cloneMessage, path, cause)
  })

const validate = (options: MakeOptions & { readonly trials: number }): EvalError | undefined => {
  if (options.name.trim().length === 0) return invalid("Suite name must not be empty", "name")
  const nameControl = controlCharacter(options.name)
  if (nameControl !== undefined) {
    return invalid(`Suite name must not contain the control character ${nameControl}`, "name")
  }
  if (!Number.isSafeInteger(options.trials) || options.trials < 1 || options.trials > 1000) {
    return invalid("Suite trials must be an integer from 1 to 1000", "trials")
  }
  if (options.cases.length === 0) return invalid("Suite must contain at least one case", "cases")
  if (options.cases.length > limits.cases) {
    return invalid(`Suite must contain at most ${limits.cases} cases, got ${options.cases.length}`, "cases")
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    return invalid(
      `Suite concurrency must be a positive safe integer, got ${String(options.concurrency)}`,
      "concurrency"
    )
  }
  if (options.concurrency > limits.concurrency) {
    return invalid(
      `Suite concurrency must be at most ${limits.concurrency}, got ${options.concurrency}`,
      "concurrency"
    )
  }
  const names = new Set<string>()
  for (const [index, suiteCase] of options.cases.entries()) {
    if (suiteCase.name.trim().length === 0) {
      return invalid("Suite case name must not be empty", `cases[${index}].name`)
    }
    const caseControl = controlCharacter(suiteCase.name)
    if (caseControl !== undefined) {
      return invalid(
        `Suite case name must not contain the control character ${caseControl}`,
        `cases[${index}].name`
      )
    }
    if (names.has(suiteCase.name)) {
      return invalid(`Duplicate suite case: ${suiteCase.name}`, `cases[${index}].name`)
    }
    names.add(suiteCase.name)
  }
  return undefined
}

// Every field is read exactly once, into these two shapes, before anything is
// validated or copied. Reading a field twice let a getter return the name that
// passed validation and then a different one into the suite, which is the same
// hole a baseline record had.
const readCase = (suiteCase: Case): Case => ({
  name: suiteCase.name,
  input: suiteCase.input,
  expected: suiteCase.expected
})

const readBinding = (binding: Binding): Binding => {
  const read: { -readonly [K in keyof Binding]: Binding[K] } = {
    scorer: binding.scorer,
    appliesTo: binding.appliesTo,
    sampling: binding.sampling
  }
  const groundTruth = binding.groundTruth
  if (groundTruth !== undefined) read.groundTruth = groundTruth
  const context = binding.context
  if (context !== undefined) read.context = context
  return read
}

const copyCase = (suiteCase: Case, index: number): Effect.Effect<Case, EvalError> =>
  Effect.gen(function*() {
    const input = yield* clone(suiteCase.input, `cases[${index}].input`)
    if (suiteCase.expected === undefined) return Object.freeze({ name: suiteCase.name, input })
    const expected = yield* clone(suiteCase.expected, `cases[${index}].expected`)
    return Object.freeze({ name: suiteCase.name, input, expected })
  })

const copyBinding = (binding: Binding, index: number): Effect.Effect<Binding, EvalError> =>
  Effect.gen(function*() {
    // `scorer` and `appliesTo` are executable identities matched by reference,
    // so they are carried over unchanged; sampling, ground truth, and context
    // are inert data that must not remain caller-owned.
    const sampling = binding.sampling === undefined
      ? undefined
      : yield* clone(binding.sampling, `bindings[${index}].sampling`)
    const copied: { -readonly [K in keyof Binding]: Binding[K] } = {
      scorer: binding.scorer,
      appliesTo: binding.appliesTo,
      sampling: sampling as Binding["sampling"]
    }
    if (binding.groundTruth !== undefined) {
      copied.groundTruth = yield* clone(binding.groundTruth, `bindings[${index}].groundTruth`)
    }
    if (binding.context !== undefined) {
      copied.context = yield* clone(binding.context, `bindings[${index}].context`)
    }
    return Object.freeze(copied)
  })

/**
 * Builds and validates a fixed suite.
 *
 * When the effect runs, it reads every option, case field, and binding field
 * exactly once, then validates and copies only what it read. Validating one
 * value and copying another let a getter hand the suite something validation
 * never saw. Every case and binding is then copied, including a binding's
 * sampling policy, so the suite is a snapshot the caller can no longer reach:
 * mutating an array, case input, or ratio policy afterwards leaves the
 * validated suite unchanged. Data is checked before `structuredClone` and
 * deeply frozen afterwards. Only plain objects, arrays, and cloneable
 * primitives are admitted, with enumerable string-keyed data properties.
 * Functions, class instances, mutable built-ins, and accessors fail with
 * `invalid_suite` naming the offending path. Cycles and shared references are
 * supported; null-prototype records become ordinary objects in the clone.
 *
 * Fails with `invalid_suite` for an empty or control-character name, no cases,
 * more than `limits.cases` cases, a duplicate case name, or a concurrency that
 * is not a safe integer in `[1, limits.concurrency]`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Effect.Effect<Suite, EvalError> =>
  Effect.suspend(() => {
    const name = options.name
    const concurrency = options.concurrency
    const cases = [...options.cases].map(readCase)
    const bindings = [...(options.bindings ?? [])].map(readBinding)
    const trials = options.trials ?? 1
    const snapshot = { name, concurrency, cases, bindings, trials }
    const error = validate(snapshot)
    if (error !== undefined) return Effect.fail(error)
    return Effect.gen(function*() {
      const copiedCases = yield* Effect.forEach(cases, copyCase)
      const copiedBindings = yield* Effect.forEach(bindings, copyBinding)
      return Object.freeze({
        name,
        cases: Object.freeze(copiedCases),
        bindings: Object.freeze(copiedBindings),
        concurrency,
        trials
      })
    })
  })

/**
 * Options used when decoding JSON Lines.
 *
 * @category models
 * @since 0.1.0
 */
export interface JsonLinesOptions {
  readonly name: string
  readonly bindings?: ReadonlyArray<Binding> | undefined
  readonly concurrency: number
  readonly trials?: number | undefined
}

const jsonCase = Schema.Struct({
  name: Schema.String,
  input: Schema.Unknown,
  expected: Schema.optional(Schema.Unknown)
})

/**
 * Loads the `{ name, input, expected? }` JSON Lines fixture format.
 *
 * Blank lines are skipped, a leading byte-order mark is stripped, and both LF
 * and CRLF terminate a line. A malformed line fails with `invalid_suite`
 * carrying the 1-based line number in both the message and the path; a fixture
 * larger than `limits.fixtureLength` is rejected before any of it is parsed.
 * The first non-blank line after `limits.cases` cases fails with
 * `invalid_suite` at `cases` before it or any later line is parsed or decoded.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromJsonLines = (text: string, options: JsonLinesOptions): Effect.Effect<Suite, EvalError> =>
  Effect.gen(function*() {
    if (text.length > limits.fixtureLength) {
      return yield* Effect.fail(
        invalid(
          `JSON Lines fixture must be at most ${limits.fixtureLength} characters, got ${text.length}`,
          "text"
        )
      )
    }
    const cases: Array<Case> = []
    const body = text.startsWith("\uFEFF") ? text.slice(1) : text
    for (const [index, line] of body.split(/\r?\n/).entries()) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      // Stop at the ceiling before parsing or decoding the excess line: a
      // fixture under the length limit can still hold hundreds of thousands
      // of tiny lines, and reporting the count only in make() would parse and
      // materialize every one of them first.
      if (cases.length === limits.cases) {
        return yield* Effect.fail(
          invalid(`Suite must contain at most ${limits.cases} cases, got ${cases.length + 1}`, "cases")
        )
      }
      const decoded = yield* Effect.try({
        try: () => JSON.parse(trimmed) as unknown,
        catch: (cause) => invalid(`Invalid JSON on line ${index + 1}`, `line[${index + 1}]`, cause)
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(jsonCase)),
        Effect.mapError((cause) =>
          cause instanceof EvalError
            ? cause
            : invalid(`Invalid suite case on line ${index + 1}`, `line[${index + 1}]`, cause)
        )
      )
      cases.push(decoded)
    }
    return yield* make({ ...options, cases })
  })
