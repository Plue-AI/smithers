/**
 * The tab strip, the worker list beside the chat, and a worker's own tab.
 *
 * The look follows the app's subagent cards (`apps/app` `SubagentGrid.tsx`,
 * `cards/AgentCards.tsx`): a lane color, a status glyph, and the way back.
 * A worker's transcript renders with the chat's own cells.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { type RefObject, useEffect, useRef } from "react"
import stringWidth from "string-width"
import type * as Asks from "./asks.ts"
import * as Inbox from "./inbox.ts"
import { type Model, seatName } from "./models.ts"
import { FailureCard } from "./panel-view.tsx"
import * as Scrubber from "./scrubber.ts"
import * as SubagentView from "./subagent-view.tsx"
import * as Subagents from "./subagents.ts"
import * as Tabs from "./tabs.ts"
import { color } from "./theme.ts"
import * as Timeline from "./timeline.ts"
import * as Transcript from "./transcript.ts"
import * as View from "./view.tsx"
import type { Tab } from "./workspace.ts"

export interface Chip {
  readonly id: string
  readonly label: string
  readonly glyph?: string
  readonly tone?: string
  /** `sol · 12.4s`: the model and clock of a worker. */
  readonly detail?: string
  /** `◆1`: Summary's count of what the person can answer now. */
  readonly badge?: string
}

/** Chat and Summary stay pinned; only the focused run or custom view gets a chip. */
export function TabStrip(props: {
  readonly chips: ReadonlyArray<Chip>
  readonly active: string
  readonly width: number
  readonly counts?: { readonly working: number; readonly failed: number }
  readonly onSelect: (id: string) => void
}) {
  const pinned = props.chips.filter((chip) => chip.id === "chat" || chip.id === "summary")
  const focused = props.chips.find((chip) => chip.id === props.active && chip.id !== "chat" && chip.id !== "summary")
  const counts = props.counts
  const badge = pinned.find((chip) => chip.id === "summary")?.badge
  const needs = badge === undefined ? "" : ` ${badge}`
  const summaryCounts = counts === undefined ?
    "" :
    [counts.working > 0 ? `◐${counts.working}` : "", counts.failed > 0 ? `✗${counts.failed}` : ""].filter(Boolean).join(
      "  "
    )
  const used = pinned.reduce((sum, chip) => sum + stringWidth(chip.label) + 3, 0) + stringWidth(needs) +
    (summaryCounts === "" ? 0 : stringWidth(summaryCounts) + 3)
  const label = focused === undefined ? "" : SubagentCard.clip(
    `▸ ${focused.label}${focused.detail === undefined ? "" : ` · ${focused.detail}`}`,
    Math.max(0, props.width - used - 2)
  )
  return (
    <box style={{ flexDirection: "row", height: 1, width: props.width, flexShrink: 0, overflow: "hidden" }}>
      {pinned.map((chip) => (
        <text
          key={chip.id}
          wrapMode="none"
          style={{ flexShrink: 0, marginRight: 1 }}
          bg={chip.id === props.active ? color.selected : color.page}
          onMouseDown={() => props.onSelect(chip.id)}
        >
          {" "}
          {chip.id === props.active
            ? <strong fg={color.brand}>{chip.label}</strong>
            : <span fg={color.muted}>{chip.label}</span>}
          {chip.id === "summary" ? <span fg={color.needs}>{needs}</span> : null}
          {" "}
        </text>
      ))}
      {summaryCounts === ""
        ? null
        : <text fg={color.muted} wrapMode="none" style={{ flexShrink: 0, marginRight: 2 }}>{summaryCounts}</text>}
      {focused === undefined || label === "" ?
        null :
        (
          <text
            fg={color.brand}
            bg={color.selected}
            wrapMode="none"
            style={{ flexShrink: 0 }}
            onMouseDown={() => props.onSelect(focused.id)}
          >
            {label}
          </text>
        )}
    </box>
  )
}

/** Reported model and elapsed time; `sol · waiting 0:12` while it asks the person. */
const facts = (tab: Tab, models: ReadonlyArray<Model>, now: number, ask?: Asks.Ask): string =>
  ask !== undefined
    ? `${seatName(tab, models)} · waiting ${Inbox.waited(now - ask.askedAt)}`
    : `${seatName(tab, models)} · ${Transcript.duration(Tabs.elapsed(tab, now))}`

/** A worker's glyph: `◆` in the needs color while the person holds its ask. */
export const styleOf = (tab: Tab, now: number, ask?: Asks.Ask): { readonly glyph: string; readonly tone: string } =>
  ask === undefined ? Tabs.styleOf(tab, now) : { glyph: "◆", tone: color.needs }

/** A worker's tab chip: glyph, title and clock, or how long its ask has waited. */
export const chip = (tab: Tab, now: number, ask?: Asks.Ask): Chip => {
  const { glyph, tone } = styleOf(tab, now, ask)
  return {
    id: `tab:${tab.id}`,
    label: tab.title,
    glyph,
    tone,
    detail: ask === undefined
      ? Transcript.duration(Tabs.elapsed(tab, now))
      : `waiting ${Inbox.waited(now - ask.askedAt)}`
  }
}

/** The workers beside the chat, drawn as their tabs are. */
export function WorkerList(props: {
  readonly tabs: ReadonlyArray<Tab>
  readonly active: string
  readonly models: ReadonlyArray<Model>
  readonly now: number
  /** The ask the person holds from a worker. */
  readonly ask?: (id: string) => Asks.Ask | undefined
  readonly onSelect: (id: string) => void
}) {
  return (
    <box style={{ flexDirection: "column" }}>
      {props.tabs.map((tab) => {
        const ask = props.ask?.(tab.id)
        const { glyph, tone } = styleOf(tab, props.now, ask)
        const selected = props.active === `tab:${tab.id}`
        return (
          <box
            key={tab.id}
            style={{ border: ["left"], paddingLeft: 1, marginBottom: 1 }}
            borderColor={selected ? color.brand : tone}
            customBorderChars={View.bar}
            backgroundColor={selected ? color.selected : color.page}
            onMouseDown={() => props.onSelect(`tab:${tab.id}`)}
          >
            <text wrapMode="word">
              <span fg={tone}>{glyph}</span>{" "}
              <span fg={selected ? color.text : color.muted}>{tab.description ?? tab.title}</span>
            </text>
            <text fg={color.faint} wrapMode="none">
              {facts(tab, props.models, props.now, ask)}
            </text>
          </box>
        )
      })}
    </box>
  )
}

function Button(props: { readonly keys: string; readonly label: string; readonly onPress: () => void }) {
  return (
    <box
      style={{ paddingLeft: 1, paddingRight: 1, marginRight: 1, flexShrink: 0 }}
      backgroundColor={color.element}
      onMouseDown={props.onPress}
    >
      <text wrapMode="none">
        <span fg={color.text}>{props.keys}</span>
        <span fg={color.muted}>{" "}{props.label}</span>
      </text>
    </box>
  )
}

/**
 * A done worker no judge could check: `✓ title · 38s · src/cart.js +1 −1 · npm test exit 0 · unchecked`,
 * with `unchecked` dim. It is done; nothing about it is red but a removed line's count.
 */
function Unchecked(props: { readonly tab: Tab; readonly transcript: Transcript.Transcript }) {
  const { files, check } = Subagents.result(props.transcript)
  return (
    <box
      style={{ border: ["left"], paddingLeft: 1, marginLeft: 2, marginBottom: 1 }}
      borderColor={color.faint}
      customBorderChars={View.bar}
    >
      <text>
        <span fg={color.success}>✓</span>
        <span fg={color.text}>
          {" "}
          {props.tab.title} · {SubagentCard.duration(Tabs.elapsed(props.tab, props.tab.endedAt ?? 0))}
        </span>
        {files.map((file) => (
          <span key={file.path}>
            <span fg={color.text}>{" · "}{file.path}</span>
            {file.added > 0 ? <span fg={color.success}>{" +"}{file.added}</span> : null}
            {file.removed > 0 ? <span fg={color.danger}>{" −"}{file.removed}</span> : null}
          </span>
        ))}
        {check === undefined
          ? null
          : <span fg={color.text}>{" · "}{check.command} exit {check.exit}</span>}
        <span fg={color.text}>{" · "}</span>
        <span fg={color.faint}>unchecked</span>
      </text>
    </box>
  )
}

/** `14:02`, local time. */
const clock = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/**
 * A worker's tab: the way back to its parent, its status header and actions,
 * and its transcript in the chat's own cells with its own children's cards.
 */
export function WorkerView(props: {
  readonly tab: Tab
  readonly transcript: Transcript.Transcript
  readonly models: ReadonlyArray<Model>
  readonly now: number
  readonly tick: string
  /** The worker's lane color in the chat. */
  readonly tone: string
  readonly width: number
  readonly expanded: boolean
  readonly failureScrollRef?: RefObject<ScrollBoxRenderable | null>
  readonly height?: number
  readonly onAction: (action: Tabs.ActionId) => void
  /** The transcript item the run timeline's playhead is on. */
  readonly jump?: string | undefined
  readonly scrollRef?: RefObject<((direction: number) => void) | undefined>
  readonly viewportRef?: RefObject<ScrollBoxRenderable | null>
  /** Titles from the chat down to this worker's parent. */
  readonly onBack: () => void
  /** Return execution to the worker while keeping its tab open. */
  readonly onRelease: () => void
  /** Every tab, for this worker's own children. */
  readonly tabs: ReadonlyArray<Tab>
  readonly cards: SubagentView.Cards
  readonly earlierOpen: boolean
  readonly onEarlier: () => void
}) {
  const scroll = useRef<ScrollBoxRenderable>(null)
  if (props.scrollRef !== undefined) {
    props.scrollRef.current = (direction) => scroll.current?.scrollBy(direction * 0.5, "viewport")
  }
  useEffect(() => {
    if (props.jump !== undefined) scroll.current?.scrollChildIntoView(props.jump)
  }, [props.jump])
  const { tab, transcript } = props
  const { glyph, tone } = Tabs.styleOf(tab, props.now)
  const facts = [
    ...(tab.driver === undefined ? [] : [`${tab.driver.by} since ${clock(tab.driver.from)}`]),
    tab.harness === undefined
      ? seatName(tab, props.models)
      : `${tab.harness.vendor}${
        tab.harness.session === undefined ? "" : ` · session ${tab.harness.session.slice(0, 8)}`
      }`,
    Transcript.duration(Tabs.elapsed(tab, props.now))
  ].join(" · ")
  const lines = Subagents.lines(
    Timeline.rows(transcript),
    Subagents.batches(transcript, props.tabs, tab.id),
    props.earlierOpen,
    tab.id
  )
  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
      <box style={{ height: 2, flexShrink: 0, paddingLeft: 1 }}>
        <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between" }}>
          <text wrapMode="none" style={{ flexShrink: 1 }}>
            <span fg={tone}>{glyph}</span> <strong fg={color.text}>{tab.title}</strong>
          </text>
          <text
            fg={color.brand}
            wrapMode="none"
            style={{ flexShrink: 0 }}
            onMouseDown={tab.driver === undefined ? props.onBack : props.onRelease}
          >
            {tab.driver === undefined ? "Back (ctrl+y)" : "Release (ctrl+y)"}
          </text>
        </box>
        <box style={{ flexDirection: "row", height: 1 }}>
          <text fg={color.faint} wrapMode="none" style={{ flexShrink: 1 }}>{facts}</text>
          {Tabs.actions(tab).map((action) => (
            <Button
              key={action.id}
              keys={action.keys[0]!}
              label={action.label}
              onPress={() => props.onAction(action.id)}
            />
          ))}
        </box>
      </box>
      {tab.status === "failed" ?
        (
          <scrollbox
            ref={props.failureScrollRef}
            style={{
              maxHeight: Math.max(2, Math.floor((props.height ?? 20) / 3)),
              flexShrink: 0,
              scrollbarOptions: { visible: false }
            }}
          >
            <FailureCard tab={tab} transcript={transcript} details={props.expanded} hints={false} />
          </scrollbox>
        ) :
        null}
      <scrollbox
        ref={(box) => {
          scroll.current = box
          if (props.viewportRef !== undefined) props.viewportRef.current = box
        }}
        stickyScroll
        stickyStart="bottom"
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, scrollbarOptions: { visible: false } }}
      >
        <SubagentView.Lines
          lines={lines}
          onEarlier={props.onEarlier}
          width={props.width - 2}
          cards={props.cards}
          row={({ row: { item } }) => {
            const step = item.kind === "cell" ? Scrubber.step(transcript, item) : undefined
            return (
              <box key={item.id} id={item.id}>
                <View.Entry
                  item={item}
                  now={props.now}
                  tick={props.tick}
                  expanded={props.expanded}
                  tone={props.tone}
                  selected={item.id === props.jump}
                  {...(step === undefined ? {} : { step })}
                />
              </box>
            )
          }}
        />
        {transcript.thinking ? <text fg={color.muted} style={{ paddingLeft: 2 }}>{props.tick} thinking</text> : null}
        {tab.status === "done" && tab.unchecked === true ? <Unchecked tab={tab} transcript={transcript} /> : null}
      </scrollbox>
    </box>
  )
}
