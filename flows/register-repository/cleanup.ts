/**
 * Cleanup opportunities, the ten signals of registration-scores.md section 2: deterministic S1-S5
 * here, Jev-judged S6-S10 in `judged.ts`.
 *
 * Normalization anchors are provisional (`hybrid-v0`; `deterministic-v0` when Jev could not judge
 * a judged signal that had candidates) until the calibration corpus exists (#3150). The range comes from a seeded bootstrap over files
 * plus each judged signal's confident and unclear share, so a replay yields the same range. Scores
 * are about code quality, whoever wrote it.
 */
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect } from "effect"
import { candidates, JUDGEABLE, judgeCandidates, JUDGED, type JudgedId, type Judgment } from "./judged.ts"
import type { Cause, Cleanup, SignalId } from "./schema.ts"
import { isSource, type SourceFile, type Tree } from "./tree.ts"

/** Weight and the value treated as the 90th percentile of human code (provisional). */
export const SIGNALS: Record<SignalId, { readonly weight: number; readonly p90: number }> = {
  duplicates: { weight: 15, p90: 8 },
  churn: { weight: 10, p90: 0.25 },
  lexicon: { weight: 10, p90: 2 },
  stubs: { weight: 10, p90: 1.5 },
  "dead-code": { weight: 10, p90: 0.2 },
  // Judged signals: estimated findings per thousand lines.
  comments: { weight: 10, p90: 2 },
  defensive: { weight: 10, p90: 1.5 },
  abstraction: { weight: 10, p90: 1 },
  drift: { weight: 10, p90: 0.5 },
  "test-theater": { weight: 5, p90: 1 }
}

/** Normalizable signal values; an absent or undefined one was not measured. */
type Values = Partial<Record<SignalId, number | undefined>>

const COMMENT = /^\s*(\/\/|#|\*|\/\*|--)/
const LEXICON =
  /\b(for now|should work|in a real (implementation|app|system)|placeholder implementation|simplified (version|implementation)|mock implementation|TODO: implement|not yet implemented)\b|\u2705|\u2728|\u{1F680}|\u{1F389}/iu
const STUB: ReadonlyArray<RegExp> = [
  /throw new Error\(\s*["'`](not implemented|todo|unimplemented)/i,
  /raise NotImplementedError/,
  /\b(todo|unimplemented)!\(/,
  /catch\s*(\([^)]*\))?\s*\{\s*\}/,
  /except(\s+\w+)?\s*:\s*pass\b/,
  /return (true|null|undefined|0)\s*;?\s*\/\/\s*TODO/i
]

interface FileSignals {
  readonly path: string
  readonly lines: number
  readonly lexicon: ReadonlyArray<number>
  readonly stubs: ReadonlyArray<number>
  /** Six-line windows as keys of per-line hashes, with the line each starts on. */
  readonly windows: ReadonlyArray<readonly [string, number]>
  readonly exports: ReadonlyArray<readonly [string, number]>
}

/** 32-bit FNV-1a of one normalized line. */
const hash = (line: string) => {
  let value = 0x811c9dc5
  for (let index = 0; index < line.length; index++) {
    value ^= line.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

const EXPORT =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:const|let|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/

const scan = (file: SourceFile): FileSignals => {
  const lines = file.text.split("\n")
  const lexicon: Array<number> = [], stubs: Array<number> = [], exports: Array<readonly [string, number]> = []
  const normalized: Array<readonly [number, number]> = []
  lines.forEach((line, index) => {
    if (COMMENT.test(line) && LEXICON.test(line)) lexicon.push(index + 1)
    if (STUB.some((pattern) => pattern.test(line))) stubs.push(index + 1)
    const exported = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.path) ? EXPORT.exec(line) : null
    if (exported !== null) exports.push([exported[1]!, index + 1])
    const compact = line.replace(/\s+/g, " ").trim()
    if (compact.length >= 12 && !COMMENT.test(line) && !/^(import|from|using|#include|package)\b/.test(compact)) {
      normalized.push([hash(compact), index + 1])
    }
  })
  // Python's `def f():` followed only by `pass` is a stub too.
  for (let index = 1; index < lines.length; index++) {
    if (/^\s*pass\s*$/.test(lines[index]!) && /^\s*def .*:\s*$/.test(lines[index - 1]!)) stubs.push(index + 1)
  }
  const windows: Array<readonly [string, number]> = []
  for (let index = 0; index + 6 <= normalized.length; index++) {
    windows.push([
      normalized.slice(index, index + 6).map(([value]) => value.toString(36)).join(","),
      normalized[index]![1]
    ])
  }
  return { path: file.path, lines: lines.length, lexicon, stubs, windows, exports }
}

/** A small seeded generator, so the bootstrap interval is the same on every replay. */
const random = (seed: number) => () => {
  // 32-bit arithmetic: a float product past 2^53 would round away the low bits.
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fff_ffff
  return seed / 2_147_483_648
}

/** Exports no other source file names, by file. One identifier index, built once. */
const unusedExports = (files: ReadonlyArray<FileSignals>, corpus: ReadonlyArray<SourceFile>) => {
  const users = new Map<string, number>()
  for (const file of corpus) {
    for (const name of new Set(file.text.match(/[A-Za-z_$][\w$]*/g) ?? [])) users.set(name, (users.get(name) ?? 0) + 1)
  }
  // A name only its declaring file mentions appears in exactly one file.
  return new Map(files.map((file) => [file.path, file.exports.filter(([name]) => (users.get(name) ?? 0) <= 1)]))
}

/** Where each file repeats a six-line window seen earlier in the corpus: one pass, by file. */
const duplicateLines = (files: ReadonlyArray<FileSignals>) => {
  const seen = new Set<string>()
  return new Map(files.map((file) => {
    const lines: Array<number> = []
    let last = -10
    for (const [window, line] of file.windows) {
      if (!seen.has(window)) seen.add(window)
      else if (line - last >= 6) {
        lines.push(line)
        last = line
      }
    }
    return [file.path, lines] as const
  }))
}

const measure = (
  files: ReadonlyArray<FileSignals>,
  unusedByFile: ReadonlyMap<string, ReadonlyArray<readonly [string, number]>>,
  duplicatesByFile: ReadonlyMap<string, ReadonlyArray<number>>,
  churn: number
) => {
  const kloc = Math.max(1, files.reduce((sum, file) => sum + file.lines, 0) / 1000)
  const duplicates = files.flatMap((file) =>
    (duplicatesByFile.get(file.path) ?? []).map((line) => [file.path, line] as const)
  )
  const exported = files.reduce((sum, file) => sum + file.exports.length, 0)
  const unused = files.flatMap((file) =>
    (unusedByFile.get(file.path) ?? []).map(([, line]) => ({ path: file.path, line }))
  )
  const values: Values = {
    duplicates: duplicates.length / kloc,
    churn,
    lexicon: files.reduce((sum, file) => sum + file.lexicon.length, 0) / kloc,
    stubs: files.reduce((sum, file) => sum + file.stubs.length, 0) / kloc,
    "dead-code": exported < 20 ? undefined : unused.length / exported
  }
  const first = (list: ReadonlyArray<{ path: string; line: number }>) => list[0] ?? null
  const locations: Partial<Record<SignalId, { count: number; location: { path: string; line: number } | null }>> = {
    duplicates: { count: duplicates.length, location: first(duplicates.map(([path, line]) => ({ path, line }))) },
    churn: { count: Math.round(churn * 100), location: null },
    lexicon: {
      count: files.reduce((sum, file) => sum + file.lexicon.length, 0),
      location: first(files.flatMap((file) => file.lexicon.map((line) => ({ path: file.path, line }))))
    },
    stubs: {
      count: files.reduce((sum, file) => sum + file.stubs.length, 0),
      location: first(files.flatMap((file) => file.stubs.map((line) => ({ path: file.path, line }))))
    },
    "dead-code": { count: unused.length, location: first(unused) }
  }
  return { values, locations }
}

const scoreOf = (values: Values) => {
  const present = (Object.keys(SIGNALS) as ReadonlyArray<SignalId>).filter((id) => values[id] !== undefined)
  const weight = present.reduce((sum, id) => sum + SIGNALS[id].weight, 0)
  const raw = present.reduce((sum, id) => sum + SIGNALS[id].weight * Math.min(1, values[id]! / SIGNALS[id].p90), 0)
  return { score: weight === 0 ? 0 : Math.round((raw / weight) * 100), weight }
}

/**
 * The raw deterministic S1-S5 values of one tree (calibration, #3150): the scan `cleanup` scores,
 * without judging or normalizing. `null` when coverage is under 60% or no source was read; a
 * signal that could not be measured (dead code under 20 exports) is `null` too.
 */
export const deterministicSignals = (tree: Tree, sourceLines: number, churn: number) => {
  const corpus = tree.files.filter((file) => isSource(file.path))
  const files = corpus.map(scan)
  const analyzed = files.reduce((sum, file) => sum + file.lines, 0)
  const coverage = sourceLines === 0 ? 0 : Math.min(1, analyzed / sourceLines)
  if (coverage < 0.6 || files.length === 0) return { coverage, analyzed, values: null }
  const { values } = measure(files, unusedExports(files, corpus), duplicateLines(files), churn)
  const pick = (id: SignalId) => values[id] ?? null
  return {
    coverage,
    analyzed,
    values: {
      duplicates: pick("duplicates"),
      churn: pick("churn"),
      lexicon: pick("lexicon"),
      stubs: pick("stubs"),
      "dead-code": pick("dead-code")
    }
  }
}

/** The source files in a language the S6-S10 pre-filter reads. */
const judgeable = (corpus: ReadonlyArray<SourceFile>) => corpus.filter((file) => JUDGEABLE.test(file.path))

/** Every S6-S10 candidate the deterministic pre-filter finds, before Jev judges any. */
export const cleanupCandidates = (tree: Tree) =>
  candidates(tree, judgeable(tree.files.filter((file) => isSource(file.path))))

type Ends = { readonly low: number; readonly high: number }
/** A judged signal's estimated findings: confident yes only, and yes plus unclear. */
const ends = (judgment: Judgment): Ends =>
  judgment.sampled === 0 ? { low: 0, high: 0 } : {
    low: (judgment.candidates * judgment.yes) / judgment.sampled,
    high: (judgment.candidates * (judgment.yes + judgment.unclear)) / judgment.sampled
  }

/**
 * `tree.files` are the readable files; `sourceLines` is the line count of every source file,
 * readable or not, so coverage is honest about what was skipped.
 */
export const cleanup = (
  tree: Tree,
  sourceLines: number,
  churn: number
): Effect.Effect<Cleanup, never, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const corpus = tree.files.filter((file) => isSource(file.path))
    const files = corpus.map(scan)
    const analyzed = files.reduce((sum, file) => sum + file.lines, 0)
    const coverage = sourceLines === 0 ? 0 : Math.min(1, analyzed / sourceLines)
    if (coverage < 0.6 || files.length === 0) {
      return {
        _tag: "cleanup" as const,
        status: "insufficient" as const,
        coverage,
        score: 0,
        low: 0,
        high: 0,
        causes: [],
        method: "deterministic-v0" as const
      }
    }
    // Judged signals are densities over the files the pre-filter reads; with none, they stay
    // unmeasured rather than a zero no evidence supports.
    const readable = judgeable(corpus)
    const judged = readable.length === 0 ? {} : yield* judgeCandidates(candidates(tree, readable))
    const unused = unusedExports(files, corpus), duplicated = duplicateLines(files)
    const { values, locations } = measure(files, unused, duplicated, churn)
    const kloc = Math.max(
      1,
      files.filter((file) => JUDGEABLE.test(file.path)).reduce((sum, file) => sum + file.lines, 0) / 1000
    )
    const judgedIds = Object.keys(judged) as ReadonlyArray<JudgedId>
    const withJudged = (pick: (range: Ends) => number, base: Values) => ({
      ...base,
      ...Object.fromEntries(judgedIds.map((id) => [id, pick(ends(judged[id]!)) / kloc]))
    })
    const middle = (range: Ends) => (range.low + range.high) / 2
    const all = withJudged(middle, values)
    const { score, weight } = scoreOf(all)
    // Each end bootstraps the deterministic signals over files with the judged signals at that end.
    const bootstrap = (pick: (range: Ends) => number) => {
      const next = random(files.length * 7919 + analyzed)
      const samples: Array<number> = []
      for (let round = 0; round < 40; round++) {
        // Subsample without replacement: a file drawn twice would count as its own duplicate.
        const sample = files.filter(() => next() < 0.8)
        if (sample.length > 0) {
          samples.push(scoreOf(withJudged(pick, measure(sample, unused, duplicated, churn).values)).score)
        }
      }
      return samples.sort((a, b) => a - b)
    }
    const lows = bootstrap((range) => range.low), highs = bootstrap((range) => range.high)
    const lowest = scoreOf(withJudged((range) => range.low, values)).score
    const highest = scoreOf(withJudged((range) => range.high, values)).score
    // Unmeasured signals widen the interval: points no evidence could score.
    const spread = Math.round(((100 - weight) / 100) * 10)
    const found: Partial<Record<SignalId, { count: number; location: { path: string; line: number } | null }>> = {
      ...locations,
      ...Object.fromEntries(judgedIds.map((id) => [id, {
        count: Math.round(ends(judged[id]!).low),
        location: judged[id]!.location
      }]))
    }
    const causes: ReadonlyArray<Cause> = (Object.keys(SIGNALS) as ReadonlyArray<SignalId>)
      .filter((id) => all[id] !== undefined && (found[id]?.count ?? 0) > 0)
      .map((id) => ({ id, contribution: SIGNALS[id].weight * Math.min(1, all[id]! / SIGNALS[id].p90) }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3)
      .map(({ id }) => ({ signal: id, count: found[id]!.count, location: found[id]!.location }))
    return {
      _tag: "cleanup" as const,
      status: "scored" as const,
      coverage: Math.round(coverage * 100) / 100,
      score,
      low: Math.max(0, Math.min(score, lowest, lows[Math.floor(lows.length * 0.1)] ?? score) - spread),
      high: Math.min(100, Math.max(score, highest, highs[Math.floor(highs.length * 0.9)] ?? score) + spread),
      causes,
      // Only a run that measured every judged signal claims the hybrid method.
      method: judgedIds.length === JUDGED.length ? "hybrid-v0" as const : "deterministic-v0" as const
    }
  })
