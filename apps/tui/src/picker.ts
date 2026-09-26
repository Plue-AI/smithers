/**
 * The dialogs: the Ctrl+K palette and every picker. What each lists, its
 * title and empty line, and the palette's background `text:` and `session:`
 * reads. The dialog itself draws in `app-view.tsx`; picking stays in the app.
 */
import { useEffect, useRef, useState } from "react"
import * as Editor from "./editor.ts"
import * as Extension from "./extension.ts"
import type { Listed } from "./flows.ts"
import * as Fuzzy from "./fuzzy.ts"
import * as Models from "./models.ts"
import * as Palette from "./palette.ts"
import * as Search from "./search.ts"
import * as Session from "./session.ts"
import { activeTheme, themes } from "./theme.ts"
import * as Timeline from "./timeline.ts"
import type * as Undo from "./undo.ts"
import * as View from "./view.tsx"
import type { Tab } from "./workspace.ts"

export type Picker =
  | { readonly kind: "model"; readonly query: string; readonly selected: number }
  | { readonly kind: "worker-model"; readonly id: string; readonly query: string; readonly selected: number }
  | { readonly kind: "theme"; readonly query: string; readonly selected: number }
  | { readonly kind: "flows"; readonly query: string; readonly selected: number }
  | { readonly kind: "agents"; readonly query: string; readonly selected: number }
  | { readonly kind: "filter"; readonly query: string; readonly selected: number }
  | {
    readonly kind: "resume"
    readonly query: string
    readonly selected: number
    readonly sessions: ReadonlyArray<Session.Summary>
  }
  | {
    readonly kind: "palette"
    readonly query: string
    readonly selected: number
    /** Read on the first `session:`; undefined until then. */
    readonly sessions?: ReadonlyArray<Session.Summary>
  }
  | {
    readonly kind: "fork"
    readonly query: string
    readonly selected: number
    readonly turns: ReadonlyArray<Session.Turn>
  }
  | {
    readonly kind: "undo"
    readonly query: ""
    readonly selected: number
    readonly target: Undo.Target
    readonly tab?: string
  }

/** A `text:` search in the palette, from launch through its real settlement. */
export interface TextSearch {
  readonly query: string
  readonly startedAt: number
  readonly status: "running" | "done"
  readonly hits: ReadonlyArray<Search.Hit>
  /** rg stopped at `Search.limit`. */
  readonly truncated: boolean
}

/** A dialog's rows and the value each one picks. */
export const rows = (
  picker: Picker,
  models: ReadonlyArray<Models.Model>,
  seat: string,
  filter: Timeline.Filter,
  tabs: ReadonlyArray<Tab>,
  files: () => ReadonlyArray<string>,
  hits: ReadonlyArray<Search.Hit>,
  flows: ReadonlyArray<Listed>,
  actions: NonNullable<Palette.Sources["actions"]> = []
): ReadonlyArray<View.Row & { readonly value: string }> => {
  if (picker.kind === "agents") {
    return Fuzzy.filter(flows.filter(Extension.isAgent), picker.query, (agent) => agent.name).map((agent) => {
      const declared = agent.seat === undefined ? undefined : Models.seatOf(agent.seat, models)
      return {
        key: agent.name,
        label: agent.name,
        hint: declared === undefined ? agent.seat ?? "" : Models.labelOf(declared, models),
        detail: agent.description,
        value: agent.name
      }
    })
  }
  if (picker.kind === "flows") {
    return Fuzzy.filter(flows, picker.query, (flow) => flow.name).map((flow) => ({
      key: flow.name,
      label: flow.name,
      detail: flow.description,
      value: flow.name
    }))
  }
  if (picker.kind === "palette") {
    const sources = {
      commands: Editor.commands,
      files,
      sessions: picker.sessions,
      tabs,
      hits,
      now: Date.now(),
      actions
    }
    // The value is the JSON of a `Palette.Value`, so every dialog picks a string.
    return Palette.rows(Palette.parse(picker.query), sources).map((row) => ({
      ...row,
      value: JSON.stringify(row.value)
    }))
  }
  if (picker.kind === "filter") {
    const rows = [
      {
        key: "source:chat",
        label: "Chat",
        current: !filter.sources.includes(Timeline.chat),
        value: `source:${Timeline.chat}`
      },
      ...tabs.map((tab) => ({
        key: `source:${tab.id}`,
        label: `↳ ${tab.title}`,
        hint: tab.status,
        current: !filter.sources.includes(tab.id),
        value: `source:${tab.id}`
      })),
      ...Timeline.kinds.map(([kind, label]) => ({
        key: `kind:${kind}`,
        label,
        current: !filter.kinds.includes(kind),
        value: `kind:${kind}`
      }))
    ]
    return [
      // Always first, so toggling never moves the selected row.
      { key: "all", label: "Show all", value: "all" },
      ...Fuzzy.filter(rows, picker.query, (row) => row.label)
    ]
  }
  if (picker.kind === "theme") {
    return Fuzzy.filter(Object.keys(themes), picker.query, (name) => name).map((name) => ({
      key: name,
      label: name,
      current: name === activeTheme(),
      value: name
    }))
  }
  if (picker.kind === "model" || picker.kind === "worker-model") {
    const listed = Fuzzy.filter(models, picker.query, (model) => `${model.label} ${model.seat} ${model.provider}`)
    const custom = picker.query.includes(":") && !models.some((model) => model.seat === picker.query)
    return [
      ...(custom ? [{ key: picker.query, label: picker.query, hint: "any seat", value: picker.query }] : []),
      ...listed.map((model) => ({
        key: model.seat,
        label: model.label,
        hint: model.provider,
        detail: model.seat,
        current: model.seat === seat,
        value: model.seat
      }))
    ]
  }
  if (picker.kind === "undo") {
    return [{ key: "undo", label: "Undo", value: "undo" }, { key: "cancel", label: "Cancel", value: "cancel" }]
  }
  if (picker.kind === "fork") {
    const now = Date.now()
    return Fuzzy.filter(picker.turns, picker.query, (turn) => turn.text).map((turn) => ({
      key: String(turn.index),
      label: turn.text.split("\n")[0]!.slice(0, 60),
      detail: View.ago(turn.at, now),
      value: String(turn.index)
    }))
  }
  return Palette.sessionRows(picker.sessions, picker.query, Date.now()).map(({ file, ...row }) => ({
    ...row,
    value: file
  }))
}

/** The dialog's title; a capped `text:` search says so. */
export const title = (picker: Picker, truncated: boolean): string =>
  picker.kind === "model" || picker.kind === "worker-model"
    ? "Select model"
    : picker.kind === "theme"
    ? "Select theme"
    : picker.kind === "flows"
    ? "Flows"
    : picker.kind === "agents"
    ? "Agents"
    : picker.kind === "filter"
    ? "Filter chat"
    : picker.kind === "palette"
    ? truncated ? `Search · first ${Search.limit}` : "Search"
    : picker.kind === "fork"
    ? "Fork from message"
    : picker.kind === "undo"
    ? `Undo ${picker.target.paths.length === 1 ? picker.target.paths[0] : `${picker.target.paths.length} files`}?`
    : "Resume session"

/** What the dialog says with no rows. */
export const empty = (picker: Picker, flows: () => string, searching: boolean): string =>
  picker.kind === "resume"
    ? "No sessions in this directory"
    : picker.kind === "flows"
    ? flows()
    : picker.kind === "agents"
    ? "No agents"
    : picker.kind === "palette"
    ? searching ? "Searching" : "No matches"
    : picker.kind === "fork"
    ? `No messages match "${picker.query}"`
    : `No ${picker.kind} matches "${picker.query}"`

/**
 * The palette's background reads. `text:` runs rg; a newer query, leaving
 * text mode, or closing cancels it. `session:` reads the session files once
 * per palette opening.
 */
export const useSearch = (options: {
  readonly picker: Picker | undefined
  readonly setPicker: (update: (current: Picker | undefined) => Picker | undefined) => void
  readonly cwd: string
  readonly setStatus: (text: string, tone: "danger") => void
}) => {
  const { picker, setPicker, cwd, setStatus } = options
  const [search, setSearch] = useState<TextSearch | undefined>()
  const searchGeneration = useRef(0)
  const parsed = picker?.kind === "palette" ? Palette.parse(picker.query) : undefined
  const textQuery = parsed?.mode === "text" && parsed.query.length >= 2 ? parsed : undefined
  const textKey = textQuery === undefined ? "" : `${textQuery.query} ${textQuery.regex ?? ""}`
  useEffect(() => {
    const generation = ++searchGeneration.current
    setSearch(undefined)
    if (textQuery === undefined) return
    let running: ReturnType<typeof Search.run> | undefined
    const timer = setTimeout(() => {
      running = Search.run({
        cwd,
        query: textQuery.query,
        ...(textQuery.regex === undefined ? {} : { regex: textQuery.regex })
      })
      setSearch({ query: textQuery.query, startedAt: Date.now(), status: "running", hits: [], truncated: false })
      void running.done.then((outcome) => {
        if (generation !== searchGeneration.current || outcome._tag === "cancelled") return
        if (outcome._tag === "done") {
          setSearch({
            query: textQuery.query,
            startedAt: 0,
            status: "done",
            hits: outcome.hits,
            truncated: outcome.truncated
          })
          return
        }
        setSearch(undefined)
        setStatus(
          outcome.reason === "missing-rg"
            ? "rg not found"
            : outcome.reason === "bad-pattern"
            ? `Bad pattern: ${outcome.message}`
            : `rg: ${outcome.message}`,
          "danger"
        )
      })
    }, 150)
    return () => {
      clearTimeout(timer)
      running?.cancel()
    }
  }, [textKey, cwd])

  const needsSessions = parsed?.mode === "sessions" && picker?.kind === "palette" && picker.sessions === undefined
  useEffect(() => {
    if (!needsSessions) return
    let sessions: ReadonlyArray<Session.Summary> = []
    try {
      sessions = Session.list(cwd)
    } catch (error) {
      setStatus(String(error), "danger")
    }
    setPicker((current) => (current?.kind === "palette" ? { ...current, sessions } : current))
  }, [needsSessions, cwd])
  return { search, parsed }
}
