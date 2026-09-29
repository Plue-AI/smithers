/*
 * The box a person answers a question in.
 *
 * A capability gate is two buttons: Approve and Deny say everything. A
 * `HumanTask` gate is a question the run is stuck on — "which service owns the
 * retry budget?" — and a decision answers nothing. Run-3 of `coding/request`
 * parked forever partly for this reason: even once the gate reached the
 * approvals inbox there was nowhere to type the answer.
 *
 * One control per kind, and nothing else: `confirm` is two words, `select` is
 * the choices the question offered, `ask` is prose, `json` is prose that has
 * to parse. The refusal for unparseable JSON is shown HERE, while the person
 * is still looking at what they typed, rather than travelling to the run and
 * coming back as a refused attempt.
 */
import { useRef, useState } from "react"
import { Button, Textarea } from "@smthrs/ui"
import type { ApprovalQuestion } from "./ApprovalQuestion"
import { attemptWords } from "./ApprovalQuestion"

/** What a person typed, shaped for the question's kind, or why it cannot be sent. */
export const answerValue = (
  question: ApprovalQuestion,
  typed: string
): { readonly value: unknown } | { readonly error: string } => {
  const trimmed = typed.trim()
  if (question.kind === "json") {
    if (trimmed === "") return { error: "Type the JSON answer this question asks for." }
    try {
      return { value: JSON.parse(trimmed) as unknown }
    } catch {
      return { error: "That is not JSON. Check the quotes and brackets, then send it again." }
    }
  }
  if (trimmed === "") return { error: "Type an answer before sending it." }
  return { value: trimmed }
}

export const ApprovalAnswerForm = ({
  question,
  draft,
  onDraft,
  disabled,
  onAnswer
}: {
  readonly question: ApprovalQuestion
  readonly draft?: { readonly question: string; readonly text: string }
  readonly onDraft?: (value: string) => void
  readonly disabled: boolean
  readonly onAnswer: (answer: unknown) => void
}) => {
  // The DOM holds in-flight editing while form.set commits; the normalized
  // question's event projection restores the text on remount or reload.
  const box = useRef<HTMLTextAreaElement>(null)
  const pendingText = useRef<{ question: string | undefined; text: string } | undefined>(undefined)
  const restoreDraft = (node: HTMLTextAreaElement | null): void => {
    box.current = node
    if (node === null || draft === undefined) return
    if (pendingText.current?.question === draft.question && pendingText.current.text !== draft.text && node.ownerDocument.activeElement === node) return
    pendingText.current = undefined
    if (node.value !== draft.text) node.value = draft.text
  }
  const [answerNote, setAnswerNote] = useState<string | undefined>(undefined)
  const attempt = attemptWords(question)

  const send = (): void => {
    const shaped = answerValue(question, box.current?.value ?? "")
    if ("error" in shaped) {
      setAnswerNote(shaped.error)
      return
    }
    setAnswerNote(undefined)
    onAnswer(shaped.value)
  }

  return (
    <div className="sui-approval-answer" data-testid="approval-answer">
      <p className="sui-approval-question">{question.prompt}</p>
      {attempt === undefined ? null : <p className="smithers-card-note">{attempt}</p>}
      {question.kind === "confirm" ?
        (
          /* The gate's acts match the grant gate's: the affirmative is the
           * solid primary, at the same control height as Approve. */
          <div className="flow-run-actions">
            <Button variant="solid" disabled={disabled} data-testid="approval-answer-yes" onClick={() => onAnswer(true)}>
              Yes
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              data-testid="approval-answer-no"
              onClick={() => onAnswer(false)}
            >
              No
            </Button>
          </div>
        ) :
        question.kind === "select" ?
        (
          <div className="flow-run-actions">
            {(question.options ?? []).map((option) => (
              <Button
                key={option}
                variant="outline"
                disabled={disabled}
                data-testid={`approval-answer-option-${option}`}
                onClick={() => onAnswer(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        ) :
        (
          <>
            <Textarea
              key={draft?.question}
              ref={restoreDraft}
              defaultValue={draft?.text ?? ""}
              onInput={event => {
                pendingText.current = { question: draft?.question, text: event.currentTarget.value }
                onDraft?.(event.currentTarget.value)
              }}
              aria-label={question.prompt}
              data-testid="approval-answer-text"
              disabled={disabled}
              placeholder={question.kind === "json" ? "A JSON value" : "Your answer"}
            />
            <div className="flow-run-actions">
              <Button variant="solid" disabled={disabled} data-testid="approval-answer-send" onClick={send}>
                Send answer
              </Button>
            </div>
          </>
        )}
      {answerNote === undefined ? null : (
        <p className="sui-approval-error" role="alert">
          {answerNote}
        </p>
      )}
    </div>
  )
}
