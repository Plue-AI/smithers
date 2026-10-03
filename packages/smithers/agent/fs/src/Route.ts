/**
 * The immutable metadata projection of a discovered flow, and its lazy loader.
 *
 * @since 0.1.0
 */

import type * as Flow from "@smthrs/core/Flow"
import * as RuntimeFlow from "@smthrs/flow/Flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { fileSpecifier } from "@smthrs/registry/Executable"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { FsError } from "./FsError.ts"
import * as Boundary from "./internal/Boundary.ts"

/**
 * Maximum number of path segments in one route.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumRouteDepth = 64

/**
 * Maximum UTF-16 length of one route segment.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumSegmentLength = 255

/**
 * Maximum UTF-16 length of one slash-joined route name.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumRouteNameLength = 4_096

/**
 * Maximum UTF-16 length of one source or companion path.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumPathLength = 16_384

/**
 * Maximum number of capabilities declared by one route.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumCapabilities = 256

/**
 * How a route's body is stored on disk.
 *
 * @category models
 * @since 0.1.0
 */
export type Kind = "module" | "markdown" | "skill"

/**
 * A path-derived command route.
 *
 * Everything here comes from registry discovery, which never evaluates a flow
 * module. Materializing the flow is {@link load}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Route {
  readonly name: string
  readonly segments: ReadonlyArray<string>
  readonly kind: Kind
  readonly sourcePath: string
  readonly description: Option.Option<string>
  readonly input: Descriptor.SchemaRef
  readonly output: Descriptor.SchemaRef
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Descriptor.EffectDeclaration
  readonly modelInvocable: boolean
  readonly placement: Option.Option<Descriptor.Placement>
  readonly ui: Option.Option<string>
}

/**
 * Generated applications augment this map with route-specific input and output
 * types from the loaded schemas (Schema.Type, not Schema.Encoded).
 *
 * @example
 * ```ts
 * declare module "@smthrs/fs/Route" {
 *   interface Manifest {
 *     review: { readonly input: { readonly title: string }; readonly output: string }
 *   }
 * }
 * ```
 *
 * @category models
 * @since 0.1.0
 */
// Declaration merging intentionally starts from an empty manifest.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Manifest {}

/**
 * A route name, narrowed to generated manifest keys when one is available.
 *
 * @category models
 * @since 0.1.0
 */
export type Name = keyof Manifest extends never ? string : Extract<keyof Manifest, string>

/**
 * The decoded input accepted by Command.call for a named route.
 *
 * @category models
 * @since 0.1.0
 */
export type Input<N extends Name> = N extends keyof Manifest
  ? Manifest[N] extends { readonly input: infer I } ? I : unknown
  : unknown

/**
 * The decoded output returned by Command.call for a named route.
 *
 * @category models
 * @since 0.1.0
 */
export type Output<N extends Name> = N extends keyof Manifest
  ? Manifest[N] extends { readonly output: infer O } ? O : unknown
  : unknown

const invalidRoute = (path: string, description = "Route metadata violates the command contract"): FsError =>
  new FsError({ code: "invalid_route", method: "Route.snapshot", description, path })

const text = (
  value: unknown,
  options: { readonly path: string; readonly maximum: number; readonly empty?: boolean | undefined }
): string => {
  if (
    typeof value !== "string" || (options.empty !== true && value.length === 0) ||
    value.length > options.maximum || value.includes("\0") || !Boundary.isWellFormedText(value)
  ) throw invalidRoute(options.path)
  return value
}

const fields = (
  value: unknown,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): Readonly<Record<string, unknown>> => {
  const admitted = Boundary.inspectRecord(value, required, optional)
  if (!admitted.ok) throw invalidRoute(admitted.path)
  return admitted.value
}

const schemaFields = (
  input: unknown,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): Readonly<Record<string, unknown>> => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalidRoute("$")
    const prototype = Object.getPrototypeOf(input)
    const known = input instanceof Descriptor.SchemaRefMarkdownArgs ||
      input instanceof Descriptor.SchemaRefMarkdownOutput ||
      input instanceof Descriptor.SchemaRefNone ||
      input instanceof Descriptor.SchemaRefModule ||
      input instanceof Descriptor.SchemaRefInline
    if (!known && prototype !== Object.prototype && prototype !== null) throw invalidRoute("$")
    const allowed = new Set([...required, ...optional])
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => typeof key === "symbol" || !allowed.has(key))) throw invalidRoute("$")
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of required) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw invalidRoute(`$.${key}`)
      output[key] = descriptor.value
    }
    for (const key of optional) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor === undefined) continue
      if (!("value" in descriptor) || !descriptor.enumerable) throw invalidRoute(`$.${key}`)
      output[key] = descriptor.value
    }
    return Object.freeze(output)
  } catch (cause) {
    if (cause instanceof FsError) throw cause
    throw invalidRoute("$")
  }
}

const optionText = (
  input: unknown,
  path: string,
  maximum: number
): Option.Option<string> => {
  try {
    if (!Option.isOption(input)) throw invalidRoute(path)
    if (Option.isNone(input)) return Option.none()
    return Option.some(text(input.value, { path, maximum }))
  } catch (cause) {
    if (cause instanceof FsError) throw cause
    throw invalidRoute(path)
  }
}

const optionPlacement = (input: unknown): Option.Option<Descriptor.Placement> => {
  try {
    if (!Option.isOption(input)) throw invalidRoute("$.placement")
    if (Option.isNone(input)) return Option.none()
    const placement = input.value
    if (placement !== "client" && placement !== "local" && placement !== "sandbox" && placement !== "remote") {
      throw invalidRoute("$.placement")
    }
    return Option.some(placement)
  } catch (cause) {
    if (cause instanceof FsError) throw cause
    throw invalidRoute("$.placement")
  }
}

const schemaRef = (input: unknown, path: string): Descriptor.SchemaRef => {
  const tagged = schemaFields(input, ["_tag"], ["path", "field", "document"])
  switch (tagged._tag) {
    case "MarkdownArgs":
      return new Descriptor.SchemaRefMarkdownArgs({})
    case "MarkdownOutput":
      return new Descriptor.SchemaRefMarkdownOutput({})
    case "None":
      return new Descriptor.SchemaRefNone({})
    case "Module": {
      const source = text(tagged.path, { path: `${path}.path`, maximum: maximumPathLength })
      if (tagged.field !== "input" && tagged.field !== "output") throw invalidRoute(`${path}.field`)
      return new Descriptor.SchemaRefModule({ path: source, field: tagged.field })
    }
    case "Inline": {
      const admitted = Boundary.admitJson(tagged.document)
      if (!admitted.ok) throw invalidRoute(`${path}.document${admitted.path.slice(1)}`)
      return new Descriptor.SchemaRefInline({ document: admitted.value })
    }
    default:
      throw invalidRoute(`${path}._tag`)
  }
}

const effectDeclaration = (input: unknown): Descriptor.EffectDeclaration => {
  const data = fields(input, ["reads", "writes", "mode", "onConflict", "tier"])
  const reads = Boundary.stringArray(data.reads, {
    maxItems: maximumCapabilities,
    maxLength: maximumPathLength
  })
  const writes = Boundary.stringArray(data.writes, {
    maxItems: maximumCapabilities,
    maxLength: maximumPathLength
  })
  if (!reads.ok) throw invalidRoute(`$.effects.reads${reads.path.slice(1)}`)
  if (!writes.ok) throw invalidRoute(`$.effects.writes${writes.path.slice(1)}`)
  if (data.mode !== "hermetic" && data.mode !== "expected") throw invalidRoute("$.effects.mode")
  if (data.onConflict !== "serialize" && data.onConflict !== "lane" && data.onConflict !== "fail") {
    throw invalidRoute("$.effects.onConflict")
  }
  if (data.tier !== "sealed" && data.tier !== "compensable" && data.tier !== "irreversible") {
    throw invalidRoute("$.effects.tier")
  }
  return Object.freeze({
    reads: reads.value,
    writes: writes.value,
    mode: data.mode,
    onConflict: data.onConflict,
    tier: data.tier
  })
}

const isAbsolutePath = (value: string): boolean =>
  value.startsWith("file:///") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)

/**
 * Copies and validates caller-owned route metadata before asynchronous use.
 *
 * @category constructors
 * @since 0.1.0
 */
export const snapshot = (input: Route): Effect.Effect<Route, FsError> =>
  Effect.try({
    try: () => {
      const data = fields(input, [
        "name",
        "segments",
        "kind",
        "sourcePath",
        "description",
        "input",
        "output",
        "capabilities",
        "effects",
        "modelInvocable",
        "placement",
        "ui"
      ])
      const segments = Boundary.stringArray(data.segments, {
        maxItems: maximumRouteDepth,
        maxLength: maximumSegmentLength
      })
      if (
        !segments.ok || segments.value.length === 0 ||
        segments.value.some((segment) => segment === "." || segment === ".." || segment.includes("/"))
      ) {
        throw invalidRoute(segments.ok ? "$.segments" : `$.segments${segments.path.slice(1)}`)
      }
      // A directory name arrives decomposed on macOS and composed from a
      // browser or an agent, so one canonical form decides route identity.
      const normalized = Object.freeze(segments.value.map((segment) => segment.normalize("NFC")))
      const name = text(data.name, { path: "$.name", maximum: maximumRouteNameLength }).normalize("NFC")
      if (name !== normalized.join("/")) {
        throw invalidRoute("$.name", "Route name must equal its slash-joined segments")
      }
      if (data.kind !== "module" && data.kind !== "markdown" && data.kind !== "skill") throw invalidRoute("$.kind")
      const sourcePath = text(data.sourcePath, { path: "$.sourcePath", maximum: maximumPathLength })
      if (!isAbsolutePath(sourcePath)) throw invalidRoute("$.sourcePath", "Route source paths must be absolute")
      const capabilities = Boundary.stringArray(data.capabilities, {
        maxItems: maximumCapabilities,
        maxLength: maximumPathLength
      })
      if (!capabilities.ok) throw invalidRoute(`$.capabilities${capabilities.path.slice(1)}`)
      if (typeof data.modelInvocable !== "boolean") throw invalidRoute("$.modelInvocable")

      return Object.freeze({
        name,
        segments: normalized,
        kind: data.kind,
        sourcePath,
        description: optionText(data.description, "$.description", maximumPathLength),
        input: schemaRef(data.input, "$.input"),
        output: schemaRef(data.output, "$.output"),
        capabilities: capabilities.value,
        effects: effectDeclaration(data.effects),
        modelInvocable: data.modelInvocable,
        placement: optionPlacement(data.placement),
        ui: optionText(data.ui, "$.ui", maximumPathLength)
      })
    },
    // Every reflective helper above catches foreign throws and normalizes them.
    catch: (cause) => cause as FsError
  })

/**
 * True only for routes the agent and Incur command surfaces may execute.
 *
 * @category guards
 * @since 0.1.0
 */
export const isCommandRoute = (route: Route): boolean => route.kind === "module" && route.modelInvocable

const loadFailed = (description: string): FsError =>
  new FsError({
    code: "load_failed",
    method: "Route.load",
    description
  })

const importFailed = (): FsError => loadFailed("The selected flow module could not be imported")

const exportMissing = (): FsError => loadFailed("The selected flow module has no default flow export")

/**
 * Materializes the flow behind a route.
 *
 * Only module routes can be materialized here. Markdown and skill bodies are
 * registry inputs, not executable commands in this private adapter.
 *
 * @category constructors
 * @since 0.1.0
 */
export const load = (
  input: Route
): Effect.Effect<(Pick<Flow.Any, "name" | "input" | "output"> & Partial<Pick<Flow.Any, "description">>), FsError> =>
  Effect.gen(function*() {
    const route = yield* snapshot(input)
    if (route.kind !== "module") {
      return yield* Effect.fail(
        new FsError({
          code: "unsupported_body",
          method: "Route.load",
          description: "Only module routes are executable"
        })
      )
    }
    const module = yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ fileSpecifier(route.sourcePath)) as Promise<{ readonly default?: unknown }>,
      catch: importFailed
    })
    if (RuntimeFlow.isFlow(module.default)) {
      return {
        name: module.default._tag,
        description: module.default.description,
        input: module.default.payloadSchema,
        output: module.default.successSchema
      }
    }
    if (
      typeof module.default !== "object" || module.default === null ||
      !("input" in module.default) || !Schema.isSchema(module.default.input) ||
      !("output" in module.default) || !Schema.isSchema(module.default.output)
    ) return yield* Effect.fail(exportMissing())
    return module.default as (Pick<Flow.Any, "name" | "input" | "output"> & Partial<Pick<Flow.Any, "description">>)
  })
