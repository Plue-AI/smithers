/**
 * Cleanup opportunities, deterministic signals S1-S5 of registration-scores.md section 2.
 *
 * Normalization anchors are provisional (`deterministic-v0`) until the calibration corpus exists
 * (#2160); the 80% interval comes from a seeded bootstrap over files, so a replay yields the same
 * range. Scores are about code quality, whoever wrote it.
 */
import type { Cause, Cleanup, SignalId } from "./schema.ts"
import type { SourceFile, Tree } from "./tree.ts"

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|sh)$/
const EXCLUDED =
  /(^|\/)(node_modules|dist|build|out|vendor|third_party|\.git|coverage|__snapshots__|__generated__|generated)\/|\.min\.js$|\.pb\.go$|_pb2\.py$|\.d\.ts$|_generated\.\w+$/

/** Weight and the value treated as the 90th percentile of human code (provisional). */
export const SIGNALS: Record<SignalId, { readonly weight: number; readonly p90: number }> = {
  duplicates: { weight: 15, p90: 8 },
  churn: { weight: 10, p90: 0.25 },
  lexicon: { weight: 10, p90: 2 },
  stubs: { weight: 10, p90: 1.5 },
  "dead-code": { weight: 10, p90: 0.2 }
}

export const isSource = (path: string) => SOURCE.test(path) && !EXCLUDED.test(path)

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
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
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
  const values: Record<SignalId, number | undefined> = {
    duplicates: duplicates.length / kloc,
    churn,
    lexicon: files.reduce((sum, file) => sum + file.lexicon.length, 0) / kloc,
    stubs: files.reduce((sum, file) => sum + file.stubs.length, 0) / kloc,
    "dead-code": exported < 20 ? undefined : unused.length / exported
  }
  const first = (list: ReadonlyArray<{ path: string; line: number }>) => list[0] ?? null
  const locations: Record<SignalId, { count: number; location: { path: string; line: number } | null }> = {
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

const scoreOf = (values: Record<SignalId, number | undefined>) => {
  const present = (Object.keys(SIGNALS) as ReadonlyArray<SignalId>).filter((id) => values[id] !== undefined)
  const weight = present.reduce((sum, id) => sum + SIGNALS[id].weight, 0)
  const raw = present.reduce((sum, id) => sum + SIGNALS[id].weight * Math.min(1, values[id]! / SIGNALS[id].p90), 0)
  return { score: weight === 0 ? 0 : Math.round((raw / weight) * 100), weight }
}

/**
 * `tree.files` are the readable files; `sourceLines` is the line count of every source file,
 * readable or not, so coverage is honest about what was skipped.
 */
export const cleanup = (tree: Tree, sourceLines: number, churn: number): Cleanup => {
  const corpus = tree.files.filter((file) => isSource(file.path))
  const files = corpus.map(scan)
  const analyzed = files.reduce((sum, file) => sum + file.lines, 0)
  const coverage = sourceLines === 0 ? 0 : Math.min(1, analyzed / sourceLines)
  if (coverage < 0.6 || files.length === 0) {
    return {
      _tag: "cleanup",
      status: "insufficient",
      coverage,
      score: 0,
      low: 0,
      high: 0,
      causes: [],
      method: "deterministic-v0"
    }
  }
  const unused = unusedExports(files, corpus), duplicated = duplicateLines(files)
  const { values, locations } = measure(files, unused, duplicated, churn)
  const { score, weight } = scoreOf(values)
  const next = random(files.length * 7919 + analyzed)
  const samples: Array<number> = []
  for (let round = 0; round < 40; round++) {
    // Subsample without replacement: a file drawn twice would count as its own duplicate.
    const sample = files.filter(() => next() < 0.8)
    if (sample.length > 0) samples.push(scoreOf(measure(sample, unused, duplicated, churn).values).score)
  }
  samples.sort((a, b) => a - b)
  // The unmeasured hybrid and Jev signals (45 of 100 points) widen the interval until #2160.
  const spread = Math.round(((100 - weight) / 100) * 10)
  const causes: ReadonlyArray<Cause> = (Object.keys(SIGNALS) as ReadonlyArray<SignalId>)
    .filter((id) => values[id] !== undefined && locations[id].count > 0)
    .map((id) => ({ id, contribution: SIGNALS[id].weight * Math.min(1, values[id]! / SIGNALS[id].p90) }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map(({ id }) => ({ signal: id, count: locations[id].count, location: locations[id].location }))
  return {
    _tag: "cleanup",
    status: "scored",
    coverage: Math.round(coverage * 100) / 100,
    score,
    low: Math.max(0, Math.min(score, samples[Math.floor(samples.length * 0.1)] ?? score) - spread),
    high: Math.min(100, Math.max(score, samples[Math.floor(samples.length * 0.9)] ?? score) + spread),
    causes,
    method: "deterministic-v0"
  }
}
