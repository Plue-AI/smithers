import { flowArgs } from "../flows/FlowArgs"
import { flowAction, flowProps } from "../flows/FlowAction"
/*
 * A conversation (DESIGN §3.1, §3.2), rendered inside the existing `issue`
 * card: rows, not bubbles (a thread is multi-party); one
 * header per persona within five minutes; day dividers; a persona that
 * resolves to an agent profile is a door to it; the task strip when the
 * issue carries intent metadata; the composer whose Enter sends through
 * `issues.comment`; pending rows that settle only on the server's answer.
 * The draft is transient chrome (AGENTS.md: an unsent draft is exempt).
 */
import { Button, Markdown, Textarea } from "@smthrs/ui"
import { useState } from "react"
import { AgentMark } from "../AgentMark"
import { resolvePersona, type PersonaRef } from "../Persona"
import type { Card } from "../state/AppState"
import { dayLabel, timeLabel } from "../Timestamps"
import type { CardProjectionAuthority, RunCommand } from "./CardFamily"

type IssueCard = Extract<Card, { kind: "issue" }>
type IssueRow = Extract<Card, { kind: "issue-list" }>["payload"]["issues"][number]
type Comment = IssueCard["payload"]["comments"][number]
type Threadish = Pick<IssueRow, "state" | "task" | "number"> & { readonly repo: string }

const GROUP_MS = 5 * 60_000

/** Who is reading, and the configured agent profiles personas resolve to; both from the store the card projects. */
export interface ThreadContext {
  readonly viewer?: string | undefined
  readonly profiles: ReadonlyArray<{ readonly id: string; readonly name: string }>
}
export const threadContext = (store: CardProjectionAuthority | undefined): ThreadContext => {
  const login = store?.collections.identitySessions?.get("identity")?.login ?? store?.collections.cloudSessions?.get("cloud")?.username
  const agents = store?.collections.cards?.get("agents")
  const profiles = agents?.kind === "agents" && "native" in agents.payload ? agents.payload.agents.map((agent) => ({ id: agent.id, name: agent.label })) : []
  return { viewer: login === null || login === "" ? undefined : login, profiles }
}

type Sync = NonNullable<IssueCard["payload"]["sync"]>

/** The mirrored conversation's link, from the mapping the record carries: Slack has a permalink; other providers have none. */
export const syncUrl = (sync: Pick<Sync, "provider" | "scopeId" | "conversationId" | "threadId">): string | undefined => {
  if (sync.provider !== "slack") return undefined
  const base = `https://app.slack.com/client/${encodeURIComponent(sync.scopeId)}/${encodeURIComponent(sync.conversationId)}`
  return sync.threadId === undefined ? base : `${base}/thread/${encodeURIComponent(sync.conversationId)}-${encodeURIComponent(sync.threadId)}`
}

/** The identity a comment was posted under: its persona (an agent profile when it names one), else its author. */
export const commentPersona = (comment: Pick<Comment, "author" | "authorAvatar" | "persona">, context: ThreadContext = { profiles: [] }): PersonaRef => {
  const persona = comment.persona
  if (persona !== undefined && persona.username !== "") return resolvePersona({ name: persona.username, iconUrl: persona.iconUrl }, context.profiles)
  const login = comment.author ?? "unknown"
  return { id: login, name: login, ...(comment.authorAvatar === undefined ? {} : { iconUrl: comment.authorAvatar }) }
}

/** Reactions as the chips read them: one per name with its count, and whether the viewer set it. */
export const reactionChips = (reactions: Comment["reactions"], viewer: string | undefined): ReadonlyArray<{ readonly name: string; readonly count: number; readonly mine: boolean }> => {
  const counts = new Map<string, { count: number; mine: boolean }>()
  for (const reaction of reactions ?? []) {
    if (!reaction.active) continue
    const held = counts.get(reaction.name) ?? { count: 0, mine: false }
    held.count += 1
    if (viewer !== undefined && reaction.actor === viewer) held.mine = true
    counts.set(reaction.name, held)
  }
  return [...counts].map(([name, { count, mine }]) => ({ name, count, mine }))
}

/** The issue strip: state, fixer and verifier — each only when recorded. */
export const TaskStrip = ({ thread, onRunCommand, compact = false }: { readonly thread: Threadish; readonly onRunCommand: RunCommand; readonly compact?: boolean }) => {
  const task = thread.task
  if (task === undefined) return null
  return (
    <span className="thread-task" data-compact={compact || undefined} aria-label="Issue">
      <span className="thread-state" data-state={thread.state}>▮ {thread.state}</span>
      {compact || task.fixedBy === undefined ? null : <span className="thread-by">fixed by <AgentMark persona={task.fixedBy} size={16} onRunCommand={onRunCommand} /></span>}
      {compact || task.verifiedBy === undefined ? null : <span className="thread-by">verified by <AgentMark persona={task.verifiedBy} size={16} onRunCommand={onRunCommand} /></span>}
    </span>
  )
}

/** The state acts an issue offers: a conversation opens and closes; an issue also gets fixed and verified. */
export const stateActions = (card: IssueCard, viewer?: string) => {
  const { state, task, number, repo } = card.payload
  const args = flowArgs("issues.close", { number, repo })
  const selfVerify = task?.fixedBy !== undefined && viewer !== undefined && task.fixedBy.id === viewer
  const acts: Array<{ readonly flow: "issues.close" | "issues.reopen" | "issues.fix" | "issues.verify"; readonly label: string; readonly disabled?: string }> = []
  if (state === "open") {
    if (task !== undefined) acts.push({ flow: "issues.fix", label: "Fixed" })
    acts.push({ flow: "issues.close", label: card.payload.kind === "chat" ? "Close" : "Close issue" })
  } else if (state === "fixed") {
    acts.push({ flow: "issues.verify", label: "Verify", ...(selfVerify ? { disabled: "fixed by you" } : {}) })
    acts.push({ flow: "issues.reopen", label: "Reopen" })
  } else if (state === "verified") {
    acts.push({ flow: "issues.close", label: "Close" })
    acts.push({ flow: "issues.reopen", label: "Reopen" })
  } else acts.push({ flow: "issues.reopen", label: card.payload.kind === "chat" ? "Reopen" : "Reopen issue" })
  return acts.map((act) => ({ ...act, args }))
}

const MessageRow = ({ comment, first, card, context, onRunCommand }: { readonly comment: Comment; readonly first: boolean; readonly card: IssueCard; readonly context: ThreadContext; readonly onRunCommand: RunCommand }) => {
  const { number, repo } = card.payload
  const persona = commentPersona(comment, context)
  const reactions = reactionChips(comment.reactions, context.viewer)
  return (
    <li className="thread-message" data-message={comment.id} data-continued={!first || undefined}>
      {first ? (
        <div className="thread-message-head">
          <AgentMark persona={persona} size={28} onRunCommand={onRunCommand} />
          {comment.createdAt === null ? null : <time className="thread-message-time" dateTime={comment.createdAt}>{timeLabel(Date.parse(comment.createdAt))}</time>}
        </div>
      ) : null}
      <div className="thread-message-body">
        <Markdown className="smithers-card-markdown" content={comment.commentBody} />
        {reactions.length === 0 || comment.id === undefined ? null : (
          <div className="thread-reactions" aria-label="Reactions">
            {reactions.map((reaction) => reaction.mine ? (
              <button key={reaction.name} type="button" className="thread-reaction" data-mine aria-label={`Remove your ${reaction.name} reaction`}
                {...flowAction(onRunCommand, "issues.comment.react", flowArgs("issues.comment.react", { number, repo, commentId: comment.id!, name: reaction.name, active: false }))}>
                {reaction.name} {reaction.count}
              </button>
            ) : <span key={reaction.name} className="thread-reaction">{reaction.name} {reaction.count}</span>)}
          </div>
        )}
      </div>
    </li>
  )
}

const Composer = ({ card, onRunCommand }: { readonly card: IssueCard; readonly onRunCommand: RunCommand }) => {
  const { number, repo } = card.payload
  const [draft, setDraft] = useState("")
  const trimmed = draft.trim()
  /* Enter and the Send button are the same act: issues.comment with the number, the text and the repository. */
  const send = () => {
    if (trimmed === "") return
    onRunCommand("issues.comment", flowArgs("issues.comment", { number, repo, text: trimmed }))
    setDraft("")
  }
  return (
    <form className="thread-composer" aria-label="Message" onSubmit={(event) => {
      event.preventDefault()
      if (trimmed === "") return
      onRunCommand("issues.comment", flowArgs("issues.comment", { number, repo, text: trimmed }))
      setDraft("")
    }}>
      <Textarea
        aria-label="Message"
        placeholder="Message"
        rows={1}
        value={draft}
        data-testid="thread-composer"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
          if (event.key === "Escape") event.currentTarget.blur()
        }}
      />
      <Button type="submit" size="sm" variant="solid" {...flowProps("issues.comment")} disabled={trimmed === ""}>Send</Button>
    </form>
  )
}

/** The mirror's delivery state, only when it is not simply synced; the record's own word. */
const syncStateWords = (sync: Sync): string | undefined =>
  sync.state === undefined || sync.state === "synced" ? undefined : sync.state.replace("_", " ")

/** The conversation body of a chat issue. */
export const IssueThreadBody = ({ card, onRunCommand, projectionStore }: { readonly card: IssueCard; readonly onRunCommand: RunCommand; readonly projectionStore?: CardProjectionAuthority | undefined }) => {
  const { comments, issueBody, sync, task, state, author, authorAvatar, number, repo } = card.payload
  const context = threadContext(projectionStore)
  const pending = card.payload.pendingComments ?? []
  const rows: Array<{ readonly comment: Comment; readonly first: boolean; readonly day: string }> = []
  let previous: Comment | undefined
  for (const comment of comments) {
    const at = comment.createdAt === null ? Number.NaN : Date.parse(comment.createdAt)
    const before = previous?.createdAt === null || previous?.createdAt === undefined ? Number.NaN : Date.parse(previous.createdAt)
    const first = previous === undefined || commentPersona(previous, context).id !== commentPersona(comment, context).id || Number.isNaN(at) || Number.isNaN(before) || at - before > GROUP_MS
    rows.push({ comment, first, day: comment.createdAt === null ? "" : dayLabel(comment.createdAt) })
    previous = comment
  }
  const days = [...new Set(rows.map((row) => row.day))]
  const acts = stateActions(card, context.viewer)
  const opener: PersonaRef | undefined = author === null ? undefined : { id: author, name: author, ...(authorAvatar === undefined ? {} : { iconUrl: authorAvatar }) }
  const viewer: PersonaRef | undefined = context.viewer === undefined ? undefined : { id: context.viewer, name: context.viewer }
  const syncState = sync === undefined ? undefined : syncStateWords(sync)
  const syncLink = sync === undefined ? undefined : syncUrl(sync)
  return (
    <article className="thread" data-testid={`conversation-${number}`} data-kind={task === undefined ? "conversation" : "issue"} data-state={state} data-keyboard-pane={card.payload.title}>
      {task === undefined && sync === undefined ? null : (
        <header className="thread-head">
          <TaskStrip thread={{ ...card.payload, repo }} onRunCommand={onRunCommand} />
          {sync === undefined ? null : (
            <span className="thread-slack-state" data-state={sync.state}>
              {syncState === undefined ? null : <span className="thread-slack">{syncState}</span>}
              {syncLink === undefined ? <span className="thread-slack">{sync.provider}</span>
                : <a className="thread-slack thread-slack-link" href={syncLink} target="_blank" rel="noreferrer">{sync.provider} ↗</a>}
            </span>
          )}
        </header>
      )}
      <ol className="thread-messages" aria-label="Messages">
        {issueBody === "" ? null : (
          <li className="thread-message" data-message="body">
            {opener === undefined ? null : <div className="thread-message-head"><AgentMark persona={opener} size={28} onRunCommand={onRunCommand} /></div>}
            <div className="thread-message-body"><Markdown className="smithers-card-markdown" content={issueBody} /></div>
          </li>
        )}
        {days.map((day) => (
          <li key={day || "undated"} className="thread-day-group">
            {day === "" ? null : <p className="thread-day">{day}</p>}
            <ol className="thread-messages">
              {rows.filter((row) => row.day === day).map((row, index) => <MessageRow key={row.comment.id ?? `${day}-${index}`} comment={row.comment} first={row.first} card={card} context={context} onRunCommand={onRunCommand} />)}
            </ol>
          </li>
        ))}
        {pending.map((request) => (
          <li key={request.id} className="thread-message thread-pending" data-pending={request.status} aria-label="Pending message">
            <div className="thread-message-head">
              {request.persona !== undefined && request.persona.username !== "" ? <AgentMark persona={resolvePersona({ name: request.persona.username, iconUrl: request.persona.iconUrl }, context.profiles)} size={28} onRunCommand={onRunCommand} />
                : viewer === undefined ? null : <AgentMark persona={viewer} size={28} />}
              <span className="thread-pending-word" role={request.status === "requested" ? undefined : "status"}>
                {request.status === "requested" ? "sending…" : request.status === "unknown" ? "Delivery unknown" : "Not delivered"}
              </span>
              {request.status === "requested" ? null : (
                <Button size="sm" variant="outline" {...flowAction(onRunCommand, "issues.comment.retry", flowArgs("issues.comment.retry", { cardId: card.id, requestId: request.id }))}>Retry</Button>
              )}
            </div>
            <div className="thread-message-body">
              <Markdown className="smithers-card-markdown" content={request.text} />
              {request.error === undefined ? null : <p className="sui-approval-error">{request.error}</p>}
            </div>
          </li>
        ))}
      </ol>
      {state === "closed" ? null : <Composer card={card} onRunCommand={onRunCommand} />}
      <div className="flow-run-actions thread-actions">
        {acts.map((act) => (
          <Button key={act.flow} size="sm" variant="outline" disabled={act.disabled !== undefined} title={act.disabled}
            {...flowAction(onRunCommand, act.flow, act.args)}>{act.label}</Button>
        ))}
      </div>
    </article>
  )
}
