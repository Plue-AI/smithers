/**
 * The in-process implementation of the ripgrep search contract.
 *
 * @since 1.0.0
 */

import * as Path from "@smthrs/kernel/Path"
import { type Context, Effect, Layer, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Grouping from "./internal/Grouping.ts"
import * as LinearRegex from "./internal/LinearRegex.ts"
import { escapeRegex } from "./internal/SearchContract.ts"
import { notice, truncateBytes } from "./internal/Text.ts"
import * as Walk from "./internal/Walk.ts"
import * as Search from "./Search.ts"
import * as Contract from "./SearchContract.ts"
import * as StdError from "./StdError.ts"

/**
 * Narrows a walk to the files a search reports.
 *
 * A root that names one file is that file: `rg` searches a path given on the
 * command line whatever `-g` says, and follows it even when it is a symlink.
 * Everything a walk found is filtered by the globs first and probed for
 * symlinks second, so the probe runs over the far smaller included set.
 */
const candidates = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  walked: Walk.Walked,
  root: string,
  globs: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function*() {
    if (walked.explicitFile) return walked.files
    const included = walked.files.filter((file) =>
      Contract.includedByGlobs(globs, Walk.relativeForPattern(path, root, file), path.basename(file))
    )
    const links = yield* Walk.symbolicLinks(fileSystem, included)
    return included.filter((_, index) => links[index] !== true)
  })

const preview = (line: string): string => {
  let head = ""
  let length = 0
  for (const character of line) {
    if (length++ === 500) break
    head += character
  }
  return truncateBytes(head, 500, { keep: "head" }).text
}

const grep = (
  input: Search.GrepInput
): Effect.Effect<Search.GrepOutput, StdError.StdError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const includedByGlobs = (relative: string, basename: string) =>
      Contract.includedByGlobs(input.globs, relative, basename)
    const walked = yield* Walk.files(fileSystem, path, input.root, input.hidden, input.noIgnore, includedByGlobs)
    const insensitive = input.ignoreCase || (input.smartCase && !/[A-Z]/.test(input.pattern))
    const regex = LinearRegex.compile(
      input.fixedStrings ? escapeRegex(input.pattern) : input.pattern,
      insensitive
    )
    const shownMatches: Array<Search.GrepMatch> = []
    const shownFiles: Array<string> = []
    let total = 0
    let filesSearched = 0
    let skippedBinary = 0

    const included = yield* candidates(fileSystem, path, walked, input.root, input.globs)
    for (const file of included) {
      // Count every admitted file, including unreadable files and binaries.
      filesSearched++
      const remaining = input.filesWithMatches ? 0 : input.limit - shownMatches.length
      const matched: Array<number> = []
      const selected = new Map<number, Search.GrepLine>()
      const recent = new Map<number, Search.GrepLine>()
      let count = 0
      let lineNumber = 0
      let through = 0
      const scanLine = (text: string) =>
        Effect.gen(function*() {
          lineNumber++
          let matches = false
          if (input.maxCount === undefined || count < input.maxCount) {
            const evaluation = regex.test(text)
            let step = evaluation.next()
            while (!step.done) {
              yield* Effect.yieldNow
              step = evaluation.next()
            }
            matches = step.value
          }
          if (matches) count++
          if (remaining <= 0) return
          // The first overflow hit is a boundary: context nearest to it must
          // not migrate to the last retained hit when the limit is applied.
          const retain = matches && matched.length < remaining + 1
          const awaiting = matched.length < remaining + 1
          if (retain || lineNumber <= through || (awaiting && input.beforeContext > 0)) {
            const row: Search.GrepLine = {
              file,
              line: lineNumber,
              text: preview(text),
              kind: retain ? "match" : "context"
            }
            if (retain) {
              matched.push(lineNumber)
              for (const [number, context] of recent) selected.set(number, context)
              through = lineNumber + input.afterContext
            }
            if (retain || lineNumber <= through) selected.set(lineNumber, row)
            if (awaiting && input.beforeContext > 0) recent.set(lineNumber, row)
          }
          recent.delete(lineNumber - input.beforeContext)
          if (matched.length >= remaining + 1) recent.clear()
        })
      // Split only on LF (stripping a preceding CR), just like sourceLines.
      // Stream.splitLines also treats a standalone CR as a delimiter.
      const decoder = new TextDecoder()
      let fragments: Array<string> = []
      const consume = (chunk: string) =>
        Effect.gen(function*() {
          let from = 0
          let newline = chunk.indexOf("\n")
          while (newline >= 0) {
            fragments.push(chunk.slice(from, newline))
            const line = fragments.join("")
            fragments = []
            yield* scanLine(line.endsWith("\r") ? line.slice(0, -1) : line)
            from = newline + 1
            newline = chunk.indexOf("\n", from)
          }
          if (from < chunk.length) fragments.push(chunk.slice(from))
        })
      const scanned = yield* Effect.gen(function*() {
        let started = false
        // A guarded disk host can safely expose atomic reads while refusing
        // open streaming handles. Retry through that same filesystem service
        // only before any bytes arrive, so a failed partial stream is never
        // combined with a second reading of a file that may have changed.
        yield* fileSystem.stream(file).pipe(
          Stream.catch((error) => started ? Stream.fail(error) : Stream.fromEffect(fileSystem.readFile(file))),
          Stream.runForEach((bytes) => {
            started = true
            if (bytes.includes(0)) {
              return Effect.fail(
                new StdError.StdError({
                  code: "binary_file",
                  message: `Cannot search binary file: ${file}`,
                  path: file
                })
              )
            }
            return consume(decoder.decode(bytes, { stream: true }))
          })
        )
        yield* consume(decoder.decode())
        if (fragments.length > 0) yield* scanLine(fragments.join(""))
        return true
      }).pipe(Effect.catch((error) => {
        if (error instanceof StdError.StdError) {
          if (walked.explicitFile) return Effect.fail(error)
          skippedBinary++
        }
        return Effect.succeed(false)
      }))
      if (!scanned || count === 0) continue
      total += input.filesWithMatches ? 1 : count
      if (input.filesWithMatches) {
        if (shownFiles.length < input.limit) shownFiles.push(file)
        continue
      }
      if (matched.length === 0) continue
      const grouped = Grouping.group([...selected.values()].sort((left, right) => left.line - right.line))
        .slice(0, remaining)
      // Source is needed only for returned symbols, and is released before
      // moving to the next file. Overflow files never load symbol source.
      const contents = new Map<string, ReadonlyArray<string>>()
      if (input.symbols) {
        const source = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))
        if (source !== undefined) contents.set(file, Grouping.sourceLines(source))
      }
      shownMatches.push(...Grouping.annotate(grouped, contents))
    }

    const truncated = total > input.limit
    const unsatisfiable = total > 0 ? undefined : yield* Contract.unsatisfiableNotice({
      fileSystem,
      path,
      root: input.root,
      globs: input.globs,
      hidden: input.hidden,
      noIgnore: input.noIgnore,
      ignored: walked.ignored
    })
    return {
      matches: shownMatches,
      files: shownFiles,
      filesSearched,
      skippedBinary,
      truncated,
      ...(truncated
        ? { notice: notice(input.filesWithMatches ? "files" : "matches", input.limit, total) }
        : {}),
      ...(unsatisfiable === undefined ? {} : { notice: unsatisfiable })
    }
  })

const glob = (
  input: Search.GlobInput
): Effect.Effect<Search.GlobOutput, StdError.StdError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const includedByGlobs = (relative: string, basename: string) =>
      Contract.includedByGlobs([input.pattern], relative, basename)
    const walked = yield* Walk.files(fileSystem, path, input.root, input.hidden, input.noIgnore, includedByGlobs)
    const included = yield* candidates(fileSystem, path, walked, input.root, [input.pattern])
    const matching = [...included].sort()
    const paths = matching.slice(0, input.limit)
    const unsatisfiable = matching.length > 0 ? undefined : yield* Contract.unsatisfiableNotice({
      fileSystem,
      path,
      root: input.root,
      globs: [input.pattern],
      hidden: input.hidden,
      noIgnore: input.noIgnore,
      ignored: walked.ignored
    })
    return {
      paths,
      total: matching.length,
      truncated: matching.length > input.limit,
      ...(matching.length > input.limit ? { notice: notice("entries", paths.length, matching.length) } : {}),
      ...(unsatisfiable === undefined ? {} : { notice: unsatisfiable })
    }
  })

/**
 * Captures filesystem and path services in the portable peer.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (services: Context.Context<FileSystem.FileSystem | Path.Path>): Search.Search =>
  Search.make({
    grep: (input) => Effect.provide(grep(input), services),
    glob: (input) => Effect.provide(glob(input), services)
  })

/**
 * Provides the in-process peer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Search.Search, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  Search.Search,
  Effect.map(Effect.context<FileSystem.FileSystem | Path.Path>(), make)
)
