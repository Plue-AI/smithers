/**
 * Language-server payloads projected into public code-intelligence responses.
 *
 * @since 1.0.0
 */

/*
 * The Language Server Protocol shapes as far as Smithers reads them (LSP
 * 3.17), and the one conversion of each into the typed answers of
 * `LocalLsp.ts`: 0-based, end-exclusive ranges become 1-based; a hover's
 * contents become one markdown string cut at the cap; a diagnostic's numeric
 * severity becomes its word. Two adapters speak the wire — the Bun host's
 * stdio session (`apps/app/src/bun/lsp/LspSession.ts`) and the renderer's
 * cloud client over plue's relay (`apps/app/src/mainview/state/CloudLspClient.ts`)
 * — and both convert HERE, so a hover reads the same whichever machine the
 * server runs on. Runtime-free: strings and numbers only.
 */
import { isRecord } from "@smthrs/canonical/Record"
import { LSP_HOVER_CAP_CHARS } from "./LocalLsp.ts"
import type { LspDiagnostic, LspHover, LspRange, LspSeverity } from "./LocalLsp.ts"

/**
 * The lsp position wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspPositionWire {
  readonly line: number
  readonly character: number
}
/**
 * The lsp range wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspRangeWire {
  readonly start: LspPositionWire
  readonly end: LspPositionWire
}
/**
 * The lsp diagnostic wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspDiagnosticWire {
  readonly range: LspRangeWire
  readonly message: string
  readonly severity?: number
  readonly code?: number | string
  readonly source?: string
  readonly relatedInformation?: unknown
}
/**
 * The lsp location wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspLocationWire {
  readonly uri: string
  readonly range: LspRangeWire
}
/**
 * The lsp location link wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspLocationLinkWire {
  readonly targetUri: string
  readonly targetRange: LspRangeWire
  readonly targetSelectionRange?: LspRangeWire
}
/**
 * The lsp marked string contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type LspMarkedString = string | { readonly language: string; readonly value: string }
/**
 * The lsp hover contents contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type LspHoverContents = LspMarkedString | ReadonlyArray<LspMarkedString> | {
  readonly kind: string
  readonly value: string
}
/**
 * The lsp hover wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspHoverWire {
  readonly contents: LspHoverContents
  readonly range?: LspRangeWire
}

const SEVERITIES: Readonly<Record<number, LspSeverity>> = { 1: "error", 2: "warning", 3: "information", 4: "hint" }

/** 0-based, end-exclusive → 1-based, end-exclusive.
 * @since 1.0.0
 * @category conversions
 */
export const toWireRange = (range: LspRangeWire): LspRange => ({
  line: range.start.line + 1,
  character: range.start.character + 1,
  endLine: range.end.line + 1,
  endCharacter: range.end.character + 1
})

const markedString = (value: LspMarkedString): string =>
  typeof value === "string" ? value : `\`\`\`${value.language}\n${value.value}\n\`\`\``

/**
 * A file URI or absolute path in free text: a leading slash not glued to a word (so a
 * URL's `//host/…` and a relative `src/…` are left alone), then at least two
 * segments. Quotes, brackets, whitespace and `:` end it, so `'/x/y'` and
 * `/x/y.ts:12:3` keep their punctuation.
 */
const PATH_TOKEN =
  /file:\/\/[^\s"'`<>()[\]{}|;,]+|(?<![A-Za-z0-9_.~/-])\/(?:[^\s"'`<>()[\]{}|:;,/]+\/)+[^\s"'`<>()[\]{}|:;,/]*/gi

/**
 * Redact slash-delimited absolute paths with at least two segments and
 * `file://` URIs, including markdown links and percent-escaped paths.
 * A local path under the root becomes root-relative (the root itself `.`).
 * Other paths keep their last segment behind `…/`, or become `…` with fewer
 * than three segments, so bare home directories do not reveal account names.
 * File URI authorities, queries and fragments are omitted; malformed escapes
 * become `…`. HTTP(S) links and relative paths are left alone. This token-based
 * redactor does not cover Windows paths or unescaped whitespace in paths.
 * @since 1.0.0
 * @category conversions
 */
export const redactHostPaths = (text: string, root: string): string =>
  text.replace(PATH_TOKEN, (token) => {
    try {
      const uri = /^file:/i.test(token) ? new URL(token) : null
      const decoded = decodeURIComponent(uri === null ? token : uri.pathname)
      const trailing = decoded.length > 1 && decoded.endsWith("/") ? "/" : ""
      const path = trailing === "" ? decoded : decoded.slice(0, -1)
      const localRoot = root.replace(/\/+$/, "")
      if (uri === null || uri.host === "") {
        if (path === localRoot) return "."
        if (path.startsWith(`${localRoot}/`)) return `${path.slice(localRoot.length + 1)}${trailing}`
      }
      const segments = path.split("/").filter((segment) => segment !== "")
      return segments.length < 3 ? "…" : `…/${segments.at(-1)}${trailing}`
    } catch {
      return "…"
    }
  })

/** The hover's text as one markdown string, through `redact`, cut at the cap and saying so.
 * @since 1.0.0
 * @category conversions
 */
export const hoverContents = (
  contents: LspHoverContents,
  redact: (text: string) => string = (text) => text
): LspHover => {
  const joined = Array.isArray(contents)
    ? (contents as ReadonlyArray<LspMarkedString>).map(markedString).join("\n\n")
    : isRecord(contents) && "kind" in contents
    ? String(contents.value)
    : markedString(contents as LspMarkedString)
  const text = redact(joined)
  const truncated = text.length > LSP_HOVER_CAP_CHARS
  return { contents: truncated ? text.slice(0, LSP_HOVER_CAP_CHARS) : text, truncated }
}

/** One diagnostic as the card and the model see it, its message through `redact`; related information stays with the server.
 * @since 1.0.0
 * @category conversions
 */
export const toDiagnostic = (
  item: LspDiagnosticWire,
  redact: (text: string) => string = (text) => text
): LspDiagnostic => ({
  ...toWireRange(item.range),
  severity: SEVERITIES[item.severity ?? 1] ?? "error",
  message: redact(item.message),
  ...(item.source === undefined ? {} : { source: item.source }),
  ...(item.code === undefined ? {} : { code: String(item.code) })
})

/**
 * A `file:` URI under `rootUri` as a root-relative path, or null when it
 * points elsewhere (a linked package, a lib.d.ts): a target the renderer
 * cannot open as a file card of this repository is counted, never invented
 * away. Both URIs must use `file://` with matching authorities. Percent-escapes
 * are decoded; queries and fragments are omitted. Dot segments, empty segments,
 * encoded separators, backslashes and NULs are refused in either path before
 * URL normalization. The root may have one trailing slash.
 * @since 1.0.0
 * @category conversions
 */
export const relativeToRoot = (uri: string, rootUri: string): string | null => {
  try {
    const target = new URL(uri)
    const root = new URL(rootUri)
    if (target.protocol !== "file:" || root.protocol !== "file:" || target.host !== root.host) return null
    const targetSegments = filePathSegments(uri, false)
    const rootSegments = filePathSegments(rootUri, true)
    if (targetSegments === null || rootSegments === null || targetSegments.length <= rootSegments.length) return null
    if (!rootSegments.every((segment, index) => segment === targetSegments[index])) return null
    return targetSegments.slice(rootSegments.length).join("/")
  } catch {
    return null
  }
}

// Read the original path: URL removes literal and percent-encoded dot segments.
const filePathSegments = (uri: string, isRoot: boolean): Array<string> | null => {
  const path = /^file:\/\/[^/?#\\]*(\/[^?#]*)/i.exec(uri)?.[1]
  if (path === undefined || /[\u0000-\u001f\u007f\\]/.test(path)) return null
  const segments = path.slice(1).split("/")
  if (isRoot && segments.at(-1) === "") segments.pop()
  const decoded = segments.map((segment) => decodeURIComponent(segment))
  return decoded.some((segment) => segment === "" || segment === "." || segment === ".." || /[/\\\u0000]/.test(segment))
    ? null
    : decoded
}

/** The one `initialize` capability set both adapters announce: markdown hovers, no related information, full-text sync.
 * @since 1.0.0
 * @category constants
 */
export const LSP_CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    publishDiagnostics: { relatedInformation: false, versionSupport: true }
  },
  workspace: { configuration: true, workspaceFolders: true }
} as const
