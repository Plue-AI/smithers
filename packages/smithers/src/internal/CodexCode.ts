/**
 * A Codex subscription seat. Only the vendor binary holds and refreshes its login.
 * @since 1.0.0
 */

import type * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Redaction from "@smthrs/journal/Redaction"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Model from "@smthrs/model/Model"
import { isContextOverflow, isQuotaExhausted, ModelError } from "@smthrs/model/ModelError"
import type { ModelEvent } from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Effect, Schema, Stream } from "effect"
import { tmpdir } from "node:os"
import { codexConfigString, codexEnvironment } from "../Agents.ts"

/**
 * @private
 * @since 1.0.0
 */
export interface Options {
  readonly model: string
  readonly executable: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly cwd?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly maxBytes?: number | undefined
}

/**
 * A subscription cannot be silently replaced by an ambient API key or token.
 * @private
 * @since 1.0.0
 */
export const environment = codexEnvironment

const failure = (code: ModelError["code"], message: string) =>
  new ModelError({ code, message: String(Redaction.redactDiagnostic(message)) })

const encode = (request: ModelRequest.ModelRequest) => {
  try {
    const decoded = Schema.decodeUnknownSync(ModelRequest.ModelRequest)(request)
    const validateUnicode = (value: unknown): void => {
      if (typeof value === "string") codexConfigString(value)
      else if (Array.isArray(value)) value.forEach(validateUnicode)
      else if (value !== null && typeof value === "object") Object.values(value).forEach(validateUnicode)
    }
    validateUnicode(decoded)
    return JSON.parse(JSON.stringify(Schema.encodeSync(ModelRequest.ModelRequest)(decoded)))
  } catch (error) {
    throw failure(
      "invalid_request",
      error instanceof RangeError ? error.message : "Model request failed Schema validation"
    )
  }
}

const prompt = (request: ModelRequest.ModelRequest): string =>
  request.messages.map((message) => {
    const text = message.role === "tool"
      ? message.content.map((part) => part.content).join("\n\n")
      : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n")
    return `<${message.role}>\n${text}\n</${message.role}>`
  }).join("\n\n")

/**
 * Fresh invocations carry the complete history; no hidden vendor history affects replay.
 * @private
 * @since 1.0.0
 */
export const command = (options: Options, request: ModelRequest.ModelRequest): ReadonlyArray<string> => [
  "exec",
  "--json",
  "-m",
  options.model,
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "--ephemeral",
  "-s",
  "read-only",
  "-c",
  `developer_instructions=${codexConfigString(request.system.map((part) => part.text).join("\n\n"))}`,
  "-c",
  "features.shell_tool=false",
  "-c",
  "web_search=\"disabled\"",
  "-c",
  "approval_policy=\"never\"",
  // Use the same public MCP entry on local and Cloud installations. No credential is in argv.
  "-c",
  "mcp_servers.smithers={command=\"smthrs\",args=[\"--mcp\"],required=true}",
  ...(request.params.reasoningEffort === undefined
    ? []
    : ["-c", `model_reasoning_effort=${codexConfigString(request.params.reasoningEffort)}`]),
  "-"
]

/**
 * Validate the JSONL receipt before publishing any answer as completed.
 * @private
 * @since 1.0.0
 */
export const parse = (stdout: string): ReadonlyArray<ModelEvent> => {
  let sessionId: string | undefined
  let responseId: string | undefined
  let text: string | undefined
  let usage: Record<string, unknown> | undefined
  let completed = false
  for (const line of stdout.split("\n").filter((line) => line.trim() !== "")) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw failure("invalid_provider_output", "Codex returned invalid JSONL")
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw failure("invalid_provider_output", "Codex returned invalid JSONL")
    }
    const event = value as Record<string, unknown>
    if (typeof event.type !== "string" || event.type === "") {
      throw failure("invalid_provider_output", "Codex returned an invalid event")
    }
    if (completed) throw failure("invalid_provider_output", "Codex emitted events after completion")
    if (event.type === "error" || event.type === "turn.failed") {
      const error = event.error as { message?: unknown } | undefined
      const message = typeof error?.message === "string"
        ? error.message
        : typeof event.message === "string"
        ? event.message
        : "Codex failed"
      throw failure(
        isContextOverflow(undefined, message)
          ? "context_overflow"
          : isQuotaExhausted(undefined, message)
          ? "quota_exceeded"
          : /login|not logged|unauthoriz|401/i.test(message)
          ? "authentication"
          : "provider_internal",
        message
      )
    }
    if (event.type === "thread.started") {
      if (sessionId !== undefined || typeof event.thread_id !== "string" || event.thread_id === "") {
        throw failure("invalid_provider_output", "Codex returned an invalid thread")
      }
      sessionId = event.thread_id
    }
    if (event.type === "item.completed") {
      if (typeof event.item !== "object" || event.item === null || Array.isArray(event.item)) {
        throw failure("invalid_provider_output", "Codex returned an invalid item")
      }
      const item = event.item as Record<string, unknown>
      if (typeof item.type !== "string" || item.type === "") {
        throw failure("invalid_provider_output", "Codex returned an invalid item")
      }
      if (item.type === "agent_message") {
        if (typeof item.text !== "string") throw failure("invalid_provider_output", "Codex returned an invalid answer")
        text = item.text
        responseId = typeof item.id === "string" ? item.id : undefined
      }
    }
    if (event.type === "turn.completed") {
      completed = true
      if (typeof event.usage !== "object" || event.usage === null || Array.isArray(event.usage)) {
        throw failure("invalid_provider_output", "Codex returned invalid usage")
      }
      usage = event.usage as Record<string, unknown>
    }
  }
  if (!completed || sessionId === undefined || text === undefined || usage === undefined) {
    throw failure("invalid_provider_output", "Codex exited without a completed answer")
  }
  const count = (key: string): number => {
    const value = usage[key] ?? 0
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw failure("invalid_provider_output", "Codex returned invalid token usage")
    }
    return value
  }
  const inputTokens = count("input_tokens")
  const outputTokens = count("output_tokens") + count("reasoning_output_tokens")
  const cachedInputTokens = count("cached_input_tokens")
  if (cachedInputTokens > inputTokens || !Number.isSafeInteger(inputTokens + outputTokens)) {
    throw failure("invalid_provider_output", "Codex returned invalid token usage")
  }
  return [
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", text },
    { type: "text-end", id: "text" },
    { type: "usage", inputTokens, outputTokens, cachedInputTokens, totalTokens: inputTokens + outputTokens },
    { type: "settle", stopReason: "stop", sessionId, ...(responseId === undefined ? {} : { responseId }) }
  ]
}

const outputLimit = 16 * 1024 * 1024

// The vendor runs through the platform's contained spawner: a supervisor owns
// its process group, closing the scope (success, failure, deadline or a
// cancelled run) kills that group, and the supervisor stops the tree if this
// host dies. No `node:child_process` launch of its own.
const execute = (
  options: Options,
  request: ModelRequest.ModelRequest
): Effect.Effect<ReadonlyArray<ModelEvent>, ModelError> =>
  Effect.scoped(Effect.gen(function*() {
    const child = yield* ScopedProcess.spawn({
      command: options.executable,
      args: [...command(options, request)],
      cwd: options.cwd ?? tmpdir(),
      env: environment(options.environment),
      stdin: "pipe",
      killSignal: "SIGKILL",
      forceKillAfter: 0,
      windowsHide: true
    }).pipe(Effect.mapError(() => failure("transport", "Codex could not start")))
    const stdout: Array<Uint8Array> = []
    let bytes = 0
    let stderr = ""
    const decoder = new TextDecoder()
    const [status] = yield* Effect.all([
      // A vendor subprocess may inherit these pipes and outlive the vendor, so
      // its exit kills the group rather than waiting for the pipes to close.
      ScopedProcess.status(child).pipe(
        Effect.tap(() => Effect.ignore(child.kill({ killSignal: "SIGKILL", forceKillAfter: 0 })))
      ),
      child.stdout.pipe(
        Stream.runForEach((chunk) =>
          Effect.suspend(() => {
            bytes += chunk.byteLength
            if (bytes > (options.maxBytes ?? outputLimit)) {
              return Effect.fail(failure("invalid_provider_output", "Codex exceeded its output limit"))
            }
            stdout.push(chunk)
            return Effect.void
          })
        )
      ),
      child.stderr.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-4096)
          })
        )
      ),
      // A vendor that closes stdin before reading the prompt still reports
      // its own failure through its exit status.
      Effect.ignore(Stream.run(Stream.make(new TextEncoder().encode(prompt(request))), child.stdin))
    ], { concurrency: "unbounded" }).pipe(
      // The platform's own failure: the supervisor or a pipe was lost mid-call.
      Effect.mapError((error) =>
        error instanceof ModelError ? error : failure("transport", "Codex stopped unexpectedly")
      )
    )
    if (status.code !== 0) {
      return yield* failure("transport", `Codex exited ${status.code ?? status.signal}: ${stderr.trim()}`)
    }
    return yield* Effect.try({
      try: () => parse(Buffer.concat(stdout).toString("utf8")),
      catch: (error) => error as ModelError
    })
  })).pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs ?? 30 * 60_000,
      orElse: () => Effect.fail(failure("call_timeout", "Codex exceeded its call deadline"))
    })
  )

/**
 * @private
 * @since 1.0.0
 */
export const make = (options: Options): Model.Model => {
  // One last answer per conversation; bounded so completed runs do not retain unlimited histories.
  const answers = new Map<string, { readonly request: string; readonly events: ReadonlyArray<ModelEvent> }>()
  return Model.make({
    providerName: "openai",
    stream: (request) =>
      Stream.unwrap(Effect.gen(function*() {
        const canonical = yield* Effect.try({
          try: () => CanonicalJson.stringify(encode(request)),
          catch: (error) => error as ModelError
        })
        if (request.tools.length > 0 || (request.serverTools?.length ?? 0) > 0) {
          return yield* failure(
            "invalid_request",
            "A codex seat offers Smithers tools over MCP, not declared or provider-run tools"
          )
        }
        const known = request.cacheKey === undefined ? undefined : answers.get(request.cacheKey)
        const events = known?.request === canonical ? known.events : yield* execute(options, request)
        if (request.cacheKey !== undefined) {
          answers.delete(request.cacheKey)
          answers.set(request.cacheKey, { request: canonical, events })
          if (answers.size > 64) answers.delete(answers.keys().next().value!)
        }
        return Stream.fromIterable(events)
      }))
  })
}

/**
 * @private
 * @since 1.0.0
 */
export const route = (model: string): FlowEngineLike.RouteResolver => ({
  prepare: (request) =>
    Effect.try({
      try: () => {
        const bodyText = CanonicalJson.stringify(encode(request))
        return {
          routeId: "codex",
          protocolId: "codex",
          method: "POST" as const,
          url: `codex:${model}`,
          publicHeaders: {},
          body: new TextEncoder().encode(bodyText),
          bodyText
        }
      },
      catch: (error) => error as ModelError
    })
})
