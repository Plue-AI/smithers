/**
 * The `files.list` flow shared by every host that runs it: its catalog entry,
 * its argument grammar, and its answer, the Files card and the model's copy of
 * what the card lists. The GUI binds its listing to these; the model host
 * binds its listing of the mirrored main to the same ones.
 * @since 1.0.0
 */

import type { AgentCommand } from "./AgentCommands.ts"
import type { Card } from "./Cards.ts"
import { parseFileArgs } from "./FileRead.ts"

/**
 * The flow's catalog entry: its name, its summary, its argument hint, and its agent rule: the agent lists a
 * directory at once.
 * @since 1.0.0
 * @category constants
 */
export const FILES_LIST_COMMAND = {
  name: "files.list",
  summary: "List a repository directory",
  args: "[path] [owner/repo]",
  agent: "run"
} as const satisfies AgentCommand

/**
 * The flow's declared input. The empty path is the repository's root.
 * @since 1.0.0
 * @category models
 */
export interface FileListInput {
  readonly path: string
  readonly repo?: string
}

/**
 * The flow's argument grammar, `[path] [owner/repo]`: the path is the first token, always; no token lists the root.
 * @since 1.0.0
 * @category parsers
 */
export const parseFileListArgs = (
  args: string | undefined
): { readonly payload: FileListInput } | { readonly error: string } => {
  const parsed = parseFileArgs(args)
  if ("error" in parsed) return parsed
  const [path = "", repo, ...rest] = parsed.tokens
  if (rest.length > 0) return { error: "files.list takes a path and optionally an owner/repo" }
  return { payload: repo === undefined ? { path } : { path, repo } }
}

/**
 * A Files card.
 * @since 1.0.0
 * @category models
 */
export type FileListCard = Extract<Card, { readonly kind: "file-list" }>

/**
 * One listed entry.
 * @since 1.0.0
 * @category models
 */
export type FileListEntry = FileListCard["payload"]["entries"][number]

/**
 * Directories first, then names in locale order: the one order every listing of a directory reads in, card and
 * sidebar alike. A repository host can answer a git tree's byte order, where `CHANGELOG.md` precedes `Cargo.lock`.
 * @since 1.0.0
 * @category utilities
 */
export const sortEntries = <E extends FileListEntry>(entries: ReadonlyArray<E>): Array<E> =>
  [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

/**
 * The model's copy of a listing stops here (a node_modules has thousands of entries); the card keeps them all.
 * @since 1.0.0
 * @category constants
 */
export const LISTING_VALUE_CAP = 400

/**
 * The model's copy of a directory listing: one entry per line, directories marked, bounded.
 * @since 1.0.0
 * @category utilities
 */
export const listingValue = (repo: string, path: string, entries: ReadonlyArray<FileListEntry>): string => {
  if (entries.length === 0) return `${path || "/"} in ${repo} is empty.`
  const shown = entries.slice(0, LISTING_VALUE_CAP).map((
    entry
  ) => (entry.kind === "dir" ? `${entry.name}/` : entry.name))
  const rest = entries.length - shown.length
  return `${path || "/"} in ${repo}:\n${shown.join("\n")}${
    rest > 0 ? `\n… and ${rest} more (the card lists them all)` : ""
  }`
}

/**
 * One finished listing of a repository directory, `""` being its root. `readAt` states the position it was taken
 * at; `truncated` says the host cut the directory short.
 * @since 1.0.0
 * @category models
 */
export interface FileList {
  readonly repo: string
  readonly path: string
  readonly entries: ReadonlyArray<FileListEntry>
  readonly truncated?: boolean
  readonly readAt?: FileListCard["payload"]["readAt"]
}

/**
 * The Files card a listing shows, its entries in the one listing order, and the model's copy of it.
 * @since 1.0.0
 * @category constructors
 */
export const fileListCard = (
  list: FileList,
  ordinal: number,
  createdAt: number
): { readonly card: FileListCard; readonly value: string } => {
  const entries = sortEntries(list.entries)
  const label = list.path === "" ? "/" : list.path
  const value = listingValue(list.repo, list.path, entries)
  return {
    card: {
      id: `files-${list.repo}-${label}`,
      kind: "file-list",
      title: `Files · ${list.repo} · ${label}`,
      status: "active",
      createdAt,
      ordinal,
      payload: {
        repo: list.repo,
        path: list.path,
        entries,
        ...(list.truncated === true ? { truncated: true } : {}),
        address: `/${list.repo}/${list.path}`,
        ...(list.readAt === undefined ? {} : { readAt: list.readAt })
      }
    },
    value: list.truncated === true
      ? `${value}\n(The directory has more entries than one listing shows.)`
      : value
  }
}
