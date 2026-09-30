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
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"

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

/** A due date in the fewest words: the weekday inside a week, else the day. */
export const dueWords = (iso: string, now: number = Date.now()): { readonly words: string; readonly past: boolean } => {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return { words: iso, past: false }
  const days = Math.round((at - now) / 86_400_000)
  const words = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 && days < 7 ? new Date(at).toLocaleDateString("en-US", { weekday: "short" }) : iso.slice(5, 10)
  return { words, past: at < now }
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

/** The issue strip: state, owner, due, priority, parent, fixer and verifier — each only when recorded. */
export const TaskStrip = ({ thread, onRunCommand, compact = false }: { readonly thread: Threadish; readonly onRunCommand: RunCommand; readonly compact?: boolean }) => {
  const task = thread.task
  if (task === undefined) return null
  const due = task.due === undefined ? undefined : dueWords(task.due)
  const settled = thread.state === "closed" || thread.state === "verified"
  return (
    <span className="thread-task" data-compact={compact || undefined} aria-label="Issue">
      <span className="thread-state" data-state={thread.state}>▮ {thread.state}</span>
      {task.owner === undefined ? null : <AgentMark persona={task.owner} size={16} nameless={compact} onRunCommand={compact ? undefined : onRunCommand} />}
      {due === undefined ? null : <span className="thread-due" data-past={due.past && !settled}>{due.words}</span>}
      {task.priority === undefined ? null : <span className="thread-priority" data-priority={task.priority}>P{task.priority}</span>}
      {task.parent === undefined ? null : compact ? <span className="thread-parent">#{task.parent.number}</span> : (
        <button type="button" className="thread-ref" {...flowAction(onRunCommand, "issues.view", flowArgs("issues.view", { number: task.parent.number, repo: thread.repo }))}>
          #{task.parent.number}{task.parent.title === undefined ? "" : ` ${task.parent.title}`}
        </button>
      )}
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

/** A comment mirrored from a chat says where it came from; an app comment says nothing. */
export const OriginMark = ({ origin }: { readonly origin: Comment["origin"] }) =>
  origin === undefined || origin === "app" ? null : <span className="thread-slack thread-origin" data-origin={origin}>· {origin}</span>

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
          <OriginMark origin={comment.origin} />
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

/* What a chat's delivery trouble says, by the mirror's state; its own error text stays behind Details. */
export const THREAD_SYNC_FAILURES: Readonly<Record<NonNullable<Sync["state"]> | "unknown", UserFailureCopy>> = {
  synced: { fault: "dependency", sentence: "Smithers had trouble syncing this chat. Not your fault.", actions: [] },
  pending: { fault: "dependency", sentence: "Smithers is still trying to deliver the latest message. Not your fault.", actions: [] },
  dispatching: { fault: "dependency", sentence: "Smithers is still trying to deliver the latest message. Not your fault.", actions: [] },
  outcome_unknown: { fault: "dependency", sentence: "Smithers does not know whether the latest message arrived. Not your fault.", actions: [] },
  failed: { fault: "dependency", sentence: "Smithers could not deliver the latest message. Not your fault.", actions: [] },
  unsupported: { fault: "dependency", sentence: "The latest message was not delivered to this chat. Not your fault.", actions: [] },
  unknown: { fault: "dependency", sentence: "Smithers had trouble syncing this chat. Not your fault.", actions: [] }
}

/* A resolution the owner chose that did not save, by its request status. */
export const THREAD_RESOLUTION_FAILURES: Readonly<Record<NonNullable<Sync["resolution"]>["status"], UserFailureCopy>> = {
  requested: { fault: "wait", sentence: "Smithers is still saving your resolution. Not your fault.", actions: [] },
  failed: { fault: "infra", sentence: "Smithers could not save your resolution. Not your fault.", actions: [] }
}

/* A message that did not send, by its pending status. */
export const THREAD_MESSAGE_FAILURES: Readonly<Record<NonNullable<IssueCard["payload"]["pendingComments"]>[number]["status"], UserFailureCopy>> = {
  requested: { fault: "wait", sentence: "Smithers is still sending this message. Not your fault.", actions: [] },
  failed: { fault: "infra", sentence: "Smithers could not send this message. Not your fault.", actions: ["retry"] },
  unknown: { fault: "infra", sentence: "Smithers does not know whether this message was sent. Not your fault.", actions: ["retry"] }
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
    const first = previous === undefined || commentPersona(previous, context).id !== commentPersona(comment, context).id || previous.origin !== comment.origin || Number.isNaN(at) || Number.isNaN(before) || at - before > GROUP_MS
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
              {sync.error ? <FailureNotice role="status" className="thread-sync-failure" data-testid="thread-sync-failure"
                failure={describedFailure(`ThreadSync.${sync.state ?? "unknown"}`, THREAD_SYNC_FAILURES[sync.state ?? "unknown"], sync.error)} /> : null}
              {sync.resolution?.error ? <FailureNotice className="thread-sync-failure" data-testid="thread-resolution-failure"
                failure={describedFailure(`ThreadResolution.${sync.resolution.status}`, THREAD_RESOLUTION_FAILURES[sync.resolution.status], sync.resolution.error)} /> : null}
              {sync.state === "outcome_unknown" && sync.deliveryId !== undefined ? <Button {...flowAction(onRunCommand, "issues.sync.resolve", flowArgs("issues.sync.resolve", { cardId: card.id, deliveryId: sync.deliveryId }))}>Resolve</Button> : null}
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
              {request.error !== undefined && request.status !== "requested" ? null : (
                <>
                  <span className="thread-pending-word" role={request.status === "requested" ? undefined : "status"}>
                    {request.status === "requested" ? "sending…" : request.status === "unknown" ? "Delivery unknown" : "Not delivered"}
                  </span>
                  {request.status === "requested" ? null : (
                    <Button size="sm" variant="outline" {...flowAction(onRunCommand, "issues.comment.retry", flowArgs("issues.comment.retry", { cardId: card.id, requestId: request.id }))}>Retry</Button>
                  )}
                </>
              )}
            </div>
            <div className="thread-message-body">
              <Markdown className="smithers-card-markdown" content={request.text} />
              {request.error === undefined ? null : (
                <FailureNotice role="status" className="thread-pending-failure" data-testid={`thread-pending-failure-${request.id}`}
                  failure={describedFailure(`ThreadMessage.${request.status}`, THREAD_MESSAGE_FAILURES[request.status], request.error)}
                  actions={{ retry: flowAction(onRunCommand, "issues.comment.retry", flowArgs("issues.comment.retry", { cardId: card.id, requestId: request.id })) }} />
              )}
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
