/**
 * The `rg`-process implementation of the ripgrep search contract.
 *
 * @since 1.0.0
 */

import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Path from "@smthrs/kernel/Path"
import { type Context, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Exec from "./internal/Exec.ts"
import * as Grouping from "./internal/Grouping.ts"
import { notice, truncateBytes } from "./internal/Text.ts"
import * as Walk from "./internal/Walk.ts"
import * as Search from "./Search.ts"
import * as Contract from "./SearchContract.ts"
import * as StdError from "./StdError.ts"

/**
 * Maximum bytes captured from either stream across one search operation.
 *
 * Native search refuses an overflow instead of truncating because a partial
 * ripgrep stream could make it disagree with the portable peer. The 64 MiB
 * bound is well above real repository listings: 400,000 paths occupy roughly
 * 16 MiB in a typical `rg --files` stream.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_CAPTURE_BYTES = 67_108_864

interface RgResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const execute = (
  cwd: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> | undefined
): Effect.Effect<RgResult, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner> =>
  Exec.exec("rg", { args, cwd, env: environment, maxCaptureBytes: MAX_CAPTURE_BYTES, overflow: "refuse" }).pipe(
    Effect.mapError((error) =>
      new StdError.StdError({
        code: error.code === "capture_overflow" ? "command_failed" : "provider_unavailable",
        message: error.code === "capture_overflow"
          ? error.message
          : "The native ripgrep implementation could not start rg"
      })
    )
  )

// Only .gitignore within the requested root participates. Disable user config,
// parent/global rules and other ignore sources so the result is host independent.
const ignoreFlags = (noIgnore: boolean | undefined): ReadonlyArray<string> => [
  "--no-config",
  "--no-require-git",
  "--no-ignore-global",
  "--no-ignore-parent",
  "--no-ignore-exclude",
  "--no-ignore-dot",
  ...(noIgnore ? ["--no-ignore"] : [])
]

/**
 * Reports what `rg` rejected, or `undefined` when it produced an answer.
 *
 * Exit status 2 means only "an error occurred", and a walk hits those
 * routinely: a dangling symlink, a symlink loop, a directory the process may
 * not list. `--no-messages` suppresses exactly those, leaving stderr empty and
 * the results on stdout complete for everything `rg` could reach — the same
 * entries the in-process peer skips, so the peers still agree. A fatal error —
 * an unparsable glob, a rejected expression, a killed process — always writes
 * to stderr, which `--no-messages` does not touch. Stderr is therefore the
 * discriminator, and the exit status alone is not.
 */
const rejection = (result: RgResult): string | undefined => {
  const message = result.stderr.trim()
  return result.exitCode > 1 && message.length > 0 ? message : undefined
}

const nulSeparated = (stdout: string): ReadonlyArray<string> => stdout.split("\0").filter((value) => value.length > 0)

const preview = (line: string): string => {
  const withoutTerminator = line.replace(/\r?\n$/, "")
  const characters = Array.from(withoutTerminator)
  return truncateBytes(characters.length > 500 ? characters.slice(0, 500).join("") : withoutTerminator, 500, {
    keep: "head"
  }).text
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined

const textAt = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  const nested = asRecord(record?.[key])
  return typeof nested?.text === "string" ? nested.text : undefined
}

const malformedJson = (): StdError.StdError =>
  new StdError.StdError({ code: "request_failed", message: "rg returned malformed JSON" })

// rg releases differ on some gitignore grammar (for example BOMs and
// unclosed character classes in 14 versus 15). Select paths through the same
// walk as portable, then name them explicitly to rg. This also prevents a
// positive caller glob from overriding ignore rules or scanning unrelated files.
const resolveRoot = (
  input: Search.GrepInput | Search.GlobInput,
  globs: ReadonlyArray<string>
): Effect.Effect<
  {
    readonly cwd: string
    readonly targets: ReadonlyArray<string>
    readonly explicitFile: boolean
    readonly ignored: boolean
    readonly absolute: (value: string) => string
  },
  StdError.StdError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const included = (relative: string, basename: string) => Contract.includedByGlobs(globs, relative, basename)
    const walked = yield* Walk.files(fileSystem, path, input.root, input.hidden, input.noIgnore, included)
    const cwd = walked.explicitFile ? path.dirname(input.root) : input.root
    const selected = walked.explicitFile ?
      walked.files :
      walked.files.filter((file) => included(Walk.relativeForPattern(path, input.root, file), path.basename(file)))
    const links = walked.explicitFile ? [] : yield* Walk.symbolicLinks(fileSystem, selected)
    return {
      cwd,
      targets: selected.filter((_, index) => links[index] !== true).map((file) => path.relative(cwd, file)),
      explicitFile: walked.explicitFile,
      ignored: walked.ignored,
      absolute: (value: string) => path.normalize(path.join(cwd, value.replace(/^\.\//, "")))
    }
  })

// Stay well below OS argv limits, including on trees with long UTF-8 names.
// Only one batch per operation is live, and the aggregate capture keeps the
// same refusal bound as a single invocation.
const executeFiles = (
  cwd: string,
  args: ReadonlyArray<string>,
  targets: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> | undefined
): Effect.Effect<RgResult, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (targets.length === 0) {
      return {
        stdout: args.includes("--json")
          ? `${JSON.stringify({ type: "summary", data: { stats: { searches: 0 } } })}\n`
          : "",
        stderr: "",
        exitCode: 0
      }
    }
    const encoder = new TextEncoder()
    const batches: Array<Array<string>> = []
    let batch: Array<string> = []
    let size = 0
    for (const target of targets) {
      const bytes = encoder.encode(target).length + 1
      if (batch.length > 0 && (batch.length >= 256 || size + bytes > 32_768)) {
        batches.push(batch)
        batch = []
        size = 0
      }
      batch.push(target)
      size += bytes
    }
    if (batch.length > 0) batches.push(batch)
    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0
    let stderrBytes = 0
    let exitCode = 0
    for (const batch of batches) {
      const result = yield* execute(cwd, [...args, ...batch], environment)
      if (rejection(result) !== undefined) return result
      stdoutBytes += encoder.encode(result.stdout).length
      stderrBytes += encoder.encode(result.stderr).length
      if (stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES) {
        return yield* Effect.fail(
          new StdError.StdError({
            code: "command_failed",
            message: `rg ${
              stdoutBytes > MAX_CAPTURE_BYTES ? "stdout" : "stderr"
            } exceeded the ${MAX_CAPTURE_BYTES}-byte capture cap`
          })
        )
      }
      stdout += result.stdout
      stderr += result.stderr
      exitCode = Math.max(exitCode, result.exitCode)
    }
    return { stdout, stderr, exitCode }
  })

const pathOrder = (left: Search.GrepLine, right: Search.GrepLine): number =>
  left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line

/**
 * Holds `maxCount` to the per-file match budget the contract states.
 *
 * `rg` labels an after-context line as a `match` when that line matches too,
 * so `--max-count 2 --after-context 1` over three consecutive matching lines
 * prints three `match` rows — measured against ripgrep 14.1.1. The in-process
 * peer stops counting at the budget and carries the surplus line as context,
 * and the generated conformance run found the two peers answering that call
 * differently on four seeds. The surplus rows are demoted rather than dropped,
 * because the caller asked for that context and `rg` did print it. Rows arrive
 * sorted by file and line, so counting in order is counting per file.
 */
const capMatches = (
  lines: ReadonlyArray<Search.GrepLine>,
  maxCount: number | undefined
): ReadonlyArray<Search.GrepLine> => {
  if (maxCount === undefined) return lines
  const counted = new Map<string, number>()
  return lines.map((line) => {
    if (line.kind !== "match") return line
    const seen = counted.get(line.file) ?? 0
    counted.set(line.file, seen + 1)
    return seen < maxCount ? line : { ...line, kind: "context" as const }
  })
}

const grep = (
  input: Search.GrepInput,
  environment: Readonly<Record<string, string>> | undefined
): Effect.Effect<
  Search.GrepOutput,
  StdError.StdError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* resolveRoot(input, input.globs)
    const args: Array<string> = [
      "--json",
      "--stats",
      ...ignoreFlags(input.noIgnore),
      "--no-messages",
      "--sort",
      "path",
      "--encoding=utf-8",
      "--crlf"
    ]
    if (input.hidden) args.push("--hidden")
    if (input.fixedStrings) args.push("--fixed-strings")
    // `rg` documents `--smart-case` as overriding `--ignore-case`, so passing
    // both makes an uppercase pattern case-SENSITIVE. The in-process peer reads
    // the pair the other way round — `ignoreCase || (smartCase && no uppercase)`
    // — because an explicit request beats a heuristic. `Grep.run` refuses the
    // combination outright, but a host binding `Search` directly never reaches
    // that check, and the generated conformance run found the two peers
    // answering seven seeds differently through it.
    if (input.ignoreCase) args.push("--ignore-case")
    else if (input.smartCase) args.push("--smart-case")
    if (input.beforeContext > 0) args.push("--before-context", String(input.beforeContext))
    if (input.afterContext > 0) args.push("--after-context", String(input.afterContext))
    if (input.maxCount !== undefined) args.push("--max-count", String(input.maxCount))
    args.push("--", input.pattern)

    const binaryArgs: Array<string> = [
      "--files-with-matches",
      "--text",
      "--null",
      ...ignoreFlags(input.noIgnore),
      "--no-messages",
      "--sort",
      "path"
    ]
    if (input.hidden) binaryArgs.push("--hidden")
    binaryArgs.push("--", "\\x00")

    const [result, binaryResult] = yield* Effect.all(
      [
        executeFiles(root.cwd, args, root.targets, environment),
        executeFiles(root.cwd, binaryArgs, root.targets, environment)
      ],
      { concurrency: "unbounded" }
    )
    for (const outcome of [result, binaryResult]) {
      const message = rejection(outcome)
      if (message !== undefined) {
        return yield* Effect.fail(new StdError.StdError({ code: "request_failed", message }))
      }
    }
    const binaryFiles = new Set(nulSeparated(binaryResult.stdout).map(root.absolute))
    if (root.explicitFile && binaryFiles.size > 0) {
      return yield* Effect.fail(
        new StdError.StdError({
          code: "binary_file",
          message: `Cannot search binary file: ${input.root}`,
          path: input.root
        })
      )
    }

    const lines: Array<Search.GrepLine> = []
    const files = new Set<string>()
    let sawSummary = false
    for (const encoded of result.stdout.split("\n")) {
      if (encoded.length === 0) continue
      let event: Record<string, unknown>
      try {
        const decoded = JSON.parse(encoded) as unknown
        const record = asRecord(decoded)
        if (record === undefined) return yield* Effect.fail(malformedJson())
        event = record
      } catch {
        return yield* Effect.fail(malformedJson())
      }
      const type = event.type
      const data = asRecord(event.data)
      if (type === "match" || type === "context") {
        const file = textAt(data, "path")
        const text = textAt(data, "lines")
        const line = data?.line_number
        if (file === undefined || text === undefined || typeof line !== "number") {
          return yield* Effect.fail(malformedJson())
        }
        const absolute = root.absolute(file)
        files.add(absolute)
        lines.push({ file: absolute, line, text: preview(text), kind: type })
      } else if (type === "begin") {
        if (textAt(data, "path") === undefined) return yield* Effect.fail(malformedJson())
      } else if (type === "end") {
        if (
          textAt(data, "path") === undefined ||
          (data?.binary_offset !== null && typeof data?.binary_offset !== "number")
        ) return yield* Effect.fail(malformedJson())
      } else if (type === "summary") {
        const stats = asRecord(data?.stats)
        if (typeof stats?.searches !== "number") return yield* Effect.fail(malformedJson())
        sawSummary = true
      } else return yield* Effect.fail(malformedJson())
    }
    if (!sawSummary) return yield* Effect.fail(malformedJson())
    for (const file of binaryFiles) files.delete(file)
    const visibleLines = capMatches(
      lines.filter((line) => !binaryFiles.has(line.file)).sort(pathOrder),
      input.maxCount
    )
    const grouped = input.filesWithMatches ? [] : Grouping.group(visibleLines)
    const entries = input.filesWithMatches ? [...files].sort() : grouped
    const truncated = entries.length > input.limit
    const shown = grouped.slice(0, input.limit)
    // `rg` reports lines, not files, so the enclosing definition costs one read
    // of each file whose hits survived the limit — never one per file searched.
    const contents = new Map<string, ReadonlyArray<string>>()
    if (input.symbols) {
      for (const file of new Set(shown.map((match) => match.file))) {
        const bytes = yield* Effect.orElseSucceed(fileSystem.readFile(file), () => undefined)
        if (bytes !== undefined) contents.set(file, Grouping.sourceLines(new TextDecoder().decode(bytes)))
      }
    }
    const unsatisfiable = entries.length > 0 ? undefined : yield* Contract.unsatisfiableNotice({
      fileSystem,
      path,
      root: input.root,
      globs: input.globs,
      hidden: input.hidden,
      noIgnore: input.noIgnore,
      ignored: root.ignored
    })
    return {
      matches: Grouping.annotate(shown, contents),
      files: input.filesWithMatches ? [...files].sort().slice(0, input.limit) : [],
      filesSearched: root.targets.length,
      skippedBinary: binaryFiles.size,
      truncated,
      ...(truncated
        ? { notice: notice(input.filesWithMatches ? "files" : "matches", input.limit, entries.length) }
        : {}),
      ...(unsatisfiable === undefined ? {} : { notice: unsatisfiable })
    }
  })

const glob = (
  input: Search.GlobInput,
  environment: Readonly<Record<string, string>> | undefined
): Effect.Effect<
  Search.GlobOutput,
  StdError.StdError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* resolveRoot(input, [input.pattern])
    const args: Array<string> = ["--files", "--null", ...ignoreFlags(input.noIgnore), "--no-messages", "--sort", "path"]
    if (input.hidden) args.push("--hidden")
    args.push("--")
    const result = yield* executeFiles(root.cwd, args, root.targets, environment)
    const rejected = rejection(result)
    if (rejected !== undefined) {
      return yield* Effect.fail(new StdError.StdError({ code: "invalid_pattern", message: rejected }))
    }
    const paths = nulSeparated(result.stdout).map(root.absolute).filter((file) =>
      root.explicitFile ||
      Contract.includedByGlobs([input.pattern], Walk.relativeForPattern(path, input.root, file), path.basename(file))
    ).sort()
    const shown = paths.slice(0, input.limit)
    const unsatisfiable = paths.length > 0 ? undefined : yield* Contract.unsatisfiableNotice({
      fileSystem,
      path,
      root: input.root,
      globs: [input.pattern],
      hidden: input.hidden,
      noIgnore: input.noIgnore,
      ignored: root.ignored
    })
    return {
      paths: shown,
      total: paths.length,
      truncated: paths.length > input.limit,
      ...(paths.length > input.limit ? { notice: notice("entries", shown.length, paths.length) } : {}),
      ...(unsatisfiable === undefined ? {} : { notice: unsatisfiable })
    }
  })

/**
 * Captures filesystem, path and process services in the native peer.
 * Optional environment declarations overlay the host child-process allowlist.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  services: Context.Context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>,
  environment?: Readonly<Record<string, string>>
): Search.Search =>
  Search.make({
    grep: (input) => Effect.provide(grep(input, environment), services),
    glob: (input) => Effect.provide(glob(input, environment), services)
  })

/**
 * Provides the `rg`-driven peer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  Search.Search,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  Search.Search,
  Effect.map(Effect.context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>(), make)
)
