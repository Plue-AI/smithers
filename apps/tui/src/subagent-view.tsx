/**
 * Subagent cards as the terminal draws them: a batch's header and equal-height
 * card grid in a parent transcript, the `◉ title finished` row, a worker tab's
 * breadcrumb, and the Summary overview. What each says comes from
 * `@smthrs/rpc/SubagentCard`, shared with the GUI; this file only colors it.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { type ReactNode, type RefObject, useEffect, useRef } from "react"
import stringWidth from "string-width"
import type { Model } from "./models.ts"
import * as Subagents from "./subagents.ts"
import { tabTitle } from "./surfaces.ts"
import * as Tabs from "./tabs.ts"
import { color } from "./theme.ts"
import type * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"
import { bar } from "./view.tsx"
import type { Tab } from "./workspace.ts"

/** A card's left rail, drawn in its worker's lane color. */
const rail = { ...bar, vertical: "▌" }

/** What every card in a view reads and does. */
export interface Cards {
  readonly transcript: (id: string) => Transcript.Transcript
  readonly models: ReadonlyArray<Model>
  readonly now: number
  /** A worker's lane color. */
  readonly lane: (id: string) => string
  /** The focused card's key (`Subagents.cardKey`). */
  readonly focused: string | undefined
  /** Workers whose files list is open. */
  readonly open: ReadonlySet<string>
  readonly onOpen: (id: string) => void
  readonly onFiles: (id: string) => void
  readonly onAction: (tab: Tab, action: Tabs.ActionId) => void
}

const chipText = (action: Tabs.Action): string => `[${action.keys[0]} ${action.label}]`

/** The actions that fit `room` columns whole, in order. */
const fitting = (actions: ReadonlyArray<Tabs.Action>, room: number): ReadonlyArray<Tabs.Action> => {
  const kept: Array<Tabs.Action> = []
  let used = 0
  for (const action of actions) {
    const width = stringWidth(chipText(action)) + (kept.length === 0 ? 0 : 1)
    if (used + width > room) break
    kept.push(action)
    used += width
  }
  return kept
}

function CardView(props: {
  readonly tab: Tab
  readonly card: SubagentCard.Card
  readonly width: number
  readonly height: number
  readonly cards: Cards
}) {
  const { tab, card, cards } = props
  const inner = Math.max(1, props.width - 1)
  const focused = cards.focused === Subagents.cardKey(tab.id)
  const pad = Math.max(0, props.height - card.height)
  const actions = focused ? Tabs.actions(tab) : []
  const chips = fitting(actions, inner - stringWidth(card.footer.text) - 1)
  return (
    <box
      id={Subagents.cardKey(tab.id)}
      style={{ width: props.width, height: props.height, border: ["left"], flexShrink: 0 }}
      borderColor={cards.lane(tab.id)}
      customBorderChars={rail}
      {...(focused ? { backgroundColor: color.element } : {})}
      onMouseDown={() => cards.onOpen(tab.id)}
    >
      <text wrapMode="none">
        <span fg={Tabs.toneColor(card.tone)}>{card.glyph}</span>{" "}
        <strong fg={color.text}>{SubagentCard.clip(card.title, inner - 2)}</strong>
      </text>
      {card.activity.earlier === undefined
        ? null
        : <text fg={color.faint} wrapMode="none">{card.activity.earlier}</text>}
      {card.activity.rows.map((row, index) => {
        const whole = SubagentCard.line(row, inner)
        const mark = row.mark === "" ? "" : ` ${row.mark}`
        const words = whole.slice(2, whole.length - mark.length)
        const dim = row.state === "pending" || row.state === "text"
        return (
          <text key={index} wrapMode="none">
            <span fg={color.muted}>{whole.slice(0, 2)}</span>
            <span fg={dim ? color.faint : color.text}>{words}</span>
            <span fg={row.mark === "✗" ? color.danger : color.text}>{mark}</span>
          </text>
        )
      })}
      {pad === 0 ? null : <box style={{ height: pad, flexShrink: 0 }} />}
      {card.files === undefined ? null : (
        <text
          fg={color.faint}
          wrapMode="none"
          onMouseDown={(event) => {
            event.stopPropagation()
            cards.onFiles(tab.id)
          }}
        >
          {SubagentCard.clip(card.files.line, inner)}
        </text>
      )}
      {card.files?.rows.map((row, index) => (
        <text key={index} fg={color.faint} wrapMode="none">
          {SubagentCard.clip(`${row.branch} ${row.text}`, inner)}
        </text>
      ))}
      <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1 }}>
        <text fg={color.faint} wrapMode="none" style={{ flexShrink: 1 }}>{card.footer.text}</text>
        {chips.length > 0
          ? (
            <box style={{ flexDirection: "row", flexShrink: 0 }}>
              {chips.map((action, index) => (
                <text
                  key={action.id}
                  wrapMode="none"
                  fg={action.id === "stop" ? color.danger : color.info}
                  style={{ marginLeft: index === 0 ? 0 : 1 }}
                  onMouseDown={(event) => {
                    event.stopPropagation()
                    cards.onAction(tab, action.id)
                  }}
                >
                  {chipText(action)}
                </text>
              ))}
            </box>
          )
          : card.footer.aside === ""
          ? null
          : <text fg={color.faint} wrapMode="none" style={{ flexShrink: 0 }}>{card.footer.aside}</text>}
      </box>
    </box>
  )
}

/** Cards across `width`, each row as tall as its tallest card; a short last row stretches. */
export function Grid(props: { readonly tabs: ReadonlyArray<Tab>; readonly width: number; readonly cards: Cards }) {
  const { cards } = props
  const layout = SubagentCard.grid(props.width, props.tabs.length)
  const shown = props.tabs.map((tab) =>
    SubagentCard.card(Subagents.subagent(tab, cards.transcript(tab.id), cards.models), cards.now, {
      open: cards.open.has(tab.id)
    })
  )
  const heights = SubagentCard.rowHeights(layout, shown.map((card) => card.height))
  return (
    <box>
      {layout.map((row, index) => (
        <box
          key={index}
          style={{ flexDirection: "row", marginBottom: index === layout.length - 1 ? 0 : 1, flexShrink: 0 }}
        >
          {row.map((cell, at) => (
            <box key={props.tabs[cell.index]!.id} style={{ marginLeft: at === 0 ? 0 : SubagentCard.gridBounds.gap }}>
              <CardView
                tab={props.tabs[cell.index]!}
                card={shown[cell.index]!}
                width={cell.width}
                height={heights[index]!}
                cards={cards}
              />
            </box>
          ))}
        </box>
      ))}
    </box>
  )
}

/** A batch in its parent's transcript: `◐ Running 3 subagents (1/3)`, the ▰ bar, then its cards. */
export function Batch(
  props: { readonly batch: Subagents.Batch; readonly width: number; readonly cards: Cards }
) {
  const header = SubagentCard.header(props.batch.tabs.map((tab) => tab.status), props.cards.now)
  const tone = Tabs.toneColor(header.tone)
  return (
    <box id={props.batch.key} style={{ marginBottom: 1 }}>
      <text wrapMode="none">
        {header.glyph === "" ? null : <span fg={tone}>{header.glyph}{" "}</span>}
        <strong fg={header.glyph === "" ? tone : color.text}>
          {SubagentCard.headerLine({ ...header, glyph: "" })}
        </strong>{"  "}
        {header.bar.map((cell, index) => (
          <span key={index} fg={cell === "done" ? color.success : color.faint}>{SubagentCard.barGlyph}</span>
        ))}
      </text>
      <Grid tabs={props.batch.tabs} width={props.width} cards={props.cards} />
    </box>
  )
}

/** `◉ title finished`, where a worker settled. */
export function Finished(props: { readonly tab: Tab; readonly tone: string }) {
  const row = SubagentCard.finished(tabTitle(props.tab), props.tab.status)
  return (
    <text wrapMode="none" style={{ marginBottom: 1 }}>
      <span fg={Tabs.toneColor(row.tone)}>{row.glyph}</span> <span fg={props.tone}>{row.title}</span>
      <span fg={color.text}>{row.line.slice(row.glyph.length + 1 + row.title.length)}</span>
    </text>
  )
}

/** A parent transcript's own rows with its workers' grids and finished rows between them. */
export function Lines(props: {
  readonly lines: ReadonlyArray<Subagents.Line>
  readonly width: number
  readonly cards: Cards
  readonly row: (line: Extract<Subagents.Line, { kind: "row" }>) => ReactNode
}) {
  return (
    <>
      {props.lines.map((line) =>
        line.kind === "row"
          ? props.row(line)
          : line.kind === "grid"
          ? <Batch key={line.key} batch={line.batch} width={props.width} cards={props.cards} />
          : <Finished key={line.key} tab={line.tab} tone={props.cards.lane(line.tab.id)} />
      )}
    </>
  )
}

/** A worker tab's way back: `▌ Subagent · title` in its lane color, and `Back (ctrl+y)`. */
export function Crumb(props: {
  readonly title: string
  readonly tone: string
  /** Titles from the chat down to this worker's parent. */
  readonly path: ReadonlyArray<string>
  readonly onBack: () => void
}) {
  return (
    <box style={{ flexShrink: 0, marginBottom: 1 }} onMouseDown={props.onBack}>
      <box style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <text wrapMode="none" style={{ flexShrink: 1 }} bg={color.element}>
          {" "}
          <span fg={props.tone}>▌</span>
          <span fg={color.text}>{" Subagent · "}{props.title}{" "}</span>
        </text>
        <text wrapMode="none" fg={color.info} style={{ flexShrink: 0, marginLeft: 1 }}>Back (ctrl+y)</text>
      </box>
      <text wrapMode="none" fg={color.faint}>{[...props.path, props.title].join(" › ")}</text>
    </box>
  )
}

/** The overview's columns: its tree pane, its cards pane, and the grid inside the cards pane's border. */
export const overviewWidths = (
  width: number
): { readonly tree: number; readonly cards: number; readonly grid: number } => {
  const tree = Math.min(28, Math.max(20, Math.floor(width * 0.3)))
  const cards = Math.max(10, width - tree)
  return { tree, cards, grid: cards - 2 }
}

/** The overview's tree row id for the chat itself. */
export const chat = "chat"

/**
 * The Summary overview: the worker tree beside the selected branch's cards.
 * The chat heads the tree; choosing it shows the conversation review.
 */
export function Overview(props: {
  readonly nodes: ReadonlyArray<Tree.Node>
  /** `chat`, or the selected worker's id. */
  readonly selected: string
  readonly pane: "tree" | "cards"
  readonly width: number
  readonly cards: Cards
  readonly onSelect: (id: string) => void
  /** The conversation review, shown while the chat is selected. */
  readonly review: ReactNode
  readonly scrollRef?: RefObject<((direction: number) => void) | undefined>
}) {
  const { tree: treeWidth, cards: rightWidth, grid: gridWidth } = overviewWidths(props.width)
  const inner = treeWidth - 2
  const tree = useRef<ScrollBoxRenderable>(null)
  const grid = useRef<ScrollBoxRenderable>(null)
  if (props.scrollRef !== undefined && props.selected !== chat) {
    props.scrollRef.current = (direction) => grid.current?.scrollBy(direction * 0.5, "viewport")
  }
  useEffect(() => tree.current?.scrollChildIntoView(`overview:${props.selected}`), [props.selected])
  useEffect(() => {
    if (props.cards.focused !== undefined) grid.current?.scrollChildIntoView(props.cards.focused)
  }, [props.cards.focused])
  const selected = props.nodes.find((node) => node.tab.id === props.selected)?.tab
  const branch = selected === undefined ? [] : Tree.branch(props.nodes.map((node) => node.tab), selected.id)
  const frame = (pane: "tree" | "cards") => props.pane === pane ? color.brand : color.border
  const row = (id: string, level: number, label: string, glyph?: { glyph: string; tone: string }, clock = "") => {
    const lead = `${"  ".repeat(level)}${glyph === undefined ? "" : `${glyph.glyph} `}`
    const room = Math.max(1, inner - 1 - stringWidth(lead) - (clock === "" ? 0 : stringWidth(clock) + 1))
    const title = SubagentCard.clip(label, room)
    const gap = Math.max(1, inner - 1 - stringWidth(lead) - stringWidth(title) - stringWidth(clock))
    const chosen = props.selected === id
    return (
      <box
        key={id}
        id={`overview:${id}`}
        style={{ height: 1, flexShrink: 0 }}
        {...(chosen ? { backgroundColor: props.pane === "tree" ? color.element : color.surface } : {})}
        onMouseDown={() => props.onSelect(id)}
      >
        <text wrapMode="none">
          {" "}
          {"  ".repeat(level)}
          {glyph === undefined ? null : <span fg={glyph.tone}>{glyph.glyph}{" "}</span>}
          <span fg={chosen ? color.text : color.muted}>{title}</span>
          <span fg={color.faint}>{" ".repeat(gap)}{clock}</span>
        </text>
      </box>
    )
  }
  return (
    <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
      <box
        title="tree"
        style={{ width: treeWidth, border: true, flexShrink: 0 }}
        borderColor={frame("tree")}
        titleColor={color.faint}
      >
        <scrollbox ref={tree} scrollX={false} style={{ flexGrow: 1, scrollbarOptions: { visible: false } }}>
          {row(chat, 0, "Chat")}
          {props.nodes.map((node) =>
            row(
              node.tab.id,
              node.level,
              tabTitle(node.tab),
              Tabs.style(node.tab.status, props.cards.now),
              SubagentCard.duration(Tabs.elapsed(node.tab, props.cards.now))
            )
          )}
        </scrollbox>
      </box>
      <box
        title={selected === undefined ? "Summary" : tabTitle(selected)}
        style={{ width: rightWidth, border: true, flexShrink: 0 }}
        borderColor={frame("cards")}
        titleColor={color.faint}
      >
        {selected === undefined ?
          props.review :
          (
            <scrollbox ref={grid} scrollX={false} style={{ flexGrow: 1, scrollbarOptions: { visible: false } }}>
              <Grid tabs={branch} width={gridWidth} cards={props.cards} />
            </scrollbox>
          )}
      </box>
    </box>
  )
}
