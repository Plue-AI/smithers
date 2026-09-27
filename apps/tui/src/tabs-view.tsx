/**
 * The tab strip, the worker list beside the chat, and a worker's own tab.
 *
 * The look follows the app's subagent rows (`apps/app` `SubagentRow.tsx`,
 * `cards/AgentCards.tsx`): a lane color, a status pill, and the way back.
 * A worker's transcript renders with the chat's own cells.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import { type RefObject, useEffect, useRef } from "react"
import * as Editor from "./editor.ts"
import type { Model } from "./models.ts"
import { FailureCard } from "./panel-view.tsx"
import * as Scrubber from "./scrubber.ts"
import * as Tabs from "./tabs.ts"
import { color } from "./theme.ts"
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
            backgroundColor={selected ? color.element : color.page}
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

/** `sol · 12.4s`, then the estimate while it runs: `sol · 12.4s ~3m`. */
const facts = (tab: Tab, models: ReadonlyArray<Model>, now: number, eta: string): string =>
  `${Tabs.model(tab.seat, models)} · ${Transcript.duration(Tabs.elapsed(tab, now))}${eta === "" ? "" : ` ${eta}`}`

/** A worker's tab chip: glyph, title, model, clock and estimate. */
export const chip = (tab: Tab, models: ReadonlyArray<Model>, now: number, eta = ""): Chip => {
  const { glyph, tone } = Tabs.style(tab.status, now)
  return {
    id: `tab:${tab.id}`,
    label: tab.title,
    glyph,
    tone,
    detail: facts(tab, models, now, eta)
  }
}

/** The workers beside the chat, drawn as their tabs are. */
export function WorkerList(props: {
  readonly tabs: ReadonlyArray<Tab>
  readonly active: string
  readonly models: ReadonlyArray<Model>
  readonly now: number
  /** The worker's estimate label, empty when there is none. */
  readonly eta: (tab: Tab) => string
  readonly onSelect: (id: string) => void
}) {
  return (
    <box style={{ flexDirection: "column" }}>
      {props.tabs.map((tab) => {
        const { glyph, tone } = Tabs.style(tab.status, props.now)
        const selected = props.active === `tab:${tab.id}`
        return (
          <box
            key={tab.id}
            style={{ border: ["left"], paddingLeft: 1, marginBottom: 1 }}
            borderColor={selected ? color.brand : tone}
            customBorderChars={View.bar}
            backgroundColor={selected ? color.element : color.page}
            onMouseDown={() => props.onSelect(`tab:${tab.id}`)}
          >
            <text wrapMode="word">
              <span fg={tone}>{glyph}</span>{" "}
              <span fg={selected ? color.text : color.muted}>{tab.description ?? tab.title}</span>
            </text>
            <text fg={color.faint} wrapMode="none">
              {facts(tab, props.models, props.now, props.eta(tab))}
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

/** A worker's tab: its status header, its actions, and its transcript in the chat's own cells. */
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
  /** The transcript item `u` undoes, marked and kept in view. */
  readonly selected?: string | undefined
  readonly scrollRef?: RefObject<((direction: number) => void) | undefined>
}) {
  const scroll = useRef<ScrollBoxRenderable>(null)
  if (props.scrollRef !== undefined) {
    props.scrollRef.current = (direction) => scroll.current?.scrollBy(direction * 0.5, "viewport")
  }
  // Follow the selection once the user moves it; on open the view stays at the live bottom.
  const opened = useRef(props.selected)
  useEffect(() => {
    if (props.selected === opened.current) return
    opened.current = undefined
    if (props.selected !== undefined) scroll.current?.scrollChildIntoView(props.selected)
  }, [props.selected])
  const { tab, transcript } = props
  const { glyph, tone } = Tabs.style(tab.status, props.now)
  const usage = transcript.usage
  const facts = [
    Tabs.model(tab.seat, props.models),
    Transcript.duration(Tabs.elapsed(tab, props.now)),
    ...(usage.input + usage.output === 0 ? [] : [`↑${Editor.tokens(usage.input)} ↓${Editor.tokens(usage.output)}`])
  ].join(" · ")
  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
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
        {transcript.items.map((item) => {
          const step = item.kind === "cell" ? Scrubber.step(transcript, item) : undefined
          return (
            <box key={item.id} id={item.id} style={{ flexDirection: "row" }}>
              <text fg={color.brand} style={{ width: 2, flexShrink: 0 }}>{item.id === props.selected ? "›" : " "}</text>
              <box style={{ flexGrow: 1, flexShrink: 1 }}>
                <View.Entry
                  item={item}
                  now={props.now}
                  tick={props.tick}
                  expanded={props.expanded}
                  tone={props.tone}
                  selected={item.id === props.selected}
                  {...(step === undefined ? {} : { step })}
                />
              </box>
            </box>
          )
        })}
        {transcript.thinking ? <text fg={color.muted} style={{ paddingLeft: 2 }}>{props.tick} thinking</text> : null}
      </scrollbox>
    </box>
  )
}
