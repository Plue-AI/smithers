/**
 * The no-change verdict: an agent that edited nothing reports why, or triage
 * (`triage.ts`) finds the issue needs no code change before any agent runs,
 * and the sweep records that once on the issue, labels it `sweep:no-change`,
 * and stops dispatching it until a human acts. A verdict our own
 * infrastructure caused (a missing tool, a killed compiler) is never recorded;
 * the next run retries.
 */
import { Effect } from "effect"
import { api } from "./github.ts"
import { HostFailed } from "./host.ts"

/** The label that parks an issue after a recorded no-change verdict. */
export const noChangeLabel = "sweep:no-change"

/** Every verdict comment starts with this; the full marker also carries the verdict's time. */
export const marker = "<!-- issue-sweep:no-change"

const tools = "vitest|bun|go|golang|cargo|rustc|playwright|chromium|pnpm|node"
const infraPatterns: ReadonlyArray<RegExp> = [
  new RegExp(
    `\\b(?:${tools})\\b\`?[^\\n.;]{0,40}?(?:not installed|isn't installed|unavailable|not available|not found|missing)`,
    "i"
  ),
  /\b(?:missing|without)\s+(?:the\s+)?`?(?:vitest|bun|go toolchain|cargo|chromium|playwright browsers?)\b/i,
  /signal: killed/i,
  /\bcompil\w*\s+(?:was\s+|were\s+)?killed/i,
  /\bOOM\b|out of memory/i,
  /executable doesn't exist/i
]

/**
 * The part of an agent's report that shows our own infrastructure kept it from
 * working (a missing vitest, bun, go, cargo, or Playwright Chromium; a
 * compiler killed for memory), or `undefined` when nothing does.
 */
export const infraCaused = (report: string): string | undefined => {
  for (const pattern of infraPatterns) {
    const match = pattern.exec(report)
    if (match !== null) return match[0]
  }
  return undefined
}

export type Need = "environment" | "acceptance" | "operator" | "evidence" | "design decision"

/** What a no-change verdict needs from a human. */
export const needOf = (report: string): Need =>
  /design decision|product decision|maintainer decision|needs? an? (?:decision|ruling)|\bdecide\b|ambiguous|which option/i
      .test(report)
    ? "design decision"
    : /credential|secret|\btoken\b|api key|\blogin\b|permission|admin access|access to|production|\bdeploy|hardware|real device/i
        .test(report)
    ? "environment"
    : "acceptance"

/** The report, blank runs collapsed, cut at a line once longer than `limit`; it cannot close a fence. */
export const evidenceOf = (report: string, limit = 1500): string => {
  const text = report.trim().replace(/\n{3,}/g, "\n\n").replaceAll("```", "'''")
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const line = cut.lastIndexOf("\n")
  return `${line > 0 ? cut.slice(0, line) : cut}\n…`
}

/**
 * The verdict comment for `report`, recorded at the ISO time `at`. A verdict
 * from triage carries the need its judge chose and says no agent ran; an
 * agent's verdict derives the need from the agent's report.
 */
export const verdictBody = (report: string, at: string, triaged?: Need): string =>
  [
    `${marker} ${at}${triaged === undefined ? "" : " triage"} -->`,
    `**No change.** Needs: ${triaged === undefined ? needOf(report) : `${triaged} (triage; no agent ran)`}`,
    "",
    "```text",
    evidenceOf(report),
    "```"
  ].join("\n")

/** Update the issue's marked comment in place when there is one; add one otherwise. */
export const verdictWrite = (
  repo: string,
  issue: number,
  comments: ReadonlyArray<{ readonly id: number; readonly body: string | null }>
): { readonly method: "POST" | "PATCH"; readonly path: string } => {
  const existing = comments.find((comment) => (comment.body ?? "").startsWith(marker))
  return existing === undefined
    ? { method: "POST", path: `repos/${repo}/issues/${issue}/comments` }
    : { method: "PATCH", path: `repos/${repo}/issues/comments/${existing.id}` }
}

interface Person {
  readonly login: string
  readonly type?: string | undefined
}

/** One entry of `GET /repos/{o}/{r}/issues/{n}/timeline`, the fields read here. */
export interface TimelineEntry {
  readonly event?: string | undefined
  readonly created_at?: string | undefined
  readonly updated_at?: string | undefined
  readonly actor?: Person | null | undefined
  readonly user?: Person | null | undefined
  readonly label?: { readonly name: string } | undefined
  readonly body?: string | null | undefined
}

// Comments scripts/issue-claim.mjs and the sweep post, whichever identity posts them.
export const bookkeeping = /^(?:Claimed by|Released by|Took over|Landed on main by issue-sweep)/

const ours = (person: Person | null | undefined) =>
  person != null && (person.type === "Bot" || person.login.endsWith("[bot]"))

const time = (at: string | undefined) => (at === undefined ? Number.NaN : Date.parse(at))

/**
 * Whether a `sweep:no-change` issue is worth another agent. The verdict's time
 * is the later of the last `labeled` event for the label and the last update
 * of the verdict comment. The issue requalifies when, after it, the label was
 * removed, or someone other than our bot commented, edited a comment, or
 * renamed the issue. Bookkeeping comments never count. With no `labeled`
 * event at all, it requalifies.
 */
export const requalifies = (entries: ReadonlyArray<TimelineEntry>, label = noChangeLabel): boolean => {
  const isLabel = (entry: TimelineEntry) => entry.label?.name === label
  const labeledAt = Math.max(
    ...entries.filter((entry) => entry.event === "labeled" && isLabel(entry)).map((entry) => time(entry.created_at))
  )
  if (!Number.isFinite(labeledAt)) return true
  const verdictAt = Math.max(
    labeledAt,
    ...entries
      .filter((entry) => entry.event === "commented" && (entry.body ?? "").startsWith(marker))
      .map((entry) => time(entry.updated_at ?? entry.created_at))
  )
  return entries.some((entry) => {
    switch (entry.event) {
      case "unlabeled":
        return isLabel(entry) && time(entry.created_at) > labeledAt
      case "commented": {
        const body = entry.body ?? ""
        if (ours(entry.user) || body.startsWith(marker) || bookkeeping.test(body)) return false
        return time(entry.created_at) > verdictAt || time(entry.updated_at) > verdictAt
      }
      case "renamed":
        return !ours(entry.actor) && time(entry.created_at) > verdictAt
      default:
        return false
    }
  })
}

const parse = <A>(text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as A,
    catch: (cause) => new HostFailed({ message: `GitHub answered no JSON: ${String(cause)}` })
  })

/** Whether the timeline of a `sweep:no-change` issue shows a human acted since the verdict. */
export const requalified = (repo: string, issue: number) =>
  api(`repos/${repo}/issues/${issue}/timeline?per_page=100`, ["--paginate", "--slurp"]).pipe(
    Effect.flatMap((text) => parse<ReadonlyArray<ReadonlyArray<TimelineEntry>>>(text)),
    Effect.map((pages) => requalifies(pages.flat()))
  )

/**
 * Records a no-change verdict on the issue: one marked comment, updated in
 * place on a later verdict, and the `sweep:no-change` label. `triaged` is the
 * need triage chose, when the verdict comes from triage instead of an agent.
 */
export const recordVerdict = (repo: string, issue: number, report: string, at: string, triaged?: Need) =>
  Effect.gen(function*() {
    const pages = yield* Effect.flatMap(
      api(`repos/${repo}/issues/${issue}/comments?per_page=100`, ["--paginate", "--slurp"]),
      (text) => parse<ReadonlyArray<ReadonlyArray<{ readonly id: number; readonly body: string | null }>>>(text)
    )
    const write = verdictWrite(repo, issue, pages.flat())
    yield* api(write.path, ["-X", write.method, "-f", `body=${verdictBody(report, at, triaged)}`])
    // Adding a label the repository lacks creates it.
    yield* api(`repos/${repo}/issues/${issue}/labels`, ["-X", "POST", "-f", `labels[]=${noChangeLabel}`])
  })
