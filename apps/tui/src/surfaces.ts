/**
 * Surfaces: the tabs across the top (chat, Summary, workers, trees, flow
 * runs, custom views) and which one shows. Routing is by id: `chat`,
 * `summary`, `tab:<worker>`, `tree:<worker>`, `flow:<run>` and `ui:<panel>`.
 */
import { useEffect, useRef, useState } from "react"
import type { Run } from "./flows.ts"
import * as Panels from "./panels.ts"
import type { Chip } from "./tabs-view.tsx"
import type { Snapshot, Tab } from "./workspace.ts"

/** A tab's name; an agent's tab leads with the agent. */
export const tabTitle = (tab: Tab): string => {
  const title = tab.harness === undefined ? tab.title : tab.description ?? tab.title
  return tab.agent === undefined ? title : `${tab.agent.name}: ${title}`
}

export const flowGlyph = (status: Run["status"]): string =>
  status === "done"
    ? "✓ "
    : status === "failed"
    ? "✗ "
    : status === "cancelled"
    ? "■ "
    : status === "queued"
    ? "… "
    : status === "parked"
    ? "⏸ "
    : "◌ "

/**
 * Every tab in strip order. Built-in plugins' open tabs sit beside Summary;
 * runtime and problem views follow the work tabs.
 */
export const chips = (input: {
  readonly workspace: Snapshot
  readonly runs: ReadonlyArray<Run>
  /** Plugin tabs, shown only while open. */
  readonly plugins: ReadonlyArray<Panels.Panel>
  /** Every other `ui:` view. */
  readonly views: ReadonlyArray<Panels.Panel>
  readonly worker: (tab: Tab) => Chip
  /** A run's estimate, with its leading space, or "". */
  readonly runEta: (run: Run) => string
}): ReadonlyArray<Chip> => {
  const { workspace } = input
  return [
    { id: "chat", label: "Chat" },
    { id: "summary", label: "Summary" },
    ...input.plugins.map((panel) => ({ id: `ui:${panel.id}`, label: panel.title })),
    ...workspace.tabs.map(input.worker),
    ...workspace.tabs.filter((tab) =>
      tab.parent === undefined && workspace.tabs.some((child) => child.parent === tab.id) &&
      !workspace.panels.some((panel) => panel.bind?.tree === tab.id)
    )
      .map((tab) => ({ id: `tree:${tab.id}`, label: `Tree: ${tab.title}` })),
    ...input.runs.map((run) => ({
      id: `flow:${run.id}`,
      label: `${flowGlyph(run.status)}${run.flow}${input.runEta(run)}`
    })),
    ...input.views.map((panel) => ({ id: `ui:${panel.id}`, label: panel.title }))
  ]
}

/** The tab after `current`, or before it when `back`, wrapping around. */
export const step = (strip: ReadonlyArray<Chip>, current: string, back: boolean): string => {
  const index = strip.findIndex((tab) => tab.id === current)
  return strip[(index + (back ? -1 : 1) + strip.length) % strip.length]!.id
}

/**
 * What a surface shows: `base` as its owner published it, and `panel` with a
 * bound tree's rows first. The chat shows no panel.
 */
export const panelFor = (surface: string, sources: {
  readonly summary: () => Panels.Panel
  readonly tab: (id: string) => Panels.Panel
  readonly run: (id: string) => Panels.Panel
  readonly tree: (id: string) => Panels.Panel
  readonly views: ReadonlyArray<Panels.Panel>
}): { readonly base: Panels.Panel | undefined; readonly panel: Panels.Panel | undefined } => {
  const base = surface === "summary"
    ? sources.summary()
    : surface.startsWith("tab:")
    ? sources.tab(surface.slice(4))
    : surface.startsWith("flow:")
    ? sources.run(surface.slice(5))
    : surface.startsWith("tree:")
    ? sources.tree(surface.slice(5))
    : sources.views.find((panel) => `ui:${panel.id}` === surface)
  const panel = base?.bind === undefined ? base : (() => {
    const tree = sources.tree(base.bind.tree)
    return { ...base, rows: [...tree.rows, ...base.rows.map((row) => ({ ...row, id: `${base.id}/${row.id}` }))] }
  })()
  return { base, panel }
}

/** Which owner a surface belongs to, so a `panel` key works only on its owner's own views. */
export const ownerOf = (id: string, sources: {
  readonly run: (id: string) => Run | undefined
  readonly plugins: ReadonlyArray<{ readonly owner: string; readonly panel: Panels.Panel }>
}): string | undefined => {
  if (id.startsWith("flow:")) {
    const run = sources.run(id.slice(5))
    return run === undefined ? undefined : `repo:${run.flow}`
  }
  if (id.startsWith("tab:")) return `runtime:${id.slice(4)}`
  if (!id.startsWith("ui:")) return undefined
  const plugin = sources.plugins.find((each) => `ui:${each.panel.id}` === id)
  if (plugin !== undefined) return plugin.owner
  const slash = id.indexOf("/")
  return slash < 0 ? "runtime:chat" : `runtime:${id.slice(3, slash)}`
}

/** The shown surface, whether its panel has the keys, the panel's row cursor, and the steered worker. */
export const useSurface = () => {
  const [surface, setSurface] = useState("chat")
  const [panelFocus, setPanelFocus] = useState(false)
  const [navigation, setNavigation] = useState(Panels.initial)
  const [steerTarget, setSteerTarget] = useState<string | undefined>()
  // Steering is for its worker's tab: showing any other surface ends it.
  useEffect(() => setSteerTarget((target) => surface === `tab:${target}` ? target : undefined), [surface])
  // Keys in one input burst are handled before the next render: a second Ctrl+] must step from the first one's tab.
  const shown = useRef(surface)
  shown.current = surface
  /** Shows `id`; any surface but the chat takes the keys. */
  const showTab = (id: string) => {
    shown.current = id
    setSurface(id)
    setPanelFocus(id !== "chat")
    setNavigation(Panels.initial())
  }
  /** Shows the tab after (or before) the one the last key showed. */
  const stepTab = (strip: ReadonlyArray<Chip>, back: boolean) => showTab(step(strip, shown.current, back))
  return {
    surface,
    setSurface,
    panelFocus,
    setPanelFocus,
    navigation,
    setNavigation,
    steerTarget,
    setSteerTarget,
    showTab,
    stepTab
  }
}

/** What Ctrl+S does. */
export type SummaryKey =
  /** Show the Summary, remembering `from` for the way back and selecting `select`'s row. */
  | { readonly kind: "summary"; readonly from: string; readonly select?: string }
  | { readonly kind: "show"; readonly surface: string }
  /** A main view keeps chat beside it: switch focus between them. */
  | { readonly kind: "focus" }

/**
 * Ctrl+S opens the Summary from the chat or a worker, tree or flow tab, with that tab's worker or flow
 * run selected, and on the Summary goes back to the tab it came from while that tab exists, else to the
 * chat. A main view or a `ui:` view switches focus instead: a plugin's tab leaves the strip once hidden.
 */
export const summaryKey = (state: {
  readonly surface: string
  /** The shown panel is a main view. */
  readonly main: boolean
  /** The tab Ctrl+S last opened the Summary from. */
  readonly from?: string
  readonly strip: ReadonlyArray<Chip>
}): SummaryKey => {
  if (state.main || state.surface.startsWith("ui:")) return { kind: "focus" }
  if (state.surface === "summary") {
    const back = state.from !== undefined && state.strip.some((chip) => chip.id === state.from) ? state.from : "chat"
    return { kind: "show", surface: back }
  }
  const select = state.surface.startsWith("tab:") || state.surface.startsWith("tree:")
    ? state.surface.slice(state.surface.indexOf(":") + 1)
    : state.surface.startsWith("flow:")
    ? state.surface
    : undefined
  return { kind: "summary", from: state.surface, ...(select === undefined ? {} : { select }) }
}
