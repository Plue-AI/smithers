/** One row over the current view while Ctrl+T inspection is open. */
import type * as Activity from "./activity.ts"
import * as Scrubber from "./scrubber.ts"
import { color } from "./theme.ts"

export function ActivityView({ activity, width, cursor, focused, onSelect, onPause }: {
  readonly activity: Activity.Activity
  readonly width: number
  readonly now: number
  readonly cursor?: number | undefined
  readonly focused: boolean
  readonly title: string
  readonly onSelect: (seq: number) => void
  readonly onPause: () => void
}) {
  if (!focused || activity.records.length === 0) return null
  const event = Scrubber.event(activity, cursor)
  const move = (name: string) => {
    const seq = Scrubber.key(activity, cursor, name)
    if (seq !== undefined) onSelect(seq)
  }
  return (
    <box backgroundColor={color.element} style={{ flexDirection: "row", height: 1, width, flexShrink: 0 }}>
      <text fg={color.brand} wrapMode="none" style={{ flexShrink: 0 }} onMouseDown={() => move("left")}>◂</text>
      <text fg={color[event.tone]} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }}>{event.label}</text>
      <text fg={color.muted} wrapMode="none" style={{ flexShrink: 0 }}>{`  ${event.index}/${event.total} `}</text>
      <text fg={color.brand} wrapMode="none" style={{ flexShrink: 0 }} onMouseDown={() => move("right")}>▸</text>
      <text fg={color.muted} wrapMode="none" style={{ flexShrink: 0 }} onMouseDown={onPause}>esc Back</text>
    </box>
  )
}
