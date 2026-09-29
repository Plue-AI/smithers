/**
 * The factory's issue list for the Smithers tab: the repository's mythical
 * stack read from Smithers Cloud as the signed-in person, grouped Needs you,
 * Working and Done under one line of measured metrics. The grouping and the
 * numbers are the app's History card's (`@smthrs/rpc/StackIssues`), so both
 * hosts say the same thing.
 */
import * as CloudSession from "@smthrs/cli/CloudSession"
import { type MythicalItem, mythicalRoute, type MythicalStack, MythicalStackSchema } from "@smthrs/rpc/Mythical"
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

const detail = (stack: MythicalStack, item: MythicalItem): ReadonlyArray<Panels.Block> => {
  const lines = [
    itemReason(item),
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
