/**
 * The app's own panels below and over the transcript: a flow run's input
 * form, the completion menu, the dialog, and the status line. They draw
 * what they are given.
 */
import { type ScrollBoxRenderable, TextBuffer, TextBufferView } from "@opentui/core"
import { flushSync, useKeyboard, usePaste, useRenderer } from "@opentui/react"
import { usd } from "@smthrs/gateway/Diagnosis"
import { basename } from "node:path"
import { useRef } from "react"
import stringWidth from "string-width"
import type * as Complete from "./complete.ts"
import * as Editor from "./editor.ts"
import type * as Extension from "./extension.ts"
import * as Dispatch from "./key-dispatch.ts"
import type { FlowForm } from "./key-dispatch.ts"
import * as Keys from "./keys.ts"
import * as Models from "./models.ts"
import { color } from "./theme.ts"
import type * as Transcript from "./transcript.ts"
import * as View from "./view.tsx"
import type { Tab } from "./workspace.ts"

/** The model that receives the composer's input. */
export function ComposerModel(props: {
  readonly seat: string
  readonly models: ReadonlyArray<Models.Model>
  readonly worker?: Pick<Tab, "seat" | "activeSeat" | "harness">
}) {
  if (props.worker !== undefined) return <span fg={color.text}>{Models.seatName(props.worker, props.models)}</span>
  const model = props.models.find((each) => each.seat === props.seat)
  const label = model?.label ?? (props.seat.startsWith("replay:") ? `replay ${basename(props.seat)}` : props.seat)
  return (
    <>
      <span fg={color.text}>{label}</span>
      {model === undefined ? null : <span fg={color.faint}>{" "}{model.provider}</span>}
    </>
  )
}

/** Completion rows shown at once. */
const menuRows = 8

/** A value box's width: its text and a cell of padding each side, at least `min`, at most `max`. */
export const boxWidth = (text: string, min: number, max: number): number =>
  Math.max(1, Math.min(max, Math.max(min, stringWidth(text) + 2)))

/**
 * A flow run's missing input. Every field draws its value in a box, and a
 * choice draws all of its options with the chosen one filled; the focused text
 * or number field takes the typing.
 */
export function FlowFormView(props: {
  readonly form: FlowForm
  readonly height: number
  readonly width?: number
  readonly compact: boolean
  readonly onField: (name: string, text: string) => void
}) {
  const { form } = props
  if (form.ask !== undefined) return <AskFormView {...props} ask={form.ask} />
  const rows = Math.max(1, props.height - (props.compact ? 1 : 4) - (form.error === undefined ? 0 : 1))
  const start = Math.min(Math.max(0, form.focus - Math.floor(rows / 2)), Math.max(0, form.fields.length - rows))
  const labelWidth = Math.min(16, Math.max(0, ...form.fields.map((field) => stringWidth(field.label))) + 2)
  // The bar, the padding and the label leave this much for a value.
  const valueWidth = Math.max(8, (props.width ?? 80) - 6 - labelWidth)
  return (
    <box
      style={{ border: ["left"], marginTop: props.compact ? 0 : 1, flexShrink: 0 }}
      borderColor={color.brand}
      customBorderChars={View.bar}
    >
      <box
        style={{
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: props.compact ? 0 : 1,
          paddingBottom: props.compact ? 0 : 1
        }}
        backgroundColor={color.element}
      >
        <text fg={color.text} wrapMode="none">
          {form.flow}
          {form.fields.length > rows ? `  ${form.focus + 1}/${form.fields.length}` : ""}
        </text>
        {form.fields.slice(start, start + rows).map((field, offset) => {
          const index = start + offset
          const value = form.draft[field.name]
          const focused = index === form.focus
          const shown = field.kind === "boolean"
            ? (value === true ? "✓" : "✗")
            : value === undefined
            ? ""
            : String(value)
          return (
            <box key={field.name} style={{ flexDirection: "row" }}>
              <text
                fg={focused ? color.brand : color.muted}
                wrapMode="none"
                style={{ width: labelWidth, flexShrink: 0 }}
              >
                {field.label}
              </text>
              {field.kind === "select" && field.options !== undefined
                ? (
                  <text wrapMode="none" style={{ flexShrink: 1 }}>
                    {field.options.map((option, at) => {
                      const chosen = String(value ?? "") === option.value
                      return (
                        <span key={option.value}>
                          {at === 0 ? "" : " "}
                          <span
                            fg={chosen ? color.page : option.disabled === true ? color.faint : color.muted}
                            bg={chosen ? (focused ? color.brand : color.muted) : color.element}
                          >
                            {chosen ? <strong>{` ${option.label} `}</strong> : ` ${option.label} `}
                          </span>
                        </span>
                      )
                    })}
                  </text>
                )
                : focused && (field.kind === "text" || field.kind === "number")
                ? (
                  <input
                    selectionOccupancy="boundary"
                    focused
                    value={shown}
                    textColor={color.text}
                    backgroundColor={color.page}
                    focusedBackgroundColor={color.page}
                    cursorColor={color.brand}
                    // The field being typed takes the row, so a burst of keys stays in view.
                    style={{ flexGrow: 1, paddingLeft: 1 }}
                    onInput={(text: string) => props.onField(field.name, text)}
                  />
                )
                : (
                  <text fg={color.text} bg={color.page} wrapMode="none" style={{ flexShrink: 1 }}>
                    {` ${shown}`.padEnd(boxWidth(shown, 8, valueWidth))}
                  </text>
                )}
            </box>
          )
        })}
        {form.error === undefined ? null : <text fg={color.danger} wrapMode="none">{form.error}</text>}
      </box>
    </box>
  )
}

/** An ask's answer form: the whole question, then one choice per line under a `>` cursor, or the typed answer. */
function AskFormView(props: {
  readonly form: FlowForm
  readonly ask: Dispatch.AskChoices
  readonly height: number
  readonly width?: number
  readonly compact: boolean
  readonly onField: (name: string, text: string) => void
}) {
  const { ask } = props
  const renderer = useRenderer()
  const question = useRef<ScrollBoxRenderable>(null)
  const lines = Dispatch.choices(ask)
  const typing = Dispatch.typed(ask)
  useKeyboard((key) => {
    if (key.name !== "pageup" && key.name !== "pagedown") return
    key.preventDefault()
    question.current?.scrollBy(key.name === "pageup" ? -0.75 : 0.75, "viewport")
  })
  usePaste((event) => {
    if (typing) return
    event.preventDefault()
    flushSync(() =>
      props.onField("answer", `${String(props.form.draft.answer ?? "")}${new TextDecoder().decode(event.bytes)}`)
    )
  })
  const input = (
    <input
      selectionOccupancy="boundary"
      focused
      value={String(props.form.draft.answer ?? "")}
      textColor={color.text}
      backgroundColor={color.surface}
      focusedBackgroundColor={color.surface}
      cursorColor={color.brand}
      style={{ flexGrow: 1 }}
      onInput={(text: string) => props.onField("answer", text)}
    />
  )
  // Reserve the answer rows before bounding the question, including wrapped and explicit newlines.
  const available = Math.max(2, props.height - (props.compact ? 0 : 4))
  const rows = Math.min(Math.max(1, lines.length), available - 1)
  const questionHeight = Math.max(1, available - rows)
  // The renderer's own wrapping and cell widths, wide glyphs and tabs included; the bar and padding take 5 cells.
  const buffer = TextBuffer.create(renderer.widthMethod)
  const view = TextBufferView.create(buffer)
  let questionRows = 1
  try {
    buffer.setText(`◆ ${ask.question}`)
    view.setWrapMode("word")
    questionRows = view.measureForDimensions(Math.max(1, (props.width ?? renderer.width) - 5), props.height)
      ?.lineCount ?? 1
  } finally {
    view.destroy()
    buffer.destroy()
  }
  const start = Math.min(Math.max(0, ask.choice - Math.floor(rows / 2)), Math.max(0, lines.length - rows))
  return (
    <box
      style={{ border: ["left"], marginTop: props.compact ? 0 : 1, flexShrink: 0 }}
      borderColor={color.brand}
      customBorderChars={View.bar}
    >
      <box
        style={{
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: props.compact ? 0 : 1,
          paddingBottom: props.compact ? 0 : 1
        }}
        backgroundColor={color.element}
      >
        <scrollbox
          ref={question}
          scrollX={false}
          style={{
            height: Math.min(questionHeight, questionRows),
            flexShrink: 0,
            scrollbarOptions: { visible: false }
          }}
        >
          <text fg={color.text} wrapMode="word">
            <span fg={color.needs}>{"◆ "}</span>
            {ask.question}
          </text>
        </scrollbox>
        {props.compact ? null : <box style={{ height: 1 }} />}
        {lines.length === 0
          ? (
            <box style={{ flexDirection: "row" }}>
              <text fg={color.brand} wrapMode="none" style={{ flexShrink: 0 }}>{"> "}</text>
              {input}
            </box>
          )
          : lines.slice(start, start + rows).map((line, offset) => {
            const index = start + offset
            const chosen = index === ask.choice
            return (
              <box key={index} style={{ flexDirection: "row" }}>
                <text fg={chosen ? color.brand : color.muted} wrapMode="none" style={{ flexShrink: 0 }}>
                  {chosen ? "> " : "  "}
                </text>
                {chosen && typing
                  ? input
                  : <text fg={chosen ? color.text : color.muted} wrapMode="none">{line}</text>}
              </box>
            )
          })}
      </box>
    </box>
  )
}

/** The composer's completion menu; an argument row marks the current model. */
export function CompletionMenu(props: {
  readonly menu: Complete.Completion
  readonly selected: number
  readonly seat: string
  readonly rows?: number
}) {
  const { menu, seat } = props
  return (
    <box
      style={{ border: ["left"], marginTop: 1, flexShrink: 0 }}
      borderColor={color.element}
      customBorderChars={View.bar}
    >
      <box style={{ paddingTop: 0 }} backgroundColor={color.element}>
        <View.List
          rows={menu.items.map((item, index) => ({
            key: `${index}:${item.label}`,
            label: item.label,
            ...(item.hint === undefined ? {} : { hint: item.hint }),
            ...(item.detail === undefined ? {} : { detail: item.detail }),
            ...(menu.kind === "argument" &&
                item.insert === `/model ${seat}`
              ? { current: true }
              : {})
          }))}
          selected={props.selected}
          height={Math.min(props.rows ?? menuRows, Math.max(1, menu.items.length))}
          background={color.element}
          empty={menu.kind === "command" ? "No matching commands" : "No matches"}
        />
      </box>
    </box>
  )
}

/** A dialog over the screen: a filter input unless it only confirms, then its rows. */
export function PickerDialog(props: {
  readonly title: string
  /** Undefined for a confirm dialog, which has no filter. */
  readonly query: string | undefined
  readonly onQuery: (query: string) => void
  readonly rows: ReadonlyArray<View.Row>
  readonly selected: number
  readonly empty: string
  readonly width: number
  readonly height: number
  /** Keys drawn under the list, as the undo checklist offers them. */
  readonly keys?: ReadonlyArray<Keys.Binding>
}) {
  const { rows, height } = props
  const compact = height < 20
  const visible = compact ? Math.max(1, height - 6) : Math.max(3, Math.floor(height / 2) - 6)
  return (
    <View.Dialog title={props.title} width={props.width} height={height}>
      {props.query === undefined ?
        null :
        (
          <box style={{ paddingLeft: 3, paddingRight: 3, marginBottom: compact ? 0 : 1 }}>
            <input
              selectionOccupancy="boundary"
              focused
              value={props.query}
              placeholder="Search"
              placeholderColor={color.faint}
              textColor={color.text}
              backgroundColor={color.surface}
              focusedBackgroundColor={color.surface}
              cursorColor={color.brand}
              onInput={props.onQuery}
            />
          </box>
        )}
      <box style={{ paddingLeft: 2, paddingRight: 2 }}>
        <View.List
          rows={rows}
          selected={props.selected}
          height={Math.min(rows.length, visible)}
          background={color.surface}
          empty={props.empty}
        />
      </box>
      {props.keys === undefined ? null : (
        <box style={{ paddingLeft: 3, paddingRight: 3, marginTop: compact ? 0 : 1 }}>
          <View.KeyHints bindings={props.keys} />
        </box>
      )}
    </View.Dialog>
  )
}

/** Context only becomes an action hint at 70% of a known window. */
export const meter = (transcript: Transcript.Transcript, window: number) => {
  const percent = window > 0 ? transcript.usage.context / window * 100 : 0
  return { percent, label: percent >= 70 ? `ctx ${Math.round(percent)}%` : "" }
}

/** Session spend includes each restored or live agent exactly once. */
export const sessionUsage = (
  chat: Transcript.Transcript,
  tabs: ReadonlyArray<Pick<Tab, "id">>,
  transcript: (id: string) => Transcript.Transcript
): Pick<Transcript.Usage, "input" | "output" | "cached" | "usd"> => {
  const total = { input: chat.usage.input, output: chat.usage.output, cached: chat.usage.cached, usd: chat.usage.usd }
  for (const id of new Set(tabs.map((tab) => tab.id))) {
    const usage = transcript(id).usage
    total.input += usage.input
    total.output += usage.output
    total.cached += usage.cached
    total.usd += usage.usd
  }
  return total
}

export const usageDetails = (usage: Pick<Transcript.Usage, "input" | "output" | "usd">): string => {
  // Keep sub-cent precision while removing zeroes beyond the cents shown in the mock.
  const dollars = usd(usage.usd).replace(/(\.\d{2}\d*?)0+$/, "$1")
  return `${Editor.tokens(usage.input)} input  ${Editor.tokens(usage.output)} output  ~${dollars} est.`
}

/** Keep the branch and the end of the project name when room runs out. */
export const clipProject = (project: string, width: number): string => {
  if (width <= 0) return ""
  if (stringWidth(project) <= width) return project
  const chars = [...project]
  while (chars.length > 0 && stringWidth(chars.join("")) > width - 1) chars.shift()
  return `…${chars.join("")}`
}

/** Project, hints, contributed actions and a context warning, in one row. */
export function StatusLine(props: {
  readonly lead: string
  readonly width?: number
  readonly hints: ReadonlyArray<Keys.Binding>
  readonly items: ReadonlyArray<Extension.Status>
  readonly onItem: (item: Extension.Status) => void
  readonly meter: ReturnType<typeof meter>
}) {
  const renderer = useRenderer()
  const width = props.width ?? renderer.width
  const right = props.items.reduce((total, item) => total + stringWidth(item.text) + 2, 0) +
    (props.meter.label === "" ? 0 : stringWidth(props.meter.label) + 2)
  const available = Math.max(0, width - right - 1)
  const hints = Keys.fit(props.hints, Math.max(0, available - Math.min(stringWidth(props.lead), 24) - 2), stringWidth)
  const hintsWidth = hints.reduce((total, binding) => total + Keys.hintWidth(binding, stringWidth) + 2, 0)
  const project = clipProject(props.lead, Math.max(0, available - hintsWidth - 2))
  return (
    <box style={{ flexDirection: "row", height: 1, paddingLeft: 1, flexShrink: 0, width }}>
      <text fg={color.faint} wrapMode="none" style={{ flexShrink: 0, marginRight: 2 }}>{project}</text>
      <View.KeyHints bindings={hints} />
      <box style={{ flexGrow: 1 }} />
      <View.StatusItems items={props.items} onSelect={props.onItem} />
      {props.meter.label === "" ?
        null :
        (
          <text
            wrapMode="none"
            fg={props.meter.percent >= 90 ? color.danger : color.warning}
            style={{ flexShrink: 0, marginLeft: 2 }}
          >
            {props.meter.label}
          </text>
        )}
    </box>
  )
}
