import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import stringWidth from "string-width"
import type * as RunCard from "./run-card.ts"
import { summary } from "./run-card.ts"
import { color } from "./theme.ts"
import { bar } from "./view.tsx"

/** One host card, updated in place from its run's actual state and receipts. */
export function RunCardView(props: {
  readonly id: string
  readonly card: RunCard.Card
  readonly width: number
  readonly focused: boolean
  readonly lane: string
  readonly onOpen: () => void
  readonly onDiff?: () => void
  readonly onUndo?: () => void
}) {
  const { card } = props
  const room = Math.max(1, props.width - 3)
  const aside = card.outcome === "requested" || card.outcome === "queued" ?
    card.outcome
    : card.outcome === "done" || card.outcome === "working" || card.failure !== undefined
    ? card.duration
    : `${card.outcome} · ${card.duration}`
  const metadata = ` · ${aside}${card.undone ? " · undone" : ""}`
  const outcome = card.failure !== undefined ?
    ` · failed: ${card.failure}` :
    card.result !== undefined
    ? ` → ${card.result}`
    : ""
  // Reserve the outcome first, with room for a recognizable title and the clock.
  const tail = SubagentCard.clip(
    outcome,
    Math.max(1, room - stringWidth(metadata) - Math.min(16, stringWidth(card.title)))
  )
  const title = SubagentCard.clip(card.title, Math.max(1, room - stringWidth(metadata) - stringWidth(tail)))
  return (
    <box id={props.id} style={{ marginBottom: 1, flexShrink: 0 }}>
      <box {...(props.focused ? { backgroundColor: color.selected } : {})}>
        <text wrapMode="none" onMouseDown={props.onOpen}>
          <span fg={card.tone}>{card.glyph}{" "}</span>
          <strong fg={color.text}>{title}</strong>
          <span fg={color.faint}>{metadata}</span>
          {tail === "" ? null : <span fg={color.text}>{tail}</span>}
        </text>
      </box>
      {card.steps.length === 0 && card.answer === undefined && card.receipts.length === 0 &&
          (card.result !== undefined || !card.settled)
        ? null :
        (
          <box
            style={{ border: ["left"], paddingLeft: 1 }}
            customBorderChars={{ ...bar, vertical: "▌" }}
            borderColor={props.lane}
            {...(props.focused ? { backgroundColor: color.selected } : {})}
          >
            {card.steps.map((line, index) => (
              <text key={index} fg={color.text} wrapMode="none">{SubagentCard.clip(line, room)}</text>
            ))}
            {summary(card.answer ?? "", room).map((line, index) => (
              <text key={`answer:${index}`} fg={color.text} wrapMode="none">{line}</text>
            ))}
            {card.receipts.length === 0
              ? null
              : <text fg={color.muted} wrapMode="word">{card.receipts.join(" · ")}</text>}
            {!card.settled ? null : (
              <box style={{ flexDirection: "row", height: 1 }}>
                {card.diff ? <text fg={color.muted} onMouseDown={props.onDiff}>{"d Diff  "}</text> : null}
                {card.undo ? <text fg={color.muted} onMouseDown={props.onUndo}>{"u Undo  "}</text> : null}
                <text
                  fg={color.muted}
                  onMouseDown={props.onOpen}
                  {...(props.focused ? { backgroundColor: color.selected } : {})}
                >
                  enter Open
                </text>
              </box>
            )}
          </box>
        )}
    </box>
  )
}
