/**
 * The app agent's host tools (spec §15.1.3, §15.1.4). A host-owned turn, one
 * whose request offers no tools of its own, runs its tool calls here, on the
 * host, between model legs: the browser executes none of them. A request that
 * offers tools keeps executing them itself, so the two never share a turn.
 *
 * The one host tool today is the `files.read` flow, served from the turn's
 * mirrored main through the producer's source read callback. It is offered
 * only when the grant names a source, which Go grants only when Source is ready
 * for the turn's author; each read is authorized again, as that author.
 *
 * @since 1.0.0-rc.0
 */

import type * as Model from "@smthrs/model/Model"
import type { ModelError } from "@smthrs/model/ModelError"
import { boundToolResult } from "@smthrs/rpc/AgentToolResult"
import { CARD_CONTENT_CAP, fileValue } from "@smthrs/rpc/FileRead"
import type {
  AgentChatMessage,
  AgentToolSpec,
  AgentTurnFrame,
  AgentTurnUsage,
  FetchLike,
  StartAgentTurnRequest
} from "@smthrs/rpc/NativeAgent"
import { Effect } from "effect"
import { z } from "zod"
import type { DurableChatGrant } from "./DurableChatProducer.ts"
import { runModelTurn } from "./ModelTurnHost.ts"
import type { FrameWriter, HeldToolCall, ModelTurnOptions } from "./ModelTurnHost.ts"

/**
 * The most model legs one host-owned turn runs, the browser tool loop's bound.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const MAX_HOST_TOOL_LEGS = 8

/**
 * The producer callback a host tool reads the turn's source through.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const SOURCE_READ_PATH = "/internal/chat/source/read"

/** The flow the source tool runs, as the journal and the conversation name it. */
const FILES_READ = "files.read"

/**
 * `files.read` offered to the model. Provider tool names admit no dot, so the
 * wire name spells the flow with an underscore.
 */
const filesReadTool: AgentToolSpec = {
  type: "function",
  name: "files_read",
  description: "Read one file from this repository's main branch and show it to the person as a File card. " +
    "The path is relative to the repository root, for example src/index.ts.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "The file's path from the repository root." } },
    required: ["path"],
    additionalProperties: false
  }
}

/**
 * Whether the host runs this turn's tool calls: its request offers no tools.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const hostOwned = (request: StartAgentTurnRequest): boolean => (request.tools?.length ?? 0) === 0

/**
 * The tools the host offers a host-owned turn: the source read once the grant
 * names a source.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const hostToolSpecs = (grant: DurableChatGrant): ReadonlyArray<AgentToolSpec> =>
  hostOwned(grant.request) && grant.source !== undefined ? [filesReadTool] : []

const SourceFileSchema = z.object({
  repository: z.string().min(1),
  path: z.string().min(1),
  commit: z.string().min(1),
  content: z.string(),
  binary: z.boolean()
}).strict()

/**
 * One file the producer read from the turn's mirrored main.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type SourceFile = z.infer<typeof SourceFileSchema>

/**
 * A source read's answer: the file, or the refusal code the callback stated.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type SourceAnswer = { readonly file: SourceFile } | { readonly code: string }

/**
 * Reads one path of the turn's source.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type SourceRead = (path: string) => Effect.Effect<SourceAnswer>

/**
 * The source read callback for one producer generation. Its capability is the
 * grant's producer token, so a read ends with the turn.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const sourceReader =
  (callbackBaseUrl: string, grant: DurableChatGrant, fetchImpl: FetchLike): SourceRead => (path) =>
    Effect.tryPromise({
      try: async (signal): Promise<SourceAnswer> => {
        const response = await fetchImpl(new URL(SOURCE_READ_PATH, callbackBaseUrl), {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${grant.token}` },
          body: JSON.stringify({ turnId: grant.turnId, generation: grant.generation, path })
        })
        const body: unknown = await response.json().catch(() => undefined)
        if (response.ok) {
          const parsed = SourceFileSchema.safeParse(body)
          return parsed.success ? { file: parsed.data } : { code: "invalid_answer" }
        }
        const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
          ? body.code
          : `status_${response.status}`
        return { code }
      },
      catch: (): SourceAnswer => ({ code: "unreachable" })
    }).pipe(Effect.catch((answer) => Effect.succeed(answer)))

const MAX_SHOWN_PATH = 200

/** A path as a sentence quotes it: whole when short, its head otherwise. */
const shown = (path: string): string => path.length > MAX_SHOWN_PATH ? `${path.slice(0, MAX_SHOWN_PATH)}…` : path

/** What the model and the conversation are told when a read does not answer a file. */
const refusalText = (path: string, code: string): string => {
  switch (code) {
    case "source_not_ready":
      return "The repository's source isn't ready yet: setup is still mirroring main. Ask again once Source ready shows in setup."
    case "path_refused":
      return `${
        shown(path)
      } is not a path inside this repository. Name a file by its path from the repository root, for example src/index.ts.`
    case "forbidden":
      return "The person who asked can't read this repository."
    case "not_found":
      return `${shown(path)} is not a file on main.`
    case "too_large":
      return `${shown(path)} is larger than the repository read limit, so it is not shown.`
    default:
      return "The repository read did not answer. Ask again."
  }
}

type FileCard = Extract<Extract<AgentTurnFrame, { readonly type: "card" }>["card"], { readonly kind: "file" }>

/** The File card for a read, and the model's bounded copy of what it shows. */
const fileCard = (file: SourceFile, ordinal: number): { readonly card: FileCard; readonly output: string } => {
  const truncated = !file.binary && file.content.length > CARD_CONTENT_CAP
  const payload = {
    repo: file.repository,
    path: file.path,
    content: file.binary ? "" : file.content.slice(0, CARD_CONTENT_CAP),
    truncated,
    ...(file.binary ? { binary: true } : {}),
    address: `/${file.repository}/${file.path}`,
    readAt: { changeId: null, commitId: file.commit, source: "head" as const }
  }
  return {
    card: {
      id: `file-${file.repository}-${file.path}`,
      kind: "file",
      title: `File · ${file.repository} · ${file.path}`,
      status: "active",
      createdAt: Date.now(),
      ordinal,
      payload
    },
    output: boundToolResult(fileValue(file.repository, file.path, payload)).modelOutput
  }
}

/** The single `path` argument of a `files_read` call, or nothing when the call names anything else. */
const pathArgument = (raw: string): string | undefined => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1) {
    return undefined
  }
  return "path" in value && typeof value.path === "string" ? value.path : undefined
}

/**
 * Runs one held tool call on the host and returns what the model reads. The
 * journal records the call, its File card or its refusal; a refusal ends the
 * call, never the turn, so the model can say what happened.
 */
const runHostTool = <E>(
  grant: DurableChatGrant,
  call: HeldToolCall,
  link: number,
  ordinal: number,
  write: FrameWriter<E>,
  read: SourceRead
): Effect.Effect<string, E> =>
  Effect.gen(function*() {
    const runId = grant.request.runId
    const offered = call.name === filesReadTool.name
    yield* write({ runId, type: "call.started", link, ordinal, name: offered ? FILES_READ : call.name })
    const refuse = (message: string, output = `failed: ${message}`) =>
      write({ runId, type: "gate.rejected", link, kind: "call_failed", message }).pipe(Effect.as(output))
    if (!offered) return yield* refuse(`${call.name} is not a tool here.`, `unknown-tool: ${call.name}`)
    const path = pathArgument(call.arguments)
    if (path === undefined) {
      return yield* refuse("files_read takes one argument, {\"path\": \"<path from the repository root>\"}.")
    }
    if (grant.source === undefined) return yield* refuse(refusalText(path, "source_not_ready"))
    const answer = yield* read(path)
    if (!("file" in answer)) return yield* refuse(refusalText(path, answer.code))
    const { card, output } = fileCard(answer.file, ordinal)
    yield* write({ runId, type: "card", card })
    yield* write({ runId, type: "call.settled", link, ordinal, name: FILES_READ, verdict: "run" })
    return output
  })

/**
 * Runs a host-owned turn: each model leg that ends in tool calls has them run
 * on the host, in order, and continues with their results. The last leg's
 * terminal frame states the whole turn's token counts; a turn still calling
 * tools after `MAX_HOST_TOOL_LEGS` legs ends with `tool_limit`.
 *
 * @category runners
 * @since 1.0.0-rc.0
 */
export const runHostTurn = <E>(
  model: Model.Model,
  grant: DurableChatGrant,
  options: ModelTurnOptions,
  write: FrameWriter<E>,
  read: SourceRead
): Effect.Effect<void, Model.ModelFailure | ModelError | E> =>
  Effect.gen(function*() {
    let request: StartAgentTurnRequest = { ...grant.request, tools: hostToolSpecs(grant) }
    let usage: AgentTurnUsage | undefined
    let ordinal = 0
    for (let link = 0;; link += 1) {
      const held = yield* runModelTurn(model, request, options, write, { usage })
      if (held === undefined) return
      usage = held.usage
      // The last leg's calls would have no leg left to read their results.
      if (link + 1 === MAX_HOST_TOOL_LEGS) break
      const results: Array<AgentChatMessage> = []
      for (const call of held.calls) {
        const output = yield* runHostTool(grant, call, link, ordinal, write, read)
        ordinal += 1
        results.push(
          { type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments },
          { type: "function_call_output", call_id: call.id, output }
        )
      }
      request = { ...request, messages: [...request.messages, ...results] }
    }
    yield* write({
      runId: grant.request.runId,
      type: "done",
      reason: "tool_limit",
      ...(usage === undefined ? {} : { usage })
    })
  })
