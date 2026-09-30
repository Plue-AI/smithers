import type { ScrollBoxRenderable } from "@opentui/core"
import { type RefObject, useEffect, useRef } from "react"
import type * as Panels from "./panels.ts"
import * as Tabs from "./tabs.ts"
import { color, syntax } from "./theme.ts"
import type * as Transcript from "./transcript.ts"
import { bar } from "./view.tsx"
import * as Workspace from "./workspace.ts"

/** A stopped worker's compact action card; technical details open with Ctrl+O. */
/** `hints: false` where the actions are buttons of their own, as in a worker's tab. */
export function FailureCard(
  { tab, transcript, details, hints = true }: {
    tab: Workspace.Tab
    transcript: Transcript.Transcript
    details: boolean
    hints?: boolean
  }
) {
  const failure = tab.failure
  if (failure === undefined) return null
  const message = tab.message === failure.headline ? undefined : tab.message
  const diagnostics = tab.detail?.includes(message ?? "") && tab.detail !== ""
    ? tab.detail
    : [message, tab.detail].filter((part) => part !== undefined && part !== "").join("\n")
  const fault = Tabs.faultWords(failure.fault)
  return (
    <box style={{ flexShrink: 0, paddingLeft: 1, marginBottom: 1 }}>
      <text fg={color.danger}>{failure.headline}{"  "}·{"  "}{fault}</text>
      <text fg={color.muted}>{Workspace.failureLine(tab, transcript)}</text>
      {hints
        ? (
          <text fg={color.brand}>
            [r] Resume here [m] Switch model{"   "}
            {failure.actions.includes("wait") ? "[w] Wait for reset   " : ""}[ctrl+o] Details
          </text>
        )
        : null}
      {details && diagnostics !== "" ?
        (
          <text fg={color.faint}>
            {diagnostics}
          </text>
        ) :
        null}
    </box>
  )
}

function BlockView({ block, split }: { block: Panels.Block; split: boolean }) {
  switch (block.kind) {
    case "text":
      return <text fg={color.muted}>{block.text}</text>
    case "code":
      return <code content={block.code} filetype={block.language ?? "text"} syntaxStyle={syntax} />
    case "table":
      return (
        <box>
          {[block.columns, ...block.rows].map((row, index) => (
            <text key={index} fg={index === 0 ? color.brand : color.text}>
              {row.map((value, col) =>
                value.replace(/\n/g, " ").slice(0, 28).padEnd(
                  Math.min(
                    30,
                    Math.max(...[block.columns, ...block.rows].map((row) =>
                      (row[col] ?? "").length
                    )) + 2
                  )
                )
              ).join(" ")}
            </text>
          ))}
        </box>
      )
    case "diff":
      return (
        <box style={{ marginBottom: 1 }}>
          <text fg={color.brand}>{block.path}</text>
          <PatchView path={block.path} patch={block.patch} split={split} />
        </box>
      )
  }
}

/** One file's patch with line numbers and syntax colors; a labeled change (binary, large) as its words. */
export function PatchView({ path, patch, split }: { path: string; patch: string; split: boolean }) {
  return patch.includes("@@")
    ? (
      <diff
        diff={patch}
        view={split ? "split" : "unified"}
        filetype={path.split(".").pop() ?? "text"}
        syntaxStyle={syntax}
        showLineNumbers
        fg={color.text}
        lineNumberFg={color.faint}
        lineNumberBg={color.page}
        addedBg={color.addedBg}
        removedBg={color.removedBg}
        contextBg={color.page}
        addedLineNumberBg={color.addedBg}
        removedLineNumberBg={color.removedBg}
        addedSignColor={color.success}
        removedSignColor={color.danger}
      />
    )
    : <text fg={color.muted}>{patch}</text>
}
export function PanelView(
  props: {
    panel: Panels.Panel
    navigation: Panels.Navigation
    height: number
    width: number
    scrollRef?: RefObject<((direction: number) => void) | undefined>
    hideSummary?: boolean
  }
) {
  const scroll = useRef<ScrollBoxRenderable>(null)
  if (props.scrollRef !== undefined) {
    props.scrollRef.current = (direction) => scroll.current?.scrollBy(direction * 0.5, "viewport")
  }
  const { panel, navigation: nav } = props
  const selected = Math.max(0, Math.min(nav.selected, panel.rows.length - 1))
  const row = panel.rows[selected]
  const expanded = row !== undefined && nav.expanded.has(row.id)
  const visible = Math.max(2, Math.min(12, Math.floor(props.height / 3)))
  const first = Math.max(0, Math.min(selected - Math.floor(visible / 2), panel.rows.length - visible))
  const diffs = (row?.details ?? []).filter((block) => block.kind === "diff")
  const blocks = nav.diff ? diffs : expanded ? (row?.details ?? []).filter((block) => block.kind !== "diff") : []
  useEffect(() => {
    scroll.current?.scrollTo(0)
  }, [panel.id, row?.id, expanded, nav.diff])
  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
      {props.hideSummary
        ? null
        : <text fg={color.text} style={{ paddingLeft: 1, marginBottom: 1 }}>{panel.summary}</text>}
      <box style={{ flexShrink: 0 }}>
        {panel.rows.slice(first, first + visible).map((item, index) => (
          <box
            key={item.id}
            backgroundColor={first + index === selected ? color.element : color.page}
            style={{ flexDirection: "row", paddingLeft: 1 }}
          >
            <text fg={item.status === "failed" ? color.danger : first + index === selected ? color.brand : color.faint}>
              {first + index === selected ? "› " : "  "}
              {String(first + index + 1).padStart(2)}{" "}
              {item.id.startsWith("tree:") ? "" : nav.expanded.has(item.id) ? "▾ " : "▸ "}
            </text>
            <text fg={item.status === "failed" ? color.danger : color.text} wrapMode="none" style={{ flexShrink: 1 }}>
              {item.label}
            </text>
          </box>
        ))}
      </box>
      {blocks.length === 0 ?
        (
          <box style={{ flexGrow: 1 }}>
            {nav.diff
              ? <text fg={color.faint} style={{ paddingLeft: 2, marginTop: 1 }}>No recorded changes.</text>
              : null}
          </box>
        ) :
        (
          <scrollbox
            ref={scroll}
            style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, marginTop: 1, border: ["left"], paddingLeft: 1 }}
            borderColor={color.element}
            customBorderChars={bar}
          >
            {blocks.map((block, index) => (
              <BlockView key={index} block={block} split={nav.split && props.width >= 100} />
            ))}
          </scrollbox>
        )}
    </box>
  )
}
