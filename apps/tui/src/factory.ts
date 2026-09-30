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
import { itemReason, itemStateLabel, itemTitle, retryable } from "@smthrs/rpc/StackView"
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

/** What filing a TODO came to: the queued item, or why not and whether the refusal is final. */
export type Filing =
  | { readonly ok: true; readonly item: MythicalItem }
  | { readonly ok: false; readonly detail: string; readonly settled: boolean }

/**
 * Files TODOs with `POST …/mythical/todos`, each under one request id: the
 * same TODO filed again after an answer that never came (a dropped network,
 * a 5xx) resends that id, so the backend returns the TODO it already filed
 * instead of filing twice. A refusal (HTTP 4xx) filed nothing and drops the id.
 * The same TODO filed while one is in flight joins it.
 */
export const filer = (
  post: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>,
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
    const [owner, name] = repo.split("/") as [string, string]
    const run = post(mythicalRoute("todos", owner, name), { title, request }, signal).then(
      (body): Filing => {
        requests.delete(key)
        return { ok: true, item: MythicalItemSchema.parse(body) }
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

/** A request that failed: a refusal (HTTP 4xx) is final; anything else may not have reached Cloud. */
const failed = (error: unknown): Filing & { readonly ok: false } => ({
  ok: false,
  detail: error instanceof Error ? error.message : String(error),
  settled: /HTTP 4\d\d\b/.test(String(error))
})

/** `12` or `#12`: the issue a factory command names. */
const issueOf = (argument: string): number | undefined => {
  const match = /^#?(\d{1,15})$/.exec(argument.trim())
  const number = match === null ? 0 : Number(match[1])
  return number > 0 ? number : undefined
}

/**
 * Retries a failed TODO with `POST …/mythical/items/{id}/retry`, the route the
 * app's History card and `smthrs history retry` use: the stack names the
 * issue's item, and only a retryable one (blocked, rejected, declined or held
 * on review) is sent. Answers the item as Cloud left it.
 */
export const retry = async (
  cloud: Pick<CloudSession.Cloud, "get" | "post">,
  repo: Repository,
  issue: number,
  signal?: AbortSignal
): Promise<Filing> => {
  const [owner, name] = repo.split("/") as [string, string]
  let stack: MythicalStack
  try {
    stack = await load(cloud.get, repo, signal)
  } catch (error) {
    return failed(error)
  }
  const item = stack.items.find((candidate) => candidate.issue?.number === issue)
  if (item === undefined) return { ok: false, detail: `#${issue} is not in the factory`, settled: true }
  if (!retryable(item)) return { ok: false, detail: `#${issue} is ${itemStateLabel(item)}`, settled: true }
  try {
    return {
      ok: true,
      item: MythicalItemSchema.parse(await cloud.post(mythicalRoute("retry", owner, name, item.id), {}, signal))
    }
  } catch (error) {
    return failed(error)
  }
}

/** One status line. */
export interface Line {
  readonly text: string
  readonly tone?: "warning"
}

/**
 * `/retry <issue>`: the status line now, and the line it settles on when
 * Cloud answers. A command it cannot send settles at once.
 */
export const retryCommand = (
  argument: string,
  repo: Repository | undefined,
  signIn: () => Promise<Pick<CloudSession.Cloud, "get" | "post"> | undefined>
): { readonly now: Line; readonly settled?: Promise<Line> } => {
  const issue = issueOf(argument)
  if (issue === undefined) return { now: { text: "Usage: /retry <issue>", tone: "warning" } }
  if (repo === undefined) return { now: { text: "No repository for this directory", tone: "warning" } }
  const settled = (async (): Promise<Line> => {
    try {
      const cloud = await signIn()
      if (cloud === undefined) return { text: "Sign in to retry: smthrs auth login", tone: "warning" }
      const answer = await retry(cloud, repo, issue)
      return answer.ok
        ? { text: `#${issue} ${itemStateLabel(answer.item)}` }
        : { text: `#${issue} not retried: ${answer.detail}`, tone: "warning" }
    } catch (error) {
      return { text: `#${issue} not retried: ${failed(error).detail}`, tone: "warning" }
    }
  })()
  return { now: { text: `Retry #${issue} requested` }, settled }
}

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
        details: detail(stack, item)
      }
    }),
    ...(group.items.length > perGroup
      ? [{ id: `more:${group.id}`, label: `… ${group.items.length - perGroup} more`, details: [] }]
      : [])
  ])
