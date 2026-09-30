/**
 * What the screen draws, owing nothing to the app's state machine.
 *
 * The look is the Smithers app's (`apps/app`): Night Owl surfaces layered
 * page → panel → element. The user's messages keep the composer's shape. The shapes are opencode's: a left `┃` bar and a filled panel
 * instead of a boxed border, and a selected row filled with the brand color.
 */
import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { clip, diffCounts } from "@smthrs/rpc/SubagentCard"
import type { UserFailure } from "@smthrs/rpc/UserFailure"
import { memo, type ReactNode, type RefObject, useState } from "react"
import stringWidth from "string-width"
import type * as Extension from "./extension.ts"
import * as Failures from "./failures.ts"
import * as Keys from "./keys.ts"
import type * as Panels from "./panels.ts"
import * as Scrubber from "./scrubber.ts"
import type * as Tabs from "./tabs.ts"
import { color, mix, syntax } from "./theme.ts"
import type * as Toasts from "./toasts.ts"
import * as Transcript from "./transcript.ts"
import type { Tab } from "./workspace.ts"

type Cell = Extract<Transcript.Item, { kind: "cell" }>
type ShellItem = Extract<Transcript.Item, { kind: "shell" }>

/** A shell block shows its last lines until expanded (pi's `PREVIEW_LINES`). */
const shellLines = 20
/** An edit's diff shows this many lines until expanded. */
const diffLines = 12
/** A finished cell's code shows this many lines until expanded; a live cell streams all of it. */
const codeLines = 8

export const bar = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: " ",
  vertical: "┃",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: ""
}

export function Home(props: { readonly width: number }) {
  return (
    <box
      style={{
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        paddingBottom: 1
      }}
    >
      <text>
        <span fg={color.brand}>
          <strong>smithers</strong>
        </span>
      </text>
      <text fg={color.faint} wrapMode="none" style={{ marginTop: 1 }}>
        {props.width >= 60
          ? (
            <>
              <span fg={color.muted}>/</span> commands{"  "}<span fg={color.muted}>@</span> files{"  "}
              <span fg={color.muted}>!</span> shell{"  "}<span fg={color.muted}>?</span> keys
            </>
          )
          : props.width >= 32
          ? (
            <>
              <span fg={color.muted}>/</span> commands{"  "}<span fg={color.muted}>@</span> files{"  "}
              <span fg={color.muted}>?</span> keys
            </>
          )
          : (
            <>
              <span fg={color.muted}>?</span> keys
            </>
          )}
      </text>
    </box>
  )
}

/** The context-sensitive footer hint strip. */
/** Footer hints, already fitted whole by `Keys.fit`: the row never clips one. */
export function KeyHints(props: { readonly bindings: ReadonlyArray<Keys.Binding> }) {
  return (
    <text wrapMode="none" style={{ flexShrink: 0 }}>
      {props.bindings.map((binding, index) => (
        <span key={binding.id}>
          {index === 0 ? "" : "  "}
          <span fg={color.text}>{Keys.primaryKey(binding)}</span>
          <span fg={color.faint}>{" "}{binding.label}</span>
        </span>
      ))}
    </text>
  )
}

/** A scrollable which-key panel, the current context's group first. */
export function KeyPopup(props: {
  readonly scrollRef: RefObject<ScrollBoxRenderable | null>
  readonly bindings: ReadonlyArray<Keys.Binding>
  readonly width: number
  readonly height: number
}) {
  return (
    <box
      style={{ position: "absolute", left: 0, bottom: 1, width: "100%", zIndex: 200, alignItems: "center" }}
    >
      <box
        style={{
          width: Math.max(1, props.width - 2),
          maxHeight: Math.max(4, props.height - 2),
          overflow: "hidden",
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 2,
          paddingRight: 2
        }}
        backgroundColor={color.surface}
      >
        <box style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 1 }}>
          <text fg={color.text}>
            <strong>Keys</strong>
          </text>
          <text fg={color.faint}>esc</text>
        </box>
        <scrollbox
          ref={props.scrollRef}
          style={{ height: Math.max(1, props.height - 7), width: "100%" }}
          scrollX={false}
        >
          <KeyColumns bindings={props.bindings} />
        </scrollbox>
        <text fg={color.faint}>pgup/pgdn</text>
      </box>
    </box>
  )
}

/** Key groups side by side, wrapping to the next row when the width runs out. */
function KeyColumns(props: { readonly bindings: ReadonlyArray<Keys.Binding> }) {
  return (
    <box style={{ flexDirection: "row", flexWrap: "wrap" }}>
      {Keys.groups(props.bindings).map(({ group, bindings }) => {
        const keyWidth = Math.max(...bindings.map((binding) => Keys.displayKeys(binding).length)) + 2
        return (
          <box key={group} style={{ marginRight: 3, marginBottom: 1, maxWidth: "100%" }}>
            <text fg={color.muted}>{group}</text>
            {bindings.map((binding) => (
              <text key={binding.id} wrapMode="word">
                <span fg={color.brand}>{Keys.displayKeys(binding).padEnd(keyWidth)}</span>
                <span fg={color.text}>{binding.label}</span>
              </text>
            ))}
          </box>
        )
      })}
    </box>
  )
}

export interface EntryProps {
  readonly item: Transcript.Item
  readonly now: number
  readonly tick: string
  readonly expanded: boolean
  /** A worker lane's color for the message bar; the chat's own messages use the brand. */
  readonly tone?: string
  /** The scrubber's playhead is on this row. */
  readonly selected?: boolean
  /** What the shared fold says about a cell's frame. */
  readonly step?: Scrubber.Step
}

/** Whether a row draws the clock: an unfinished cell or call, or a shell command still running. */
export const ticking = (item: Transcript.Item): boolean =>
  item.kind === "cell"
    ? item.endedAt === undefined || item.calls.some((call) => call.endedAt === undefined)
    : item.kind === "shell"
    ? item.result === undefined
    : false

const sameStep = (a: Scrubber.Step | undefined, b: Scrubber.Step | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.line === b.line && a.notes.length === b.notes.length &&
    a.notes.every((note, index) => note === b.notes[index]))

/**
 * Whether a row can keep its last drawing. Items are immutable, so a settled
 * row redraws only when it, its fold step, or the view changes; the 100 ms
 * clock reaches only rows that draw it.
 */
export const sameEntry = (a: EntryProps, b: EntryProps): boolean =>
  a.item === b.item && a.expanded === b.expanded && a.selected === b.selected && a.tone === b.tone &&
  sameStep(a.step, b.step) && (!ticking(b.item) || (a.now === b.now && a.tick === b.tick))

export const Entry = memo(EntryView, sameEntry)

function EntryView(props: EntryProps) {
  const { item } = props
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} queued={item.queued === true} tone={props.tone ?? color.brand} />
    case "cell":
      return (
        <CellView
          cell={item}
          now={props.now}
          tick={props.tick}
          expanded={props.expanded}
          selected={props.selected === true}
          step={props.step ?? { notes: [] }}
        />
      )
    case "shell":
      return <ShellView item={item} tick={props.tick} expanded={props.expanded} />
    case "answer":
      return (
        <box style={{ marginBottom: 1, paddingLeft: 2, paddingRight: 2 }}>
          <markdown content={item.text} syntaxStyle={syntax} />
        </box>
      )
    case "error":
      return (
        <box
          style={{ border: ["left"], paddingLeft: 1, marginBottom: 1 }}
          borderColor={item.stopped === true ? color.faint : color.danger}
          customBorderChars={bar}
        >
          {item.stopped === true
            ? <text fg={color.faint}>■ stopped</text>
            : <text fg={color.danger}>✗ {item.background === true ? "" : "failed: "}{item.text}</text>}
        </box>
      )
    case "note":
      return item.text === ""
        ? null
        : <text fg={color.faint} style={{ paddingLeft: 2, marginBottom: 1 }}>{item.text}</text>
    case "card":
      return <Card panel={item.panel} />
  }
}

type RowStatus = Panels.Row["status"]
const rowGlyph = (status: RowStatus): { readonly glyph: string; readonly tone: string } =>
  status === "done"
    ? { glyph: "✓", tone: color.success }
    : status === "running"
    ? { glyph: "◌", tone: color.info }
    : status === "requested"
    ? { glyph: "◌", tone: color.faint }
    : status === "failed"
    ? { glyph: "✗", tone: color.danger }
    : status === "cancelled"
    ? { glyph: "■", tone: color.faint }
    : { glyph: "·", tone: color.faint }
/** Rows a card shows; the rest are in its `ui:<id>` view. */
const cardRows = 5
const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - stringWidth(text)))

/**
 * A panel placed in the transcript: title, summary and its first rows, updated in place. Click, or `enter` while focused, opens its view.
 * A flow run's card leads with its status glyph: `✓ sum · 40ms → 5`.
 */
export function Card(
  props: {
    readonly panel: Panels.Panel
    readonly status?: RowStatus
    readonly focused?: boolean
    readonly onOpen?: () => void
  }
) {
  const { panel } = props
  const shown = panel.rows.slice(0, cardRows)
  const failed = props.status === "failed" || panel.rows.some((row) => row.status === "failed")
  const head = props.status === undefined ? undefined : rowGlyph(props.status)
  return (
    <box
      style={{ border: ["left"], paddingLeft: 1, marginBottom: 1 }}
      borderColor={props.focused === true ? color.text : failed ? color.danger : color.brand}
      {...(props.focused === true ? { backgroundColor: color.selected } : {})}
      customBorderChars={bar}
      {...(props.onOpen === undefined ? {} : { onMouseDown: props.onOpen })}
    >
      <text>
        {head === undefined ? null : <span fg={head.tone}>{head.glyph}{" "}</span>}
        <span fg={color.text}>
          <strong>{panel.title}</strong>
        </span>
        <span fg={color.muted}>{" · "}{panel.summary}</span>
      </text>
      {shown.length === 0 ? null : (
        <text>
          {shown.map((row, index) => {
            const { glyph, tone } = rowGlyph(row.status)
            return (
              <span key={row.id}>
                {index === 0 ? "" : "   "}
                <span fg={tone}>{glyph}{" "}</span>
                <span fg={row.status === "failed" ? color.danger : color.text}>{clip(row.label, 32)}</span>
              </span>
            )
          })}
          {panel.rows.length > cardRows ? <span fg={color.faint}>{`   +${panel.rows.length - cardRows}`}</span> : null}
        </text>
      )}
    </box>
  )
}

const statusTone = (tone: Extension.Status["tone"]): string =>
  tone === undefined ? color.muted : tone === "info" ? color.info : color[tone]

/** Contributed footer items; clicking one runs its action. */
export function StatusItems(props: {
  readonly items: ReadonlyArray<Extension.Status>
  readonly onSelect: (item: Extension.Status) => void
}) {
  return (
    <box style={{ flexDirection: "row", flexShrink: 0 }}>
      {props.items.map((item) => (
        <text
          key={item.id}
          wrapMode="none"
          fg={statusTone(item.tone)}
          style={{ marginRight: 2 }}
          onMouseDown={() => props.onSelect(item)}
        >
          {item.text}
        </text>
      ))}
    </box>
  )
}

/** The user's message keeps the composer's shape: a left bar on a filled panel. */
function UserMessage(props: { readonly text: string; readonly queued: boolean; readonly tone: string }) {
  return (
    <box
      style={{ border: ["left"], marginTop: 1, marginBottom: 1 }}
      borderColor={props.queued ? color.faint : props.tone}
      customBorderChars={bar}
    >
      <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }} backgroundColor={color.surface}>
        <text fg={props.queued ? color.muted : color.text}>{props.text}</text>
        {props.queued ? <text fg={color.faint} style={{ marginTop: 1 }}>steering</text> : null}
      </box>
    </box>
  )
}

/** Read at render time: a theme change repaints writing cells in the new accent. */
export const statusColor = (status: Transcript.CellStatus): string =>
  ({
    writing: color.brand,
    running: color.info,
    done: color.faint,
    failed: color.danger,
    rejected: color.warning,
    stopped: color.faint
  })[status]

function ShellView(props: { readonly item: ShellItem; readonly tick: string; readonly expanded: boolean }) {
  const { item } = props
  const lines = item.output.replace(/\n+$/, "").split("\n")
  const hidden = props.expanded ? 0 : Math.max(0, lines.length - shellLines)
  const shown = lines.slice(hidden).join("\n")
  const result = item.result
  return (
    <box
      style={{ border: ["left"], marginBottom: 1 }}
      borderColor={item.excluded ? color.faint : color.success}
      customBorderChars={bar}
    >
      <box style={{ paddingLeft: 1, paddingRight: 1 }} backgroundColor={color.surface}>
        <text fg={color.success}>$ {item.command.split("\n")[0]}</text>
        {hidden > 0 ? <text fg={color.faint}>… {hidden} more lines (ctrl+o to expand)</text> : null}
        {shown === "" ? null : <text fg={color.muted}>{shown}</text>}
        {result === undefined ? <text fg={color.info}>{props.tick} Running… (esc to cancel)</text> : null}
        {result?.cancelled === true ? <text fg={color.warning}>(cancelled)</text> : null}
        {result !== undefined && !result.cancelled && result.exitCode !== 0
          ? <text fg={color.warning}>(exit {result.exitCode ?? "?"})</text>
          : null}
        {result?.fullOutputPath === undefined
          ? null
          : <text fg={color.faint}>Full output: {result.fullOutputPath}</text>}
      </box>
    </box>
  )
}

/** A step with no call or prose to name it reads as its first line of code. */
const firstLine = (source: string): string => source.split("\n").find((line) => line.trim() !== "")?.trim() ?? "cell"

const noteTone = (tone: "warn" | "bad" | "good"): string =>
  tone === "good" ? color.success : tone === "bad" ? color.danger : color.warning

/** Failures stay visible; expanded steps carry the diagnostic body and evidence. */
function Callout(props: { readonly note: Scrubber.Step["notes"][number]; readonly expanded: boolean }) {
  const { note } = props
  const tone = noteTone(note.tone)
  return (
    <box style={{ border: ["left"], marginTop: 1 }} borderColor={tone} customBorderChars={bar}>
      <box style={{ paddingLeft: 1, paddingRight: 1 }} backgroundColor={mix(tone, 10, color.page)}>
        <text fg={tone}>
          <strong>{note.tone === "good" ? "✓" : "△"} {note.title}</strong>
        </text>
        {!props.expanded || note.body === "" ? null : <text fg={color.text}>{note.body}</text>}
        {props.expanded
          ? note.evidence?.map((line, index) => <text key={index} fg={color.muted} wrapMode="char">{line}</text>)
          : null}
      </box>
    </box>
  )
}

function CellView(props: {
  readonly cell: Cell
  readonly now: number
  readonly tick: string
  readonly expanded: boolean
  readonly selected: boolean
  readonly step: Scrubber.Step
}) {
  const { cell, step } = props
  const [folded, setFolded] = useState(false)
  const live = cell.status === "writing" || cell.status === "running"
  const elapsed = (cell.endedAt ?? props.now) - cell.startedAt
  // A live cell streams its whole code. Once it ends, the call rows below say
  // what it did, so the code and what it printed fold until ctrl+o.
  const lines = cell.source.split("\n")
  const hiddenCode = live || props.expanded || lines.length <= codeLines + 1 ? 0 : lines.length - codeLines
  const code = hiddenCode === 0 ? cell.source : lines.slice(0, codeLines).join("\n")
  const printed = cell.printed.trimEnd()
  const printedRows = printed === "" ? 0 : printed.split("\n").length
  const tone = props.selected ? color.brand : statusColor(cell.status)
  const line = step.line
  const open = live || !folded
  const mark = live ? props.tick : open ? "▾" : "▸"
  const result = line === undefined ? "" : Scrubber.outcome(line)
  const notes = step.notes.filter((note) => props.expanded || (note.tone !== "good" && note.title !== "unmoved"))
  // By default a cell is what it did: its agent rows. Ctrl+O, or selecting it, shows the program.
  if (!props.expanded && !props.selected) {
    const rows = cell.calls.filter((call) => !plumbing(call.flow))
    if (cell.status === "rejected" || (rows.length === 0 && cell.error === undefined && notes.length === 0 && !live)) {
      return null
    }
    return (
      <box style={{ paddingLeft: 1, marginBottom: 1 }}>
        {live && rows.length === 0 ? <text fg={color.faint}>{props.tick} working</text> : null}
        {rows.map((call, index) => (
          <CallView key={index} call={call} now={props.now} tick={props.tick} expanded={false} timed={false} />
        ))}
        {cell.error === undefined
          ? null
          : (
            <FailureLine
              failure={Failures.cellFailure("failed", cell.error)}
              tone={color.danger}
              expanded={false}
            />
          )}
        {notes.map((note) => <Callout key={note.seq} note={note} expanded={false} />)}
      </box>
    )
  }
  return (
    <box style={{ border: ["left"], paddingLeft: 1, marginBottom: 1 }} borderColor={tone} customBorderChars={bar}>
      <box
        style={{ flexDirection: "row", justifyContent: "space-between" }}
        {...(props.selected ? { backgroundColor: color.selected } : {})}
        onMouseDown={() => setFolded(!folded)}
      >
        <text style={{ flexShrink: 1 }} wrapMode="none">
          <span fg={live ? tone : color.faint}>{mark}{" "}</span>
          <span fg={props.selected ? color.brand : color.faint}>{String(cell.index).padStart(2)}{"  "}</span>
          {line !== undefined
            ? (
              <>
                <span fg={line.failed ? color.danger : color.text}>{line.verb}{" "}</span>
                <span fg={color.muted}>{line.subject}</span>
              </>
            )
            : cell.prose !== ""
            ? <span fg={color.text}>{cell.prose.split("\n")[0]}</span>
            : cell.status === "writing"
            ? <span fg={color.muted}>writing</span>
            : <span fg={color.muted}>{firstLine(cell.source)}</span>}
        </text>
        {/* The leading space keeps clipped text off the clock. */}
        <text style={{ flexShrink: 0 }} wrapMode="none">
          {" "}
          {result === ""
            ? null
            : (
              <span fg={line?.failed === true ? color.danger : color.muted}>
                {result.split("\n")[0]!.slice(0, 24)}
                {"  "}
              </span>
            )}
          <span fg={color.faint}>{Transcript.duration(elapsed)}</span>
        </text>
      </box>
      {!open ? null : line !== undefined && cell.prose !== ""
        ? (
          <text fg={color.muted} style={{ paddingLeft: 2 }}>
            <em>“{cell.prose}”</em>
          </text>
        )
        : cell.prose.includes("\n")
        ? <text fg={color.muted}>{cell.prose.split("\n").slice(1).join("\n")}</text>
        : null}
      {!open || code === "" ?
        null :
        (
          <box style={{ paddingLeft: 1, paddingRight: 1, marginTop: 1 }} backgroundColor={color.page}>
            <code content={code} filetype="javascript" syntaxStyle={syntax} streaming={cell.status === "writing"} />
            {hiddenCode === 0 ? null : <text fg={color.faint}>… {hiddenCode} more lines</text>}
          </box>
        )}
      {!open || cell.calls.length === 0 ? null : (
        <box>
          {cell.calls.map((call, index) => (
            <CallView key={index} call={call} now={props.now} tick={props.tick} expanded={props.expanded} />
          ))}
        </box>
      )}
      {!open || printed === "" ? null : props.expanded
        ? (
          <box style={{ marginTop: 1, paddingLeft: 1, paddingRight: 1 }} backgroundColor={color.surface}>
            <text fg={color.muted}>{printed}</text>
          </box>
        )
        : <text fg={color.faint}>printed {printedRows} {printedRows === 1 ? "line" : "lines"} · ctrl+o</text>}
      {cell.error === undefined
        ? null
        : (
          <FailureLine
            failure={Failures.cellFailure(cell.status === "rejected" ? "rejected" : "failed", cell.error)}
            tone={cell.status === "rejected" ? color.warning : color.danger}
            expanded={props.expanded}
          />
        )}
      {notes.map((note) => <Callout key={note.seq} note={note} expanded={props.expanded} />)}
    </box>
  )
}

/** A failure's sentence; its raw text shows only while Ctrl+O expands the transcript. */
function FailureLine(
  props: { readonly failure: UserFailure; readonly tone: string; readonly expanded: boolean; readonly indent?: boolean }
) {
  const { failure } = props
  const lead = props.indent === true ? "  " : ""
  const hidden = failure.fault !== "user" && failure.detail !== ""
  return (
    <box>
      <text fg={props.tone}>
        {lead}
        {failure.sentence}
        {hidden && !props.expanded ? <span fg={color.faint}>{" "}· ctrl+o</span> : null}
      </text>
      {hidden && props.expanded ? <text fg={color.faint}>{lead}{failure.detail}</text> : null}
    </box>
  )
}

const icons: Record<string, string> = {
  bash: "$",
  read: "→",
  ls: "✱",
  find: "✱",
  grep: "✱",
  glob: "✱",
  edit: "←",
  write: "←"
}

/** Calls that run the program rather than the work; they show only with Ctrl+O. */
export const plumbing = (flow: string): boolean =>
  ["agent.delegate", "ui.publish", "tab.read", "tab.list", "smithers.run"].includes(flow) ||
  flow.startsWith("monitor.")

/**
 * What a settled call's glyph says: a stopped call's `■`, a command's exit
 * status (`✓` only for exit 0), a failed call's `✗`, a change's `✓`, else the
 * flow's own icon.
 */
export const callMark = (
  call: Transcript.Call
): { readonly glyph: string; readonly tone: "success" | "danger" | "muted" | "faint" } =>
  call.status === "stopped"
    ? { glyph: "■", tone: "faint" }
    : call.status === "failed" || (call.exit !== undefined && call.exit !== 0)
    ? { glyph: "✗", tone: "danger" }
    : call.exit !== undefined || call.change !== undefined || (call.patches?.length ?? 0) > 0
    ? { glyph: "✓", tone: "success" }
    : { glyph: icons[call.flow] ?? "⚙", tone: "muted" }

/** A change's line counts, `+1 −1`, from its receipts or its own edit. */
const changeCounts = (call: Transcript.Call): { readonly added: number; readonly removed: number } | undefined => {
  const diffs = (call.patches ?? []).map((each) => each.patch)
  const all = diffs.length > 0 ? diffs : call.change === undefined ? [] : [Transcript.unified(call.change)]
  if (all.length === 0) return undefined
  return all.map(diffCounts).reduce((sum, each) => ({
    added: sum.added + each.added,
    removed: sum.removed + each.removed
  }))
}

function CallView(
  props: {
    readonly call: Transcript.Call
    readonly now: number
    readonly tick: string
    readonly expanded: boolean
    /** Draws the call's duration; the default view leaves it out. */
    readonly timed?: boolean
  }
) {
  const { call } = props
  const mark = callMark(call)
  // A command reads as itself and its exit status; the verb adds nothing.
  const command = call.exit !== undefined
  const verb = call.verb === undefined
    ? call.flow
    : call.status === "running" || call.status === "stopped"
    ? call.verb.pending
    : call.status === "ok"
    ? call.verb.success
    : call.verb.failure
  const subject = call.subject.split("\n")[0]!
  const diff = call.change === undefined || call.status === "failed" || call.status === "stopped"
    ? undefined
    : Transcript.unified(call.change)
  const diffRows = diff === undefined ? 0 : diff.split("\n").length - 3
  const counts = call.status === "ok" && !command ? changeCounts(call) : undefined
  return (
    <box>
      <box style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <text style={{ flexShrink: 1 }} wrapMode="none">
          <span fg={call.status === "running" ? color.info : color[mark.tone]}>
            {call.status === "running" ? props.tick : mark.glyph}
            {" "}
          </span>
          {command ? null : <span fg={call.status === "failed" ? color.danger : color.text}>{verb}{" "}</span>}
          <span fg={color.muted}>{subject}</span>
          {command
            ? <span fg={call.exit === 0 ? color.faint : color.danger}>{"  "}exit {call.exit}</span>
            : null}
          {counts === undefined ? null : (
            <>
              {"  "}
              {counts.added > 0 ? <span fg={color.success}>+{counts.added}</span> : null}
              {counts.added > 0 && counts.removed > 0 ? " " : null}
              {counts.removed > 0 ? <span fg={color.danger}>−{counts.removed}</span> : null}
            </>
          )}
        </text>
        {props.timed === false ? null : (
          <text fg={color.faint} style={{ flexShrink: 0 }}>
            {" "}
            {Transcript.duration((call.endedAt ?? props.now) - call.startedAt)}
          </text>
        )}
      </box>
      {call.message === undefined
        ? null
        : (
          <FailureLine
            failure={Failures.callFailure({ ...call, message: call.message })}
            tone={color.danger}
            expanded={props.expanded}
            indent
          />
        )}
      {diff === undefined ? null : (
        <box style={{ marginTop: 1, marginBottom: 1, marginLeft: 2 }}>
          <diff
            diff={props.expanded || diffRows <= diffLines ? diff : diff.split("\n").slice(0, diffLines + 3).join("\n")}
            view="unified"
            filetype={call.change!.path.split(".").pop() ?? "text"}
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
          {!props.expanded && diffRows > diffLines
            ? <text fg={color.faint}>… {diffRows - diffLines} more lines</text>
            : null}
        </box>
      )}
    </box>
  )
}

export interface Row {
  readonly key: string
  readonly label: string
  readonly hint?: string
  readonly detail?: string
  /** Marks the current model or session. */
  readonly current?: boolean
}

/**
 * A list with one selected row, windowed around the selection, as the
 * completion menu and every dialog draw it.
 */
export function List(props: {
  readonly rows: ReadonlyArray<Row>
  readonly selected: number
  readonly height: number
  readonly background: string
  readonly empty: string
}) {
  const { rows, height } = props
  if (rows.length === 0) return <text fg={color.faint} style={{ paddingLeft: 1 }}>{props.empty}</text>
  const first = Math.max(0, Math.min(props.selected - Math.floor(height / 2), rows.length - height))
  const shown = rows.slice(first, first + height)
  const labelWidth = Math.min(40, Math.max(...shown.map((row) => stringWidth(row.label))) + 2)
  const columns = shown.some((row) => row.hint !== undefined || row.detail !== undefined)
  const hintWidth = Math.max(0, ...shown.map((row) => (row.hint === undefined ? 0 : stringWidth(row.hint) + 2)))
  return (
    <box>
      {shown.map((row, offset) => {
        const selected = first + offset === props.selected
        const fg = selected ? color.page : color.text
        const label = columns ? pad(clip(row.label, labelWidth - 2), labelWidth) : row.label
        return (
          <box
            key={row.key}
            style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, height: 1 }}
            backgroundColor={selected ? color.brand : props.background}
          >
            <text fg={fg} wrapMode="none" style={{ flexShrink: 1 }}>
              <span fg={selected ? color.page : color.brand}>{row.current === true ? "● " : "  "}</span>
              {selected ? <strong>{label}</strong> : label}
              <span fg={selected ? color.page : color.muted}>{pad(row.hint ?? "", hintWidth)}</span>
              <span fg={selected ? color.page : color.faint}>{row.detail ?? ""}</span>
            </text>
          </box>
        )
      })}
      {rows.length > height
        ? (
          <box style={{ paddingLeft: 3 }}>
            <text fg={color.faint}>{props.selected + 1}/{rows.length}</text>
          </box>
        )
        : null}
    </box>
  )
}

const backdrop = RGBA.fromInts(1, 22, 39, 170)

/** A centered panel over a dimmed screen; the app routes keys to it while it is open. */
export function Dialog(props: {
  readonly title: string
  readonly width: number
  readonly height: number
  readonly children: ReactNode
}) {
  const compact = props.height < 20
  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        alignItems: "center",
        paddingTop: compact ? 1 : Math.max(1, Math.floor(props.height / 5)),
        zIndex: 100
      }}
      backgroundColor={backdrop}
    >
      <box
        style={{ width: props.width, paddingTop: compact ? 0 : 1, paddingBottom: compact ? 0 : 1 }}
        backgroundColor={color.surface}
      >
        <box
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            paddingLeft: 3,
            paddingRight: 3,
            marginBottom: compact ? 0 : 1
          }}
        >
          <text fg={color.text} wrapMode="none" style={{ flexShrink: 1 }}>
            <strong>{props.title}</strong>
          </text>
          <text fg={color.faint} style={{ flexShrink: 0 }}>esc</text>
        </box>
        {props.children}
      </box>
    </box>
  )
}

/** The oldest waiting approval, pinned above the composer. */
export function Approval(
  props: {
    readonly request: {
      readonly flow: string
      readonly subject: string
      readonly always: boolean
    }
    /** What `a` grants, from `Approvals.scope`. */
    readonly width: number
    readonly scope: string
    /** False while the focused panel owns `a`. */
    readonly all?: boolean
    /** Keys show exactly when they answer; see `Approvals.ready`. */
    readonly armed: boolean
    readonly more: number
    readonly worker?: string
  }
) {
  return (
    <box
      style={{
        flexDirection: props.width < 90 ? "column" : "row",
        justifyContent: "space-between",
        marginTop: 1,
        paddingLeft: 2,
        flexShrink: 0
      }}
    >
      {/* Wrapped, never clipped: `y` approves exactly the text shown. */}
      <text wrapMode="char" style={{ flexShrink: 1 }} fg={color.warning}>
        {props.worker === undefined ? "" : `↳ ${props.worker} `}? {props.request.flow}{" "}
        {props.request.subject.replace(/\s+/g, " ")}
        {props.more > 0 ? ` +${props.more}` : ""}
      </text>
      {props.armed
        ? (
          <text wrapMode="word" style={{ flexShrink: 0, marginLeft: props.width < 90 ? 0 : 2 }}>
            <span fg={color.text}>y</span>
            <span fg={color.faint}>{" allow  "}</span>
            <span fg={color.text}>n</span>
            <span fg={color.faint}>{" deny"}</span>
            {props.request.always && props.all !== false ? <span fg={color.text}>{"  a"}</span> : null}
            {props.request.always && props.all !== false ? <span fg={color.faint}>{` ${props.scope}`}</span> : null}
          </text>
        )
        : null}
    </box>
  )
}

/**
 * Toasts stack right-aligned above the composer, like the app's toast stack,
 * and never cover content. A worker's toast carries its card's Stop and Steer.
 */
export function ToastStack(
  props: {
    readonly rows: ReadonlyArray<Toasts.Row>
    readonly height: number
    readonly compact: boolean
    readonly onAction?: (tab: Tab, action: Tabs.ActionId) => void
  }
) {
  if (props.rows.length === 0) return null
  return (
    <scrollbox
      stickyScroll
      stickyStart="bottom"
      scrollX={false}
      style={{
        height: Math.min(props.height, props.rows.length * (props.compact ? 1 : 2)),
        flexShrink: 0,
        scrollbarOptions: { visible: false },
        contentOptions: { alignItems: "flex-end" }
      }}
    >
      {props.rows.map((row) => (
        <box
          key={row.id}
          style={{ border: ["left"], marginTop: props.compact ? 0 : 1, maxWidth: 60, flexShrink: 0 }}
          borderColor={row.tone === "info" ? color.brand : color[row.tone]}
          customBorderChars={bar}
        >
          <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 2 }} backgroundColor={color.element}>
            <text fg={color.text}>{row.text}</text>
            {row.worker?.actions.map((action) => (
              <text
                key={action.id}
                wrapMode="none"
                fg={action.id === "stop" ? color.danger : color.info}
                style={{ marginLeft: 2, flexShrink: 0 }}
                onMouseDown={() => props.onAction?.(row.worker!.tab, action.id)}
              >
                {action.label}
              </text>
            ))}
          </box>
        </box>
      ))}
    </scrollbox>
  )
}

/** `2m ago`, `3h ago`, `Sep 4`. */
export const ago = (at: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
