/**
 * The chat and every worker on one clock, filtered the way a log view is:
 * by source, by kind of row, and by text.
 */
import type * as Transcript from "./transcript.ts"

export type Kind = Transcript.Item["kind"]

export const kinds: ReadonlyArray<readonly [kind: Kind, label: string]> = [
  ["user", "Messages"],
  ["cell", "Cells"],
  ["shell", "Shell"],
  ["answer", "Answers"],
  ["error", "Errors"],
  ["note", "Notes"],
  ["card", "Cards"]
]

/** The chat's own source id; a worker's is its tab id. */
export const chat = "chat"

export interface Source {
  readonly id: string
  readonly transcript: Transcript.Transcript
}

export interface Row {
  readonly key: string
  readonly source: string
  readonly item: Transcript.Item
  readonly at: number
}

/** What is hidden; the empty filter shows everything. */
export interface Filter {
  readonly sources: ReadonlyArray<string>
  readonly kinds: ReadonlyArray<Kind>
  readonly query: string
}

export const all: Filter = { sources: [], kinds: [], query: "" }

export const active = (filter: Filter): boolean =>
  filter.sources.length > 0 || filter.kinds.length > 0 || filter.query !== ""

const flip = <A>(values: ReadonlyArray<A>, value: A): ReadonlyArray<A> =>
  values.includes(value) ? values.filter((each) => each !== value) : [...values, value]

export const toggleSource = (filter: Filter, source: string): Filter => ({
  ...filter,
  sources: flip(filter.sources, source)
})

export const toggleKind = (filter: Filter, kind: Kind): Filter => ({ ...filter, kinds: flip(filter.kinds, kind) })

/** Everything a row says, for the text filter to match. */
export const text = (item: Transcript.Item): string => {
  switch (item.kind) {
    case "user":
    case "answer":
    case "error":
    case "note":
      return item.text
    case "shell":
      return `${item.command}\n${item.output}`
    case "card":
      return [item.panel.title, item.panel.summary, ...item.panel.rows.map((row) => row.label)].join("\n")
    case "cell":
      return [item.prose, item.source, item.printed, item.error ?? "", ...item.calls.map((call) => call.subject)].join(
        "\n"
      )
  }
}

/**
 * Rows from every source, oldest first. An item keeps its source's order: its
 * time is never earlier than the item before it in the same source.
 */
export const merge = (sources: ReadonlyArray<Source>, filter: Filter = all): ReadonlyArray<Row> => {
  const query = filter.query.toLowerCase()
  return sources
    .filter((source) => !filter.sources.includes(source.id))
    .flatMap((source) => {
      let at = 0
      return source.transcript.items.map((item) => {
        at = Math.max(at, item.at ?? at)
        return { key: `${source.id}:${item.id}`, source: source.id, item, at }
      })
    })
    .filter((row) => !filter.kinds.includes(row.item.kind))
    .filter((row) => query === "" || text(row.item).toLowerCase().includes(query))
    .sort((a, b) => a.at - b.at)
}

/** One view's merge cache: clock-only renders reuse rows without sorting again. */
export const cached = (): typeof merge => {
  let previous: ReadonlyArray<Source> = []
  let selected: Filter | undefined
  let rows: ReadonlyArray<Row> = []
  return (sources, filter = all) => {
    if (
      selected === filter && sources.length === previous.length &&
      sources.every((source, index) =>
        source.id === previous[index]!.id && source.transcript === previous[index]!.transcript
      )
    ) return rows
    previous = sources
    selected = filter
    rows = merge(sources, filter)
    return rows
  }
}
