import { Data, Effect, Schema } from "effect"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

/** Triage ranks are dispatch data; labels can override them. */
export interface TriageRow {
  readonly repo: string
  readonly n: number
  readonly type: string
  readonly severity: string
  readonly effort: string
  readonly needs_will: boolean
  readonly title: string
}

export interface Issue {
  readonly number: number
  readonly title: string
  readonly labels: ReadonlyArray<{ readonly name: string }>
  readonly body?: string
}

export interface ObservedIssue extends Issue {
  readonly body: string
}

export interface Candidate {
  readonly repo: string
  readonly n: number
  readonly title: string
  readonly blocked: boolean
  readonly severity: number
  readonly effort: number
  readonly boost: number
  /** False for Will's never-bundle classes; such an issue runs alone. */
  readonly bundleable: boolean
}

export interface History {
  readonly attempts?: number
  readonly last?: number
  readonly retryAfter?: number
  readonly closed?: boolean
  readonly willonly?: boolean
  readonly boost?: boolean
}

export interface SelectionOptions {
  /** Epoch seconds, supplied by the observer. Pure calls default to zero. */
  readonly now?: number
  readonly taken?: ReadonlySet<number>
  readonly reserved?: ReadonlySet<string>
  readonly skip?: ReadonlySet<string>
  readonly history?: Readonly<Record<string, History>>
}

export const repository = (repo: string): string => repo.includes("/") ? repo : `smithersai/${repo}`
export const issueKey = (repo: string, n: number): string => `${repository(repo)}#${n}`

export const RESERVED: ReadonlySet<string> = new Set(
  [2598, 2524, 2523, 2441, 2414, 2765].map((n) => issueKey("smithers", n))
)

const skipLabels = new Set(["epic", "wontfix", "invalid", "duplicate", "question", "needs-human-approval"])
const skipTitle = /^(blocked on will|epic\b|\[?epic|umbrella)/i
const severityRank: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3 }
const effortRank: Readonly<Record<string, number>> = { trivial: 0, easy: 1, hard: 2 }
/**
 * Will's never-bundle classes, matched in labels and titles: security, money,
 * merge/landing, unclear root cause, and cross-package design or architecture.
 */
const neverBundle = new RegExp(
  [
    "secur",
    "vulnerab",
    "\\bcve\\b",
    "credential",
    "secret",
    "billing",
    "pricing",
    "\\bprice",
    "\\bcredits?\\b",
    "payment",
    "invoice",
    "merge",
    "\\bland(?:s|ed|er|ing)?\\b",
    "root.?cause",
    "unclear",
    "cross.?package",
    "design",
    "architecture",
    "\\bepic\\b"
  ].join("|"),
  "i"
)

export const priority = (rows: ReadonlyArray<TriageRow>): ReadonlyMap<string, readonly [number, number, string]> =>
  new Map(rows.map((row) => [
    issueKey(row.repo, row.n),
    [severityRank[row.severity] ?? 4, effortRank[row.effort] ?? 1, row.type] as const
  ]))

/** Named production source files, excluding test files and test directories. */
export const areas = (body: string): ReadonlySet<string> => {
  const paths = body.matchAll(
    /(?<![\w/])(?:apps|packages|scripts|infra|internal|cmd|db|e2e)\/[A-Za-z0-9_./-]+\.(?:tsx?|go|mjs|js|py|rs|sql)\b/g
  )
  return new Set(
    Array.from(paths, (match) => match[0]).filter((path) =>
      !["/test/", "/tests/", ".test.", ".spec.", "_test."].some((part) => path.includes(part))
    )
  )
}

/** Exact dispatcher order: boost, unblocked, severity, effort, newest issue. */
const compare = (left: Candidate, right: Candidate): number =>
  left.boost - right.boost || Number(left.blocked) - Number(right.blocked)
  || left.severity - right.severity || left.effort - right.effort || right.n - left.n

export const candidates = (
  repo: string,
  issues: ReadonlyArray<Issue>,
  rows: ReadonlyArray<TriageRow>,
  options: SelectionOptions = {}
): { readonly candidates: ReadonlyArray<Candidate>; readonly pending: boolean } => {
  const ranks = priority(rows)
  const out: Array<Candidate> = []
  const now = options.now ?? 0
  let pending = false
  for (const issue of issues) {
    const key = issueKey(repo, issue.number)
    const labels = new Set(issue.labels.map((label) => label.name))
    const history = options.history?.[key] ?? {}
    // Only current GitHub evidence can classify open work as Will-only.
    // Old history/triage and dispatch filters cannot prove completion.
    const held = labels.has("in-progress") || labels.has("mega:in-progress")
    if (labels.has("will-only") && !held) continue
    pending = true
    if (
      options.taken?.has(issue.number) || (options.reserved ?? RESERVED).has(key)
      || options.skip?.has(key) || labels.has("in-progress") || labels.has("mega:in-progress")
      || Array.from(labels).some((label) => skipLabels.has(label)) || skipTitle.test(issue.title)
      || ranks.get(key)?.[2] === "epic" || history.closed || history.willonly
    ) continue
    if (now < (history.retryAfter ?? 0)) continue
    const attempts = history.attempts ?? 0
    const cooldown = Math.min(3 * 3600 * Math.max(1, attempts), 24 * 3600)
    if (attempts > 0 && now - (history.last ?? 0) < cooldown) continue
    const rank = ranks.get(key) ?? [2, 1, ""]
    let severity = rank[0]
    let effort = rank[1]
    if (labels.has("severity:critical")) severity = 0
    else if (labels.has("severity:high") || labels.has("security")) severity = Math.min(severity, 1)
    if (labels.has("size:hard")) effort = 2
    else if (labels.has("size:trivial")) effort = 0
    else if (labels.has("size:easy")) effort = 1
    out.push({
      repo: repository(repo),
      n: issue.number,
      title: issue.title,
      blocked: labels.has("blocked-on-will"),
      severity,
      effort,
      boost: history.boost ? 0 : 1,
      bundleable: ![issue.title, ...labels].some((text) => neverBundle.test(text))
    })
  }
  return { candidates: out.sort(compare), pending }
}

/** Bundle at most two simple, bundleable companions naming the same production source. */
export const pick_companions = (
  lead: Candidate,
  cands: ReadonlyArray<Candidate>,
  bodies: ReadonlyMap<number, string>,
  taken: ReadonlySet<number> = new Set()
): ReadonlyArray<Candidate> => {
  if (!lead.bundleable || lead.blocked || lead.effort >= 2 || lead.severity < 2) return []
  const files = areas(bodies.get(lead.n) ?? "")
  if (files.size === 0) return []
  return cands
    .filter((candidate) =>
      repository(candidate.repo) === repository(lead.repo) && candidate.n !== lead.n && !taken.has(candidate.n)
      && candidate.bundleable && !candidate.blocked && candidate.effort < 2 && candidate.severity >= 2
    )
    .map((candidate) => ({
      candidate,
      score: Array.from(areas(bodies.get(candidate.n) ?? "")).filter((path) => files.has(path)).length
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score - left.score || left.candidate.effort - right.candidate.effort || left.candidate.n - right.candidate.n
    )
    .slice(0, 2)
    .map(({ candidate }) => candidate)
}

export class IssueReadError extends Data.TaggedError("IssueReadError")<{
  readonly operation: "triage" | "github"
  readonly detail: string
}> {}

const TriageRows = Schema.Array(Schema.Struct({
  repo: Schema.String,
  n: Schema.Number,
  type: Schema.String,
  severity: Schema.String,
  effort: Schema.String,
  needs_will: Schema.Boolean,
  title: Schema.String
}))
const Issues = Schema.Array(Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  body: Schema.optional(Schema.NullOr(Schema.String))
}))
const execute = promisify(execFile)

const listIssues = async (repo: string, signal: AbortSignal): Promise<string> => {
  const result = await execute("gh", [
    "issue",
    "list",
    "--repo",
    repository(repo),
    "--state",
    "open",
    "--limit",
    "1000",
    "--json",
    "number,title,labels,body"
  ], { signal, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 })
  return result.stdout
}

export interface ObserveOptions {
  readonly repo: string
  readonly triagePath?: string
  readonly selection?: SelectionOptions
  /** Host/test boundary; production uses gh issue list. */
  readonly command?: (repo: string, signal: AbortSignal) => Promise<string>
}

/** Reads each repository once per observation, with no stale body cache. */
export const observeIssues = (options: ObserveOptions) =>
  Effect.gen(function*() {
    const rows = yield* Effect.tryPromise({
      try: async (signal) => {
        const path = options.triagePath ?? join(homedir(), "Smithers-Ops", "dispatch", "final.json")
        let text: string
        try {
          text = await readFile(path, { encoding: "utf8", signal })
        } catch (error) {
          // Triage is optional; unavailable GitHub evidence is never an empty queue.
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
          throw error
        }
        return Schema.decodeUnknownSync(TriageRows)(JSON.parse(text))
      },
      catch: (error) => new IssueReadError({ operation: "triage", detail: String(error) })
    })
    const issues = yield* Effect.tryPromise({
      try: async (signal): Promise<ReadonlyArray<ObservedIssue>> => {
        const text = await (options.command ?? listIssues)(repository(options.repo), signal)
        return Schema.decodeUnknownSync(Issues)(JSON.parse(text)).map((issue) => ({ ...issue, body: issue.body ?? "" }))
      },
      catch: (error) => new IssueReadError({ operation: "github", detail: String(error) })
    })
    return {
      ...candidates(options.repo, issues, rows, { now: Date.now() / 1000, ...options.selection }),
      issues
    }
  })

export interface Bundle {
  readonly repo: string
  readonly lead: { readonly repo: string; readonly n: number; readonly title: string }
  readonly extras: ReadonlyArray<{ readonly repo: string; readonly n: number; readonly title: string }>
  readonly severity: string
  readonly effort: string
}

export interface SelectOptions {
  readonly repos: ReadonlyArray<string>
  readonly exclude?: ReadonlySet<string>
  readonly triagePath?: string
  readonly selection?: Omit<SelectionOptions, "taken">
  readonly command?: ObserveOptions["command"]
}

/** Observes and bundles repositories in configured order, assigning each issue once. */
export const selectCandidates = (options: SelectOptions) =>
  Effect.gen(function*() {
    const { taken: ignoredTaken, ...selection } = (options.selection ?? {}) as SelectionOptions
    void ignoredTaken
    const bundles: Array<Bundle> = []
    let openIssues = 0
    let pending = false
    for (const repo of new Set(options.repos.map(repository))) {
      const skip = new Set([...(options.selection?.skip ?? []), ...(options.exclude ?? [])])
      const selected = yield* observeIssues({
        repo,
        ...(options.triagePath === undefined ? {} : { triagePath: options.triagePath }),
        ...(options.command === undefined ? {} : { command: options.command }),
        selection: { ...selection, skip }
      })
      openIssues += selected.issues.length
      pending ||= selected.pending
      const bodies = new Map(selected.issues.map((issue) => [issue.number, issue.body]))
      const taken = new Set<number>()
      for (const lead of selected.candidates) {
        if (taken.has(lead.n)) continue
        const extras = pick_companions(lead, selected.candidates, bodies, taken)
        for (const issue of [lead, ...extras]) taken.add(issue.n)
        const ref = (issue: Candidate) => ({ repo, n: issue.n, title: issue.title })
        bundles.push({
          repo,
          lead: ref(lead),
          extras: extras.map(ref),
          severity: ["critical", "high", "medium", "low"][lead.severity] ?? "unknown",
          effort: lead.effort === 0 ? "trivial" : lead.effort === 1 ? "easy" : "hard"
        })
      }
    }
    return { candidates: bundles, openIssues, pending }
  })
