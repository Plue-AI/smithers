/** Runtime-authored, serializable UI. Cells construct these values; the host owns rendering and keys. */
import { Schema } from "effect"

const short = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))
const content = Schema.String.check(Schema.isMaxLength(200_000))
export const Block = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: content }),
  Schema.Struct({ kind: Schema.Literal("code"), code: content, language: Schema.optional(short) }),
  Schema.Struct({ kind: Schema.Literal("diff"), patch: content, path: short }),
  Schema.Struct({
    kind: Schema.Literal("table"),
    columns: Schema.Array(short).check(Schema.isMaxLength(12)),
    rows: Schema.Array(Schema.Array(content)).check(Schema.isMaxLength(200))
  })
])
export type Block = typeof Block.Type
const name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
/** What choosing a key, a status item or a row does. Never a shell command. */
export const Action = Schema.Union([
  /** Sends a prompt to the chat coordinator. */
  Schema.Struct({
    kind: Schema.Literal("prompt"),
    prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000))
  }),
  /** Requests a flow run; missing input opens the flow's form. */
  Schema.Struct({
    kind: Schema.Literal("flow"),
    flow: name,
    input: Schema.optional(Schema.Record(Schema.String, Schema.Json))
  }),
  /** Starts a custom agent in a worker tab; without a prompt the composer asks for one. */
  Schema.Struct({
    kind: Schema.Literal("agent"),
    agent: name,
    prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000)))
  }),
  /** Switches to a surface: `chat`, `summary`, `smithers`, `tab:<id>`, `flow:<id>` or `ui:<id>`. */
  Schema.Struct({ kind: Schema.Literal("open"), surface: short })
])
export type Action = typeof Action.Type
export const Row = Schema.Struct({
  id: short,
  label: short,
  status: Schema.optional(
    Schema.Literals(["running", "waiting", "queued", "parked", "done", "failed", "requested", "cancelled"])
  ),
  details: Schema.Array(Block).check(Schema.isMaxLength(40)),
  // A user selects an action; publishing a panel never executes its actions.
  action: Schema.optional(Schema.Union([
    Schema.Struct({ label: short, prompt: content }),
    Schema.Struct({ label: short, action: Action })
  ]))
})
export type Row = typeof Row.Type
export const Panel = Schema.Struct({
  id: short,
  title: short,
  summary: short.check(Schema.isPattern(/^[^\r\n]+$/)),
  placement: Schema.optional(Schema.Literals(["tab", "main"])),
  bind: Schema.optional(Schema.Struct({ tree: short })),
  rows: Schema.Array(Row).check(Schema.isMaxLength(500))
})
export type Panel = typeof Panel.Type
/** Model status without a bound run has no host-owned source to settle it. */
export const unboundStatus = (panel: Panel): boolean =>
  panel.bind === undefined &&
  panel.rows.every((row) => row.status !== undefined && row.details.length === 0 && row.action === undefined)
/** Custom views a session keeps. */
export const limit = 24

/** Adds or refreshes `panel` as the newest view, dropping the oldest past `limit`. */
export const keep = (panels: Map<string, Panel>, panel: Panel): void => {
  panels.delete(panel.id)
  panels.set(panel.id, panel)
  for (const id of panels.keys()) {
    if (panels.size <= limit) break
    panels.delete(id)
  }
}

export const decode = (value: unknown): Panel => {
  const panel = Schema.decodeUnknownSync(Panel)(value)
  if (JSON.stringify(panel).length > 1_000_000) throw new Error("Panel exceeds 1 MB")
  if (new Set(panel.rows.map((row) => row.id)).size !== panel.rows.length) throw new Error("Row ids must be unique")
  return panel
}

export interface Navigation {
  readonly selected: number
  readonly expanded: ReadonlySet<string>
  readonly diff: boolean
  readonly split: boolean
}
export const initial = (): Navigation => ({ selected: 0, expanded: new Set(), diff: false, split: false })
/** Shared by the built-in summary and every agent-authored panel. */
export const navigate = (state: Navigation, key: string, rows: ReadonlyArray<Row>): Navigation => {
  const selected = Math.max(0, Math.min(state.selected, rows.length - 1))
  if (key === "j" || key === "down") return { ...state, selected: Math.max(0, Math.min(rows.length - 1, selected + 1)) }
  if (key === "k" || key === "up") return { ...state, selected: Math.max(0, selected - 1) }
  if (key === "d") return { ...state, diff: !state.diff }
  if (key === "v") return { ...state, split: !state.split }
  const row = rows[selected]
  if (row === undefined) return { ...state, selected: 0 }
  const expanded = new Set(state.expanded)
  if (key === "h" || key === "left") expanded.delete(row.id)
  else if (key === "l" || key === "right") expanded.add(row.id)
  else if (key === "return" || key === "kpenter" || key === "space") {
    if (expanded.has(row.id)) expanded.delete(row.id)
    else expanded.add(row.id)
  }
  return { ...state, selected, expanded }
}
export const teaching =
  `Use ui.publish to build custom terminal UI whenever a view makes the answer easier to inspect: comparisons, plans, choices, or results. Write JavaScript cells that construct a panel and call the flow; do not print UI JSON. Panels have {id,title,summary,rows:[{id,label,status?,details:[blocks],action?}]}. Blocks are {kind:"text",text}, {kind:"code",code,language?}, {kind:"diff",path,patch} or {kind:"table",columns,rows}. A row action is {label,prompt} or {label,action}; an action is {kind:"prompt",prompt}, {kind:"flow",flow,input?}, {kind:"agent",agent,prompt?} or {kind:"open",surface}. A bare panel opens a tab; publish {kind:"panel",placement:"card",panel} for a live card in the chat, {kind:"status",status:{id,text,tone?,action?}} for a footer item (24 characters), or {kind:"key",key:{id,key:"alt+z",label,action}} for a key (ctrl or alt required). Reuse the panel id to update it. Keep summary to one sentence (e.g. "Investigation requested.", never "running" for a requested receipt) and row labels to concise human English. Details hold actual evidence and code. Actions run ONLY when the user chooses them. Publishing never changes keyboard focus. Prefer useful UI to long prose. Never invent actions the user did not request, nor keys or status items. placement:"main" opens a main view with chat beside it, and bind:{tree:rootId} adds live worker rows. The host owns run status; publish only useful results or controls, never status panels.`
