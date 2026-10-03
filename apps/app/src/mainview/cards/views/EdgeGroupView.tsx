import type { EdgeMapProps, ToastCard } from "@smthrs/rpc/ToastCard"
import { EdgeRow } from "./EdgeRowView"
export function Edge({ entries, direction, narrow, onAction, onView }: { entries: ToastCard[]; direction: "above" | "below" } & Pick<EdgeMapProps, "narrow" | "onAction" | "onView">) {
  const nearest = direction === "above" ? entries.at(-1) : entries[0]
  const jump = () => onView({ jump_to: nearest!.entry_id })
  const rest = direction === "above" ? entries.slice(2).at(-1) : entries[2]
  const more = () => onView({ jump_to: rest!.entry_id })
  if (!nearest) return null
  return <section className="mvp-edge" data-edge={direction} data-narrow={narrow || undefined} aria-label={`Live ${direction}`}>
    <button type="button" className="mvp-edge-pill" onClick={jump}>{direction === "above" ? "↑" : "↓"} {entries.length} live {direction}</button>
    <ol className="mvp-tl-edge">{entries.slice(0, 2).map(toast => <EdgeRow key={toast.id} toast={toast} onAction={onAction} onView={onView} />)}
      {rest ? <li><button type="button" className="mvp-tl-more" onClick={more}>+{entries.length - 2} {direction}</button></li> : null}
    </ol>
  </section>
}
