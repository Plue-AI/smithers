/**
 * The shared machinery every composition pattern is built from: labelling a
 * pattern flow, refusing a bound it cannot build, and intersecting the effect
 * envelopes of the flows a pattern wraps.
 *
 * The envelope algebra comes straight from `@smthrs/plan/Effects`, the one
 * effect model: a decorator that narrows a wrapped flow's authority here and a
 * `Graph.build` that refuses a widening composition are reading the same
 * declaration through the same rule, not two rules that happen to agree.
 *
 * @since 0.1.0
 */

import * as Graph from "@smthrs/flow/Graph"
import * as Effects from "@smthrs/plan/Effects"
import * as Schema from "effect/Schema"
import { PatternError } from "../PatternError.ts"

/**
 * @since 0.1.0
 * @private
 */
export interface EffectIntersection {
  readonly declaration: Effects.Declaration | undefined
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly mode: boolean
  readonly tier: boolean
}

/**
 * Reads the shared acceptance vocabulary using own properties only.
 *
 * @since 0.1.0
 * @private
 */
export const accepted = (value: unknown): boolean => {
  if (value === true || value === "approved") return true
  if (typeof value !== "object" || value === null) return false
  const record = value as Readonly<Record<string, unknown>>
  return (
    (Object.hasOwn(record, "approved") && record.approved === true) ||
    (Object.hasOwn(record, "accepted") && record.accepted === true)
  )
}

/**
 * Refuses a priority before a pattern sorts, annotates, or runs its member.
 *
 * @since 1.0.0
 * @private
 */
export const safeIntegerPriorityRefusal = (
  pattern: string,
  member: string,
  value: unknown
): PatternError | undefined =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? undefined
    : new PatternError({
      code: "invalid_decorator",
      message: `${pattern} priority for member "${member}" must be a safe integer, received ${value}`
    })

/**
 * Refuses a width bound that is not a positive safe integer.
 *
 * Every pattern that bounds how many members are in flight refuses the same
 * values with the same sentence, so the sentence is stated once and named by
 * the pattern that declared the bound. What counts as "no bound at all"
 * differs per pattern, so each caller answers that before asking: `Panel`
 * reads an absent option and `Quarantine` reads the literal `"unbounded"`.
 *
 * @since 1.0.0
 * @private
 */
export const concurrencyRefusal = (pattern: string, concurrency: number): PatternError | undefined =>
  Number.isSafeInteger(concurrency) && concurrency >= 1 ? undefined : new PatternError({
    code: "invalid_decorator",
    message: `${pattern} concurrency must be a positive safe integer, received ${concurrency}`
  })

/**
 * Refuses a member record a pattern cannot compose because it holds nothing.
 *
 * @since 1.0.0
 * @private
 */
export const nonEmptyMembersRefusal = (
  pattern: string,
  names: ReadonlyArray<string>
): PatternError | undefined =>
  names.length === 0
    ? new PatternError({ code: "invalid_decorator", message: `${pattern} requires at least one member` })
    : undefined

/**
 * Refuses a declared bound whose unrolling can never be built into a plan.
 *
 * A pattern that unrolls a bound sequences `callsPerUnit` calls per unit into
 * a left-nested chain, so the plan nests one level deeper per call.
 * `@smthrs/flow`'s `Graph.build`, the builder that executes these
 * declarations, refuses a plan nested past its exported
 * `Graph.maximumGraphDepth` with a `graph_too_deep` `GraphBuildError` naming
 * the node, which names neither the option nor the pattern that produced it.
 * Refusing at the declaration names both, and reads the same constant the
 * builder does, so the two can never drift apart.
 *
 * The arithmetic: the flow's own root is one level, each of the `value` units
 * nests `callsPerUnit` more, and the value the chain settles with sits one
 * unit below the last one, so the deepest node is
 * `callsPerUnit * (value + 1) + 1`. The largest bound that still builds is the
 * largest `value` keeping that at or under the builder's limit.
 *
 * The limit counts the chain alone. Deeper member flows, or an enclosing
 * pattern that unrolls this one, spend the same budget, so a bound under the
 * limit can still be refused by `Graph.build`.
 *
 * @since 1.0.0
 * @private
 */
export const sequencedBoundRefusal = (
  pattern: string,
  option: string,
  value: number,
  callsPerUnit: number
): PatternError | undefined => {
  const limit = Math.floor((Graph.maximumGraphDepth - 1) / callsPerUnit) - 1
  return value <= limit ? undefined : new PatternError({
    code: "invalid_decorator",
    message: `${pattern} ${option} must be at most ${limit} to stay inside the plan depth limit, received ${value}`
  })
}

const normalized = (values: Iterable<string>): ReadonlyArray<string> => [...new Set(values)].sort()

const intersectPaths = (
  template: ReadonlyArray<string>,
  supplied: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const intersection: Array<string> = []
  for (const expected of template) {
    for (const actual of supplied) {
      if (Effects.covers(expected, actual)) {
        intersection.push(actual)
      } else if (Effects.covers(actual, expected)) {
        intersection.push(expected)
      }
    }
  }
  return normalized(intersection)
}

const tierRank = {
  sealed: 0,
  compensable: 1,
  irreversible: 2
} as const

const tierOf = (declaration: Effects.Declaration): keyof typeof tierRank => declaration.tier ?? "sealed"

/**
 * @since 0.1.0
 * @private
 */
export const intersectEffects = (
  template: Effects.Declaration | undefined,
  supplied: Effects.Declaration | undefined
): EffectIntersection => {
  if (supplied === undefined) {
    return { declaration: undefined, reads: [], writes: [], mode: false, tier: false }
  }
  if (template === undefined) {
    return {
      declaration: undefined,
      reads: supplied.reads,
      writes: supplied.writes,
      mode: supplied.mode === "expected",
      tier: tierOf(supplied) !== "sealed"
    }
  }
  if (Effects.narrow(template, supplied).ok) {
    return { declaration: supplied, reads: [], writes: [], mode: false, tier: false }
  }
  const reads = intersectPaths(template.reads, supplied.reads)
  const writes = intersectPaths(template.writes, supplied.writes)
  const templateTier = tierOf(template)
  const suppliedTier = tierOf(supplied)
  const narrowedTier = tierRank[templateTier] <= tierRank[suppliedTier] ? templateTier : suppliedTier
  const declaration = Effects.make({
    reads,
    writes,
    mode: template.mode === "hermetic" || supplied.mode === "hermetic" ? "hermetic" : "expected",
    onConflict: template.onConflict,
    tier: narrowedTier
  })
  return {
    declaration,
    reads: supplied.reads.filter((path) => !reads.includes(path)),
    writes: supplied.writes.filter((path) => !writes.includes(path)),
    mode: supplied.mode !== declaration.mode,
    tier: suppliedTier !== narrowedTier
  }
}

/**
 * @since 0.1.0
 * @private
 */
export const intersectCapabilities = (
  template: ReadonlyArray<string>,
  supplied: ReadonlyArray<string>
): ReadonlyArray<string> => normalized(supplied.filter((capability) => template.includes(capability)))

const schemaDocument = (schema: Schema.Top): unknown | undefined => {
  try {
    return Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  } catch {
    return undefined
  }
}

const step = (path: string, key: string): string => path === "" ? key : `${path}.${key}`

// The comparison walks JSON Schema documents, whose only containers are
// objects and arrays. Keeping that one-line container guard here is what lets
// the package's dependency footprint small.
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const firstDifference = (expected: unknown, actual: unknown, path: string): string | undefined => {
  if (isRecord(expected) && isRecord(actual)) {
    // JSON objects are unordered, so sorted keys keep compatibility and paths
    // independent of declaration order. JSON Schema arrays encode ordered
    // keywords such as `anyOf` and `enum`, so they stay positional.
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) return step(path, key)
      const difference = firstDifference(expected[key], actual[key], step(path, key))
      if (difference !== undefined) return difference
    }
    return undefined
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return path
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`)
      if (difference !== undefined) return difference
    }
    return undefined
  }
  return Object.is(expected, actual) ? undefined : path
}

const isTop = (schema: Schema.Top): boolean => schema.ast._tag === "Any" || schema.ast._tag === "Unknown"

const isNever = (schema: Schema.Top): boolean => schema.ast._tag === "Never"

type SchemaSide = "input" | "output"

type SchemaCompatibilityIssue =
  | {
    readonly _tag: "IncompatibleSchemas"
    readonly side: SchemaSide
    readonly expectedTag: string
    readonly actualTag: string
    readonly path: string | undefined
  }
  | {
    readonly _tag: "SchemaConversionFailed"
    readonly side: SchemaSide
    readonly schema: "expected" | "actual"
    readonly tag: string
  }

const incompatible = (
  side: SchemaSide,
  expected: Schema.Top,
  actual: Schema.Top,
  path?: string
): SchemaCompatibilityIssue => {
  const expectedTag = expected.ast._tag
  const actualTag = actual.ast._tag
  return {
    _tag: "IncompatibleSchemas",
    side,
    expectedTag,
    actualTag,
    path: expectedTag === actualTag ? path : undefined
  }
}

const compareSchemas = (
  side: SchemaSide,
  expected: Schema.Top,
  actual: Schema.Top
): SchemaCompatibilityIssue | undefined => {
  if (expected === actual) return undefined
  const expectedDocument = schemaDocument(expected)
  if (expectedDocument === undefined) {
    return { _tag: "SchemaConversionFailed", side, schema: "expected", tag: expected.ast._tag }
  }
  const actualDocument = schemaDocument(actual)
  if (actualDocument === undefined) {
    return { _tag: "SchemaConversionFailed", side, schema: "actual", tag: actual.ast._tag }
  }
  const difference = firstDifference(expectedDocument, actualDocument, "")
  return difference === undefined ? undefined : incompatible(side, expected, actual, difference)
}

/**
 * Compares a declared input and output pair against the pair another
 * declaration states, whatever shape the declaration itself has.
 *
 * A `@smthrs/flow` flow states its pair as `payloadSchema`/`successSchema`, so
 * the comparison takes the two schemas rather than the declaration that
 * carries them.
 *
 * @since 1.0.0
 * @private
 */
export const declaredSchemasCompatible = (
  input: Schema.Top,
  output: Schema.Top,
  declared: { readonly input: Schema.Top; readonly output: Schema.Top }
): SchemaCompatibilityIssue | undefined => {
  if (!isNever(input) && !isTop(declared.input)) {
    const inputIssue = isTop(input)
      ? incompatible("input", input, declared.input)
      : compareSchemas("input", input, declared.input)
    if (inputIssue !== undefined) return inputIssue
  }
  if (!isTop(output) && !isNever(declared.output)) {
    return compareSchemas("output", output, declared.output)
  }
  return undefined
}

/**
 * The name and description a pattern's `MakeOptions` may carry.
 *
 * @since 1.0.0
 * @private
 */
export interface Labeled {
  readonly name?: string | undefined
  readonly description?: string | undefined
}

/**
 * @since 1.0.0
 * @private
 */
export interface Label {
  readonly name: string
  readonly description: string | undefined
}

const labelValue = (value: unknown): string => Array.isArray(value) ? value.map(String).join(",") : String(value)

/**
 * Names a pattern flow the way the decorators name theirs: the pattern kind
 * and its declared bounds, `reviewLoop(maxRounds=3)`, unless the caller
 * supplied a `name`. An `undefined` field is left out of the label.
 *
 * @since 1.0.0
 * @private
 */
export const label = (kind: string, fields: Readonly<Record<string, unknown>>, options: Labeled): Label => ({
  name: options.name ?? `${kind}(${
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${labelValue(value)}`)
      .join(", ")
  })`,
  description: options.description
})
