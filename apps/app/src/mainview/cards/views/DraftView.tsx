import { useState } from "react"
import type { DraftViewProps } from "@smthrs/rpc/DraftCard"
import { GitCommitHorizontal, LockKeyhole } from "lucide-react"

/** Presentation only; author filtering and Draft admission belong to the Container. */
export function DraftView({ model, actions, gestures, onAction: dispatch }: DraftViewProps) {
  const edit = gestures.set
  const editable = edit !== undefined && edit.disabled === undefined
  const currentPlaceValue = JSON.stringify(model.place.mode === "append" ? { mode: "append" } : { mode: model.place.mode, n: model.place.n })
  // Reset only the changed field; preserve unsubmitted edits in other fields.
  const [title, setTitle] = useState({ current: model.title, value: model.title })
  if (title.current !== model.title) setTitle({ current: model.title, value: model.title })
  const [prompt, setPrompt] = useState({ current: model.prompt, value: model.prompt })
  if (prompt.current !== model.prompt) setPrompt({ current: model.prompt, value: model.prompt })
  const [acceptance, setAcceptance] = useState({ current: JSON.stringify(model.acceptance), value: model.acceptance.join("\n") })
  if (acceptance.current !== JSON.stringify(model.acceptance)) setAcceptance({ current: JSON.stringify(model.acceptance), value: model.acceptance.join("\n") })
  const [placeValue, setPlaceValue] = useState({ current: currentPlaceValue, value: currentPlaceValue })
  if (placeValue.current !== currentPlaceValue) setPlaceValue({ current: currentPlaceValue, value: currentPlaceValue })
  const [fixes, setFixes] = useState({ current: model.issue?.fixes ?? false, value: model.issue?.fixes ?? false })
  if (fixes.current !== (model.issue?.fixes ?? false)) setFixes({ current: model.issue?.fixes ?? false, value: model.issue?.fixes ?? false })
  const acceptanceValue = JSON.stringify(acceptance.value === "" ? [] : acceptance.value.split("\n"))
  const currentValues: Record<string, string> = { title: model.title, prompt: model.prompt, acceptance: JSON.stringify(model.acceptance), place: currentPlaceValue, fixes: String(model.issue?.fixes ?? false) }
  const onAction: typeof dispatch = (tag, args) => {
    if (tag === edit?.tag && args?.field && (args.field === "acceptance"
      ? acceptance.value === model.acceptance.join("\n")
      : args.value === currentValues[args.field])) return
    dispatch(tag, args)
  }
  const trueValue = String(true)
  const falseValue = String(false)
  const placeN = model.place.mode === "append" ? undefined : model.place.n
  const unavailable = placeN !== undefined && !model.place.options.some(item => item.n === placeN)
  return (
    <section className="smithers-card draft-view" data-kind="draft" data-keyboard-pane="Draft" aria-label="Draft">
      {model.drafting ? <p role="status">Drafting TODO…</p> : model.draftNote ? <p role="status">{model.draftNote}</p> : null}
      <header className="smithers-card-header draft-head">
        <GitCommitHorizontal size={14} aria-hidden="true" />
        <span>{model.place.mode === "amend" ? `Amend T${model.place.n}` : "New TODO"}</span>
        {model.private && !model.committed ? <span className="draft-private"><LockKeyhole size={12} aria-hidden="true" />Only you</span> : null}
      </header>
      <div className="smithers-card-body">
        {model.committed ? (
          <div className="draft-receipt"><GitCommitHorizontal size={14} aria-hidden="true" />
            <span>Committed as <span className="draft-ref">T{model.committed.n}</span></span>
            {model.committed.rev > 1 ? <span className="draft-ref">+{model.committed.rev - 1}</span> : null}
            <b>{model.title}</b>
          </div>
        ) : <>
          <label className="draft-field"><span>Title</span>
            {editable ? <input value={title.value} onInput={event => setTitle({ current: title.current, value: event.currentTarget.value })} data-flow={edit.tag}
              onBlur={() => onAction(edit.tag, { ...edit.args, field: "title", value: title.value })} /> : <input value={title.value} readOnly />}
          </label>
          <label className="draft-field"><span>Prompt</span>
            {editable ? <textarea rows={4} value={prompt.value} onInput={event => setPrompt({ current: prompt.current, value: event.currentTarget.value })} data-flow={edit.tag}
              onBlur={() => onAction(edit.tag, { ...edit.args, field: "prompt", value: prompt.value })} /> : <textarea rows={4} value={prompt.value} readOnly />}
          </label>
          <label className="draft-field"><span>Acceptance</span>
            {editable ? <textarea rows={Math.max(2, model.acceptance.length)}
              value={acceptance.value} onInput={event => setAcceptance({ current: acceptance.current, value: event.currentTarget.value })} data-flow={edit.tag}
              onBlur={() => onAction(edit.tag, { ...edit.args, field: "acceptance", value: acceptanceValue })} /> : <textarea rows={Math.max(2, model.acceptance.length)} value={acceptance.value} readOnly />}
          </label>
          <label className="draft-field-row"><span>Place</span>
            {editable ? <select value={placeValue.value} data-flow={edit.tag}
              onInput={event => setPlaceValue({ current: placeValue.current, value: event.currentTarget.value })}
              onChange={event => onAction(edit.tag, { ...edit.args, field: "place", value: event.currentTarget.value })}>
              {unavailable ? <option value={currentPlaceValue} disabled>{model.place.mode === "before" ? "Before" : "Amend"} T{placeN} (unavailable)</option> : null}
              <option value={'{"mode":"append"}'}>Append</option>
              {model.place.options.map(item => <option key={`before:${item.n}`} value={JSON.stringify({ mode: "before", n: item.n })}>Before T{item.n} {item.title}</option>)}
              {model.place.options.map(item => <option key={`amend:${item.n}`} value={JSON.stringify({ mode: "amend", n: item.n })}>Amend T{item.n} {item.title}</option>)}
            </select> : <select value={placeValue.value} disabled><option value={placeValue.value}>{model.place.mode === "append" ? "Append" : `${model.place.mode === "before" ? "Before" : "Amend"} T${model.place.n}`}</option></select>}
          </label>
          {model.issue ? <>
            <a className="draft-issue" href={model.issue.url} target="_blank" rel="noreferrer">#{model.issue.number} {model.issue.title}{model.issue.url ? " ↗" : ""}</a>
            <label className="draft-check">{editable ? <input type="checkbox" checked={fixes.value}
              onClick={event => setFixes({ current: fixes.current, value: event.currentTarget.checked })}
              data-flow={edit.tag} onChange={event => onAction(edit.tag, { ...edit.args, field: "fixes", value: event.currentTarget.checked ? trueValue : falseValue })} /> : <input type="checkbox" checked={fixes.value} disabled />}
              Closes #{model.issue.number} when merged
            </label>
          </> : null}
          {model.seed ? <div className="draft-seed"><span>Seed · Read-only</span>
            {model.seed.files.map(file => <code key={file}>{file}</code>)}
          </div> : null}
          {edit?.disabled ? <p className="draft-reason">{edit.disabled.reason}</p> : null}
        </>}
        {actions.length > 0 ? <div className="draft-actions">{actions.map((action, index) => (
          <div className="draft-action" key={`${action.tag}:${index}`}>
            {action.disabled ? <button type="button" data-flow={action.tag} disabled>{action.label}</button> : <button type="button" data-flow={action.tag} data-primary={action.primary || undefined}
              onClick={() => onAction(action.tag, { ...action.args })}>
              {action.label}
            </button>}
            {action.disabled ? <span className="draft-reason">{action.disabled.reason}</span> : null}
          </div>
        ))}</div> : null}
      </div>
    </section>
  )
}
