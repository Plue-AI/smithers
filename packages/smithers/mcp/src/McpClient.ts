/**
 * A minimal MCP client covering the `initialize` handshake, `tools/list`, and
 * `tools/call`, over {@link StdioTransport}.
 *
 * This is deliberately not a general MCP SDK. Smithers has exactly one
 * consumer of an MCP session: {@link McpFlows}, which needs a tool catalog
 * and a way to invoke one entry from it, so the client exposes only that.
 * Resources, prompts, sampling, and roots are not wired up; add them here
 * when a flow adapter needs them, not speculatively.
 *
 * @since 1.0.0-rc.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { Effect, Exit, Result, Schema, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as DiagnosticReporter from "./internal/DiagnosticReporter.ts"
import * as JsonLimits from "./internal/JsonLimits.ts"
import * as Limits from "./internal/Limits.ts"
import * as StdioTransport from "./internal/StdioTransport.ts"
import { McpError } from "./McpError.ts"

/**
 * One remote tool as the server describes it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ToolDescription {
  readonly name: string
  readonly description: string | undefined
  /** The tool's parameter shape, as a JSON Schema document with `type: "object"`. */
  readonly inputSchema: Record<string, unknown>
  /** The tool's structured result shape, when the server disclosed one. */
  readonly outputSchema: Record<string, unknown> | undefined
}

/**
 * The result of one `tools/call`.
 *
 * MCP tool content is a small union (text, image, embedded resource, …); this
 * client passes every block through by shape rather than modeling the union,
 * since {@link McpFlows} only needs to hand the blocks back to the caller.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ToolResult {
  readonly content: ReadonlyArray<Record<string, unknown>>
  readonly isError: boolean
  readonly structuredContent: Record<string, unknown> | undefined
}

/**
 * A live MCP session, holding the tool catalog fetched at connect time and a
 * way to call one of its entries.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface McpClient {
  readonly server: string
  readonly tools: ReadonlyArray<ToolDescription>
  /**
   * Calls one catalogued tool. An unknown name fails with `tool_not_found`
   * before a JSON-RPC frame is written. Declared structured output is checked
   * against the supported output-schema subset before it is returned.
   */
  readonly callTool: (name: string, args: Record<string, unknown>) => Effect.Effect<ToolResult, McpError>
}

/**
 * Options accepted by {@link connect}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ConnectOptions extends StdioTransport.ConnectOptions {
  /** The name this server is known by, for flow naming and error messages. */
  readonly server: string
  /** Deadline for each initialize/catalog request. See {@link defaultHandshakeTimeoutMs}. */
  readonly handshakeTimeoutMs?: number | undefined
  /** Maximum tools accepted across every catalog page. See {@link defaultMaxTools}. */
  readonly maxTools?: number | undefined
  /**
   * Maximum UTF-8 bytes in a tool name. Names also cannot be `.` or `..`, or
   * contain `/`, a control or format character (Unicode categories Cc and Cf,
   * which include bidi and zero-width marks), U+2028, U+2029, or a lone
   * surrogate. See {@link defaultMaxToolNameBytes}.
   */
  readonly maxToolNameBytes?: number | undefined
  /**
   * Maximum UTF-8 bytes of one tool's model-facing text: its description plus
   * its JSON-encoded `inputSchema`. See {@link defaultMaxToolDocumentBytes}.
   */
  readonly maxToolDocumentBytes?: number | undefined
  /** Maximum pages walked while fetching the catalog. See {@link defaultMaxCatalogPages}. */
  readonly maxCatalogPages?: number | undefined
}

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * Authoritative decoder for a persisted MCP server entry.
 *
 * The schema requires non-empty server and command names, string arguments,
 * a plain string-valued environment record, and positive-integer limits.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const ConnectOptionsSchema = Schema.Struct({
  server: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.NonEmptyString),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  handshakeTimeoutMs: Schema.optional(PositiveInteger),
  requestTimeoutMs: Schema.optional(PositiveInteger),
  queueCapacity: Schema.optional(PositiveInteger),
  maxFrameBytes: Schema.optional(PositiveInteger),
  maxOutboundFrameBytes: Schema.optional(PositiveInteger),
  maxStderrBytes: Schema.optional(PositiveInteger),
  maxTools: Schema.optional(PositiveInteger),
  maxToolNameBytes: Schema.optional(PositiveInteger),
  maxToolDocumentBytes: Schema.optional(PositiveInteger),
  maxCatalogPages: Schema.optional(PositiveInteger)
})

/**
 * Frozen identity disclosed to every MCP server during initialization.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const clientInfo: { readonly name: string; readonly version: string } = Object.freeze({
  name: "smithers",
  version: "1.0.0-rc.1"
})

/**
 * MCP revisions whose `tools/list` and `tools/call` shapes this client
 * decodes. The frozen list always proposes `2025-06-18` first.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const supportedProtocolVersions: ReadonlyArray<string> = Object.freeze([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
])

/**
 * Default deadline for each MCP handshake request.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultHandshakeTimeoutMs = 10_000

/**
 * Default deadline for each tool request.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultRequestTimeoutMs = StdioTransport.defaultRequestTimeoutMs

/**
 * Default number of outbound frames allowed to wait in memory.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultQueueCapacity = StdioTransport.defaultQueueCapacity

/**
 * Default maximum inbound JSON-RPC frame size.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxFrameBytes = StdioTransport.defaultMaxFrameBytes

/**
 * Default maximum outbound JSON-RPC frame size.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxOutboundFrameBytes = StdioTransport.defaultMaxOutboundFrameBytes

/**
 * Default maximum child-stderr tail retained for connection diagnostics.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxStderrBytes = StdioTransport.defaultMaxStderrBytes

/**
 * Default maximum number of tools in a remote catalog.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxTools = 256

/**
 * Default maximum UTF-8 byte length of one remote tool name.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxToolNameBytes = 128

/**
 * Default maximum UTF-8 bytes of one tool's description plus its JSON-encoded
 * `inputSchema`, the server-authored text a model reads for that tool.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const defaultMaxToolDocumentBytes = 65_536

/**
 * Default maximum number of remote catalog pages.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxCatalogPages = 32

/**
 * Maximum nested JSON containers, including the JSON-RPC envelope. Fixed so
 * accepted server schemas and values remain safe for recursive consumers.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maxJsonDepth = JsonLimits.maxDepth

const invalidResponse = (server: string, message: string): McpError =>
  new McpError({ code: "invalid_response", message, server })

const asInitialize = (server: string, result: unknown): Result.Result<void, McpError> => {
  if (!isRecord(result)) {
    return Result.fail(Limits.protocolError(
      server,
      `MCP server "${server}" returned a malformed initialize result: result is not an object`
    ))
  }
  if (typeof result.protocolVersion !== "string") {
    return Result.fail(Limits.protocolError(
      server,
      `MCP server "${server}" returned a malformed initialize result: protocolVersion is not a string`
    ))
  }
  if (!supportedProtocolVersions.includes(result.protocolVersion)) {
    return Result.fail(Limits.protocolError(
      server,
      `MCP server "${server}" speaks an unsupported protocol version; this client speaks ${
        supportedProtocolVersions.join(", ")
      }`
    ))
  }
  if (!isRecord(result.capabilities)) {
    return Result.fail(Limits.protocolError(
      server,
      `MCP server "${server}" returned a malformed initialize result: capabilities is not an object`
    ))
  }
  if (!Object.hasOwn(result.capabilities, "tools") || !isRecord(result.capabilities.tools)) {
    return Result.fail(Limits.protocolError(
      server,
      `MCP server "${server}" does not serve tools: its initialize result declares no tools capability`
    ))
  }
  return Result.succeed(undefined)
}

type CatalogLimits = {
  readonly maxTools: number
  readonly maxToolNameBytes: number
  readonly maxToolDocumentBytes: number
}

type ToolPage = {
  readonly nextCursor: string | undefined
}

const nameEncoder = new TextEncoder()

// Cc covers C0, DEL, and C1. Cf covers bidi overrides and isolates (U+202A-202E,
// U+2066-2069), zero-width marks (U+200B-200F, U+2060, U+FEFF), and soft hyphen:
// all invisible text that makes `mcp/<server>/<tool>` read as another tool.
// Cs catches a lone surrogate, which UTF-8 encoding would silently replace.
const forbiddenToolNameCharacter = /[/\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u

const isForbiddenToolName = (name: string): boolean =>
  name === "." || name === ".." || forbiddenToolNameCharacter.test(name)

const asToolPage = (
  server: string,
  result: unknown,
  limits: CatalogLimits,
  seen: Set<string>,
  described: Array<ToolDescription>
): Result.Result<ToolPage, McpError> => {
  const tools = isRecord(result) ? result.tools : undefined
  if (!Array.isArray(tools)) {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/list result with no tools array`
    ))
  }
  for (const [index, tool] of tools.entries()) {
    if (described.length >= limits.maxTools) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned more than ${limits.maxTools} tools`
      ))
    }
    if (!isRecord(tool)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned tools[${index}], which is not an object`
      ))
    }
    const record = tool
    if (typeof record.name !== "string" || record.name === "") {
      return Result.fail(invalidResponse(server, `MCP server "${server}" returned tools[${index}] with no name`))
    }
    if (nameEncoder.encode(record.name).byteLength > limits.maxToolNameBytes) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tool name longer than ${limits.maxToolNameBytes} bytes`
      ))
    }
    if (isForbiddenToolName(record.name)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tool name that is "." or "..", or contains "/" or an invisible or control character`
      ))
    }
    if (seen.has(record.name)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a duplicate tool name at catalog index ${index}`
      ))
    }
    if (!isRecord(record.inputSchema) || record.inputSchema.type !== "object") {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tool whose inputSchema is not a JSON Schema object of type "object"`
      ))
    }
    const description = typeof record.description === "string" ? record.description : undefined
    const documentBytes = nameEncoder.encode(description ?? "").byteLength +
      nameEncoder.encode(JSON.stringify(record.inputSchema)).byteLength
    if (documentBytes > limits.maxToolDocumentBytes) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tool description and inputSchema longer than ${limits.maxToolDocumentBytes} bytes`
      ))
    }
    let outputSchema: Record<string, unknown> | undefined
    if (Object.hasOwn(record, "outputSchema")) {
      if (!isRecord(record.outputSchema)) {
        return Result.fail(invalidResponse(
          server,
          `MCP server "${server}" returned a tool whose outputSchema is not a JSON object`
        ))
      }
      outputSchema = record.outputSchema
    }
    seen.add(record.name)
    described.push({
      name: record.name,
      description,
      inputSchema: record.inputSchema,
      outputSchema
    })
  }

  const nextCursor = isRecord(result) && Object.hasOwn(result, "nextCursor") ? result.nextCursor : undefined
  if (nextCursor === undefined) return Result.succeed({ nextCursor: undefined })
  if (typeof nextCursor !== "string" || nextCursor === "") {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/list cursor that is not a non-empty string`
    ))
  }
  return Result.succeed({ nextCursor })
}

// Container guards deliberately inspect only the shape; traversal below owns
// cooperative interruption. Schema.Int excludes unsafe integers, unlike JSON Schema.
const outputTypes = {
  null: Schema.Null,
  boolean: Schema.Boolean,
  object: Schema.declare(isRecord),
  array: Schema.declare(Array.isArray),
  number: Schema.Number,
  string: Schema.String,
  integer: Schema.Number.check(Schema.makeFilter(Number.isInteger))
}

// Every traversal step consumes a slice slot, including enum-key construction.
// Yielding keeps validation interruptible after the transport has completed.
const runJsonWork = <A>(work: Generator<void, A>): Effect.Effect<A> =>
  Effect.gen(function*() {
    while (true) {
      for (let steps = 0; steps < 1_024; steps += 1) {
        const next = work.next()
        if (next.done) return next.value
      }
      yield* Effect.yieldNow
    }
  })

// Keys are canonical JSON: object order is irrelevant, array order is not.
// Inputs here are depth-checked parsed JSON, never caller-owned arguments.
const enumKey = function*(value: unknown): Generator<void, string> {
  yield
  if (Array.isArray(value)) {
    const items: Array<string> = []
    for (const item of value) items.push(yield* enumKey(item))
    return `[${items.join(",")}]`
  }
  if (isRecord(value)) {
    const members: Array<string> = []
    for (const key of Object.keys(value).sort()) {
      members.push(`${JSON.stringify(key)}:${yield* enumKey(value[key])}`)
    }
    return `{${members.join(",")}}`
  }
  return JSON.stringify(value)
}

type OutputValidator = (value: unknown, path: string) => Generator<void, JsonIssue | undefined>

/**
 * Compile the supported output-schema subset once per catalog. Effect Schema
 * owns type unions; this cooperative compatibility traversal retains composite
 * enums, own-property requirements and ignored unsupported keywords. Importing
 * the whole document would enforce constraints this client does not support.
 */
const compileOutputSchema = function*(schema: Record<string, unknown>): Generator<void, OutputValidator> {
  yield
  const types = new Set<keyof typeof outputTypes>()
  for (const candidate of Array.isArray(schema.type) ? schema.type : [schema.type]) {
    yield
    if (typeof candidate === "string" && Object.hasOwn(outputTypes, candidate)) {
      types.add(candidate as keyof typeof outputTypes)
    }
  }
  const accepts = Schema.is(
    types.size === 0 ? Schema.Unknown : Schema.Union([...types].map((type) => outputTypes[type]))
  )
  const typeReason = `expected ${[...types].join(" or ")}`
  let enumIndex: Set<string> | undefined
  if (Array.isArray(schema.enum)) {
    enumIndex = new Set()
    for (const member of schema.enum) enumIndex.add(yield* enumKey(member))
  }
  const required: Array<string> = []
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      yield
      if (typeof key === "string") required.push(key)
    }
  }
  const properties: Array<readonly [string, OutputValidator]> = []
  if (isRecord(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) {
      yield
      if (isRecord(property)) properties.push([key, yield* compileOutputSchema(property)])
    }
  }
  const items = isRecord(schema.items) ? yield* compileOutputSchema(schema.items) : undefined

  return function*(value, path) {
    yield
    if (enumIndex !== undefined && !enumIndex.has(yield* enumKey(value))) {
      return { path, reason: "expected a declared enum value" }
    }
    if (!accepts(value)) return { path, reason: typeReason }
    if (isRecord(value)) {
      for (const key of required) {
        yield
        if (!Object.hasOwn(value, key)) return { path: `${path}.${key}`, reason: "required property is missing" }
      }
      for (const [key, validate] of properties) {
        yield
        if (!Object.hasOwn(value, key)) continue
        const issue = yield* validate(value[key], `${path}.${key}`)
        if (issue !== undefined) return issue
      }
    }
    if (Array.isArray(value) && items !== undefined) {
      for (const [index, item] of value.entries()) {
        const issue = yield* items(item, `${path}[${index}]`)
        if (issue !== undefined) return issue
      }
    }
    return undefined
  }
}

const asToolResult = function*(
  server: string,
  result: unknown,
  outputSchema: Record<string, unknown> | undefined,
  diagnostic: (source: "invalid-response", detail: unknown) => void,
  validate: OutputValidator | undefined
): Generator<void, Result.Result<ToolResult, McpError>> {
  if (!isRecord(result)) {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/call result that is not an object`
    ))
  }
  const hasContent = Object.hasOwn(result, "content")
  const hasStructuredContent = Object.hasOwn(result, "structuredContent")
  if (!hasContent && !hasStructuredContent) {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/call result with no content array`
    ))
  }
  if (hasContent && !Array.isArray(result.content)) {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/call result with no content array`
    ))
  }
  const content: Array<Record<string, unknown>> = []
  const blocks = hasContent ? result.content as Array<unknown> : []
  for (const [index, block] of blocks.entries()) {
    yield
    if (!isRecord(block)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tools/call result whose content[${index}] is not an object`
      ))
    }
    content.push(block)
  }
  if (Object.hasOwn(result, "isError") && typeof result.isError !== "boolean") {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/call result whose isError is not a boolean`
    ))
  }
  let structuredContent: Record<string, unknown> | undefined
  if (hasStructuredContent) {
    if (!isRecord(result.structuredContent)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tools/call result whose structuredContent is not a JSON object`
      ))
    }
    structuredContent = result.structuredContent
    if (validate !== undefined) {
      const issue = yield* validate(structuredContent, "structuredContent")
      if (issue !== undefined) {
        diagnostic("invalid-response", { issue, outputSchema })
        return Result.fail(invalidResponse(
          server,
          `MCP server "${server}" returned structuredContent that its own outputSchema rejects: ${issue.reason}; property path withheld`
        ))
      }
    }
  }
  return Result.succeed({
    content,
    isError: result.isError === true,
    structuredContent
  })
}

interface JsonObject {
  [key: string]: JsonValue
}

type JsonValue = null | boolean | number | string | Array<JsonValue> | JsonObject

type JsonIssue = {
  readonly path: string
  readonly reason: string
}

type JsonPath = string | { readonly parent: JsonPath; key: string | number }

const renderJsonPath = (path: JsonPath): string =>
  typeof path === "string" ?
    path :
    `${renderJsonPath(path.parent)}${typeof path.key === "number" ? `[${path.key}]` : `.${path.key}`}`

const jsonFailure = (path: JsonPath, reason: string): Result.Result<JsonValue, JsonIssue> =>
  Result.fail({ path: renderJsonPath(path), reason })

const reflect = <A>(thunk: () => A): Result.Result<A, string> => {
  try {
    return Result.succeed(thunk())
  } catch {
    return Result.fail("a property that threw when read")
  }
}

const ownDescriptors = (object: object): Result.Result<PropertyDescriptorMap, string> =>
  reflect(() => Object.getOwnPropertyDescriptors(object))

const isAccessor = (descriptor: PropertyDescriptor): boolean =>
  Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set")

type JsonBudget = { remaining: number }

// Lower bounds on encoded size avoid expanding repeated references into an
// enormous tree before the transport's exact UTF-8 frame check. String/key
// UTF-16 length is a lower bound even with escapes and surrogate pairs.
const spendJson = (budget: JsonBudget, bytes: number): boolean => {
  budget.remaining -= bytes
  return budget.remaining >= 0
}

const snapshotJson = (
  value: unknown,
  path: JsonPath,
  ancestors: Set<object>,
  budget: JsonBudget
): Result.Result<JsonValue, JsonIssue> => {
  const bytes = typeof value === "string" ?
    value.length + 2
    : typeof value === "number" || typeof value === "boolean" ?
    String(value).length
    : value === null ?
    4
    : 2
  if (!spendJson(budget, bytes)) return jsonFailure(path, "JSON expansion exceeds the outbound frame budget")
  if (value === null) return Result.succeed(null)
  if (typeof value === "boolean" || typeof value === "string") return Result.succeed(value)
  if (typeof value === "number") {
    return Number.isFinite(value) ? Result.succeed(value) : jsonFailure(path, "a non-finite number")
  }
  if (typeof value === "undefined") return jsonFailure(path, "undefined")
  if (typeof value === "bigint") return jsonFailure(path, "a bigint")
  if (typeof value === "function") return jsonFailure(path, "a function")
  if (typeof value === "symbol") return jsonFailure(path, "a symbol")

  if (ancestors.has(value)) return jsonFailure(path, "a cyclic reference")
  // Arguments live inside the wire envelope and its params object.
  if (ancestors.size + 3 > maxJsonDepth) return jsonFailure(path, `JSON nesting exceeds ${maxJsonDepth} containers`)
  const array = reflect(() => Array.isArray(value))
  if (Result.isFailure(array)) return jsonFailure(path, array.failure)
  if (array.success) {
    const length = reflect(() => (value as Array<unknown>).length)
    if (Result.isFailure(length)) return jsonFailure(path, length.failure)
    if (!Number.isSafeInteger(length.success) || length.success < 0) {
      return jsonFailure(path, "a property that threw when read")
    }
    if (!spendJson(budget, Math.max(0, length.success - 1))) {
      return jsonFailure(path, "JSON expansion exceeds the outbound frame budget")
    }
    const descriptors = ownDescriptors(value)
    if (Result.isFailure(descriptors)) return jsonFailure(path, descriptors.failure)
    ancestors.add(value)
    const copied: Array<JsonValue> = []
    const memberPath: JsonPath = { parent: path, key: 0 }
    for (let index = 0; index < length.success; index += 1) {
      memberPath.key = index
      // Missing slots must not resolve through Object.prototype.
      const descriptor = Object.hasOwn(descriptors.success, index) ? descriptors.success[index] : undefined
      if (descriptor !== undefined && isAccessor(descriptor)) {
        ancestors.delete(value)
        return jsonFailure(memberPath, "an accessor property")
      }
      const member = descriptor === undefined ? undefined : descriptor.value
      const snapshot = snapshotJson(member, memberPath, ancestors, budget)
      if (Result.isFailure(snapshot)) {
        ancestors.delete(value)
        return snapshot
      }
      copied.push(snapshot.success)
    }
    ancestors.delete(value)
    return Result.succeed(copied)
  }

  const object = value as Record<string, unknown>
  const prototype = reflect(() => Object.getPrototypeOf(object))
  if (Result.isFailure(prototype)) return jsonFailure(path, prototype.failure)
  if (prototype.success !== Object.prototype && prototype.success !== null) {
    return jsonFailure(path, "an object with a non-plain prototype")
  }
  const symbols = reflect(() => Object.getOwnPropertySymbols(object))
  if (Result.isFailure(symbols)) return jsonFailure(path, symbols.failure)
  const descriptors = ownDescriptors(object)
  if (Result.isFailure(descriptors)) return jsonFailure(path, descriptors.failure)
  for (const key of symbols.success) {
    if (Object.hasOwn(descriptors.success, key) && descriptors.success[key]!.enumerable) {
      return jsonFailure(path, "a symbol-keyed property")
    }
  }

  ancestors.add(object)
  const copied: JsonObject = {}
  let members = 0
  const memberPath: JsonPath = { parent: path, key: "" }
  for (const key of Object.keys(descriptors.success)) {
    memberPath.key = key
    const descriptor = descriptors.success[key]!
    if (descriptor.enumerable !== true) continue
    if (!spendJson(budget, key.length + 3 + Math.min(1, members++))) {
      ancestors.delete(object)
      return jsonFailure(path, "JSON expansion exceeds the outbound frame budget")
    }
    if (isAccessor(descriptor)) {
      ancestors.delete(object)
      return jsonFailure(memberPath, "an accessor property")
    }
    const snapshot = snapshotJson(descriptor.value, memberPath, ancestors, budget)
    if (Result.isFailure(snapshot)) {
      ancestors.delete(object)
      return snapshot
    }
    Object.defineProperty(copied, key, {
      configurable: true,
      enumerable: true,
      value: snapshot.success,
      writable: true
    })
  }
  ancestors.delete(object)
  return Result.succeed(copied)
}

const snapshotArguments = (
  server: string,
  args: Record<string, unknown>,
  diagnostic: (source: "invalid-arguments", detail: unknown) => void,
  maxBytes: number
): Result.Result<Record<string, unknown>, McpError> => {
  const snapshot = snapshotJson(args, "arguments", new Set(), { remaining: maxBytes })
  if (Result.isFailure(snapshot)) {
    diagnostic("invalid-arguments", snapshot.failure)
    return Result.fail(Limits.protocolError(
      server,
      `MCP server "${server}" was sent a tool argument that is not JSON: ${snapshot.failure.reason}; property path withheld`
    ))
  }
  if (!isRecord(snapshot.success)) {
    return Result.fail(Limits.protocolError(server, `MCP server "${server}" tool arguments must be a JSON object`))
  }
  return Result.succeed(snapshot.success)
}

/**
 * Connects to an MCP server over stdio, completes the `initialize` handshake,
 * and fetches its tool catalog once, up front. Failed or interrupted setup
 * closes its subprocess and I/O fibers before returning to the caller; a
 * successful session stays open until the caller scope closes.
 *
 * The tool catalog is a snapshot: a server that changes its tools after
 * connecting (a `notifications/tools/list_changed` push) is not re-polled.
 * {@link McpFlows} rebuilds by reconnecting to refresh.
 * Catalog input schemas must declare `type: "object"`. A later tool result may
 * omit `content` when it carries `structuredContent`; a declared output schema
 * is enforced for the documented keyword subset.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const connect = (
  options: ConnectOptions
): Effect.Effect<McpClient, McpError, ChildProcessSpawner | Scope.Scope> =>
  Effect.acquireUseRelease(
    Effect.flatMap(Effect.scope, Scope.fork),
    (scope) =>
      Effect.gen(function*() {
        const diagnostic = yield* DiagnosticReporter.make(options.server)
        const decodeResponse = <A>(response: unknown, decoded: Result.Result<A, McpError>) =>
          Effect.fromResult(decoded).pipe(
            Effect.tapError(() => Effect.sync(() => diagnostic("invalid-response", response)))
          )
        const handshakeTimeoutMs = options.handshakeTimeoutMs ?? defaultHandshakeTimeoutMs
        const maxArgumentBytes = options.maxOutboundFrameBytes ?? defaultMaxOutboundFrameBytes
        const maxTools = options.maxTools ?? defaultMaxTools
        const maxToolNameBytes = options.maxToolNameBytes ?? defaultMaxToolNameBytes
        const maxToolDocumentBytes = options.maxToolDocumentBytes ?? defaultMaxToolDocumentBytes
        const maxCatalogPages = options.maxCatalogPages ?? defaultMaxCatalogPages
        yield* Limits.checkPositiveIntegers(options.server, [
          ["handshakeTimeoutMs", handshakeTimeoutMs],
          ["maxTools", maxTools],
          ["maxToolNameBytes", maxToolNameBytes],
          ["maxToolDocumentBytes", maxToolDocumentBytes],
          ["maxCatalogPages", maxCatalogPages]
        ])

        const transport = yield* StdioTransport.connect(options)

        const initialized = yield* transport.request(
          "initialize",
          {
            protocolVersion: supportedProtocolVersions[0],
            capabilities: {},
            clientInfo
          },
          handshakeTimeoutMs
        )
        yield* decodeResponse(initialized, asInitialize(options.server, initialized))
        // A notification, not a request: the server never replies to it, and the
        // handshake is not complete until the client sends it.
        yield* transport.notify("notifications/initialized", undefined, handshakeTimeoutMs)

        const tools: Array<ToolDescription> = []
        const toolNames = new Set<string>()
        const cursors = new Set<string>()
        let params: Record<string, unknown> = {}
        let pageCount = 0
        while (true) {
          const listed = yield* transport.request("tools/list", params, handshakeTimeoutMs)
          pageCount += 1
          const page = yield* decodeResponse(
            listed,
            asToolPage(
              options.server,
              listed,
              { maxTools, maxToolNameBytes, maxToolDocumentBytes },
              toolNames,
              tools
            )
          )
          if (page.nextCursor === undefined) break
          if (cursors.has(page.nextCursor)) {
            diagnostic("invalid-response", listed)
            return yield* Effect.fail(invalidResponse(
              options.server,
              `MCP server "${options.server}" repeated a tools/list cursor`
            ))
          }
          if (pageCount >= maxCatalogPages) {
            return yield* Effect.fail(invalidResponse(
              options.server,
              `MCP server "${options.server}" returned more than ${maxCatalogPages} tools/list pages`
            ))
          }
          cursors.add(page.nextCursor)
          params = { cursor: page.nextCursor }
        }
        JsonLimits.freezeParsed(tools)
        const validators = new Map<string, OutputValidator>()
        for (const tool of tools) {
          if (tool.outputSchema !== undefined) {
            validators.set(tool.name, yield* runJsonWork(compileOutputSchema(tool.outputSchema)))
          }
        }

        const callTool = (name: string, args: Record<string, unknown>): Effect.Effect<ToolResult, McpError> => {
          const tool = tools.find((candidate) => candidate.name === name)
          if (tool === undefined) {
            return Effect.fail(
              new McpError({
                code: "tool_not_found",
                message: `MCP server "${options.server}" has no requested tool`,
                server: options.server
              })
            )
          }
          const snapshot = snapshotArguments(options.server, args, diagnostic, maxArgumentBytes)
          if (Result.isFailure(snapshot)) {
            // Do not inspect the rejected object again: it may contain throwing
            // accessors or proxies. Even diagnostic observers see only the safe
            // rejection, never a second traversal of executable user properties.
            return Effect.fail(snapshot.failure)
          }
          return Effect.flatMap(
            transport.request("tools/call", { name, arguments: snapshot.success }),
            (result) =>
              Effect.flatMap(
                runJsonWork(asToolResult(options.server, result, tool.outputSchema, diagnostic, validators.get(name))),
                (decoded) => decodeResponse(result, decoded)
              )
          )
        }

        return { server: options.server, tools, callTool }
      }).pipe(Scope.provide(scope)),
    // Closing a failed attempt also detaches it from the caller's scope.
    // Successful sessions remain owned by that scope until it closes.
    (scope, exit) => Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void
  )
