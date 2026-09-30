import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Ready } from "./schema.ts"

/** Typed reason recorded when landing is refused. */
export const ISSUE_CLOSED = "issue_closed"

export interface Refusal {
  readonly key: string
  readonly reason: typeof ISSUE_CLOSED
  readonly issues: ReadonlyArray<number>
}

export interface ClosedGuardDeps {
  /** Reads the current GitHub state of one issue, through the host's own client. */
  readonly view: (repo: string, n: number) => Promise<string>
  /** Releases the claim on one issue with the given note. */
  readonly release: (repo: string, n: number, by: string, note: string) => Promise<boolean>
  readonly receiptsDir?: string
}

const defaultReceiptsDir = () => join(homedir(), "Smithers-Ops/burndown/landings")

/**
 * Landing needs an open issue. When any member issue is closed, nothing lands,
 * every claim is released as `issue_closed`, and `<key>.refused.json` keeps the
 * prepared commits for the operator. Repeating the call rewrites the same
 * receipt and releases nothing new. An unreadable state is an error, never a
 * permit: the caller skips landing this round.
 */
export const refuseIfClosed = async (member: Ready, deps: ClosedGuardDeps): Promise<Refusal | undefined> => {
  const { assignment, result } = member
  const issues = [assignment.lead, ...assignment.extras].map((issue) => issue.n)
  const closed: Array<number> = []
  for (const n of issues) {
    if ((await deps.view(assignment.repo, n)).trim().toUpperCase() === "CLOSED") closed.push(n)
  }
  if (closed.length === 0) return undefined
  const dir = deps.receiptsDir ?? defaultReceiptsDir()
  const path = join(dir, `${result.key}.refused.json`)
  const prior = await readFile(path, "utf8").then((text) => JSON.parse(text) as { at?: string }, () => undefined)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path,
    JSON.stringify(
      {
        version: 1,
        key: result.key,
        repo: assignment.repo,
        reason: ISSUE_CLOSED,
        closed,
        commits: result.commits,
        at: prior?.at ?? new Date().toISOString()
      },
      null,
      2
    ) + "\n"
  )
  for (const n of issues) await deps.release(assignment.repo, n, `burndown-${assignment.key}`, ISSUE_CLOSED)
  return { key: result.key, reason: ISSUE_CLOSED, issues: closed }
}
