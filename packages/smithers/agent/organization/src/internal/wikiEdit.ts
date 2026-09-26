/**
 * Role edits to the organization wiki: `write`, `edit` (one exact string
 * replacement), and `append` of Markdown files, confined by real path to the
 * principal's knowledge grants and never to an authority or configuration
 * page.
 *
 * The protected set is fixed plus whatever the host names from its loaded
 * configuration: the roster, policy, connections, meetings and routines
 * pages, the skills and cases, the setup notes, `AGENTS.md` and `CLAUDE.md`
 * at any depth, and every hidden segment. It is matched segment by segment,
 * case-folded and NFC-normalized, against both the path the role named and
 * the real path it resolves to, so a symlink, a differently cased spelling on
 * a case-insensitive disk, or a directory link into a protected tree is
 * refused like the page itself. A write replaces the file by renaming a
 * sibling temporary file over it, so a hard link to a protected page is
 * broken, never written through.
 *
 * The host's journal is asked before a write (`guard`: a page with
 * uncommitted changes the host did not make is refused, so the owner's own
 * work is never overwritten) and told after it (`record`), which is how the
 * host commits exactly what roles wrote and attributes each edit.
 *
 * @since 1.0.0
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as KnowledgePath from "./knowledgePath.ts"

/**
 * One wiki edit, as the journal and the task's evidence record it.
 *
 * @private
 * @since 1.0.0
 */
export interface Edit {
  readonly principal: string
  /** The real wiki-relative path written. */
  readonly path: string
  readonly op: "write" | "edit" | "append"
  /** Size of the file after the edit, in bytes. */
  readonly bytes: number
}

/**
 * The host's side of role edits.
 *
 * @private
 * @since 1.0.0
 */
export interface Journal {
  /** Fails with the reason when `path` must not be written now. */
  readonly guard: (path: string) => Effect.Effect<void, string>
  /** Records a finished edit. */
  readonly record: (edit: Edit) => Effect.Effect<void>
}

/**
 * Why an edit was refused. `message` never contains file content.
 *
 * @private
 * @since 1.0.0
 */
export class Refusal extends Data.TaggedError("WikiEditRefusal")<{
  readonly code:
    | "invalid-path"
    | "protected"
    | "not-granted"
    | "outside-root"
    | "not-a-file"
    | "too-large"
    | "conflict"
    | "no-match"
    | "invalid-input"
    | "io"
  readonly message: string
}> {}

const refuse = (code: Refusal["code"], message: string): Refusal => new Refusal({ code, message })

/**
 * The authority and configuration pages no role may edit, whatever its
 * grants, at the default layout. The host adds the pages its organization
 * page names.
 *
 * @private
 * @since 1.0.0
 */
export const fixedProtected: ReadonlyArray<string> = [
  "Org/Roles/",
  "Org/Policy/",
  "Org/Organization.md",
  "Org/Connections.md",
  "Org/Meetings.md",
  "Org/Routines.md",
  "Org/Specialists/",
  "Org/Skills/",
  "Org/Cases/",
  "Org/Common Operating Instructions.md",
  "Org/Setup/"
]

/** Page names protected at any depth. */
const protectedNames = new Set(["agents.md", "claude.md"])

const fold = (text: string) => text.normalize("NFC").toLowerCase()

const segmentsOf = (path: string) => path.split("/").filter((segment) => segment !== "").map(fold)

/**
 * Whether `path` (wiki-relative, `/`-separated) is or lies under a protected
 * page: a hidden segment, `AGENTS.md` or `CLAUDE.md` anywhere, or a prefix
 * of segments equal, case-folded, to one of {@link fixedProtected} or `extra`.
 *
 * @private
 * @since 1.0.0
 */
export const isProtected = (path: string, extra: ReadonlyArray<string> = []): boolean => {
  const raw = path.split("/").filter((segment) => segment !== "")
  if (raw.some((segment) => segment.startsWith("."))) return true
  const folded = segmentsOf(path)
  if (folded.some((segment) => protectedNames.has(segment))) return true
  return [...fixedProtected, ...extra].some((entry) => {
    const prefix = segmentsOf(entry)
    return prefix.length > 0 && prefix.length <= folded.length &&
      prefix.every((segment, index) => folded[index] === segment)
  })
}

/**
 * What a role asks for.
 *
 * @private
 * @since 1.0.0
 */
export interface Request {
  readonly op: "write" | "edit" | "append"
  readonly path: string
  readonly content?: string | undefined
  readonly oldString?: string | undefined
  readonly newString?: string | undefined
}

/**
 * Everything one edit needs.
 *
 * @private
 * @since 1.0.0
 */
export interface Options {
  readonly root: string
  readonly principal: string
  readonly request: Request
  /** Whether the principal's knowledge grants cover a wiki file path. */
  readonly admit: (path: string) => boolean
  /** Protected pages besides {@link fixedProtected}. */
  readonly protected: ReadonlyArray<string>
  readonly maxFileBytes: number
  readonly maxCallBytes: number
  readonly journal?: Journal | undefined
}

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength

const occurrences = (text: string, needle: string) => {
  let count = 0
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) count++
  return count
}

/**
 * Applies one edit, or refuses it before anything is written.
 *
 * @private
 * @since 1.0.0
 */
export const apply = (options: Options): Effect.Effect<Edit, Refusal, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { request } = options
    const parsed = KnowledgePath.parse(request.path)
    if (!parsed.ok || parsed.path.kind !== "file" || !/\.md$/i.test(request.path)) {
      return yield* refuse("invalid-path", "is not a relative Markdown wiki file path")
    }
    if (isProtected(request.path, options.protected)) {
      return yield* refuse(
        "protected",
        "is an authority or configuration page; propose the change in Org/Proposals/ instead"
      )
    }
    if (!options.admit(request.path)) return yield* refuse("not-granted", "is not granted")
    const payload = request.op === "edit" ? request.newString : request.content
    if (typeof payload !== "string" || (request.op === "edit" && (request.oldString ?? "") === "")) {
      return yield* refuse(
        "invalid-input",
        request.op === "edit" ? "an edit needs oldString and newString" : `${request.op} needs content`
      )
    }
    if (utf8(payload) > options.maxCallBytes) {
      return yield* refuse("too-large", `one call writes at most ${options.maxCallBytes} bytes`)
    }
    const io = (message: string) => () => refuse("io", message)
    const real = yield* fs.realPath(path.resolve(options.root)).pipe(
      Effect.mapError(io("the wiki root could not be resolved"))
    )
    const prefix = path.join(real, path.sep)
    const relativeOf = (candidate: string) =>
      candidate.startsWith(prefix) ? candidate.slice(prefix.length).split(path.sep).join("/") : undefined
    // Walk the existing directories by real path; the first missing one
    // ends the walk, since nothing below it can be a link.
    const segments = parsed.path.segments
    let directory = real
    let missing = 0
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      const next = path.join(directory, segment)
      if (!(yield* fs.exists(next).pipe(Effect.mapError(io("could not be checked"))))) {
        missing = segments.length - 1 - index
        break
      }
      directory = yield* fs.realPath(next).pipe(Effect.mapError(io("could not be resolved")))
      const within = relativeOf(directory)
      if (within === undefined) return yield* refuse("outside-root", "resolves outside the wiki root")
      if (isProtected(within, options.protected)) {
        return yield* refuse("protected", "resolves to an authority or configuration page")
      }
    }
    const rest = segments.slice(segments.length - 1 - missing)
    let target = path.join(directory, ...rest)
    const exists = missing === 0 && (yield* fs.exists(target).pipe(Effect.mapError(io("could not be checked"))))
    if (exists) target = yield* fs.realPath(target).pipe(Effect.mapError(io("could not be resolved")))
    const resolved = relativeOf(target)
    if (resolved === undefined) return yield* refuse("outside-root", "resolves outside the wiki root")
    if (isProtected(resolved, options.protected)) {
      return yield* refuse("protected", "resolves to an authority or configuration page")
    }
    const reparsed = KnowledgePath.parse(resolved)
    if (!reparsed.ok || !/\.md$/i.test(resolved) || !options.admit(resolved)) {
      return yield* refuse("not-granted", "resolves to a path that is not granted")
    }
    if (options.journal !== undefined) {
      yield* options.journal.guard(resolved).pipe(Effect.mapError((reason) => refuse("conflict", reason)))
    }
    let current = ""
    if (exists) {
      const info = yield* fs.stat(target).pipe(Effect.mapError(io("could not be read")))
      if (info.type !== "File") return yield* refuse("not-a-file", "is not a regular file")
      if (Number(info.size) > options.maxFileBytes) {
        return yield* refuse("too-large", `is over ${options.maxFileBytes} bytes`)
      }
      current = yield* fs.readFileString(target).pipe(Effect.mapError(io("could not be read")))
    }
    let next: string
    if (request.op === "write") next = payload
    else if (request.op === "append") {
      next = current === "" || current.endsWith("\n") ? `${current}${payload}` : `${current}\n${payload}`
    } else {
      const found = occurrences(current, request.oldString!)
      if (found !== 1) {
        return yield* refuse(
          "no-match",
          found === 0 ? "does not contain oldString" : "contains oldString more than once"
        )
      }
      next = current.replace(request.oldString!, () => payload)
    }
    const bytes = utf8(next)
    if (bytes > options.maxFileBytes) return yield* refuse("too-large", `would be over ${options.maxFileBytes} bytes`)
    yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
      Effect.mapError(io("a directory could not be created"))
    )
    const temporary = `${target}.${globalThis.crypto.randomUUID()}.tmp`
    yield* fs.writeFileString(temporary, next).pipe(Effect.mapError(io("could not be written")))
    yield* fs.rename(temporary, target).pipe(
      Effect.mapError(io("could not be renamed into place")),
      Effect.tapError(() => Effect.ignore(fs.remove(temporary)))
    )
    const edit: Edit = { principal: options.principal, path: resolved, op: request.op, bytes }
    if (options.journal !== undefined) yield* options.journal.record(edit)
    return edit
  })

const isResult = (value: unknown): value is { readonly evidence: ReadonlyArray<unknown> } =>
  typeof value === "object" && value !== null && Array.isArray((value as { evidence?: unknown }).evidence)

/**
 * `result` with one `file` evidence item per page the task edited, in
 * order. Anything that is not a role result is returned as it is.
 *
 * @private
 * @since 1.0.0
 */
export const withEvidence = <A>(result: A, edits: ReadonlyArray<Edit>): A =>
  !isResult(result) || edits.length === 0 ? result : {
    ...result,
    evidence: [
      ...result.evidence,
      ...edits.map((edit) => ({
        kind: "file",
        ref: edit.path,
        detail: `wiki-edit ${edit.op} by ${edit.principal}: ${edit.bytes} bytes`
      }))
    ]
  }
