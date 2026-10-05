/**
 * The app agent's tools on the host (spec §15.1.3, §15.1.4). A host-owned
 * turn, one whose request offers no tools of its own, is offered the app
 * agent's one tool, `commands`, and the host runs its calls between model
 * legs: the browser executes none of them. A request that offers tools keeps
 * executing them itself, so the two never share a turn.
 *
 * The host runs the catalog commands `@smthrs/rpc` declares for it
 * (`INSTALL_HOST_COMMANDS`: each one's name, copy and agent rule, mvp.md
 * Appendix B), binding each to this host's transport with the grammar, input
 * and card builder the GUI uses: `files.list` and `files.read` list and read
 * the turn's mirrored main through the producer's source callbacks; `stack` and `todo` read the
 * install's TODO routes through the producer's API callback; `todo.new`, a
 * confirm command, only shows its author a private Draft, which they commit
 * themselves. Go grants each transport only when the credential that admitted
 * the turn can use it now and authorizes every call again as that credential.
 * A turn offered any command gets this host's instructions and capability
 * lines, which list exactly the commands its grant runs; a turn offered none
 * keeps its request's own.
 *
 * @since 1.0.0-rc.0
 */

import type * as Model from "@smthrs/model/Model"
import type { ModelError } from "@smthrs/model/ModelError"
import {
  type AgentCommand,
  commandsToolSpec,
  decodeCommandsCall,
  INSTALL_HOST_COMMANDS,
  unknownCommandResult,
  unknownToolResult
} from "@smthrs/rpc/AgentCommands"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import {
  ACCOUNT_NUMBERS_LINE,
  AGENT_NAME_LINE,
  agentCommandLine,
  ANNOUNCED_ACT_LINE,
  ASK_IS_PERMISSION_LINE,
  cantYetsSentence,
  FAILED_RESULT_LINE,
  namedCantYets,
  RUN_IS_NOT_RESULT_LINE,
  TOOL_CHANNEL_LINE,
  WORKFLOW_LAUNDERING_RULE
} from "@smthrs/rpc/AgentInstructions"
import { boundToolResult, MAX_TOOL_LEGS } from "@smthrs/rpc/AgentToolResult"
import type { Card } from "@smthrs/rpc/Cards"
import { fileListCard, FILES_LIST_COMMAND, parseFileListArgs } from "@smthrs/rpc/FileList"
import { fileReadCard, FILES_READ_COMMAND, parseFileReadArgs } from "@smthrs/rpc/FileRead"
import type { AgentChatMessage, AgentTurnUsage, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { draftCard, parseTodoArgs, todoCard, TodoNewInputSchema, todoPath, TODOS_PATH } from "@smthrs/rpc/TodoCommands"
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

/**
 * The producer callback a host tool lists the turn's source directories through.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const SOURCE_LIST_PATH = "/internal/chat/source/list"

/**
 * The producer callback a host command reads the install's API through.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export const API_CALL_PATH = "/internal/chat/api"

/**
 * Whether the host runs this turn's tool calls: its request offers no tools.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const hostOwned = (request: StartAgentTurnRequest): boolean => (request.tools?.length ?? 0) === 0

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

const SourceDirectorySchema = z.object({
  repository: z.string().min(1),
  path: z.string(),
  commit: z.string().min(1),
  entries: z.array(z.object({ name: z.string().min(1), kind: z.enum(["file", "dir"]) }).strict()),
  truncated: z.boolean()
}).strict()

/**
 * One directory the producer listed on the turn's mirrored main.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type SourceDirectory = z.infer<typeof SourceDirectorySchema>

/**
 * A source listing's answer: the directory, or the refusal code the callback stated.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type SourceListing = { readonly directory: SourceDirectory } | { readonly code: string }

/**
 * Lists one directory of the turn's source; the empty path is its root.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type SourceList = (path: string) => Effect.Effect<SourceListing>

/**
 * An API read's answer: the route's own status and body, or the refusal code
 * the callback stated before reaching the route.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ApiAnswer = { readonly status: number; readonly body: unknown } | { readonly code: string }

/**
 * Reads one install API route as the turn's admitting credential.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ApiRead = (path: string) => Effect.Effect<ApiAnswer>

/**
 * The producer callbacks a host-owned turn's commands reach the install through.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HostTransport {
  readonly read: SourceRead
  readonly list: SourceList
  readonly api: ApiRead
}

/** A callback refusal's code, or the status it answered without one. */
const refusalCode = (response: Response, body: unknown): string =>
  typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
    ? body.code
    : `status_${response.status}`

/** Posts one producer callback with the grant's capability; a callback that does not answer states `unreachable`. */
const callback = <A>(
  callbackBaseUrl: string,
  grant: DurableChatGrant,
  fetchImpl: FetchLike,
  path: string,
  body: Record<string, unknown>,
  answer: (response: Response, body: unknown) => A | { readonly code: string }
): Effect.Effect<A | { readonly code: string }> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImpl(new URL(path, callbackBaseUrl), {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${grant.token}` },
        body: JSON.stringify({ turnId: grant.turnId, generation: grant.generation, ...body })
      })
      const parsed: unknown = await response.json().catch(() => undefined)
      return response.ok ? answer(response, parsed) : { code: refusalCode(response, parsed) }
    },
    catch: () => ({ code: "unreachable" })
  }).pipe(Effect.catch((refused) => Effect.succeed(refused)))

/**
 * The source read callback for one producer generation. Its capability is the
 * grant's producer token, so a read ends with the turn.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const sourceReader =
  (callbackBaseUrl: string, grant: DurableChatGrant, fetchImpl: FetchLike): SourceRead => (path) =>
    callback(callbackBaseUrl, grant, fetchImpl, SOURCE_READ_PATH, { path }, (_response, body): SourceAnswer => {
      const parsed = SourceFileSchema.safeParse(body)
      return parsed.success ? { file: parsed.data } : { code: "invalid_answer" }
    })

/**
 * The source list callback for one producer generation, on the read callback's terms.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const sourceLister =
  (callbackBaseUrl: string, grant: DurableChatGrant, fetchImpl: FetchLike): SourceList => (path) =>
    callback(callbackBaseUrl, grant, fetchImpl, SOURCE_LIST_PATH, { path }, (_response, body): SourceListing => {
      const parsed = SourceDirectorySchema.safeParse(body)
      return parsed.success ? { directory: parsed.data } : { code: "invalid_answer" }
    })

const ApiAnswerSchema = z.object({ status: z.number().int(), body: z.unknown() }).strict()

/**
 * The API read callback for one producer generation: a GET of one install
 * route, answered as the route answered the turn's admitting credential.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const apiReader = (callbackBaseUrl: string, grant: DurableChatGrant, fetchImpl: FetchLike): ApiRead => (path) =>
  callback(callbackBaseUrl, grant, fetchImpl, API_CALL_PATH, { method: "GET", path }, (_response, body) => {
    const parsed = ApiAnswerSchema.safeParse(body)
    return parsed.success ? { status: parsed.data.status, body: parsed.data.body } : { code: "invalid_answer" }
  })

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

/** What one command answered: the cards it shows and the model's copy, or the refusal both are told. */
type Outcome = { readonly cards: ReadonlyArray<Card>; readonly value: string } | { readonly refusal: string }

/** One command bound to this turn: it runs with the call's argument text and ordinal. */
type BoundRun = (args: string | undefined, ordinal: number) => Effect.Effect<Outcome>

/**
 * A host command's binding to this turn: undefined when the turn's grant
 * cannot run it, so it is neither offered nor listed.
 */
type Bind = (grant: DurableChatGrant, transport: HostTransport) => BoundRun | undefined

/** `files.read` on the turn's mirrored main. */
const filesRead: Bind = (grant, { read }) => {
  const repository = grant.source?.repository
  if (repository === undefined) return undefined
  return (args, ordinal) =>
    Effect.gen(function*() {
      const input = parseFileReadArgs(args)
      if ("error" in input) return { refusal: input.error }
      const { path, repo, ref, line, column } = input.payload
      if (repo !== undefined && repo !== repository) {
        return { refusal: `This question reads ${repository} only; name a file in it.` }
      }
      if (ref !== undefined) return { refusal: "This question reads main only; ask without --ref." }
      const answer = yield* read(path)
      if (!("file" in answer)) return { refusal: refusalText(path, answer.code) }
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
      return { cards: [card], value }
    })
}

/** What the model and the conversation are told when a listing does not answer a directory. */
const listRefusalText = (path: string, code: string): string => {
  switch (code) {
    case "path_refused":
      return `${
        shown(path)
      } is not a path inside this repository. Name a directory by its path from the repository root, for example src, or list the root with no path.`
    case "not_found":
      return `${shown(path)} is not a directory on main.`
    default:
      return refusalText(path, code)
  }
}

/** A listing's path as the repository names it, without the slashes around it: `/` names the root, as no path does. */
const directoryPath = (path: string): string => path.replace(/^\/+/u, "").replace(/\/+$/u, "")

/** `files.list` on the turn's mirrored main. */
const filesList: Bind = (grant, { list }) => {
  const repository = grant.source?.repository
  if (repository === undefined) return undefined
  return (args, ordinal) =>
    Effect.gen(function*() {
      const input = parseFileListArgs(args)
      if ("error" in input) return { refusal: input.error }
      const { repo } = input.payload
      if (repo !== undefined && repo !== repository) {
        return { refusal: `This question reads ${repository} only; name a directory in it.` }
      }
      const path = directoryPath(input.payload.path)
      const answer = yield* list(path)
      if (!("directory" in answer)) return { refusal: listRefusalText(path, answer.code) }
      const { directory } = answer
      const { card, value } = fileListCard(
        {
          repo: directory.repository,
          path: directory.path,
          entries: directory.entries,
          truncated: directory.truncated,
          readAt: { changeId: null, commitId: directory.commit, source: "head" }
        },
        ordinal,
        Date.now()
      )
      return { cards: [card], value }
    })
}

/** What the model and the conversation are told when a TODO read does not answer. */
const todoRefusal = (answer: ApiAnswer): string => {
  if ("code" in answer) {
    return answer.code === "forbidden"
      ? "The person who asked can't use this install's TODOs now."
      : "The TODO read did not answer. Ask again."
  }
  // The route's own refusal names its reason, as it does for the person's browser.
  const { body } = answer
  return typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
    ? body.message
    : "The TODO read did not answer. Ask again."
}

/** One install route's answer as `schema` reads it, or the refusal the model and the conversation are told. */
const readRoute = <A>(
  api: ApiRead,
  path: string,
  schema: z.ZodType<A>
): Effect.Effect<{ readonly value: A } | { readonly refusal: string }> =>
  Effect.map(api(path), (answer) => {
    if ("code" in answer || answer.status !== 200) return { refusal: todoRefusal(answer) }
    const parsed = schema.safeParse(answer.body)
    return parsed.success ? { value: parsed.data } : { refusal: "The TODO read did not answer. Ask again." }
  })

/** `stack`: the install's TODOs, each open one shown as its TODO card. */
const stack: Bind = (grant, { api }) =>
  grant.api === undefined ? undefined : (args, ordinal) =>
    Effect.gen(function*() {
      if ((args ?? "").trim() !== "") return { refusal: "/stack takes no arguments." }
      const listed = yield* readRoute(api, TODOS_PATH, z.array(TodoCardSchema))
      if ("refusal" in listed) return listed
      const now = Date.now()
      return {
        cards: listed.value.filter((model) => model.state !== "merged" && model.state !== "dropped").map((model) =>
          todoCard(model.n, model, ordinal, now)
        ),
        value: JSON.stringify({
          todos: listed.value.map((model) => ({
            n: model.n,
            title: model.title,
            state: model.state,
            owner: model.owner.login,
            ...(model.place === undefined ? {} : { place: model.place })
          }))
        })
      }
    })

const TodoNumberSchema = z.number().int().positive()

/** `todo Tn`: one TODO, shown as its TODO card. */
const todo: Bind = (grant, { api }) =>
  grant.api === undefined ? undefined : (args, ordinal) =>
    Effect.gen(function*() {
      const input = parseTodoArgs()(args)
      if ("error" in input) return { refusal: input.error }
      const n = TodoNumberSchema.safeParse(input.payload.n)
      if (!n.success) return { refusal: "Name the TODO by its number: /todo T12." }
      const read = yield* readRoute(api, todoPath(n.data), TodoCardSchema)
      if ("refusal" in read) return read
      return { cards: [todoCard(n.data, read.value, ordinal, Date.now())], value: JSON.stringify(read.value) }
    })

/** `todo.new`'s declared input, refusing every field it does not declare. */
const TodoNewInput = z.strictObject(TodoNewInputSchema.shape)

/** What the model is told after a Draft is shown. */
const DRAFTED =
  "Drafted: the Draft is on the person's screen. Nothing is filed until they press Commit, so never say the TODO exists."

/**
 * `todo.new` asks the person: it shows its author a private Draft and files
 * nothing. The Draft appends, the only place the install files a TODO at for
 * now, so it carries no placement to choose from.
 */
const todoNew: Bind = (grant) => {
  const author = grant.api?.author
  if (author === undefined) return undefined
  return (args, ordinal) =>
    Effect.sync(() => {
      const input = parseTodoArgs("text", false)(args)
      if ("error" in input) return { refusal: input.error }
      if ("cardId" in input.payload) return { refusal: "Only the person commits a Draft: they press Commit on it." }
      const draft = TodoNewInput.safeParse(input.payload)
      // The Draft's Commit key is the host's to choose, never the model's.
      if (!draft.success || draft.data.idempotencyKey !== undefined) {
        return { refusal: "todo.new takes the TODO's text, and optionally its title and acceptance." }
      }
      const { text = "", title, acceptance, before } = draft.data
      if (before !== undefined) {
        return { refusal: "A new TODO goes at the end of the stack for now: draft it without before." }
      }
      const card = draftCard(
        {
          id: `draft:${globalThis.crypto.randomUUID()}`,
          author,
          text,
          title,
          acceptance,
          options: [],
          idempotencyKey: globalThis.crypto.randomUUID()
        },
        ordinal,
        Date.now()
      )
      return { cards: [card], value: DRAFTED }
    })
}

/** Each command this host runs, bound by name: a declared command without a binding, or the reverse, does not compile. */
const binds: { readonly [Name in (typeof INSTALL_HOST_COMMANDS)[number]["name"]]: Bind } = {
  "files.list": filesList,
  "files.read": filesRead,
  stack,
  todo,
  "todo.new": todoNew
}

/** A command this turn's grant runs. */
interface Offered {
  readonly command: AgentCommand
  readonly run: BoundRun
}

/** The commands this turn's grant runs, in the order the list and the instructions name them. */
const offeredCommands = (grant: DurableChatGrant, transport: HostTransport): ReadonlyArray<Offered> =>
  INSTALL_HOST_COMMANDS.flatMap((command) => {
    const run = binds[command.name](grant, transport)
    return run === undefined ? [] : [{ command, run }]
  })

/** How a turn that can list finds a file it was not named: it lists, never guesses. */
const LIST_BEFORE_READ_LINE =
  "Asked about the repository's code without a file named, list the root with files.list, then list or read the paths it shows; never guess a path."

/**
 * The instructions of a turn this host runs commands for. They replace the
 * request's own, which describe its client's commands: the model reads the
 * app agent's standing rules and exactly the commands this host runs for the
 * turn's author, and no other.
 */
const hostInstructions = (offered: ReadonlyArray<Offered>): string => {
  const reads = offered.flatMap(({ command }) =>
    command.name === FILES_LIST_COMMAND.name || command.name === FILES_READ_COMMAND.name ? [command.name] : []
  )
  return [
    AGENT_NAME_LINE,
    "You have one tool, \"commands\": action \"list\" returns the commands below; action \"execute\" runs one by name with its argument text, as the person who asked.",
    TOOL_CHANNEL_LINE,
    ASK_IS_PERMISSION_LINE,
    ANNOUNCED_ACT_LINE,
    RUN_IS_NOT_RESULT_LINE,
    FAILED_RESULT_LINE,
    ACCOUNT_NUMBERS_LINE,
    "",
    "The commands you can run in this conversation, and no others (any other answers \"unknown-command\" and nothing runs):",
    ...offered.map(({ command }) => agentCommandLine(command)),
    ...(reads.includes(FILES_LIST_COMMAND.name) ? [LIST_BEFORE_READ_LINE] : []),
    "",
    `Everything this list lacks is a can't-yet. ${cantYetsSentence(namedCantYets(reads))}`,
    ...WORKFLOW_LAUNDERING_RULE
  ].join("\n")
}

/**
 * The runtime context of a turn this host runs commands for: the client's
 * facts, with this host's capability lines in place of the client's, and
 * without the client's blocks that name commands only the client runs (the
 * tutorial, the Cloud session and the repository check).
 */
const hostContext = (context: AgentRuntimeContext): AgentRuntimeContext => {
  const { cloud: _cloud, onboarding: _onboarding, repositoryUpdate: _repositoryUpdate, ...facts } = context
  return {
    ...facts,
    capabilities: [
      "Hold a streaming conversation in this chat and read its visible transcript.",
      "Run the commands the instructions list through the \"commands\" tool, as the person who asked; each answers with a card in this chat."
    ],
    limitations: [
      "Cannot see or control the host environment beyond what this context block states.",
      "Runs no command the instructions do not list: any other answers unknown-command, and nothing runs."
    ]
  }
}

/** The request of a turn this host runs commands for: its instructions, context and tool are this host's. */
const hostRequest = (request: StartAgentTurnRequest, offered: ReadonlyArray<Offered>): StartAgentTurnRequest => {
  const { context, ...rest } = request
  return {
    ...rest,
    instructions: hostInstructions(offered),
    ...(context === undefined ? {} : { context: hostContext(context) }),
    tools: [commandsToolSpec]
  }
}

/**
 * Runs one command and returns what the model reads. The journal records the
 * call and its cards, or its refusal; a refusal ends the call, never the
 * turn, so the model can say what happened.
 */
const runCommand = <E>(
  grant: DurableChatGrant,
  offered: Offered,
  args: string | undefined,
  link: number,
  ordinal: number,
  write: FrameWriter<E>
): Effect.Effect<string, E> =>
  Effect.gen(function*() {
    const runId = grant.request.runId
    const name = offered.command.name
    yield* write({ runId, type: "call.started", link, ordinal, name })
    const outcome = yield* offered.run(args, ordinal)
    if ("refusal" in outcome) {
      yield* write({ runId, type: "gate.rejected", link, kind: "call_failed", message: outcome.refusal })
      return `failed: ${outcome.refusal}`
    }
    for (const card of outcome.cards) yield* write({ runId, type: "card", card })
    yield* write({ runId, type: "call.settled", link, ordinal, name, verdict: "run" })
    return boundToolResult(outcome.value).modelOutput
  })

/**
 * Runs one held tool call on the host and returns what the model reads: the
 * commands tool's list of what this turn runs, or one command's result.
 */
const runHostTool = <E>(
  grant: DurableChatGrant,
  offered: ReadonlyArray<Offered>,
  call: HeldToolCall,
  link: number,
  ordinal: number,
  write: FrameWriter<E>
): Effect.Effect<string, E> => {
  // A turn offered no tool runs none, whatever the model calls.
  if (call.name !== commandsToolSpec.name || offered.length === 0) {
    return Effect.succeed(unknownToolResult(call.name))
  }
  const decoded = decodeCommandsCall(call.arguments)
  if ("failure" in decoded) return Effect.succeed(decoded.failure)
  if (decoded.action === "list") {
    const listed = offered.flatMap(({ command }) =>
      decoded.namespace === "" || command.name === decoded.namespace ||
        command.name.startsWith(`${decoded.namespace}.`)
        ? [{
          name: command.name,
          summary: command.summary,
          ...(command.args === undefined ? {} : { args: command.args })
        }]
        : []
    )
    return Effect.succeed(JSON.stringify({ commands: listed }))
  }
  const target = offered.find(({ command }) => command.name === decoded.name)
  if (target === undefined) return Effect.succeed(unknownCommandResult(decoded.name))
  return runCommand(grant, target, decoded.args, link, ordinal, write)
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
  transport: HostTransport
): Effect.Effect<void, Model.ModelFailure | ModelError | E> =>
  Effect.gen(function*() {
    const offered = offeredCommands(grant, transport)
    // A turn offered no command keeps its request's own instructions and context: this host owns neither.
    let request: StartAgentTurnRequest = offered.length === 0
      ? { ...grant.request, tools: [] }
      : hostRequest(grant.request, offered)
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
        const output = yield* runHostTool(grant, offered, call, link, ordinal, write)
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
