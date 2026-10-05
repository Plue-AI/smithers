/**
 * The `files.read` flow shared by every host that runs it: its catalog copy,
 * its argument grammar, and its answer, the File card and the model's copy of
 * what the card shows. The GUI binds its read to these; the model host binds
 * its read of the mirrored main to the same ones.
 * @since 1.0.0
 */

import type { Card } from "./Cards.ts"

/**
 * The flow's name, as the catalog, the journal and the conversation name it.
 * @since 1.0.0
 * @category constants
 */
export const FILES_READ = "files.read"

/**
 * The flow's catalog copy: its summary and its argument hint.
 * @since 1.0.0
 * @category constants
 */
export const FILES_READ_COPY = {
  summary: "Read a file from a repository",
  args: "<path>[:<line>[:<col>]] [owner/repo] [--ref <revision>]"
} as const

/**
 * The card cap (characters): a transcript card states a file, it is not an editor.
 * @since 1.0.0
 * @category constants
 */
export const CARD_CONTENT_CAP = 16 * 1024

/**
 * One path or repository token, quoted when it holds whitespace, a quote or a backslash.
 * @since 1.0.0
 * @category utilities
 */
export const quoteFileArg = (value: string): string =>
  value === "" || /[\s"'\\]/.test(value) ? JSON.stringify(value) : value

/**
 * File tokens as argument text, shared by buttons, forms and slash parsing.
 * @since 1.0.0
 * @category utilities
 */
export const fileArgs = (...values: ReadonlyArray<string | undefined>): string =>
  values.filter((value): value is string => value !== undefined).map(quoteFileArg).join(" ")

/**
 * File tokens from argument text. Quotes preserve whitespace in file names; unquoted backslashes remain literal.
 * @since 1.0.0
 * @category parsers
 */
export const parseFileArgs = (
  input: string | undefined
): { readonly tokens: Array<string> } | { readonly error: string } => {
  const tokens: Array<string> = []
  const text = input ?? ""
  let index = 0
  while (index < text.length) {
    while (/\s/.test(text[index] ?? "") && index < text.length) index += 1
    if (index >= text.length) break
    const quote = text[index]
    if (quote !== "\"" && quote !== "'") {
      const start = index
      while (index < text.length && !/\s/.test(text[index]!)) index += 1
      tokens.push(text.slice(start, index))
      continue
    }
    const start = index++
    let value = ""
    let closed = false
    while (index < text.length) {
      const character = text[index++]!
      if (character === quote) {
        closed = true
        break
      }
      if (quote === "\"" && character === "\\" && index < text.length) {
        value += character + text[index++]!
      } else value += character
    }
    if (!closed || (index < text.length && !/\s/.test(text[index]!))) {
      return { error: "Close the quoted file argument before the next argument." }
    }
    if (quote === "\"") {
      try {
        value = JSON.parse(text.slice(start, index)) as string
      } catch {
        return { error: "The quoted file argument contains an invalid escape." }
      }
    }
    tokens.push(value)
  }
  return { tokens }
}

/**
 * The flow's declared input.
 * @since 1.0.0
 * @category models
 */
export interface FileReadInput {
  readonly path: string
  readonly repo?: string
  readonly line?: number
  readonly column?: number
  readonly ref?: string
}

/**
 * The flow's argument grammar, `<path>[:<line>[:<col>]] [owner/repo] [--ref <revision>]`: the path is the first
 * token, always; the line anchor is stripped off it.
 * @since 1.0.0
 * @category parsers
 */
export const parseFileReadArgs = (
  args: string | undefined
): { readonly payload: FileReadInput } | { readonly error: string } => {
  const parsed = parseFileArgs(args)
  if ("error" in parsed) return parsed
  const tokens = [...parsed.tokens]
  const refAt = tokens.indexOf("--ref")
  const ref = refAt === -1 ? undefined : tokens[refAt + 1]
  if (refAt !== -1) {
    if (refAt !== tokens.length - 2 || !ref) return { error: "files.read --ref needs a revision" }
    tokens.splice(refAt, 2)
  }
  const [token, repo] = tokens
  if (token === undefined) return { error: "files.read needs a file path" }
  if (tokens.length > 2) return { error: "files.read takes a path and optionally an owner/repo" }
  const anchor = /^(.*?):(\d+)(?::(\d+))?$/.exec(token)
  const path = anchor === null ? token : anchor[1] ?? ""
  if (path === "") return { error: "files.read needs a file path" }
  const line = anchor === null ? undefined : Number(anchor[2])
  const column = anchor?.[3] === undefined ? undefined : Number(anchor[3])
  if (line === 0 || column === 0) {
    return { error: "files.read lines and columns count from 1: /files.read <path>[:<line>[:<col>]]" }
  }
  return {
    payload: {
      path,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      ...(ref === undefined ? {} : { ref }),
      ...(repo === undefined ? {} : { repo })
    }
  }
}

/**
 * The model's copy of a file: the same bounded text the card shows, with truncation and binary stated.
 * @since 1.0.0
 * @category utilities
 */
export const fileValue = (
  repo: string,
  path: string,
  payload: { readonly content: string; readonly truncated: boolean; readonly binary?: boolean }
): string =>
  payload.binary === true
    ? `${path} in ${repo} is a binary file; its bytes are not shown.`
    : `${path} in ${repo}${
      payload.truncated ? " (truncated at the card cap; the rest stays in the repository)" : ""
    }:\n${payload.content}`

/**
 * A File card.
 * @since 1.0.0
 * @category models
 */
export type FileReadCard = Extract<Card, { readonly kind: "file" }>

/**
 * One finished read: the file's text, or `binary` when its bytes are not text, and where it was read. A read at
 * a revision names it in `ref`; any other read states the position it was taken at in `readAt`.
 * @since 1.0.0
 * @category models
 */
export interface FileRead {
  readonly repo: string
  readonly path: string
  readonly content: string
  readonly binary: boolean
  readonly readAt?: FileReadCard["payload"]["readAt"]
  readonly ref?: string
  readonly line?: number
  readonly column?: number
}

/**
 * The File card a read shows, cut at the card cap, and the model's copy of it. A binary file is stated, never
 * printed, and carries no line anchor.
 * @since 1.0.0
 * @category constructors
 */
export const fileReadCard = (
  read: FileRead,
  ordinal: number,
  createdAt: number
): { readonly card: FileReadCard; readonly value: string } => {
  const truncated = !read.binary && read.content.length > CARD_CONTENT_CAP
  const content = read.binary ? "" : truncated ? read.content.slice(0, CARD_CONTENT_CAP) : read.content
  const at = read.ref === undefined
    ? { address: `/${read.repo}/${read.path}`, ...(read.readAt === undefined ? {} : { readAt: read.readAt }) }
    : { address: `/${read.repo}/${read.path}`, ref: read.ref }
  const anchor = read.binary || read.line === undefined
    ? {}
    : { line: read.line, ...(read.column === undefined ? {} : { column: read.column }) }
  const payload = {
    repo: read.repo,
    path: read.path,
    content,
    truncated,
    ...(read.binary ? { binary: true } : {}),
    ...at,
    ...anchor
  }
  return {
    card: {
      id: `file-${read.repo}-${read.path}${read.ref === undefined ? "" : `@${read.ref}`}`,
      kind: "file",
      title: `File · ${read.repo} · ${read.path}`,
      status: "active",
      createdAt,
      ordinal,
      payload
    },
    value: fileValue(read.repo, read.path, payload)
  }
}
