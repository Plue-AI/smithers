import { EntryRow } from "./EntryRow"
import { PlaceholderAvatarUrl, type Actor } from "@smthrs/rpc/CardPrimitives"
import { flowArgs } from "./flows/FlowArgs"
import { answerActions } from "./flows/AnswerActions"
import { DiffAction } from "./cards/views/DiffAction"
import { dynamicFlowAction, flowAction, flowProps } from "./flows/FlowAction"
import { Button, Markdown, Marker, Reasoning } from "@smthrs/ui"
import { CheckCircle2, Copy, RotateCcw } from "lucide-react"
import { useRef, useState } from "react"
import { useController } from "./ControllerContext"
import { INIT_GREETING, INIT_TITLE, type InitMessage } from "./HostOpening"
import type { Message } from "./state/AppState"
import { scrubToolEcho } from "./state/MessageScrub"
import { timeLabel } from "./Timestamps"
import { StorageRecoveryButton } from "./StorageRecoveryButton"
import { ContextLine } from "./ContextLine"
import { contextActions } from "./flows/contextActions"
import { contextOpenAction } from "./flows/contextOpenAction"
import { ContextContainer } from "./ContextContainer"
import { STORAGE_RECOVERY_EXPORT } from "./state/StorageRecoveryContract"
import type { CommandOutcome } from "./flows/Commands"

const systemNoteLabel = (message: Message): string => {
  if (message.statusDetail !== undefined) return `Turn interrupted — ${message.statusDetail}`
  return message.status === "failed" ? "Turn failed" : "Turn interrupted"
}

function CopyMessageButton({
  text,
  onCopy
}: {
  readonly text: string
  readonly onCopy: (text: string) => Promise<CommandOutcome>
}) {
  const [copied, setCopied] = useState(false)
  const copyAttempt = useRef(0)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="message-action"
      {...flowProps("chat.copy-message")}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      onClick={() => {
        const attempt = ++copyAttempt.current
        setCopied(false)
        void onCopy(text).then(outcome => {
          if (outcome.status !== "executed" || attempt !== copyAttempt.current) return
          setCopied(true)
          window.setTimeout(() => {
            if (attempt === copyAttempt.current) setCopied(false)
          }, 1200)
        })
      }}
    >
      {copied ? <span className="message-action-copied">Copied</span> : <Copy size={12} />}
    </Button>
  )
}


/* The answer's Context line: expanding is this viewer's transient chrome (T-APP-17). */
function AnswerContext({ items }: { items: NonNullable<Message["context"]> }) {
  const [expanded, setExpanded] = useState(false)
  const controller = useController()
  const actions = contextActions(items, (tag, input) => controller.runCommand(tag, JSON.stringify(input)), contextOpenAction)
  return <ContextLine count={items.length} expanded={expanded} onView={patch => setExpanded(patch.expanded)} {...actions} />
}

export function TranscriptMessage({ entry, streamingMessageId }: { entry: { kind: "message"; message: Message } | { kind: "init"; message: InitMessage }; streamingMessageId?: string }) {
  const controller = useController()
  const context = entry.kind === "message" ? controller.contextLine(entry.message.id) : undefined
  const external = entry.kind === "message" && entry.message.origin === "external"
  const identity = controller.store.collections.identitySessions.get("identity")
  const member = identity?.state === "signed-in" && identity.login ? { login: identity.login, name: identity.login, avatar_url: PlaceholderAvatarUrl } : undefined
  const author: Actor = entry.message.actor ?? (entry.message.role === "user" && member
    ? { kind: "person", ...member, color_index: 0 }
    : entry.message.role === "smithers" ? { kind: "agent", id: "smithers", agent: "smithers", avatar_url: PlaceholderAvatarUrl, color_index: 6 }
    : { kind: "system", color_index: 7 })
  return <EntryRow
    kind={entry.message.act ? "event" : entry.message.role === "user" ? "prompt" : "answer"}
    author={author}
    title=""
    tone={entry.message.status === "failed" ? "failed" : entry.message.id === streamingMessageId ? "live" : "quiet"}
    source={{ origin: external ? "external" : undefined,
      session: external ? entry.message.session_id : undefined,
      correlation: external ? entry.message.correlation_id : undefined,
      participant: external ? entry.message.participant_id : undefined }}
    onAction={(tag, args) => { controller.runCommand(tag, JSON.stringify(args)) }}
    card={<>
      {entry.message.status !== "complete" ? <Marker variant="note" live className="bubble-system-note">{systemNoteLabel(entry.message)}</Marker> : null}
      {entry.message.reasoning !== undefined && entry.message.reasoning !== "" ?
        (
          <Reasoning
            className="message-reasoning"
            streaming={entry.message.id === streamingMessageId}
            title="Reasoning"
          >
            <div className="message-reasoning-text">{entry.message.reasoning}</div>
          </Reasoning>
        ) :
        null}
      {entry.kind === "init" ?
        (
          <div className="message-init" data-testid="init-message">
            <CheckCircle2 size={16} className="message-init-check" aria-label="Initialized" />
            <div className="message-init-body">
              {/* The greeting is a voice line, not a second headline — only
               * the title carries bold. */}
              <Markdown
                className="message-markdown message-init-greeting"
                content={INIT_GREETING}
              />
              <Markdown
                className="message-markdown message-init-title"
                content={`**${INIT_TITLE}**`}
              />
              <details className="message-init-details">
                <summary>Details</summary>
                <Markdown
                  className="message-markdown message-init-details-content"
                  content={entry.message.details}
                />
              </details>
            </div>
          </div>
        ) :
        entry.message.text !== "" ?
        (
          // scrubToolEcho: a weak model's tool call written into prose
          // is wire debris, never content — stripped at render only;
          // the store and dev-tools keep the raw truth.
          <Markdown
            className="message-markdown"
            content={external ? entry.message.text : scrubToolEcho(entry.message.text)}
          />
        ) :
        null}
      {!external && entry.kind === "message" && entry.message.role === "smithers" && entry.message.status === "complete" && entry.message.id !== streamingMessageId && !entry.message.action && scrubToolEcho(entry.message.text).trim() ? (() => {
        const bindings = answerActions((name, input) => controller.commands.submit({ name, payload: (input ?? {}) as Record<string, unknown>, actor: "user", ...(name === "wiki.save" ? { display: flowArgs("wiki.save", input as { name?: string; text?: string }) } : {}) }), scrubToolEcho(entry.message.text))
        return <div className="message-answer-actions">{bindings.actions.map(action => <DiffAction key={action.tag} action={action} onAction={bindings.onAction} />)}</div>
      })() : null}
{context ? <ContextContainer {...context} available={controller.contextAvailable()} dispatch={(tag, input) => controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user" })} /> : entry.kind === "message" && entry.message.context !== undefined ? <AnswerContext items={entry.message.context} /> : null}
      {/* The synthetic auth message has no clock time to tell. */}
      {!external && entry.message.answeredAction && <p role="status">{entry.message.answeredAction.answer}</p>}
      {entry.message.createdAt > 0 ?
        (
          <time
            className="message-time"
            dateTime={new Date(entry.message.createdAt).toISOString()}
          >
            {timeLabel(entry.message.createdAt)}
          </time>
        ) :
        null}
      {external ? null : entry.message.action?.flow === STORAGE_RECOVERY_EXPORT ?
        <StorageRecoveryButton state={controller.storageRecoveryState} onDownload={() => { controller.runCommand(STORAGE_RECOVERY_EXPORT) }} /> :
        entry.message.action !== undefined ?
        (
          <Button
            className="message-cta"
            autoFocus={entry.message.id === "auth-state"}
            {...dynamicFlowAction((name, args) => {
              const action = entry.message.action
              if (action?.revision && controller.commands.find(name)?.metadata.confirmPerson) {
                void controller.commands.confirm(entry.message.id, action.revision)
                return true
              }
              return controller.runCommand(name, args)
            }, entry.message.action?.flow ?? "", entry.message.action?.args)}
          >
            {entry.message.action.label}
          </Button>
        ) :
        null}
      <span className="message-actions">
        <CopyMessageButton
          text={entry.message.text}
          onCopy={(text) => controller.runCommandForResult("chat.copy-message", text)}
        />
        {!external && entry.message.status === "failed" ?
          (
            <Button
              variant="ghost"
              size="icon"
              className="message-action"
              aria-label="Retry turn"
              title="Retry turn"
              {...flowAction(controller.runCommand, "chat.retry")}
            >
              <RotateCcw size={12} />
            </Button>
          ) :
          null}
      </span>
    </>}
  />
}
