/**
 * The run scrubber docked above the composer, drawn the way the app's dock is
 * (`apps/app` `ChatRunTimeline`): a pause button, phase segments to scale,
 * milestone ticks with their labels, a playhead knob, and the phase and clock
 * at the playhead. Clicks and drags jump; `Scrubber` does the geometry.
 */
import type { MouseEvent } from "@opentui/core"
import type { Milestone, PhaseId } from "@smthrs/gateway/RunTrace"
import { useRef, useState } from "react"
import * as Activity from "./activity.ts"
import * as Scrubber from "./scrubber.ts"
import { color, mix } from "./theme.ts"

const tones: Record<PhaseId, keyof typeof color> = {
  researching: "info",
  implementing: "brand",
  testing: "success",
  stuck: "warning",
  blocked: "danger",
  unrecorded: "element"
}
const tickTone = (tone: Milestone["tone"]): string =>
  tone === "bad"
    ? color.danger
    : tone === "good"
    ? color.success
    : tone === "warn"
    ? color.warning
    : tone === "muted"
    ? color.faint
    : color.brand

const fill = (phase: PhaseId, reached: boolean): string =>
  phase === "unrecorded"
    ? reached ? color.element : mix(color.element, 45, color.page)
    : mix(color[tones[phase]], reached ? 26 : 9, color.page)

const clip = (text: string, width: number): string =>
  width <= 0 ? "" : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

export function ActivityView({ activity, width, now, cursor, focused, title, onSelect, onPause }: {
  readonly activity: Activity.Activity
  readonly width: number
  readonly now: number
  readonly cursor?: number | undefined
  readonly focused: boolean
  readonly title: string
  /** Jump the playhead, and the chat with it, to a journal position. */
  readonly onSelect: (seq: number) => void
  /** Stop following the live end, or resume it. */
  readonly onPause: () => void
}) {
  const [hover, setHover] = useState<number | undefined>(undefined)
  const [hoverTick, setHoverTick] = useState<number | undefined>(undefined)
  const track = useRef<{ x: number } | null>(null)
  const model = Activity.model(activity)
  if (model.bands.length === 0 && model.milestones.length === 0) return null
  const layout = Scrubber.layout(activity, width, cursor, now)
  const { lead, rows, tail } = layout
  const mark = rows, bar = rows + 1
  const columnOf = (event: MouseEvent) => Math.max(0, Math.min(layout.track - 1, event.x - (track.current?.x ?? 0)))
  const jump = (event: MouseEvent) => {
    event.stopPropagation()
    onSelect(Scrubber.seqAt(layout, columnOf(event)))
  }
  const paused = cursor !== undefined
  const button = lead >= 10 ? (paused ? "▶ Live" : "⏸ Pause") : lead > 0 ? (paused ? "▶" : "⏸") : ""
  const legend = lead >= 10 ? (focused ? "←→ [ ]" : "ctrl+t") : ""
  return (
    <box style={{ height: rows + 2, width, flexShrink: 0, marginTop: 1 }}>
      {layout.ticks.map((tick) =>
        tick.label === "" ?
          null :
          (
            <text
              key={`label:${tick.seq}`}
              wrapMode="none"
              fg={hoverTick === tick.seq || tick.seq === cursor
                ? color.text
                : tick.reached
                ? tickTone(tick.tone)
                : color.faint}
              style={{
                position: "absolute",
                left: lead + tick.left,
                top: tick.row,
                width: tick.label.length,
                height: 1
              }}
              onMouseOver={() => setHoverTick(tick.seq)}
              onMouseOut={() => setHoverTick(undefined)}
              onMouseDown={(event: MouseEvent) => {
                event.stopPropagation()
                onSelect(tick.seq)
              }}
            >
              {tick.label}
            </text>
          )
      )}
      {legend === "" ?
        null :
        (
          <text fg={color.faint} wrapMode="none" style={{ position: "absolute", left: 1, top: mark, height: 1 }}>
            {legend}
          </text>
        )}
      {button === "" ?
        null :
        (
          <text
            fg={paused ? color.brand : color.muted}
            bg={color.element}
            wrapMode="none"
            style={{ position: "absolute", left: 0, top: bar, width: Math.min(lead - 1, button.length + 2), height: 1 }}
            onMouseDown={(event: MouseEvent) => {
              event.stopPropagation()
              onPause()
            }}
          >
            {` ${button} `}
          </text>
        )}
      <box
        ref={track as never}
        style={{ position: "absolute", left: lead, top: mark, width: layout.track, height: 2 }}
        onMouseDown={jump}
        onMouseDrag={jump}
        onMouseMove={(event: MouseEvent) => setHover(columnOf(event))}
        onMouseOut={() => setHover(undefined)}
      >
        {layout.segments.map((segment) => (
          <box
            key={`${segment.seq}`}
            backgroundColor={fill(segment.phase, segment.reached)}
            style={{ position: "absolute", left: segment.left, top: 1, width: segment.width, height: 1 }}
          >
            <text wrapMode="none" fg={segment.reached ? color.text : color.muted}>
              {segment.label === ""
                ? ""
                : segment.current
                ? <strong>{` ${segment.label}`}</strong>
                : ` ${segment.label}`}
            </text>
          </box>
        ))}
        {layout.ticks.map((tick) =>
          tick.column === layout.knob ?
            null :
            (
              <text
                key={`tick:${tick.seq}`}
                wrapMode="none"
                fg={tick.reached ? tickTone(tick.tone) : color.faint}
                style={{ position: "absolute", left: tick.column, top: 0, width: 1, height: 1 }}
                onMouseDown={(event: MouseEvent) => {
                  event.stopPropagation()
                  onSelect(tick.seq)
                }}
              >
                ╷
              </text>
            )
        )}
        {hover === undefined || hover === layout.knob ?
          null :
          (
            <text
              fg={color.muted}
              wrapMode="none"
              style={{ position: "absolute", left: hover, top: 0, width: 1, height: 1 }}
            >
              ▾
            </text>
          )}
        <text
          fg={color.brand}
          wrapMode="none"
          style={{ position: "absolute", left: layout.knob, top: 0, width: 1, height: 1 }}
        >
          ●
        </text>
        <text
          fg={color.brand}
          wrapMode="none"
          bg={fill(
            layout.segments.find((segment) => segment.left <= layout.knob && layout.knob < segment.left + segment.width)
              ?.phase ?? "unrecorded",
            true
          )}
          style={{ position: "absolute", left: layout.knob, top: 1, width: 1, height: 1 }}
        >
          ┃
        </text>
      </box>
      {tail === 0 ? null : (
        <>
          {rows === 0 ?
            null :
            (
              <text
                fg={color.faint}
                wrapMode="none"
                style={{ position: "absolute", left: width - tail + 2, top: mark - 1, height: 1 }}
              >
                {clip(title, tail - 2)}
              </text>
            )}
          <text
            fg={color.text}
            wrapMode="none"
            style={{ position: "absolute", left: width - tail + 2, top: mark, height: 1 }}
          >
            <strong>{clip(layout.phase, tail - 2)}</strong>
          </text>
          <text
            fg={color.muted}
            wrapMode="none"
            style={{ position: "absolute", left: width - tail + 2, top: bar, height: 1 }}
          >
            {layout.elapsed}
          </text>
        </>
      )}
    </box>
  )
}
