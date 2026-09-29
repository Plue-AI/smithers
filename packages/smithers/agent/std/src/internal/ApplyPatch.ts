/**
 * Faithful port of the Codex CLI apply_patch engine.
 *
 * Mirrors `codex-rs/apply-patch/src/{parser,streaming_parser,seek_sequence}.rs`
 * and the applier in `lib.rs`: the V4A patch grammar, the lenient heredoc
 * boundary handling, the fuzzy context-matching ladder, and every error
 * string, so ChatGPT-family models see exactly the behavior they were
 * posttrained on. Pure module: no host access.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import { sourceLines } from "./Text.ts"

const BEGIN_PATCH_MARKER = "*** Begin Patch"
const END_PATCH_MARKER = "*** End Patch"
const ADD_FILE_MARKER = "*** Add File: "
const DELETE_FILE_MARKER = "*** Delete File: "
const UPDATE_FILE_MARKER = "*** Update File: "
const MOVE_TO_MARKER = "*** Move to: "
const EOF_MARKER = "*** End of File"
const CHANGE_CONTEXT_MARKER = "@@ "
const EMPTY_CHANGE_CONTEXT_MARKER = "@@"
const ENVIRONMENT_ID_MARKER = "*** Environment ID:"

/**
 * Parse failure with Codex-identical message text.
 *
 * `invalid patch: {message}` for patch-level failures and
 * `invalid hunk at line {line}, {message}` for hunk-level failures.
 *
 * @since 1.0.0
 * @private
 */
export class ParseError extends Schema.TaggedError<ParseError>()("@smthrs/std/ParseError", {
  kind: Schema.Literals(["invalid_patch", "invalid_hunk"]),
  detail: Schema.String,
  lineNumber: Schema.UndefinedOr(Schema.Number)
}) {
  override get message(): string {
    return this.kind === "invalid_patch"
      ? `invalid patch: ${this.detail}`
      : `invalid hunk at line ${this.lineNumber}, ${this.detail}`
  }
}

const parseError = (kind: ParseError["kind"], detail: string, lineNumber?: number): ParseError =>
  new ParseError({ kind, detail, lineNumber })

/**
 * One replaced region of an update hunk.
 *
 * @since 1.0.0
 * @private
 */
export interface UpdateFileChunk {
  changeContext: string | undefined
  oldLines: Array<string>
  newLines: Array<string>
  isEndOfFile: boolean
}

/**
 * A parsed patch hunk.
 *
 * @since 1.0.0
 * @private
 */
export type Hunk =
  | { readonly kind: "add"; readonly path: string; contents: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
    readonly kind: "update"
    readonly path: string
    movePath: string | undefined
    readonly chunks: Array<UpdateFileChunk>
  }

/**
 * Parsed patch: hunks plus the optional environment id preamble.
 *
 * @since 1.0.0
 * @private
 */
export interface ParsedPatch {
  readonly hunks: ReadonlyArray<Hunk>
  readonly environmentId: string | undefined
}

type Mode =
  | { readonly _tag: "NotStarted" }
  | { readonly _tag: "StartedPatch" }
  | { readonly _tag: "AddFile" }
  | { readonly _tag: "DeleteFile" }
  | { readonly _tag: "UpdateFile"; readonly hunkLineNumber: number }
  | { readonly _tag: "EndedPatch" }

const invalidHunkHeader = (trimmed: string, lineNumber: number): ParseError =>
  parseError(
    "invalid_hunk",
    `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    lineNumber
  )

const unexpectedUpdateLine = (line: string, lineNumber: number): ParseError =>
  parseError(
    "invalid_hunk",
    `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
    lineNumber
  )

/**
 * Streaming line state machine for the V4A patch grammar; a faithful port of
 * `StreamingPatchParser`.
 *
 * @since 1.0.0
 * @private
 */
export class StreamingPatchParser {
  private lineBuffer = ""
  private mode: Mode = { _tag: "NotStarted" }
  private hunks: Array<Hunk> = []
  private lineNumber = 0
  private _environmentId: string | undefined

  environmentId(): string | undefined {
    return this._environmentId
  }

  private ensureUpdateHunkIsNotEmpty(line: string): void {
    const last = this.hunks[this.hunks.length - 1]
    if (last === undefined || last.kind !== "update") return
    if (last.chunks.length === 0 && this.mode._tag === "UpdateFile") {
      throw parseError(
        "invalid_hunk",
        `Update file hunk for path '${last.path}' is empty`,
        this.mode.hunkLineNumber
      )
    }
    const chunk = last.chunks[last.chunks.length - 1]
    if (chunk !== undefined && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
      if (line === END_PATCH_MARKER) {
        throw parseError("invalid_hunk", "Update hunk does not contain any lines", this.lineNumber)
      }
      throw unexpectedUpdateLine(line, this.lineNumber)
    }
  }

  private handleHunkHeadersAndEndPatch(trimmed: string): boolean {
    if (this.mode._tag === "StartedPatch" && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
      if (this._environmentId !== undefined) {
        throw parseError("invalid_patch", "apply_patch environment_id cannot be specified more than once")
      }
      const environmentId = trimmed.slice(ENVIRONMENT_ID_MARKER.length).trim()
      if (environmentId === "") {
        throw parseError("invalid_patch", "apply_patch environment_id cannot be empty")
      }
      this._environmentId = environmentId
      return true
    }
    if (trimmed === END_PATCH_MARKER) {
      this.ensureUpdateHunkIsNotEmpty(trimmed)
      this.mode = { _tag: "EndedPatch" }
      return true
    }
    if (trimmed.startsWith(ADD_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed)
      this.hunks.push({ kind: "add", path: trimmed.slice(ADD_FILE_MARKER.length), contents: "" })
      this.mode = { _tag: "AddFile" }
      return true
    }
    if (trimmed.startsWith(DELETE_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed)
      this.hunks.push({ kind: "delete", path: trimmed.slice(DELETE_FILE_MARKER.length) })
      this.mode = { _tag: "DeleteFile" }
      return true
    }
    if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed)
      this.hunks.push({
        kind: "update",
        path: trimmed.slice(UPDATE_FILE_MARKER.length),
        movePath: undefined,
        chunks: []
      })
      this.mode = { _tag: "UpdateFile", hunkLineNumber: this.lineNumber }
      return true
    }
    return false
  }

  pushDelta(delta: string): ReadonlyArray<Hunk> {
    for (const ch of delta) {
      if (ch === "\n") {
        let line = this.lineBuffer
        this.lineBuffer = ""
        if (line.endsWith("\r")) line = line.slice(0, -1)
        this.lineNumber += 1
        this.processLine(line)
      } else {
        this.lineBuffer += ch
      }
    }
    return this.hunks
  }

  finish(): ReadonlyArray<Hunk> {
    if (this.lineBuffer !== "") {
      const line = this.lineBuffer
      this.lineBuffer = ""
      this.lineNumber += 1
      if (line.trim() === END_PATCH_MARKER) {
        this.ensureUpdateHunkIsNotEmpty(line.trim())
        this.mode = { _tag: "EndedPatch" }
      } else {
        this.processLine(line)
      }
    }
    if (this.mode._tag !== "EndedPatch") {
      throw parseError("invalid_patch", "The last line of the patch must be '*** End Patch'")
    }
    return this.hunks
  }

  private lastUpdate(): Extract<Hunk, { kind: "update" }> | undefined {
    const last = this.hunks[this.hunks.length - 1]
    return last !== undefined && last.kind === "update" ? last : undefined
  }

  private processLine(line: string): void {
    const trimmed = line.trim()
    switch (this.mode._tag) {
      case "NotStarted": {
        if (trimmed === BEGIN_PATCH_MARKER) {
          this.mode = { _tag: "StartedPatch" }
          return
        }
        throw parseError("invalid_patch", "The first line of the patch must be '*** Begin Patch'")
      }
      case "StartedPatch": {
        if (this.handleHunkHeadersAndEndPatch(trimmed)) return
        throw invalidHunkHeader(trimmed, this.lineNumber)
      }
      case "AddFile": {
        if (this.handleHunkHeadersAndEndPatch(trimmed)) return
        const last = this.hunks[this.hunks.length - 1]
        if (line.startsWith("+") && last !== undefined && last.kind === "add") {
          last.contents += `${line.slice(1)}\n`
          return
        }
        throw invalidHunkHeader(trimmed, this.lineNumber)
      }
      case "DeleteFile": {
        if (this.handleHunkHeadersAndEndPatch(trimmed)) return
        throw invalidHunkHeader(trimmed, this.lineNumber)
      }
      case "UpdateFile": {
        const hunkLineNumber = this.mode.hunkLineNumber
        const updateLine = line.replace(/\s+$/, "")
        if (this.handleHunkHeadersAndEndPatch(updateLine)) return

        const hunk = this.lastUpdate()
        if (hunk !== undefined) {
          const chunks = hunk.chunks
          const lastChunk = chunks[chunks.length - 1]
          if (lastChunk !== undefined && lastChunk.isEndOfFile) {
            if (updateLine === "") return
            if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
              throw parseError(
                "invalid_hunk",
                `Expected update hunk to start with a @@ context marker, got: '${line}'`,
                this.lineNumber
              )
            }
          }

          if (chunks.length === 0 && hunk.movePath === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
            hunk.movePath = updateLine.slice(MOVE_TO_MARKER.length)
            this.mode = { _tag: "UpdateFile", hunkLineNumber }
            return
          }

          if (
            (updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) &&
            lastChunk !== undefined && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0
          ) {
            throw unexpectedUpdateLine(line, this.lineNumber)
          }

          if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
            chunks.push({ changeContext: undefined, oldLines: [], newLines: [], isEndOfFile: false })
            this.mode = { _tag: "UpdateFile", hunkLineNumber }
            return
          }

          if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
            chunks.push({
              changeContext: updateLine.slice(CHANGE_CONTEXT_MARKER.length),
              oldLines: [],
              newLines: [],
              isEndOfFile: false
            })
            this.mode = { _tag: "UpdateFile", hunkLineNumber }
            return
          }

          if (updateLine === EOF_MARKER) {
            if (lastChunk !== undefined && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
              throw parseError("invalid_hunk", "Update hunk does not contain any lines", this.lineNumber)
            }
            if (lastChunk !== undefined) lastChunk.isEndOfFile = true
            this.mode = { _tag: "UpdateFile", hunkLineNumber }
            return
          }

          const ensureChunk = (): UpdateFileChunk => {
            if (chunks.length === 0) {
              chunks.push({ changeContext: undefined, oldLines: [], newLines: [], isEndOfFile: false })
            }
            return chunks[chunks.length - 1]!
          }

          if (line === "") {
            const chunk = ensureChunk()
            chunk.oldLines.push("")
            chunk.newLines.push("")
            this.mode = { _tag: "UpdateFile", hunkLineNumber }
            return
          }
          if (line.startsWith(" ")) {
            const chunk = ensureChunk()
            chunk.oldLines.push(line.slice(1))
            chunk.newLines.push(line.slice(1))
            this.mode = { _tag: "UpdateFile", hunkLineNumber }
            return
          }
          if (line.startsWith("+")) {
            ensureChunk().newLines.push(line.slice(1))
            this.mode = { _tag: "UpdateFile", hunkLineNumber }
            return
          }
          if (line.startsWith("-")) {
            ensureChunk().oldLines.push(line.slice(1))
            this.mode = { _tag: "UpdateFile", hunkLineNumber }
            return
          }
          if (lastChunk !== undefined && (lastChunk.oldLines.length > 0 || lastChunk.newLines.length > 0)) {
            throw parseError(
              "invalid_hunk",
              `Expected update hunk to start with a @@ context marker, got: '${line}'`,
              this.lineNumber
            )
          }
        }
        throw unexpectedUpdateLine(line, this.lineNumber)
      }
      case "EndedPatch": {
        if (trimmed === "") return
        throw parseError("invalid_patch", "The last line of the patch must be '*** End Patch'")
      }
    }
  }
}

const checkStartAndEndLinesStrict = (firstLine: string | undefined, lastLine: string | undefined): void => {
  const first = firstLine?.trim()
  const last = lastLine?.trim()
  if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return
  if (first !== undefined && first !== BEGIN_PATCH_MARKER) {
    throw parseError("invalid_patch", "The first line of the patch must be '*** Begin Patch'")
  }
  throw parseError("invalid_patch", "The last line of the patch must be '*** End Patch'")
}

const checkPatchBoundariesStrict = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  checkStartAndEndLinesStrict(lines[0], lines.length === 0 ? undefined : lines[lines.length - 1])
  return lines
}

const checkPatchBoundariesLenient = (originalLines: ReadonlyArray<string>): ReadonlyArray<string> => {
  let originalError: ParseError
  try {
    return checkPatchBoundariesStrict(originalLines)
  } catch (error) {
    originalError = error as ParseError
  }
  if (originalLines.length >= 2) {
    const first = originalLines[0]!
    const last = originalLines[originalLines.length - 1]!
    if (
      (first === "<<EOF" || first === "<<'EOF'" || first === "<<\"EOF\"") &&
      last.endsWith("EOF") && originalLines.length >= 4
    ) {
      return checkPatchBoundariesStrict(originalLines.slice(1, -1))
    }
  }
  throw originalError
}

/**
 * Parse a complete patch text; lenient mode (heredoc unwrapping) is always
 * on, matching Codex.
 *
 * @since 1.0.0
 * @private
 */
export const parsePatch = (patch: string): ParsedPatch => {
  const trimmed = patch.trim()
  const lines = trimmed === "" ? [] : trimmed.split("\n")
  const patchLines = checkPatchBoundariesLenient(lines)
  const parser = new StreamingPatchParser()
  parser.pushDelta(`${patchLines.join("\n")}\n`)
  const hunks = parser.finish()
  return { hunks, environmentId: parser.environmentId() }
}

const normalise = (s: string): string =>
  [...s.trim()].map((c) => {
    switch (c) {
      case "‐":
      case "‑":
      case "‒":
      case "–":
      case "—":
      case "―":
      case "−":
        return "-"
      case "‘":
      case "’":
      case "‚":
      case "‛":
        return "'"
      case "“":
      case "”":
      case "„":
      case "‟":
        return "\""
      case " ":
      case " ":
      case " ":
      case " ":
      case " ":
      case " ":
      case " ":
      case " ":
      case " ":
      case " ":
      case " ":
      case " ":
      case "　":
        return " "
      default:
        return c
    }
  }).join("")

/**
 * Fuzzy sequence search with the Codex leniency ladder: exact, rstrip, trim,
 * then unicode-normalised comparison; end-of-file patterns anchor at the end
 * first.
 *
 * @since 1.0.0
 * @private
 */
export const seekSequence = (
  lines: ReadonlyArray<string>,
  pattern: ReadonlyArray<string>,
  start: number,
  eof: boolean
): number | undefined => {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return undefined
  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start
  const upper = lines.length - pattern.length
  const passes: ReadonlyArray<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.replace(/\s+$/, "") === b.replace(/\s+$/, ""),
    (a, b) => a.trim() === b.trim(),
    (a, b) => normalise(a) === normalise(b)
  ]
  for (const equals of passes) {
    for (let i = searchStart; i <= upper; i++) {
      let ok = true
      for (let p = 0; p < pattern.length; p++) {
        if (!equals(lines[i + p]!, pattern[p]!)) {
          ok = false
          break
        }
      }
      if (ok) return i
    }
  }
  return undefined
}

/**
 * Applier failure carrying the Codex message text verbatim.
 *
 * `context_not_found` is an `@@` context line absent from the file;
 * `lines_not_found` is a chunk whose expected lines are absent.
 *
 * @since 1.0.0
 * @private
 */
export class ComputeReplacementsError extends Schema.TaggedError<ComputeReplacementsError>()(
  "@smthrs/std/ComputeReplacementsError",
  {
    reason: Schema.Literals(["context_not_found", "lines_not_found"]),
    path: Schema.String,
    message: Schema.String
  }
) {}

type Replacement = readonly [startIndex: number, oldLength: number, newLines: ReadonlyArray<string>]

const computeReplacements = (
  originalLines: ReadonlyArray<string>,
  path: string,
  chunks: ReadonlyArray<UpdateFileChunk>
): Array<Replacement> => {
  const replacements: Array<Replacement> = []
  let lineIndex = 0

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const idx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false)
      if (idx === undefined) {
        throw new ComputeReplacementsError({
          reason: "context_not_found",
          path,
          message: `Failed to find context '${chunk.changeContext}' in ${path}`
        })
      }
      lineIndex = idx + 1
    }

    if (chunk.oldLines.length === 0) {
      const insertionIdx = originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
        ? originalLines.length - 1
        : originalLines.length
      replacements.push([insertionIdx, 0, [...chunk.newLines]])
      continue
    }

    let pattern: ReadonlyArray<string> = chunk.oldLines
    let newSlice: ReadonlyArray<string> = chunk.newLines
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)

    if (found === undefined && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1)
      if (newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1)
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)
    }

    if (found !== undefined) {
      replacements.push([found, pattern.length, [...newSlice]])
      lineIndex = found + pattern.length
    } else {
      throw new ComputeReplacementsError({
        reason: "lines_not_found",
        path,
        message: `Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`
      })
    }
  }

  replacements.sort((a, b) => a[0] - b[0])
  return replacements
}

const applyReplacements = (lines: Array<string>, replacements: ReadonlyArray<Replacement>): Array<string> => {
  for (let r = replacements.length - 1; r >= 0; r--) {
    const [startIdx, oldLength, newSegment] = replacements[r]!
    lines.splice(startIdx, Math.min(oldLength, Math.max(lines.length - startIdx, 0)), ...newSegment)
  }
  return lines
}

/**
 * Derive the new file contents for an update hunk from the original
 * contents, matching Codex `derive_new_contents_from_chunks`.
 *
 * @since 1.0.0
 * @private
 */
export const deriveNewContents = (
  originalContents: string,
  path: string,
  chunks: ReadonlyArray<UpdateFileChunk>
): string => {
  const originalLines = sourceLines(originalContents)
  const replacements = computeReplacements(originalLines, path, chunks)
  const newLines = applyReplacements([...originalLines], replacements)
  if (newLines[newLines.length - 1] !== "") newLines.push("")
  return newLines.join("\n")
}

/**
 * Render the Codex success summary: `Success. Updated the following files:`
 * with `A`/`M`/`D` lines for adds, updates, and deletes in that order.
 *
 * @since 1.0.0
 * @private
 */
export const printSummary = (affected: {
  readonly added: ReadonlyArray<string>
  readonly modified: ReadonlyArray<string>
  readonly deleted: ReadonlyArray<string>
}): string => {
  const lines = ["Success. Updated the following files:"]
  for (const path of affected.added) lines.push(`A ${path}`)
  for (const path of affected.modified) lines.push(`M ${path}`)
  for (const path of affected.deleted) lines.push(`D ${path}`)
  return `${lines.join("\n")}\n`
}
