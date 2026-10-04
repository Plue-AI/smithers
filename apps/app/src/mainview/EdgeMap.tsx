import type { EdgeMapProps, ToastCard } from "@smthrs/rpc/ToastCard"

type EdgeProps = { entries: ToastCard[]; direction: "above" | "below" } & Pick<EdgeMapProps, "narrow" | "onAction" | "onView">

function EdgeRow({ toast, onAction, onView }: { toast: ToastCard } & Pick<EdgeMapProps, "onAction" | "onView">) {
  const action = toast.action
  const jump = () => onView({ jump_to: toast.entry_id })
  const press = () => { if (action) onAction(action.tag, action.args ?? {}) }
  return <li data-tone={toast.tone}>
    <button type="button" className="mvp-tl-row" onClick={jump}><span className="mvp-tl-node" aria-hidden="true">●</span>
      <span className="mvp-tl-text"><b>{toast.title}</b>{toast.detail === undefined ? null : <span>{toast.detail}</span>}</span>
    </button>
    {action ? <span className="mvp-tl-actions"><button type="button" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={press}>{action.label}</button>
      {action.disabled ? <span>{action.disabled.reason}</span> : null}</span> : null}
  </li>
}

function Edge({ entries, direction, narrow, onAction, onView }: EdgeProps) {
  // Attention first, then failed, then live; the nearest of those is the pill's jump.
  const nearest = direction === "above" ? entries.at(-1) : entries[0]
  const rest = entries[2]
  const jump = () => { if (nearest) onView({ jump_to: nearest.entry_id }) }
  const more = () => { if (rest) onView({ jump_to: rest.entry_id }) }
  if (!nearest) return null
  const tone = entries.some(entry => entry.tone === "attention") ? "attention" : entries.some(entry => entry.tone === "failed") ? "failed" : "live"
  return <section className="mvp-edge" data-edge={direction} data-narrow={narrow || undefined} aria-label={`Live ${direction}`}>
    <button type="button" className="mvp-edge-pill" data-tone={tone} onClick={jump}>{direction === "above" ? "↑" : "↓"} {entries.length} live {direction}</button>
    <ol className="mvp-tl-edge" data-edge={direction === "above" ? "top" : "bottom"}>
      {entries.slice(0, 2).map(toast => <EdgeRow key={toast.id} toast={toast} onAction={onAction} onView={onView} />)}
      {rest ? <li><button type="button" className="mvp-tl-more" onClick={more}>+{entries.length - 2} {direction}</button></li> : null}
    </ol>
  </section>
}

/** Live work off screen, pinned to the top and bottom edges (T-UI-08). */
export function EdgeMap({ above, below, narrow, onAction, onView }: EdgeMapProps) {
  return <div className="mvp-edge-map">
    <Edge entries={above} direction="above" narrow={narrow} onAction={onAction} onView={onView} />
    <Edge entries={below} direction="below" narrow={narrow} onAction={onAction} onView={onView} />
  </div>
}
