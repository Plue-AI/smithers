/**
 * Built-in deterministic scorers over text, unified diffs and sandbox commands.
 * @since 0.1.0
 */
import type { Session } from "@smthrs/sandbox/Sandbox"
import { Effect, Stream } from "effect"
import * as Rubric from "./Rubric.ts"
import * as Scorer from "./Scorer.ts"
import { ScorerError } from "./ScorerError.ts"

const invalid = (message: string) => new ScorerError({ code: "invalid_declaration", message })
const inconclusive = (message: string) => new ScorerError({ code: "inconclusive", message })
const text = (value: unknown): Effect.Effect<string, ScorerError> =>
  typeof value === "string" ? Effect.succeed(value) : Effect.fail(inconclusive("Scorer requires text"))
const normalize = (value: string) => value.trim().replace(/\s+/g, " ")

/** Normalized text equality: trims edges and collapses whitespace. @category scorers @since 0.1.0 */
export const exact = () =>
  Scorer.make({
    id: "smithers/scorers/exact",
    version: "1",
    name: "exact",
    score: ({ output, groundTruth }) =>
      Effect.gen(function*() {
        const actual = normalize(yield* text(output)), expected = normalize(yield* text(groundTruth))
        return { score: actual === expected ? 1 : 0, reason: actual === expected ? "Text matches" : "Text differs" }
      })
  })

/** Case-sensitive containment of the ground-truth text. @category scorers @since 0.1.0 */
export const contains = () =>
  Scorer.make({
    id: "smithers/scorers/contains",
    version: "1",
    name: "contains",
    score: ({ output, groundTruth }) =>
      Effect.gen(function*() {
        const actual = yield* text(output), expected = yield* text(groundTruth)
        return { score: actual.includes(expected) ? 1 : 0 }
      })
  })

/** Existing model-agnostic 1 to 5 rubric scorer. @category scorers @since 0.1.0 */
export const rubric = Rubric.make

/** A command in an already acquired sandbox session. @category models @since 0.1.0 */
export interface TestsPassOptions {
  readonly command: string
  readonly sandbox: Pick<Session, "spawn">
  /** Bounds command execution, including output drains. Default: 60 seconds. */
  readonly timeoutMs?: number
}

/** Exit zero passes; nonzero fails; launch, transport and timeout failures are inconclusive. @category scorers @since 0.1.0 */
export const testsPass = (options: TestsPassOptions) => {
  const { command, sandbox } = options, timeoutMs = options.timeoutMs ?? 60_000
  if (!command.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw invalid("testsPass requires a command and positive integer timeoutMs")
  }
  return Scorer.make({
    id: "smithers/scorers/tests-pass",
    version: "1",
    name: "testsPass",
    config: { command, timeoutMs },
    score: () =>
      Effect.scoped(Effect.gen(function*() {
        const process = yield* sandbox.spawn(command, {})
        const [exitCode] = yield* Effect.all([
          process.exitCode,
          Stream.runDrain(process.stdout),
          Stream.runDrain(process.stderr)
        ], { concurrency: "unbounded" })
        if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
          return yield* inconclusive("Sandbox returned no valid exit code")
        }
        return { score: exitCode === 0 ? 1 : 0, reason: `Command exited ${exitCode}`, meta: { exitCode } }
      })).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError(() => inconclusive("Sandbox test command could not complete"))
      )
  })
}

/** Inclusive diff budget. @category models @since 0.1.0 */
export interface DiffOptions {
  readonly max: number
}

interface DiffCounts {
  readonly added: number
  readonly removed: number
  readonly files: number
}
// Git quotes non-ASCII paths with UTF-8 octal bytes. Decode those without
// conflating separate spellings of the same touched path.
const path = (header: string): string => {
  const raw = header.startsWith("\"") ? header : header.split("\t")[0]!
  if (!raw.startsWith("\"")) return raw
  const bytes: number[] = []
  for (let index = 1; index < raw.length - 1; index++) {
    const char = raw[index]!
    if (char !== "\\") {
      const codePoint = raw.codePointAt(index)!
      bytes.push(...new TextEncoder().encode(String.fromCodePoint(codePoint)))
      if (codePoint > 0xffff) index++
    } else {
      const octal = raw.slice(index + 1, index + 4)
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8))
        index += 3
      } else {
        const escaped = raw[++index]!,
          simple: Record<string, string> = {
            a: "\x07",
            b: "\b",
            t: "\t",
            n: "\n",
            v: "\v",
            f: "\f",
            r: "\r",
            "\"": "\"",
            "\\": "\\"
          }
        if (!(escaped in simple)) throw inconclusive("Invalid quoted diff path")
        bytes.push(...new TextEncoder().encode(simple[escaped]!))
      }
    }
  }
  if (!raw.endsWith("\"")) throw inconclusive("Invalid quoted diff path")
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes))
}
const countDiff = (diff: string): DiffCounts => {
  let added = 0, removed = 0, old = 0, next = 0, oldPath: string | undefined, newPath: string | undefined
  let pendingHeaders = false
  const files = new Set<string>()
  const touch = () => {
    const value = newPath === "/dev/null" ? oldPath : newPath
    if (value === undefined || value === "/dev/null") throw inconclusive("Diff hunk has no file headers")
    files.add(value.replace(/^[ab]\//, ""))
  }
  for (const line of diff.split(/\r?\n/)) {
    if (old > 0 || next > 0) {
      if (line === "\\ No newline at end of file") continue
      if (line.startsWith("+") && next > 0) {
        added++
        next--
      } else if (line.startsWith("-") && old > 0) {
        removed++
        old--
      } else if (line.startsWith(" ") && old > 0 && next > 0) {
        old--
        next--
      } else throw inconclusive("Incomplete unified diff hunk")
      continue
    }
    if (line.startsWith("diff --git ")) {
      if (pendingHeaders) throw inconclusive("Diff file has no unified headers")
      pendingHeaders = true
      oldPath = undefined
      newPath = undefined
    } else if (line.startsWith("--- ")) oldPath = path(line.slice(4))
    else if (line.startsWith("+++ ")) {
      newPath = path(line.slice(4))
      touch()
      pendingHeaders = false
    } else if (line.startsWith("@@ ")) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
      if (hunk === null) throw inconclusive("Invalid unified diff hunk")
      old = hunk[1] === undefined ? 1 : Number(hunk[1])
      next = hunk[2] === undefined ? 1 : Number(hunk[2])
      if (!Number.isSafeInteger(old) || !Number.isSafeInteger(next)) throw inconclusive("Invalid unified diff size")
      touch()
    } else if (
      /^(index |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to )/.test(
        line
      )
    ) {
      pendingHeaders = true
    } else if (line === "" || line === "\\ No newline at end of file") {
      continue
    } else throw inconclusive("Scorer requires a text unified diff")
  }
  if (pendingHeaders) throw inconclusive("Diff file has no unified headers")
  if (old !== 0 || next !== 0) throw inconclusive("Incomplete unified diff hunk")
  return { added, removed, files: files.size }
}
const diffScorer = (name: "diffSize" | "touchedFiles", options: DiffOptions) => {
  const max = options.max
  if (!Number.isSafeInteger(max) || max < 0) throw invalid("Diff budget max must be a nonnegative safe integer")
  return Scorer.make({
    id: `smithers/scorers/${name}`,
    version: "1",
    name,
    config: { max },
    score: ({ output }) =>
      Effect.gen(function*() {
        const value = yield* text(output)
        const counts = yield* Effect.try({
          try: () => countDiff(value),
          catch: () => inconclusive("Scorer requires a complete text unified diff")
        })
        const count = name === "diffSize" ? counts.added + counts.removed : counts.files
        return {
          score: count <= max ? 1 : 0,
          reason: `${counts.added} added, ${counts.removed} removed, ${counts.files} files; ${name} ${count}/${max}`,
          meta: { ...counts, count, max }
        }
      })
  })
}
/** Counts added plus removed lines against an inclusive cap. @category scorers @since 0.1.0 */
export const diffSize = (options: DiffOptions) => diffScorer("diffSize", options)
/** Counts distinct file paths against an inclusive cap. @category scorers @since 0.1.0 */
export const touchedFiles = (options: DiffOptions) => diffScorer("touchedFiles", options)
