/**
 * Memory: the context a task needs, as one ordinary sealed flow named
 * `memory`.
 *
 * A cell reaches it the way it reaches every capability:
 * `ctx.call("memory", { task, query?, paths?, sources?, maxBytes? })`. There
 * is no `ctx.memory`. A host binds it with {@link plugin} (through
 * `CellPlugin.fromBindings`), and runs the same selection once before frame 0
 * with {@link opening}, whose value is `Agent.Options.memory`.
 *
 * Selection is deterministic shortlisting plus one Jev boolean per candidate:
 *
 * - **Seeds**: paths and commit ids the task or `paths` name. Kept, never
 *   judged.
 * - **Wiki**: the page catalog, skills and imported dependency pages, the
 *   top {@link shortlist} by keyword, each asked `memory/needed`.
 * - **Repo**: a README-guided walk. Each level asks `memory/descend` of every
 *   child directory, from the root README down, at most {@link maxLevels}
 *   levels, {@link maxChildren} children per directory and {@link maxDirs}
 *   directories. The files of the kept directories, of the seeds'
 *   directories and of the paths kept pages cite are then asked
 *   `memory/needed`.
 * - **Commits**: commits that touched the kept and seeded files, with their
 *   mythical notes, asked `memory/needed`.
 * - **Facts**: remembered rows from `@smthrs/memory`, withheld by the
 *   existing `relevance/unnecessary` reading at `Relevance.withholdAt`.
 *
 * Every decision has its own threshold on a calibrated scale
 * (`MemoryCalibration`). The winners are packed into one byte-stable fenced
 * block under `maxBytes`. The result enters a run as a call result in the
 * append-only tail, or at frame 0 as `Agent.Options.memory` rows, so the
 * prompt-cache prefix is never rewritten.
 *
 * A Jev that is unavailable (unreachable, timed out, or refusing with a 429
 * or a 5xx, as `EvaluatorBackup.withFallback` reads it), or a host with no
 * judge (reason `unconfigured`), leaves the call with its seeds and its
 * recalled facts, and `unjudged` set; the run-start relevance reading still
 * judges the facts. Any other Jev failure fails the call with
 * {@link MemoryFailed}.
 *
 * @since 1.0.0
 */

import * as Capability from "@smthrs/capability/Capability"
import * as Digest from "@smthrs/core/Digest"
import * as Fault from "@smthrs/flow/Fault"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Judgement from "@smthrs/harness/Judgement"
import * as Relevance from "@smthrs/harness/Relevance"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import type * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as MemorySource from "@smthrs/memory/Source"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import type { FlowsHooks, FlowsPlugin } from "@smthrs/plugin"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as CellPlugin from "./CellPlugin.ts"
import * as FlowEngineLike from "./FlowEngineLike.ts"
import * as Commits from "./internal/memory/commits.ts"
import * as Pack from "./internal/memory/pack.ts"
import * as Repo from "./internal/memory/repo.ts"
import * as Wiki from "./internal/memory/wiki.ts"
import * as MemoryCalibration from "./MemoryCalibration.ts"

/**
 * The flow's name, and the plugin's.
 *
 * @category constants
 * @since 1.0.0
 */
export const name = "memory"

/**
 * The block size a call packs to when it names none, in UTF-8 bytes.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxBytes = 32 * 1024

/**
 * The largest block a call may ask for: `Recall.MAX_RECALL_TOKENS`.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxMaxBytes = Recall.MAX_RECALL_TOKENS

/**
 * The block size the host's frame-0 call packs to.
 *
 * @category constants
 * @since 1.0.0
 */
export const openingMaxBytes = 16 * 1024

/**
 * Wiki candidates Jev reads per call, best keyword matches first.
 *
 * @category constants
 * @since 1.0.0
 */
export const shortlist = 30

/**
 * README walk bounds: levels below the root, children kept per directory,
 * and directories kept in all.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxLevels = 4

/**
 * Children the walk descends into per directory.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxChildren = 8

/**
 * Directories the walk keeps in all.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxDirs = 48

/**
 * Files per directory, and files in all, that one call asks Jev about.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxFilesPerDir = 64

/**
 * Files one call asks Jev about in all.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxFiles = 256

/**
 * The most of one candidate Jev reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const headBytes = 1024

/**
 * The most of a directory's README Jev reads. Short on purpose: measured on
 * 2026-09-28, a 300-byte head beside the path separated the directory a task
 * needed from its siblings better than a 1 KiB one.
 *
 * @category constants
 * @since 1.0.0
 */
export const aboutBytes = 300

/**
 * Items listed in `omitted`, highest probability first.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxOmitted = 64

/**
 * A level that took longer than this caps the walk one level shallower.
 *
 * @category constants
 * @since 1.0.0
 */
export const slowLevelMs = 2_000

/**
 * The sources a call may read.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SourceName = Schema.Literals(["wiki", "repo", "commits", "facts"])

/**
 * What a call asks for.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  task: Schema.String.annotate({ description: "The task the context is for, in the run's own words" }),
  query: Schema.optional(Schema.String).annotate({
    description: "A narrower question within the task; the task alone when absent"
  }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Repository-relative files or directories to include without judging"
  }),
  sources: Schema.optional(Schema.Array(SourceName)).annotate({
    description: "Which of wiki, repo, commits and facts to read; all when absent"
  }),
  maxBytes: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024), Schema.isLessThanOrEqualTo(maxMaxBytes))
  ).annotate({ description: "The block's size in UTF-8 bytes, 1024 to 65536; 32768 when absent" })
})

/**
 * The decoded form of {@link Input}.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * What one candidate is.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ItemKind = Schema.Literals(["page", "skill", "dep", "dir", "file", "commit", "fact"])

/**
 * One candidate, kept or omitted, without its text. `p` is Jev's probability
 * that it is needed (or worth descending into); a seed's is 1. `decided`
 * says what settled it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Item = Schema.Struct({
  kind: ItemKind,
  id: Schema.String,
  digest: Schema.String,
  bytes: Schema.Int,
  p: Schema.Number,
  decided: Schema.Literals(["seed", "jev", "budget", "stale", "unjudged"])
})

/**
 * The decoded form of {@link Item}.
 *
 * @category models
 * @since 1.0.0
 */
export type Item = typeof Item.Type

/**
 * What a call returns. `context` is the one fenced block; `omitted` lists at
 * most {@link maxOmitted} ids; `cost` is the Jev spend.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  context: Schema.String,
  digest: Schema.String,
  kept: Schema.Array(Item),
  omitted: Schema.Array(Item),
  cost: Schema.Struct({ jevRequests: Schema.Int, jevMs: Schema.Number, candidates: Schema.Int }),
  unjudged: Schema.optional(Schema.Struct({ reason: AgentEvent.UnjudgedReason, detail: Schema.String }))
})

/**
 * The decoded form of {@link Output}.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * A call that could not decide: Jev failed other than by being unavailable
 * (`judge_failed`), the facts store failed (`facts_failed`), the host refused
 * a read of the repository (`read_failed`), or the repository's thresholds
 * file does not decode (`thresholds_invalid`). A path that is not there, and
 * a file or walked directory the host will not let it read, is skipped; a
 * denied seed fails, so a call never silently drops a path the task named.
 *
 * @category errors
 * @since 1.0.0
 */
export class MemoryFailed extends Schema.TaggedError<MemoryFailed>()("@smthrs/agent/Memory/MemoryFailed", {
  code: Schema.Literals(["judge_failed", "facts_failed", "read_failed", "thresholds_invalid"]),
  message: Schema.String
}) {}
// Jev is a dependency; the facts store and the host's filesystem are the
// platform's; a thresholds file that does not decode is the repository's.
Fault.register("@smthrs/agent/Memory/MemoryFailed", {
  judge_failed: "dependency",
  facts_failed: "infra",
  read_failed: "infra",
  thresholds_invalid: "user"
})

/**
 * What `memory` reads: every file. A host opens with the workspace only for a
 * launch whose capabilities allow this, so the opening and a later call are
 * refused alike.
 *
 * @category constants
 * @since 1.0.0
 */
export const reads = Capability.make("fs:read", "/**")

/**
 * The `memory` declaration.
 *
 * `sealed` is honest: a call that reads the live tree is re-keyed by the
 * frame's write count and tree digest, so a call after an edit is a new
 * question, and a resumed run replays the recorded block byte for byte.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = {
  name,
  description:
    "Context for a task in one call: wiki pages, skills, the code a README-guided walk finds, commits and their notes, and remembered facts, each chosen by Jev and packed into one block under maxBytes. Returns { context, kept, omitted, cost }; print context. paths are included without judging. Call it first on an unfamiliar task, and again with query when the task narrows.",
  input: Input,
  output: Output,
  capabilities: [Capability.format(reads), `model:call:${Evaluator.defaultModel}`],
  effects: { reads: [reads.resource], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
} as const

/**
 * What a host binds memory to.
 *
 * - `root` is the repository.
 * - `pages` replaces the wiki catalog, for a host that already holds fresh
 *   pages (planning passes its verified snapshot).
 * - `facts` reads remembered rows from these banks through these services.
 * - `thresholds` replaces the repository's own ({@link thresholds}).
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly root: string
  readonly pages?: ReadonlyArray<Wiki.Page> | undefined
  readonly facts?:
    | {
      readonly services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>
      readonly banks: ReadonlyArray<string>
    }
    | undefined
  readonly thresholds?: MemoryCalibration.Thresholds | undefined
}

/**
 * One wiki candidate a host supplies in `Options.pages`.
 *
 * @category models
 * @since 1.0.0
 */
export type Page = Wiki.Page

/**
 * One kept item with the text the block carries for it (a head when it did
 * not fit whole).
 *
 * @category models
 * @since 1.0.0
 */
export interface Kept extends Item {
  readonly text: string
}

/**
 * A selection: the call's output, the kept items with their text, every item
 * that cleared its threshold before the byte budget (`needed`, in pack order),
 * and every Jev request it took.
 *
 * @category models
 * @since 1.0.0
 */
export interface Selection {
  readonly output: Output
  readonly kept: ReadonlyArray<Kept>
  readonly needed: ReadonlyArray<Item>
  readonly asked: ReadonlyArray<Judgement.Asked>
  readonly unjudged?: Unjudged | undefined
}

/**
 * The services a selection reads through.
 *
 * @category models
 * @since 1.0.0
 */
export type Requirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const extensions = new Set([
  "c",
  "cc",
  "cfg",
  "cjs",
  "conf",
  "cpp",
  "cs",
  "css",
  "go",
  "gradle",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "lock",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "nix",
  "php",
  "proto",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "tf",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zig"
])
// Library names read exactly like a filename and never name a repository file.
const prose = new Set(["node.js", "next.js", "nuxt.js", "react.js", "three.js", "vue.js", "express.js"])
// A leading "/", "." or ".." is consumed rather than skipped, so an absolute
// or escaping mention is rejected as a path instead of matching its tail.
const candidate = /(?:\.{1,2}\/|[/.])?[A-Za-z0-9_][A-Za-z0-9_.@+-]*(?:\/[A-Za-z0-9_.@+-]+)*/g

/**
 * A repository-relative path, normalized, or `null` for an absolute or
 * escaping path and for private or runtime trees.
 *
 * @category paths
 * @since 1.0.0
 */
export const normalizePath: (value: string) => string | null = Repo.normalizePath

/**
 * Path-like tokens named by prose, oldest mention first and deduplicated.
 * Only tokens with a source-file extension count, so "e.g." is not a path.
 *
 * @category paths
 * @since 1.0.0
 */
export const extractPaths = (...texts: ReadonlyArray<string>): ReadonlyArray<string> => {
  const found: Array<string> = []
  const seen = new Set<string>()
  for (const text of texts) {
    // A URL names a network resource, not a file in this workspace.
    const prosaic = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " ")
    for (const [token] of prosaic.matchAll(candidate)) {
      const trimmed = token.replace(/[.\-_@+]+$/, "")
      const extension = trimmed.slice(trimmed.lastIndexOf(".") + 1).toLowerCase()
      if (!trimmed.includes(".") || !extensions.has(extension)) continue
      if (prose.has(trimmed.toLowerCase())) continue
      const normalized = normalizePath(trimmed)
      if (normalized === null || seen.has(normalized)) continue
      seen.add(normalized)
      found.push(normalized)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Jev readings
// ---------------------------------------------------------------------------

const Task = Schema.Struct({ task: Schema.String, query: Schema.optionalKey(Schema.String) })

/**
 * The state one memory reading sends, in UTF-8 bytes of its JSON. Below
 * `Judgement.maxStateBytes`: on 2026-09-28 the Jev gateway answered 400 to a
 * 256 KB state of repository text and accepted 120 KB, so memory packs its
 * items into requests of at most 64 KiB and sends them in parallel.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxStateBytes = 64 * 1024

/**
 * `memory/needed`: would an agent doing the task need to read this item
 * before acting?
 *
 * @category readings
 * @since 1.0.0
 */
export const needed = Judgement.perItem({
  id: "memory/needed",
  maxStateBytes,
  description: "Decide which candidate items an agent needs to read before acting on its task",
  context: Task,
  item: Schema.Struct({ kind: Schema.String, id: Schema.String, head: Schema.String }),
  questions: {
    needed: (i) =>
      Classifier.boolean({
        instructions:
          `Must an engineer doing context.task (narrowed by context.query when present) read items[${i}] before acting? Judge by items[${i}].kind and items[${i}].id first, then items[${i}].head, the start of it.`,
        criteria: {
          true: "it is code, a test, a doc or a record the task names, changes or plainly depends on",
          false: "it is about a different area than the task"
        }
      })
  }
})

/**
 * `memory/descend`: could what the task touches live under this directory?
 *
 * @category readings
 * @since 1.0.0
 */
export const descend = Judgement.perItem({
  id: "memory/descend",
  maxStateBytes,
  description: "Decide which directories of a repository could hold what a task touches",
  context: Task,
  item: Schema.Struct({ path: Schema.String, about: Schema.String }),
  questions: {
    descend: (i) =>
      Classifier.boolean({
        instructions:
          `Does the directory items[${i}].path contain files an engineer must open or edit to do context.task (narrowed by context.query when present)? Judge by its path first, then items[${i}].about, its README head or its entries.`,
        criteria: {
          true: "the task names or clearly implies this area",
          false: "the task is about a different area"
        }
      })
  }
})

/**
 * The reading Jev did not answer: why, and the classifier and item count it
 * asked, as the `decision-unjudged` row journals them.
 *
 * @category models
 * @since 1.0.0
 */
export interface Unjudged extends Judgement.Unjudged {
  readonly classifier: string
  readonly items: number
}

interface Judging {
  readonly asked: Array<Judgement.Asked>
  unjudged: Unjudged | undefined
}

/**
 * Reasons that leave a call with its seeds rather than failing it: Jev did
 * not answer (`unreachable`, `timeout`), or the host binds no judge at all
 * (`unconfigured`). A `refused` answer degrades too when it was a 429 or a
 * 5xx: the rule `EvaluatorBackup.withFallback` falls back by. Every other
 * failure is a judge that answered wrongly, and fails the call.
 */
const degrading = new Set(["unreachable", "timeout", "unconfigured"])

const unavailable = (error: Evaluator.EvaluatorError): boolean =>
  error.code === "refused" && error.status !== undefined && (error.status >= 500 || error.status === 429)

/**
 * One reading, recorded in `state`. `undefined` once any reading of the call
 * was unjudged; a failure other than {@link degrading} fails the call.
 * `Judgement.Unjudged` carries no status, so the bound Evaluator is watched
 * for the unavailable refusals the reading failed with.
 */
const judged = <A extends { readonly asked: ReadonlyArray<Judgement.Asked> }>(
  state: Judging,
  reading: Effect.Effect<A, Judgement.Unjudged>,
  asking: { readonly classifier: string; readonly items: number }
): Effect.Effect<A | undefined, MemoryFailed> =>
  state.unjudged !== undefined ? Effect.succeed(undefined) : Effect.gen(function*() {
    const refusals = new Set<string>()
    const bound = yield* Effect.serviceOption(Evaluator.Evaluator)
    const watched = Option.isNone(bound) ? reading : Effect.provideService(
      reading,
      Evaluator.Evaluator,
      Evaluator.Evaluator.of({
        evaluate: (request) =>
          bound.value.evaluate(request).pipe(Effect.tapError((error) =>
            Effect.sync(() => {
              if (unavailable(error)) refusals.add(Evaluator.publicMessage(error))
            })
          ))
      })
    )
    const result = yield* Effect.result(watched)
    if (result._tag === "Success") {
      state.asked.push(...result.success.asked)
      return result.success
    }
    if (
      degrading.has(result.failure.reason) ||
      (result.failure.reason === "refused" && refusals.has(result.failure.detail))
    ) {
      state.unjudged = { ...result.failure, ...asking }
      return undefined
    }
    return yield* new MemoryFailed({
      code: "judge_failed",
      message: `${result.failure.reason}: ${result.failure.detail}`
    })
  })

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const digestOf = (text: string): string => Digest.digest(text)

const candidateOf = (
  kind: Pack.Selected["kind"],
  id: string,
  text: string,
  p: number,
  decided: Pack.Selected["decided"]
): Pack.Selected => ({ kind, id, digest: digestOf(text), bytes: Repo.size(text), p, decided, text })

type Decided = MemoryCalibration.Thresholds["decisions"]

/** Judges `candidates` with `memory/needed`; splits them by their own kind's threshold. */
const neededOf = (
  state: Judging,
  context: typeof Task.Type,
  decisions: Decided,
  candidates: ReadonlyArray<Pack.Selected>
) =>
  Effect.gen(function*() {
    if (candidates.length === 0) return { kept: [], omitted: [] }
    const read = yield* judged(
      state,
      needed.read(
        context,
        candidates.map((item) => ({ kind: item.kind, id: item.id, head: Repo.headOf(item.text, headBytes) }))
      ),
      { classifier: needed.classifierFor(candidates.length).id, items: candidates.length }
    )
    if (read === undefined) return { kept: [], omitted: [] }
    const kept: Array<Pack.Selected> = []
    const omitted: Array<Pack.Selected> = []
    candidates.forEach((item, index) => {
      const p = read.answers[index]!.needed.probability
      const decision = decisions[item.kind as keyof Decided]
      ;(MemoryCalibration.include(decision, p) ? kept : omitted).push({ ...item, p })
    })
    return { kept, omitted }
  })

const wikiSource = (
  root: string,
  pages: ReadonlyArray<Wiki.Page> | undefined,
  state: Judging,
  context: typeof Task.Type,
  decisions: Decided
) =>
  Effect.gen(function*() {
    const all = pages ?? (yield* Wiki.catalog(root))
    const stale = all.filter((page) => page.stale === true).map((page) =>
      candidateOf(page.kind, page.id, page.text, 0, "stale")
    )
    const terms = RecallKeyword.normalizeQueryTerms(`${context.task}\n${context.query ?? ""}`)
    const ranked = all.filter((page) => page.stale !== true).map((page) => ({
      page,
      score: RecallKeyword.scoreRow(terms, {
        key: `${page.id} ${page.title}`,
        text: page.text,
        tags: [],
        updatedAtMs: 0
      })
    })).sort((left, right) =>
      right.score - left.score || (left.page.id < right.page.id ? -1 : left.page.id > right.page.id ? 1 : 0)
    ).slice(0, shortlist)
    const judgedPages = yield* neededOf(
      state,
      context,
      decisions,
      ranked.map(({ page }) => candidateOf(page.kind, page.id, page.text, 0, "jev"))
    )
    // A kept page brings the files its catalog says it explains.
    const inputs = judgedPages.kept.flatMap((item) =>
      all.find((page) => page.kind === item.kind && page.id === item.id)?.inputs ?? []
    )
    return { kept: judgedPages.kept, omitted: [...judgedPages.omitted, ...stale], inputs }
  })

const factsSource = (
  facts: NonNullable<Options["facts"]>,
  state: Judging,
  context: typeof Task.Type
) =>
  Effect.gen(function*() {
    const rows = yield* Effect.flatMap(Recall.Recall, (recall) =>
      recall.recall({
        banks: facts.banks,
        query: Repo.headOf(context.task, Recall.MAX_RECALL_QUERY_BYTES),
        maxTokens: 4096
      })).pipe(
        Effect.provideContext(facts.services),
        Effect.mapError((error) => new MemoryFailed({ code: "facts_failed", message: error.message }))
      )
    if (rows.length === 0) return { kept: [], omitted: [] }
    const reading = yield* judged(
      state,
      Relevance.judge(
        { task: context.task },
        rows.map((row) => ({ kind: "memory" as const, id: row.key, text: row.text }))
      ),
      { classifier: Relevance.reader.classifierFor(rows.length).id, items: rows.length }
    )
    // Granted facts Jev could not read are kept: the run-start relevance
    // reading still judges each row.
    if (reading === undefined) {
      return {
        kept: rows.map((row) => candidateOf("fact", `${row.bank}/${row.key}`, row.text, 1, "unjudged")),
        omitted: []
      }
    }
    const kept: Array<Pack.Selected> = []
    const omitted: Array<Pack.Selected> = []
    // Verdicts are in row order; a key may repeat across banks.
    reading.verdicts.forEach((verdict, index) =>
      (verdict.withheld ? omitted : kept).push(
        candidateOf("fact", `${rows[index]!.bank}/${verdict.item.id}`, verdict.item.text, 1 - verdict.p, "jev")
      )
    )
    return { kept, omitted }
  })

const readmeOf = (entry: Repo.Entry): string | undefined =>
  entry.files.find((file) => /^readme(?:\.(?:md|mdx|txt))?$/i.test(file.slice(file.lastIndexOf("/") + 1)))

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

/**
 * A directory as the walk shows it: its README head, then its entries (at
 * most 64 names, directories marked with a trailing slash, and a `+N` count
 * past them). The names carry what a generic README head does not: `apps/`
 * whose README never says "tui" still lists `tui/`.
 */
const about = (root: string, tree: Repo.Tree, dir: string) =>
  Effect.gen(function*() {
    const entry = tree.get(dir)!
    const readme = readmeOf(entry)
    const head = readme === undefined ? undefined : yield* Repo.head(root, readme, aboutBytes)
    const names = [...entry.dirs.map((path) => `${basename(path)}/`), ...entry.files.map(basename)].sort()
    const listed = names.slice(0, 64).join(", ") + (names.length > 64 ? ` +${names.length - 64}` : "")
    return head === undefined ? `entries: ${listed}` : `${head}\nentries: ${listed}`
  })

/**
 * The README walk: the directories kept, in visit order, and those omitted.
 * Every child is judged itself; one without a README by its entries. At most
 * {@link maxFilesPerDir} children of one directory are judged, by name; the
 * rest are omitted unread as `budget`.
 */
const walk = (root: string, tree: Repo.Tree, state: Judging, context: typeof Task.Type, decisions: Decided) =>
  Effect.gen(function*() {
    const kept: Array<string> = [""]
    const omitted: Array<Pack.Selected> = []
    let frontier: ReadonlyArray<string> = [""]
    let levels = maxLevels
    for (let level = 0; level < levels && frontier.length > 0 && kept.length - 1 < maxDirs; level++) {
      const children = frontier.flatMap((parent) => tree.get(parent)!.dirs.slice(0, maxFilesPerDir))
      omitted.push(
        ...frontier.flatMap((parent) => tree.get(parent)!.dirs.slice(maxFilesPerDir)).map((path) =>
          candidateOf("dir", path, "", 0, "budget")
        )
      )
      if (children.length === 0) break
      const items = yield* Effect.forEach(
        children,
        (path) => Effect.map(about(root, tree, path), (text) => ({ path, about: text }))
      )
      const started = Date.now()
      const read = yield* judged(state, descend.read(context, items), {
        classifier: descend.classifierFor(items.length).id,
        items: items.length
      })
      if (read === undefined) break
      if (Date.now() - started > slowLevelMs) levels = Math.min(levels, 3)
      const scored = items.map((item, index) => ({ ...item, p: read.answers[index]!.descend.probability }))
        .sort((left, right) => right.p - left.p || (left.path < right.path ? -1 : 1))
      const perParent = new Map<string, number>()
      const next: Array<string> = []
      for (const child of scored) {
        const parent = parentOf(child.path)
        const taken = perParent.get(parent) ?? 0
        if (
          taken < maxChildren && kept.length - 1 + next.length < maxDirs &&
          MemoryCalibration.include(decisions.descend, child.p)
        ) {
          perParent.set(parent, taken + 1)
          next.push(child.path)
        } else {
          omitted.push(candidateOf("dir", child.path, child.about, child.p, "jev"))
        }
      }
      kept.push(...next)
      frontier = next
    }
    return { kept, omitted }
  })

/** Instruction files every harness already reads itself. */
const instructions = /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/

const binary = /\.(?:png|jpe?g|gif|ico|webp|svg|pdf|zip|gz|tgz|wasm|woff2?|ttf|otf|db|sqlite|lockb|mp4|mov|bin)$/i

/**
 * `files`, then the files of `dirs`, other than `exclude`, as unjudged
 * candidates; the files past {@link maxFilesPerDir} or {@link maxFiles} are
 * `dropped` unread, as `budget` rows.
 */
const leaves = (
  root: string,
  tree: Repo.Tree,
  files: ReadonlyArray<string>,
  dirs: ReadonlyArray<string>,
  exclude: ReadonlySet<string>
) =>
  Effect.gen(function*() {
    const paths: Array<string> = [...files]
    const past: Array<string> = []
    for (const dir of new Set(dirs)) {
      const all = tree.get(dir)?.files ?? []
      paths.push(...all.slice(0, maxFilesPerDir))
      past.push(...all.slice(maxFilesPerDir))
    }
    const eligible = (file: string) => !exclude.has(file) && !binary.test(file) && !instructions.test(file)
    const unique = [...new Set(paths)].filter(eligible)
    const asked = new Set(unique.slice(0, maxFiles))
    const heads = yield* Effect.forEach(
      [...asked],
      (path) => Effect.map(Repo.head(root, path, headBytes), (head) => ({ path, head })),
      { concurrency: 16 }
    )
    const dropped = [...new Set([...unique.slice(maxFiles), ...past])].filter((file) =>
      eligible(file) && !asked.has(file)
    )
    return {
      candidates: heads.flatMap(({ head, path }) =>
        head === undefined ? [] : [candidateOf("file", path, head, 0, "jev")]
      ),
      dropped: dropped.map((path) => candidateOf("file", path, "", 0, "budget"))
    }
  })

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")))

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const publicItem = (item: Pack.Selected): Item => ({
  kind: item.kind,
  id: item.id,
  digest: item.digest,
  bytes: item.bytes,
  p: Number(item.p.toFixed(4)),
  decided: item.decided
})

/**
 * `root`'s own thresholds: {@link MemoryCalibration.file} when present, else
 * `MemoryCalibration.initial`. A present file that does not decode fails as
 * `thresholds_invalid`, never silently replaced by the defaults.
 *
 * @category constructors
 * @since 1.0.0
 */
export const thresholds = (
  root: string
): Effect.Effect<MemoryCalibration.Thresholds, MemoryFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = (yield* Path.Path).join(root, MemoryCalibration.file)
    const text = yield* fs.readFileString(file).pipe(
      Effect.catch(Repo.absent(undefined)),
      Effect.mapError((error) =>
        new MemoryFailed({ code: "read_failed", message: `${error.reason._tag}: ${error.message}` })
      )
    )
    if (text === undefined) return MemoryCalibration.initial
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryCalibration.Thresholds))(text).pipe(
      Effect.mapError((error) =>
        new MemoryFailed({ code: "thresholds_invalid", message: `${MemoryCalibration.file}: ${error.message}` })
      )
    )
  })

/**
 * Selects the context for `input` in `options.root`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const select = (input: Input, options: Options): Effect.Effect<Selection, MemoryFailed, Requirements> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const decisions = (options.thresholds ?? (yield* thresholds(options.root))).decisions
    const maxBytes = Math.min(maxMaxBytes, Math.max(1024, Math.floor(input.maxBytes ?? defaultMaxBytes)))
    const sources = new Set(input.sources ?? SourceName.literals)
    const context: typeof Task.Type = input.query === undefined
      ? { task: Judgement.task(input.task) }
      : { task: Judgement.task(input.task), query: Judgement.task(input.query) }
    const state: Judging = { asked: [], unjudged: undefined }

    // Seeds: named paths that exist, kept whole and never judged. They are
    // the repository's, so they are read only when `repo` is a source; a
    // named commit is read only when `commits` is.
    const named = !sources.has("repo") ? [] : [
      ...new Set([
        ...(input.paths ?? []).flatMap((value) => {
          const normalized = normalizePath(value.replace(/^\.\//, "").replace(/\/+$/, ""))
          return normalized === null ? [] : [normalized]
        }),
        ...extractPaths(input.task, input.query ?? "")
      ])
    ]
    const seedFiles: Array<Pack.Selected> = []
    const seedDirs: Array<string> = []
    const rootReal = named.length === 0 ? "" : yield* fs.realPath(options.root)
    for (const relative of named) {
      // A seed is refused unless it resolves inside the root: a tracked link
      // in a parent directory may point anywhere.
      const real = yield* Repo.inside(fs, path, rootReal, path.join(options.root, relative))
      if (real === undefined) continue
      const info = yield* fs.stat(real)
      if (info.type === "Directory") seedDirs.push(relative)
      // A named file the host will not let memory read fails the call
      // (`read_failed`) rather than vanish from the block unmentioned.
      const text = info.type === "File"
        ? yield* Repo.head(options.root, relative, Wiki.pageBytes, { denied: "fail" })
        : undefined
      if (text !== undefined) seedFiles.push(candidateOf("file", relative, text, 1, "seed"))
    }
    const seedCommits = Commits.commitIds(`${input.task}\n${input.query ?? ""}`)

    const needsTree = sources.has("repo")
    const tree = needsTree ? yield* Repo.tree(options.root) : undefined
    const [wiki, facts, walked] = yield* Effect.all([
      sources.has("wiki")
        ? wikiSource(options.root, options.pages, state, context, decisions)
        : Effect.succeed(undefined),
      sources.has("facts") && options.facts !== undefined
        ? factsSource(options.facts, state, context)
        : Effect.succeed(undefined),
      tree === undefined ? Effect.succeed(undefined) : walk(options.root, tree, state, context, decisions)
    ], { concurrency: "unbounded" })

    // Files: those kept pages explain or cite, then those of the seeds'
    // directories, the cited files' directories and the walked directories.
    const cited = [
      ...(wiki?.inputs ?? []).flatMap((input) => {
        const normalized = normalizePath(input)
        return normalized === null ? [] : [normalized]
      }),
      ...extractPaths(...(wiki?.kept ?? []).map((page) => page.text))
    ].filter((cite) => tree?.get(parentOf(cite))?.files.includes(cite) === true)
    const seeded = new Set(seedFiles.map((seed) => seed.id))
    const offered = tree === undefined || walked === undefined
      ? { candidates: [], dropped: [] }
      : yield* leaves(options.root, tree, cited, [
        ...seedDirs,
        ...seedFiles.map((seed) => parentOf(seed.id)),
        ...cited.map(parentOf),
        ...walked.kept
      ], seeded)
    const files = yield* neededOf(state, context, decisions, offered.candidates)
    const keptFiles = yield* Effect.forEach(
      files.kept,
      (file) =>
        Effect.map(
          Repo.head(options.root, file.id, Wiki.pageBytes),
          (text) => text === undefined ? file : candidateOf("file", file.id, text, file.p, "jev")
        )
    )

    // A commit the task names by id is a seed: kept, never judged.
    const history = sources.has("commits")
      ? (yield* Commits.read(options.root, [...seedFiles, ...keptFiles].map((file) => file.id), seedCommits)).map(
        (commit) => {
          const seed = seedCommits.some((id) => commit.commitId.startsWith(id))
          return candidateOf("commit", commit.commitId.slice(0, 12), commit.text, seed ? 1 : 0, seed ? "seed" : "jev")
        }
      )
      : []
    const seeds = [...seedFiles, ...history.filter((commit) => commit.decided === "seed")]
    const commits = yield* neededOf(state, context, decisions, history.filter((commit) => commit.decided !== "seed"))

    const chosen = state.unjudged !== undefined
      ? [...seeds, ...(facts?.kept ?? [])]
      : [...seeds, ...(facts?.kept ?? []), ...(wiki?.kept ?? []), ...keptFiles, ...commits.kept]
    const packed = Pack.pack(chosen, maxBytes)
    const omitted = state.unjudged !== undefined ? packed.omitted : [
      ...packed.omitted,
      ...(wiki?.omitted ?? []),
      ...(facts?.omitted ?? []),
      ...(walked?.omitted ?? []),
      ...files.omitted,
      ...offered.dropped,
      ...commits.omitted
    ]
    const candidates = state.asked.reduce(
      (total, asked) => total + Object.keys(asked.questions).length,
      0
    )
    const output: Output = {
      context: packed.context,
      digest: digestOf(packed.context),
      kept: packed.kept.map(publicItem),
      omitted: [...omitted].sort((left, right) => right.p - left.p || (left.id < right.id ? -1 : 1)).slice(
        0,
        maxOmitted
      ).map(publicItem),
      cost: {
        jevRequests: state.asked.length,
        jevMs: state.asked.reduce((total, asked) => total + asked.latencyMs, 0),
        candidates
      },
      ...(state.unjudged === undefined
        ? {}
        : { unjudged: { reason: state.unjudged.reason, detail: state.unjudged.detail } })
    }
    return {
      output,
      kept: packed.kept.map((item) => ({ ...publicItem(item), text: item.text })),
      needed: [...chosen].sort(Pack.order).map(publicItem),
      asked: state.asked,
      ...(state.unjudged === undefined ? {} : { unjudged: state.unjudged })
    }
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new MemoryFailed({
          code: "read_failed",
          message: `${error.reason._tag}: ${error.message}`
        })
      ))
  )

// ---------------------------------------------------------------------------
// Binding, plugin and frame 0
// ---------------------------------------------------------------------------

/**
 * Journals a selection's readings into the calling run: a `decision-settled`
 * row per Jev request, or the `decision-unjudged` row.
 */
const journal = (selection: Selection, call: Cell.Call) =>
  Effect.gen(function*() {
    const write = yield* AgentEvent.Journal
    const at = { scope: call.identity.session, frame: call.identity.frame }
    for (const asked of selection.asked) yield* write(Judgement.decision(asked, { ...at, acted: true }))
    if (selection.unjudged !== undefined) {
      yield* write(
        Judgement.unjudgedEvent(selection.unjudged, {
          ...at,
          classifier: selection.unjudged.classifier,
          items: selection.unjudged.items
        })
      )
    }
  })

/**
 * The version of the selection rules. It joins the step key beside the
 * thresholds digest, so a changed rule never replays an old selection.
 *
 * @category constants
 * @since 1.0.0
 */
export const version = "memory/v1"

/**
 * `memory` bound to `services`, reading `options.root`.
 *
 * The step key carries {@link version}, the root and the thresholds digest.
 * It selects with `options.thresholds`, `MemoryCalibration.initial` when
 * absent; {@link source} binds the repository's own.
 *
 * @category constructors
 * @since 1.0.0
 */
export const binding = (
  services: Context.Context<Requirements | Evaluator.Evaluator>,
  options: Options
): FlowBinding.Binding => {
  const pinned = options.thresholds ?? MemoryCalibration.initial
  // Each relevance reading a call takes is charged to the calling run (#3010).
  const judged = FlowEngineLike.metered(services)
  const handler = (input: Input, call: Cell.Call) =>
    select(input, { ...options, thresholds: pinned }).pipe(
      Effect.tap((selection) => journal(selection, call)),
      Effect.map((selection) => selection.output)
    )
  return FlowBinding.provide(
    FlowBinding.make({
      flow,
      handler,
      publicError: (error: MemoryFailed) => `${error.code}: ${error.message}`,
      activity: "reads",
      presentation: {
        verb: { pending: "recalling context", success: "recalled context", failure: "failed to recall context" },
        subject: "none",
        result: "none"
      },
      bodyDigest: Digest.digest(Digest.canonical({
        version,
        root: options.root,
        thresholds: MemoryCalibration.digest(pinned)
      }))
    }),
    judged
  )
}

/**
 * The `memory` flows source: {@link binding} with the repository's
 * {@link thresholds}, read each time a run resolves its flows with authority
 * for {@link reads}; otherwise `MemoryCalibration.initial` is pinned without
 * reading the repository. An authorized thresholds file that does not decode
 * fails the run's assembly.
 *
 * @category constructors
 * @since 1.0.0
 */
export const source = (
  services: Context.Context<Requirements | Evaluator.Evaluator>,
  options: Options
): FlowBinding.Source => ({
  name,
  bindings: () =>
    Effect.gen(function*() {
      const ceiling = yield* CapabilitySet.current
      const fitted = options.thresholds ?? (CapabilitySet.allows(ceiling, reads)
        ? yield* thresholds(options.root).pipe(Effect.provideContext(services))
        : MemoryCalibration.initial)
      return [binding(services, { ...options, thresholds: fitted })]
    }).pipe(
      Effect.mapError((error) =>
        new HarnessError({ code: "assembly_failed", message: `${error.code}: ${error.message}` })
      )
    )
})

/**
 * The memory plugin: {@link binding} contributed through
 * `CellPlugin.fromBindings`. Pass it in `Agent.Options.plugins`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const plugin = (
  services: Context.Context<Requirements | Evaluator.Evaluator>,
  options: Options
): FlowsPlugin<FlowsHooks> => CellPlugin.fromBindings({ name, bindings: [binding(services, options)] })

/**
 * A selection as `Agent.Options.memory`: one row per kept item, keyed
 * `<kind>/<id>`, so the run-start relevance reading can still withhold any
 * row at `Relevance.withholdAt`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const declared = (selection: Selection): MemorySource.Declared => {
  const rows = selection.kept.map((item) => ({
    origin: "recall" as const,
    bank: name,
    key: `${item.kind}/${item.id}`,
    // A head says it is one, as the block does.
    text: Repo.size(item.text) < item.bytes ? item.text + Pack.cut : item.text
  }))
  return { rows, digest: Digest.digest(MemorySource.render(rows)) }
}

/**
 * The host's frame-0 call: the same selection for `task`, packed to
 * {@link openingMaxBytes}, as `Agent.Options.memory`, with the reading Jev
 * did not answer for the host to log.
 *
 * @category constructors
 * @since 1.0.0
 */
export const opening = (
  task: string,
  options: Options
): Effect.Effect<
  {
    readonly memory: MemorySource.Declared
    readonly selection: Selection
    readonly unjudged: Unjudged | undefined
  },
  MemoryFailed,
  Requirements
> =>
  Effect.map(select({ task, maxBytes: openingMaxBytes }, options), (selection) => ({
    memory: declared(selection),
    selection,
    unjudged: selection.unjudged
  }))
