/**
 * Bridges loaded Effect schemas to command-line shaped input.
 *
 * @private
 * @since 0.1.0
 */

import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { z } from "incur"
import { FsError } from "../FsError.ts"
import * as Boundary from "./Boundary.ts"

/**
 * Positional values collected by the agent parser or Incur.
 *
 * @private
 * @since 0.1.0
 */
export type Positional = ReadonlyArray<string> | Readonly<Record<string, unknown>>

/**
 * Input assembled before authoritative Effect schema decoding.
 *
 * @private
 * @since 0.1.0
 */
export interface Assembly {
  readonly value: unknown
}

/**
 * Declarative Incur descriptors plus the authoritative Effect decoder.
 *
 * @private
 * @since 0.1.0
 */
export interface CommandSchema {
  readonly args: z.ZodObject<any> | undefined
  readonly options: z.ZodObject<any> | undefined
  readonly assemble: (args: Positional, options: Readonly<Record<string, unknown>>) => Assembly
  readonly decode: (assembly: Assembly) => Effect.Effect<unknown, FsError>
}

type JsonSchema = Readonly<Record<string, unknown>>

const schemaFailure = (code: "decode_failed" | "encode_failed", method: string): FsError =>
  new FsError({
    code,
    method,
    description: code === "encode_failed"
      ? "The flow output did not satisfy its schema"
      : "The command input did not satisfy the flow schema"
  })

const recoverSchema = <A>(
  effect: Effect.Effect<A, unknown, unknown>,
  code: "decode_failed" | "encode_failed",
  method: string
): Effect.Effect<A, FsError> => (Effect.matchCauseEffect(effect, {
  onFailure: () => Effect.fail(schemaFailure(code, method)),
  onSuccess: Effect.succeed
}) as Effect.Effect<A, FsError>)

const jsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const record = (input: unknown): JsonSchema | undefined =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as JsonSchema
    : undefined

const unsupportedSchema = (): FsError =>
  new FsError({
    code: "unsupported_schema",
    method: "SchemaBridge.toCommandSchema",
    description: "The flow input schema cannot be projected into command input"
  })

const resolveReference = (
  input: unknown,
  definitions: JsonSchema,
  seen = new Set<unknown>()
): JsonSchema => {
  const schema = record(input)
  if (schema === undefined || seen.has(schema)) throw unsupportedSchema()
  if (schema.$ref === undefined) return schema
  const reference = schema.$ref
  if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) throw unsupportedSchema()
  seen.add(schema)
  const name = reference.slice("#/$defs/".length).replace(/~1/g, "/").replace(/~0/g, "~")
  return resolveReference(Object.hasOwn(definitions, name) ? definitions[name] : undefined, definitions, seen)
}

const objectFor = (
  schema: JsonSchema,
  definitions: JsonSchema,
  ancestors: ReadonlySet<JsonSchema>
): z.ZodObject<any> => {
  const properties = record(schema.properties) ?? {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const shape: Record<string, z.ZodType> = Object.create(null) as Record<string, z.ZodType>
  for (const [name, property] of Object.entries(properties)) {
    const field = zodFor(property, definitions, ancestors)
    shape[name] = required.has(name) ? field : field.optional()
  }
  const object = z.object(shape)
  return schema.additionalProperties === false
    ? object.strict()
    : object.catchall(zodFor(schema.additionalProperties ?? true, definitions, ancestors))
}

const zodFor = (
  input: unknown,
  definitions: JsonSchema,
  ancestors: ReadonlySet<JsonSchema> = new Set()
): z.ZodType => {
  if (input === true) return z.unknown()
  if (input === false) return z.never()
  const schema = resolveReference(input, definitions)
  // Recursive definitions cannot be expanded into finite command descriptors.
  // Refuse them here rather than overflowing during discovery.
  if (ancestors.has(schema)) throw unsupportedSchema()
  const next = new Set(ancestors).add(schema)
  const project = (node: unknown): z.ZodType => zodFor(node, definitions, next)
  const variants = schema.anyOf ?? schema.oneOf
  if (Array.isArray(variants)) return z.union(variants.map(project))
  if (Object.hasOwn(schema, "const")) {
    const literal = z.literal(schema.const as string | number | boolean | null)
    return typeof schema.const === "string" ? literal : z.preprocess(jsonValue, literal)
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum
    return values.every((value) => typeof value === "string")
      ? z.enum(values as [string, ...Array<string>])
      : z.union(values.map((value) => project({ const: value })))
  }
  const type = schema.type
  if (Array.isArray(type)) return z.union(type.map((type) => project({ ...schema, type })))
  if (type === "string") return z.string()
  if (type === "integer") return z.preprocess(jsonValue, z.int())
  // `jsonValue` rather than `z.coerce`: coercion turns `""`, `null`, and `[]`
  // into `0`, which would silently invent input for a durable run.
  if (type === "number") return z.preprocess(jsonValue, z.number())
  if (type === "boolean") return z.preprocess(jsonValue, z.boolean())
  if (type === "null") return z.preprocess(jsonValue, z.null())
  if (type === "array") {
    if (Array.isArray(schema.prefixItems)) {
      const items = schema.prefixItems.map((item, index) => {
        const field = project(item)
        return index < Number(schema.minItems ?? 0) ? field : field.optional()
      })
      const tuple = z.tuple(items as [z.ZodType, ...Array<z.ZodType>])
      // Effect omits `items` even for an unconstrained rest. A fixed tuple
      // instead carries `maxItems`, so that bound decides whether to add rest.
      return schema.items === false || Number(schema.maxItems) <= items.length
        ? tuple
        : tuple.rest(project(schema.items ?? true))
    }
    return z.array(project(schema.items ?? true))
  }
  if (type === "object") return z.preprocess(jsonValue, objectFor(schema, definitions, next))
  if (type !== undefined || schema.allOf !== undefined || schema.not !== undefined) throw unsupportedSchema()
  return z.preprocess(jsonValue, z.unknown())
}

const documentOf = (schema: Schema.Top): {
  readonly root: JsonSchema
  readonly definitions: JsonSchema
} => {
  // Objects are advertised closed. Effect's default (`"ignore"`) leaves every
  // struct open, which `objectFor` would project as `catchall(unknown)`; an
  // unknown flag or nested key would then pass the projection and be dropped
  // by the authoritative decoder instead of refused. Index signatures keep
  // their typed `additionalProperties` either way.
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  return {
    root: document.schema,
    definitions: document.definitions
  }
}

const objectDescriptors = (
  root: JsonSchema,
  definitions: JsonSchema
): {
  readonly args: z.ZodObject<any> | undefined
  readonly options: z.ZodObject<any>
} => {
  const options = objectFor(root, definitions, new Set([root]))
  const shape = options.shape
  // Positionals are advertised only when the flow schema really has an `args`
  // field. Mounting one anywhere else would publish a parameter that the strict
  // options object is guaranteed to refuse.
  return {
    args: Object.hasOwn(shape, "args") ? z.object({ args: shape.args! }) : undefined,
    options
  }
}

const positionalRecord = (args: Positional): Readonly<Record<string, unknown>> => {
  if (!Array.isArray(args)) return args as Readonly<Record<string, unknown>>
  return args.length === 0 ? {} : { args }
}

/**
 * Joins positional tokens into the single argument string Markdown flows take.
 *
 * Incur delivers positionals as the record `{ args: ["a", "b"] }`, so the
 * tokens have to be read out of that key rather than off the record's values.
 * Anything that is not a list of strings is returned unchanged so the
 * authoritative `args: string` decode refuses it: `String(value)` would invoke
 * a caller-supplied `toString` and turn `["a", "b"]` into `"a,b"`.
 */
const positionalText = (args: Positional): unknown => {
  const values: unknown = Array.isArray(args) ? args : (args as Readonly<Record<string, unknown>>).args
  if (values === undefined) return ""
  if (!Array.isArray(values)) return values
  return values.every((value) => typeof value === "string") ? values.join(" ") : values
}

/**
 * Merges a scalar command's tokens into the one object its strict schema checks.
 *
 * A scalar flow takes its value from the first positional or the named
 * `input`, and every other token has to reach the strict `{ input }` object so
 * it is refused rather than dropped: a surplus positional is kept under
 * `args`, an unknown flag under its own name, and a positional beside a named
 * input is kept as a second `input` entry under `--input`, because keeping
 * either one alone would silently invoke the flow with half the input. Only
 * `undefined` counts as absent, so an explicit `null` reaches the flow schema,
 * which decides whether it is accepted.
 */
const scalarRecord = (args: Positional, options: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const positional: Readonly<Record<string, unknown>> = Array.isArray(args)
    ? args.length === 0 ? {} : { input: args[0], ...(args.length > 1 ? { args: args.slice(1) } : {}) }
    : args as Readonly<Record<string, unknown>>
  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(positional)) {
    if (value !== undefined) merged[key] = value
  }
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) merged[Object.hasOwn(merged, key) ? `--${key}` : key] = value
  }
  return merged
}

const decodeWith = (
  schema: Schema.Top,
  zodSchema: z.ZodType,
  assembly: Assembly
): Effect.Effect<unknown, FsError> =>
  Effect.suspend(() => {
    const parsed = zodSchema.safeParse(assembly.value)
    if (!parsed.success) return Effect.fail(schemaFailure("decode_failed", "SchemaBridge.decodeInput"))
    return decodeInput(schema, parsed.data)
  })

/**
 * Authoritatively decodes and snapshots one loaded flow input.
 *
 * @private
 * @since 0.1.0
 */
export const decodeInput = (schema: Schema.Top, value: unknown): Effect.Effect<unknown, FsError> =>
  recoverSchema(
    Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<unknown, unknown, unknown>,
    "decode_failed",
    "SchemaBridge.decodeInput"
  ).pipe(
    Effect.flatMap((decoded) => {
      if (decoded === undefined) return Effect.succeed(undefined)
      const admitted = Boundary.admitJson(decoded)
      return admitted.ok
        ? Effect.succeed(admitted.value)
        : Effect.fail(schemaFailure("decode_failed", "SchemaBridge.decodeInput"))
    })
  )

/**
 * Projects a loaded route input schema onto command-line args and options.
 *
 * @private
 * @since 0.1.0
 */
export const toCommandSchema = (
  ref: Descriptor.SchemaRef,
  schema: Schema.Top
): Effect.Effect<CommandSchema, FsError> => {
  if (ref._tag === "MarkdownOutput") {
    return Effect.fail(
      new FsError({
        code: "unsupported_schema",
        method: "SchemaBridge.toCommandSchema",
        description: "An output locator cannot describe command input"
      })
    )
  }
  if (ref._tag === "None") {
    const empty = z.object({}).strict()
    return Effect.succeed(Object.freeze({
      // A schema-free command takes nothing, so it advertises no positionals.
      args: undefined,
      options: empty,
      assemble: (args: Positional, options: Readonly<Record<string, unknown>>) =>
        Object.freeze({ value: { ...positionalRecord(args), ...options } }),
      decode: (assembly: Assembly) =>
        Object.keys(assembly.value as Record<string, unknown>).length === 0
          ? recoverSchema(
            Schema.decodeUnknownEffect(schema)(undefined) as Effect.Effect<unknown, unknown, unknown>,
            "decode_failed",
            "SchemaBridge.decodeInput"
          )
          : Effect.fail(schemaFailure("decode_failed", "SchemaBridge.decodeInput"))
    }))
  }
  if (ref._tag === "MarkdownArgs") {
    const command = z.object({ args: z.string() }).strict()
    return Effect.succeed(Object.freeze({
      args: z.object({ args: z.array(z.string()).optional() }),
      options: z.object({}).strict(),
      assemble: (args: Positional, options: Readonly<Record<string, unknown>>) =>
        Object.freeze({ value: { args: positionalText(args), ...options } }),
      decode: (assembly: Assembly) => decodeWith(schema, command, assembly)
    }))
  }

  return Effect.try({
    try: () => {
      const { definitions, root } = documentOf(schema)
      const resolved = resolveReference(root, definitions)
      if (record(resolved.properties) !== undefined) {
        const descriptors = objectDescriptors(resolved, definitions)
        const command = descriptors.options
        return Object.freeze({
          args: descriptors.args,
          options: descriptors.options,
          assemble: (args: Positional, options: Readonly<Record<string, unknown>>) =>
            Object.freeze({ value: { ...positionalRecord(args), ...options } }),
          decode: (assembly: Assembly) => decodeWith(schema, command, assembly)
        })
      }

      const value = zodFor(resolved, definitions)
      const command = z.object({ input: value }).strict()
      return Object.freeze({
        args: z.object({ input: value.optional() }),
        options: z.object({ input: value.optional() }).strict(),
        assemble: (args: Positional, options: Readonly<Record<string, unknown>>) =>
          Object.freeze({ value: scalarRecord(args, options) }),
        decode: (assembly: Assembly) =>
          Effect.flatMap(
            Effect.suspend(() => {
              const parsed = command.safeParse(assembly.value)
              return parsed.success
                ? Effect.succeed(parsed.data.input)
                : Effect.fail(schemaFailure("decode_failed", "SchemaBridge.decodeInput"))
            }),
            (input) => decodeInput(schema, input)
          )
      })
    },
    catch: unsupportedSchema
  })
}

/**
 * Encodes and snapshots a flow output through its declared schema.
 *
 * @private
 * @since 0.1.0
 */
export const encodeOutput = (schema: Schema.Top, value: unknown): Effect.Effect<unknown, FsError> =>
  recoverSchema(
    Schema.encodeUnknownEffect(schema)(value) as Effect.Effect<unknown, unknown, unknown>,
    "encode_failed",
    "SchemaBridge.encodeOutput"
  ).pipe(
    Effect.flatMap((encoded) => {
      if (encoded === undefined) return Effect.succeed(undefined)
      const admitted = Boundary.admitJson(encoded)
      return admitted.ok
        ? Effect.succeed(admitted.value)
        : Effect.fail(schemaFailure("encode_failed", "SchemaBridge.encodeOutput"))
    })
  )

/**
 * Snapshots programmatic input before any module-loading await.
 *
 * @private
 * @since 0.1.0
 */
export const snapshotInput = (input: unknown): Effect.Effect<Boundary.Json | undefined, FsError> => {
  if (input === undefined) return Effect.succeed(undefined)
  const admitted = Boundary.admitJson(input)
  return admitted.ok
    ? Effect.succeed(admitted.value)
    : Effect.fail(schemaFailure("decode_failed", "SchemaBridge.snapshotInput"))
}
