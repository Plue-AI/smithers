import type { TimelineLine, TimelineProps } from "@smthrs/rpc/TimelineCard"
export function Line({ line, inView, onView }: { line: TimelineLine; inView: boolean } & Pick<TimelineProps, "onView">) {
  const jump = () => onView({ jump_to: line.entry_id })
  return <li data-entry={line.entry_id} data-tone={line.tone} data-in-view={inView || undefined}><button type="button" onClick={jump}><span className="mvp-tl-node" aria-hidden="true">●</span><span className="mvp-tl-text"><b>{line.title}</b>{line.summary === undefined ? null : <span>{line.summary}</span>}</span></button></li>
}
