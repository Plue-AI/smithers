/**
 * A flow's inline form, derived from its payload schema; and the `/flow`
 * argument grammar.
 *
 * Port of the schema-only half of apps/app/src/mainview/flows/FlowForms.ts; a
 * second adapter, extract when a third appears.
 */
import { Schema, type SchemaAST } from "effect"

export interface Field {
  readonly name: string
  readonly label: string
  readonly kind: "text" | "number" | "boolean" | "select"
  readonly required: boolean
  readonly options?: ReadonlyArray<Value>
}
export type Value = string | number | boolean
export type Draft = Readonly<Record<string, Value>>

/** "runId" → "Run id". */
export const humanize = (name: string): string => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `Schema.optional(S)` is `Union([S, Undefined])` marked optional: the control is S's. */
const unwrapOptional = (ast: SchemaAST.AST): { readonly ast: SchemaAST.AST; readonly optional: boolean } => {
  const optional = ast.context?.isOptional === true
  if (ast._tag === "Union") {
    const rest = ast.types.filter((member) => member._tag !== "Undefined")
    if (rest.length === 1 && rest[0] !== undefined) {
      return { ast: rest[0], optional: optional || rest.length < ast.types.length }
    }
  }
  return { ast, optional }
}

const control = (ast: SchemaAST.AST): Pick<Field, "kind" | "options"> => {
  const numeric = (node: SchemaAST.AST): boolean =>
    node._tag === "Number" ||
    (node._tag === "Literal" && ["Infinity", "-Infinity", "NaN"].includes(String(node.literal))) ||
    (node._tag === "Union" && node.types.every(numeric))
  if (
    ast._tag === "Number" || (ast._tag === "Union" && ast.types.some((type) => type._tag === "Number") && numeric(ast))
  ) {
    return { kind: "number" }
  }
  if (ast._tag === "Boolean") return { kind: "boolean" }
  if (ast._tag === "Literal") return { kind: "select", options: [ast.literal as Value] }
  if (ast._tag === "Union" && ast.types.length > 0 && ast.types.every((member) => member._tag === "Literal")) {
    return { kind: "select", options: ast.types.map((member) => member.literal as Value) }
  }
  return { kind: "text" }
}

/** One field per property of the payload struct, in schema order. */
export const fields = (schema: Schema.Top): Array<Field> => {
  const ast = schema.ast
  if (ast._tag !== "Objects") return []
  return ast.propertySignatures.map((signature) => {
    const name = String(signature.name)
    const { ast: inner, optional } = unwrapOptional(signature.type)
    return { name, label: humanize(name), required: !optional, ...control(inner) }
  })
}

const coerce = (field: Field, value: unknown): Value | undefined => {
  if (value === undefined || value === null) return undefined
  if (field.kind === "select") {
    return field.options?.find((option) => option === value) ??
      field.options?.find((option) => String(option) === String(value))
  }
  if (field.kind === "number") {
    const number = typeof value === "number" ? value : Number(String(value).trim())
    return Number.isFinite(number) && String(value).trim() !== "" ? number : undefined
  }
  if (field.kind === "boolean") {
    return typeof value === "boolean" ? value : ["true", "on", "yes", "1"].includes(String(value).trim().toLowerCase())
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}

/** The form's starting values: each given field coerced to its control; a required boolean starts false. */
export const draft = (list: ReadonlyArray<Field>, given: Readonly<Record<string, unknown>>): Record<string, Value> => {
  const result: Record<string, Value> = {}
  for (const field of list) {
    const value = coerce(field, given[field.name] ?? (field.kind === "boolean" && field.required ? false : undefined))
    if (value !== undefined) result[field.name] = value
  }
  return result
}

/** The labels of required fields the draft leaves blank, in schema order. */
export const missing = (list: ReadonlyArray<Field>, values: Draft): Array<string> =>
  list.filter((field) => {
    const value = values[field.name]
    return field.required && field.kind !== "boolean" &&
      (value === undefined || (typeof value === "string" && value.trim() === ""))
  }).map((field) => field.label)

/** The filled form as the flow's payload: fields the form cannot show keep their given values. */
export const payload = (
  schema: Schema.Top,
  list: ReadonlyArray<Field>,
  given: Readonly<Record<string, unknown>>,
  values: Draft
): { readonly payload: Record<string, unknown> } | { readonly error: string } => {
  const blank = missing(list, values)
  if (blank.length > 0) return { error: `Needs: ${blank.join(", ")}` }
  const shown = new Set(list.map((field) => field.name))
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(given).filter(([name]) => !shown.has(name)))
  const properties = schema.ast._tag === "Objects"
    ? new Map(
      schema.ast.propertySignatures.map((signature) => [String(signature.name), unwrapOptional(signature.type).ast])
    )
    : new Map<string, SchemaAST.AST>()
  for (const field of list) {
    const value = values[field.name]
    if (value === undefined || (typeof value === "string" && value.trim() === "" && !field.required)) continue
    const tag = properties.get(field.name)?._tag
    if (field.kind === "number" && typeof value === "string") {
      const number = Number(value.trim())
      if (!Number.isFinite(number)) return { error: `${field.label}: not a number` }
      result[field.name] = number
    } else if (typeof value === "string" && (tag === "Objects" || tag === "Arrays")) {
      try {
        result[field.name] = JSON.parse(value)
      } catch {
        return { error: `${field.label}: invalid JSON` }
      }
    } else result[field.name] = value
  }
  return { payload: result }
}

/**
 * `/flow <name>` arguments, as `smthrs up` reads them: a JSON object, other
 * JSON as `{data}`, or `key=value` tokens where a bare token is `true`.
 */
export const parseArgs = (
  text: string
): { readonly input: Record<string, unknown> } | { readonly error: string } => {
  const trimmed = text.trim()
  if (trimmed === "") return { input: {} }
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
    try {
      const decoded = JSON.parse(trimmed) as unknown
      return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
        ? { input: decoded as Record<string, unknown> }
        : { input: { data: decoded } }
    } catch {
      return { error: "Invalid JSON" }
    }
  }
  const tokens: Array<string> = []
  let token = ""
  let quote: "'" | "\"" | undefined
  let started = false
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index]!
    if (character === "\\" && quote !== "'") {
      const next = trimmed[index + 1]
      if (next === undefined) return { error: "Trailing escape" }
      // Preserve ordinary path backslashes; only syntax needs escaping.
      if (next === "\\" || next === "\"" || next === "'" || /\s/.test(next)) {
        token += next
        index++
      } else token += character
      started = true
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined
      else token += character
    } else if (character === "\"" || character === "'") {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) tokens.push(token)
      token = ""
      started = false
    } else {
      token += character
      started = true
    }
  }
  if (quote !== undefined) return { error: "Unclosed quote" }
  if (started) tokens.push(token)
  return {
    input: Object.fromEntries(tokens.map((token) => {
      const separator = token.indexOf("=")
      return separator < 1 ? [token, true] : [token.slice(0, separator), token.slice(separator + 1)]
    }))
  }
}

export const valid = (schema: Schema.Top, value: unknown): boolean => Schema.is(schema)(value)
