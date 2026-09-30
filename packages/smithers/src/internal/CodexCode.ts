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
import { Effect, Schema, Stream } from "effect"
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
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

const execute = (
  options: Options,
  request: ModelRequest.ModelRequest
): Effect.Effect<ReadonlyArray<ModelEvent>, ModelError> =>
  Effect.callback((resume) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(options.executable, [...command(options, request)], {
        cwd: options.cwd ?? tmpdir(),
        env: environment(options.environment),
        stdio: "pipe",
        detached: process.platform !== "win32",
        shell: false
      })
    } catch {
      resume(Effect.fail(failure("transport", "Codex could not start")))
      return
    }
    let output = ""
    let stderr = ""
    let bytes = 0
    let settled = false
    const killGroup = () => {
      if (child.pid === undefined) return
      try {
        if (process.platform === "win32") child.kill("SIGKILL")
        else process.kill(-child.pid, "SIGKILL")
      } catch { /* Already exited. */ }
    }
    const kill = () => {
      killGroup()
      child.stdout.destroy()
      child.stderr.destroy()
      child.stdin.destroy()
    }
    const finish = (result: Effect.Effect<ReadonlyArray<ModelEvent>, ModelError>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      kill()
      resume(result)
    }
    const timer = setTimeout(
      () => finish(Effect.fail(failure("call_timeout", "Codex exceeded its call deadline"))),
      options.timeoutMs ?? 30 * 60_000
    )
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8")
      if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) {
        finish(Effect.fail(failure("invalid_provider_output", "Codex exceeded its output limit")))
      } else output += chunk
    })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096)
    })
    // A vendor subprocess may inherit these pipes and outlive its parent.
    child.on("exit", killGroup)
    child.on("error", () => finish(Effect.fail(failure("transport", "Codex could not start"))))
    child.on("close", (code) => {
      if (code !== 0) finish(Effect.fail(failure("transport", `Codex exited ${code}: ${stderr.trim()}`)))
      else {finish(Effect.try({
          try: () => parse(output),
          catch: (error) => error as ModelError
        }))}
    })
    child.stdin.on("error", () => undefined)
    child.stdin.end(prompt(request))
    return Effect.sync(() => {
      settled = true
      clearTimeout(timer)
      kill()
    })
  })

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
