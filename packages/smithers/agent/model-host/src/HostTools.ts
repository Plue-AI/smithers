/**
 * The app agent's tools on the host (spec §15.1.3, §15.1.4). A host-owned
 * turn, one whose request offers no tools of its own, is offered the app
 * agent's one tool, `commands`, and the host runs its calls between model
 * legs: the browser executes none of them. A request that offers tools keeps
 * executing them itself, so the two never share a turn.
 *
 * The host runs the commands of one table. Each row binds a catalog command's
 * shared declaration in `@smthrs/rpc` (its name, copy, grammar and card
 * builder) to this host's transport and states its agent rule (mvp.md
 * Appendix B): `files.read` reads the turn's mirrored main through the
 * producer's source read callback; `stack` and `todo` read the install's TODO
 * routes through the producer's API callback; `todo.new` asks the person: it
 * only shows its author a private Draft, which they commit themselves. Go
 * grants each transport only when the credential that admitted the turn can
 * use it now and authorizes every call again as that credential, so a turn is
 * offered, and its instructions list, exactly the commands its grant runs.
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
import type { Card } from "@smthrs/rpc/Cards"
import { fileReadCard, FILES_READ, FILES_READ_COPY, parseFileReadArgs } from "@smthrs/rpc/FileRead"
import type {
  AgentChatMessage,
  AgentToolSpec,
  AgentTurnUsage,
  FetchLike,
  StartAgentTurnRequest
} from "@smthrs/rpc/NativeAgent"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import {
  draftCard,
  parseTodoArgs,
  STACK,
  STACK_COPY,
  TODO,
  TODO_COPY,
  TODO_NEW,
  TODO_NEW_COPY,
  todoCard,
  todoPath,
  TODOS_PATH
} from "@smthrs/rpc/TodoCommands"
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
 * One row of the host's command table: a catalog command's copy and agent
 * rule, and its binding to this host's transport. `bind` answers undefined
 * when the turn's grant cannot run the command, so it is neither offered nor
 * listed. A command whose rule is `never` has no row.
 */
interface HostCommand {
  readonly name: string
  readonly summary: string
  readonly args?: string
  /** mvp.md Appendix B: `run` acts at once; `confirm` only shows the person what to confirm. */
  readonly agent: "run" | "confirm"
  readonly bind: (grant: DurableChatGrant, transport: HostTransport) => BoundRun | undefined
}

/** `files.read` on the turn's mirrored main. */
const filesRead: HostCommand = {
  name: FILES_READ,
  ...FILES_READ_COPY,
  agent: "run",
  bind: (grant, { read }) => {
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
const stack: HostCommand = {
  name: STACK,
  ...STACK_COPY,
  agent: "run",
  bind: (grant, { api }) =>
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
}

const TodoNumberSchema = z.number().int().positive()

/** `todo Tn`: one TODO, shown as its TODO card. */
const todo: HostCommand = {
  name: TODO,
  ...TODO_COPY,
  agent: "run",
  bind: (grant, { api }) =>
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
}

/** The fields a written TODO's Draft takes from `todo.new`; its id, key and Commit are the person's. */
const DraftInputSchema = z.object({
  text: z.string().optional(),
  title: z.string().min(1).optional(),
  acceptance: z.array(z.string()).optional(),
  before: TodoNumberSchema.optional()
}).strict()

/** What the model is told after a Draft is shown. */
const DRAFTED =
  "Drafted: the Draft is on the person's screen. Nothing is filed until they press Commit, so never say the TODO exists."

/** `todo.new` asks the person: it shows its author a private Draft and files nothing. */
const todoNew: HostCommand = {
  name: TODO_NEW,
  ...TODO_NEW_COPY,
  agent: "confirm",
  bind: (grant) => {
    const author = grant.api?.author
    if (author === undefined) return undefined
    return (args, ordinal) =>
      Effect.sync(() => {
        const input = parseTodoArgs("text", false)(args)
        if ("error" in input) return { refusal: input.error }
        if ("cardId" in input.payload) return { refusal: "Only the person commits a Draft: they press Commit on it." }
        const draft = DraftInputSchema.safeParse(input.payload)
        if (!draft.success) {
          return { refusal: "todo.new takes the TODO's text, and optionally its title and acceptance." }
        }
        const { text = "", title, acceptance, before } = draft.data
        const card = draftCard(
          {
            id: `draft:${globalThis.crypto.randomUUID()}`,
            author,
            text,
            title,
            acceptance,
            before,
            options: [],
            idempotencyKey: globalThis.crypto.randomUUID()
          },
          ordinal,
          Date.now()
        )
        return { cards: [card], value: DRAFTED }
      })
  }
}

/** Every command this host runs, in the order the list and the instructions name them. */
const hostCommands: ReadonlyArray<HostCommand> = [filesRead, stack, todo, todoNew]

/** A command this turn's grant runs. */
interface Offered {
  readonly command: HostCommand
  readonly run: BoundRun
}

/** The commands this turn's grant runs. */
const offeredCommands = (grant: DurableChatGrant, transport: HostTransport): ReadonlyArray<Offered> =>
  hostCommands.flatMap((command) => {
    const run = command.bind(grant, transport)
    return run === undefined ? [] : [{ command, run }]
  })

/** A command as the instructions list it, with its arguments and, for a confirm command, what it asks. */
const commandLine = ({ command }: Offered): string =>
  `- /${command.name}${command.args === undefined ? "" : ` ${command.args}`} — ${command.summary}${
    command.agent === "confirm" ? " (asks the person: it shows them what to confirm and files nothing)" : ""
  }`

/**
 * The instructions of a host-owned turn. They replace the request's own, which
 * describe its client's commands: the model reads exactly the commands this
 * host runs for this turn's author, and no other.
 */
const hostInstructions = (offered: ReadonlyArray<Offered>): string =>
  [
    "You are Smithers, this install's app agent, answering the person who asked. Your name is exactly \"Smithers\".",
    ...(offered.length === 0
      ? ["No command runs for you in this conversation: answer in words, and say plainly what you cannot do here."]
      : [
        "You have one tool, \"commands\": action \"list\" returns the commands below; action \"execute\" runs one by name with its argument text, as the person who asked.",
        "The commands you can run in this conversation, and no others (any other answers \"unknown-command\" and nothing runs):",
        ...offered.map(commandLine),
        "When the person's request maps to one of these, run it in this turn. A tool result beginning \"failed:\" or \"unknown-command:\" means nothing ran: relay the reason and never report it as done."
      ])
  ].join("\n")

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
    const tools: ReadonlyArray<AgentToolSpec> = offered.length === 0 ? [] : [commandsToolSpec]
    let request: StartAgentTurnRequest = { ...grant.request, instructions: hostInstructions(offered), tools }
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
