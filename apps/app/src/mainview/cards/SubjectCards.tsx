/*
 * MOCK SEAM (delete with state/seams/DesignWorld): the bodies of the subject
 * cards the design world opens, Issue, File, Diff, Wiki page, Review and PR,
 * read by the `design:` id (subjects.ts). File and Diff render through the
 * real Views (CodeSurface, DiffCardSurface) from the rpc models; the rest draw
 * the mock's layout until their Views and rpc models land. Every press is a
 * registry submission through flowAction: Make TODO is `todo.new`, Please fix
 * is `todo.steer`, both the TODO lane's flows.
 */
import { Fragment, Suspense, lazy, useState, type ReactNode } from "react"
import { Button, Markdown } from "@smthrs/ui"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import type { DiffCard } from "@smthrs/rpc/DiffCard"
import type { CodeEditorViewProps, FileCard } from "@smthrs/rpc/FileCard"
import { BookOpen, CircleAlert, CircleDot, ExternalLink, FileSymlink, FileX, FolderSync, GitCommitHorizontal, Info, Link2, Signpost } from "lucide-react"
import { useController } from "../ControllerContext"
import { flowAction, type FlowActionProps } from "../flows/FlowAction"
import { flowArgs, hasFlowArgs } from "../flows/FlowArgs"
import type { Card } from "../state/AppState"
import { useDesignWorld } from "../state/seams/DesignWorld/hooks"
import { actorOf, refNumber } from "../state/seams/DesignWorld/todo"
import { branchOf, todoOf, type ActorId, type DesignBranch, type DesignWorldRows } from "../state/seams/DesignWorld"
import { designDefinition, designDiffs, designFileCard, designHover, subjectOf } from "../state/seams/DesignWorld/subjects"
import { ActorChip, actorName } from "./views/ActorChip"
import { CodeEditorSurface as CodeSurface } from "./CodeEditorSurface"

const DiffCardSurface = lazy(() => import("./DiffSurface").then(module => ({ default: module.DiffCardSurface })))

/** One press: the tag's flow, submitted through the registry from this card. */
const usePress = (cardId: string) => {
  const controller = useController()
  return <Tag extends CatalogTag>(tag: Tag, payload: Record<string, unknown> = {}): FlowActionProps =>
    flowAction(() => { void controller.commands.submit({ name: tag, payload, actor: "user", originCardId: cardId }) }, tag,
      hasFlowArgs(tag) ? flowArgs(tag, payload as never) : undefined)
}

const Who = ({ world, who, size = "s" }: { readonly world: DesignWorldRows; readonly who: ActorId; readonly size?: "s" | "m" }) =>
  <ActorChip actor={actorOf(world, who)} size={size} />

const nameOf = (world: DesignWorldRows, who: ActorId): string => actorName(actorOf(world, who))

const BranchChip = ({ branch, press }: { readonly branch: DesignBranch | undefined; readonly press: ReturnType<typeof usePress> }) =>
  branch === undefined ? <span className="mvp-branch-chip" data-main>main</span>
    : <button type="button" className="mvp-branch-chip" {...press("branch", { name: branch.name })}>{branch.name}</button>

const GitHubLink = ({ href }: { readonly href: string }) =>
  <a className="mvp-link" href={href} target="_blank" rel="noreferrer"><ExternalLink size={13} aria-hidden="true" />GitHub</a>

/* ── Issue ──────────────────────────────────────────────────── */

const Comment = ({ world, who, age, text }: { readonly world: DesignWorldRows; readonly who: ActorId; readonly age: string; readonly text: string }) => (
  <article className="mvp-comment">
    <Who world={world} who={who} />
    <div><header><b>{nameOf(world, who)}</b><span>{age}</span></header><p>{text}</p></div>
  </article>
)

const IssueBody = ({ card, number }: { readonly card: Card; readonly number: number }) => {
  const world = useDesignWorld()
  const press = usePress(card.id)
  const issue = world.issues.find(each => each.number === number)
  if (issue === undefined) return null
  const made = issue.todo === undefined ? undefined : todoOf(world, issue.todo)
  return (
    <div className="design-subject" data-subject="issue">
      <div className="mvp-meta">
        <span className="mvp-issue-state" data-open={issue.open || undefined}><CircleDot size={13} aria-hidden="true" />{issue.open ? "Open" : "Closed"}</span>
      </div>
      <div className="mvp-thread">
        <Comment world={world} who={issue.author} age={issue.age} text={issue.body} />
        {issue.comments.map((comment, index) => <Comment key={index} world={world} who={comment.who} age={comment.age} text={comment.text} />)}
      </div>
      <div className="mvp-actions">
        {made === undefined
          ? <Button variant="solid" size="sm" {...press("todo.new", { text: issue.body, title: issue.title })}>Make TODO</Button>
          : <span className="mvp-made"><GitCommitHorizontal size={14} aria-hidden="true" />Committed as
            <Button variant="ghost" size="sm" {...press("todo", { n: refNumber(made.ref) })}>{made.ref} ↗</Button></span>}
        <span className="mvp-actions-end">
          <Button variant="ghost" size="sm" {...press("issue.comment", { number })}>Comment</Button>
          <GitHubLink href={`https://github.com/${world.repo.repo}/issues/${issue.number}`} />
        </span>
      </div>
    </div>
  )
}

const IssuesBody = ({ card }: { readonly card: Card }) => {
  const world = useDesignWorld()
  const press = usePress(card.id)
  const open = world.issues.filter(each => each.open)
  return (
    <div className="design-subject" data-subject="issues">
      <ul className="mvp-rows">
        {open.map(issue => (
          <li key={issue.number}>
            <button type="button" className="mvp-row" {...press("issue", { number: issue.number })}>
              <span className="mvp-issue-state" data-open><CircleDot size={13} aria-hidden="true" /></span>
              <span className="mvp-row-title"><span className="mvp-issue-number">#{issue.number}</span> {issue.title}</span>
              <span className="mvp-row-meta">{nameOf(world, issue.author)} · {issue.age}{issue.comments.length > 0 ? ` · ${issue.comments.length}` : ""}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mvp-actions">
        <Button variant="outline" size="sm" {...press("issue.new")}>New issue</Button>
        <span className="mvp-actions-end"><GitHubLink href={`https://github.com/${world.repo.repo}/issues`} /></span>
      </div>
    </div>
  )
}

/* ── Files ──────────────────────────────────────────────────── */

const FilesBody = ({ card, branch }: { readonly card: Card; readonly branch: string }) => {
  const world = useDesignWorld()
  const press = usePress(card.id)
  const files = world.files.filter(each => each.branch === branch)
  return (
    <div className="design-subject" data-subject="files">
      <div className="mvp-meta"><BranchChip branch={branchOf(world, branch)} press={press} /></div>
      <ul className="mvp-rows">
        {files.map(file => (
          <li key={file.id}>
            <button type="button" className="mvp-row" {...press("file", { path: file.path, branch: file.branch })}>
              <span className="mvp-row-title mvp-mono">{file.path}</span>
              {(file.editors ?? []).length > 0 ? <span className="mvp-wiki-authors">{(file.editors ?? []).map(each => <Who key={each.who} world={world} who={each.who} />)}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* Ctrl-hover, Ctrl-click, Shift-F10 and F12 on a seeded file answer from the seed (subjects.ts designHover/designDefinition). */
const FILE_GESTURES: CodeEditorViewProps["gestures"] = { hover: { tag: "code.hover", label: "Hover" }, definition: { tag: "code.definition", label: "Go to definition" } }

const FileBody = ({ card, subject }: { readonly card: Extract<Card, { kind: "file" }>; readonly subject: string }) => {
  const world = useDesignWorld()
  const press = usePress(card.id)
  const [intel, setIntel] = useState<Pick<FileCard, "hover" | "reveal">>({})
  const file = world.files.find(each => each.id === subject)
  if (file === undefined) return null
  const model: FileCard = { ...designFileCard(world, file, card.payload.line), ...intel }
  const answer = (tag: CatalogTag, input?: Record<string, string>) => {
    const line = Number(input?.line)
    const col = Number(input?.col)
    if (!Number.isInteger(line) || !Number.isInteger(col)) return
    if (tag === "code.hover") {
      const hover = designHover(file, line, col)
      if (hover !== undefined) setIntel(current => ({ ...current, hover }))
    } else if (tag === "code.definition") {
      const reveal = designDefinition(file, line, col)
      if (reveal !== undefined) setIntel(current => ({ ...current, reveal }))
    }
  }
  const restore = press("file.restore", { path: file.path, branch: file.branch, revision: "before" })
  return (
    <div className="design-subject" data-subject="file">
      {model.gone === undefined ? null : (
        <div className="mvp-file-notice" data-mock="file-gone">
          {model.gone.kind === "deleted" ? <FileX size={14} aria-hidden="true" /> : <FileSymlink size={14} aria-hidden="true" />}
          <span>{model.gone.kind === "deleted" ? `Deleted by ${actorName(model.gone.by)}` : <>Renamed to <code>{model.gone.to.split("/").at(-1)}</code> by {actorName(model.gone.by)}</>}</span>
          <span className="mvp-actions-end"><Button size="sm" variant="outline" {...restore}>Restore</Button></span>
        </div>
      )}
      {model.outside === undefined || model.gone !== undefined ? null : (
        <div className="mvp-file-notice" data-tone="outside" data-mock="file-outside">
          <FolderSync size={14} aria-hidden="true" />
          <span>Changed outside Smithers</span>
          <span className="mvp-actions-end"><Button size="sm" variant="outline" {...restore}>Restore</Button></span>
        </div>
      )}
      {model.editors.length === 0 ? null : (
        <div className="mvp-meta"><span className="mvp-wiki-authors">{model.editors.map((each, index) => <ActorChip key={index} actor={each.actor} size="s" />)}</span></div>
      )}
      <CodeSurface model={model} actions={[]} gestures={FILE_GESTURES} onAction={answer} view={{ maximized: false }} onView={() => {}} />
    </div>
  )
}

/* ── Diff ───────────────────────────────────────────────────── */

const DiffBody = ({ card, subject }: { readonly card: Card; readonly subject: string }) => {
  const world = useDesignWorld()
  const controller = useController()
  const diffs = designDiffs(world, subject)
  const submit = (tag: CatalogTag, payload: Record<string, unknown>) => { void controller.commands.submit({ name: tag, payload, actor: "user", originCardId: card.id }) }
  if (diffs.length === 0) return <p className="world-card-empty">No changes yet</p>
  return (
    <div className="design-subject" data-subject="diff">
      {diffs.map((diff: DiffCard) => (
        <Suspense key={diff.path} fallback={<pre className="world-card-path">{diff.path}</pre>}>
          <DiffCardSurface model={diff}
            actions={diff.against.kind === "burst" ? [{ tag: "file.restore", label: "Restore this file" }] : []}
            gestures={{}} view={{ maximized: false }} onView={() => {}}
            onAction={tag => submit(tag, { path: diff.path, branch: world.branches.find(each => each.name === diff.branch)?.id ?? diff.branch, revision: "before" })} />
        </Suspense>
      ))}
    </div>
  )
}

/* ── Wiki page ──────────────────────────────────────────────── */

/** A block's inline Markdown: `code` spans. */
const Inline = ({ text }: { readonly text: string }) =>
  <>{text.split("`").map((piece, index) => index % 2 === 1 ? <code key={index}>{piece}</code> : <Fragment key={index}>{piece}</Fragment>)}</>

const WikiBody = ({ card, pageId }: { readonly card: Card; readonly pageId: string }) => {
  const world = useDesignWorld()
  const press = usePress(card.id)
  const page = world.wiki.find(each => each.id === pageId)
  if (page === undefined) return null
  const decision = page.decision
  const editors = page.editors ?? []
  return (
    <div className="design-subject" data-subject="wiki">
      <div className="mvp-meta">
        <span className="mvp-wiki-rev" title={`r${page.rev} by ${page.authors.map(each => nameOf(world, each)).join(" and ")}`}>
          <span className="mvp-wiki-rev-chip"><BookOpen size={12} aria-hidden="true" />r{page.rev}</span>
          <span className="mvp-wiki-authors">{page.authors.map(each => <Who key={each} world={world} who={each} />)}</span>
        </span>
        {editors.length > 0 ? <span className="mvp-saved" data-saving><span className="mvp-saving-mark" aria-hidden="true" />Saving…</span> : null}
      </div>
      <div className="mvp-wiki-doc" role="group" aria-label={`${page.title}, r${page.rev}`}>
        {page.lines.map(line => {
          const others = editors.filter(each => each.line === line.n).map(each => each.who)
          const callout = decision === undefined || line.n < decision.from || line.n > decision.to ? undefined : line.n === decision.to ? "last" : "body"
          return (
            <Fragment key={line.n}>
              {decision !== undefined && line.n === decision.from ? (
                <div className="mvp-wiki-row">
                  <span className="mvp-wiki-flag" />
                  <div className="mvp-wiki-block mvp-wiki-head" data-callout="head">
                    <Signpost size={13} aria-hidden="true" />Decision
                    <span className="mvp-wiki-by"><Who world={world} who={decision.by} />Learning<span aria-hidden="true">·</span>
                      <a className="mvp-wiki-change" href={`https://github.com/${world.repo.repo}/pull/${decision.change}`} target="_blank" rel="noreferrer">#{decision.change} ↗</a></span>
                  </div>
                </div>
              ) : null}
              <div className="mvp-wiki-row">
                <span className="mvp-wiki-flag">{others[0] === undefined ? null : <Who world={world} who={others[0]} />}</span>
                <p className="mvp-wiki-block" data-callout={callout} data-mock={`wiki-line-${line.n}`}><Inline text={line.text} /></p>
              </div>
            </Fragment>
          )
        })}
      </div>
      {(page.cited ?? []).map(cite => {
        const item = todoOf(world, cite.todo)
        return item === undefined ? null : (
          <div key={cite.todo} className="mvp-wiki-row">
            <span className="mvp-wiki-flag" />
            <button type="button" className="mvp-wiki-cited" {...press("todo", { n: refNumber(item.ref) })}>
              <Link2 size={13} aria-hidden="true" />Cited by {item.ref}<span className="mvp-mono">r{cite.rev}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

/* ── Review ─────────────────────────────────────────────────── */

const SEVERITY = {
  blocker: { word: "Blocker", Icon: CircleAlert },
  fix: { word: "Fix", Icon: CircleDot },
  note: { word: "Note", Icon: Info }
} as const

const ReviewBody = ({ card, reviewId }: { readonly card: Card; readonly reviewId: string }) => {
  const world = useDesignWorld()
  const press = usePress(card.id)
  const review = world.reviews.find(each => each.id === reviewId)
  if (review === undefined) return null
  const branch = branchOf(world, review.branch)
  const item = branch?.item === undefined ? undefined : todoOf(world, branch.item)
  const n = item === undefined ? undefined : refNumber(item.ref)
  const line = (finding: (typeof review.findings)[number]) => `Please fix ${finding.path}:${finding.line}: ${finding.text}`
  const pending = review.findings.filter(each => each.acted === undefined)
  return (
    <div className="design-subject" data-subject="review">
      <div className="mvp-meta">
        <span className="mvp-verdict" data-verdict={review.verdict}>{review.verdict === "clean" ? "No findings" : `${review.findings.length} findings`}</span>
        <BranchChip branch={branch} press={press} /><span>against {branch?.from ?? "main"}</span>
        <span className="mvp-edited-by"><Who world={world} who={review.by} />{nameOf(world, review.by)}</span>
      </div>
      {review.findings.length === 0 ? null : (
        <ul className="mvp-findings">
          {review.findings.map((finding, index) => {
            const { word, Icon } = SEVERITY[finding.severity]
            return (
              <li key={index} data-severity={finding.severity} data-acted={finding.acted}>
                <span className="mvp-finding-kind"><Icon size={13} aria-hidden="true" />{word}</span>
                <button type="button" className="mvp-ws-where" {...press("file", { path: finding.path, branch: review.branch, line: finding.line })}>
                  {finding.path.split("/").at(-1)}:{finding.line}
                </button>
                <span className="mvp-finding-text">{finding.text}
                  {n === undefined || finding.acted !== undefined ? null
                    : <Button variant="ghost" size="sm" data-mock={`finding-fix-${review.id}-${index}`} {...press("todo.steer", { n, text: line(finding) })}>Please fix</Button>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <div className="mvp-actions">
        {n === undefined || pending.length === 0 ? null
          : <Button size="sm" variant="solid" data-mock={`review-send-${review.id}`} {...press("todo.steer", { n, text: pending.map(line).join("\n") })}>Send to the coding agent</Button>}
        <span className="mvp-actions-end"><Button size="sm" variant="ghost" {...press("diff", { branch: review.branch })}>Diff</Button></span>
      </div>
    </div>
  )
}

/* ── PR ─────────────────────────────────────────────────────── */

const PrBody = ({ card, number }: { readonly card: Card; readonly number: number }) => {
  const world = useDesignWorld()
  const press = usePress(card.id)
  const pr = world.prs.find(each => each.number === number)
  if (pr === undefined) return null
  const item = todoOf(world, pr.todo)
  return (
    <div className="design-subject" data-subject="pr">
      <div className="mvp-meta">
        <span className="mvp-issue-state" data-open={pr.state === "open" || undefined}><CircleDot size={13} aria-hidden="true" />{pr.state === "open" ? "Open" : pr.state === "merged" ? "Merged" : "Closed"}</span>
        <span className="mvp-mono">{pr.head} → {pr.base}</span>
        <span className="mvp-edited-by"><Who world={world} who={pr.requestedBy} />{nameOf(world, pr.requestedBy)}</span>
      </div>
      <Markdown className="mvp-pr-body" content={pr.body.join("\n")} />
      <div className="mvp-actions">
        {item === undefined ? null : <Button variant="ghost" size="sm" {...press("todo", { n: refNumber(item.ref) })}>{item.ref} ↗</Button>}
        <span className="mvp-actions-end"><GitHubLink href={`https://github.com/${world.repo.repo}/pull/${pr.number}`} /></span>
      </div>
    </div>
  )
}

/* ── The door ───────────────────────────────────────────────── */

/** The body of a `design:` card, by the subject its id names; null for an id this lane never wrote. */
export const DesignSubjectBody = ({ card }: { readonly card: Card }): ReactNode => {
  const at = subjectOf(card)
  if (at === undefined) return null
  switch (at.kind) {
    case "issue": return <IssueBody card={card} number={Number(at.subject)} />
    case "issues": return <IssuesBody card={card} />
    case "files": return <FilesBody card={card} branch={at.subject} />
    case "file": return card.kind === "file" ? <FileBody card={card} subject={at.subject} /> : null
    case "diff": return <DiffBody card={card} subject={at.subject} />
    case "wiki": return <WikiBody card={card} pageId={at.subject} />
    case "review": return <ReviewBody card={card} reviewId={at.subject} />
    case "pr": return <PrBody card={card} number={Number(at.subject)} />
    default: return null
  }
}
