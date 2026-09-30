/**
 * A Claude subscription seat: the user's own signed-in Claude Code, driven
 * through the Claude Agent SDK, as a {@link Model.Model}.
 *
 * Anthropic lets a Claude subscription sign only Claude Code's own requests,
 * and forbids a third party to collect, store or relay its credentials. So
 * this process holds no Claude credential at all: it starts the `claude`
 * binary, and that binary signs every call. The seat exists only where no
 * `ANTHROPIC_API_KEY` is set (`Providers.claudeCode`); a key keeps Claude
 * seats on the Messages API.
 *
 * Each conversation (`request.cacheKey`) is one long-lived Claude Code session,
 * locked down so Claude Code adds as little as it can: no tools, no MCP
 * servers, settings, plugins or skills of the user's, and the request's system
 * prompt in place of Claude Code's. A frame is one turn. Claude answers in
 * text, a fenced cell like any other seat's reply, and the text passes through
 * unchanged. The next request extends the last by that reply and new messages
 * (the cell's result, the person's steering), and those messages are the next
 * user turn, so Claude reads them with the person's authority, never as tool
 * output. A request identical to the last one is a retry and gets the
 * recorded answer without advancing Claude. Any other request (another
 * process, a compacted window) starts a fresh session with the history
 * flattened into its first message.
 *
 * A request without a `cacheKey` belongs to no conversation, like a
 * compaction summary, and is answered by a session of its own that closes
 * after one turn.
 *
 * Of the generation parameters only `reasoningEffort` reaches Claude Code, as
 * its `effort`. It has no setting for the others, and refusing them would
 * refuse every flow that states one for an API seat, so they are ignored.
 * Provider-run tools and declared tools are refused: Claude Code runs none.
 *
 * @since 1.0.0
 * @private
 */

import * as Sdk from "@anthropic-ai/claude-agent-sdk"
import type * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Model from "@smthrs/model/Model"
import { ModelError, type ModelErrorCode } from "@smthrs/model/ModelError"
import type { ModelEvent, Usage } from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Schema, Stream } from "effect"
import { tmpdir } from "node:os"
import * as Failure from "./Failure.ts"

/**
 * The part of an SDK query this seat drives.
 *
 * @since 1.0.0
 * @private
 */
export interface Query extends AsyncIterable<Sdk.SDKMessage> {
  readonly interrupt: () => Promise<unknown>
  readonly close: () => void
}

/**
 * Starts a Claude Code session: `Sdk.query`, or a test's fake.
 *
 * @since 1.0.0
 * @private
 */
export type Start = (input: {
  readonly prompt: string | AsyncIterable<Sdk.SDKUserMessage>
  readonly options: Sdk.Options
}) => Query

/**
 * @since 1.0.0
 * @private
 */
export interface Options {
  /** The model Claude Code runs. */
  readonly model: string
  /** The installed `claude` binary. */
  readonly executable: string
  /** Claude Code's environment. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** Claude Code's working directory, the system temporary directory by default: it never works in a repository. */
  readonly cwd?: string | undefined
  /**
   * Keeps each session's transcript on disk, so `claude --resume <sessionId>`
   * can open it (the `sessionId` on the `settle` event). Off by default: an
   * unattended seat leaves nothing behind.
   */
  readonly hijackable?: boolean | undefined
  readonly start?: Start | undefined
  /** How long an idle session stays open, one hour by default. */
  readonly idleMillis?: number | undefined
}

const effort: Readonly<Record<ModelRequest.ReasoningEffort, Sdk.EffortLevel>> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
}

const errorCodes: Readonly<Record<Sdk.SDKAssistantMessageError, ModelErrorCode>> = {
  authentication_failed: "authentication",
  oauth_org_not_allowed: "authentication",
  account_on_hold: "authentication",
  verification_required: "authentication",
  cloud_credential_error: "authentication",
  billing_error: "quota_exceeded",
  rate_limit: "rate_limited",
  overloaded: "provider_internal",
  server_error: "provider_internal",
  invalid_request: "invalid_request",
  model_not_found: "invalid_request",
  max_output_tokens: "invalid_provider_output",
  unknown: "unknown"
}

const statusCode = (status: number | undefined): ModelErrorCode =>
  status === 401 || status === 403
    ? "authentication"
    : status === 429
    ? "rate_limited"
    : status === 400
    ? "invalid_request"
    : "provider_internal"

interface Session {
  readonly messages: AsyncIterator<Sdk.SDKMessage>
  /** The model, system prompt and parameters the session was started with. */
  readonly identity: string
  /** The last request's messages, canonical, and the whole request. */
  seen: ReadonlyArray<string>
  last: string
  answer: ReadonlyArray<ModelEvent>
  /** Sends Claude the next user turn. */
  readonly send: (text: string) => void
  /** Stops the idle clock while a turn runs, and restarts it once the session waits. */
  readonly rest: (idle: boolean) => void
  readonly close: () => void
}

type Encoded = typeof ModelRequest.ModelRequest.Encoded

/**
 * The request as plain JSON: decoded first, so a plain object is accepted,
 * and with absent optional fields dropped rather than kept as `undefined`.
 */
const encode = (request: ModelRequest.ModelRequest): Encoded => {
  try {
    const decoded = Schema.decodeUnknownSync(ModelRequest.ModelRequest)(request)
    return JSON.parse(JSON.stringify(Schema.encodeSync(ModelRequest.ModelRequest)(decoded)))
  } catch {
    throw new ModelError({ code: "invalid_request", message: "Model request failed Schema validation" })
  }
}

const textOf = (message: ModelRequest.Message): string =>
  message.role === "tool"
    ? message.content.map((part) => part.content).join("\n\n")
    : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n")

/** One prompt from a history: plain when it is only the user's, labeled by role otherwise. */
const flatten = (messages: ReadonlyArray<ModelRequest.Message>): string =>
  messages.every((message) => message.role === "user")
    ? messages.map(textOf).join("\n\n")
    : messages.map((message) => `<${message.role}>\n${textOf(message)}\n</${message.role}>`).join("\n\n")

/** The messages a request adds after the last one and its reply, when it extends it. */
const extension = (
  seen: ReadonlyArray<string>,
  messages: ReadonlyArray<string>,
  request: ModelRequest.ModelRequest
): ReadonlyArray<ModelRequest.Message> | undefined => {
  if (messages.length < seen.length + 2 || seen.some((message, index) => message !== messages[index])) return undefined
  if (request.messages[seen.length]!.role !== "assistant") return undefined
  const added = request.messages.slice(seen.length + 1)
  return added.some((message) => message.role === "assistant") ? undefined : added
}

const usageOf = (raw: {
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
}): Usage => {
  const read = raw.cache_read_input_tokens ?? undefined
  const written = raw.cache_creation_input_tokens ?? undefined
  const input = raw.input_tokens ?? undefined
  const inputTokens = input === undefined && read === undefined && written === undefined
    ? undefined
    : (input ?? 0) + (read ?? 0) + (written ?? 0)
  const outputTokens = raw.output_tokens ?? undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(read === undefined ? {} : { cachedInputTokens: read }),
    ...(written === undefined ? {} : { cacheWriteTokens: written }),
    ...(inputTokens === undefined && outputTokens === undefined
      ? {}
      : { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) })
  }
}

/** Reads one turn: its text, then its usage and why it stopped, from the turn's result. */
const read = async (messages: AsyncIterator<Sdk.SDKMessage>): Promise<ReadonlyArray<ModelEvent>> => {
  let text = ""
  let responseId: string | undefined
  let failure: ModelError | undefined
  for (;;) {
    const next = await messages.next()
    if (next.done === true) throw new ModelError({ code: "transport", message: "Claude Code exited mid-answer" })
    const message = next.value
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      responseId = message.message.id
      if (message.error !== undefined) {
        failure = new ModelError({ code: errorCodes[message.error], message: `Claude Code: ${message.error}` })
      }
      for (const block of message.message.content) if (block.type === "text") text += block.text
    } else if (message.type === "result") {
      if (failure !== undefined) throw failure
      if (message.subtype !== "success") {
        throw new ModelError({ code: "provider_internal", message: message.errors.join("\n") })
      }
      if (message.is_error) {
        const status = message.api_error_status ?? undefined
        throw new ModelError({
          code: statusCode(status),
          message: message.result,
          ...(status === undefined ? {} : { httpStatus: status })
        })
      }
      return [
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", text },
        { type: "text-end", id: "text" },
        { type: "usage", ...usageOf(message.usage) },
        {
          type: "settle",
          stopReason: message.stop_reason === "max_tokens" ? "length" : "stop",
          ...(responseId === undefined ? {} : { responseId }),
          sessionId: message.session_id
        }
      ]
    }
  }
}

const userTurn = (text: string): Sdk.SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null
})

/**
 * The claude-code seat's {@link Model.Model}. Sessions live in the returned
 * model, one per conversation.
 *
 * @category constructors
 * @since 1.0.0
 * @private
 */
export const make = (options: Options): Model.Model => {
  const start: Start = options.start ?? (({ options, prompt }) => Sdk.query({ prompt, options }))
  const idleMillis = options.idleMillis ?? 60 * 60_000
  const sessions = new Map<string, Session>()

  const locked = (request: ModelRequest.ModelRequest): Sdk.Options => ({
    model: options.model,
    pathToClaudeCodeExecutable: options.executable,
    cwd: options.cwd ?? tmpdir(),
    env: { ...options.environment, CLAUDE_AGENT_SDK_CLIENT_APP: "smithers", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    systemPrompt: { type: "custom", prompt: request.system.map((part) => part.text) },
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    plugins: [],
    skills: [],
    permissionMode: "dontAsk",
    persistSession: options.hijackable === true,
    // A session with no title is named by an extra model call over its first prompt.
    title: "Smithers",
    ...(request.params.reasoningEffort === undefined ? {} : { effort: effort[request.params.reasoningEffort] })
  })

  const open = (key: string, identity: string, request: ModelRequest.ModelRequest): Session => {
    // The streaming input: each user turn is queued until Claude Code reads it.
    const turns: Array<Sdk.SDKUserMessage> = [userTurn(flatten(request.messages))]
    let wake = () => {}
    let closed = false
    const prompt = (async function*(): AsyncGenerator<Sdk.SDKUserMessage> {
      for (;;) {
        while (turns.length > 0) yield turns.shift()!
        if (closed) return
        await new Promise<void>((resolve) => wake = resolve)
      }
    })()
    const query = start({ prompt, options: locked(request) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const session: Session = {
      messages: query[Symbol.asyncIterator](),
      identity,
      seen: [],
      last: "",
      answer: [],
      send: (text) => {
        turns.push(userTurn(text))
        wake()
      },
      rest: (idle) => {
        clearTimeout(timer)
        if (!idle) return
        timer = setTimeout(session.close, idleMillis)
        timer.unref?.()
      },
      close: () => {
        clearTimeout(timer)
        if (sessions.get(key) === session) sessions.delete(key)
        closed = true
        wake()
        // Closing alone can leave a running turn going until the process is
        // gone, so the turn is interrupted first.
        void query.interrupt().catch(() => {}).finally(() => query.close())
      }
    }
    sessions.set(key, session)
    return session
  }

  const conversation = async (
    request: ModelRequest.ModelRequest,
    key: string,
    signal: AbortSignal
  ): Promise<ReadonlyArray<ModelEvent>> => {
    const encoded = encode(request)
    const identity = CanonicalJson.stringify({
      modelId: encoded.modelId,
      system: encoded.system,
      params: encoded.params
    })
    const messages = encoded.messages.map((message) => CanonicalJson.stringify(message))
    const last = CanonicalJson.stringify(encoded)
    const live = sessions.get(key)
    if (live !== undefined && live.last === last) return live.answer
    const added = live === undefined || live.identity !== identity ? undefined : extension(live.seen, messages, request)
    if (added === undefined) live?.close()
    const session = added === undefined ? open(key, identity, request) : live!
    signal.addEventListener("abort", session.close, { once: true })
    session.rest(false)
    try {
      if (added !== undefined) session.send(added.map(textOf).join("\n\n"))
      const answer = await read(session.messages)
      session.seen = messages
      session.last = last
      session.answer = answer
      session.rest(true)
      return answer
    } catch (error) {
      session.close()
      throw error
    } finally {
      signal.removeEventListener("abort", session.close)
    }
  }

  const oneShot = async (request: ModelRequest.ModelRequest, signal: AbortSignal) => {
    const query = start({ prompt: flatten(request.messages), options: { ...locked(request), maxTurns: 1 } })
    const abort = () => void query.interrupt().catch(() => {})
    signal.addEventListener("abort", abort, { once: true })
    try {
      return await read(query[Symbol.asyncIterator]())
    } finally {
      signal.removeEventListener("abort", abort)
      query.close()
    }
  }

  const answer = (request: ModelRequest.ModelRequest, signal: AbortSignal) => {
    if ((request.serverTools?.length ?? 0) > 0 || request.tools.length > 0) {
      throw new ModelError({
        code: "invalid_request",
        message: "A claude-code seat offers no declared or provider-run tools"
      })
    }
    return request.cacheKey === undefined
      ? oneShot(request, signal)
      : conversation(request, request.cacheKey, signal)
  }

  return Model.make({
    providerName: "anthropic",
    stream: (request) =>
      Stream.unwrap(
        Effect.map(
          Effect.tryPromise({
            try: (signal) => answer(request, signal),
            catch: (error) =>
              error instanceof ModelError
                ? error
                : new ModelError({
                  code: "transport",
                  message: `Claude Code failed: ${Failure.operatorSentence(error)}`
                })
          }),
          Stream.fromIterable
        )
      )
  })
}

/**
 * The claude-code seat's sealed-step view of a request: the request itself,
 * canonical, since no wire body exists outside Claude Code.
 *
 * @category constructors
 * @since 1.0.0
 * @private
 */
export const route = (model: string): FlowEngineLike.RouteResolver => ({
  prepare: (request) =>
    Effect.try({
      try: () => {
        const bodyText = CanonicalJson.stringify(encode(request))
        return {
          routeId: "claude-code",
          protocolId: "claude-code",
          method: "POST" as const,
          url: `claude-code:${model}`,
          publicHeaders: {},
          body: new TextEncoder().encode(bodyText),
          bodyText
        }
      },
      catch: (error) =>
        error instanceof ModelError
          ? error
          : new ModelError({ code: "invalid_request", message: "Model request failed Schema validation" })
    })
})
