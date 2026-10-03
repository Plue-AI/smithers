import { DiffSurface } from "../ViewModules"
import { flowAction, flowProps } from "../flows/FlowAction"
import type React from "react"
/*
 * The change and diff cards (lane change, ADR 0003 — the change is the
 * unit; ADR 0004 — review on the change card; lane L1 — the live plue
 * shapes). The change card's body is the facets: Diff (two revision pickers,
 * interdiff pins), Findings (per revision, with the analyzer runs), Checks
 * (per revision, with their work), Review (the verdict strip, the threads
 * with Done / Ack / Reopen), History (provenance per revision, the landed
 * row), plus Walkthrough only when an artifact exists and Owners only when
 * the change GET carries ownership. A field the server did not state renders
 * nothing — never a guess, never a number for confidence. Every act binds a
 * registered command through onRunCommand and carries data-flow
 * (parity.test.ts gates this).
 */
import { Button, StatusPill } from "@smthrs/ui"
import { AlertTriangle, FileDiff, GitMerge, GitPullRequest, History } from "lucide-react"
import { Suspense } from "react"
import type { ChangeFacet, ChangeRevision, ChangeThread, LandingBlock } from "@smthrs/rpc/Changes"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { timeLabel, durationLabel } from "../Timestamps"
import { shortId } from "../state/ids"
import { flowArgs } from "../flows/FlowArgs"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureDetails, FailureNotice } from "../FailureNotice"

/* A change or diff card's recorded failure; its raw text stays behind Details. */
export const CHANGE_FAILURES: Readonly<Record<"change" | "diff", UserFailureCopy>> = {
  change: { fault: "infra", sentence: "Smithers could not finish that on this change. Not your fault.", actions: [] },
  diff: { fault: "infra", sentence: "Smithers could not load this diff. Not your fault.", actions: [] }
}

export interface ChangeCardActions {
  readonly onRunCommand: RunCommand
}

type ChangeCard = Extract<Card, { kind: "change" }>
type DiffCard = Extract<Card, { kind: "diff" }>
type ChangePayload = ChangeCard["payload"]

/** Failed state already names the failure, so these rows need only a raw-detail disclosure. Announcement marks the one landing notice as live; analyzer lists stay quiet. */
const RecordedFailureDetails = ({ detail, testId, announcement }: {
  readonly detail: string
  readonly testId: string
  readonly announcement?: string
}) => detail.trim() === "" ? null :
  <div className="sui-approval-error" role={announcement === undefined ? undefined : "alert"} data-testid={testId}>
    {announcement === undefined ? null : <span className="ghc-visually-hidden">{announcement}</span>}
    <FailureDetails detail={detail} />
  </div>

/*
 * Code intelligence L5 (docs/code-intel/PLAN.md §7): a hunk renders through
 * `@pierre/diffs` CodeView behind this boundary — the file card's engine and
 * theme mapping — so pierre and the grammars stay in an async chunk that
 * never imports the entry. The verbatim patch is the complete first state
 * while the chunk loads.
 */


/** An absent auxiliary has no copy unless the server recorded a read failure. */
const Unread = ({ field, reason }: { readonly field: string; readonly reason: string | null | undefined }) =>
  reason ? <p className="world-card-empty">{field} not read ({reason})</p> : null

/** `rev N` when a recorded revision carries the commit, else the short commit — a lookup, never an inference. */
const revisionLabel = (revisions: ReadonlyArray<ChangeRevision>, commitId: string | null): string | null => {
  if (commitId === null) return null
  const revision = revisions.find((candidate) => candidate.commitId === commitId)
  return revision === undefined ? shortId(commitId) : `rev ${revision.seq}`
}

/** A pin token as the card prints it: `parent`, `current`, or `rev N`. */
const pinLabel = (token: string): string => (token === "parent" || token === "current" ? token : `rev ${token}`)

/** `N revision(s) since` when the current revision is past the judged one; nothing when either is unknown. */
const revisionsSince = (currentSeq: number | null, seq: number | null): string | null => {
  if (currentSeq === null || seq === null || currentSeq <= seq) return null
  const count = currentSeq - seq
  return `${count} revision${count === 1 ? "" : "s"} since`
}

/*
 * The landing request's state on this card's pill vocabulary (done / failed /
 * pending, as the check pills already use): `merged` is done,
 * `failed` is failed, `closed` is a neutral end (the cancelled tint, plue's
 * own word as the label — the shared table would tint "closed" green), and
 * open / draft / queued / landing are pending.
 */
const landingPill = (state: string): { readonly status: string; readonly label?: string } =>
  state === "merged"
    ? { status: "done" }
    : state === "failed"
    ? { status: "failed" }
    : state === "closed"
    ? { status: "cancelled", label: "Closed" }
    : { status: "pending" }

/** One gate block in words, from the block's own fields (plue#452 `blocked_by`). */
const blockWords = (block: LandingBlock): string => {
  if (block.kind === "check") return `check ${block.name ?? ""}`.trim()
  if (block.kind === "review") {
    if (block.missing === "human_approval") return `${block.count ?? 1} human approval${(block.count ?? 1) === 1 ? "" : "s"} missing`
    if (block.missing === "agent_lgtm") return "agent LGTM missing"
    if (block.missing === "person_approval") return "person approval missing"
    if (block.missing === "changes_requested") return `changes requested by ${block.name ?? "a reviewer"}`
    return `review ${block.name ?? ""}`.trim()
  }
  if (block.kind === "conflict") return `conflict in ${block.name ?? "a file"}`
  if (block.kind === "owner") return `owner approval missing on ${block.path ?? "a path"}`
  if (block.kind === "agent_policy") return `agent changes denied on ${block.path ?? "a path"}`
  if (block.kind === "thread") return `${block.count ?? 1} comment${(block.count ?? 1) === 1 ? "" : "s"} open`
  return block.kind
}

/** The threads the gate counts as unresolved: open, and done-but-unacked (plue counts `state <> 'resolved'`). */
const unresolvedThreads = (threads: ReadonlyArray<ChangeThread> | null): number =>
  (threads ?? []).filter((thread) => thread.state === "open" || thread.state === "done").length

/**
 * What the landing gate stands on, from the card's own facts: the threads
 * still open (ADR 0004's `2 threads open`, shown as `2 comments open`) and the
 * blocks the landing list stated for this change.
 */
const gateReasons = (payload: ChangePayload): ReadonlyArray<string> => {
  const reasons: Array<string> = []
  const open = unresolvedThreads(payload.threads)
  if (open > 0) reasons.push(`${open} comment${open === 1 ? "" : "s"} open`)
  for (const block of payload.stack?.blockedBy ?? []) {
    if (block.kind === "thread") continue
    reasons.push(blockWords(block))
  }
  return reasons
}

/** The people whose requested changes the landing list states for this change. */
const changesRequestedBy = (payload: ChangePayload): ReadonlyArray<string> =>
  (payload.stack?.blockedBy ?? []).flatMap((block) =>
    block.kind === "review" && block.missing === "changes_requested" && block.name !== null ? [block.name] : []
  )

interface LandAct {
  readonly label: string
  readonly ariaLabel: string
  /** The blocking reason the disabled button wears; null when Land may run. */
  readonly blocked: string | null
}

/*
 * The Land act's label, scope, and blocking reason from the card's own state
 * (ADR 0003: "Land (confirm; disabled with the blocking reason)"). A
 * landing request lands its WHOLE stack, so the label names the scope
 * (`Land 1 → N`), only the top change may land (a prefix land is plue#452),
 * plue lands a request only while it is open or failed, and the gate's own
 * blocks (open threads, checks, owners) read on the button.
 */
const landAct = (payload: ChangePayload): LandAct => {
  const { stack } = payload
  if (stack === null) return { label: "Land", ariaLabel: "Land the change", blocked: null }
  const scope = stack.size <= 1 ? ` ${payload.changeId} alone` : ` 1 → ${stack.size} together`
  const ariaLabel = `Land the change: lands${scope}`
  if (stack.position < stack.size) {
    const top = stack.changeIds[stack.size - 1] ?? "its top change"
    return {
      label: "Land",
      ariaLabel,
      blocked:
        `Land all ${stack.size} changes from ${top}.`
    }
  }
  if (stack.state === "queued" || stack.state === "landing") return { label: "Land", ariaLabel, blocked: `${stack.state}…` }
  if (stack.state === "merged") return { label: "Land", ariaLabel, blocked: "landed" }
  if (stack.state !== "open" && stack.state !== "failed") {
    return { label: "Land", ariaLabel, blocked: `${stack.state} — only open or failed requests can land` }
  }
  const verb = stack.state === "failed" ? "Retry land" : "Land"
  const label = stack.size <= 1 ? verb : `${verb} 1 → ${stack.size}`
  const reasons = gateReasons(payload)
  return { label, ariaLabel, blocked: reasons.length === 0 ? null : reasons.join(" · ") }
}

/*
 * The facet strip: Walkthrough leads when the current revision came from an
 * agent session and the change touches more than 20 files (ADR 0004),
 * otherwise it sits after History; both only when an artifact exists. Owners
 * closes the strip only when the change GET carried ownership.
 */
const facetsOf = (payload: ChangePayload): ReadonlyArray<readonly [ChangeFacet, string]> => {
  const current = payload.revisions.find((revision) => revision.seq === payload.currentSeq)
  const hasWalkthrough = payload.walkthrough !== null && payload.walkthrough !== undefined
  const walkthroughLeads = hasWalkthrough && current?.source === "agent" && (payload.diff?.files.length ?? 0) > 20
  const facets: Array<readonly [ChangeFacet, string]> = []
  if (hasWalkthrough && walkthroughLeads) facets.push(["walkthrough", "Walkthrough"])
  facets.push(["diff", "Diff"], ["findings", "Findings"], ["checks", "Checks"], ["review", "Review"], ["history", "History"])
  if (hasWalkthrough && !walkthroughLeads) facets.push(["walkthrough", "Walkthrough"])
  if (payload.owners !== null && payload.owners !== undefined) facets.push(["owners", "Owners"])
  return facets
}

/** The owners line of the header strip (ADR 0004 row 10); null when the change GET carried no ownership. */
const ownersLine = (payload: ChangePayload): string | null => {
  const owners = payload.owners
  if (owners === null || owners === undefined) return null
  const denied = owners.touchedPaths.filter((touched) => touched.agentPolicy === "deny")
  if (denied.length > 0) return `owners · agent changes denied on ${denied.map((touched) => touched.path).join(", ")}`
  const missing = owners.missingApprovals.length
  if (missing > 0) return `owners · ${missing} path${missing === 1 ? "" : "s"} missing`
  return "owners ✓"
}

/** The Suggested reviewers slot: plue's suggestions plus every missing approval's candidates, by name. */
const suggestedReviewers = (payload: ChangePayload): ReadonlyArray<string> | null => {
  const owners = payload.owners
  if (owners === null || owners === undefined) return null
  const names = new Set(owners.suggestedReviewers)
  for (const missing of owners.missingApprovals) for (const candidate of missing.candidates) names.add(candidate)
  return [...names]
}

/**
 * Whether this change is worth splitting (the brief's gate): its landing
 * request states a landable prefix SHORTER than the stack, so part of the
 * request cannot land as it stands. plue#489 splits one change by path, so
 * the act lives on the diff's file rows — the only place the paths are.
 */
const splittable = (payload: ChangePayload): boolean => {
  const stack = payload.stack
  if (stack === null) return false
  const prefix = stack.landablePrefix
  return prefix !== null && prefix !== undefined && prefix < stack.size
}

/* The diff facet: the two revision pickers, then the file rows of the diff at those pins, each opening the one-file diff card. */
const ChangeDiffFacet = ({ card, onRunCommand }: { readonly card: ChangeCard } & ChangeCardActions) => {
  const { payload } = card
  const canSplit = splittable(payload)
  const diff = payload.diff
  const from = diff?.from ?? "parent"
  const to = diff?.to ?? "current"
  const humanReviewed = (payload.reviews ?? []).some((review) => review.reviewerKind !== "agent" && review.lastReviewedSeq !== null)
  return (
    <div className="world-card-list">
      {payload.revisions.length > 0 ?
        (
          <div className="world-card-row change-pins">
            <select
              className="sui-input"
              aria-label="Diff from"
              {...flowProps("change.pins")}
              value={from}
              onChange={(event) => onRunCommand("change.pins", flowArgs("change.pins", { changeId: payload.changeId, from: event.target.value, to }))}
            >
              <option value="parent">parent</option>
              {payload.revisions.map((revision) => <option key={revision.seq} value={String(revision.seq)}>rev {revision.seq}</option>)}
            </select>
            <span className="world-card-path">→</span>
            <select
              className="sui-input"
              aria-label="Diff to"
              {...flowProps("change.pins")}
              value={to}
              onChange={(event) => onRunCommand("change.pins", flowArgs("change.pins", { changeId: payload.changeId, from, to: event.target.value }))}
            >
              {payload.revisions.map((revision) => <option key={revision.seq} value={String(revision.seq)}>rev {revision.seq}</option>)}
              <option value="current">current</option>
            </select>
            {diff?.sinceReview !== null && diff?.sinceReview !== undefined ?
              (
                <>
                  <span className="world-card-path">since your review at rev {diff.sinceReview.seq} → {pinLabel(to)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Show the whole diff, parent to current"
                    {...flowAction(onRunCommand, "change.pins", flowArgs("change.pins", { changeId: payload.changeId, from: "parent", to: "current" }))}
                  >
                    show all
                  </Button>
                </>
              ) :
              humanReviewed ?
              (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Show the diff since my last review"
                  {...flowAction(onRunCommand, "review.since-mine", payload.changeId)}
                >
                  since my review
                </Button>
              ) :
              null}
          </div>
        ) :
        null}
      {diff === null ?
        <Unread field={`diff of ${payload.changeId}`} reason={payload.unread?.diff} /> :
        diff.files.length === 0 ?
        <p className="world-card-empty">{payload.changeId} changes no files {pinLabel(from)} → {pinLabel(to)}.</p> :
        (
          <ul className="world-card-list">
            {diff.files.map((file) => (
              <li key={file.path} className="world-card-row">
                <FileDiff size={14} aria-hidden="true" />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Open the diff of ${file.path}`}
                  {...flowAction(onRunCommand, "change.diff", flowArgs("change.diff", { changeId: payload.changeId, from, to, path: file.path }))}
                >
                  <span className="world-card-title">{file.path}</span>
                </Button>
                <span className="world-card-path">
                  {file.changeType} · +{file.additions} −{file.deletions}
                </span>
                {/* plue#489: move this file's diff into a new change; offered only while the stack's landable prefix is short. */}
                {canSplit ?
                  (
                    null
                  ) :
                  null}
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

/* A check's work in words, only when the row states any (a row of zeros states no work). */
const checkWork = (check: NonNullable<ChangePayload["checks"]>[number]): string | null => {
  const affected = check.targetsAffected ?? 0
  const ran = check.targetsRan ?? 0
  const cached = check.targetsCached ?? 0
  const duration = check.durationMs ?? 0
  if (affected === 0 && ran === 0 && cached === 0 && duration === 0) return null
  return `${affected} affected · ${ran} ran · ${cached} cached · ${durationLabel(duration)}`
}

/* The checks facet: the revision picker, one row per context (newest answer per context) with its work. Unread (null) is never "no checks". */
const ChangeChecksFacet = ({ card, onRunCommand }: { readonly card: ChangeCard } & ChangeCardActions) => {
  const { payload } = card
  const at = payload.checksAt ?? payload.currentSeq
  return (
    <div className="world-card-list">
      {payload.revisions.length > 0 ?
        (
          <div className="world-card-row change-pins">
            <span className="world-card-path">at</span>
            <select
              className="sui-input"
              aria-label="Checks at revision"
              {...flowProps("change.checks")}
              value={at === null ? "" : String(at)}
              onChange={(event) => onRunCommand("change.checks", flowArgs("change.checks", { changeId: payload.changeId, seq: Number(event.target.value) }))}
            >
              {payload.revisions.map((candidate) => <option key={candidate.seq} value={String(candidate.seq)}>rev {candidate.seq}</option>)}
            </select>
          </div>
        ) :
        null}
      {payload.checks === null ?
        <Unread field="checks" reason={payload.unread?.checks} /> :
        payload.checks.length === 0 ?
        <p className="world-card-empty">No checks recorded at this revision.</p> :
        (
          <ul className="world-card-list">
            {payload.checks.map((check) => {
              const work = checkWork(check)
              return (
                <li key={check.context} className="world-card-row">
                  <span className="world-card-title">{check.context}</span>
                  <StatusPill
                    status={check.state === "success" ? "done" : check.state === "failure" || check.state === "error" ? "failed" : "pending"}
                  />
                  <span className="world-card-path">{check.state}</span>
                  {work !== null ? <span className="world-card-path">{work}</span> : null}
                </li>
              )
            })}
          </ul>
        )}
    </div>
  )
}

/* The findings facet: the analyzer runs as headers, then one row per finding with its revision, state, feedback, and the two acts. */
const ChangeFindingsFacet = ({ card, onRunCommand }: { readonly card: ChangeCard } & ChangeCardActions) => {
  const { payload } = card
  if (payload.findings === null) {
    return <Unread field="findings" reason={payload.unread?.findings} />
  }
  const analyzers = payload.analyzers ?? []
  return (
    <div className="world-card-list">
      {analyzers.length > 0 ?
        (
          <ul className="world-card-list" aria-label="Analyzer runs">
            {analyzers.map((run) => (
              <li key={`${run.name}-${run.seq ?? ""}`} className="world-card-row">
                <span className="world-card-title">{run.name}</span>
                <span className="world-card-path">
                  {run.state}
                  {run.seq !== null ? ` · rev ${run.seq}` : ""}
                  {run.pausedReason !== null ? ` · ${run.pausedReason}` : ""}
                </span>
                {run.failureReason !== null ?
                  <RecordedFailureDetails detail={run.failureReason} testId="change-analyzer-failure" /> :
                  null}
              </li>
            ))}
          </ul>
        ) :
        null}
      {payload.findings.length === 0 && analyzers.length === 0 ?
        <p className="world-card-empty">No findings recorded for {payload.changeId}.</p> :
        null}
      {payload.findings.length > 0 ?
        (
          <ul className="world-card-list" aria-label="Findings">
            {payload.findings.map((finding, index) => {
              const dimmed = finding.feedback !== null && finding.feedback !== undefined
              return (
                <li key={finding.id ?? index} className={dimmed ? "world-card-row change-finding change-finding--dimmed" : "world-card-row change-finding"}>
                  <span className="world-card-title">{finding.severity}</span>
                  <span className="world-card-path">{finding.analyzer}</span>
                  <span className="world-card-path">{finding.path}{finding.line !== null ? `:${finding.line}` : ""}</span>
                  <span className="world-card-title">{finding.summary}</span>
                  <span className="world-card-path">
                    {finding.raisedAtSeq !== null ? `rev ${finding.raisedAtSeq}` : ""}
                    {finding.state === "stale" ? " · stale" : ""}
                    {dimmed ? ` · ${(finding.feedback ?? "").replaceAll("_", " ")}` : ""}
                  </span>
                  {finding.id !== null && finding.id !== undefined ?
                    (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Dispatch the agent on finding ${finding.id}`}
                          {...flowAction(onRunCommand, "findings.please-fix", flowArgs("findings.please-fix", { changeId: payload.changeId, findingId: finding.id }))}
                        >
                          Please fix
                        </Button>
                        {dimmed ? null : (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Mark finding ${finding.id} not useful`}
                            {...flowAction(onRunCommand, "findings.not-useful", flowArgs("findings.not-useful", { changeId: payload.changeId, findingId: finding.id }))}
                          >
                            Not useful
                          </Button>
                        )}
                      </>
                    ) :
                    null}
                </li>
              )
            })}
          </ul>
        ) :
        null}
    </div>
  )
}

const THREAD_GLYPH: Readonly<Record<NonNullable<ChangeThread["state"]>, string>> = { open: "○", done: "◐", resolved: "●" }

/*
 * The Request review picker (ADR 0004 "Suggested reviewers … inside the
 * Request review picker"; plue#488 `review_requests[]` on the landing DTO).
 * One row per request the landing carries — a human by login or a named
 * agent, plue's own state word, and who asked — with Unrequest on a request
 * still standing. An unread list says so; a read empty list says nobody has
 * been asked, which is a fact, not a blank.
 */
const RequestReviewPicker = ({
  payload,
  onRunCommand
}: { readonly payload: ChangePayload } & ChangeCardActions) => {
  const requests = payload.reviewRequests
  if (requests === undefined) return null
  if (requests === null) {
    return <Unread field="review requests" reason={payload.unread?.reviewRequests} />
  }
  if (requests.length === 0) return <p className="world-card-empty">Nobody has been asked to review {payload.changeId}.</p>
  return (
    <ul className="world-card-list" aria-label="Review requests">
      {requests.map((request) => (
        <li key={request.id} className="world-card-row">
          <span className="world-card-title">{request.reviewer ?? `agent ${request.agent ?? ""}`.trim()}</span>
          <span className="world-card-path">
            {request.state}
            {request.requestedBy !== null ? ` · asked by ${request.requestedBy}` : ""}
          </span>
          {request.state === "requested" ?
            (
              <Button
                size="sm"
                variant="outline"
                aria-label={`Dismiss review request ${request.id}`}
                {...flowAction(onRunCommand, "review.unrequest", flowArgs("review.unrequest", { changeId: payload.changeId, requestId: request.id }))}
              >
                Unrequest
              </Button>
            ) :
            null}
        </li>
      ))}
    </ul>
  )
}

/*
 * The review facet: the verdict strip (each reviewer with the revision they
 * judged, the agent's confidence WORD, revisions since), the owners line,
 * then the threads with their lifecycle glyph, anchor token, and one-click
 * Done / Ack / Reopen, then the Suggested reviewers slot. An unread list
 * (null) says so with its reason; "No review is recorded" is stated only
 * when both lists were read and are empty.
 */
const ChangeReviewFacet = ({ card, onRunCommand }: { readonly card: ChangeCard } & ChangeCardActions) => {
  const { payload } = card
  const reviews = payload.reviews ?? []
  const threads = payload.threads ?? []
  const owners = ownersLine(payload)
  const suggested = suggestedReviewers(payload)
  const since = payload.diff?.sinceReview ?? null
  const threadActs = (thread: ChangeThread): ReadonlyArray<readonly ["review.done" | "review.ack" | "review.reopen", string, string]> => {
    if (thread.id === null || thread.id === undefined || thread.state === null || thread.state === undefined) return []
    if (thread.state === "open") return [["review.done", "Done", `Mark comment ${thread.id} done`]]
    if (thread.state === "done") {
      return [["review.ack", "Ack", `Acknowledge comment ${thread.id}`], ["review.reopen", "Reopen", `Reopen comment ${thread.id}`]]
    }
    return [["review.reopen", "Reopen", `Reopen comment ${thread.id}`]]
  }
  return (
    <div className="world-card-list">
      {since !== null ?
        (
          <p className="world-card-row">
            <span className="world-card-path">since your review at rev {since.seq} → {pinLabel(payload.diff?.to ?? "current")}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Show the whole diff, parent to current"
              {...flowAction(onRunCommand, "change.pins", flowArgs("change.pins", { changeId: payload.changeId, from: "parent", to: "current" }))}
            >
              show all
            </Button>
          </p>
        ) :
        null}
      {payload.reviews === null ?
        <Unread field="reviews" reason={payload.unread?.reviews} /> :
        null}
      {payload.threads === null ?
        <Unread field="review comments" reason={payload.unread?.threads} /> :
        null}
      {reviews.length === 0 ? null : (
        <ul className="world-card-list" aria-label="Verdicts">
          {reviews.map((review, index) => {
            const since = revisionsSince(payload.currentSeq, review.seq)
            return (
              <li key={index} className="world-card-row">
                {/* plue#500 `reviewer_login`: the login, or an agent session's title — never the id `reviewer` carries. */}
                <span className="world-card-title">{review.reviewerLogin ?? review.reviewer ?? review.reviewerKind ?? "review"}</span>
                <span className="world-card-path">
                  {review.reviewerKind === "agent" && review.reviewer !== null ? "agent · " : ""}
                  {review.verdict}
                  {/* plue#484 `type`: how the verdict counts to the gate, stated only when it is a different word. */}
                  {review.type !== null && review.type !== undefined && review.type !== review.verdict ? ` · ${review.type}` : ""}
                  {review.seq !== null ? ` at rev ${review.seq}` : ""}
                  {review.confidence !== null ? ` · ${review.confidence} confidence` : ""}
                  {since !== null ? ` · ${since}` : ""}
                </span>
                {review.summary !== "" ? <span className="world-card-path">"{review.summary}"</span> : null}
              </li>
            )
          })}
        </ul>
      )}
      {owners !== null ? <p className="world-card-path">{owners}</p> : null}
      {threads.length === 0 ? null : (
        <ul className="world-card-list" aria-label="Review comments">
          {threads.map((thread, index) => (
            <li key={thread.id ?? index} className="world-card-row">
              {thread.state !== null && thread.state !== undefined ? <span aria-label={`comment ${thread.state}`}>{THREAD_GLYPH[thread.state]}</span> : null}
              <span className="world-card-path">
                {thread.path ?? "file"}{thread.line !== null ? `:${thread.line}` : ""}
                {thread.anchor === "moved" && thread.currentLine !== null && thread.currentLine !== undefined ? ` → :${thread.currentLine}` : ""}
                {/* plue#484 `user_login`: the thread's author by name (ADR 0004's `· will ·`). */}
                {thread.author !== null ? ` · ${thread.author}` : ""}
                {revisionLabel(payload.revisions, thread.commitId ?? null) !== null ? ` · ${revisionLabel(payload.revisions, thread.commitId ?? null)}` : ""}
                {thread.anchor === "stale" ? " · stale" : thread.anchor === "moved" ? " · moved" : ""}
              </span>
              <span className="world-card-title">{thread.body}</span>
              {thread.state === "done" && thread.resolvedInRevision?.seq !== null && thread.resolvedInRevision?.seq !== undefined ?
                <span className="world-card-path">done at rev {thread.resolvedInRevision.seq}</span> :
                null}
              {thread.state === "resolved" ? <span className="world-card-path">resolved</span> : null}
              {threadActs(thread).map(([flow, label, aria]) => (
                <Button
                  key={flow}
                  size="sm"
                  variant="outline"
                  aria-label={aria}
                  {...flowAction(onRunCommand, flow, flowArgs(flow, { changeId: payload.changeId, threadId: thread.id! }))}
                >
                  {label}
                </Button>
              ))}
            </li>
          ))}
        </ul>
      )}
      <RequestReviewPicker payload={payload} onRunCommand={onRunCommand} />
      {suggested !== null ?
        (
          <p className="world-card-row">
            <span className="world-card-path">Suggested reviewers ·</span>
            {suggested.length === 0 ? <span className="world-card-path">none</span> : suggested.map((login) => (
              <Button
                key={login}
                size="sm"
                variant="ghost"
                aria-label={`Request review from ${login}`}
                {...flowAction(onRunCommand, "review.request", flowArgs("review.request", { changeId: payload.changeId, reviewer: login }))}
              >
                {login}
              </Button>
            ))}
          </p>
        ) :
        null}
      {payload.reviews !== null && payload.threads !== null && reviews.length === 0 && threads.length === 0 ?
        <p className="world-card-empty">No review is recorded for {payload.changeId}.</p> :
        null}
    </div>
  )
}

/* The history facet: one row per revision with its provenance and acts, then the landed row (plue#450, #464). */
const ChangeHistoryFacet = ({ card, onRunCommand }: { readonly card: ChangeCard } & ChangeCardActions) => {
  const { payload } = card
  const landed = payload.landed ?? null
  if (payload.revisions.length === 0 && landed === null) {
    return <p className="world-card-empty">No revisions recorded for {payload.changeId}.</p>
  }
  return (
    <ul className="world-card-list" aria-label="Revisions">
      {payload.revisions.map((revision) => (
        <li key={revision.seq} className="world-card-row">
          <History size={14} aria-hidden="true" />
          <span className="world-card-title">rev {revision.seq}</span>
          <span className="world-card-path">
            {shortId(revision.commitId)}
            {revision.source !== undefined ? ` · ${revision.source}` : ""}
            {revision.agentSessionId !== undefined ? ` · agent session ${shortId(revision.agentSessionId)}` : ""}
            {revision.workspaceSnapshotId !== undefined ? ` · snapshot ${revision.workspaceSnapshotId}` : ""}
            {revision.createdAt !== undefined ? ` · ${timeLabel(Date.parse(revision.createdAt))}` : ""}
          </span>
          {payload.currentSeq !== null && revision.seq < payload.currentSeq ?
            (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Diff rev ${revision.seq} to current`}
                {...flowAction(onRunCommand, "change.pins", flowArgs("change.pins", { changeId: payload.changeId, from: String(revision.seq), to: "current" }))}
              >
                Diff to current
              </Button>
            ) :
            null}
        </li>
      ))}
      {landed !== null ?
        (
          <li className="world-card-row">
            <GitMerge size={14} aria-hidden="true" />
            <span className="world-card-title">landed</span>
            <span className="world-card-path">
              {/* plue#485: the landing request's NUMBER, which is what addresses it everywhere else. */}
              {landed.landingRequestNumber != null ? `landing #${landed.landingRequestNumber} · ` : ""}
              {landed.by !== null ? `by ${landed.by}` : ""}
              {landed.approvedBy.length > 0 ?
                ` · approved by ${landed.approvedBy.map((approver) => approver.seq === null ? approver.login : `${approver.login} at rev ${approver.seq}`).join(", ")}` :
                ""}
              {landed.at !== null ? ` · ${timeLabel(Date.parse(landed.at))}` : ""}
            </span>
          </li>
        ) :
        null}
    </ul>
  )
}

/* The owners facet (ADR 0004 row 10): one row per touched path — its owners by name, the policy word, and who satisfied it or who is asked. */
const ChangeOwnersFacet = ({ card, onRunCommand }: { readonly card: ChangeCard } & ChangeCardActions) => {
  const owners = card.payload.owners
  if (owners === null || owners === undefined) return null
  const candidatesFor = (path: string): ReadonlyArray<string> =>
    owners.missingApprovals.find((missing) => missing.path === path)?.candidates ?? []
  return (
    <div className="world-card-list">
      {owners.touchedPaths.length === 0 ?
        <p className="world-card-empty">No owned paths are touched.</p> :
        (
          <ul className="world-card-list" aria-label="Touched paths">
            {owners.touchedPaths.map((touched) => {
              const candidates = candidatesFor(touched.path)
              return (
                <li key={touched.path} className="world-card-row">
                  <span className="world-card-title">{touched.path}</span>
                  <span className="world-card-path">
                    {touched.owners.length > 0 ? touched.owners.join(", ") : "no owners"}
                    {touched.agentPolicy !== "" ? ` · ${touched.agentPolicy}` : ""}
                    {touched.satisfiedBy !== null ?
                      ` · approved by ${touched.satisfiedBy.login}${touched.satisfiedBy.seq !== null ? ` at rev ${touched.satisfiedBy.seq}` : ""}` :
                      candidates.length > 0 ?
                      ` · missing · ask` :
                      ""}
                  </span>
                  {/* ADR 0004 row 10, live on plue#488: each candidate is one click of review.request. */}
                  {touched.satisfiedBy === null ?
                    candidates.map((candidate) => (
                      <Button
                        key={candidate}
                        size="sm"
                        variant="outline"
                        aria-label={`Request review of ${touched.path} from ${candidate}`}
                        {...flowAction(onRunCommand, "review.request", flowArgs("review.request", { changeId: card.payload.changeId, reviewer: candidate }))}
                      >
                        {candidate}
                      </Button>
                    )) :
                    null}
                </li>
              )
            })}
          </ul>
        )}
      {owners.requiredApprovers.length > 0 ? <p className="world-card-path">Required approvers · {owners.requiredApprovers.join(", ")}</p> : null}
      <p className="world-card-row">
        <span className="world-card-path">Suggested reviewers ·</span>
        {(suggestedReviewers(card.payload) ?? []).length === 0 ?
          <span className="world-card-path">none</span> :
          (suggestedReviewers(card.payload) ?? []).map((login) => (
            <Button
              key={login}
              size="sm"
              variant="ghost"
              aria-label={`Request review from ${login}`}
              {...flowAction(onRunCommand, "review.request", flowArgs("review.request", { changeId: card.payload.changeId, reviewer: login }))}
            >
              {login}
            </Button>
          ))}
      </p>
    </div>
  )
}

/* The walkthrough facet (plue#465): the artifact's sections, a diagram's source when one rides. */
const ChangeWalkthroughFacet = ({ card }: { readonly card: ChangeCard }) => {
  const walkthrough = card.payload.walkthrough
  if (walkthrough === null || walkthrough === undefined) return null
  return (
    <div className="world-card-list">
      {walkthrough.seq !== null ? <p className="world-card-path">walkthrough of rev {walkthrough.seq}</p> : null}
      {walkthrough.sections.length === 0 ? <p className="world-card-empty">The walkthrough has no sections.</p> : (
        <ul className="world-card-list" aria-label="Walkthrough sections">
          {walkthrough.sections.map((section, index) => (
            <li key={index} className="world-card-list">
              <span className="world-card-title">{section.title}</span>
              <p className="world-card-path">{section.markdown}</p>
              {section.diagram !== null ? <pre className="world-card-path">{section.diagram}</pre> : null}
            </li>
          ))}
        </ul>
      )}

    </div>
  )
}

const ChangeFacetBody = ({
  card,
  facet,
  onRunCommand
}: {
  readonly card: ChangeCard
  readonly facet: ChangeFacet
} & ChangeCardActions) => {
  if (facet === "diff") return <ChangeDiffFacet card={card} onRunCommand={onRunCommand} />
  if (facet === "findings") return <ChangeFindingsFacet card={card} onRunCommand={onRunCommand} />
  if (facet === "checks") return <ChangeChecksFacet card={card} onRunCommand={onRunCommand} />
  if (facet === "review") return <ChangeReviewFacet card={card} onRunCommand={onRunCommand} />
  if (facet === "owners") return <ChangeOwnersFacet card={card} onRunCommand={onRunCommand} />
  if (facet === "walkthrough") return <ChangeWalkthroughFacet card={card} />
  return <ChangeHistoryFacet card={card} onRunCommand={onRunCommand} />
}

type ChangeStack = NonNullable<ChangeCard["payload"]["stack"]>

/*
 * The stack view (onboarding SCRIPT v4 beat 8): the stack's commits as rows,
 * top first, standing on the target bookmark, like `jj log`. A row that moved
 * onto the target wears a "rebased" chip with its old and new ids; a row that
 * did not move wears none (a field the opener did not state renders nothing).
 */
export const ChangeStackView = ({ payload, stack }: { readonly payload: ChangeCard["payload"]; readonly stack: ChangeStack & { readonly rows: NonNullable<ChangeStack["rows"]> } }) => {
  const checksOk = payload.checks !== null && payload.checks.length > 0 && payload.checks.every((check) => check.state === "success")
  const rows = stack.rows
  return (
    <section className="change-stack" aria-label="Change stack" data-stack-size={stack.size} data-target={stack.targetBookmark}>
      <p className="change-stack-header" data-testid="change-stack-header">
        Change #{stack.landingNumber} · stack of {stack.size} · target {stack.targetBookmark}
        {checksOk ? " · checks ✓" : ""}
      </p>
      <ol className="commit-rows change-stack-rows" aria-label="Commits, top of the stack first">
        {rows.map((row, index) => ({ row, position: index + 1 })).reverse().map(({ row, position }) => (
          <li key={row.changeId} className="commit-row change-stack-row" data-stack-row={position} data-change-id={row.changeId}
            data-rebased={row.rebased !== undefined} style={{ "--stack-delay": `${(rows.length - position) * 90}ms` } as React.CSSProperties}>
            <code className="change-stack-id">{shortId(row.commitId)}</code>
            <span className="change-stack-message">{row.message}</span>
            <span className="change-stack-stat">+{row.additions} −{row.deletions}</span>
            {row.rebased !== undefined ?
              (
                <span className="change-stack-rebased" data-from={row.rebased.from} data-to={row.rebased.to}>
                  rebased {shortId(row.rebased.from)} → {shortId(row.rebased.to)}
                </span>
              ) :
              null}
          </li>
        ))}
      </ol>
      <p className="change-stack-target"><code>{stack.targetBookmark}</code></p>
    </section>
  )
}

/** Only recorded evidence or an actual read failure; absent fields have no row. */
const ReviewEvidence = ({ card, onRunCommand }: { readonly card: ChangeCard } & ChangeCardActions) => {
  const p = card.payload
  const at = (seq: number | null | undefined): string => seq == null ? "" :
    `rev ${seq}${p.currentSeq === null ? " · current revision unknown" : seq === p.currentSeq ? " · current" : " · not current"}`
  const missing = (reason: string | undefined): string => reason ? `Not read: ${reason}` : ""
  const checks = p.checks === null ? missing(p.unread?.checks) : p.checks.length === 0 ? "0" :
    p.checks.map(check => `${check.context}: ${check.state}`).join(" · ")
  const current = p.findings?.filter(finding => finding.state !== "stale" && p.currentSeq !== null && finding.raisedAtSeq === p.currentSeq)
  const rows: Array<readonly [ChangeFacet, string, string]> = []
  if (p.checks !== null || p.unread?.checks) rows.push(["checks", "Checks", [checks, at(p.checksAt)].filter(Boolean).join(" · ")])
  if (p.findings !== null || p.unread?.findings) rows.push(["findings", "Findings", p.findings === null ? missing(p.unread?.findings) :
    p.currentSeq === null ? String(p.findings.length) :
      `${current?.length ?? 0} current · ${p.findings.length - (current?.length ?? 0)} older or unlinked`])
  if (p.threads !== null || p.unread?.threads) rows.push(["review", "Review comments", p.threads === null ? missing(p.unread?.threads) :
    `${p.threads.filter(thread => thread.state === "open").length} open · ${p.threads.filter(thread => thread.state === "done").length} awaiting acknowledgment`])
  if (p.walkthrough) rows.push(["walkthrough", "Walkthrough", at(p.walkthrough.seq)])
  const hasHumanReview = (p.reviews ?? []).some(review => review.reviewerKind !== "agent")
  if (rows.length === 0 && !p.unread?.walkthrough && !hasHumanReview) return null
  return <section className="world-card-list" aria-label="Review evidence">
    <h4>Review evidence</h4>
    {rows.map(([facet, label, detail]) => <div key={facet} className="world-card-row">
      <span className="world-card-title">{label}</span><span className="world-card-path">{detail}</span>
      <Button size="sm" variant="outline" 
        {...flowAction(onRunCommand, "change.facet", flowArgs("change.facet", { changeId: p.changeId, facet }))}>Inspect {label.toLowerCase()}</Button>
    </div>)}
    {p.unread?.walkthrough === undefined ? null : <p className="world-card-path">Walkthrough not read: {p.unread.walkthrough}</p>}
    {hasHumanReview ? <Button size="sm" variant="outline" 
      {...flowAction(onRunCommand, "review.since-mine", p.changeId)}>Diff since my review</Button> : null}
  </section>
}

export const ChangeCardBody = ({
  card,
  onRunCommand
}: { readonly card: ChangeCard } & ChangeCardActions) => {
  const { payload } = card
  const stackRows = payload.stack?.rows
  /* Nothing but the stack was read: the stack view is the whole card. */
  if (payload.stack !== null && stackRows !== undefined && payload.revisions.length === 0 && payload.diff === null) {
    return <ChangeStackView payload={payload} stack={{ ...payload.stack, rows: stackRows }} />
  }
  const facets = facetsOf(payload)
  const wanted: ChangeFacet = payload.facet ?? "diff"
  /* A facet whose data is absent (a walkthrough that vanished, no owners) falls back to the diff rather than an empty tab. */
  const facet: ChangeFacet = facets.some(([name]) => name === wanted) ? wanted : "diff"
  const landed = payload.stack?.state === "merged"
  const land = landAct(payload)
  const turn = payload.turn ?? null
  const agentReviews = (payload.reviews ?? []).filter((review) => review.reviewerKind === "agent")
  const humanReviews = (payload.reviews ?? []).filter((review) => review.reviewerKind !== "agent")
  const owners = ownersLine(payload)
  return (
    <div className="world-card-list">
      {payload.currentSeq !== null || payload.stack !== null || turn !== null ? <p className="world-card-row">
        {payload.currentSeq !== null ? <span className="world-card-path">
          rev {payload.currentSeq}{payload.revisionCount !== null ? ` of ${payload.revisionCount}` : ""}
        </span> : null}
        {payload.stack !== null ? <StatusPill {...landingPill(payload.stack.state)} /> : null}
        {/* plue#484: the turn names its actor's LOGIN (a username, or an agent session's title); the party alone when it names none. */}
        {turn !== null ?
          (
            <span className="world-card-path">
              turn: {turn.actorLogin ?? turn.party}
              {turn.actorLogin !== null && turn.actorLogin !== undefined ? ` · ${turn.party}` : ""}
            </span>
          ) :
          null}
      </p> : null}
      {payload.description !== "" ? <p className="world-card-title">{payload.description.split("\n")[0]}</p> : null}
      {payload.repos.length > 0 ?
        (
          <p className="world-card-path">
            {payload.repos.map((stat) => `${stat.repo} +${stat.additions} −${stat.deletions}`).join(" · ")}
          </p>
        ) :
        null}
      {/* The three-bit review strip (ADR 0004): the agent's verdict with its confidence WORD, the human approval with revisions since, the owners line. */}
      {agentReviews.length > 0 || humanReviews.length > 0 || owners !== null ?
        (
          <ul className="world-card-list" aria-label="Review strip">
            {agentReviews.map((review, index) => (
              <li key={`agent-${index}`} className="world-card-path">
                agent {review.verdict}
                {review.seq !== null ? ` at rev ${review.seq}` : ""}
                {review.confidence !== null ? ` (${review.confidence} confidence)` : ""}
              </li>
            ))}
            {humanReviews.map((review, index) => {
              const since = revisionsSince(payload.currentSeq, review.seq)
              return (
                <li key={`human-${index}`} className="world-card-path">
                  {/* plue#500: the same login the Review facet's row reads. */}
                  {review.reviewerLogin ?? review.reviewer ?? "someone"} {review.verdict}
                  {review.seq !== null ? ` at rev ${review.seq}` : ""}
                  {since !== null ? ` · ${since}` : ""}
                </li>
              )
            })}
            {owners !== null ? <li className="world-card-path">{owners}</li> : null}
          </ul>
        ) :
        null}
      <ReviewEvidence card={card} onRunCommand={onRunCommand} />
      {payload.conflicts === null ?
        <Unread field="conflicts" reason={payload.unread?.conflicts} /> :
        null}
      {/* One row per conflicted file, each with its own Resolve (ADR 0003: the act belongs to the conflicted hunk, not the card). */}
      {payload.conflicts !== null && payload.conflicts.length > 0 ?
        (
          <ul className="world-card-list" aria-label="Conflicted files">
            {payload.conflicts.map((conflict) => (
              <li key={conflict.path} className="world-card-row">
                <AlertTriangle size={14} aria-hidden="true" />
                <span className="world-card-path">
                  Conflicted: {conflict.path} · {conflict.state}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Dispatch an agent to resolve the conflict in ${conflict.path}`}
                  {...flowAction(onRunCommand, "change.resolve", flowArgs("change.resolve", { changeId: payload.changeId, path: conflict.path }))}
                >
                  Resolve
                </Button>
              </li>
            ))}
          </ul>
        ) :
        null}
      {payload.unread?.stack !== undefined ?
        <p className="world-card-empty">landing request not read ({payload.unread.stack})</p> :
        null}
      {payload.stack !== null ?
        (
          <p className="world-card-path">
            Landing #{payload.stack.landingNumber} · position {payload.stack.position} of {payload.stack.size}
            {payload.stack.positionFrom === "server" ? "" : " by request order"} ·{" "}
            {payload.stack.state} → {payload.stack.targetBookmark}
            {payload.stack.conflictStatus === "conflicted" ? " · conflicted" : ""}
            {payload.stack.landablePrefix !== null && payload.stack.landablePrefix !== undefined ?
              ` · ${payload.stack.landablePrefix} of ${payload.stack.size} landable` :
              ""}
          </p>
        ) :
        null}
      {payload.error !== undefined ?
        <FailureNotice className="sui-approval-error" data-testid="change-failure" failure={describedFailure("ChangeFailed", CHANGE_FAILURES.change, payload.error)} /> :
        null}
      <div className="world-card-row" role="tablist" aria-label="Change facets">
        {facets.map(([name, label]) => (
          <Button
            key={name}
            size="sm"
            variant={name === facet ? "default" : "outline"}
            role="tab"
            aria-selected={name === facet}
            {...flowAction(onRunCommand, "change.facet", flowArgs("change.facet", { changeId: payload.changeId, facet: name }))}
          >
            {label}
          </Button>
        ))}
      </div>
      <ChangeFacetBody card={card} facet={facet} onRunCommand={onRunCommand} />
      <div className="world-card-row">
        {payload.changeset !== null && payload.stack === null ? null : (
        <Button
          size="sm"
          aria-label={land.ariaLabel}
          disabled={land.blocked !== null}
          {...flowAction(onRunCommand, "change.land", payload.changeId)}
        >
          <GitMerge size={12} aria-hidden="true" /> {land.label}
        </Button>
        )}
        {land.blocked !== null ? <span className="world-card-path">{land.blocked}</span> : null}
        {/* A person's requested changes hold the landing until they review again: ask them. */}
        {changesRequestedBy(payload).map((login) => (
          <Button
            key={login}
            size="sm"
            variant="ghost"
            aria-label={`Request review from ${login}`}
            {...flowAction(onRunCommand, "review.request", flowArgs("review.request", { changeId: payload.changeId, reviewer: login }))}
          >
            Ask {login}
          </Button>
        ))}
        {landed ?
          (
            null
          ) :
          null}
        <Button
          size="sm"
          variant="outline"
          aria-label="Open the full diff card"
          {...flowAction(onRunCommand, "change.diff", payload.changeId)}
        >
          <GitPullRequest size={12} aria-hidden="true" /> Full diff
        </Button>
      </div>
    </div>
  )
}

/** Keep revision numbers and named pins intact; abbreviate recorded hashes. */
const shortDiffId = (id: string): string => /^[0-9a-f]{13,64}$/i.test(id) ? id.slice(0, 7) : id

export const DiffCardBody = ({
  card,
  onRunCommand
}: { readonly card: DiffCard } & ChangeCardActions) => {
  const { payload } = card
  return (
    <div className="world-card-list">
      <p className="world-card-path">
        {payload.repo} · <span title={payload.changeId}>{shortDiffId(payload.changeId)}</span> · <span title={payload.from}>{pinLabel(shortDiffId(payload.from))}</span> → <span title={payload.to}>{pinLabel(shortDiffId(payload.to))}</span>
        {payload.pin.commitId !== null ? <>
          {` · pinned at ${payload.pin.seq !== null ? `rev ${payload.pin.seq} · ` : ""}`}<span title={payload.pin.commitId}>{payload.pin.commitId.slice(0, 7)}</span>
        </> : null}
      </p>
      {payload.error !== undefined ?
        <FailureNotice className="sui-approval-error" data-testid="diff-failure" failure={describedFailure("DiffFailed", CHANGE_FAILURES.diff, payload.error)} /> :
        null}
      {payload.files.length === 0 ?
        payload.error === undefined ? <p className="world-card-empty">No files in this diff.</p> : null :
        (
          <ul className="world-card-list">
            {payload.files.map((file) => (
              <li key={file.path} className="world-card-row">
                <FileDiff size={14} aria-hidden="true" />
                <span className="world-card-title">{file.path}</span>
                {!file.isBinary && file.changeType !== "deleted" && payload.pin.commitId !== null ? <Button variant="ghost" size="sm"  {...flowAction(onRunCommand, "files.open-diff", flowArgs("files.open-diff", { cardId: card.id, path: file.path }))}>Open file</Button> : null}
                <span className="world-card-path">
                  {file.changeType} · +{file.additions} −{file.deletions}
                  {file.conflicted === true ? " · conflicted" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      {payload.files.map((file) => {
        if (file.isBinary) {
          return (
            <p key={`binary-${file.path}`} className="world-card-empty">
              {file.path} is binary, so its diff is not shown here.
            </p>
          )
        }
        if (file.patch !== undefined) {
          return (
            <Suspense key={`patch-${file.path}`} fallback={<pre className="world-card-path">{file.patch}</pre>}>
              <DiffSurface path={file.path} oldPath={file.oldPath} patch={file.patch} />
            </Suspense>
          )
        }
        if (file.patchLines !== undefined) {
          return (
            <p key={`ref-${file.path}`} className="world-card-empty">
              {file.path}'s hunk is {file.patchLines} lines — it rides by reference.{" "}
              <Button
                variant="ghost"
                size="sm"
                {...flowAction(onRunCommand, "change.diff", flowArgs("change.diff", { changeId: payload.changeId, from: payload.from, to: payload.to, path: file.path }))}
              >
                Read it
              </Button>
            </p>
          )
        }
        return null
      })}
    </div>
  )
}

export const changeCardFamily: CardFamily<"change" | "diff"> = {
  change: {
    render: (card, actions) => <ChangeCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  diff: {
    render: (card, actions) => <DiffCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
