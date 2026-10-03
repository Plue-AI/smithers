import { useState } from "react"
import type { DraftViewProps } from "@smthrs/rpc/DraftCard"
import { GitCommitHorizontal, LockKeyhole } from "lucide-react"

/** Presentation only; author filtering and Draft admission belong to the Container. */
export function DraftView({ model, actions, gestures, onAction }: DraftViewProps) {
  const edit = gestures.set
  const editable = edit !== undefined && edit.disabled === undefined
  const [title, setTitle] = useState(model.title)
  const [prompt, setPrompt] = useState(model.prompt)
  const [acceptance, setAcceptance] = useState(model.acceptance.join("\n"))
  const currentPlaceValue = JSON.stringify(model.place.mode === "append" ? { mode: "append" } : { mode: model.place.mode, n: model.place.n })
  const [placeValue, setPlaceValue] = useState(currentPlaceValue)
  const [fixes, setFixes] = useState(model.issue?.fixes ?? false)
  const acceptanceValue = JSON.stringify(acceptance === "" ? [] : acceptance.split("\n"))
  const trueValue = String(true)
  const falseValue = String(false)
  const placeN = model.place.mode === "append" ? undefined : model.place.n
  const unavailable = placeN !== undefined && !model.place.options.some(item => item.n === placeN)
  return (
    <section className="smithers-card draft-view" data-kind="draft" data-keyboard-pane="Draft" aria-label="Draft">
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
            {editable ? <input value={title} onInput={event => setTitle(event.currentTarget.value)} data-flow={edit.tag}
              onBlur={() => onAction(edit.tag, { ...edit.args, field: "title", value: title })} /> : <input value={title} readOnly />}
          </label>
          <label className="draft-field"><span>Prompt</span>
            {editable ? <textarea rows={4} value={prompt} onInput={event => setPrompt(event.currentTarget.value)} data-flow={edit.tag}
              onBlur={() => onAction(edit.tag, { ...edit.args, field: "prompt", value: prompt })} /> : <textarea rows={4} value={prompt} readOnly />}
          </label>
          <label className="draft-field"><span>Acceptance</span>
            {editable ? <textarea rows={Math.max(2, model.acceptance.length)}
              value={acceptance} onInput={event => setAcceptance(event.currentTarget.value)} data-flow={edit.tag}
              onBlur={() => onAction(edit.tag, { ...edit.args, field: "acceptance", value: acceptanceValue })} /> : <textarea rows={Math.max(2, model.acceptance.length)} value={acceptance} readOnly />}
          </label>
          <label className="draft-field-row"><span>Place</span>
            {editable ? <select value={placeValue} data-flow={edit.tag}
              onInput={event => setPlaceValue(event.currentTarget.value)}
              onChange={event => onAction(edit.tag, { ...edit.args, field: "place", value: event.currentTarget.value })}>
              {unavailable ? <option value={currentPlaceValue} disabled>{model.place.mode === "before" ? "Before" : "Amend"} T{placeN} (unavailable)</option> : null}
              <option value={'{"mode":"append"}'}>Append</option>
              {model.place.options.map(item => <option key={`before:${item.n}`} value={JSON.stringify({ mode: "before", n: item.n })}>Before T{item.n} {item.title}</option>)}
              {model.place.options.map(item => <option key={`amend:${item.n}`} value={JSON.stringify({ mode: "amend", n: item.n })}>Amend T{item.n} {item.title}</option>)}
            </select> : <select value={placeValue} disabled><option value={placeValue}>{model.place.mode === "append" ? "Append" : `${model.place.mode === "before" ? "Before" : "Amend"} T${model.place.n}`}</option></select>}
          </label>
          {model.issue ? <>
            <a className="draft-issue" href={model.issue.url} target="_blank" rel="noreferrer">#{model.issue.number} {model.issue.title} ↗</a>
            <label className="draft-check">{editable ? <input type="checkbox" checked={fixes}
              onClick={event => setFixes(event.currentTarget.checked)}
              data-flow={edit.tag} onChange={event => onAction(edit.tag, { ...edit.args, field: "fixes", value: event.currentTarget.checked ? trueValue : falseValue })} /> : <input type="checkbox" checked={fixes} disabled />}
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
