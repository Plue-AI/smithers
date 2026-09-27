/**
 * Converts the safe subset of zod schemas to `effect/Schema` text.
 *
 * A 0.x task's output schema is a zod object, and the 1.0 target takes an
 * `effect/Schema`. Most of those schemas are plain data declarations that
 * convert deterministically, so the migration should not spend a model call on
 * them, and should not risk one silently changing a field's type.
 *
 * The subset is deliberately narrow. `.passthrough()`, `.refine()`,
 * `.transform()`, `z.discriminatedUnion`, `z.lazy`, and custom error maps carry
 * behavior that a text rewrite cannot preserve, so they are `guided`: the agent
 * rewrites them and records a decision.
 *
 * @since 1.0.0-rc.0
 */

import * as ts from "typescript/unstable/ast"
import type { Detection } from "./Detect.ts"
import * as Sort from "./internal/Sort.ts"
import * as Ts from "./internal/Ts.ts"
import * as Inventory from "./Inventory.ts"

/**
 * Whether a zod chain converts on its own, and why it does not when it does
 * not.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Classification {
  readonly class: "automatic" | "guided"
  readonly reason: string | undefined
}

/**
 * One converted schema declaration.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ZodHint {
  readonly file: string
  readonly name: string
  readonly chain: string
  readonly class: "automatic" | "guided"
  readonly reason: string | undefined
  /** The `effect/Schema` text, when the chain is in the safe subset. */
  readonly schema: string | undefined
}

const unsupportedCalls: ReadonlyArray<{ readonly name: string; readonly reason: string }> = [
  {
    name: "passthrough",
    reason: "`.passthrough()` keeps unknown keys; effect/Schema decides that at the struct level"
  },
  { name: "catchall", reason: "`.catchall()` has no direct struct-level counterpart" },
  { name: "refine", reason: "`.refine()` carries a predicate and a custom message; a check has to be written by hand" },
  { name: "superRefine", reason: "`.superRefine()` carries arbitrary validation logic" },
  { name: "transform", reason: "`.transform()` changes the decoded type; it becomes a transformation schema" },
  { name: "brand", reason: "`.brand()` has no textual equivalent" },
  { name: "pipe", reason: "`.pipe()` composes two schemas and needs a decision about which is the encoded side" },
  { name: "discriminatedUnion", reason: "`z.discriminatedUnion` becomes a tagged union and needs the tag named" },
  { name: "lazy", reason: "`z.lazy` is a recursive schema and needs an explicit type annotation" },
  { name: "intersection", reason: "`z.intersection` has no direct counterpart" },
  { name: "tuple", reason: "`z.tuple` becomes `Schema.Tuple` and needs its element order checked by hand" },
  { name: "map", reason: "`z.map` has no plain counterpart" },
  { name: "set", reason: "`z.set` has no plain counterpart" },
  { name: "promise", reason: "`z.promise` has no counterpart in a decoded schema" },
  { name: "function", reason: "`z.function` is not data" },
  { name: "custom", reason: "`z.custom` carries arbitrary validation logic" },
  { name: "preprocess", reason: "`z.preprocess` changes the encoded side" },
  { name: "coerce", reason: "`z.coerce` changes the encoded side" }
]

/**
 * Classifies one zod chain by its source text.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const classify = (chain: string, parser: typeof Ts.parse = Ts.parse): Classification => {
  for (const { name, reason } of unsupportedCalls) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(chain)) return { class: "guided", reason }
  }
  return print(chain, parser) === undefined
    ? { class: "guided", reason: "the chain uses a zod form outside the safe subset" }
    : { class: "automatic", reason: undefined }
}

const literalText = (node: ts.Node): string | undefined => {
  if (ts.isStringLiteral(node)) return JSON.stringify(node.text)
  if (ts.isNumericLiteral(node)) return node.text
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true"
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false"
  if (node.kind === ts.SyntaxKind.NullKeyword) return "null"
  return undefined
}

const defaultText = (node: ts.Node): string | undefined => {
  const literal = literalText(node)
  if (literal !== undefined) return literal
  if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) return "[]"
  if (ts.isObjectLiteralExpression(node) && node.properties.length === 0) return "{}"
  return undefined
}

/**
 * What a converted chain is, as far as a length or value check needs to know.
 * `min` on a string is a length; `min` on a number is a bound; `min` on a
 * boolean is nothing this printer will guess at.
 */
type Kind = "string" | "number" | "array" | "other"

interface Converted {
  readonly text: string
  readonly kind: Kind
  /** Set when the field is optional in the input because it has a default. */
  readonly decodingDefault: string | undefined
  readonly optional: boolean
  readonly description: string | undefined
}

const plain = (text: string, kind: Kind = "other"): Converted => ({
  text,
  kind,
  decodingDefault: undefined,
  optional: false,
  description: undefined
})

/**
 * A child schema as it can appear inside an array, a union, or a record.
 *
 * A description survives as an annotation. An optional or a default cannot:
 * `z.array(z.string().optional())` admits `undefined` elements and a printed
 * `Schema.Array(Schema.String)` does not, so the chain is refused rather than
 * printed with the metadata dropped.
 */
const nested = (child: Converted): string | undefined => {
  if (child.optional || child.decodingDefault !== undefined) return undefined
  return child.description === undefined ? child.text : `${child.text}.annotate({ description: ${child.description} })`
}

/** The key schemas a record can be printed with: a string, or a closed set of string literals. */
const recordKey = (key: Converted): string | undefined =>
  key.kind === "string" || /^Schema\.Literals?\(/.test(key.text) ? nested(key) : undefined

const convert = (node: ts.Expression): Converted | undefined => {
  // `z.<name>(...)` and `<inner>.<name>(...)` are the only two shapes.
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text
    const receiver = node.expression.expression
    const args = node.arguments

    if (ts.isIdentifier(receiver) && receiver.text === "z") {
      switch (method) {
        case "string":
          return plain("Schema.String", "string")
        case "number":
          return plain("Schema.Number", "number")
        case "boolean":
          return plain("Schema.Boolean")
        case "int":
          return plain("Schema.Int", "number")
        case "unknown":
        case "any":
          return plain("Schema.Unknown")
        case "array": {
          const element = args[0] === undefined ? undefined : convert(args[0])
          const printed = element === undefined ? undefined : nested(element)
          if (printed === undefined) return undefined
          return plain(`Schema.Array(${printed})`, "array")
        }
        case "record": {
          // `z.record(value)` keys by string; `z.record(key, value)` keys by
          // whatever it was given, and only a string or a literal set has a
          // `Schema.Record` key with the same meaning.
          const key = args.length === 2
            ? (args[0] === undefined ? undefined : convert(args[0]))
            : plain("Schema.String", "string")
          const value = args.length === 2
            ? (args[1] === undefined ? undefined : convert(args[1]))
            : args[0] === undefined
            ? undefined
            : convert(args[0])
          const keyText = key === undefined ? undefined : recordKey(key)
          const valueText = value === undefined ? undefined : nested(value)
          if (keyText === undefined || valueText === undefined) return undefined
          return plain(`Schema.Record(${keyText}, ${valueText})`)
        }
        case "literal": {
          const literal = args[0] === undefined ? undefined : literalText(args[0])
          if (literal === undefined) return undefined
          return plain(`Schema.Literal(${literal})`)
        }
        case "enum": {
          const values = args[0]
          if (values === undefined || !ts.isArrayLiteralExpression(values)) return undefined
          const members = values.elements.map(literalText)
          if (members.some((member) => member === undefined)) return undefined
          return plain(`Schema.Literals([${members.join(", ")}])`)
        }
        case "union": {
          const values = args[0]
          if (values === undefined || !ts.isArrayLiteralExpression(values)) return undefined
          const members = values.elements.map((element) => {
            const converted = convert(element)
            return converted === undefined ? undefined : nested(converted)
          })
          if (members.some((member) => member === undefined)) return undefined
          return plain(`Schema.Union([${members.join(", ")}])`)
        }
        case "object": {
          const shape = args[0]
          if (shape === undefined || !ts.isObjectLiteralExpression(shape)) return undefined
          const fields: Array<string> = []
          for (const property of shape.properties) {
            if (!ts.isPropertyAssignment(property)) return undefined
            const key = ts.isIdentifier(property.name)
              ? property.name.text
              : ts.isStringLiteral(property.name)
              ? property.name.text
              : undefined
            if (key === undefined) return undefined
            const value = convert(property.initializer)
            if (value === undefined) return undefined
            let text = value.text
            if (value.description !== undefined) text = `${text}.annotate({ description: ${value.description} })`
            if (value.decodingDefault !== undefined) {
              text = `${text}.pipe(Schema.withDecodingDefaultKey(Effect.succeed(${value.decodingDefault})))`
            } else if (value.optional) {
              text = `Schema.optional(${text})`
            }
            fields.push(`  ${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${text}`)
          }
          return plain(`Schema.Struct({\n${fields.join(",\n")}\n})`)
        }
        default:
          return undefined
      }
    }

    // Method on a converted receiver.
    const inner = convert(receiver)
    if (inner === undefined) return undefined
    switch (method) {
      case "optional":
        return { ...inner, optional: true }
      case "nullable":
        return { ...inner, text: `Schema.NullOr(${inner.text})` }
      case "nullish":
        return { ...inner, text: `Schema.NullOr(${inner.text})`, optional: true }
      case "default": {
        const value = args[0] === undefined ? undefined : defaultText(args[0])
        if (value === undefined) return undefined
        return { ...inner, decodingDefault: value }
      }
      case "describe": {
        const value = args[0] === undefined ? undefined : literalText(args[0])
        if (value === undefined) return undefined
        return { ...inner, description: value }
      }
      case "int":
        return inner.kind === "number"
          ? { ...inner, text: `${inner.text}.pipe(Schema.check(Schema.isInt()))` }
          : undefined
      case "nonnegative":
        return inner.kind === "number"
          ? { ...inner, text: `${inner.text}.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))` }
          : undefined
      case "positive":
        return inner.kind === "number"
          ? { ...inner, text: `${inner.text}.pipe(Schema.check(Schema.isGreaterThan(0)))` }
          : undefined
      case "min":
      case "max": {
        const value = args[0] === undefined ? undefined : literalText(args[0])
        if (value === undefined) return undefined
        // By what the receiver is, not by what its text happens to contain: a
        // string or an array has a length, a number has a bound, and anything
        // else has no `min` this printer can name.
        const check = inner.kind === "string" || inner.kind === "array"
          ? method === "min" ? "isMinLength" : "isMaxLength"
          : inner.kind === "number"
          ? method === "min" ? "isGreaterThanOrEqualTo" : "isLessThanOrEqualTo"
          : undefined
        if (check === undefined) return undefined
        return { ...inner, text: `${inner.text}.pipe(Schema.check(Schema.${check}(${value})))` }
      }
      default:
        return undefined
    }
  }
  return undefined
}

/**
 * The `effect/Schema` text for one zod chain, or `undefined` when the chain is
 * outside the safe subset.
 *
 * The printed text needs `Schema` from `effect/Schema` and, when a field has a
 * default, `Effect` from `effect/Effect` in scope.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const print = (chain: string, parser: typeof Ts.parse = Ts.parse): string | undefined => {
  const value = parse(chain, parser)
  if (value === undefined) return undefined
  // A top-level `.optional()` or `.default()` has no bare-schema spelling:
  // `Schema.optional` is a struct field's, and a decoding default applied at
  // the top changes what the schema accepts. Printing the bare text would
  // drop it while calling the chain automatic, so the chain is refused and
  // stays guided. A description survives as an annotation.
  if (value.optional || value.decodingDefault !== undefined) return undefined
  return value.description === undefined ? value.text : `${value.text}.annotate({ description: ${value.description} })`
}

const parse = (chain: string, parser: typeof Ts.parse): Converted | undefined => {
  const source = parser("chain.ts", `const value = ${chain}`)
  const statement = source.statements[0]
  if (statement === undefined || !ts.isVariableStatement(statement)) return undefined
  const declaration = statement.declarationList.declarations[0]
  if (declaration?.initializer === undefined) return undefined
  return convert(declaration.initializer)
}

/**
 * The `effect/Schema` text for one zod chain as a struct field: the same as
 * {@link print}, with a top-level description, default, or optional applied
 * the way a field carries them. A payload key printed with {@link print}
 * alone would drop the default a step relied on.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const printField = (chain: string, parser: typeof Ts.parse = Ts.parse): string | undefined => {
  const value = parse(chain, parser)
  if (value === undefined) return undefined
  let text = value.text
  if (value.description !== undefined) text = `${text}.annotate({ description: ${value.description} })`
  if (value.decodingDefault !== undefined) {
    text = `${text}.pipe(Schema.withDecodingDefaultKey(Effect.succeed(${value.decodingDefault})))`
  } else if (value.optional) {
    text = `Schema.optional(${text})`
  }
  return text
}

/**
 * Every zod schema declaration in the project's workflow, component, and
 * library files, converted where it can be.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const hints = (detection: Detection, parser: typeof Ts.parse = Ts.parse): ReadonlyArray<ZodHint> => {
  const files = [
    ...detection.workflowFiles.map((workflow) => workflow.path),
    ...detection.components,
    ...detection.libs
  ]
  const seen = new Set<string>()
  const found: Array<ZodHint> = []
  for (const file of files) {
    if (seen.has(file)) continue
    seen.add(file)
    const text = detection.sources.get(file)
    if (text === undefined) continue
    for (const { name, chain } of Inventory.zodChains(file, text, parser)) {
      const classification = classify(chain, parser)
      found.push({
        file,
        name,
        chain,
        class: classification.class,
        reason: classification.reason,
        schema: classification.class === "automatic" ? print(chain, parser) : undefined
      })
    }
  }
  return found.sort((left, right) => Sort.byText(left.file, right.file) || Sort.byText(left.name, right.name))
}
