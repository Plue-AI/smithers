/**
 * The app agent's tools on the host (spec §15.1.3, §15.1.4). A host-owned
 * turn, one whose request offers no tools of its own, is offered the app
 * agent's one tool, `commands`, and the host runs its calls between model
 * legs: the browser executes none of them. A request that offers tools keeps
 * executing them itself, so the two never share a turn.
 *
 * The one command the host runs today is the `files.read` flow, bound to the
 * turn's mirrored main through the producer's source read callback. The tool
 * is offered only when the grant names a source, which Go grants only when
 * the credential that admitted the turn can read it; each read is authorized
 * again, as that credential.
 *
 * @since 1.0.0-rc.0
 */

import type * as Model from "@smthrs/model/Model"
import type { ModelError } from "@smthrs/model/ModelError"
import {
  commandsToolSpec,
  decodeCommandsCall,
  unknownCommandResult,
  unknownToolResult
} from "@smthrs/rpc/AgentCommands"
import { boundToolResult, MAX_TOOL_LEGS } from "@smthrs/rpc/AgentToolResult"
import { fileReadCard, FILES_READ, FILES_READ_COPY, parseFileReadArgs } from "@smthrs/rpc/FileRead"
import type {
  AgentChatMessage,
  AgentToolSpec,
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
 * The producer callback a host tool reads the turn's source through.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const SOURCE_READ_PATH = "/internal/chat/source/read"

/** The commands this host runs, as the list action answers them. */
const hostCommands = [{ name: FILES_READ, ...FILES_READ_COPY }] as const

/**
 * Whether the host runs this turn's tool calls: its request offers no tools.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const hostOwned = (request: StartAgentTurnRequest): boolean => (request.tools?.length ?? 0) === 0

/**
 * The tools the host offers a host-owned turn: the app agent's one tool, once
 * the grant names a source for its commands to read.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const hostToolSpecs = (grant: DurableChatGrant): ReadonlyArray<AgentToolSpec> =>
  hostOwned(grant.request) && grant.source !== undefined ? [commandsToolSpec] : []

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

/**
 * Runs one `files.read` on the turn's mirrored main. The journal records the
 * call and its File card, or its refusal; a refusal ends the call, never the
 * turn, so the model can say what happened.
 */
const readFile = <E>(
  grant: DurableChatGrant,
  source: { readonly repository: string },
  args: string | undefined,
  link: number,
  ordinal: number,
  write: FrameWriter<E>,
  read: SourceRead
): Effect.Effect<string, E> =>
  Effect.gen(function*() {
    const runId = grant.request.runId
    yield* write({ runId, type: "call.started", link, ordinal, name: FILES_READ })
    const refuse = (message: string) =>
      write({ runId, type: "gate.rejected", link, kind: "call_failed", message }).pipe(Effect.as(`failed: ${message}`))
    const input = parseFileReadArgs(args)
    if ("error" in input) return yield* refuse(input.error)
    const { path, repo, ref, line, column } = input.payload
    if (repo !== undefined && repo !== source.repository) {
      return yield* refuse(`This question reads ${source.repository} only; name a file in it.`)
    }
    if (ref !== undefined) return yield* refuse("This question reads main only; ask without --ref.")
    const answer = yield* read(path)
    if (!("file" in answer)) return yield* refuse(refusalText(path, answer.code))
    const { file } = answer
    const { card, value } = fileReadCard(
      {
        repo: file.repository,
        path: file.path,
        content: file.content,
        binary: file.binary,
        readAt: { changeId: null, commitId: file.commit, source: "head" },
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column })
      },
      ordinal,
      Date.now()
    )
    yield* write({ runId, type: "card", card })
    yield* write({ runId, type: "call.settled", link, ordinal, name: FILES_READ, verdict: "run" })
    return boundToolResult(value).modelOutput
  })

/**
 * Runs one held tool call on the host and returns what the model reads: the
 * commands tool's list of what this host runs, or one command's result.
 */
const runHostTool = <E>(
  grant: DurableChatGrant,
  call: HeldToolCall,
  link: number,
  ordinal: number,
  write: FrameWriter<E>,
  read: SourceRead
): Effect.Effect<string, E> => {
  // A turn offered no tool runs none, whatever the model calls.
  if (call.name !== commandsToolSpec.name || grant.source === undefined) {
    return Effect.succeed(unknownToolResult(call.name))
  }
  const decoded = decodeCommandsCall(call.arguments)
  if ("failure" in decoded) return Effect.succeed(decoded.failure)
  if (decoded.action === "list") {
    const listed = hostCommands.filter((command) =>
      decoded.namespace === "" || command.name === decoded.namespace ||
      command.name.startsWith(`${decoded.namespace}.`)
    )
    return Effect.succeed(JSON.stringify({ commands: listed }))
  }
  if (decoded.name !== FILES_READ) return Effect.succeed(unknownCommandResult(decoded.name))
  return readFile(grant, grant.source, decoded.args, link, ordinal, write, read)
}

/**
 * Runs a host-owned turn: each model leg that ends in tool calls has them run
 * on the host, in order, and continues with their results. The last leg's
 * terminal frame states the whole turn's token counts; a turn still calling
 * tools after `MAX_TOOL_LEGS` legs ends with `tool_limit`.
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
      if (link + 1 === MAX_TOOL_LEGS) break
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
