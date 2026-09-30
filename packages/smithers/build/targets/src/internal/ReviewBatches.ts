/**
 * Review batch planning: related changed code stays together, unchanged
 * callers and dependencies travel with it, and every request fits the
 * selected model's token budget with output capacity reserved.
 * @since 1.0.0
 */

import * as NodePath from "node:path"

/**
 * Conservative token estimate for provider-bound text: three UTF-8 bytes per token.
 * @category budget
 * @since 1.0.0
 */
export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 3)

/**
 * One changed file, or one symbol-aligned slice of a changed file too large for a single request.
 * @category models
 * @since 1.0.0
 */
export interface Segment {
  readonly path: string
  readonly contents: string
  readonly deleted?: boolean
  /** 1-based line of the file this slice starts at. */
  readonly firstLine: number
  readonly lastLine: number
  readonly totalLines: number
}

/**
 * One planned model request: its changed slices plus the unchanged related files it carries.
 * @category models
 * @since 1.0.0
 */
export interface PlannedBatch {
  readonly changed: ReadonlyArray<Segment>
  readonly related: ReadonlyArray<string>
  readonly omittedRelated: ReadonlyArray<string>
}

const scriptExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const

/**
 * Whether static relative imports of a file can be resolved.
 * @category graph
 * @since 1.0.0
 */
export const isScript = (path: string): boolean => scriptExtensions.some((extension) => path.endsWith(extension))

const relativeImport = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*(["'])(\.{1,2}\/[^"'\r\n]*)\1/g

/**
 * Relative module specifiers a script names in static imports, re-exports, dynamic imports and requires.
 * @category graph
 * @since 1.0.0
 */
export const importSpecifiers = (
  contents: string
): ReadonlyArray<string> => [...new Set([...contents.matchAll(relativeImport)].map((match) => match[2]!))]

/**
 * The workspace paths one relative specifier can name, in resolution order.
 * Specifiers that leave the workspace resolve to nothing.
 * @category graph
 * @since 1.0.0
 */
export const importCandidates = (from: string, specifier: string): ReadonlyArray<string> => {
  const trimmed = NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(from), specifier))
    .replace(/\/+$/, "")
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith("../") || NodePath.posix.isAbsolute(trimmed)) return []
  const swapped = /\.(?:m|c)?js$|\.jsx$/.exec(trimmed)
  const sources = swapped === null ? [] : [
    `${trimmed.slice(0, swapped.index)}${
      swapped[0] === ".jsx" ? ".tsx" : swapped[0] === ".mjs" ? ".mts" : swapped[0] === ".cjs" ? ".cts" : ".ts"
    }`
  ]
  return [
    trimmed,
    ...sources,
    ...scriptExtensions.map((extension) => `${trimmed}${extension}`),
    ...scriptExtensions.map((extension) => `${trimmed}/index${extension}`)
  ]
}

/**
 * The first candidate of a specifier that `exists` accepts.
 * @category graph
 * @since 1.0.0
 */
export const resolveImport = (
  from: string,
  specifier: string,
  exists: (path: string) => boolean
): string | undefined => importCandidates(from, specifier).find(exists)

/**
 * Module stems a caller's relative specifier ends with when it names `path`.
 * @category graph
 * @since 1.0.0
 */
export const importStems = (path: string): ReadonlyArray<string> => {
  const name = NodePath.posix.basename(path).replace(/\.[^.]+$/, "")
  const directory = NodePath.posix.basename(NodePath.posix.dirname(path))
  return name === "index" && directory !== "." && directory !== "" ? [name, directory] : [name]
}

/**
 * Go files in one directory form one package and are always related.
 * @category graph
 * @since 1.0.0
 */
export const goPackage = (path: string): string | undefined =>
  path.endsWith(".go") ? NodePath.posix.dirname(path) : undefined

/** Top-level declarations: the symbol boundaries a large file is split at. */
const symbolStart =
  /^(?:export\b|async\b|function\b|class\b|const\b|let\b|var\b|type\b|interface\b|enum\b|declare\b|abstract\b|namespace\b|module\b|func\b|def\b|fn\b|pub\b|impl\b|struct\b|trait\b|package\b|import\b|@[A-Za-z]|\/\*\*|#\[)/

/** UTF-8 bytes of a string once JSON-escaped, without its quotes. */
const escapedBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text), "utf8") - 2

/**
 * Splits one file into slices whose `cost` fits `budget`, cutting at top-level
 * symbol boundaries when possible, then at lines, then within an overlong line.
 * @category splitting
 * @since 1.0.0
 */
export const splitFile = (
  file: { readonly path: string; readonly contents: string; readonly deleted?: boolean },
  budget: number,
  cost: (segment: Segment) => number
): ReadonlyArray<Segment> => {
  const lines = file.contents.split("\n")
  const totalLines = lines.length
  const segment = (first: number, last: number, contents: string): Segment => ({
    path: file.path,
    contents,
    ...(file.deleted === true ? { deleted: true } : {}),
    firstLine: first + 1,
    lastLine: last + 1,
    totalLines
  })
  const whole = segment(0, totalLines - 1, file.contents)
  if (cost(whole) <= budget) return [whole]
  // Slice sizes are priced from escaped byte prefix sums; every emitted slice is then priced exactly.
  const header = 2 * Buffer.byteLength(file.path, "utf8") + 160
  const withBreak = (index: number) => index < totalLines - 1 ? `${lines[index]!}\n` : lines[index]!
  const prefix = [0]
  for (let index = 0; index < totalLines; index++) prefix.push(prefix[index]! + escapedBytes(withBreak(index)))
  const fits = (first: number, last: number) => Math.ceil((header + prefix[last + 1]! - prefix[first]!) / 3) <= budget
  const output: Array<Segment> = []
  const emit = (value: Segment) => {
    if (cost(value) > budget) {
      throw new Error(`${JSON.stringify(file.path)} cannot be split under the review token budget`)
    }
    output.push(value)
  }
  let open: number | undefined
  let close = -1
  const flush = () => {
    if (open !== undefined) {
      emit(segment(open, close, lines.slice(open, close + 1).map((_, offset) => withBreak(open! + offset)).join("")))
    }
    open = undefined
  }
  const extend = (first: number, last: number): boolean => {
    if (open !== undefined && fits(open, last)) {
      close = last
      return true
    }
    flush()
    if (!fits(first, last)) return false
    open = first
    close = last
    return true
  }
  // Units begin at a symbol boundary, so a unit never starts mid-declaration.
  const starts = [0]
  for (let index = 1; index < totalLines; index++) {
    if (symbolStart.test(lines[index]!)) starts.push(index)
  }
  starts.forEach((first, unit) => {
    const last = (starts[unit + 1] ?? totalLines) - 1
    if (extend(first, last)) return
    // A unit larger than the budget is cut at line boundaries.
    for (let line = first; line <= last; line++) {
      if (extend(line, line)) continue
      // One line larger than the budget: slice it by characters, every slice reporting that line.
      const source = withBreak(line)
      let start = 0
      let bytes = header
      for (let offset = 0; offset < source.length;) {
        const width = source.codePointAt(offset)! > 0xffff ? 2 : 1
        const next = escapedBytes(source.slice(offset, offset + width))
        if (offset > start && Math.ceil((bytes + next) / 3) > budget) {
          emit(segment(line, line, source.slice(start, offset)))
          start = offset
          bytes = header
        }
        bytes += next
        offset += width
      }
      emit(segment(line, line, source.slice(start)))
    }
  })
  flush()
  return output
}

/**
 * Inputs for {@link planBatches}. `edges` relate changed paths to each other,
 * `related` lists each changed path's unchanged related files in priority
 * order (dependencies before callers), and `cost` prices one rendered file.
 * @category models
 * @since 1.0.0
 */
export interface PlanInput {
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string; readonly deleted?: boolean }>
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>
  readonly related: ReadonlyMap<string, ReadonlyArray<string>>
  readonly relatedCost: (path: string) => number
  readonly segmentCost: (segment: Segment) => number
  readonly budget: number
  readonly maximumFiles: number
}

/**
 * Groups changed files into connected components of the relation graph, keeps
 * each component together whenever it fits one request, and fills remaining
 * budget with the batch's unchanged related files.
 * @category planning
 * @since 1.0.0
 */
export const planBatches = (input: PlanInput): ReadonlyArray<PlannedBatch> => {
  const byPath = new Map(input.files.map((file) => [file.path, file] as const))
  const order = [...byPath.keys()].sort()
  const seen = new Set<string>()
  const components: Array<ReadonlyArray<string>> = []
  for (const start of order) {
    if (seen.has(start)) continue
    // Breadth-first from the smallest path keeps directly related files adjacent when a component must split.
    const component: Array<string> = []
    const queue = [start]
    seen.add(start)
    while (queue.length > 0) {
      const path = queue.shift()!
      component.push(path)
      for (const next of [...(input.edges.get(path) ?? [])].sort()) {
        if (!seen.has(next) && byPath.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    components.push(component)
  }
  const batches: Array<Array<Segment>> = []
  let current: Array<Segment> = []
  let used = 0
  let files = new Set<string>()
  const close = () => {
    if (current.length > 0) batches.push(current)
    current = []
    used = 0
    files = new Set()
  }
  const add = (segment: Segment, price: number) => {
    if (
      current.length > 0 &&
      (used + price > input.budget || (!files.has(segment.path) && files.size >= input.maximumFiles))
    ) {
      close()
    }
    current.push(segment)
    used += price
    files.add(segment.path)
  }
  for (const component of components) {
    const segments = component.flatMap((path) => splitFile(byPath.get(path)!, input.budget, input.segmentCost))
    const prices = segments.map(input.segmentCost)
    const total = prices.reduce((sum, price) => sum + price, 0)
    const whole = total <= input.budget && component.length <= input.maximumFiles
    // A component that fits one request never straddles two.
    if (
      whole && current.length > 0 && (used + total > input.budget || files.size + component.length > input.maximumFiles)
    ) {
      close()
    }
    segments.forEach((segment, index) => add(segment, prices[index]!))
  }
  close()
  return batches.map((changed) => {
    const inBatch = new Set(changed.map((segment) => segment.path))
    let remaining = input.budget - changed.reduce((sum, segment) => sum + input.segmentCost(segment), 0)
    const related: Array<string> = []
    const omittedRelated: Array<string> = []
    const candidates: Array<string> = []
    // Round-robin across the batch's files so every changed file receives its highest-priority relations first.
    const lists = [...inBatch].map((path) => input.related.get(path) ?? [])
    for (let rank = 0; lists.some((list) => rank < list.length); rank++) {
      for (const list of lists) {
        const path = list[rank]
        if (path !== undefined && !inBatch.has(path) && !candidates.includes(path)) candidates.push(path)
      }
    }
    for (const path of candidates) {
      const price = input.relatedCost(path)
      if (price <= remaining) {
        related.push(path)
        remaining -= price
      } else {
        omittedRelated.push(path)
      }
    }
    return { changed, related, omittedRelated }
  })
}

interface Source {
  readonly path: string
  readonly contents: string
}

/**
 * Unchanged paths the changed scripts import, resolved against `exists`.
 * @category graph
 * @since 1.0.0
 */
export const calleePaths = (
  changed: ReadonlyArray<Source>,
  exists: (path: string) => boolean
): ReadonlyArray<string> => {
  const names = new Set(changed.map((file) => file.path))
  const output = new Set<string>()
  for (const file of changed) {
    if (!isScript(file.path)) continue
    for (const specifier of importSpecifiers(file.contents)) {
      const resolved = resolveImport(file.path, specifier, exists)
      if (resolved !== undefined && !names.has(resolved)) output.add(resolved)
    }
  }
  return [...output].sort()
}

const extendedRegex = /[.[\]()*+?{}|^$\\]/g

/**
 * Extended regular expressions matching a relative specifier that can name a changed script.
 * @category graph
 * @since 1.0.0
 */
export const callerPatterns = (changed: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(changed.filter(isScript).flatMap(importStems))].sort().map((stem) =>
    `/${stem.replace(extendedRegex, "\\$&")}(\\.[A-Za-z]+)?["']`
  )

/**
 * Directories whose Go files share a package with a changed Go file.
 * @category graph
 * @since 1.0.0
 */
export const goDirectories = (changed: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(changed.flatMap((path) => goPackage(path) ?? []))].sort()

/**
 * The relation graph among changed files and each changed file's related
 * unchanged files, dependencies first, then Go package siblings, then callers.
 * @category graph
 * @since 1.0.0
 */
export const relate = (
  changed: ReadonlyArray<Source>,
  unchanged: ReadonlyArray<Source>,
  exists: (path: string) => boolean
): {
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>
  readonly related: ReadonlyMap<string, ReadonlyArray<string>>
} => {
  const names = new Set(changed.map((file) => file.path))
  const available = new Set(unchanged.map((file) => file.path))
  const edges = new Map<string, Set<string>>()
  const link = (left: string, right: string) => {
    if (left === right) return
    for (const [from, to] of [[left, right], [right, left]] as const) {
      const set = edges.get(from) ?? new Set<string>()
      set.add(to)
      edges.set(from, set)
    }
  }
  const callees = new Map<string, Array<string>>()
  const siblings = new Map<string, Array<string>>()
  const callers = new Map<string, Array<string>>()
  const push = (map: Map<string, Array<string>>, key: string, value: string) => {
    const list = map.get(key) ?? []
    if (!list.includes(value)) list.push(value)
    map.set(key, list)
  }
  for (const file of changed) {
    if (isScript(file.path)) {
      for (const specifier of importSpecifiers(file.contents)) {
        const resolved = resolveImport(file.path, specifier, exists)
        if (resolved === undefined) continue
        if (names.has(resolved)) link(file.path, resolved)
        else if (available.has(resolved)) push(callees, file.path, resolved)
      }
    }
    const directory = goPackage(file.path)
    if (directory === undefined) continue
    for (const other of changed) {
      if (goPackage(other.path) === directory) link(file.path, other.path)
    }
    for (const other of [...available].sort()) {
      if (goPackage(other) === directory) push(siblings, file.path, other)
    }
  }
  for (const file of [...unchanged].sort((left, right) => left.path < right.path ? -1 : 1)) {
    if (!isScript(file.path)) continue
    for (const specifier of importSpecifiers(file.contents)) {
      const resolved = resolveImport(file.path, specifier, exists)
      if (resolved !== undefined && names.has(resolved)) push(callers, resolved, file.path)
    }
  }
  const related = new Map<string, ReadonlyArray<string>>()
  for (const file of changed) {
    const list = [
      ...new Set([
        ...(callees.get(file.path) ?? []),
        ...(siblings.get(file.path) ?? []),
        ...(callers.get(file.path) ?? [])
      ])
    ]
    if (list.length > 0) related.set(file.path, list)
  }
  return { edges, related }
}
