import { useCallback, useRef, useSyncExternalStore } from "react"
import type { TimelineProps } from "@smthrs/rpc/TimelineCard"
import { Line } from "./cards/views/TimelineLineView"
export function Timeline({ lines, on_screen, onView }: TimelineProps) {
  const callback = useRef(onView)
  callback.current = onView
  const previous = useRef<boolean | undefined>(undefined)
  // The viewport is an external browser store. Subscribe through React's store
  // boundary; report only transitions, independently of the parent's callback identity.
  const subscribe = useCallback((notify: () => void) => {
    const media = window.matchMedia("(min-width: 1180px)")
    const onView = (patch: { timeline_visible: boolean }) => {
      if (previous.current !== patch.timeline_visible) {
        previous.current = patch.timeline_visible
        callback.current(patch)
      }
      notify()
    }
    const report = () => onView({ timeline_visible: media.matches })
    report()
    media.addEventListener("change", report)
    return () => media.removeEventListener("change", report)
  }, [])
  useSyncExternalStore(subscribe, () => window.matchMedia("(min-width: 1180px)").matches, () => false)
  const first = lines.findIndex(line => line.entry_id === on_screen[0])
  const last = lines.findIndex(line => line.entry_id === on_screen[1])
  return <nav className="mvp-timeline" aria-label="Timeline"><ol>{lines.map((line, index) => <Line key={line.entry_id} line={line} inView={first >= 0 && last >= first && index >= first && index <= last} onView={onView} />)}</ol></nav>
}
