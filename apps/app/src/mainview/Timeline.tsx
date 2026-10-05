import { useCallback, useRef, useSyncExternalStore } from "react"
import type { TimelineLine, TimelineProps, TimelineZoom } from "@smthrs/rpc/TimelineCard"

import { Button } from "@smthrs/ui/button"
import { Spinner } from "@smthrs/ui"
import { Check, CircleAlert, Sparkles, X } from "lucide-react"
import { ActorChip } from "./cards/views/ActorChip"
import { StateGlyph } from "./cards/views/StateWord"

const WIDE = "(min-width: 1180px)"

const CLOCK: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" }
const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
const sameDay = (from: number, to: number): boolean => {
  const a = new Date(from), b = new Date(to)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * A zoomed line's span: the locale's range of clock readings inside one day (`11:48 – 12:05`), of dates when the run
 * crosses a day (`Oct 3 – 5`; a bare clock would lie, Timestamps.ts §28.9), and each end on its own for the
 * accessible name. Nothing without both ends.
 */
export const spanOf = ({ from, to }: Pick<TimelineZoom, "from" | "to">): { readonly text: string; readonly from: string; readonly to: string } | undefined => {
  if (from === undefined || to === undefined) return undefined
  const [start, end] = from <= to ? [from, to] : [to, from]
  const format = new Intl.DateTimeFormat([], sameDay(start, end) ? CLOCK : DAY)
  return { text: format.formatRange(start, end), from: format.format(start), to: format.format(end) }
}

/** The stacked node of a zoomed line: one bar per level above the entry, wider as the level rises; level 3 is the coarsest. */
function StackGlyph({ level }: { level: number }) {
  const bars = Math.min(level, 3) + 1
  const width = 6 + Math.min(level, 3) * 2
  const height = 2, gap = 1.5
  const top = (16 - (bars * height + (bars - 1) * gap)) / 2
  return <svg className="mvp-tl-stack" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    {Array.from({ length: bars }, (_, index) => <rect key={index} x={(16 - width) / 2} y={top + index * (height + gap)} width={width} height={height} rx="1" fill="currentColor" />)}
  </svg>
}

function Line({ line, inView, onView, onAction }: { line: TimelineLine; inView: boolean } & Pick<TimelineProps, "onView" | "onAction">) {
  const { glyph, action, zoom } = line
  const jump = () => onView({ jump_to: line.entry_id })
  const span = zoom === undefined ? undefined : spanOf(zoom)
  const name = zoom === undefined ? undefined : `${zoom.count} entries${span ? `, ${span.from} to ${span.to}` : ""}: ${line.title}`
  return <li data-entry={line.entry_id} data-kind={line.kind} data-tone={line.tone} data-in-view={inView || undefined} data-fresh={line.fresh || undefined} data-zoom={zoom?.level}>
    <button type="button" onClick={jump} aria-label={name}><span className="mvp-tl-node">
      {zoom ? <StackGlyph level={zoom.level} />
        : "state" in glyph ? <StateGlyph state={glyph.state} /> : "actor" in glyph ? <ActorChip actor={glyph.actor} size="s" />
        : glyph.event === "running" ? <Spinner size="sm" aria-label="Working" />
        : glyph.event === "ok" ? <Check size={13} className="mvp-tl-ok" aria-hidden="true" />
        : glyph.event === "attention" ? <CircleAlert size={13} className="mvp-toast-attention" aria-hidden="true" />
        : <X size={13} className="mvp-tl-failed" aria-hidden="true" />}
    </span>
      <span className="mvp-tl-text"><b>{zoom?.written ? <Sparkles size={11} className="mvp-written" aria-hidden="true" /> : null}{line.title}</b>
        {zoom ? <span className="mvp-tl-zoom">{zoom.count} entries{span ? <> · <time>{span.text}</time></> : null}</span>
          : line.summary === undefined ? null : <span>{line.summary}</span>}</span>
    </button>
    {action ? <span className="mvp-tl-actions"><Button size="sm" variant="outline" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={event => { event.stopPropagation(); onAction(action.tag, action.args ?? {}) }}>{action.label}</Button>
      {action.disabled ? <span>{action.disabled.reason}</span> : null}</span> : null}
  </li>
}

/** One line per conversation entry, or one per run of entries far from the band (zoom); the band marks what is on screen (T-UI-08). */
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
