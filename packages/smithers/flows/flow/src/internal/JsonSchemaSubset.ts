/**
 * The bounded JSON Schema subset a human-task answer is checked against.
 *
 * `HumanTask` asks a person for a value and refuses one that does not fit the
 * question. The fit for a `json` question is decided here: a schema is kept
 * inside a deliberately small subset, an answer is checked against it under
 * the same size bounds every human-task value is admitted under, and every
 * rejection is rendered within one diagnostic budget. `HumanTask` re-exports
 * the limits and the two public entry points; this file is the mechanism.
 *
 * @since 1.0.0
 */

import * as BoundedJson from "./BoundedJson.ts"

/**
 * The deepest supported JSON Schema path, counting the root as depth zero.
 *
 * @private
 * @since 1.0.0
 */
export const maxSchemaDepth = 32

/**
 * The most schema objects one human-task request may contain.
 *
 * @private
 * @since 1.0.0
 */
export const maxSchemaNodes = 512

/**
 * The most JSON values embedded across schema keywords such as `enum`.
 *
 * @private
 * @since 1.0.0
 */
export const maxSchemaValueNodes = 10_000

/**
 * The deepest JSON value embedded in a schema, including enum members.
 *
 * @private
 * @since 1.0.0
 */
export const maxSchemaValueDepth = 64

/**
 * The most JSON values one answer validation may visit.
 *
 * @private
 * @since 1.0.0
 */
export const maxAnswerNodes = 10_000

/**
 * The largest encoded JSON answer that can enter the durable store.
 *
 * @private
 * @since 1.0.0
 */
export const maxAnswerBytes = 256 * 1024

/**
 * The largest encoded JSON Schema carried by one question.
 *
 * @private
 * @since 1.0.0
 */
export const maxSchemaBytes = 256 * 1024

/**
 * The deepest admitted answer tree.
 *
 * @private
 * @since 1.0.0
 */
export const maxAnswerDepth = 64

/**
 * The largest encoded string value admitted in a request or answer.
 *
 * @private
 * @since 1.0.0
 */
export const maxJsonStringBytes = 128 * 1024

/**
 * The largest encoded object key admitted in a request or answer.
 *
 * @private
 * @since 1.0.0
 */
export const maxJsonKeyBytes = 4 * 1024

/**
 * The most members admitted in one JSON array or object.
 *
 * @private
 * @since 1.0.0
 */
export const maxJsonMembers = 10_000

/**
 * The most caller-supplied characters retained in one rendered diagnostic.
 *
 * @private
 * @since 1.0.0
 */
export const maxDiagnosticChars = 512

/** The JSON Schema types the bounded subset understands. */
const supportedTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])

/** The JSON Schema keywords the bounded subset understands. */
const supportedKeywords = [
  "type",
  "enum",
  "properties",
  "required",
  "items",
  "nullable",
  "description",
  "title"
]

/** Truncates a caller-supplied diagnostic while stating exactly what was dropped.
 * @private
 * @since 1.0.0
 */
export const truncateDiagnostic = (rendered: string): string => {
  const prefix = BoundedJson.scalarPrefix(rendered, maxDiagnosticChars)
  return prefix.length === rendered.length
    ? prefix
    : `${prefix} [${rendered.length - prefix.length} characters dropped]`
}

/** Renders one JSON value for a bounded rejection message.
 * @private
 * @since 1.0.0
 */
export const renderDiagnostic = (value: unknown): string => BoundedJson.render(value, maxDiagnosticChars)

/**
 * Renders a value list in its comma-separated diagnostic shape.
 *
 * Every member renders to at least one character, so members past the
 * diagnostic budget can never survive truncation and are not rendered at all.
 */
const renderDiagnosticList = (values: ReadonlyArray<unknown>): string =>
  truncateDiagnostic(
    values.slice(0, maxDiagnosticChars).map((value) => BoundedJson.render(value, maxDiagnosticChars)).join(", ")
  )

/** Renders a JSON pointer-ish path for a rejection message. */
const at = (path: ReadonlyArray<string>): string =>
  path.length === 0 ? "the answer" : `"${truncateDiagnostic(path.join("."))}"`

/** Whether a value is a plain JSON object rather than an array or a null. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Compares two JSON values structurally without depending on object key order. */
const jsonEquals = (left: unknown, right: unknown): boolean => {
  const pending: Array<readonly [unknown, unknown]> = [[left, right]]
  while (pending.length > 0) {
    const [a, b] = pending.pop()!
    if (a === b) continue
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false
      for (let index = a.length - 1; index >= 0; index--) pending.push([a[index], b[index]])
      continue
    }
    if (!isObject(a) || !isObject(b)) return false
    const aKeys = Object.keys(a).sort()
    const bKeys = Object.keys(b).sort()
    if (aKeys.length !== bKeys.length) return false
    for (let index = aKeys.length - 1; index >= 0; index--) {
      const aKey = aKeys[index]!
      const bKey = bKeys[index]!
      if (aKey !== bKey) return false
      pending.push([a[aKey], b[bKey]])
    }
  }
  return true
}

/** The bounds one answer is admitted under.
 * @private
 * @since 1.0.0
 */
export const answerLimits: BoundedJson.Limits = {
  maxNodes: maxAnswerNodes,
  maxDepth: maxAnswerDepth,
  maxBytes: maxAnswerBytes,
  maxStringBytes: maxJsonStringBytes,
  maxKeyBytes: maxJsonKeyBytes,
  maxMembers: maxJsonMembers
}

/** The bounds one schema is admitted under, enum members included.
 * @private
 * @since 1.0.0
 */
export const schemaLimits: BoundedJson.Limits = {
  maxNodes: maxSchemaValueNodes,
  maxDepth: maxSchemaValueDepth,
  maxBytes: maxSchemaBytes,
  maxStringBytes: maxJsonStringBytes,
  maxKeyBytes: maxJsonKeyBytes,
  maxMembers: maxJsonMembers
}

/**
 * Checks a value against the bounded JSON Schema subset, returning the first
 * reason it does not fit.
 *
 * The subset is `type` (`object`, `array`, `string`, `number`, `integer`,
 * `boolean`, `null`), `enum`, `properties`, `required`, `items`, and
 * `nullable`. It is deliberately small: a human-task schema exists to say what
 * shape an answer takes, and every keyword beyond these describes a constraint
 * a person cannot be usefully re-asked about. A schema that reaches outside it
 * is refused as `request_invalid` rather than silently ignored, because a
 * quietly dropped constraint reads as a validation that passed.
 *
 * Presence is `Object.hasOwn`, never the `in` operator. An answer is a decoded
 * JSON object, so every property it really has is its own; `in` also reports
 * `Object.prototype`'s members, which would accept a missing required
 * `toString` and check a `constructor` nobody answered against the schema for
 * one.
 *
 * @private
 */
const checkAt = (
  value: unknown,
  schema: Record<string, unknown>,
  path: ReadonlyArray<string>
): string | undefined => {
  const nullable = schema["nullable"] === true
  const enumeration = schema["enum"]
  if (enumeration !== undefined) {
    const matches = (enumeration as ReadonlyArray<unknown>).some((allowed) => jsonEquals(allowed, value))
    if (!matches) return `${at(path)} must be one of ${renderDiagnosticList(enumeration as ReadonlyArray<unknown>)}.`
  }
  const type = schema["type"]
  if (!(nullable && value === null) && type !== undefined) {
    const typeComplaint = type === "object"
      ? isObject(value) ? undefined : `${at(path)} must be an object.`
      : type === "array"
      ? Array.isArray(value) ? undefined : `${at(path)} must be an array.`
      : type === "integer"
      ? Number.isInteger(value) ? undefined : `${at(path)} must be an integer.`
      : type === "number"
      // Bounded JSON admission already rejected every non-finite number.
      ? typeof value === "number" ? undefined : `${at(path)} must be a number.`
      : type === "string"
      ? typeof value === "string" ? undefined : `${at(path)} must be a string.`
      : type === "boolean"
      ? typeof value === "boolean" ? undefined : `${at(path)} must be a boolean.`
      : value === null
      ? undefined
      : `${at(path)} must be null.`
    if (typeComplaint !== undefined) return typeComplaint
  }

  // Object and array keywords are independent constraints. JSON Schema does
  // not require a sibling `type`; they apply whenever the instance has the
  // relevant shape and are otherwise ignored.
  if (isObject(value)) {
    const required = schema["required"]
    if (Array.isArray(required)) {
      const missing = required.find((key) => !Object.hasOwn(value, key as string))
      if (missing !== undefined) {
        return `${at(path)} is missing the required property "${truncateDiagnostic(String(missing))}".`
      }
    }
    const properties = schema["properties"]
    if (isObject(properties)) {
      for (const [key, property] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key)) continue
        const rejection = checkAt(value[key], property as Record<string, unknown>, [...path, key])
        if (rejection !== undefined) return rejection
      }
    }
  }
  if (Array.isArray(value)) {
    const items = schema["items"]
    if (items !== undefined) {
      for (const [index, element] of value.entries()) {
        const rejection = checkAt(element, items as Record<string, unknown>, [...path, String(index)])
        if (rejection !== undefined) return rejection
      }
    }
  }
  return undefined
}

/** Checks schema validity and snapshots both inputs before walking them together.
 * @private
 * @since 1.0.0
 */
export const check = (value: unknown, schema: unknown): string | undefined => {
  const admittedSchema = BoundedJson.admit(schema, schemaLimits)
  if (!admittedSchema.ok) return admittedSchema.complaint
  const schemaComplaint = validateSchemaAt(admittedSchema.value, [], 0, { visited: 0 })
  if (schemaComplaint !== undefined) return schemaComplaint
  const admittedAnswer = BoundedJson.admit(value, answerLimits)
  if (!admittedAnswer.ok) return admittedAnswer.complaint
  return checkAt(admittedAnswer.value, admittedSchema.value as Record<string, unknown>, [])
}

interface SchemaBudget {
  visited: number
}

/** Walks one schema node under a shared depth and node budget. */
const validateSchemaAt = (
  schema: unknown,
  path: ReadonlyArray<string>,
  depth: number,
  budget: SchemaBudget
): string | undefined => {
  if (depth > maxSchemaDepth) {
    return `${at(path)} exceeds the maximum JSON Schema depth of ${maxSchemaDepth}.`
  }
  budget.visited++
  if (budget.visited > maxSchemaNodes) {
    return `${at(path)} exceeds the maximum JSON Schema node count of ${maxSchemaNodes}.`
  }
  if (!isObject(schema)) return `${at(path)} is described by something that is not a JSON Schema object.`
  const unsupported = Object.keys(schema).find((keyword) => !supportedKeywords.includes(keyword))
  if (unsupported !== undefined) {
    return `${at(path)} uses the unsupported JSON Schema keyword "${truncateDiagnostic(unsupported)}".`
  }
  const enumeration = schema["enum"]
  if (enumeration !== undefined && !Array.isArray(enumeration)) {
    return `${at(path)} declares an "enum" that is not an array.`
  }
  if (Array.isArray(enumeration) && enumeration.length === 0) {
    return `${at(path)} declares an empty "enum".`
  }
  if (Object.hasOwn(schema, "required")) {
    const required = schema["required"]
    if (!Array.isArray(required)) return `${at([...path, "required"])} is not an array.`
    const invalid = required.findIndex((key) => typeof key !== "string")
    if (invalid !== -1) return `${at([...path, "required", String(invalid)])} is not a string.`
    if (new Set(required).size !== required.length) {
      return `${at([...path, "required"])} contains a duplicate property name.`
    }
  }
  if (Object.hasOwn(schema, "nullable") && typeof schema["nullable"] !== "boolean") {
    return `${at([...path, "nullable"])} is not a boolean.`
  }
  const type = schema["type"]
  if (type !== undefined && (typeof type !== "string" || !supportedTypes.has(type))) {
    return `${at(path)} declares the unsupported JSON Schema type ${renderDiagnostic(type)}.`
  }
  for (const keyword of ["description", "title"] as const) {
    if (Object.hasOwn(schema, keyword) && typeof schema[keyword] !== "string") {
      return `${at([...path, keyword])} is not a string.`
    }
  }
  const properties = schema["properties"]
  if (properties !== undefined) {
    if (!isObject(properties)) return `${at(path)} declares "properties" that is not an object.`
    for (const [key, property] of Object.entries(properties)) {
      const complaint = validateSchemaAt(property, [...path, key], depth + 1, budget)
      if (complaint !== undefined) return complaint
    }
  }
  const items = schema["items"]
  return items === undefined ? undefined : validateSchemaAt(items, [...path, "items"], depth + 1, budget)
}

/**
 * Checks that a JSON Schema stays inside the bounded subset, at every depth.
 *
 * Returns the first reason the schema is out of bounds, or `undefined` when the
 * whole tree is inside it.
 *
 * @private
 * @since 1.0.0
 */
export const validateSchema = (
  schema: unknown,
  path: ReadonlyArray<string>
): string | undefined => {
  const admitted = BoundedJson.admit(schema, schemaLimits)
  return admitted.ok
    ? validateSchemaAt(admitted.value, path, 0, { visited: 0 })
    : admitted.complaint
}
