/**
 * The app's own panels below and over the transcript: a flow run's input
 * form, the completion menu, the dialog, and the status line. They draw
 * what they are given; state and keys stay with the app.
 */
import { TextBuffer, TextBufferView } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { usd } from "@smthrs/gateway/Diagnosis"
import { basename } from "node:path"
import type { ReactNode } from "react"
import stringWidth from "string-width"
import type * as Complete from "./complete.ts"
import * as Editor from "./editor.ts"
import type * as Extension from "./extension.ts"
import * as Inbox from "./inbox.ts"
import type { FlowForm } from "./key-dispatch.ts"
import type * as Keys from "./keys.ts"
import type * as Models from "./models.ts"
import * as Tabs from "./tabs.ts"
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
  if (props.worker !== undefined) return <span fg={color.text}>{Tabs.seatName(props.worker, props.models)}</span>
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
  const renderer = useRenderer()
  const question = form.id.startsWith("ask:")
  const available = props.height - (props.compact ? 0 : 3) - (form.error === undefined ? 0 : 1)
  const measure = (title: string) => {
    if (!question) return 1
    // Use the renderer's wrapping and cell widths, including wide glyphs and tabs.
    const buffer = TextBuffer.create(renderer.widthMethod)
    const view = TextBufferView.create(buffer)
    try {
      buffer.setText(title)
      view.setWrapMode("word")
      return Math.max(
        1,
        Math.min(
          available - 1,
          view.measureForDimensions(Math.max(1, (props.width ?? renderer.width) - 5), props.height)?.lineCount ?? 1
        )
      )
    } finally {
      view.destroy()
      buffer.destroy()
    }
  }
  let titleRows = measure(form.flow)
  let rows = Math.max(1, available - titleRows)
  const title = `${form.flow}${form.fields.length > rows ? `  ${form.focus + 1}/${form.fields.length}` : ""}`
  titleRows = measure(title)
  rows = Math.max(1, available - titleRows)
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
        <text fg={color.text} wrapMode={question ? "word" : "none"} style={{ height: titleRows, flexShrink: 0 }}>
          {title}
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

/** The status line's right end: a stale-context warning, token usage and USD, and the context window used. */
export const meter = (transcript: Transcript.Transcript, window: number) => {
  const usage = transcript.usage
  const percent = window > 0 ? (usage.context / window) * 100 : 0
  const { cache } = Inbox.usage(usage, window)
  return {
    percent,
    context: transcript.contextAssessment?.outdated || transcript.contextAssessment?.irrelevant
      ? `context: ${
        [
          transcript.contextAssessment.outdated ? "outdated" : "",
          transcript.contextAssessment.irrelevant ? "irrelevant" : ""
        ].filter(Boolean).join(" + ")
      } · compact?  `
      : "",
    usage: `↑${Editor.tokens(usage.input)} ↓${Editor.tokens(usage.output)}${
      usage.cached === 0 ? "" : ` R${Editor.tokens(usage.cached)}`
    }${usage.usd > 0 ? ` ${usd(usage.usd)}` : ""}`,
    window: `${
      window > 0
        ? `  ${percent.toFixed(1)}%/${Editor.tokens(window)}`
        : ""
    }${cache === undefined ? "" : ` cache ${cache}%`}`
  }
}

/** The line under the composer: where or how long, the key hints, status items and the meter. */
export function StatusLine(props: {
  /** The running turn's clock, or the path, branch and session name. */
  readonly lead: ReactNode
  readonly hints: ReadonlyArray<Keys.Binding>
  readonly items: ReadonlyArray<Extension.Status>
  readonly onItem: (item: Extension.Status) => void
  readonly meter: ReturnType<typeof meter>
}) {
  const { meter } = props
  return (
    <box
      style={{ flexDirection: "row", justifyContent: "space-between", height: 1, paddingLeft: 1, flexShrink: 0 }}
    >
      <box style={{ flexDirection: "row", flexShrink: 1, marginRight: 2 }}>
        {/* The path gives way before the hints do. */}
        <text wrapMode="none" style={{ flexShrink: 100, marginRight: 2 }}>
          {props.lead}
        </text>
        <View.KeyHints bindings={props.hints} />
      </box>
      <box style={{ flexDirection: "row", flexShrink: 0 }}>
        <View.StatusItems items={props.items} onSelect={props.onItem} />
        <text wrapMode="none" style={{ flexShrink: 0 }}>
          {meter.context === "" ? null : <span fg={color.warning}>{meter.context}</span>}
          <span fg={color.faint}>{meter.usage}</span>
          {meter.window === "" ?
            null :
            (
              <span fg={meter.percent > 90 ? color.danger : meter.percent > 70 ? color.warning : color.faint}>
                {meter.window}
              </span>
            )}
        </text>
      </box>
    </box>
  )
}
