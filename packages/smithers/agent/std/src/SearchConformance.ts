/**
 * A differential conformance kit for {@link Search} implementations.
 *
 * `Search` is a public extension seam: a host binds its own implementation and
 * every `grep` and `glob` call in the package goes through it. Two peers ship
 * here, and the contract they are held to used to live only in
 * `test/SearchConformance.test.ts` — a file `package.json` does not publish, so
 * a third-party peer had the seam and no way to prove it filled it. Worse, the
 * cases there are hand-picked: they pin the divergences somebody already
 * found. A literal `?` matched `fo` in one peer and `foo?` in the other for as
 * long as nobody thought to write that case down.
 *
 * This module is the other half. It generates a tree and a batch of calls from
 * a seed, runs them through two implementations, and reports every answer that
 * differs. Nothing here knows which peer is right: a divergence is the finding,
 * and the reference peer to compare against is the caller's choice —
 * `PortableSearch` is the obvious one, because it needs no external binary.
 *
 * The generator deliberately stays inside the ground both peers claim to
 * share: no symlinks, no unreadable directories, no CRLF, no NUL bytes, no
 * filename a shell would have to quote. Those are the cases the hand-written
 * table pins one by one, with an expected value that says which behaviour is
 * intended. A generator cannot say that; it can only say the two disagree.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as Search from "./Search.ts"
import type * as StdError from "./StdError.ts"

/**
 * One file the generated tree contains.
 *
 * @category models
 * @since 1.0.0
 */
export interface GeneratedFile {
  /** Path relative to the tree root, always with `/` separators. */
  readonly path: string
  readonly content: string
}

/**
 * A generated tree plus the calls to make against it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Plan {
  readonly seed: number
  readonly root: string
  readonly files: ReadonlyArray<GeneratedFile>
  readonly grep: ReadonlyArray<Search.GrepInput>
  readonly glob: ReadonlyArray<Search.GlobInput>
}

/**
 * One call two implementations answered differently.
 *
 * `subject` and `reference` are the rendered answers, so a report names the
 * bytes that differ rather than saying only that they did.
 *
 * @category models
 * @since 1.0.0
 */
export interface Divergence {
  readonly call: "grep" | "glob"
  readonly input: Search.GrepInput | Search.GlobInput
  readonly subject: string
  readonly reference: string
}

/**
 * mulberry32: 32 bits of state, uniform enough for fixture generation and
 * reproducible from a seed on every host, which a shared `Math.random` is not.
 */
const random = (seed: number): () => number => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pick = <A>(next: () => number, values: ReadonlyArray<A>): A => values[Math.floor(next() * values.length)]!

const chance = (next: () => number, probability: number): boolean => next() < probability

// Names both peers walk identically: no separator, no dot prefix outside the
// two deliberate hidden entries, no name a directory skip list contains, and
// no character that would need quoting on a command line.
const stems = ["alpha", "beta", "gamma", "Delta", "e-psilon", "ze_ta", "eta2", "th.eta", "iota", "kappa"] as const
const extensions = [".ts", ".js", ".txt", ".py", ".md"] as const
const directories = ["", "one", "one/two", "three", "three/four/five"] as const

// Lines drawn from a vocabulary that mixes the needle, near misses, regex
// metacharacters that must survive `fixedStrings`, and definition headers the
// `symbols` option reads.
const lines = [
  "needle",
  "a needle in the line",
  "Needle capitalised",
  "no match here",
  "needle? with a question mark",
  "a+b and x*y and [z]",
  "def widen(value):",
  "class Widget:",
  "    needle = value",
  "function widen(value) {",
  "",
  "trailing needle"
] as const

const patterns = ["needle", "Needle", "needle?", "a+b", "[z]", "^needle$", "widen", "no match at all"] as const

const globPatterns = ["**/*.ts", "*.ts", "**/*", "one/**/*.ts", "**/*.{ts,js}", "**/alpha*"] as const

/**
 * Builds a reproducible tree and call batch from a seed.
 *
 * The same seed and root always produce the same plan, so a divergence a run
 * reports can be replayed exactly by rerunning that seed.
 *
 * @category generators
 * @since 1.0.0
 */
export const plan = (options: {
  readonly seed: number
  readonly root: string
  readonly files?: number | undefined
  readonly calls?: number | undefined
}): Plan => {
  const next = random(options.seed)
  const fileCount = options.files ?? 12
  const callCount = options.calls ?? 12
  const files: Array<GeneratedFile> = []
  for (let index = 0; index < fileCount; index++) {
    const directory = pick(next, directories)
    // The index makes every generated path unique, including repeated random picks.
    const name = `${pick(next, stems)}${index}${pick(next, extensions)}`
    const path = directory === "" ? name : `${directory}/${name}`
    const body: Array<string> = []
    for (let line = 0; line < 1 + Math.floor(next() * 8); line++) body.push(pick(next, lines))
    files.push({ path, content: `${body.join("\n")}${chance(next, 0.8) ? "\n" : ""}` })
  }

  // Always exercise precedence, anchoring, directory pruning and nested
  // negation alongside each seed's generated content (without a git repo).
  if (fileCount > 0) {
    files.push(
      { path: ".gitignore", content: "*.ignored\n!keep.ignored\n/root-only.ts\ncache/\n" },
      { path: "drop.ignored", content: "needle\n" },
      { path: "keep.ignored", content: "needle\n" },
      { path: "root-only.ts", content: "needle\n" },
      { path: "cache/a.ts", content: "needle\n" },
      { path: "nested/.gitignore", content: "!keep.ignored\n/anchored.ts\nframes/\n" },
      { path: "nested/keep.ignored", content: "needle\n" },
      { path: "nested/drop.ignored", content: "needle\n" },
      { path: "nested/anchored.ts", content: "needle\n" },
      { path: "nested/deep/anchored.ts", content: "needle\n" },
      { path: "nested/root-only.ts", content: "needle\n" },
      { path: "nested/frames/a.ts", content: "needle\n" },
      { path: "other/frames", content: "needle\n" }
    )
  }

  const roots = [options.root, ...files.map((entry) => `${options.root}/${entry.path}`)]
  const grep: Array<Search.GrepInput> = []
  for (let index = 0; index < callCount; index++) {
    const fixedStrings = chance(next, 0.4)
    // `Grep.run` refuses `ignoreCase` together with `smartCase` as mutually
    // exclusive, so a generated call carrying both would be exploring ground
    // the contract does not describe.
    const ignoreCase = chance(next, 0.25)
    grep.push({
      pattern: pick(next, patterns),
      root: chance(next, 0.75) ? options.root : pick(next, roots),
      fixedStrings,
      ignoreCase,
      smartCase: !ignoreCase && chance(next, 0.3),
      globs: chance(next, 0.4) ? [pick(next, ["*.ts", "*.txt", "!*.js", "**/*.ts"])] : [],
      beforeContext: Math.floor(next() * 3),
      afterContext: Math.floor(next() * 3),
      ...(chance(next, 0.3) ? { maxCount: 1 + Math.floor(next() * 2) } : {}),
      filesWithMatches: chance(next, 0.25),
      hidden: chance(next, 0.5),
      noIgnore: chance(next, 0.25),
      symbols: chance(next, 0.3),
      limit: 1 + Math.floor(next() * 40)
    })
  }

  const glob: Array<Search.GlobInput> = []
  for (let index = 0; index < callCount; index++) {
    glob.push({
      pattern: pick(next, globPatterns),
      root: options.root,
      hidden: chance(next, 0.5),
      noIgnore: chance(next, 0.25),
      limit: 1 + Math.floor(next() * 20)
    })
  }

  return { seed: options.seed, root: options.root, files, grep, glob }
}

/**
 * Writes a plan's tree under its root.
 *
 * @category generators
 * @since 1.0.0
 */
export const materialize = (
  target: Plan
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* Effect.forEach(target.files, (entry) => {
      const absolute = path.join(target.root, ...entry.path.split("/"))
      return fileSystem.makeDirectory(path.dirname(absolute), { recursive: true }).pipe(
        Effect.andThen(fileSystem.writeFileString(absolute, entry.content)),
        Effect.orDie
      )
    }, { discard: true })
  })

/** A typed answer rendered so two of them can be compared as text. */
const rendered = <A>(
  effect: Effect.Effect<A, StdError.StdError>
): Effect.Effect<string> =>
  effect.pipe(
    Effect.match({
      onSuccess: (value) => JSON.stringify(value),
      onFailure: (error) => JSON.stringify({ failure: error.code })
    })
  )

/**
 * Runs every call in a plan through two implementations and reports the
 * answers that differ.
 *
 * A failure is compared like any other answer: two peers that refuse the same
 * call with the same code agree, and one that refuses where the other answers
 * has diverged.
 *
 * @category conformance
 * @since 1.0.0
 */
export const compare = (options: {
  readonly plan: Plan
  readonly subject: Search.Search
  readonly reference: Search.Search
}): Effect.Effect<ReadonlyArray<Divergence>> =>
  Effect.gen(function*() {
    const divergences: Array<Divergence> = []
    for (const input of options.plan.grep) {
      const subject = yield* rendered(options.subject.grep(input))
      const reference = yield* rendered(options.reference.grep(input))
      if (subject !== reference) divergences.push({ call: "grep", input, subject, reference })
    }
    for (const input of options.plan.glob) {
      const subject = yield* rendered(options.subject.glob(input))
      const reference = yield* rendered(options.reference.glob(input))
      if (subject !== reference) divergences.push({ call: "glob", input, subject, reference })
    }
    return divergences
  })

/**
 * Renders divergences as the report a failing conformance run should print.
 *
 * @category conformance
 * @since 1.0.0
 */
export const report = (divergences: ReadonlyArray<Divergence>): string =>
  divergences.map((divergence) =>
    [
      `${divergence.call}(${JSON.stringify(divergence.input)})`,
      `  subject:   ${divergence.subject}`,
      `  reference: ${divergence.reference}`
    ].join("\n")
  ).join("\n\n")
