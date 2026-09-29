import { ViewSkeleton } from "../ViewSkeleton"
import { DiffSurface } from "../ViewModules"
import { flowAction } from "../flows/FlowAction"
/*
 * The PR (landing) cards: the list ("pr-list") and the detail ("pr"), laid
 * out like GitHub's pull requests (ported from multi src/landings:
 * LandingsListView's rows and LandingDetailView's header, tab bar, commits
 * tab, files tab and merge box). A land is QUEUED (202) — the card language
 * says "queued", never a terminal claim. Every act binds a registered command
 * through onRunCommand and carries data-flow (parity.test.ts gates this); the
 * tab bar is local presentation state (setPrTab, allowlisted there).
 */
import { Button, Markdown } from "@smthrs/ui"
import { Suspense } from "react"
import { flowArgs } from "../flows/FlowArgs"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
import {
  Avatar,
  AvatarStack,
  BADGE_CLASS,
  checkDisplay,
  CommentBox,
  LabelPill,
  people,
  prDisplay,
  RelativeTime,
  repoLabel,
  SideSection,
  StateIcon,
  StatePill,
  TONE_CLASS,
  type Tone
} from "./GithubParts"
import { Octicon } from "./Octicon"

/* The diff renderer is heavy; like ChangeCards, load it only when a file is shown. */


export interface LandingCardActions {
  readonly onRunCommand: RunCommand
}

type LandingRow = Extract<Card, { kind: "pr-list" }>["payload"]["landings"][number]
type LandingPayload = Extract<Card, { kind: "pr" }>["payload"]

/** Row facts the rpc schema does not declare yet; rendered when a read carries them. */
interface LandingRowExtras {
  readonly draft?: boolean
  readonly reviewsRequested?: number
  readonly createdAt?: string | null
  readonly comments?: number
  readonly baseBranch?: string
  readonly labels?: ReadonlyArray<string>
  readonly labelColors?: Readonly<Record<string, string>>
  readonly additions?: number
  readonly deletions?: number
  readonly assignees?: ReadonlyArray<{ readonly login: string; readonly avatar?: string | undefined }>
  readonly reviewers?: ReadonlyArray<{ readonly login: string; readonly avatar?: string | undefined }>
}

type LandingFile = NonNullable<LandingPayload["files"]>[number]
type LandingCommit = NonNullable<LandingPayload["commits"]>[number]

const BranchChip = ({ name }: { readonly name: string }) => (
  <span className="ghc-branch"><Octicon name="git-branch" size={12} /> {name}</span>
)

const LandingListRow = ({ repo, landing, onRunCommand }: { readonly repo: string; readonly landing: LandingRow } & LandingCardActions) => {
  const extra = landing as LandingRow & LandingRowExtras
  const labels = extra.labels ?? []
  const avatars = people(extra.reviewers ?? extra.assignees)
  return (
    <li className="ghc-row" data-landing={landing.number}>
      <button
        type="button"
        className="ghc-row-btn"
        aria-label={`Open pull request #${landing.number}: ${landing.title}`}
        {...flowAction(onRunCommand, "prs.view", flowArgs("prs.view", { number: landing.number, repo }))}
      >
        <StateIcon display={prDisplay(landing.state, extra.draft)} />
        <span className="ghc-row-main">
          <span className="ghc-row-title">
            <span className="ghc-row-title-text">{landing.title}</span>
            {labels.map((label) => <LabelPill key={label} name={label} color={extra.labelColors?.[label]} />)}
          </span>
          <span className="ghc-row-meta">
            #{landing.number}
            {landing.author !== null ? <> · opened by <span className="ghc-author-muted">{landing.author}</span></> : null}
            {extra.createdAt != null ? <> <RelativeTime iso={extra.createdAt} /></> : null}
            {extra.createdAt == null && landing.updatedAt !== null ? <> · updated <RelativeTime iso={landing.updatedAt} /></> : null}
            {landing.branch !== undefined ?
              <>
                {" · "}
                <BranchChip name={landing.branch} />
                {extra.baseBranch !== undefined ? <> → <BranchChip name={extra.baseBranch} /></> : null}
              </> :
              null}
          </span>
          {landing.files !== undefined && landing.files.length > 0 ?
            (
              <span className="ghc-row-files" data-landing-files="">
                <Octicon name="file-diff" size={12} /> touches {landing.files.join(", ")}
              </span>
            ) :
            null}
        </span>
        <span className="ghc-row-side">
          {extra.additions !== undefined || extra.deletions !== undefined ?
            <span className="ghc-diffstat"><span className="ghc-add">+{extra.additions ?? 0}</span> <span className="ghc-del">−{extra.deletions ?? 0}</span></span> :
            null}
          {avatars.length > 0 ? <AvatarStack people={avatars} /> : null}
          {extra.reviewsRequested !== undefined && extra.reviewsRequested > 0 ?
            (
              <span className="ghc-row-count" aria-label={`${extra.reviewsRequested} reviews requested`}>
                <Octicon name="eye" /> {extra.reviewsRequested}
              </span>
            ) :
            null}
          {extra.comments !== undefined && extra.comments > 0 ?
            (
              <span className="ghc-row-count" aria-label={`${extra.comments} comments`}>
                <Octicon name="comment" /> {extra.comments}
              </span>
            ) :
            null}
        </span>
      </button>
    </li>
  )
}

export const LandingListCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "pr-list" }> } & LandingCardActions) => {
  const { repo, landings } = card.payload
  const open = landings.filter((landing) => prDisplay(landing.state).tone === "open").length
  return (
    <div className="ghc ghc-box" data-testid="pr-list">
      <div className="ghc-toolbar">
        <span className="ghc-count" data-active="true"><Octicon name="git-pull-request" /> {open} Open</span>
        {landings.length - open > 0 ? <span className="ghc-count"><Octicon name="check" /> {landings.length - open} Other</span> : null}
        <span className="ghc-toolbar-repo">{repoLabel(repo)}</span>
      </div>
      {landings.length === 0 ?
        (
          <p className="world-card-empty ghc-empty">
            <Octicon name="git-pull-request" size={24} />
            <span>{card.body ?? `No pull requests in ${repoLabel(repo)}.`}</span>
          </p>
        ) :
        (
          <ul className="ghc-rows">
            {landings.map((landing) => <LandingListRow key={landing.number} repo={repo} landing={landing} onRunCommand={onRunCommand} />)}
          </ul>
        )}
    </div>
  )
}

type PrTab = "conversation" | "commits" | "checks" | "files"

const reviewVerb = (type: string): { readonly icon: "check" | "file-diff" | "comment"; readonly tone: Tone; readonly verb: string } => {
  const word = type.toLowerCase()
  if (word === "approved" || word === "approve") return { icon: "check", tone: "open", verb: "approved these changes" }
  if (word.includes("change")) return { icon: "file-diff", tone: "closed", verb: "requested changes" }
  return { icon: "comment", tone: "draft", verb: "reviewed" }
}

const checksSummary = (checks: LandingPayload["checks"]): { readonly tone: Tone; readonly icon: "check-circle-fill" | "x-circle-fill" | "dot-fill"; readonly text: string } => {
  if (checks.length === 0) return { tone: "draft", icon: "dot-fill", text: "No checks reported" }
  const tones = checks.map((check) => checkDisplay(check.state).tone)
  const failing = tones.filter((tone) => tone === "closed").length
  if (failing > 0) return { tone: "closed", icon: "x-circle-fill", text: `${failing} failing ${failing === 1 ? "check" : "checks"}` }
  if (tones.some((tone) => tone === "queued")) return { tone: "queued", icon: "dot-fill", text: "Some checks haven't completed yet" }
  return { tone: "open", icon: "check-circle-fill", text: "All checks have passed" }
}

/* A tab whose read failed, by tab; the seam's own words stay behind Details. */
export const LANDING_READ_FAILURES: Readonly<Record<"commits" | "files", UserFailureCopy>> = {
  commits: { fault: "infra", sentence: "Smithers could not load the commits of this pull request. Not your fault.", actions: ["retry"] },
  files: { fault: "infra", sentence: "Smithers could not load the files of this pull request. Not your fault.", actions: ["retry"] }
}

const ReadFailure = ({ tab, detail, retry }: { readonly tab: "commits" | "files"; readonly detail: string; readonly retry: ReturnType<typeof flowAction> }) => (
  <FailureNotice className="ghc-tab-empty" data-testid={`landing-${tab}-failure`}
    failure={describedFailure(`LandingRead.${tab}`, LANDING_READ_FAILURES[tab], detail)} actions={{ retry }} />
)

const CommitsTab = ({ commits, error, retry }: { readonly commits: ReadonlyArray<LandingCommit> | undefined; readonly error?: string; readonly retry: ReturnType<typeof flowAction> }) => {
  if (error !== undefined) return <ReadFailure tab="commits" detail={error} retry={retry} />
  if (commits === undefined) return <p className="ghc-tab-empty">Commits unavailable.</p>
  if (commits.length === 0) return <p className="ghc-tab-empty">No commits in this stack.</p>
  return (
    <ul className="ghc-box ghc-rows ghc-commits">
      {commits.map((commit, index) => {
        const id = commit.commitId ?? commit.changeId ?? ""
        return (
          <li key={id === "" ? index : id} className="ghc-commit">
            <span className="ghc-commit-icon"><Octicon name="git-commit" /></span>
            <span className="ghc-row-main">
              <span className="ghc-commit-title">{commit.message.split("\n")[0] || id}</span>
              <span className="ghc-row-meta">
                {commit.author != null ? <span className="ghc-author-muted">{commit.author}</span> : null}
                {commit.author != null && commit.timestamp != null ? " · " : null}
                {commit.timestamp != null ? <RelativeTime iso={commit.timestamp} /> : null}
              </span>
            </span>
            {id !== "" ? <code className="ghc-sha">{id.slice(0, 8)}</code> : null}
          </li>
        )
      })}
    </ul>
  )
}

const FilesTab = ({ files, error, retry }: { readonly files: ReadonlyArray<LandingFile> | undefined; readonly error?: string; readonly retry: ReturnType<typeof flowAction> }) => {
  if (error !== undefined) return <ReadFailure tab="files" detail={error} retry={retry} />
  if (files === undefined) return <p className="ghc-tab-empty">Files unavailable.</p>
  if (files.length === 0) return <p className="ghc-tab-empty">No file changes in this pull request.</p>
  return (
    <div className="ghc-files">
      {files.map((file) => (
        <section key={file.path} className="ghc-box ghc-file" aria-label={file.path}>
          <header className="ghc-file-head">
            <Octicon name={file.status === "added" ? "file" : "file-diff"} />
            <span className="ghc-mono ghc-file-path">{file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path}</span>
            {file.additions !== undefined || file.deletions !== undefined ?
              (
                <span className="ghc-diffstat">
                  <span className="ghc-add">+{file.additions ?? 0}</span> <span className="ghc-del">−{file.deletions ?? 0}</span>
                </span>
              ) :
              null}
          </header>
          {file.patch !== undefined ?
            (
              <Suspense fallback={<ViewSkeleton />}>
                <DiffSurface path={file.path} oldPath={file.oldPath} patch={file.patch} />
              </Suspense>
            ) :
            null}
        </section>
      ))}
    </div>
  )
}

export const LandingCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "pr" }> } & LandingCardActions) => {
  const { repo, number, title, state, author, prBody, reviews, checks } = card.payload
  const extra = card.payload
  const actionable = ["open", "draft", "failed"].includes(state.toLowerCase())
  const canLand = actionable && state.toLowerCase() !== "draft" && !extra.draft
  const tab = card.payload.tab ?? "conversation"
  const summary = checksSummary(checks)
  const additions = (extra.files ?? []).reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const deletions = (extra.files ?? []).reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const tabs: ReadonlyArray<readonly [PrTab, string, "comment" | "git-commit" | "check" | "file-diff", number | undefined]> = [
    ["conversation", "Conversation", "comment", reviews.length],
    ["commits", "Commits", "git-commit", extra.commits?.length],
    ["checks", "Checks", "check", checks.length],
    ["files", "Files changed", "file-diff", extra.files?.length]
  ]
  const reviewers = [...new Set(reviews.flatMap((review) => review.author !== null ? [review.author] : []))]
  const commitCount = extra.commits?.length
  const retry = flowAction(onRunCommand, "prs.view", flowArgs("prs.view", { number, repo }))
  return (
    <article className="ghc ghc-detail" data-landing={number}>
      <header className="ghc-detail-head">
        <h3 className="ghc-detail-title">
          {title} <span className="ghc-detail-number">#{number}</span>
        </h3>
        <div className="ghc-detail-sub">
          <StatePill display={prDisplay(state, extra.draft)} />
          <span>
            <strong className="ghc-author">{author ?? "Someone"}</strong>
            {extra.branch !== undefined ?
              <>
                {` wants to merge ${commitCount !== undefined ? `${commitCount} ${commitCount === 1 ? "commit" : "commits"} ` : ""}into `}
                <BranchChip name={extra.baseBranch ?? "main"} /> from <BranchChip name={extra.branch} />
              </> :
              " opened this pull request"}
            {extra.createdAt != null ? <> <RelativeTime iso={extra.createdAt} /></> : null}
            {` · ${repoLabel(repo)}`}
          </span>
        </div>
      </header>
      <div className="ghc-tabs" role="tablist" aria-label={`Pull request #${number} tabs`}>
        {tabs.map(([name, label, icon, count]) => (
          <button
            key={name}
            type="button"
            role="tab"
            className="ghc-tab"
            aria-selected={tab === name}
            {...flowAction(onRunCommand, "prs.tab", flowArgs("prs.tab", { cardId: card.id, tab: name }))}
          >
            <Octicon name={icon} /> {label}
            {count !== undefined ? <span className="ghc-tab-count">{count}</span> : null}
            {name === "files" && extra.files !== undefined && extra.files.length > 0 ?
              <span className="ghc-diffstat"><span className="ghc-add">+{additions}</span> <span className="ghc-del">−{deletions}</span></span> :
              null}
          </button>
        ))}
      </div>
      <div className="ghc-detail-grid" role="tabpanel">
        <div className="ghc-detail-main">
          {tab === "conversation" ?
            (
              <>
                <CommentBox author={author} avatarUrl={extra.authorAvatar} createdAt={extra.createdAt} verb="opened this pull request">
                  {prBody === "" ?
                    <p className="world-card-empty ghc-muted">No description provided.</p> :
                    <Markdown className="smithers-card-markdown" content={prBody} />}
                </CommentBox>
                {reviews.length === 0 ?
                  <p className="ghc-event"><span className="ghc-event-badge"><Octicon name="eye" size={14} /></span> No reviews yet.</p> :
                  reviews.map((review, index) => {
                    const verb = reviewVerb(review.type)
                    return (
                      <div key={index} className="ghc-review">
                        <p className="ghc-event">
                          <span className={`ghc-event-badge ${BADGE_CLASS[verb.tone]}`}><Octicon name={verb.icon} size={14} /></span>
                          <strong className="ghc-author">{review.author ?? "Someone"}</strong> {verb.verb}
                        </p>
                        {review.reviewBody !== "" ?
                          (
                            <CommentBox author={review.author} verb="reviewed">
                              <Markdown className="smithers-card-markdown" content={review.reviewBody} />
                            </CommentBox>
                          ) :
                          null}
                      </div>
                    )
                  })}
              </>
            ) :
            null}
          {tab === "commits" ? <CommitsTab commits={extra.commits} error={extra.readErrors?.commits} retry={retry} /> : null}
          {tab === "files" ? <FilesTab files={extra.files} error={extra.readErrors?.files} retry={retry} /> : null}
          {tab === "conversation" || tab === "checks" ?
            (
              <section className="ghc-box ghc-merge" aria-label="Checks and landing">
                <header className={`ghc-merge-head ${TONE_CLASS[summary.tone]}`}>
                  <Octicon name={summary.icon} size={20} />
                  <span className="ghc-merge-title">{summary.text}</span>
                </header>
                {checks.length > 0 ?
                  (
                    <ul className="ghc-rows">
                      {checks.map((check) => {
                        const display = checkDisplay(check.state)
                        return (
                          <li key={check.context} className="ghc-check">
                            <StateIcon display={display} />
                            <span className="ghc-check-name">{check.context}</span>
                            <span className="ghc-check-state">{check.state}</span>
                          </li>
                        )
                      })}
                    </ul>
                  ) :
                  null}
                {actionable && <footer className="ghc-merge-foot">
                  {canLand && <Button
                    size="sm"
                    {...flowAction(onRunCommand, "prs.land", flowArgs("prs.land", { number, repo }))}
                  >
                    <Octicon name="git-merge" /> Land (queue merge)
                  </Button>}
                  <Button
                    size="sm"
                    variant="outline"
                    {...flowAction(onRunCommand, "prs.review", flowArgs("prs.review", { number, verdict: "approve", repo }))}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    {...flowAction(onRunCommand, "prs.review", flowArgs("prs.review", { number, verdict: "request-changes", repo }))}
                  >
                    Request changes
                  </Button>
                </footer>}
              </section>
            ) :
            null}
        </div>
        <aside className="ghc-side" aria-label={`Pull request #${number} details`}>
          <SideSection title="Reviewers" empty="No reviews">
            {reviewers.length > 0 ?
              reviewers.map((reviewer) => (
                <span key={reviewer} className="ghc-side-person"><Avatar person={{ login: reviewer }} /> {reviewer}</span>
              )) :
              null}
          </SideSection>
          <SideSection title="Labels">
            {(extra.labels ?? []).length > 0 ? (extra.labels ?? []).map((label) => <LabelPill key={label} name={label} color={extra.labelColors?.[label]} />) : null}
          </SideSection>
          <SideSection title="Repository">
            <span className="ghc-mono">{repoLabel(repo)}</span>
          </SideSection>
        </aside>
      </div>
    </article>
  )
}

export const landingCardFamily: CardFamily<"pr-list" | "pr"> = {
  "pr-list": {
    render: (card, actions) => <LandingListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  pr: {
    render: (card, actions) => <LandingCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
