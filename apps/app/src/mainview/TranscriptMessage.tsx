import { dynamicFlowAction, flowAction, flowProps } from "./flows/FlowAction"
import { Button, ChatMessage, Markdown, Marker, Reasoning } from "@smthrs/ui"
import { CheckCircle2, Copy, RotateCcw } from "lucide-react"
import { useRef, useState } from "react"
import { useController } from "./ControllerContext"
import { INIT_GREETING, INIT_TITLE, type InitMessage } from "./HostOpening"
import type { Message } from "./state/AppState"
import { scrubToolEcho } from "./state/MessageScrub"
import { timeLabel } from "./Timestamps"
import { StorageRecoveryButton } from "./StorageRecoveryButton"
import { ContextLine } from "./ContextLine"
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
  return <ContextLine count={items.length} items={[...items]} expanded={expanded} onView={patch => setExpanded(patch.expanded)} />
}

export function TranscriptMessage({ entry, streamingMessageId }: { entry: { kind: "message"; message: Message } | { kind: "init"; message: InitMessage }; streamingMessageId?: string }) {
  const controller = useController()
  return entry.message.act !== undefined ?
  (
    <Marker
      key={entry.message.id}
      variant="note"
      className="bubble-system-note tool-act-line"
    >
      {entry.message.text}
    </Marker>
  ) :
  (
    <ChatMessage
      className="smithers-chat-message"
      key={entry.message.id}
      role={entry.message.role === "user" ? "user" : "assistant"}
      meta={entry.message.status !== "complete" ?
        (
          <Marker variant="note" live className="bubble-system-note">
            {systemNoteLabel(entry.message)}
          </Marker>
        ) :
        undefined}
    >
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
            content={scrubToolEcho(entry.message.text)}
          />
        ) :
        null}
      {entry.kind === "message" && entry.message.context !== undefined && entry.message.context.length > 0 ? <AnswerContext items={entry.message.context} /> : null}
      {/* The synthetic auth message has no clock time to tell. */}
      {entry.message.answeredAction && <p role="status">{entry.message.answeredAction.answer}</p>}
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
      {entry.message.action?.flow === STORAGE_RECOVERY_EXPORT ?
        <StorageRecoveryButton state={controller.storageRecoveryState} onDownload={() => { controller.runCommand(STORAGE_RECOVERY_EXPORT) }} /> :
        entry.message.action !== undefined ?
        (
          <Button
            className="message-cta"
            autoFocus={entry.message.id === "auth-state"}
            {...dynamicFlowAction(controller.runCommand, entry.message.action?.flow ?? "", entry.message.action?.args)}
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
        {entry.message.status === "failed" ?
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
    </ChatMessage>
  )
}
