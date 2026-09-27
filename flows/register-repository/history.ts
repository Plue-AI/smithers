/** Commit history analyses over one `git log` read. Pure: the host runs git, these read its text. */
import type { AgentShare, Commits, Contributors } from "./schema.ts"

export const DAY = 86_400
export const WEEKS = 12

/** The one `git log` shape these parsers read: a record separator, then fields, then numstat lines. */
export const LOG_FORMAT = "%x1e%H%x1f%ae%x1f%an%x1f%at%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)"

export interface FileChange {
  readonly path: string
  readonly added: number
  readonly deleted: number
}
export interface Commit {
  readonly sha: string
  readonly email: string
  readonly name: string
  readonly time: number
  readonly subject: string
  readonly coAuthors: ReadonlyArray<string>
  readonly files: ReadonlyArray<FileChange>
}

export const parseLog = (text: string): ReadonlyArray<Commit> =>
  text.split("\x1e").flatMap((record) => {
    const [header, ...rest] = record.split("\n")
    const fields = header?.split("\x1f") ?? []
    if (fields.length < 6 || !/^[0-9a-f]{40}$/.test(fields[0]!)) return []
    const files = rest.flatMap((line) => {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
      return match === null ? [] : [{
        path: match[3]!,
        added: match[1] === "-" ? 0 : Number(match[1]),
        deleted: match[2] === "-" ? 0 : Number(match[2])
      }]
    })
    return [{
      sha: fields[0]!,
      email: fields[1]!.toLowerCase(),
      name: fields[2]!,
      time: Number(fields[3]),
      subject: fields[4]!,
      coAuthors: fields[5]!.split("\x1d").map((value) => value.trim()).filter((value) => value !== ""),
      files
    }]
  })

const AGENT = /\b(claude|copilot|cursor|devin|codex|openai|anthropic|aider|jules|gemini|sweep|smithers)\b/i
const HOUSEKEEPING_BOTS = /^(dependabot|renovate|github-actions|pre-commit-ci|mergify|allcontributors)/i
const AGENT_BRANCH = /from [^/\s]+\/(claude|codex|copilot|cursor|devin|agent|ai)[/-]/i

/** Which traced agent evidence a commit carries, if any. */
export const agentTrace = (commit: Commit): string | undefined => {
  if (commit.coAuthors.some((value) => AGENT.test(value))) return "co-author trailer"
  const bot = /\[bot\]/.test(commit.name) || /\[bot\]@/.test(commit.email)
  if (bot && !HOUSEKEEPING_BOTS.test(commit.name) && AGENT.test(`${commit.name} ${commit.email}`)) return "agent author"
  if (AGENT_BRANCH.test(commit.subject)) return "agent branch"
  return undefined
}

const person = (commit: Commit) => !/\[bot\]/.test(commit.name) && !/\[bot\]@/.test(commit.email)

/** Commits inside the twelve months before `now`, newest first as git gives them. */
export const lastYear = (commits: ReadonlyArray<Commit>, now: number) =>
  commits.filter((commit) => commit.time > now - 365 * DAY && commit.time <= now)

/** A burst: more than 500 added lines over ten or more files within ten minutes of the author's previous commit. */
export const bursts = (commits: ReadonlyArray<Commit>): number => {
  const byAuthor = new Map<string, Array<Commit>>()
  for (const commit of commits) {
    const own = byAuthor.get(commit.email)
    if (own === undefined) byAuthor.set(commit.email, [commit])
    else own.push(commit)
  }
  let count = 0
  for (const own of byAuthor.values()) {
    const sorted = [...own].sort((a, b) => a.time - b.time)
    sorted.forEach((commit, index) => {
      const added = commit.files.reduce((sum, file) => sum + file.added, 0)
      const previous = sorted[index - 1]
      if (added > 500 && commit.files.length >= 10 && previous !== undefined && commit.time - previous.time < 600) {
        count += 1
      }
    })
  }
  return count
}

export const commitGraph = (commits: ReadonlyArray<Commit>, now: number): Commits => {
  const start = now - WEEKS * 7 * DAY
  const weeks = Array.from({ length: WEEKS }, (_, index) => ({
    start: new Date((start + index * 7 * DAY) * 1000).toISOString().slice(0, 10),
    people: 0,
    agents: 0
  }))
  const recent = commits.filter((commit) => commit.time > start && commit.time <= now)
  for (const commit of recent) {
    const week = weeks[Math.min(WEEKS - 1, Math.floor((commit.time - start) / (7 * DAY)))]!
    if (agentTrace(commit) !== undefined) week.agents += 1
    else week.people += 1
  }
  return { _tag: "commits", weeks, total: recent.length, bursts: bursts(recent) }
}

export const ADOPTION_MARKERS = ["AGENTS.md", "CLAUDE.md", ".cursor", ".cursorrules", ".github/copilot-instructions.md"]

export const agentShare = (commits: ReadonlyArray<Commit>, now: number, paths: ReadonlyArray<string>): AgentShare => {
  const year = lastYear(commits, now)
  const traces = new Set(year.flatMap((commit) => agentTrace(commit) ?? []))
  const present = new Set(paths)
  const markers = ADOPTION_MARKERS.filter((marker) =>
    present.has(marker) || paths.some((path) => path.startsWith(`${marker}/`))
  )
  return {
    _tag: "agent-share",
    commits: year.length,
    traced: year.filter((commit) => agentTrace(commit) !== undefined).length,
    markers: [...traces, ...markers]
  }
}

export const contributors = (commits: ReadonlyArray<Commit>, now: number): Contributors => {
  const counts = new Map<string, number>()
  for (const commit of lastYear(commits, now).filter(person)) {
    counts.set(commit.email, (counts.get(commit.email) ?? 0) + 1)
  }
  const shares = [...counts.values()].sort((a, b) => b - a)
  const total = shares.reduce((sum, count) => sum + count, 0)
  let core = 0, covered = 0
  while (core < shares.length && covered < total / 2) covered += shares[core++]!
  return {
    _tag: "contributors",
    total: shares.length,
    shares,
    core,
    coreShare: total === 0 ? 0 : Math.round((covered / total) * 100) / 100
  }
}

/**
 * Two-week churn proxy (signal S2): of the lines added in the last 180 days, the share that later
 * commits deleted from the same file within 14 days. Numstat cannot tell which lines, so each
 * deletion counts against the earliest unmatched additions to that file.
 */
export const churn = (commits: ReadonlyArray<Commit>, now: number): number => {
  const window = [...commits].filter((commit) => commit.time > now - 180 * DAY).sort((a, b) => a.time - b.time)
  const open = new Map<string, Array<{ time: number; lines: number }>>()
  let added = 0, rewritten = 0
  for (const commit of window) {
    for (const file of commit.files) {
      const pending = (open.get(file.path) ?? []).filter((entry) => commit.time - entry.time <= 14 * DAY)
      let deleted = file.deleted
      for (const entry of pending) {
        const taken = Math.min(entry.lines, deleted)
        entry.lines -= taken
        deleted -= taken
        rewritten += taken
      }
      added += file.added
      open.set(file.path, [...pending.filter((entry) => entry.lines > 0), { time: commit.time, lines: file.added }])
    }
  }
  return added === 0 ? 0 : rewritten / added
}

/** PR numbers named by merge and squash subjects. */
export const mergedPulls = (commits: ReadonlyArray<Commit>): ReadonlyArray<number> =>
  commits.flatMap((commit) => {
    const match = /^Merge pull request #(\d+)/.exec(commit.subject) ?? /\(#(\d+)\)\s*$/.exec(commit.subject)
    return match === null ? [] : [Number(match[1])]
  })
