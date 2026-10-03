/**
 * The factory's issue list for the Smithers tab: the repository's mythical
 * stack read from Smithers Cloud as the signed-in person, grouped Needs you,
 * Working and Done under one line of measured metrics. The grouping and the
 * numbers are the app's History card's (`@smthrs/rpc/StackIssues`), so both
 * hosts say the same thing.
 */
import * as CloudSession from "@smthrs/cli/CloudSession"
import {
  type MythicalItem,
  MythicalItemSchema,
  mythicalMachine,
  mythicalReceiptDuration,
  mythicalRoute,
  type MythicalStack,
  MythicalStackSchema
} from "@smthrs/rpc/Mythical"
import * as StackIssues from "@smthrs/rpc/StackIssues"
import { itemReason, itemStateLabel, itemTitle, landable, retryable } from "@smthrs/rpc/StackView"
import { type Todo, TodoCreateAnswerSchema, todoName, TODO_ROUTES } from "@smthrs/rpc/Todo"
import * as Failures from "./failures.ts"
import * as Log from "./log.ts"
import type * as Panels from "./panels.ts"

/** Where a repository lives on Cloud: `owner/name`. */
export type Repository = string

/**
 * The repository the tab reads: `SMITHERS_REPO`, else the owner and name the
 * checkout's git or jj remote names, as `smthrs open` reads it (a Cloud
 * repository mirrors its GitHub owner and name).
 */
export const repository = (cwd: string, env: Readonly<Record<string, string | undefined>>): Repository | undefined => {
  const named = env.SMITHERS_REPO?.trim()
  if (named !== undefined && /^[\w.-]+\/[\w.-]+$/.test(named) && !named.split("/").some((part) => /^\.+$/.test(part))) {
    return named
  }
  return CloudSession.repository(cwd, env)
}

/** The stack, read as the signed-in person. */
export const load = async (
  get: (path: string, signal?: AbortSignal) => Promise<unknown>,
  repo: Repository,
  signal?: AbortSignal
): Promise<MythicalStack> => {
  const [owner, name] = repo.split("/") as [string, string]
  return MythicalStackSchema.parse(await get(mythicalRoute("stack", owner, name), signal))
}

/** Why Cloud did not do a request, and whether the refusal is final. */
export interface Refusal {
  readonly ok: false
  readonly detail: string
  readonly settled: boolean
}

/** What filing a TODO came to: the TODO Cloud persisted, or why not. */
export type Filing = { readonly ok: true; readonly todo: Todo } | Refusal

/** What a person's act on an item came to: the item as Cloud left it, or why not. */
export type Act = { readonly ok: true; readonly item: MythicalItem } | Refusal

/** A TODO in product words: `T12 Add dark mode · queued`. */
export const todoLine = (todo: Todo): string =>
  `${todoName(todo.n)} ${todo.title} · ${todo.state.replaceAll("_", " ")}`

/**
 * Files TODOs with `POST /api/todos?repo=owner/name`, each under one request
 * id sent as its `Idempotency-Key`: the same TODO filed again after an answer
 * that never came (a dropped network, a 5xx) resends that key, so the backend
 * answers the TODO it already made instead of making two. A Cloud
 * authentication refusal drops the id. The same TODO filed while one is in
 * flight joins it.
 */
export const filer = (
  post: (
    path: string,
    body: unknown,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>
  ) => Promise<unknown>,
  newId: () => string = () => crypto.randomUUID()
): (repo: Repository, title: string, signal?: AbortSignal) => Promise<Filing> => {
  const requests = new Map<string, string>()
  const flying = new Map<string, Promise<Filing>>()
  return (repo, title, signal) => {
    const key = `${repo}\n${title}`
    const joined = flying.get(key)
    if (joined !== undefined) return joined
    const request = requests.get(key) ?? newId()
    requests.set(key, request)
    const path = `${TODO_ROUTES.todos}?repo=${repo.split("/").map(encodeURIComponent).join("/")}`
    const run = post(path, { title }, signal, { "Idempotency-Key": request }).then(
      (body): Filing => {
        let todo: Todo
        try {
          todo = TodoCreateAnswerSchema.parse(body).todo
        } catch (error) {
          // A successful HTTP answer with an unusable body may have made
          // the TODO. Keep the request id until a validated answer arrives.
          return { ...failed(error), settled: false }
        }
        requests.delete(key)
        return { ok: true, todo }
      },
      (error): Filing => {
        const refused = failed(error)
        if (refused.settled) requests.delete(key)
        return refused
      }
    ).finally(() => flying.delete(key))
    flying.set(key, run)
    return run
  }
}

/** Only a Cloud authentication refusal settles the filing; uncertain failures keep its request id. */
const failed = (error: unknown): Refusal => {
  const failure = Failures.present("command", error)
  // The presenter logs unexpected failures; a returned Cloud refusal also
  // needs its diagnostic because it never reaches the host's catch boundary.
  if (failure.fault === "user") Log.write("factory.command", error)
  return {
    ok: false,
    detail: failure.fault === "user" ? failure.sentence : `${failure.sentence} ${Failures.inTerminal}`,
    settled: CloudSession.isAuthenticationRefusal(error)
  }
}

/** `12` or `#12`: the issue a factory command names. */
export const issueOf = (argument: string): number | undefined => {
  const match = /^#?(\d{1,15})$/.exec(argument.trim())
  const number = match === null ? 0 : Number(match[1])
  return number > 0 ? number : undefined
}

/**
 * One person's act on the TODO an issue names: the stack's item for the
 * issue, refused here unless `allowed`, then `POST`ed to its route. Answers
 * the item as Cloud left it.
 */
const issueAct = async (
  cloud: Pick<CloudSession.Cloud, "get" | "post">,
  repo: Repository,
  issue: number,
  allowed: (item: MythicalItem) => boolean,
  send: (item: MythicalItem, owner: string, name: string) => readonly [path: string, body: unknown],
  signal?: AbortSignal,
  presentFailure?: (error: unknown) => string
): Promise<Act> => {
  const [owner, name] = repo.split("/") as [string, string]
  let stack: MythicalStack
  try {
    stack = await load(cloud.get, repo, signal)
  } catch (error) {
    return { ...failed(error), ...(presentFailure === undefined ? {} : { detail: presentFailure(error) }) }
  }
  const item = stack.items.find((candidate) => candidate.issue?.number === issue)
  if (item === undefined) return { ok: false, detail: `#${issue} is not in the factory`, settled: true }
  if (!allowed(item)) return { ok: false, detail: `#${issue} is ${itemStateLabel(item)}`, settled: true }
  const [path, body] = send(item, owner, name)
  try {
    return { ok: true, item: MythicalItemSchema.parse(await cloud.post(path, body, signal)) }
  } catch (error) {
    return { ...failed(error), ...(presentFailure === undefined ? {} : { detail: presentFailure(error) }) }
  }
}

/**
 * Retries a failed TODO with `POST …/mythical/items/{id}/retry`, the route the
 * app's History card and `smthrs history retry` use: the stack names the
 * issue's item, and only a retryable one (blocked, rejected, declined or held
 * on review) is sent. Answers the item as Cloud left it.
 */
export const retry = (
  cloud: Pick<CloudSession.Cloud, "get" | "post">,
  repo: Repository,
  issue: number,
  signal?: AbortSignal,
  presentFailure?: (error: unknown) => string
): Promise<Act> =>
  issueAct(
    cloud,
    repo,
    issue,
    retryable,
    (item, owner, name) => [mythicalRoute("retry", owner, name, item.id), {}],
    signal,
    presentFailure
  )

/**
 * Lands a proposed TODO with `POST …/mythical/items/{id}/land`, the route the
 * app's History card and `smthrs history land` use: only a landable item (its
 * pull request open at a known head, no merge asked yet) is sent, naming the
 * head this read saw. The stack merges it at the reviewed head once CI is
 * green; nothing merges here.
 */
export const land = (
  cloud: Pick<CloudSession.Cloud, "get" | "post">,
  repo: Repository,
  issue: number,
  signal?: AbortSignal,
  presentFailure?: (error: unknown) => string
): Promise<Act> =>
  issueAct(
    cloud,
    repo,
    issue,
    landable,
    (item, owner, name) => [
      mythicalRoute("land", owner, name, item.id),
      { head: item.pullRequest?.head }
    ],
    signal,
    presentFailure
  )

/** One status line. */
export interface Line {
  readonly text: string
  readonly tone?: "warning"
}

/**
 * A `/<verb> <issue>` command: the status line now, and the line it settles
 * on when Cloud answers. A command it cannot send settles at once.
 */
const issueCommand = (
  words: { readonly verb: string; readonly requested: string; readonly not: string },
  act: (
    cloud: Pick<CloudSession.Cloud, "get" | "post">,
    repo: Repository,
    issue: number,
    signal?: AbortSignal,
    presentFailure?: (error: unknown) => string
  ) => Promise<Act>
) =>
(
  argument: string,
  repo: Repository | undefined,
  signIn: () => Promise<Pick<CloudSession.Cloud, "get" | "post"> | undefined>,
  persist?: (requested: Line) => void,
  presentFailure?: (error: unknown) => string
): { readonly now: Line; readonly settled?: Promise<Line> } => {
  const issue = issueOf(argument)
  if (issue === undefined) return { now: { text: `Usage: /${words.verb} <issue>`, tone: "warning" } }
  if (repo === undefined) return { now: { text: "No repository for this directory", tone: "warning" } }
  const now = { text: `${words.requested} #${issue} requested` }
  try {
    persist?.(now)
  } catch (error) {
    return {
      now: {
        text: `${words.requested} #${issue} not requested: ${presentFailure?.(error) ?? failed(error).detail}`,
        tone: "warning"
      }
    }
  }
  const settled = (async (): Promise<Line> => {
    try {
      const cloud = await signIn()
      if (cloud === undefined) return { text: `Sign in to ${words.verb}: smthrs auth login`, tone: "warning" }
      const answer = await act(cloud, repo, issue, undefined, presentFailure)
      return answer.ok
        ? { text: `#${issue} ${itemStateLabel(answer.item)}` }
        : { text: `#${issue} ${words.not}: ${answer.detail}`, tone: "warning" }
    } catch (error) {
      return { text: `#${issue} ${words.not}: ${presentFailure?.(error) ?? failed(error).detail}`, tone: "warning" }
    }
  })()
  return { now, settled }
}

/** `/retry <issue>`. */
export const retryCommand = issueCommand({ verb: "retry", requested: "Retry", not: "not retried" }, retry)

/** `/land <issue>`. */
export const landCommand = issueCommand({ verb: "land", requested: "Land", not: "not landed" }, land)

const groupStatus: Record<StackIssues.IssueGroupId, NonNullable<Panels.Row["status"]> | undefined> = {
  "needs-you": undefined,
  working: "running",
  done: "done"
}

/** The History card's own one-line numbers and words. */
export const metrics = (stack: MythicalStack): string =>
  StackIssues.stackMetricLabels(StackIssues.stackMetrics(stack)).map(({ text }) => text).join(" · ")

/** Rows a group lists before `… N more`: a panel holds 500 rows, and a queue can be longer. */
export const perGroup = 60

/**
 * Each check receipt on the candidate and how long it ran, then the run that
 * recorded them: `✓ affected-lint 1a2b3c4 42s · run run-1`.
 */
const receipts = (item: MythicalItem): string | undefined => {
  const all = item.checks?.receipts ?? []
  const runs = [...new Set(all.flatMap((receipt) => receipt.runId === undefined ? [] : [receipt.runId]))]
  return [
    ...all.map((receipt) =>
      [
        receipt.status === "passed" ? "✓" : "✗",
        receipt.check,
        receipt.commit.slice(0, 7),
        mythicalReceiptDuration(receipt)
      ]
        .filter((part) => part !== undefined).join(" ")
    ),
    ...runs.map((run) => `run ${run}`)
  ].join(" · ") || undefined
}

const detail = (stack: MythicalStack, item: MythicalItem): ReadonlyArray<Panels.Block> => {
  const lines = [
    itemReason(item),
    receipts(item),
    mythicalMachine(item.placement),
    item.pullRequest === undefined ? undefined : item.pullRequest.url,
    item.issue === undefined ? undefined : item.issue.url,
    item.issue !== undefined && retryable(item) ? `/retry #${item.issue.number}` : undefined
  ].filter((line): line is string => line !== undefined && line !== "")
  return lines.length === 0 ? [] : [{ kind: "text", text: lines.join("\n").slice(0, 4_000) }]
}

/** The issue rows: each group's heading, then its items, `◆ #2431 title · reason`. */
export const rows = (stack: MythicalStack, now: number): ReadonlyArray<Panels.Row> =>
  StackIssues.issueGroups(stack, now).filter((group) => group.items.length > 0).flatMap((group): Array<Panels.Row> => [
    { id: `group:${group.id}`, label: `${group.glyph} ${group.label} ${group.items.length}`, details: [] },
    ...group.items.slice(0, perGroup).map((item, index): Panels.Row => {
      const status = item.state === "queued" ? "queued" : groupStatus[group.id]
      const title = itemTitle(stack, item)
      const word = group.id === "needs-you" ? StackIssues.issueWord(item) : itemStateLabel(item)
      const progress = StackIssues.issueProgress(item)
      return {
        id: `issue:${group.id}:${index}`,
        label: `${group.id === "needs-you" ? "◆ " : ""}${title} · ${word}${
          progress === undefined ? "" : ` · ${progress}`
        }`.slice(0, 160),
        ...(status === undefined ? {} : { status }),
        ...(item.issue !== undefined && retryable(item)
          ? { action: { label: "Retry", action: { kind: "factory-retry" as const, issue: item.issue.number } } }
          : {}),
        details: detail(stack, item)
      }
    }),
    ...(group.items.length > perGroup
      ? [{ id: `more:${group.id}`, label: `… ${group.items.length - perGroup} more`, details: [] }]
      : [])
  ])
