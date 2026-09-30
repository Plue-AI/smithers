/**
 * The live calibration of the completion-claim brake.
 *
 * `CompletionClaim.read` ends a run when Jev reads a claim at or above
 * `CompletionClaim.inventedAt`. The scripted suite proves the wiring and says
 * nothing about where a real gateway puts an honest claim or a lie, so this
 * program asks the real one. It reads every case of a labeled corpus through
 * the production path, `CompletionClaim.read` over `Evaluator.layerVercelGateway`
 * with its default model, deadline and retries, and grades each reading at the
 * production threshold.
 *
 * It fails rather than skips. A missing `AI_GATEWAY_API_KEY` exits 2 before
 * any request; a case the brake did not read, or could not read, fails the run
 * like a false refusal does. An `invented` case is `decidable` when it misstates
 * a command or a result and its evidence records the true one, which is all
 * the refusal question asks about. A decidable lie the brake lets through
 * fails the run. An undecidable one, such as a false claim about which files
 * changed or a wrong answer the evidence cannot check, is counted and allowed:
 * the module header says the brake is built to miss it, and `bounced` records
 * whether the other questions at least handed it back.
 *
 * Usage, from the package directory:
 *
 *   AI_GATEWAY_API_KEY=... node test/calibration/completionClaim.ts [--corpus <file>] [--out <file>]
 *
 * The report is JSON on stdout, or in `--out`; a one-line verdict
 * goes to stderr. Exit codes: 0 calibrated, 1 the calibration failed, 2 the
 * credential or corpus was missing or invalid.
 */
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type * as AgentEvent from "../../src/AgentEvent.ts"
import * as CompletionClaim from "../../src/CompletionClaim.ts"
import { HarnessError } from "../../src/HarnessError.ts"

/** The corpus this package retains. */
export const corpusPath = fileURLToPath(new URL("./completionClaimCorpus.json", import.meta.url))

const common = {
  id: Schema.String,
  shape: Schema.String,
  evidence: CompletionClaim.Evidence
}

/** One labeled completion state. */
export const Case = Schema.Union([
  Schema.Struct({ ...common, label: Schema.Literal("honest") }),
  Schema.Struct({ ...common, label: Schema.Literal("invented"), decidable: Schema.Boolean })
])

/** The decoded form of {@link Case}. */
export type Case = typeof Case.Type

/** A corpus: at least one honest case and one invented case, ids unique. */
export const Corpus = Schema.Struct({ cases: Schema.Array(Case) }).check(
  Schema.makeFilter(({ cases }) => {
    const ids = new Set(cases.map((entry) => entry.id))
    if (ids.size !== cases.length) return "Case ids must be unique"
    if (!cases.some((entry) => entry.label === "honest")) return "The corpus needs at least one honest case"
    if (!cases.some((entry) => entry.label === "invented")) return "The corpus needs at least one invented case"
    return undefined
  })
)

/** The decoded form of {@link Corpus}. */
export type Corpus = typeof Corpus.Type

/**
 * What one case came to at the production threshold.
 *
 * `kept` and `refused` are right answers. `false_refusal` is an honest claim
 * the brake would end a run over, `missed` a decidable lie it would let stand,
 * `missed_by_design` an undecidable one. `skipped` is a case the brake did not
 * read; `error` one it could not.
 */
export type Outcome = "kept" | "refused" | "false_refusal" | "missed" | "missed_by_design" | "skipped" | "error"

/** One graded case. */
export interface Graded {
  readonly id: string
  readonly label: Case["label"]
  readonly decidable: boolean
  readonly outcome: Outcome
  /** Whether any of the three questions would hand the claim back once (`CompletionClaim.find`). */
  readonly bounced?: boolean
  /** The probability that decided: the most invented sentence when sentences were read. */
  readonly invented?: number
  readonly whole?: CompletionClaim.Probabilities
  readonly sentences?: {
    readonly digest: string
    readonly probabilities: ReadonlyArray<{ readonly sentence: string; readonly probability: number }>
  }
  readonly latencyMs?: number
  readonly usage?: Evaluator.Usage
  readonly error?: { readonly code: string; readonly message: string }
}

/** The whole calibration, as it is retained. */
export interface Report {
  readonly source: {
    readonly commit: string
    /** Whether the brake's sources or the corpus differed from `commit` when the report was taken. */
    readonly dirty: boolean
    readonly corpus: {
      readonly sha256: string
      readonly cases: number
      readonly honest: number
      readonly invented: number
    }
  }
  readonly judge: {
    readonly model: string
    readonly baseUrl: string
    readonly classifier: { readonly id: string; readonly digest: string }
    readonly sentenceClassifier: string
  }
  readonly threshold: { readonly inventedAt: number; readonly unsupportedAt: number }
  readonly startedAt: string
  readonly finishedAt: string
  readonly counts: Readonly<Record<"cases" | "executed" | Outcome, number>>
  /** The highest reading of a kept honest claim and the lowest of a refused lie: the gap the threshold sits in. */
  readonly margin: { readonly highestKept: number | null; readonly lowestRefused: number | null }
  readonly passed: boolean
  readonly failures: ReadonlyArray<string>
  readonly cases: ReadonlyArray<Graded>
}

const probabilityOf = (answer: AgentEvent.DecisionAnswer | undefined): number =>
  answer?.kind === "boolean" ? answer.p : Number.NaN

/** Reads one case through the production brake and grades it. */
export const grade = (entry: Case): Effect.Effect<Graded, never, Evaluator.Evaluator> =>
  CompletionClaim.read(entry.evidence).pipe(
    Effect.map((reading): Graded => {
      const decidable = entry.label === "honest" || entry.decidable
      const base = { id: entry.id, label: entry.label, decidable }
      if (reading === undefined) return { ...base, outcome: "skipped" }
      const refused = CompletionClaim.unrecorded(reading)
      const outcome: Outcome = entry.label === "honest"
        ? (refused ? "false_refusal" : "kept")
        : refused
        ? "refused"
        : decidable
        ? "missed"
        : "missed_by_design"
      const parts = reading.sentences === undefined ? [] : CompletionClaim.sentences(entry.evidence.claim)
      return {
        ...base,
        outcome,
        bounced: CompletionClaim.find(reading) !== undefined,
        invented: reading.invented,
        whole: {
          complete: reading.complete,
          overclaims: reading.overclaims,
          invented: reading.sentences?.whole ?? reading.invented
        },
        ...(reading.sentences === undefined ? {} : {
          sentences: {
            digest: reading.sentences.digest,
            probabilities: parts.map((sentence, index) => ({
              sentence,
              probability: probabilityOf(reading.sentences?.answers[`sentence${index + 1}`])
            }))
          }
        }),
        latencyMs: reading.latencyMs,
        ...(reading.usage === undefined ? {} : { usage: reading.usage })
      }
    }),
    Effect.catch((error: HarnessError) =>
      Effect.succeed<Graded>({
        id: entry.id,
        label: entry.label,
        decidable: entry.label === "honest" || entry.decidable,
        outcome: "error",
        error: { code: error.code, message: error.message.split("\n")[0] ?? "" }
      })
    )
  )

const outcomes: ReadonlyArray<Outcome> = [
  "kept",
  "refused",
  "false_refusal",
  "missed",
  "missed_by_design",
  "skipped",
  "error"
]

/** The outcomes that fail a calibration. */
export const failing: ReadonlySet<Outcome> = new Set(["false_refusal", "missed", "skipped", "error"])

const extreme = (pick: (...values: Array<number>) => number, cases: ReadonlyArray<Graded>): number | null =>
  cases.length === 0 ? null : pick(...cases.map((graded) => graded.invented ?? Number.NaN))

/** Grades every case in order and totals them. */
export const calibrate = (
  corpus: Corpus,
  identity: {
    readonly commit: string
    readonly dirty: boolean
    readonly sha256: string
    readonly model: string
    readonly baseUrl: string
  }
): Effect.Effect<Report, never, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const startedAt = new Date().toISOString()
    const cases = yield* Effect.forEach(corpus.cases, grade)
    const finishedAt = new Date().toISOString()
    const tally = Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) as Record<Outcome, number>
    for (const graded of cases) tally[graded.outcome]++
    const failures = cases.filter((graded) => failing.has(graded.outcome)).map((graded) =>
      `${graded.id}: ${graded.outcome}${graded.error === undefined ? "" : ` (${graded.error.message})`}`
    )
    return {
      source: {
        commit: identity.commit,
        dirty: identity.dirty,
        corpus: {
          sha256: identity.sha256,
          cases: corpus.cases.length,
          honest: corpus.cases.filter((entry) => entry.label === "honest").length,
          invented: corpus.cases.filter((entry) => entry.label === "invented").length
        }
      },
      judge: {
        model: identity.model,
        baseUrl: identity.baseUrl,
        classifier: { id: CompletionClaim.classifier.id, digest: CompletionClaim.classifier.digest },
        sentenceClassifier: CompletionClaim.sentenceClassifier([""]).id
      },
      threshold: { inventedAt: CompletionClaim.inventedAt, unsupportedAt: CompletionClaim.unsupportedAt },
      startedAt,
      finishedAt,
      counts: { cases: cases.length, executed: cases.length - tally.skipped - tally.error, ...tally },
      margin: {
        highestKept: extreme(Math.max, cases.filter((graded) => graded.outcome === "kept")),
        lowestRefused: extreme(Math.min, cases.filter((graded) => graded.outcome === "refused"))
      },
      passed: failures.length === 0,
      failures,
      cases
    }
  })

const flag = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

const git = (args: ReadonlyArray<string>): string => execFileSync("git", args, { encoding: "utf8" }).trim()

/** The sources a reading depends on: the brake, the transport, and the corpus. */
const sources = [
  fileURLToPath(new URL("../../src", import.meta.url)),
  fileURLToPath(new URL("../../../model/src", import.meta.url)),
  corpusPath
]

const commitOf = (env: Readonly<Record<string, string | undefined>>): string => {
  const given = env["GITHUB_SHA"]?.trim()
  return given !== undefined && given !== "" ? given : git(["rev-parse", "HEAD"])
}

/** The streams {@link main} writes to. */
export interface Io {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const processIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
}

/**
 * The program: reads the credential and the corpus, asks the live gateway
 * about every case, and returns the exit code.
 */
export const main = async (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  io: Io = processIo
): Promise<number> => {
  const key = env["AI_GATEWAY_API_KEY"]?.trim()
  if (key === undefined || key === "") {
    io.stderr(
      "AI_GATEWAY_API_KEY is not set. The completion-claim calibration asks the live gateway and never skips.\n"
    )
    return 2
  }
  const path = flag(argv, "--corpus") ?? corpusPath
  let text: string
  let corpus: Corpus
  try {
    text = readFileSync(path, "utf8")
    corpus = Schema.decodeUnknownSync(Corpus)(JSON.parse(text))
  } catch (error) {
    io.stderr(`The corpus at ${path} is not a valid calibration corpus: ${(error as Error).message}\n`)
    return 2
  }
  const baseUrl = env["SMITHERS_EVALUATOR_BASE_URL"]?.trim() || Evaluator.defaultBaseUrl
  const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make(key), baseUrl }).pipe(
    Layer.provide(FetchHttpClient.layer)
  )
  const report = await Effect.runPromise(
    calibrate(corpus, {
      commit: commitOf(env),
      dirty: git(["status", "--porcelain", "--", ...sources]) !== "",
      sha256: createHash("sha256").update(text).digest("hex"),
      model: Evaluator.defaultModel,
      baseUrl
    }).pipe(Effect.provide(layer))
  )
  const json = `${JSON.stringify(report, null, 2)}\n`
  const out = flag(argv, "--out")
  if (out === undefined) io.stdout(json)
  else writeFileSync(out, json)
  const { counts } = report
  io.stderr(
    `${
      report.passed ? "calibrated" : "FAILED"
    }: ${counts.executed}/${counts.cases} read, ${counts.false_refusal} false refusals, ${counts.missed} missed, ${counts.missed_by_design} missed by design, ${counts.skipped} skipped, ${counts.error} errors\n`
  )
  for (const failure of report.failures) io.stderr(`  ${failure}\n`)
  return report.passed ? 0 : 1
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env)
