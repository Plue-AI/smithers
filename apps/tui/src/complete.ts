/**
 * Composer completion: `/command`, its argument, and `@file`.
 *
 * Pure: the caller passes the text, the cursor, and the sources; the result
 * names the span to replace and what may replace it. Triggers follow pi and
 * opencode: `/` only at the start of the message, `@` after whitespace or at
 * the start, and a space or newline closes either.
 */
import * as Editor from "./editor.ts"
import * as Fuzzy from "./fuzzy.ts"

export interface Suggestion {
  readonly label: string
  /** A second column: a command's arguments, a model's provider. */
  readonly hint?: string
  readonly detail?: string
  /** Replaces `start` to `end` when chosen. */
  readonly insert: string
  /** Enter runs the resulting message instead of only inserting it. */
  readonly submit: boolean
}

export interface Completion {
  readonly kind: "command" | "argument" | "file"
  /** What the menu matched, so a caller can reset its selection when it changes. */
  readonly query: string
  readonly start: number
  readonly end: number
  readonly items: ReadonlyArray<Suggestion>
}

export interface Sources {
  readonly models: ReadonlyArray<{ readonly seat: string; readonly label: string; readonly provider: string }>
  /** Repository files, relative to the working directory; read only when `@` is typed. */
  readonly files: () => ReadonlyArray<string>
  /** The directory's flows, from the last discovery. */
  readonly flows?: () => ReadonlyArray<{ readonly name: string; readonly description: string }>
}

/** The most file suggestions offered at once (pi shows 20). */
export const fileLimit = 20

const flowItems = (typed: string, sources: Sources): Array<Suggestion> =>
  Fuzzy.filter(sources.flows?.() ?? [], typed, (flow) => flow.name).map((flow) => ({
    label: `/flow ${flow.name}`,
    hint: "flow",
    detail: flow.description,
    insert: `/flow ${flow.name}`,
    submit: true
  }))

const commandItems = (typed: string, sources: Sources): Array<Suggestion> => [
  ...Fuzzy.filter(Editor.commands, typed, (command) => command.name).map((command) => ({
    label: `/${command.name}`,
    ...(command.args === undefined ? {} : { hint: command.args }),
    detail: command.description,
    insert: Editor.takesArgument(command) ? `/${command.name} ` : `/${command.name}`,
    submit: !Editor.takesArgument(command)
  })),
  ...flowItems(typed, sources)
]

const argumentItems = (name: string, typed: string, sources: Sources): Array<Suggestion> | undefined => {
  if (name === "model") {
    return Fuzzy.filter(sources.models, typed, (model) => `${model.label} ${model.seat}`).map((model) => ({
      label: model.label,
      hint: model.provider,
      insert: `/model ${model.seat}`,
      submit: true
    }))
  }
  if (name === "flow") return flowItems(typed, sources)
  return undefined
}

/** Characters that cannot appear raw in a terminal row or an unquoted mention. */
const unsafe = /[\p{Cc}\p{Zl}\p{Zp}]|[^\S ]/gu

const escape = (char: string): string =>
  JSON.stringify(char).length === 4
    ? JSON.stringify(char).slice(1, -1)
    : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`

/** `path` for a menu row: control and non-space whitespace characters escaped, Unicode kept readable. */
export const display = (path: string): string => path.replace(unsafe, escape)

/**
 * `@path` or `@path:line` with a trailing space. A path with whitespace, a
 * quote, a backslash, a control character, or a `:digits` ending is a JSON
 * string, so the mention names exactly one file and Unicode stays readable.
 */
export const mention = (path: string, line?: number): string =>
  `@${/[\s"\\\p{Cc}]|:\d+$/u.test(path) ? `"${JSON.stringify(path).slice(1, -1).replace(unsafe, escape)}"` : path}${
    line === undefined ? "" : `:${line}`
  } `

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** Files by name first, then by path; shorter paths win ties. */
export const rankFiles = (files: ReadonlyArray<string>, query: string): Array<string> => {
  if (query === "") return [...files].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
  const ranked: Array<{ readonly path: string; readonly score: number }> = []
  for (const path of files) {
    const byName = Fuzzy.score(query, basename(path))
    const byPath = Fuzzy.score(query, path)
    if (byName === undefined && byPath === undefined) continue
    ranked.push({ path, score: Math.min(byName ?? Infinity, (byPath ?? Infinity) + 20) })
  }
  return ranked.sort((a, b) => a.score - b.score || a.path.length - b.path.length).map((entry) => entry.path)
}

/** What the menu offers for `text` with the cursor at `cursor`, or undefined for no menu. */
export const complete = (text: string, cursor: number, sources: Sources): Completion | undefined => {
  const before = text.slice(0, cursor)
  if (text.startsWith("/") && !before.includes("\n")) {
    const space = before.indexOf(" ")
    if (space < 0) {
      const end = /^\S*/.exec(text)![0].length
      return { kind: "command", query: before.slice(1), start: 0, end, items: commandItems(before.slice(1), sources) }
    }
    const name = before.slice(1, space)
    const typed = before.slice(space + 1)
    const items = argumentItems(name, typed.trimStart(), sources)
    if (items === undefined) return undefined
    return {
      kind: "argument",
      query: `${name} ${typed}`,
      start: 0,
      end: cursor + /^\S*/.exec(text.slice(cursor))![0].length,
      items
    }
  }
  const found = /(^|\s)@(\S*)$/.exec(before)
  if (found === null) return undefined
  const query = found[2]!
  const start = cursor - query.length - 1
  const end = cursor + /^\S*/.exec(text.slice(cursor))![0].length
  const items = rankFiles(sources.files(), query).slice(0, fileLimit).map((path) => ({
    label: display(path),
    insert: mention(path),
    submit: false
  }))
  return { kind: "file", query, start, end, items }
}

/** `text` with the completion's span replaced, and where the cursor lands. */
export const apply = (
  text: string,
  completion: Completion,
  suggestion: Suggestion
): { readonly text: string; readonly cursor: number } => {
  const rest = text.slice(completion.end)
  // The inserted trailing space merges with a space already there.
  const insert = rest.startsWith(" ") && suggestion.insert.endsWith(" ")
    ? suggestion.insert.slice(0, -1)
    : suggestion.insert
  const cursor = completion.start + insert.length + (insert === suggestion.insert ? 0 : 1)
  return { text: text.slice(0, completion.start) + insert + rest, cursor }
}
