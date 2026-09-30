import * as SubagentCard from "@smthrs/rpc/SubagentCard"
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
  return (
    <box id={props.id} style={{ marginBottom: 1, flexShrink: 0 }}>
      <box {...(props.focused ? { backgroundColor: color.selected } : {})}>
        <text wrapMode="none" onMouseDown={props.onOpen}>
          <span fg={card.tone}>{card.glyph}{" "}</span>
          <strong fg={color.text}>{SubagentCard.clip(card.title, Math.max(1, room - aside.length - 3))}</strong>
          <span fg={color.faint}>{` · ${aside}`}{card.undone ? " · undone" : ""}</span>
          {card.failure === undefined ? null : <span fg={color.text}>{` · ${card.failure}`}</span>}
          {card.result === undefined
            ? null
            : <span fg={color.text}>{` → ${SubagentCard.clip(card.result, room)}`}</span>}
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
