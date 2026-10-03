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
import * as Editor from "./editor.ts"
import type { Model } from "./models.ts"
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
}

const text = (chip: Chip): string =>
  ` ${chip.glyph === undefined ? "" : `${chip.glyph} `}${chip.label}${
    chip.detail === undefined ? "" : ` ${chip.detail}`
  } `

/** One row of whole tabs around the active one; `‹ 3` and `2 ›` count and open the hidden ones. */
export function TabStrip(props: {
  readonly chips: ReadonlyArray<Chip>
  readonly active: string
  readonly width: number
  readonly onSelect: (id: string) => void
}) {
  const { chips } = props
  const active = Math.max(0, chips.findIndex((chip) => chip.id === props.active))
  // Each chip is followed by a one-column gap.
  const { first, last } = Tabs.fit(chips.map((chip) => text(chip).length + 1), active, props.width)
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      {first === 0 ?
        null :
        (
          <text
            fg={color.muted}
            wrapMode="none"
            style={{ flexShrink: 0 }}
            onMouseDown={() => props.onSelect(chips[first - 1]!.id)}
          >
            {`‹ ${first}`.padEnd(Tabs.arrow)}
          </text>
        )}
      {chips.slice(first, last).map((chip) => {
        const selected = chip.id === props.active
        return (
          <box
            key={chip.id}
            style={{ flexShrink: 0, marginRight: 1 }}
            backgroundColor={selected ? color.selected : color.page}
            onMouseDown={() => props.onSelect(chip.id)}
          >
            <text wrapMode="none">
              {" "}
              {chip.glyph === undefined ? null : <span fg={chip.tone ?? color.faint}>{chip.glyph}{" "}</span>}
              {selected ? <strong fg={color.brand}>{chip.label}</strong> : <span fg={color.muted}>{chip.label}</span>}
              {chip.detail === undefined ? null : <span fg={color.faint}>{" "}{chip.detail}</span>}
              {" "}
            </text>
          </box>
        )
      })}
      {last >= chips.length ?
        null :
        (
          <text
            fg={color.muted}
            wrapMode="none"
            style={{ flexShrink: 0 }}
            onMouseDown={() => props.onSelect(chips[last]!.id)}
          >
            {`${chips.length - last} ›`.padStart(Tabs.arrow)}
          </text>
        )}
    </box>
  )
}

/** Reported model and elapsed time. */
const facts = (tab: Tab, models: ReadonlyArray<Model>, now: number): string =>
  `${Tabs.seatName(tab, models)} · ${Transcript.duration(Tabs.elapsed(tab, now))}`

/** A worker's tab chip: glyph, title, model and clock. */
export const chip = (tab: Tab, models: ReadonlyArray<Model>, now: number): Chip => {
  const { glyph, tone } = Tabs.styleOf(tab, now)
  return {
    id: `tab:${tab.id}`,
    label: tab.title,
    glyph,
    tone,
    detail: facts(tab, models, now)
  }
}

/** The workers beside the chat, drawn as their tabs are. */
export function WorkerList(props: {
  readonly tabs: ReadonlyArray<Tab>
  readonly active: string
  readonly models: ReadonlyArray<Model>
  readonly now: number
  readonly onSelect: (id: string) => void
}) {
  return (
    <box style={{ flexDirection: "column" }}>
      {props.tabs.map((tab) => {
        const { glyph, tone } = Tabs.styleOf(tab, props.now)
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
              {facts(tab, props.models, props.now)}
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
  readonly onAction: (action: Tabs.ActionId) => void
  /** The transcript item the run timeline's playhead is on. */
  readonly jump?: string | undefined
  readonly scrollRef?: RefObject<((direction: number) => void) | undefined>
  /** Titles from the chat down to this worker's parent. */
  readonly path: ReadonlyArray<string>
  readonly onBack: () => void
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
  const usage = transcript.usage
  const facts = [
    ...(tab.driver === undefined ? [] : [`${tab.driver.by} since ${clock(tab.driver.from)}`]),
    tab.harness === undefined
      ? Tabs.seatName(tab, props.models)
      : `${tab.harness.vendor}${
        tab.harness.session === undefined ? "" : ` · session ${tab.harness.session.slice(0, 8)}`
      }`,
    Transcript.duration(Tabs.elapsed(tab, props.now)),
    ...(usage.input + usage.output === 0 ? [] : [`↑${Editor.tokens(usage.input)} ↓${Editor.tokens(usage.output)}`])
  ].join(" · ")
  const lines = Subagents.lines(
    Timeline.rows(transcript),
    Subagents.batches(transcript, props.tabs, tab.id),
    props.earlierOpen,
    tab.id
  )
  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
      <SubagentView.Crumb
        title={tab.title}
        tone={props.tone}
        path={props.path}
        onBack={props.onBack}
        driving={tab.driver !== undefined}
      />
      <box
        style={{ border: ["left"], paddingLeft: 1, marginBottom: 1, flexShrink: 0 }}
        borderColor={props.tone}
        customBorderChars={View.bar}
      >
        <text wrapMode="word">
          <span fg={tone}>{glyph}</span> <strong fg={color.text}>{tab.title}</strong>
        </text>
        <text fg={color.faint} wrapMode="none">{facts}</text>
        {tab.status === "failed"
          ? <FailureCard tab={tab} transcript={transcript} details={props.expanded} hints={false} />
          : null}
        <box style={{ flexDirection: "row", marginTop: 1 }}>
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
      <scrollbox
        ref={scroll}
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
