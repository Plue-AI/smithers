import type { DraftViewProps } from "@smthrs/rpc/DraftCard"
import { GitCommitHorizontal, LockKeyhole } from "lucide-react"

/** Presentation only; author filtering and Draft admission belong to the Container. */
export function DraftView({ model, actions, gestures, onAction }: DraftViewProps) {
  const edit = gestures.set
  const editable = edit !== undefined && edit.disabled === undefined
  const set = (field: string, value: string) => {
    if (edit && !edit.disabled) onAction(edit.tag, { ...edit.args, field, value })
  }
  const placeValue = model.place.mode === "append" ? "append" : `${model.place.mode}:${model.place.n}`
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
            <span>Committed as <span className="draft-ref">T{model.committed.n}</span> ↗</span>
            {model.committed.rev > 1 ? <span className="draft-ref">+{model.committed.rev - 1}</span> : null}
            <b>{model.title}</b>
          </div>
        ) : <>
          <label className="draft-field"><span>Title</span>
            <input key={model.title} defaultValue={model.title} readOnly={!editable} data-flow={edit?.tag}
              onBlur={event => set("title", event.currentTarget.value)} />
          </label>
          <label className="draft-field"><span>Prompt</span>
            <textarea key={model.prompt} rows={4} defaultValue={model.prompt} readOnly={!editable} data-flow={edit?.tag}
              onBlur={event => set("prompt", event.currentTarget.value)} />
          </label>
          <label className="draft-field"><span>Acceptance</span>
            <textarea key={JSON.stringify(model.acceptance)} rows={Math.max(2, model.acceptance.length)}
              defaultValue={model.acceptance.join("\n")} readOnly={!editable} data-flow={edit?.tag}
              onBlur={event => set("acceptance", JSON.stringify(event.currentTarget.value === "" ? [] : event.currentTarget.value.split("\n")))} />
          </label>
          <label className="draft-field-row"><span>Place</span>
            <select key={placeValue} defaultValue={placeValue} disabled={!editable} data-flow={edit?.tag}
              onBlur={event => {
                const [mode, n] = event.currentTarget.value.split(":")
                set("place", JSON.stringify(mode === "append" ? { mode } : { mode, n: Number(n) }))
              }}>
              <option value="append">Append</option>
              {model.place.options.map(item => <option key={`before:${item.n}`} value={`before:${item.n}`}>Before T{item.n} {item.title}</option>)}
              {model.place.options.map(item => <option key={`amend:${item.n}`} value={`amend:${item.n}`}>Amend T{item.n} {item.title}</option>)}
            </select>
          </label>
          {model.issue ? <>
            <a className="draft-issue" href={model.issue.url} target="_blank" rel="noreferrer">#{model.issue.number} {model.issue.title} ↗</a>
            <label className="draft-check"><input key={String(model.issue.fixes)} type="checkbox" defaultChecked={model.issue.fixes}
              disabled={!editable} data-flow={edit?.tag} onBlur={event => set("fixes", String(event.currentTarget.checked))} />
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
            <button type="button" data-flow={action.tag} data-primary={action.primary || undefined} disabled={!!action.disabled}
              onClick={() => { if (!action.disabled) onAction(action.tag, { ...action.args }) }}>
              {action.label}{action.label === "Commit" ? <span aria-hidden="true"> ⏎</span> : null}
            </button>
            {action.disabled ? <span className="draft-reason">{action.disabled.reason}</span> : null}
          </div>
        ))}</div> : null}
      </div>
    </section>
  )
}
