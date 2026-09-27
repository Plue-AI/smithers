/**
 * The chat's rows, filtered the way a log view is: by kind of row and by
 * text. Workers show as subagent cards (`subagents.ts`), never as rows here.
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

export interface Row {
  /** The row's element id: `chat:<item id>`. */
  readonly key: string
  readonly item: Transcript.Item
  readonly at: number
}

/** What is hidden; the empty filter shows everything. */
export interface Filter {
  readonly kinds: ReadonlyArray<Kind>
  readonly query: string
}

export const all: Filter = { kinds: [], query: "" }

export const active = (filter: Filter): boolean => filter.kinds.length > 0 || filter.query !== ""

const flip = <A>(values: ReadonlyArray<A>, value: A): ReadonlyArray<A> =>
  values.includes(value) ? values.filter((each) => each !== value) : [...values, value]

export const toggleKind = (filter: Filter, kind: Kind): Filter => ({ ...filter, kinds: flip(filter.kinds, kind) })

/** A chat item's row key. */
export const key = (id: string): string => `chat:${id}`

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
 * The transcript's rows, oldest first. A row's time is never earlier than the
 * row before it: an item without a time, or with a skewed one, keeps its place.
 */
export const rows = (transcript: Transcript.Transcript, filter: Filter = all): ReadonlyArray<Row> => {
  const query = filter.query.toLowerCase()
  let at = 0
  return transcript.items
    .map((item) => {
      at = Math.max(at, item.at ?? at)
      return { key: key(item.id), item, at }
    })
    .filter((row) => !filter.kinds.includes(row.item.kind))
    .filter((row) => query === "" || text(row.item).toLowerCase().includes(query))
}

/** One view's row cache: clock-only renders reuse rows without filtering again. */
export const cached = (): typeof rows => {
  let previous: Transcript.Transcript | undefined
  let selected: Filter | undefined
  let kept: ReadonlyArray<Row> = []
  return (transcript, filter = all) => {
    if (previous === transcript && selected === filter) return kept
    previous = transcript
    selected = filter
    kept = rows(transcript, filter)
    return kept
  }
}
