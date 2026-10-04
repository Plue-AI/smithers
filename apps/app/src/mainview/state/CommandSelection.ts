/*
 * Jev command selection (issue #3313): which commands the chat model sees in
 * full for one user message.
 *
 * The prompt used to carry the whole catalog and degraded it in stages to fit
 * a 16 KiB cap; in an empty web session it fell to namespace counts, so the
 * model never saw /theme and said it could not switch themes.
 * Now the decision model (Jev, POST /api/commands/select) reads the message
 * and names the relevant commands; the prompt lists those, the commands the
 * standing instructions name (pinned), and everything disclosed for earlier
 * messages, each with its full descriptor. The `commands` tool's list action
 * with a `query` discloses more mid-turn. Disclosure governs context, never
 * permission: execute by name stays open for every callable command.
 *
 * A selection that fails is a typed, retryable failure of the turn. There is
 * no fallback to the full catalog or to an LLM-only turn.
 */
import { COMMANDS_SELECT_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { InstructionCommand } from "./Instructions"
import type { Message } from "./AppState"
import type { RecommendTailEntry } from "./Recommend"
import { recommendTail } from "./Recommend"
import { REPO_TOKEN } from "./RepoContext"

export { COMMANDS_SELECT_PATH }

/** The refusal code a failed selection carries into the transcript and the model's tool result. */
export const COMMANDS_SELECT_FAILED = "commands_select_failed"

/** Why a selection failed, by class, so the copy and the tests branch on data. */
export type CommandSelectFailureReason = "timeout" | "http" | "empty" | "credit" | "sign_in" | "rate_limited" | "unavailable"

export class CommandSelectError extends Error {
  readonly code = COMMANDS_SELECT_FAILED
  constructor(readonly reason: CommandSelectFailureReason, readonly status: number | null = null) {
    super(`${COMMANDS_SELECT_FAILED}: ${reason}`)
    this.name = "CommandSelectError"
  }
}

/** The most commands a list action with a query discloses. */
export const QUERY_DISCLOSURE_LIMIT = 5
/** The most disclosed names a prompt carries, newest messages first. */
export const DISCLOSED_PROMPT_LIMIT = 40
/** The server refuses longer messages; the newest characters are the ask. */
export const SELECT_MESSAGE_MAX_CHARS = 4000
/** The server's command-list bound (routes.recommendCommandsMax). */
export const SELECT_COMMANDS_MAX = 300
/** The client's own deadline: the server's 1.5 s Jev deadline plus the round trip. */
export const SELECT_CLIENT_TIMEOUT_MS = 4000

export interface SelectedCommand {
  readonly name: string
  readonly probability: number
}

export interface CommandSelectRequest {
  readonly message: string
  readonly tail: ReadonlyArray<RecommendTailEntry>
  readonly repo: string | null
  readonly commands: ReadonlyArray<{ readonly name: string; readonly summary: string }>
}

/** The decision model's door. Resolves the ranked selection or rejects with a CommandSelectError. */
export type CommandSelector = (request: CommandSelectRequest) => Promise<ReadonlyArray<SelectedCommand>>

/** The request for one message: its earlier conversation as the tail, offered commands bounded by the server's cap. */
export const commandSelectRequest = (input: {
  readonly message: string
  readonly earlier: ReadonlyArray<Pick<Message, "role" | "text" | "act">>
  readonly repo: string | null
  readonly commands: ReadonlyArray<InstructionCommand>
}): CommandSelectRequest => ({
  message: input.message.trim().slice(-SELECT_MESSAGE_MAX_CHARS),
  tail: recommendTail(input.earlier),
  repo: input.repo !== null && REPO_TOKEN.test(input.repo) ? input.repo : null,
  commands: input.commands.slice(0, SELECT_COMMANDS_MAX).map(({ name, summary }) => ({ name, summary }))
})

/** A 200 body, validated: only names the request offered, in the server's order. */
export const parseSelection = (body: unknown, offered: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<SelectedCommand> => {
  const rows = typeof body === "object" && body !== null ? (body as { readonly commands?: unknown }).commands : undefined
  if (!Array.isArray(rows)) throw new CommandSelectError("empty")
  const names = new Set(offered.map(command => command.name))
  const seen = new Set<string>()
  const selected: SelectedCommand[] = []
  for (const row of rows) {
    if (typeof row !== "object" || row === null) throw new CommandSelectError("empty")
    const { name, probability } = row as { readonly name?: unknown; readonly probability?: unknown }
    if (typeof name !== "string" || typeof probability !== "number" || !Number.isFinite(probability)) throw new CommandSelectError("empty")
    if (!names.has(name) || seen.has(name)) continue
    seen.add(name)
    selected.push({ name, probability })
  }
  return selected
}

/** The failure class of a non-2xx answer. */
export const selectFailureOf = (status: number): CommandSelectFailureReason =>
  status === 401 || status === 403 ? "sign_in"
    : status === 402 ? "credit"
    : status === 429 ? "rate_limited"
    : status === 504 ? "timeout"
    : status === 404 || status === 503 ? "unavailable"
    : "http"

/** The HTTP door: POST /api/commands/select on the app's own origin. */
export const httpCommandSelector = (
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  baseUrl: string,
  timeoutMs = SELECT_CLIENT_TIMEOUT_MS
): CommandSelector => async (request) => {
  let response: Response
  try {
    response = await fetch(`${baseUrl}${COMMANDS_SELECT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    throw new CommandSelectError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "http")
  }
  if (!response.ok) throw new CommandSelectError(selectFailureOf(response.status), response.status)
  let body: unknown
  try { body = await response.json() } catch { throw new CommandSelectError("empty", response.status) }
  return parseSelection(body, request.commands)
}

const REASON_COPY: Readonly<Record<CommandSelectFailureReason, string>> = {
  timeout: "the decision model did not answer in time",
  http: "the decision model could not be reached",
  empty: "the decision model returned no decision",
  credit: "your balance is spent",
  sign_in: "this needs you signed in",
  rate_limited: "the decision model is rate limited right now",
  unavailable: "this server has no decision model"
}

/** The transcript line for a failed selection: what failed and that /retry is the next act. */
export const selectFailureText = (error: unknown): string => {
  const reason = error instanceof CommandSelectError ? error.reason : "http"
  return `Smithers could not choose commands for this message: ${REASON_COPY[reason]}. Nothing ran. Retry with /chat.retry.`
}

/** The model's tool-result line for a failed discovery, coded so the fault class travels. */
export const selectFailureToolResult = (error: unknown): string =>
  `failed: ${COMMANDS_SELECT_FAILED} (${error instanceof CommandSelectError ? error.reason : "http"}): the list action's query could not be answered; execute by name or list a namespace instead`

/*
 * The commands the standing instructions name. Derived from the text so it
 * cannot drift: a rule that tells the model to "execute auth.prompt" always
 * puts auth.prompt's grammar beside it. Only dotted names count; a bare word
 * like "chat" or "wiki" is prose far more often than it is a command.
 */
export const pinnedCommandNames = (standing: string, catalog: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<string> =>
  catalog.filter(({ name }) => name.includes(".") && mentions(standing, name)).map(({ name }) => name)

const NAME_CHAR = /[\w-]/u
/* A whole-name mention: not inside a longer name before it, and not continued by a name character or a further `.segment`. */
const mentions = (text: string, name: string): boolean => {
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1] ?? ""
    const after = text[at + name.length] ?? ""
    const next = text[at + name.length + 1] ?? ""
    if (NAME_CHAR.test(before) || before === ".") continue
    if (NAME_CHAR.test(after) || (after === "." && NAME_CHAR.test(next))) continue
    return true
  }
  return false
}

/** The names disclosed across the retained conversation, newest message first, bounded. */
export const disclosedCommandNames = (
  messages: ReadonlyArray<Pick<Message, "role" | "disclosed">>,
  limit = DISCLOSED_PROMPT_LIMIT
): ReadonlyArray<string> => {
  const names: string[] = []
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue
    for (const name of message.disclosed ?? []) {
      if (names.length >= limit) return names
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}
