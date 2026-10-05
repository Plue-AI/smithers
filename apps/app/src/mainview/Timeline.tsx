import { useCallback, useRef, useSyncExternalStore } from "react"
import type { TimelineLine, TimelineProps } from "@smthrs/rpc/TimelineCard"

import { Button } from "@smthrs/ui/button"
import { Spinner } from "@smthrs/ui"
import { Check, CircleAlert, X } from "lucide-react"
import { ActorChip } from "./cards/views/ActorChip"
import { StateGlyph } from "./cards/views/StateWord"

const WIDE = "(min-width: 1180px)"

function Line({ line, inView, onView, onAction }: { line: TimelineLine; inView: boolean } & Pick<TimelineProps, "onView" | "onAction">) {
  const { glyph, action } = line
  const jump = () => onView({ jump_to: line.entry_id })
  return <li data-entry={line.entry_id} data-kind={line.kind} data-tone={line.tone} data-in-view={inView || undefined} data-fresh={line.fresh || undefined}>
    <button type="button" onClick={jump}><span className="mvp-tl-node">
      {"state" in glyph ? <StateGlyph state={glyph.state} /> : "actor" in glyph ? <ActorChip actor={glyph.actor} size="s" />
        : glyph.event === "running" ? <Spinner size="sm" aria-label="Working" />
        : glyph.event === "ok" ? <Check size={13} className="mvp-tl-ok" aria-hidden="true" />
        : glyph.event === "attention" ? <CircleAlert size={13} className="mvp-toast-attention" aria-hidden="true" />
        : <X size={13} className="mvp-tl-failed" aria-hidden="true" />}
    </span>
      <span className="mvp-tl-text"><b>{line.title}</b>{line.summary === undefined ? null : <span>{line.summary}</span>}</span>
    </button>
    {action ? <span className="mvp-tl-actions"><Button size="sm" variant="outline" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={event => { event.stopPropagation(); onAction(action.tag, action.args ?? {}) }}>{action.label}</Button>
      {action.disabled ? <span>{action.disabled.reason}</span> : null}</span> : null}
  </li>
}

/** One line per conversation entry; the band marks what is on screen (T-UI-08). */
export function Timeline({ lines, on_screen, onView, onAction }: TimelineProps) {
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
    <Line key={line.entry_id} line={line} inView={first >= 0 && last >= first && index >= first && index <= last} onView={onView} onAction={onAction} />)}</ol></nav>
}
