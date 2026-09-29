/**
 * `memory/calibrate`: refit every memory decision's threshold from journal
 * labels and landed fixes.
 *
 * {@link calibrate} is pure: it runs `MemoryCalibration.refit` per decision
 * and keeps the current setting of every decision whose fit was refused.
 * {@link run} gathers the labels (journals plus the last `landed` commits on
 * `main`), calibrates, and writes `.smithers/memory-thresholds.json` only when
 * asked.
 */
import type * as Memory from "@smthrs/agent/Memory"
import * as MemoryCalibration from "@smthrs/agent/MemoryCalibration"
import { Fault } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import * as Labels from "./labels.ts"
import * as Landed from "./landed.ts"
import * as Thresholds from "./thresholds.ts"

type Decision = MemoryCalibration.Decision

const all: ReadonlyArray<Decision> = MemoryCalibration.Decision.literals

/** A journal directory or journal file that could not be read or parsed. */
export class JournalInvalid extends Schema.TaggedError<JournalInvalid>()("flows/memory/JournalInvalid", {
  path: Schema.String,
  message: Schema.String
}) {}
// A journal that cannot be listed, read or parsed is the run store's, not the caller's.
Fault.register("flows/memory/JournalInvalid", "infra")

/** One decision's line in the receipt. */
export const DecisionReceipt = Schema.Struct({
  labels: Schema.Number,
  outcome: Schema.Literals(["refit", "too_few_labels", "move_too_large"]),
  from: Schema.Number,
  proposed: Schema.Number,
  to: Schema.Number
})
export type DecisionReceipt = typeof DecisionReceipt.Type

/** What one calibration measured and decided. */
export const Receipt = Schema.Struct({
  perDecision: Schema.Record(MemoryCalibration.Decision, DecisionReceipt),
  recallAtBudget: Schema.NullOr(Schema.Number),
  /** Landed commits `recallAtBudget` pools. */
  items: Schema.Number,
  /** Landed commits left out of `recallAtBudget` because Jev never judged them. */
  unjudged: Schema.Number,
  restoreRate: Schema.NullOr(Schema.Number),
  instructionMisses: Schema.Number,
  n: Schema.Number
})
export type Receipt = typeof Receipt.Type

/** One landed commit's evaluation, without its labels. */
export const LandedItem = Schema.Struct({
  commit: Schema.String,
  issue: Schema.optional(Schema.Number),
  needed: Schema.Array(Schema.String),
  found: Schema.Array(Schema.String),
  seeded: Schema.Number,
  recall: Schema.NullOr(Schema.Number),
  bytes: Schema.Number,
  jevMs: Schema.Number,
  unjudged: Schema.optional(Schema.String)
})

/** Where a calibration's labels came from and what the landed fixes measured. */
export const Evidence = Schema.Struct({
  journals: Schema.Number,
  /** TUI sessions with no harness event: tabs that never ran an agent. */
  skippedJournals: Schema.Number,
  restores: Schema.Number,
  withheldFlows: Schema.Number,
  labelSources: Schema.Record(Schema.Literals(Labels.sources), Schema.Number),
  landed: Schema.Struct({
    recall: Schema.NullOr(Schema.Number),
    items: Schema.Number,
    unjudged: Schema.Number,
    needed: Schema.Number,
    found: Schema.Number,
    meanPerItem: Schema.NullOr(Schema.Number),
    budgetBytes: Schema.Number,
    commits: Schema.Array(LandedItem)
  })
})
export type Evidence = typeof Evidence.Type

/** What {@link calibrate} reads. */
export interface Input {
  readonly labels: Partial<Readonly<Record<Decision, ReadonlyArray<MemoryCalibration.Label>>>>
  readonly current: MemoryCalibration.Thresholds
  readonly recallAtBudget?: number | null
  readonly items?: number
  readonly unjudged?: number
  readonly restoreRate?: number | null
  readonly instructionMisses?: number
}

/** Refits each decision; a refused decision keeps its current setting. */
export const calibrate = (input: Input): { thresholds: MemoryCalibration.Thresholds; receipt: Receipt } => {
  const decisions = { ...input.current.decisions }
  const perDecision = {} as Record<Decision, DecisionReceipt>
  let n = 0
  for (const decision of all) {
    const labels = input.labels[decision] ?? []
    n += labels.length
    const current = input.current.decisions[decision]
    const fitted = MemoryCalibration.refit(current, labels)
    if (fitted._tag === "Refit") decisions[decision] = fitted.decided
    perDecision[decision] = {
      labels: labels.length,
      outcome: fitted._tag === "Refit" ? "refit" : fitted.reason,
      from: current.tau,
      proposed: fitted._tag === "Refit" ? fitted.decided.tau : fitted.proposed,
      to: decisions[decision].tau
    }
  }
  return {
    thresholds: { ...input.current, decisions },
    receipt: {
      perDecision,
      recallAtBudget: input.recallAtBudget ?? null,
      items: input.items ?? 0,
      unjudged: input.unjudged ?? 0,
      restoreRate: input.restoreRate ?? null,
      instructionMisses: input.instructionMisses ?? 0,
      n
    }
  }
}

/** What {@link run} reads. */
export interface RunOptions {
  readonly root: string
  /** Directory of `*.jsonl` journals, searched recursively; none when absent. */
  readonly journals?: string | undefined
  /** Only journals whose file name starts with this. */
  readonly journalPrefix?: string | undefined
  /** How many landed commits on `main` to evaluate, 0 to {@link maxLanded}; none when 0. */
  readonly landed: number
  readonly write: boolean
  readonly memory?: Omit<Memory.Options, "root" | "thresholds"> | undefined
}

const invalid = (path: string) => (cause: unknown) =>
  new JournalInvalid({ path, message: cause instanceof Error ? cause.message : String(cause) })

/**
 * Reads every `*.jsonl` journal under `dir`, subdirectories included (the
 * TUI keeps one folder per working directory), into one run's labels each.
 * A TUI session with a header and no harness event (a tab that never ran an
 * agent) is skipped and counted; any other journal with no harness event is
 * {@link JournalInvalid}: it would add a run with no labels.
 */
export const journalLabels = (dir: string, prefix = "") =>
  Effect.gen(function*() {
    const names = yield* Effect.tryPromise({ try: () => readdir(dir, { recursive: true }), catch: invalid(dir) })
    const read = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".jsonl") && basename(name).startsWith(prefix)).sort(),
      (name) => {
        const path = join(dir, name)
        return Effect.tryPromise({
          try: async () => {
            const journal = Labels.journalOf(Labels.parseJsonl(await readFile(path, "utf8")))
            if (journal.events.length > 0) return Labels.fromEvents(journal.events, journal.cwd)
            if (journal.cwd !== undefined) return undefined
            throw new Error("no harness events")
          },
          catch: invalid(path)
        })
      }
    )
    const runs = read.filter((one) => one !== undefined)
    return { runs, skipped: read.length - runs.length }
  })

/** The most landed commits one calibration evaluates. */
export const maxLanded = 500

/**
 * Gathers labels, calibrates, and writes the fit when `options.write`.
 * `landed` outside 0 to {@link maxLanded} fails with `LandedFailed`.
 */
export const run = (options: RunOptions) =>
  Effect.gen(function*() {
    if (!Number.isSafeInteger(options.landed) || options.landed < 0 || options.landed > maxLanded) {
      return yield* new Landed.LandedFailed({
        message: `landed must be an integer from 0 to ${maxLanded}, got ${options.landed}`
      })
    }
    const current = yield* Thresholds.load(options.root)
    const { runs, skipped } = options.journals === undefined
      ? { runs: [], skipped: 0 }
      : yield* journalLabels(options.journals, options.journalPrefix)
    const commits = options.landed > 0 ? yield* Landed.landedCommits(options.root, options.landed) : []
    const evaluated = yield* Landed.evaluateAll(options.root, commits, { ...options.memory, thresholds: current })
    const labels = [...runs.flatMap((one) => one.labels), ...evaluated.flatMap((one) => one.labels)]
    const restores = runs.reduce((total, one) => total + one.restores, 0)
    const withheld = runs.reduce((total, one) => total + one.withheldFlows, 0)
    const recall = Landed.recallAtBudget(evaluated)
    const { receipt, thresholds } = calibrate({
      labels: Labels.byDecision(labels),
      current,
      recallAtBudget: recall.recall,
      items: recall.items,
      unjudged: recall.unjudged,
      restoreRate: withheld === 0 ? null : Number((restores / withheld).toFixed(4)),
      instructionMisses: runs.reduce((total, one) => total + one.instructionMisses, 0)
    })
    if (options.write) yield* Thresholds.write(options.root, thresholds, receipt)
    const evidence: Evidence = {
      journals: runs.length,
      skippedJournals: skipped,
      restores,
      withheldFlows: withheld,
      labelSources: Object.fromEntries(
        Labels.sources.map((source) => [source, labels.filter((label) => label.source === source).length])
      ) as Record<Labels.Source, number>,
      landed: {
        ...recall,
        budgetBytes: Landed.budget,
        commits: evaluated.map(({ labels: _labels, ...rest }) => rest)
      }
    }
    return { receipt, thresholds, evidence, written: options.write }
  })
