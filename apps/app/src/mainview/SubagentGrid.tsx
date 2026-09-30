import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { allowed, live } from "@smthrs/rpc/WorkerControls"
import { useClock } from "@smthrs/ui/clock"
import { useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react"
import { flowAction, flowProps } from "./flows/FlowAction"
import { flowArgs } from "./flows/FlowArgs"
import type { FlowName } from "./flows/FlowName"
import type { Card } from "./state/AppState"
import { MAIN_TAB_ID } from "./state/AppState"
import type { CardProjectionAuthority } from "./cards/CardFamily"
import { LANE_COLORS, subagentsFromCards } from "./state/ChatTimeline"
import { childCardOf, childRuns, childSubagent, footerOf, overview, parentRunOf, type OverviewNode } from "./state/Subagents"
import { useCardRows } from "./state/useCardRows"
import { workerToastActions } from "./WorkerToastActions"
import { SurfaceHeader } from "./SurfaceChrome"
import { Bot } from "lucide-react"

/*
 * Slate's subagent card grid (#2162), drawn from `@smthrs/rpc/SubagentCard`
 * so the glyphs, rows and footers match the TUI: a batch header with its ▰
 * bar, then one card per subagent in the lane color. Enter or a click opens
 * the child; the Stop chip is the worker's own stop flow.
 */

/** A flow and its arguments. */
export interface Door {
  readonly flow: FlowName
  readonly args?: string | undefined
}

/** One card: the subagent, its lane color and its two doors. */
export interface SubagentItem {
  readonly id: string
  readonly color: number
  readonly subagent: SubagentCard.Subagent
  readonly open: Door
  /** The worker's stop flow while it has one. */
  readonly stop?: Door | undefined
}

/** A worker card's Stop, the same flow its toast offers. */
export const stopDoor = (card: Card): Door | undefined => {
  const stop = workerToastActions(card).find(action => action.label === "Stop")
  return stop === undefined ? undefined : { flow: stop.flow, args: stop.args }
}

/** Where an agent card opens: a local agent's own tab, a cloud session's card tab. */
export const agentDoors = (card: Extract<Card, { kind: "agent" }>): { readonly open: Door; readonly stop?: Door | undefined } => ({
  open: "cloud" in card.payload ? { flow: "tab.card", args: card.id } : { flow: "tab.select", args: card.payload.tabId },
  stop: stopDoor(card)
})

/** A child run opens as its run card. */
export const childRunDoor = (runId: string, repo: string): Door => ({ flow: "runs.open", args: flowArgs("runs.open", { runId, repo }) })

/** One clock for every glyph on screen, turning only while something is live. */
const useSubagentClock = (subagents: ReadonlyArray<SubagentCard.Subagent>): number =>
  useClock(subagents.some(subagent => live(subagent.status)), SubagentCard.frameMs)

const Header = ({ statuses, now }: { readonly statuses: ReadonlyArray<SubagentCard.Subagent["status"]>; readonly now: number }) => {
  const header = SubagentCard.header(statuses, now)
  return (
    <div className="subagent-header" data-tone={header.tone}>
      <span className="subagent-header-text">{[header.glyph, header.text].filter(part => part !== "").join(" ")}</span>
      {header.count === "" ? null : <span className="subagent-header-count">{header.count}</span>}
      {header.mark === "" ? null : <span className="subagent-header-mark">{header.mark}</span>}
      <span className="subagent-bar" aria-hidden="true">
        {header.bar.map((cell, index) => <i key={index} data-state={cell}>{SubagentCard.barGlyph}</i>)}
      </span>
    </div>
  )
}

/** Arrow keys move between cards the way they sit on screen. */
const moveFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
  const grid = event.currentTarget.parentElement
  if (grid === null) return
  const cards = [...grid.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("subagent-card"))
  const index = cards.indexOf(event.currentTarget)
  const across = Math.max(1, cards.filter(card => card.offsetTop === cards[0]?.offsetTop).length)
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" ? across
    : event.key === "ArrowUp" ? -across : undefined
  const target = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : step === undefined ? undefined : index + step
  if (target === undefined) return
  event.preventDefault()
  cards[Math.min(Math.max(target, 0), cards.length - 1)]?.focus()
}

const SubagentCardView = ({ item, now, onRunCommand }: {
  readonly item: SubagentItem
  readonly now: number
  readonly onRunCommand: (name: FlowName, args?: string) => void
}) => {
  // The files list is a disclosure with no address: transient chrome.
  const [filesOpen, setFilesOpen] = useState(false)
  const { subagent, open } = item
  const card = SubagentCard.card(subagent, now, { open: filesOpen })
  const footer = footerOf(subagent, now)
  const stop = item.stop !== undefined && allowed("stop", subagent) ? item.stop : undefined
  return (
    <div className="subagent-card" role="group" tabIndex={0} aria-keyshortcuts="Enter" data-lane-color={item.color} data-tone={card.tone}
      data-testid={`subagent-${item.id}`} aria-label={`${subagent.title}, ${footer.clock}`} {...flowProps(open.flow, open.args)}
      onClick={(event: MouseEvent<HTMLElement>) => {
        if (event.target instanceof Element && event.target.closest("button") !== null) return
        onRunCommand(open.flow, open.args)
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onRunCommand(open.flow, open.args)
          return
        }
        moveFocus(event)
      }}>
      {stop === undefined ? null : <button type="button" className="subagent-stop" {...flowAction(onRunCommand, stop.flow, stop.args)}>Stop</button>}
      <div className="subagent-title"><span className="subagent-glyph" data-tone={card.tone}>{card.glyph}</span> {card.title}</div>
      <div className="subagent-activity">
        {card.activity.earlier === undefined ? null : <div className="subagent-earlier">{card.activity.earlier}</div>}
        {card.activity.rows.map((row, index) => (
          <div key={index} className="subagent-activity-row" data-state={row.state}>
            <span className="subagent-activity-text">{row.branch} {row.text}</span>
            {row.mark === "" ? null : <span className="subagent-mark" data-mark={row.mark}>{row.mark}</span>}
          </div>
        ))}
        {card.files?.rows.map((row, index) => (
          <div key={`file-${index}`} className="subagent-activity-row subagent-file"><span className="subagent-activity-text">{row.branch} {row.text}</span></div>
        ))}
      </div>
      <div className="subagent-footer">
        {card.files === undefined ? <span /> : (
          <button type="button" className="subagent-files" aria-expanded={filesOpen} onClick={() => setFilesOpen(!filesOpen)}>{card.files.line}</button>
        )}
        <span className="subagent-clock">
          {footer.text}
          {footer.aside === "" ? null : <span className="subagent-aside">{footer.aside}</span>}
        </span>
      </div>
    </div>
  )
}

/** A batch: its header and ▰ bar over the card grid. */
export const SubagentBatch = ({ items, onRunCommand }: {
  readonly items: ReadonlyArray<SubagentItem>
  readonly onRunCommand: (name: FlowName, args?: string) => void
}) => {
  const now = useSubagentClock(items.map(item => item.subagent))
  if (items.length === 0) return null
  return (
    <section className="subagent-batch" aria-label={SubagentCard.headerLine(SubagentCard.header(items.map(item => item.subagent.status), now))}>
      <Header statuses={items.map(item => item.subagent.status)} now={now} />
      <div className="subagent-grid">
        {items.map(item => <SubagentCardView key={item.id} item={item} now={now} onRunCommand={onRunCommand} />)}
      </div>
    </section>
  )
}

/** The batches before the newest ten, as one row that shows them where they stood. */
export const SubagentEarlier = ({ batches, onOpen }: { readonly batches: number; readonly onOpen: () => void }) => (
  <button type="button" className="subagent-earlier-batches" aria-expanded={false} onClick={onOpen}>{SubagentCard.earlierLine(batches)}</button>
)

/** `◉ {title} done` in the parent, once the subagent settles. */
export const SubagentFinished = ({ subagent, color }: { readonly subagent: SubagentCard.Subagent; readonly color: number }) => {
  const row = SubagentCard.finished(subagent.title, subagent.status)
  return (
    <p className="subagent-finished" data-tone={row.tone} data-lane-color={color}>
      <span className="subagent-glyph" data-tone={row.tone}>{row.glyph}</span> {row.line.slice(row.glyph.length + 1)}
    </p>
  )
}

/** The bar over a subagent's own view, and the way back to the conversation (ctrl+y). */
export const SubagentCrumb = ({ title, color, onRunCommand }: {
  readonly title: string
  readonly color: number
  readonly onRunCommand: (name: FlowName, args?: string) => void
}) => (
  <div className="subagent-crumb" data-lane-color={color} data-testid="subagent-crumb" ref={bindBackShortcut}>
    <span className="subagent-crumb-title"><span className="subagent-crumb-rail" aria-hidden="true">▌</span> Subagent · {title}</span>
    <button type="button" className="subagent-back" data-subagent-back="" aria-keyshortcuts="Control+Y"
      {...flowAction(onRunCommand, "tab.select", MAIN_TAB_ID)}>Back (ctrl+y)</button>
  </div>
)

/**
 * The breadcrumb's words for a view: an agent card's own tab, a local
 * agent's terminal (by its tab id), or a child run's card. Undefined for
 * anything that is not a subagent.
 */
export const subagentCrumbOf = (cards: ReadonlyArray<Card>, view: { readonly card: Card } | { readonly tabId: string }): { readonly title: string; readonly color: number } | undefined => {
  if ("card" in view && view.card.kind === "run-trace") {
    const found = parentRunOf(cards, view.card)
    return found === undefined ? undefined : { title: found.child.title, color: found.index % LANE_COLORS }
  }
  const subagent = subagentsFromCards(cards).find(each => "card" in view ? each.id === view.card.id
    : !("cloud" in each.card.payload) && each.card.payload.tabId === view.tabId)
  return subagent === undefined ? undefined : { title: subagent.subagent.title, color: subagent.color }
}

/**
 * ctrl+y presses the visible breadcrumb's Back, so the key and the button are
 * one door. It listens on the document while the crumb is mounted (a ref
 * callback, not an effect): opening the subagent leaves focus on the card it
 * was opened from, which the now-hidden conversation still holds.
 */
const bindBackShortcut = (crumb: HTMLElement | null): (() => void) | undefined => {
  if (crumb === null) return undefined
  const doc = crumb.ownerDocument
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "y") return
    if (crumb.closest("[hidden]") !== null || !crumb.isConnected) return
    event.preventDefault()
    event.stopPropagation()
    crumb.querySelector<HTMLButtonElement>("[data-subagent-back]")?.click()
  }
  doc.addEventListener("keydown", onKeyDown, true)
  return () => doc.removeEventListener("keydown", onKeyDown, true)
}

type RunCard = Extract<Card, { kind: "run-trace" }>
/** The cards collection a mounted card reads its child runs from. */
type CardCollection = NonNullable<CardProjectionAuthority["collections"]["cards"]>

/** A run's detached child runs as cards; each opens as its own run card. */
export const ChildRunGrid = ({ card, cards, onRunCommand }: {
  readonly card: RunCard
  readonly cards: ReadonlyArray<Card>
  readonly onRunCommand: (name: FlowName, args?: string) => void
}) => (
  <SubagentBatch onRunCommand={onRunCommand} items={childRuns(card).map((child, index) => {
    const own = childCardOf(cards, card, child.runId)
    return {
      id: child.runId,
      color: index % LANE_COLORS,
      subagent: childSubagent(child, own),
      open: childRunDoor(child.runId, card.payload.repo),
      stop: own === undefined ? undefined : stopDoor(own)
    }
  })} />
)

const LiveChildRunGrid = ({ collection, card, onRunCommand }: {
  readonly card: RunCard
  readonly collection: CardCollection
  readonly onRunCommand: (name: FlowName, args?: string) => void
}) => <ChildRunGrid card={card} cards={useCardRows(collection)} onRunCommand={onRunCommand} />

/** The child grid, reading the child runs' own cards live when the store is there. */
export const ChildRuns = ({ card, collection, onRunCommand }: {
  readonly card: RunCard
  readonly collection: CardCollection | undefined
  readonly onRunCommand: (name: FlowName, args?: string) => void
}) =>
  childRuns(card).length === 0 ? null
    : collection === undefined ? <ChildRunGrid card={card} cards={[]} onRunCommand={onRunCommand} />
    : <LiveChildRunGrid card={card} collection={collection} onRunCommand={onRunCommand} />

/** Where an overview row opens: an agent's own tab or card tab, else its run card. */
const nodeDoors = (node: OverviewNode): { readonly open: Door; readonly stop?: Door | undefined } =>
  "agent" in node.open ? agentDoors(node.open.agent)
    : { open: childRunDoor(node.open.runId, node.open.repo), stop: node.card === undefined ? undefined : stopDoor(node.card) }

/**
 * The ctrl+s overview beside the chat (#2190), the GUI's form of the TUI
 * Summary: every subagent as a tree, then the top-level ones as the grid.
 * A tree row and a card open the same worker.
 */
export const SubagentOverview = ({ cards, onRunCommand }: {
  readonly cards: ReadonlyArray<Card>
  readonly onRunCommand: (name: FlowName, args?: string) => void
}) => {
  const nodes = overview(cards, LANE_COLORS)
  const now = useSubagentClock(nodes.map(node => node.subagent))
  const roots = nodes.filter(node => node.level === 0)
  return (
    <section data-keyboard-pane="Subagents" className="subagents-surface embedded-pane" aria-label="Subagents" data-testid="subagent-overview">
      <SurfaceHeader icon={<Bot size={17} aria-hidden="true" />} title="Subagents" closeCommand="chat" onClose={() => onRunCommand("chat")} />
      <div className="subagents-content">
        {nodes.length === 0 ? null : (
          <ul className="subagent-tree" aria-label="Subagent tree">
            {nodes.map(node => {
              const open = nodeDoors(node).open
              const glyph = SubagentCard.glyph(node.subagent.status, now)
              return (
                <li key={node.id} style={{ paddingInlineStart: `${node.level * 16}px` }}>
                  <button type="button" className="subagent-tree-row" data-lane-color={node.color} data-testid={`subagent-tree-${node.id}`}
                    {...flowAction(onRunCommand, open.flow, open.args)}>
                    <span className="subagent-glyph" data-tone={glyph.tone}>{glyph.glyph}</span>
                    <span className="subagent-tree-title">{node.subagent.title}</span>
                    <span className="subagent-clock">{footerOf(node.subagent, now).clock}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <SubagentBatch onRunCommand={onRunCommand} items={roots.map(node => ({ id: node.id, color: node.color, subagent: node.subagent, ...nodeDoors(node) }))} />
      </div>
    </section>
  )
}
