/**
 * Ctrl+K: one search over commands, files, file text, sessions, and worker
 * tabs. The first token picks the mode, as in the app's Cmd+K palette
 * (`apps/app/src/mainview/flows/SearchQuery.ts`, `PREFIXES` and `parseQuery`).
 * `/`, `text:` (with `/re/`) and `?` keep the app's meaning; `conversation:` and
 * `tab:` are the terminal's own. The app's `@` is symbols there, but `@` is a
 * file here, so it is not a prefix.
 *
 * Pure: the caller passes the sources and acts on the chosen row's value.
 */
import { display, fileLimit, mention, rankFiles } from "./complete.ts"
import type * as Editor from "./editor.ts"
import type * as Extension from "./extension.ts"
import * as Fuzzy from "./fuzzy.ts"
import type * as Search from "./search.ts"
import type * as Session from "./session.ts"
import * as View from "./view.tsx"
import type { Tab } from "./workspace.ts"

export type Mode = "all" | "commands" | "text" | "sessions" | "tabs" | "help"

export interface Parsed {
  readonly mode: Mode
  readonly prefix: string
  readonly query: string
  /** `text:/re/`: the pattern between the slashes. */
  readonly regex?: string
}

export const prefixes: ReadonlyArray<{ readonly prefix: string; readonly mode: Mode; readonly label: string }> = [
  { prefix: "/", mode: "commands", label: "commands" },
  { prefix: "text:", mode: "text", label: "text in files" },
  { prefix: "conversation:", mode: "sessions", label: "conversations" },
  { prefix: "tab:", mode: "tabs", label: "worker tabs" }
]

export const parse = (raw: string): Parsed => {
  const text = raw.trimStart()
  if (text.trim() === "?") return { mode: "help", prefix: "?", query: "" }
  if (text.startsWith("/")) return { mode: "commands", prefix: "/", query: text.slice(1).trim() }
  const word = prefixes.find((each) => each.prefix !== "/" && text.startsWith(each.prefix))
  if (word === undefined) return { mode: "all", prefix: "", query: text.trim() }
  const query = text.slice(word.prefix.length).trim()
  const regex = word.mode === "text" ? /^\/(.+)\/$/.exec(query)?.[1] : undefined
  return { mode: word.mode, prefix: word.prefix, query, ...(regex === undefined ? {} : { regex }) }
}

export type Value =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "hit"; readonly path: string; readonly line: number }
  | { readonly kind: "command"; readonly name: string }
  | { readonly kind: "session"; readonly file: string }
  | { readonly kind: "tab"; readonly id: string }
  | { readonly kind: "prefix"; readonly prefix: string }
  /** A contributed key or status item: choosing it runs its action. */
  | { readonly kind: "action"; readonly action: Extension.Action }

export interface Row extends View.Row {
  readonly value: Value
}

export interface Sources {
  readonly commands: ReadonlyArray<Editor.Command>
  readonly files: () => ReadonlyArray<string>
  /** Undefined until read. */
  readonly sessions: ReadonlyArray<Session.Summary> | undefined
  readonly tabs: ReadonlyArray<Tab>
  readonly hits: ReadonlyArray<Search.Hit>
  readonly now: number
  /** Contributed keys and status items; `hint` is the key. */
  readonly actions?: ReadonlyArray<
    { readonly key: string; readonly label: string; readonly hint?: string; readonly action: Extension.Action }
  >
}

/** The saved-conversation rows `/resume` and `conversation:` both show. */
export const sessionRows = (
  sessions: ReadonlyArray<Session.Summary>,
  query: string,
  now: number
): Array<View.Row & { readonly file: string }> =>
  Fuzzy.filter(sessions, query, (session) => `${session.name ?? ""} ${session.firstPrompt}`).map((session) => ({
    key: session.file,
    label: (session.name ?? session.firstPrompt).split("\n")[0]!.slice(0, 60),
    detail: session.parent === undefined
      ? View.ago(session.modified, now)
      : `fork · ${View.ago(session.modified, now)}`,
    file: session.file
  }))

const commandRows = (commands: ReadonlyArray<Editor.Command>, query: string): Array<Row> =>
  Fuzzy.filter(commands, query, (command) => command.name).map((command) => ({
    key: `command:${command.name}`,
    label: `/${command.name}`,
    ...(command.args === undefined ? {} : { hint: command.args }),
    detail: command.description,
    value: { kind: "command", name: command.name }
  }))

export const rows = (parsed: Parsed, sources: Sources): ReadonlyArray<Row> => {
  const { query } = parsed
  switch (parsed.mode) {
    case "all":
      return [
        ...commandRows(sources.commands, query),
        ...Fuzzy.filter(sources.actions ?? [], query, (each) => each.label).map(({ action, ...row }): Row => ({
          ...row,
          value: { kind: "action", action }
        })),
        ...rankFiles(sources.files(), query).slice(0, fileLimit).map((path): Row => ({
          key: `file:${path}`,
          label: display(path),
          value: { kind: "file", path }
        }))
      ]
    case "commands":
      return commandRows(sources.commands, query)
    case "text":
      return sources.hits.map((hit) => ({
        key: `hit:${hit.path}:${hit.line}`,
        label: `${display(hit.path)}:${hit.line}`,
        detail: display(hit.text.trim()),
        value: { kind: "hit", path: hit.path, line: hit.line }
      }))
    case "sessions":
      return sessionRows(sources.sessions ?? [], query, sources.now).map(({ file, ...row }) => ({
        ...row,
        value: { kind: "session", file }
      }))
    case "tabs":
      return Fuzzy.filter(sources.tabs, query, (tab) => `${tab.title} ${tab.id} ${tab.status}`).map((tab) => ({
        key: `tab:${tab.id}`,
        label: tab.title,
        hint: tab.status,
        value: { kind: "tab", id: tab.id }
      }))
    case "help":
      return prefixes.map((each) => ({
        key: `prefix:${each.prefix}`,
        label: each.prefix,
        detail: each.label,
        value: { kind: "prefix", prefix: each.prefix }
      }))
  }
}

export { mention }

/** `insert` at `cursor`, spaced from the word before it; its trailing space merges with one already there. */
export const insertAt = (
  text: string,
  cursor: number,
  insert: string
): { readonly text: string; readonly cursor: number } => {
  const before = text.slice(0, cursor)
  const rest = text.slice(cursor)
  const lead = before === "" || /\s$/.test(before) ? "" : " "
  const body = rest.startsWith(" ") && insert.endsWith(" ") ? insert.slice(0, -1) : insert
  const next = before + lead + body
  return { text: next + rest, cursor: next.length + (body === insert ? 0 : 1) }
}
