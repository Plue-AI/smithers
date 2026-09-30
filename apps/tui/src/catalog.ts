/**
 * The `/flows` catalog: every flow and agent the directory declares, what it
 * takes, and how its last run went. The same entries head the home screen.
 * Listing never imports a module; input names appear once the host has.
 */
import * as Extension from "./extension.ts"
import type * as Flows from "./flows.ts"
import type * as Lifecycle from "./lifecycle.ts"
import { flowGlyph } from "./surfaces.ts"

export interface Last {
  readonly status: "done" | "failed" | "cancelled" | "running"
  readonly at: number
}

export interface Entry {
  readonly name: string
  readonly description: string
  /** Input names (`a, b, unit`) then keys (`alt+r`); `Restart to load` for a flow added after launch. */
  readonly hint: string
  /** Its declared keys, as the footer spells them. */
  readonly keys: ReadonlyArray<string>
  readonly unloaded: boolean
  readonly last?: Last
}

/** A run, a worker tab or a store row, as one status the catalog shows. */
const shown = (status: string): Last["status"] =>
  status === "done" || status === "completed"
    ? "done"
    : status === "failed"
    ? "failed"
    : status === "cancelled"
    ? "cancelled"
    : "running"

export const entries = (input: {
  readonly flows: ReadonlyArray<Flows.Listed>
  /** Input names once the module is imported; undefined before. */
  readonly fields: (name: string) => ReadonlyArray<string> | undefined
  readonly unloaded: (name: string) => boolean
  readonly keys: (name: string) => ReadonlyArray<string>
  /** This conversation's runs and agent tabs, and the store's runs, newest wins. */
  readonly runs: ReadonlyArray<Flows.Run>
  readonly tabs: ReadonlyArray<
    {
      readonly agent?: { readonly name: string }
      readonly status: Lifecycle.Status
      readonly startedAt: number
      readonly endedAt?: number
    }
  >
  readonly recorded: ReadonlyArray<Flows.Recorded>
}): ReadonlyArray<Entry> => {
  const last = new Map<string, Last>()
  const note = (name: string, status: string, at: number | undefined) => {
    if (at === undefined) return
    const before = last.get(name)
    if (before === undefined || at > before.at) last.set(name, { status: shown(status), at })
  }
  for (const run of input.recorded) note(run.flow, run.status, run.at)
  for (const run of input.runs) note(run.flow, run.status, run.endedAt ?? run.startedAt)
  for (const tab of input.tabs) {
    if (tab.agent !== undefined) note(tab.agent.name, tab.status, tab.endedAt ?? tab.startedAt)
  }
  return input.flows.map((flow) => {
    const unloaded = input.unloaded(flow.name)
    const keys = input.keys(flow.name)
    const fields = Extension.isAgent(flow) ? [] : input.fields(flow.name) ?? []
    const previous = last.get(flow.name)
    return {
      name: flow.name,
      description: flow.description,
      hint: unloaded ? "Restart to load" : [fields.join(", "), keys.join(" ")].filter((part) => part !== "").join("  "),
      keys,
      unloaded,
      ...(unloaded || previous === undefined ? {} : { last: previous })
    }
  })
}

/** A last run's mark: `✓`, `✗`, `■` or `◌`. */
export const mark = (last: Last): string => flowGlyph(last.status).trim()
