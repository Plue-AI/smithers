import { flowArgs } from "../flows/FlowArgs"
import { DiffSurface } from "../ViewModules"
import { flowAction } from "../flows/FlowAction"
/*
 * The commit cards: a repository's commits list ("commit-list", GitHub's
 * Commits page: rows grouped under "Commits on <day>") and one commit
 * ("commit": message, people, parents and the diff). The commit head is
 * `@smthrs/ui`'s Commit artifact; each file's hunks reuse DiffSurface, the
 * surface ChangeCards' diff facet draws with. Every act is a flow through
 * onRunCommand with data-flow set: a row opens commits.read, a parent opens
 * commits.read, a sha copies through chat.copy-message. Arrow keys, j and k
 * move between rows; Enter opens the focused one.
 */
import {
  Commit,
  CommitAuthor,
  CommitFile,
  CommitFiles,
  CommitHash,
  CommitHeader,
  CommitInfo,
  CommitMessage,
  CommitMetadata
} from "@smthrs/ui"
import type { CommitFileStatusKind } from "@smthrs/ui"
import { Suspense } from "react"
import type { KeyboardEvent } from "react"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"

/*
 * What a commit card's failure says, by the part that failed; the seam's own
 * words stay behind Details. Only the diff read has a re-read to offer.
 */
export const COMMIT_FAILURES: Readonly<Record<"list" | "commit" | "diff", UserFailureCopy>> = {
  list: { fault: "infra", sentence: "Smithers could not load every commit. Not your fault.", actions: [] },
  commit: { fault: "infra", sentence: "Smithers could not load this commit. Not your fault.", actions: [] },
  diff: { fault: "infra", sentence: "Smithers could not load this commit's diff. Not your fault.", actions: ["retry"] }
}
import { Avatar, RelativeTime } from "./GithubParts"

/*
 * The hunks, lazily (DiffSurface pulls the heavy pierre adapter). A chunk that
 * fails to load must not take the commit down with it: the patch the seam
 * carried is rendered verbatim instead, which is what DiffSurface itself falls
 * back to for a patch pierre cannot read.
 */

type CommitListCard = Extract<Card, { kind: "commit-list" }>
type CommitCard = Extract<Card, { kind: "commit" }>
type Summary = CommitListCard["payload"]["commits"][number]

/** The login a row shows: the stated login, else the author's name. */
const personOf = (author: Summary["author"]) => ({
  login: author.login ?? author.name ?? author.email ?? "unknown",
  ...(author.avatarUrl === undefined ? {} : { avatarUrl: author.avatarUrl })
})

/** "Commits on Sep 10, 2026", in the viewer's local day. */
export const dayLabel = (iso: string | null): string =>
  iso === null ?
    "Commits with no date" :
    `Commits on ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`

/** Rows grouped by local day, in list order (the list is newest first). */
export const groupByDay = (commits: ReadonlyArray<Summary>): ReadonlyArray<{ readonly label: string; readonly commits: ReadonlyArray<Summary> }> => {
  const groups: Array<{ label: string; commits: Summary[] }> = []
  for (const commit of commits) {
    const label = dayLabel(commit.authoredAt)
    const last = groups[groups.length - 1]
    if (last !== undefined && last.label === label) last.commits.push(commit)
    else groups.push({ label, commits: [commit] })
  }
  return groups
}

/**
 * Row navigation inside a list card: ArrowDown/j and ArrowUp/k move focus
 * between the `[data-row-open]` buttons, Home and End jump. Focus only; the
 * act stays the button's own flow.
 */
export const moveRowFocus = (event: KeyboardEvent<HTMLElement>): void => {
  const keys: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }
  if (!(event.key in keys) && event.key !== "Home" && event.key !== "End") return
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-row-open]")]
  if (rows.length === 0) return
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 :
    at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + keys[event.key]!))
  event.preventDefault()
  rows[next]?.focus()
}

const STATUS_TEXT: Record<NonNullable<Summary["status"]>, { readonly glyph: string; readonly label: string }> = {
  success: { glyph: "✓", label: "All checks passed" },
  failure: { glyph: "✕", label: "Some checks failed" },
  pending: { glyph: "●", label: "Checks in progress" }
}

const StatusBadge = ({ status }: { readonly status: Summary["status"] }) =>
  status === undefined ? null : (
    <span className="commit-status" data-status={status} role="img" aria-label={STATUS_TEXT[status].label} title={STATUS_TEXT[status].label}>
      {STATUS_TEXT[status].glyph}
    </span>
  )

const VerifiedBadge = ({ verified }: { readonly verified: boolean | undefined }) =>
  verified === true ? <span className="commit-verified">Verified</span> : null

/** The short sha as a copy button: the clipboard write is chat.copy-message's. */
const ShaChip = ({ sha, onRunCommand }: { readonly sha: string; readonly onRunCommand: RunCommand }) => (
  <button
    type="button"
    className="commit-sha"
    aria-label={`Copy full SHA ${sha}`}
    title={`Copy ${sha}`}
    {...flowAction(onRunCommand, "chat.copy-message", sha)}
  >
    <code>{sha.slice(0, 7)}</code>
  </button>
)

/** What commits.read names for a row: the change id when there is one. */
const refOf = (commit: Summary): string => commit.changeId ?? commit.commitId

export const CommitListBody = ({ card, onRunCommand }: { readonly card: CommitListCard; readonly onRunCommand: RunCommand }) => {
  const { repo, branch, commits, truncated, error } = card.payload
  return (
    <section className="commit-list" aria-label={`Commits${branch === null ? "" : ` on ${branch}`}`} onKeyDown={moveRowFocus}>
      <p className="commit-list-head">
        {commits.length} {commits.length === 1 ? "commit" : "commits"}
        {branch === null ? null : <> on <code>{branch}</code></>}
        {truncated === true ? " · the newest shown" : null}
      </p>
      {error !== undefined ?
        <FailureNotice className="sui-approval-error" data-testid="commit-list-failure" failure={describedFailure("CommitList.read", COMMIT_FAILURES.list, error)} /> :
        null}
      {commits.length === 0 ?
        <p className="world-card-empty">No commits in {repo} yet.</p> :
        groupByDay(commits).map((group) => (
          <div key={group.label} className="commit-day">
            <h4 className="commit-day-label">{group.label}</h4>
            <ol className="commit-rows">
              {group.commits.map((commit) => (
                <li key={commit.commitId} className="commit-row" data-commit-id={commit.commitId}>
                  <div className="commit-row-main">
                    <button
                      type="button"
                      className="commit-row-open"
                      data-row-open
                      {...flowAction(onRunCommand, "commits.read", flowArgs("commits.read", { ref: refOf(commit), repo }))}
                    >
                      {commit.title}
                    </button>
                    <span className="commit-row-meta">
                      <Avatar person={personOf(commit.author)} size={16} />
                      <span className="commit-row-author">{personOf(commit.author).login}</span>
                      {commit.authoredAt === null ? null : <>committed <RelativeTime iso={commit.authoredAt} /></>}
                    </span>
                  </div>
                  <span className="commit-row-side">
                    <VerifiedBadge verified={commit.verified} />
                    <StatusBadge status={commit.status} />
                    <ShaChip sha={commit.commitId} onRunCommand={onRunCommand} />
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
    </section>
  )
}

const FILE_STATUS: ReadonlyArray<CommitFileStatusKind> = ["added", "modified", "deleted", "renamed", "copied"]
const fileStatus = (changeType: string): CommitFileStatusKind =>
  FILE_STATUS.find((kind) => kind === changeType) ?? "modified"

export const CommitDetailBody = ({ card, onRunCommand }: { readonly card: CommitCard; readonly onRunCommand: RunCommand }) => {
  const { repo, commit, message, committer, parents, files, diffError, error } = card.payload
  const author = personOf(commit.author)
  return (
    <div className="commit-detail">
      {error !== undefined ?
        <FailureNotice className="sui-approval-error" data-testid="commit-failure" failure={describedFailure("Commit.read", COMMIT_FAILURES.commit, error)} /> :
        null}
      <Commit>
        <CommitHeader>
          <Avatar person={author} size={20} />
          <CommitAuthor>{author.login}</CommitAuthor>
          {commit.author.email === null ? null : <span className="commit-email">{commit.author.email}</span>}
          <CommitInfo>
            {commit.authoredAt === null ? null : <RelativeTime iso={commit.authoredAt} />}
            <VerifiedBadge verified={commit.verified} />
            <StatusBadge status={commit.status} />
          </CommitInfo>
        </CommitHeader>
        <CommitMessage>{message}</CommitMessage>
        <CommitMetadata>
          <span>
            commit <ShaChip sha={commit.commitId} onRunCommand={onRunCommand} />
          </span>
          {commit.changeId === null ? null : <span>change <CommitHash hash={commit.commitId} changeId={commit.changeId} short={false} /></span>}
          {committer === undefined || committer === null ? null : (
            <span>committed by {committer.login ?? committer.name ?? committer.email}</span>
          )}
          <span className="commit-parents">
            {parents.length === 0 ? "no parents" : parents.length === 1 ? "1 parent" : `${parents.length} parents`}
            {parents.map((parent) => {
              const ref = parent.changeId ?? parent.commitId
              if (ref === null) return null
              return <button
                key={ref}
                type="button"
                className="commit-sha"
                data-row-open
                {...flowAction(onRunCommand, "commits.read", flowArgs("commits.read", { ref, repo }))}
              >
                <code>{(parent.commitId ?? parent.changeId ?? "").slice(0, 7)}</code>
              </button>
            })}
          </span>
        </CommitMetadata>
        {files.length > 0 ?
          (
            <CommitFiles>
              {files.map((file) => (
                <CommitFile
                  key={file.path}
                  file={{
                    path: file.path,
                    status: fileStatus(file.changeType),
                    additions: file.additions,
                    deletions: file.deletions,
                    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath })
                  }}
                />
              ))}
            </CommitFiles>
          ) :
          null}
      </Commit>
      {diffError !== undefined ?
        <FailureNotice role="status" className="world-card-empty" data-testid="commit-diff-failure"
          failure={describedFailure("Commit.diff", COMMIT_FAILURES.diff, diffError)}
          actions={{ retry: flowAction(onRunCommand, "commits.read", flowArgs("commits.read", { ref: refOf(commit), repo })) }} /> :
        null}
      {diffError === undefined && files.length === 0 ? <p className="world-card-empty">This commit changes no files.</p> : null}
      {files.map((file) => (
        <section key={`diff-${file.path}`} className="commit-diff" aria-label={`Diff of ${file.path}`}>
          <h4 className="commit-diff-path">
            <code>{file.path}</code> <span className="commit-diff-stat">+{file.additions} −{file.deletions}</span>
          </h4>
          {file.isBinary ?
            <p className="world-card-empty">{file.path} is binary, so its diff is not shown here.</p> :
            file.patch === undefined ?
            <p className="world-card-empty">No patch was returned for {file.path}.</p> :
            (
              <Suspense fallback={<pre className="world-card-path">{file.patch}</pre>}>
                <DiffSurface path={file.path} oldPath={file.oldPath} patch={file.patch} />
              </Suspense>
            )}
        </section>
      ))}
    </div>
  )
}

export const commitCardFamily: CardFamily<"commit-list" | "commit"> = {
  "commit-list": { render: (card, actions) => <CommitListBody card={card} onRunCommand={actions.onRunCommand} />, pill: settledPill },
  commit: { render: (card, actions) => <CommitDetailBody card={card} onRunCommand={actions.onRunCommand} />, pill: settledPill }
}
