import { useCallback, useRef, useSyncExternalStore } from "react"
import type { TimelineLine, TimelineProps } from "@smthrs/rpc/TimelineCard"

const WIDE = "(min-width: 1180px)"

function Line({ line, inView, onView }: { line: TimelineLine; inView: boolean } & Pick<TimelineProps, "onView">) {
  const jump = () => onView({ jump_to: line.entry_id })
  return <li data-entry={line.entry_id} data-kind={line.kind} data-tone={line.tone} data-in-view={inView || undefined}>
    <button type="button" onClick={jump}><span className="mvp-tl-node" aria-hidden="true">●</span>
      <span className="mvp-tl-text"><b>{line.title}</b>{line.summary === undefined ? null : <span>{line.summary}</span>}</span>
    </button>
  </li>
}

/** One line per conversation entry; the band marks what is on screen (T-UI-08). */
export function Timeline({ lines, on_screen, onView }: TimelineProps) {
  const callback = useRef(onView)
  callback.current = onView
  const previous = useRef<boolean | undefined>(undefined)
  // The viewport is an external browser store: report only transitions, through React's store boundary.
  const subscribe = useCallback((notify: () => void) => {
    const media = window.matchMedia(WIDE)
    const report = () => {
      if (previous.current !== media.matches) {
        previous.current = media.matches
        callback.current({ timeline_visible: media.matches })
      }
      notify()
    }
    report()
    media.addEventListener("change", report)
    return () => media.removeEventListener("change", report)
  }, [])
  useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false)
  const first = lines.findIndex(line => line.entry_id === on_screen[0])
  const last = lines.findIndex(line => line.entry_id === on_screen[1])
  return <nav className="mvp-timeline" aria-label="Timeline"><ol>{lines.map((line, index) =>
    <Line key={line.entry_id} line={line} inView={first >= 0 && last >= first && index >= first && index <= last} onView={onView} />)}</ol></nav>
}
