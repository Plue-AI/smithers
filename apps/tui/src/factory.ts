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
  mythicalRoute,
  type MythicalStack,
  MythicalStackSchema
} from "@smthrs/rpc/Mythical"
import * as StackIssues from "@smthrs/rpc/StackIssues"
import { itemReason, itemStateLabel, itemTitle } from "@smthrs/rpc/StackView"
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
        const settled = /HTTP 4\d\d\b/.test(String(error))
        if (settled) requests.delete(key)
        return { ok: false, detail: error instanceof Error ? error.message : String(error), settled }
      }
    ).finally(() => flying.delete(key))
    flying.set(key, run)
    return run
  }
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

/** Each check receipt on the candidate: `✓ affected-lint 1a2b3c4`. */
const receipts = (item: MythicalItem): string | undefined =>
  item.checks?.receipts?.map((receipt) =>
    `${receipt.status === "passed" ? "✓" : "✗"} ${receipt.check} ${receipt.commit.slice(0, 7)}`
  ).join(" · ") || undefined

const detail = (stack: MythicalStack, item: MythicalItem): ReadonlyArray<Panels.Block> => {
  const lines = [
    itemReason(item),
    receipts(item),
    mythicalMachine(item.placement),
    item.pullRequest === undefined ? undefined : item.pullRequest.url,
    item.issue === undefined ? undefined : item.issue.url
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
