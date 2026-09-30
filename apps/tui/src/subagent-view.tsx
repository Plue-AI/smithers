/** Host-owned run cards, worker breadcrumbs, and the Summary overview. */
import type { ScrollBoxRenderable } from "@opentui/core"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from "react"
import stringWidth from "string-width"
import type * as Asks from "./asks.ts"
import * as Graph from "./graph.ts"
import * as Inbox from "./inbox.ts"
import { RunCardView } from "./run-card-view.tsx"
import * as RunCard from "./run-card.ts"
import * as Subagents from "./subagents.ts"
import { tabTitle } from "./surfaces.ts"
import * as Tabs from "./tabs.ts"
import { color } from "./theme.ts"
import { TranscriptRail } from "./transcript-rail.tsx"
import type * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"
import { bar } from "./view.tsx"
import type { Tab } from "./workspace.ts"

/** A card's left rail, drawn in its worker's lane color. */
const rail = { ...bar, vertical: "▌" }

/** What every card in a view reads and does. */
export interface Cards {
  readonly transcript: (id: string) => Transcript.Transcript
  readonly now: number
  /** A worker's lane color. */
  readonly lane: (id: string) => string
  /** The focused card's key (`Subagents.cardKey`). */
  readonly focused: string | undefined
  readonly onOpen: (id: string) => void
  readonly onDiff?: (tab: Tab) => void
  readonly onUndo?: (tab: Tab) => void
  readonly onRunOpen?: (surface: string) => void
  readonly flowSteps?: (id: string) => ReadonlyArray<string>
  /** The ask the person holds from a worker: its card shows the question instead of its steps. */
  readonly ask?: (id: string) => Asks.Ask | undefined
  /** The worker whose ask `a` answers from here: the only thing waiting for the person. */
  readonly answers?: string
  /** A form has the keys: an ask's card shows none. */
  readonly answering?: true
}

/** An ask's numbered choices: `1 sum  2 plus  3 other`; blank without options. */
const numbered = (ask: Asks.Ask): string =>
  (ask.options ?? []).map((option, index) => `${index + 1} ${option}`).join("  ")

/** `New name for add()?  1 sum  2 plus  3 other`, then how to answer. */
function AskLines(props: { readonly tab: Tab; readonly ask: Asks.Ask; readonly cards: Cards }) {
  const choices = numbered(props.ask)
  return (
    <>
      <text fg={color.text} wrapMode="word">
        {props.ask.question}
        {choices === "" ? null : <span fg={color.muted}>{`  ${choices}`}</span>}
      </text>
      <text wrapMode="none">
        {props.cards.answers === props.tab.id
          ? (
            <>
              <span fg={color.text}>a</span>
              <span fg={color.muted}>{" Answer  "}</span>
            </>
          )
          : null}
        {props.cards.answering === true ? null : (
          <>
            <span fg={color.text}>enter</span>
            <span fg={color.muted}>{" Open"}</span>
          </>
        )}
      </text>
    </>
  )
}

/** `◆ title · waiting 0:12`. */
function AskTitle(props: { readonly tab: Tab; readonly ask: Asks.Ask; readonly now: number; readonly width: number }) {
  const clock = ` · waiting ${Inbox.waited(props.now - props.ask.askedAt)}`
  return (
    <text wrapMode="none">
      <span fg={color.needs}>◆</span>{" "}
      <strong fg={color.text}>
        {SubagentCard.clip(tabTitle(props.tab), Math.max(1, props.width - 2 - clock.length))}
      </strong>
      <span fg={color.faint}>{clock}</span>
    </text>
  )
}

/** Host-owned cards in request order; one full-width card per run. A worker the person's answer waits on shows its question. */
export function Grid(props: { readonly tabs: ReadonlyArray<Tab>; readonly width: number; readonly cards: Cards }) {
  return (
    <box>
      {props.tabs.map((tab) => {
        const ask = props.cards.ask?.(tab.id)
        if (ask !== undefined) {
          return (
            <TranscriptRail
              key={tab.id}
              id={Subagents.cardKey(tab.id)}
              style={{ border: ["left"], marginBottom: 1, flexShrink: 0 }}
              borderColor={props.cards.lane(tab.id)}
              customBorderChars={rail}
              {...(props.cards.focused === Subagents.cardKey(tab.id) ? { backgroundColor: color.element } : {})}
              onMouseDown={() => props.cards.onOpen(tab.id)}
            >
              <AskTitle tab={tab} ask={ask} now={props.cards.now} width={Math.max(1, props.width - 1)} />
              <AskLines tab={tab} ask={ask} cards={props.cards} />
            </TranscriptRail>
          )
        }
        const card = RunCard.worker(tab, props.cards.transcript(tab.id), props.cards.now)
        return (
          <RunCardView
            key={tab.id}
            id={Subagents.cardKey(tab.id)}
            card={card}
            width={props.width}
            focused={props.cards.focused === Subagents.cardKey(tab.id)}
            lane={props.cards.lane(tab.id)}
            onOpen={() => props.cards.onOpen(tab.id)}
            {...(props.cards.onDiff === undefined ? {} : { onDiff: () => props.cards.onDiff!(tab) })}
            {...(props.cards.onUndo === undefined ? {} : { onUndo: () => props.cards.onUndo!(tab) })}
          />
        )
      })}
    </box>
  )
}

export function Batch(props: { readonly batch: Subagents.Batch; readonly width: number; readonly cards: Cards }) {
  return (
    <box id={props.batch.key}>
      <Grid tabs={props.batch.tabs} width={props.width} cards={props.cards} />
      {(props.batch.runs ?? []).map((run) => (
        <RunCardView
          key={run.id}
          id={`flow:${run.id}`}
          card={RunCard.flow(run, props.cards.now, props.cards.flowSteps?.(run.id))}
          width={props.width}
          focused={props.cards.focused === `flow:${run.id}`}
          lane={color.brand}
          onOpen={() => props.cards.onRunOpen?.(`flow:${run.id}`)}
        />
      ))}
    </box>
  )
}

/** A parent’s own rows with its workers’ host-owned cards. */
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
          : (
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
      )}
    </>
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

const groupGlyph: Record<Inbox.Group, string> = { needs: "◆", working: "◐", failed: "✗", done: "●" }
const groupColor = (group: Inbox.Group): string =>
  group === "needs" ? color.needs : group === "working" ? color.info : group === "failed" ? color.danger : color.success

/** A row's glyph: a needs-you node is `◆` in the needs color (`⇄` while driven), the rest the shared status glyph. */
export const rowGlyph = (row: Inbox.Row, now: number): { readonly glyph: string; readonly tone: string } =>
  row.status === "input" || (row.group === "needs" && row.worker?.driver === undefined)
    ? { glyph: "◆", tone: color.needs }
    : row.worker === undefined
    ? Tabs.style(row.status, now)
    : Tabs.styleOf(row.worker, now)

/** A flow run's node call as a graph node's glyph. */
const callGlyph = { done: "●", failed: "●", running: "◐", requested: "○", cancelled: "■" } as const

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
      sub: [each.seat, each.clock].filter((part) => part !== "").join(" · "),
      children
    }
  }
  if (row.run !== undefined) {
    return box(
      row,
      nodes(row.run.id).map((call) => ({
        key: `${row.key}:${call.id}`,
        glyph: callGlyph[call.status],
        tone: call.status === "done"
          ? color.success
          : call.status === "failed"
          ? color.danger
          : call.status === "running"
          ? color.info
          : color.faint,
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

/** Fixed column right of the model: the clock; each value leaves a space before the next. */
const columns = { clock: 8 } as const

/**
 * The model column's width in a pane `inner` cells wide: the longest model
 * name among `rows` and its space, short of leaving a name under a dozen cells.
 */
export const seatColumn = (rows: ReadonlyArray<Pick<Inbox.Row, "seat">>, inner: number): number =>
  Math.max(9, Math.min(1 + Math.max(0, ...rows.map((row) => stringWidth(row.seat))), inner - 28))

/**
 * A tree row right of its `lead` cells in a pane `inner` cells wide: the name
 * clipped to fit, the gap, and the model column `seat` cells wide, then the
 * clock column.
 */
export const treeRow = (
  row: Inbox.Row,
  lead: number,
  inner: number,
  seat: number
): { readonly title: string; readonly gap: number; readonly aside: string } => {
  const pad = (text: string, width: number) => SubagentCard.clip(text, width - 1).padEnd(width)
  // A clock wider than its column, a park's `resets 21:43`, takes the empty seat column too.
  const aside = `${
    row.seat === "" && stringWidth(row.clock) >= columns.clock
      ? pad(row.clock, seat + columns.clock)
      : `${pad(row.seat, seat)}${pad(row.clock, columns.clock)}`
  }`
  const right = seat + columns.clock
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
  /** The Failed group shows its rows; closed, only `✗ Failed N ›`. */
  readonly failedOpen?: boolean
  readonly scrollRef?: RefObject<((direction: number) => void) | undefined>
}) {
  const { tree: treeWidth, cards: rightWidth, grid: gridWidth } = overviewWidths(props.width)
  const inner = treeWidth - 2
  const seat = seatColumn(Inbox.flat(props.sections), inner)
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
  const row = Inbox.flat(props.sections, props.failedOpen === true).find((each) => each.key === props.selected)
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
    const { title, gap, aside } = treeRow(each, stringWidth(lead), inner, seat)
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
          {props.sections.map((section) => {
            const heading = (
              <text key={`heading:${section.group}`} wrapMode="none">
                {" "}
                <span fg={groupColor(section.group)}>{groupGlyph[section.group]}</span>{" "}
                <strong fg={color.text}>{Inbox.headings[section.group]}</strong>
                {/* Needs you counts what waits, as Summary's ◆N does: two asks from one worker are 2. */}
                <span fg={color.faint}>
                  {` ${section.group === "needs" ? Inbox.count([section]) : section.rows.length}`}
                </span>
                {section.group === "failed" && props.failedOpen !== true ? <span fg={color.muted}>{" ›"}</span> : null}
              </text>
            )
            if (section.group !== "failed") return [heading, ...section.rows.map(nodeRow)]
            return [line(Inbox.failedKey, heading), ...(props.failedOpen === true ? section.rows.map(nodeRow) : [])]
          })}
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
          row.ask !== undefined && selected !== undefined && props.peek === undefined ?
          (
            <AskPane
              tab={selected}
              ask={row.ask}
              seat={row.seat}
              lane={props.cards.lane(selected.id)}
              now={props.cards.now}
            />
          ) :
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

/** The selected row's ask: whose it is and how long it has waited, then the whole question and its choices. */
function AskPane(
  props: {
    readonly tab: Tab
    readonly ask: Asks.Ask
    readonly seat: string
    readonly lane: string
    readonly now: number
  }
) {
  const choices = numbered(props.ask)
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ border: ["left"], flexShrink: 0 }} borderColor={props.lane} customBorderChars={rail}>
        <text wrapMode="none">
          <span fg={color.needs}>◆</span> <strong fg={color.text}>{tabTitle(props.tab)}</strong>
        </text>
        <text fg={color.faint} wrapMode="none">
          {`waiting ${Inbox.waited(props.now - props.ask.askedAt)} · ${props.seat}`}
        </text>
      </box>
      <box style={{ paddingLeft: 1, paddingTop: 1, flexShrink: 0 }}>
        <text fg={color.text} wrapMode="word">{props.ask.question}</text>
        {choices === "" ? null : <text fg={color.muted} wrapMode="word">{choices}</text>}
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
