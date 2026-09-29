import { flowAction, flowOf, flowProps } from "../flows/FlowAction"
import { Button } from "@smthrs/ui"
import { useCallback, useContext, useRef, type KeyboardEvent } from "react"
import { ControllerContext } from "../ControllerContext"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { writeOnlyGesture } from "../flows/CommandGesture"
import { flowArgs } from "../flows/FlowArgs"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { UserFailure, UserFailureCopy } from "@smthrs/rpc/UserFailure"

/*
 * THE FORM LAW (apps/app/AGENTS.md; docs/workbench-lanes/flow-forms.md): the
 * one form card every flow shares. Its fields derive from the flow's input
 * schema, its options come from the seams (controller/forms.ts), and its
 * draft IS the card payload: a field commits through `form.set` on every
 * input event (the DOM keeps in-flight editing and focus, never React
 * state), Submit is `form.submit` (the controller assembles the line
 * and runs the flow as whoever asked for it), Cancel is `card.dismiss`.
 * Every act names its flow through onRunCommand. An option the human cannot
 * pick is disabled and carries its reason.
 *
 * The keyboard (apps/app/AGENTS.md, keyboard-only access): the form the
 * human's own act rendered takes focus on its first unfilled required field.
 * The button door still has its trigger focused; the slash door's composer is
 * hidden by the time the form mounts, so the controller records that request
 * as a focus handoff (controller/forms.ts) and the card claims it once. A
 * submission disables the control that held focus, so focus is held at the
 * form (never <body>) until the outcome: refused returns it to the open field,
 * acted leaves it there. Cancel moves it to the next control after the card
 * before the card leaves. Options that arrive (or are withdrawn) while a field
 * holds focus swap its <input> and <select>; the replacement keeps the
 * keyboard unless the human has moved on.
 */

type FlowFormCard = Extract<Card, { kind: "flow-form" }>
type FlowFormField = FlowFormCard["payload"]["fields"][number]

/** A single-line Enter uses the same submission as the button, without interrupting IME input. */
const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
  if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
}

const blank = (value: string | number | boolean | undefined): boolean =>
  value === undefined || (typeof value === "string" && value.trim() === "")

const CONTROLS = "input:not(:disabled), textarea:not(:disabled), select:not(:disabled)"

/** The first required control the draft has not filled, else the first control. */
const firstOpenControl = (form: HTMLFormElement): HTMLElement | undefined => {
  const controls = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(CONTROLS)]
  return controls.find((control) => control.closest("[data-required='true']") !== null && control.type !== "checkbox" && control.value.trim() === "") ?? controls[0]
}

/** Hold focus at an element that is not a control (runtime/KeyboardPanes.focusControl's tabindex trick). */
const holdFocus = (target: HTMLElement): void => {
  target.tabIndex = -1
  target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true })
  target.focus({ preventScroll: true })
}

/** The next tabbable control after the form's card, else the last one before it. */
const focusNeighbor = (form: HTMLFormElement): void => {
  const card = form.closest<HTMLElement>(".smithers-card") ?? form
  const controls = [...form.ownerDocument.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, [tabindex]")]
    .filter((node) => !card.contains(node) && node.tabIndex >= 0 && !node.matches(":disabled") && node.closest("[hidden], [inert], [aria-hidden='true']") === null)
  const after = controls.find((node) => (card.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
  ;(after ?? controls.at(-1))?.focus()
}

/** The required fields the draft has not filled (a boolean is answered either way). */
export const unfilled = (payload: FlowFormCard["payload"]): ReadonlyArray<FlowFormField> =>
  payload.fields.filter((field) => field.required && field.kind !== "boolean" && field.kind !== "write-only" && blank(payload.draft[field.name]))

export const FlowFormCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: FlowFormCard
  readonly onRunCommand: RunCommand
}) => {
  const { flow, fields, draft, error } = card.payload
  const settled = card.status === "acted"
  const busy = card.payload.submitting === true
  const commit = (field: string, value: string): void => onRunCommand("form.set", flowArgs("form.set", { cardId: card.id, field, value }))
  const complete = unfilled(card.payload).length === 0 && fields.every(field => field.disabledReason === undefined)
  // Static previews and isolated tests mount without a controller; they keep the button handoff only.
  const controller = useContext(ControllerContext)
  const handoff = controller?.formFocus
  // Runs on mount and whenever the request (ordinal) or the submission state
  // changes, never on a draft edit: the DOM keeps in-flight editing and focus.
  const bindFocus = useCallback((node: HTMLFormElement | null): void => {
    if (node === null) return
    // Claim the handoff even when it cannot be honored: a request the human moved past must not fire later.
    const requested = handoff?.take(card.id) === true
    const active = node.ownerDocument.activeElement
    if (settled || busy) {
      // The control that held focus just disabled (Chrome drops it to <body> on the next frame): hold focus at the form.
      if (active !== null && active !== node && node.contains(active) && active.matches(":disabled")) holdFocus(node)
      return
    }
    // A refused submission: the keyboard goes back to the field it left.
    if (active === node) {
      firstOpenControl(node)?.focus()
      return
    }
    if (card.payload.via !== "user") return
    const fromButton = flowOf(active) === flow
    if ((!requested && !fromButton) || (active !== null && node.contains(active))) return
    // The human has moved on when focus rests on some other control; <body> and
    // the composer (hidden once its slash ran) are where the slash door left it.
    if (!fromButton && active !== null && active !== node.ownerDocument.body && active.closest(".composer-wrap") === null) return
    firstOpenControl(node)?.focus()
  }, [card.id, card.ordinal, card.payload.via, flow, settled, busy, handoff])
  // DOM bookkeeping, never application state: the field control that owned
  // focus when React detached it, for its replacement to claim in that commit.
  const detachedFocus = useRef<{ readonly row: Element; readonly node: Element } | undefined>(undefined)
  // Arriving (or withdrawn) options swap a select field's <input> and <select>,
  // and the browser drops a removed node's focus to <body>. A ref detaches
  // before its node leaves the DOM, so the cleanup still sees who owned focus;
  // the replacement in the same row (this card, this field) takes it only while
  // focus rests nowhere, so a human who moved on keeps the keyboard. A stable
  // node, a restored form, and a field nobody focused never match.
  const keepFocus = useCallback((node: HTMLInputElement | HTMLSelectElement | null): (() => void) | undefined => {
    const row = node?.closest("[data-field]") ?? null
    if (node === null || row === null) return undefined
    const detached = detachedFocus.current
    if (detached?.row === row) {
      detachedFocus.current = undefined
      const active = node.ownerDocument.activeElement
      if (detached.node !== node && !detached.node.isConnected && (active === null || active === node.ownerDocument.body)) node.focus({ preventScroll: true })
    }
    return () => {
      if (node.ownerDocument.activeElement === node) detachedFocus.current = { row, node }
    }
  }, [])
  const cancel = flowAction(onRunCommand, "card.dismiss", card.id)
  return (
    <form ref={bindFocus} className="flow-form" data-flow-name={flow} data-via={card.payload.via} onSubmit={(event) => {
      event.preventDefault()
      if (complete && !busy && !settled) {
        // Move before React disables the active input: browsers clear focus
        // synchronously on disable, before the updated ref can observe it.
        if (event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement)) holdFocus(event.currentTarget)
        const privateFields = [...event.currentTarget.querySelectorAll<HTMLInputElement>("input[type=password][data-write-only]")]
        if (privateFields.length === 0) onRunCommand("form.submit", card.id)
        else {
          const values: Record<string, string> = {}
          for (const input of privateFields) { values[input.dataset.writeOnly!] = input.value; input.value = "" }
          const gesture = writeOnlyGesture("form.submit", values)
          if (controller) void controller.submitCommand({ name: "form.submit", payload: { cardId: card.id }, actor: "user", originCardId: card.id, gesture }).finally(gesture.release)
          else gesture.release()
        }
      }
    }}>
      {fields.map((field) => {
        const value = draft[field.name]
        const text = value === undefined ? "" : String(value)
        const testId = `flow-form-${field.name}`
        const listId = `flow-form-options-${card.id}-${field.name}`
        const options = field.options ?? []
        const restoreDraft = (node: HTMLInputElement | HTMLTextAreaElement | null): void => {
          if (node === null || node.value === text) return
          // A durable snapshot can lag the next input event. Replaying it
          // into the active editor drops keystrokes; every input has already
          // dispatched form.set, so retain its buffer until focus moves on.
          if (node.ownerDocument.activeElement === node) return
          node.value = text
        }
        return (
          <label key={field.name} className="flow-form-row" data-field={field.name} data-kind={field.kind} data-required={field.required}>
            <span>{field.label}</span>
            {field.disabledReason !== undefined ? <select aria-label={field.label} data-testid={testId} disabled value="">
              <option value="" disabled>{field.label} · {field.disabledReason}</option>
            </select> : field.kind === "select" && options.length > 0 ?
              (
                <select
                  aria-label={field.label}
                  data-testid={testId}
                  ref={keepFocus}
                  value={text}
                  required={field.required}
                  disabled={settled || busy}
                  onChange={(event) => commit(field.name, event.currentTarget.value)}
                >
                  {/* The unpicked state: a select must be able to say "nothing yet" without inventing a default. */}
                  {options.some((option) => option.value === text) ? null : <option value="">{""}</option>}
                  {options.map((option) => (
                    <option key={option.value} value={option.value} disabled={option.disabled === true} title={option.reason}>
                      {option.disabled === true && option.reason !== undefined ? `${option.label} · ${option.reason}` : option.label}
                    </option>
                  ))}
                </select>
              ) :
              field.kind === "write-only" ?
              <input type="password" aria-label={field.label} data-testid={testId} data-write-only={field.name}
                autoComplete="new-password" spellCheck={false} required={field.required} disabled={settled || busy}
                onKeyDown={submitOnEnter} /> :
              field.kind === "textarea" ?
              <textarea aria-label={field.label}
                data-testid={testId} ref={restoreDraft} defaultValue={text} placeholder={field.placeholder} rows={12} required={field.required} disabled={settled || busy}
                onInput={event => commit(field.name, event.currentTarget.value)} /> :
              field.kind === "boolean" ?
              (
                <input
                  type="checkbox"
                  aria-label={field.label}
                  data-testid={testId}
                  checked={value === true}
                  disabled={settled || busy}
                  onChange={(event) => commit(field.name, event.currentTarget.checked ? "true" : "false")}
                />
              ) :
              (
                <>
                  <input
                    type={field.kind === "number" ? "number" : "text"}
                    step={field.kind === "number" ? "any" : undefined}
                    aria-label={field.label}
                    data-testid={testId}
                    ref={(node) => {
                      restoreDraft(node)
                      return keepFocus(node)
                    }}
                    defaultValue={text}
                    placeholder={field.placeholder}
                    required={field.required}
                    disabled={settled || busy}
                    list={options.length > 0 ? listId : undefined}
                    onInput={(event) => commit(field.name, event.currentTarget.value)}
                    onKeyDown={submitOnEnter}
                  />
                  {options.length > 0 ?
                    (
                      <datalist id={listId}>
                        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </datalist>
                    ) :
                    null}
                </>
              )}
          </label>
        )
      })}
      {settled ? null : (
        <div className="flow-run-actions">
          <Button variant="ghost" size="sm" data-testid="flow-form-cancel" disabled={busy} {...cancel} onClick={(event) => {
            // The card leaves with this act; a keyboard user's focus moves on before it does.
            if (event.currentTarget.form?.contains(event.currentTarget.ownerDocument.activeElement) === true) focusNeighbor(event.currentTarget.form)
            event.currentTarget.form?.querySelectorAll<HTMLInputElement>("input[type=password][data-write-only]").forEach(input => { input.value = "" })
            cancel.onClick()
          }}>
            Cancel
          </Button>
          <Button type="submit" size="sm" {...flowProps("form.submit")} data-testid="flow-form-submit" disabled={!complete || busy}>
            {card.payload.submitLabel ?? "Submit"}
          </Button>
        </div>
      )}
      {error !== undefined ?
        <FailureNotice className="sui-approval-error" data-testid="flow-form-failure" failure={formFailure(error, card.payload.errorKind)} /> :
        null}
    </form>
  )
}

type FlowFormErrorKind = NonNullable<Extract<Card, { kind: "flow-form" }>["payload"]["errorKind"]>

/*
 * A read or a run that failed says one sentence; its text stays behind
 * Details. Submit stays the retry, so neither offers one of its own.
 */
const FORM_FAILURES: Readonly<Record<FlowFormErrorKind, UserFailureCopy>> = {
  read: { fault: "infra", sentence: "Smithers could not load the choices for this form. Not your fault.", actions: [] },
  run: { fault: "infra", sentence: "Smithers could not run this. Not your fault.", actions: [] }
}

/** With no kind, the text is the form's own sentence about the input (controller/forms.ts), shown as is. */
const formFailure = (text: string, kind: FlowFormErrorKind | undefined): UserFailure => kind === undefined
  ? { tag: "FlowFormInput", fault: "user", sentence: text, actions: [], detail: "" }
  : describedFailure(kind === "read" ? "FlowFormReadFailed" : "FlowFormRunFailed", FORM_FAILURES[kind], text)

export const flowFormCardFamily: CardFamily<"flow-form"> = {
  "flow-form": {
    render: (card, actions) => <FlowFormCardBody card={card} onRunCommand={actions.onRunCommand} />,
    /* A form asks for input; a refusal belongs in its body, never a machine status pill. */
    pill: () => ""
  }
}
