/**
 * Subagent cards as the terminal draws them: a batch's header and equal-height
 * card grid in a parent transcript, the `◉ title done` row, a worker tab's
 * breadcrumb, and the Summary overview. What each says comes from
 * `@smthrs/rpc/SubagentCard`, shared with the GUI; this file only colors it.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from "react"
import stringWidth from "string-width"
import type * as Asks from "./asks.ts"
import * as Graph from "./graph.ts"
import * as Inbox from "./inbox.ts"
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
      {...(focused ? { backgroundColor: color.selected } : {})}
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
        const dim = row.state === "pending" || row.state === "stopped" || row.state === "text"
        return (
          <text key={index} wrapMode="none">
            <span fg={color.muted}>{whole.slice(0, 2)}</span>
            <span fg={dim ? color.faint : color.text}>{words}</span>
            <span fg={row.mark === "✗" ? color.danger : row.mark === "■" ? color.faint : color.text}>{mark}</span>
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

/**
 * A batch in its parent's transcript: `◐ Running 3 subagents (1/3)`, the ▰ bar, then its cards.
 * One settled worker is headed by its outcome: `■ Add JSDoc · stopped at 6s`.
 */
export function Batch(
  props: { readonly batch: Subagents.Batch; readonly width: number; readonly cards: Cards }
) {
  const only = props.batch.tabs.length === 1 ? props.batch.tabs[0]! : undefined
  const header = SubagentCard.header(
    props.batch.tabs.map((tab) => tab.status),
    props.cards.now,
    only === undefined ? undefined : { title: tabTitle(only), startedAt: only.startedAt, endedAt: only.endedAt }
  )
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

/**
 * Where a worker settled: `◉ title done`, `◉ title failed: <cause>`,
 * `◉ title stopped`. Its keys are on its focused card: in Chat a bare key
 * reaches the composer, and in a worker's view it acts on that worker.
 */
export function Finished(props: { readonly tab: Tab; readonly tone: string }) {
  const row = SubagentCard.finished(tabTitle(props.tab), props.tab.status, Tabs.outcome(props.tab))
  return (
    <text wrapMode="none" style={{ marginBottom: 1 }}>
      <span fg={Tabs.toneColor(row.tone)}>{row.glyph}</span> <span fg={props.tone}>{row.title}</span>
      <span fg={color.text}>{row.line.slice(row.glyph.length + 1 + row.title.length)}</span>
    </text>
  )
}

/** A parent transcript's own rows with its workers' grids and outcome rows between them. */
export function Lines(props: {
  readonly lines: ReadonlyArray<Subagents.Line>
  readonly width: number
  readonly cards: Cards
  readonly row: (line: Extract<Subagents.Line, { kind: "row" }>) => ReactNode
  readonly onEarlier: () => void
}) {
  return (
    <>
      {props.lines.map((line) =>
        line.kind === "row"
          ? props.row(line)
          : line.kind === "grid"
          ? <Batch key={line.key} batch={line.batch} width={props.width} cards={props.cards} />
          : line.kind === "earlier"
          ? (
            <box
              key={line.key}
              id={line.key}
              style={{ height: 1, flexShrink: 0 }}
              onMouseDown={(event) => {
                // Disclosure keeps the native composer focused.
                event.preventDefault()
                props.onEarlier()
              }}
              {...(props.cards.focused === line.key ? { backgroundColor: color.selected } : {})}
            >
              <text fg={color.muted} wrapMode="none">
                {SubagentCard.clip(SubagentCard.earlierLine(line.batches), props.width)}
              </text>
            </box>
          )
          : <Finished key={line.key} tab={line.tab} tone={props.cards.lane(line.tab.id)} />
      )}
    </>
  )
}

/** A worker tab's way back: `▌ Subagent · title` in its lane color, and `Back (ctrl+y)`. */
export function Crumb(props: {
  readonly title: string
  readonly tone: string
  /** The person drives this worker: `⇄ you drive`, and ctrl+y releases it. */
  readonly driving?: boolean
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
          {props.driving === true ? <span fg={color.needs}>{"⇄ you drive "}</span> : null}
        </text>
        <text
          wrapMode="none"
          fg={props.driving === true ? color.needs : color.info}
          style={{ flexShrink: 0, marginLeft: 1 }}
        >
          {props.driving === true ? "Release (ctrl+y)" : "Back (ctrl+y)"}
        </text>
      </box>
      <text wrapMode="none" fg={color.faint}>{[...props.path, props.title].join(" › ")}</text>
    </box>
  )
}

/** The overview's columns: its inbox pane, its cards pane, and the grid inside the cards pane's border. */
export const overviewWidths = (
  width: number
): { readonly tree: number; readonly cards: number; readonly grid: number } => {
  const tree = Math.min(72, Math.max(30, Math.floor(width * 0.6)))
  const cards = Math.max(10, width - tree)
  return { tree, cards, grid: cards - 2 }
}

/** The overview's tree row id for the chat itself. */
export const chat = "chat"

const groupGlyph: Record<Inbox.Group, string> = { needs: "◆", working: "◐", done: "●" }
const groupColor = (group: Inbox.Group): string =>
  group === "needs" ? color.needs : group === "working" ? color.info : color.success

/** A row's glyph: a needs-you node is `◆` in the needs color, the rest the shared status glyph. */
export const rowGlyph = (row: Inbox.Row, now: number): { readonly glyph: string; readonly tone: string } =>
  row.status === "input" || row.ask !== undefined
    ? { glyph: "◆", tone: color.needs }
    : row.worker === undefined
    ? Tabs.style(row.status, now)
    : Tabs.styleOf(row.worker, now)

/** A flow run's node call as a graph node's glyph. */
const callGlyph = { done: "●", failed: "●", running: "◐" } as const

/**
 * The run forest around `row` as a graph: its root worker and every agent under it, or a flow run
 * and its node calls. Rows supply each box's name, seat and clock.
 */
export const forest = (
  row: Inbox.Row,
  rows: ReadonlyArray<Inbox.Row>,
  tabs: ReadonlyArray<Tab>,
  nodes: (
    runId: string
  ) => ReadonlyArray<{ readonly id: string; readonly label: string; readonly status: keyof typeof callGlyph }>,
  now: number
): Graph.Node => {
  const box = (each: Inbox.Row, children: ReadonlyArray<Graph.Node>): Graph.Node => {
    const glyph = rowGlyph(each, now)
    return {
      key: each.key,
      glyph: glyph.glyph,
      tone: glyph.tone,
      name: each.name,
      sub: [each.seat, each.clock, Inbox.meter(each)].filter((part) => part !== "").join(" · "),
      children
    }
  }
  if (row.run !== undefined) {
    return box(
      row,
      nodes(row.run.id).map((call) => ({
        key: `${row.key}:${call.id}`,
        glyph: callGlyph[call.status],
        tone: call.status === "done" ? color.success : call.status === "failed" ? color.danger : color.info,
        name: call.label,
        sub: "",
        children: []
      }))
    )
  }
  const byKey = new Map(rows.map((each) => [each.key, each]))
  // Restored tabs are data: a parent cycle ends the walk instead of hanging it.
  let root = row.worker!
  const climbed = new Set([root.id])
  for (let parent = root.parent; parent !== undefined && !climbed.has(parent);) {
    const above = tabs.find((tab) => tab.id === parent)
    if (above === undefined) break
    climbed.add(above.id)
    root = above
    parent = above.parent
  }
  const grown = new Set<string>()
  const grow = (tab: Tab): Graph.Node | undefined => {
    const shown = byKey.get(tab.id)
    if (shown === undefined || grown.has(tab.id)) return undefined
    grown.add(tab.id)
    return box(
      shown,
      tabs.filter((child) => child.parent === tab.id).flatMap((child) => grow(child) ?? [])
    )
  }
  return grow(root) ?? box(row, [])
}

/** The graph pane: the forest drawn, the selected box scrolled into view; PageUp/PageDown scroll it. */
export function GraphView(props: {
  readonly root: Graph.Node
  readonly selected: string
  readonly scrollRef?: RefObject<((direction: number) => void) | undefined>
}) {
  const box = useRef<ScrollBoxRenderable>(null)
  // The scroll for a selection waits for layout; a person's own scroll before it lands supersedes it.
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The clock redraws the app ten times a second; the forest is drawn again only when it changes.
  const shape = JSON.stringify(props.root)
  const drawn = useMemo(
    () =>
      Graph.draw(props.root, props.selected, {
        line: color.faint,
        accent: color.brand,
        text: color.text,
        faint: color.faint
      }),
    [shape, props.selected]
  )
  if (props.scrollRef !== undefined) {
    props.scrollRef.current = (direction) => {
      clearTimeout(pending.current)
      box.current?.scrollBy(direction * 0.5, "viewport")
    }
  }
  // Only a new selection, or its box moving, scrolls the view; a redraw leaves PageUp/PageDown where they were.
  const at = drawn.boxes.get(props.selected)
  // After layout: before it the view has no size and clamps the scroll to 0. A new forest's size counts too.
  useEffect(() => {
    if (at === undefined) return
    pending.current = setTimeout(
      () => box.current?.scrollTo({ x: Math.max(0, at.x - 2), y: Math.max(0, at.y - 1) }),
      0
    )
    return () => clearTimeout(pending.current)
  }, [props.selected, at?.x, at?.y, drawn.rows.length])
  return (
    <scrollbox ref={box} scrollX scrollY style={{ flexGrow: 1, scrollbarOptions: { visible: false } }}>
      {drawn.rows.map((spans, index) => (
        <text key={index} wrapMode="none">
          {spans.map((span, at) => <span key={at} fg={span.fg}>{span.text}</span>)}
        </text>
      ))}
    </scrollbox>
  )
}

/** Fixed columns right of the name: seat, clock, window and cache; each value leaves a space before the next. */
const columns = { seat: 9, clock: 8, meter: 10 } as const

/**
 * A tree row right of its `lead` cells in a pane `inner` cells wide: the name
 * clipped to fit, the gap, and the fixed seat, clock and meter columns. A
 * narrow pane keeps the names readable: the meter column goes first.
 */
export const treeRow = (
  row: Inbox.Row,
  lead: number,
  inner: number
): { readonly title: string; readonly gap: number; readonly aside: string } => {
  const meter = inner - columns.seat - columns.clock - columns.meter >= 24 ? columns.meter : 0
  const pad = (text: string, width: number) => SubagentCard.clip(text, width - 1).padEnd(width)
  const aside = `${pad(row.seat, columns.seat)}${pad(row.clock, columns.clock)}${
    meter === 0 ? "" : SubagentCard.clip(Inbox.meter(row), meter)
  }`
  const right = columns.seat + columns.clock + meter
  // One space always separates the clipped name from the seat column.
  const title = SubagentCard.clip(row.name, Math.max(1, inner - 2 - lead - right))
  return { title, gap: Math.max(1, inner - 1 - lead - stringWidth(title) - right), aside }
}

/** The pending question or the last step of the selected row, `space` in the overview. */
export function Peek(props: { readonly row: Inbox.Row; readonly lines: ReadonlyArray<string>; readonly now: number }) {
  const { row } = props
  const glyph = rowGlyph(row, props.now)
  return (
    <box style={{ flexDirection: "column", paddingLeft: 1 }}>
      <text wrapMode="none">
        <span fg={glyph.tone}>{glyph.glyph}</span> <strong fg={color.text}>{row.name}</strong>
        <span fg={color.faint}>{`  ${[row.seat, row.clock].filter((part) => part !== "").join(" · ")}`}</span>
      </text>
      {props.lines.map((line, index) => <text key={index} fg={color.text}>{line}</text>)}
      {row.window === undefined ? null : <text fg={color.faint}>{`window  ${row.window}%`}</text>}
      {row.cache === undefined ? null : <text fg={color.faint}>{`cache   ${row.cache}%`}</text>}
    </box>
  )
}

/**
 * The Summary overview: Needs you, Working and Done beside the selected
 * worker's cards. The chat heads the list; choosing it shows the conversation
 * review. `peek` shows the selected row's question or last step instead of cards.
 */
export function Overview(props: {
  readonly sections: ReadonlyArray<Inbox.Section>
  /** `chat`, or the selected row's key. */
  readonly selected: string
  readonly pane: "tree" | "cards"
  readonly width: number
  readonly cards: Cards
  readonly tabs: ReadonlyArray<Tab>
  readonly onSelect: (key: string) => void
  /** The conversation review, shown while the chat is selected. */
  readonly review: ReactNode
  /** The selected row's question or last step while peeking. */
  readonly peek?: ReadonlyArray<string>
  /** `g`: the selected row's run forest, drawn instead of the list and cards. */
  readonly graph?: Graph.Node
  /** Open asks: a POC lane lists its own. */
  readonly asks?: ReadonlyArray<Asks.Ask>
  readonly scrollRef?: RefObject<((direction: number) => void) | undefined>
}) {
  const { tree: treeWidth, cards: rightWidth, grid: gridWidth } = overviewWidths(props.width)
  const inner = treeWidth - 2
  const tree = useRef<ScrollBoxRenderable>(null)
  const grid = useRef<ScrollBoxRenderable>(null)
  if (props.scrollRef !== undefined && props.selected !== chat) {
    props.scrollRef.current = (direction) => grid.current?.scrollBy(direction * 0.5, "viewport")
  }
  // Also when the list comes back from the graph: it mounts at the top.
  const listed = props.graph === undefined
  useEffect(() => tree.current?.scrollChildIntoView(`overview:${props.selected}`), [props.selected, listed])
  useEffect(() => {
    if (props.cards.focused !== undefined) grid.current?.scrollChildIntoView(props.cards.focused)
  }, [props.cards.focused])
  const row = Inbox.flat(props.sections).find((each) => each.key === props.selected)
  const selected = row?.worker
  const branch = selected === undefined ? [] : Tree.branch(props.tabs, selected.id)
  const split = selected === undefined ? undefined : Subagents.lanes(props.tabs, selected.id)
  const frame = (pane: "tree" | "cards") => props.pane === pane ? color.brand : color.border
  const line = (id: string, content: ReactNode) => {
    const chosen = props.selected === id
    return (
      <box
        key={id}
        id={`overview:${id}`}
        style={{ height: 1, flexShrink: 0 }}
        {...(chosen ? { backgroundColor: props.pane === "tree" ? color.selected : color.surface } : {})}
        onMouseDown={() => props.onSelect(id)}
      >
        {content}
      </box>
    )
  }
  const nodeRow = (each: Inbox.Row) => {
    const glyph = rowGlyph(each, props.cards.now)
    const lead = `  ${"  ".repeat(each.level)}${glyph.glyph} `
    const { title, gap, aside } = treeRow(each, stringWidth(lead), inner)
    const chosen = props.selected === each.key
    return line(
      each.key,
      <text wrapMode="none">
        {" "}
        {"  ".repeat(each.level + 1)}
        <span fg={glyph.tone}>{glyph.glyph}{" "}</span>
        <span fg={chosen ? color.text : color.muted}>{title}</span>
        <span fg={color.faint}>{" ".repeat(gap)}{aside}</span>
      </text>
    )
  }
  if (props.graph !== undefined) {
    return (
      <box
        title="graph"
        style={{ border: true, flexGrow: 1, flexShrink: 1, minHeight: 0 }}
        borderColor={color.brand}
        titleColor={color.faint}
      >
        <GraphView
          root={props.graph}
          selected={props.selected}
          {...(props.scrollRef === undefined ? {} : { scrollRef: props.scrollRef })}
        />
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
          {line(
            chat,
            <text wrapMode="none">
              {" "}
              <span fg={props.selected === chat ? color.text : color.muted}>Chat</span>
            </text>
          )}
          {props.sections.map((section) => [
            <text key={`heading:${section.group}`} wrapMode="none">
              {" "}
              <span fg={groupColor(section.group)}>{groupGlyph[section.group]}</span>{" "}
              <strong fg={color.text}>{Inbox.headings[section.group]}</strong>
              <span fg={color.faint}>{` ${section.rows.length}`}</span>
            </text>,
            ...section.rows.map(nodeRow)
          ])}
        </scrollbox>
      </box>
      <box
        title={row === undefined ? "Summary" : row.name}
        style={{ width: rightWidth, border: true, flexShrink: 0 }}
        borderColor={frame("cards")}
        titleColor={color.faint}
      >
        {row === undefined ?
          props.review :
          props.peek !== undefined || selected === undefined ?
          <Peek row={row} lines={props.peek ?? []} now={props.cards.now} /> :
          split !== undefined ?
          (
            <scrollbox ref={grid} scrollX={false} style={{ flexGrow: 1, scrollbarOptions: { visible: false } }}>
              <Lanes split={split} width={gridWidth} cards={props.cards} asks={props.asks ?? []} />
            </scrollbox>
          ) :
          (
            <scrollbox ref={grid} scrollX={false} style={{ flexGrow: 1, scrollbarOptions: { visible: false } }}>
              <Grid tabs={branch} width={gridWidth} cards={props.cards} />
            </scrollbox>
          )}
      </box>
    </box>
  )
}

/** A dashed border: the POC lane never lands. */
const dashed = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "╌",
  vertical: "╎",
  topT: "╌",
  bottomT: "╌",
  leftT: "╎",
  rightT: "╎",
  cross: "╌"
}

/** Each lane's width when two share the cards pane. */
export const laneWidth = (width: number): number => Math.max(10, Math.floor(width / 2))

/** The superexpert view: the implement lane's cards beside the POC lane's, with the POC's open questions. */
function Lanes(props: {
  readonly split: NonNullable<ReturnType<typeof Subagents.lanes>>
  readonly width: number
  readonly cards: Cards
  readonly asks: ReadonlyArray<Asks.Ask>
}) {
  const half = laneWidth(props.width)
  const poc = new Set(props.split.poc.map((tab) => tab.id))
  const questions = props.asks.filter((ask) => poc.has(ask.from))
  return (
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <box title="implement" style={{ width: half, border: true }} borderColor={color.border} titleColor={color.faint}>
        <Grid tabs={props.split.implement} width={half - 2} cards={props.cards} />
      </box>
      <box
        title="POC never lands"
        style={{ width: half, border: true }}
        borderColor={color.warning}
        customBorderChars={dashed}
        titleColor={color.warning}
      >
        <Grid tabs={props.split.poc} width={half - 2} cards={props.cards} />
        {questions.length === 0 ? null : (
          <>
            <text fg={color.needs}>{`◆ ${questions.length} question${questions.length === 1 ? "" : "s"}`}</text>
            {questions.map((ask, index) => (
              <text key={ask.id} fg={color.text} wrapMode="none">
                {SubagentCard.clip(`${index + 1} ${ask.question}`, half - 3)}
              </text>
            ))}
          </>
        )}
      </box>
    </box>
  )
}
