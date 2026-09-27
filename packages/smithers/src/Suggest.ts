/**
 * `smthrs suggest`: read the project, stream the ways Smithers can help, and
 * implement the one the operator picks.
 *
 * The verb is the composition of four modules that already exist and are
 * tested on their own: `Providers` decides which seat this machine can run,
 * `suggest/Checklist` reads the repository and yields one suggestion per
 * match, `suggest/Brief` turns a match into the text the agent is handed, and
 * `suggest/SuggestFlow` runs that text through a kernel-guarded filesystem
 * pinned to the project root. Nothing here reads a file or spends a token
 * itself; this module is the order those four happen in and the shape of what
 * an operator sees.
 *
 * Three renderings, one scan. `--json` writes one document per suggestion as
 * it is found, then the seat and the outcome, and never asks a question.
 * `--list`, and any session whose streams are not terminals, prints the same
 * suggestions as lines and stops there. An interactive session prints them
 * while a spinner says the scan continues, then asks which one to implement,
 * implements it, and offers that suggestion's follow-ups and the large
 * suggestions the checklist held back.
 *
 * Every side effect an operator did not ask for is a side effect they have to
 * undo, so the implementation writes files under the project root and never
 * commits: `SuggestFlow.rules` denies `.git/` and `.flows/` in the grant
 * store, and there is no `proc:spawn` grant at all.
 *
 * @since 1.0.0-rc.0
 */

import { Effect, Exit, Option } from "effect"
import { statSync } from "node:fs"
import { homedir } from "node:os"
import * as CliError from "./CliError.ts"
import type * as Environment from "./Environment.ts"
import { readText } from "./internal/HostFiles.ts"
import * as Providers from "./Providers.ts"
import * as Brief from "./suggest/Brief.ts"
import * as Checklist from "./suggest/Checklist.ts"
import * as SuggestFlow from "./suggest/SuggestFlow.ts"
import * as Ui from "./Ui.ts"

/**
 * What one implementation wrote, and which question it answered.
 *
 * `kind` separates the three briefs the agent can be handed: the suggestion
 * the operator picked, one of that suggestion's follow-ups, and a suggestion
 * the checklist held back as too large to offer first.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Implementation {
  readonly kind: "suggestion" | "follow-up" | "held-back"
  /** The suggestion this implementation belongs to. */
  readonly suggestion: string
  /** The follow-up id, for `kind: "follow-up"`. */
  readonly followUp?: string | undefined
  readonly files: ReadonlyArray<string>
  readonly command: string
  readonly notes: string
}

/**
 * What one `smthrs suggest` did.
 *
 * `listed` covers every rendering that only prints: `--json`, `--list`, and a
 * session that cannot ask. `nothing` is a scan that found nothing small
 * enough to offer first, which is not a failure.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Outcome {
  readonly status: "listed" | "implemented" | "cancelled" | "nothing"
  readonly root: string
  readonly seat: string
  /** The suggestion ids, in the order the scan streamed them. */
  readonly suggestions: ReadonlyArray<string>
  readonly implemented: ReadonlyArray<Implementation>
}

/**
 * The process status one outcome ends on.
 *
 * A cancelled prompt is 130, the status the rest of the CLI already uses for
 * a cancelled thing. Everything else here is 0; a failure never reaches this
 * function, because it left as a typed `CliError`.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const exitStatus = (outcome: Outcome): number => outcome.status === "cancelled" ? 130 : 0

/**
 * One implementing step: a brief in, the files it wrote out.
 *
 * The seam a test replaces. Everything above it (the seat, the scan, the
 * prompts, the rendering) is the verb; everything below it is one model call
 * inside a sandbox, which `test/suggest/SuggestFlow.scripted.test.ts` proves
 * on its own.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Implement = (brief: string) => Effect.Effect<SuggestFlow.Implemented, Error>

/**
 * What one invocation was told.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  /** The absolute project root to read. */
  readonly root: string
  /** The `--seat provider:model` override. */
  readonly seat?: string | undefined
  readonly list: boolean
  readonly json: boolean
  readonly environment: Environment.Source
  /** Explicit judge for an embedded or offline implementation host. */
  readonly evaluator?: SuggestFlow.NodeConfig["evaluator"]
  readonly homeDirectory?: string | undefined
  /** How the seat scan reads a credential store. Defaults to the real one. */
  readonly readFile?: ((path: string) => string | undefined) | undefined
  /** What the checklist reads. Defaults to the Node reader over `root`. */
  readonly repository?: Checklist.Repository | undefined
  /** How a brief is implemented. Defaults to the bundled flow on this host. */
  readonly implement?: Implement | undefined
  /** Where a `--json` document is written. Defaults to stdout. */
  readonly emit?: ((line: string) => void) | undefined
}

const writeLine = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

/**
 * Whether a path is a directory this verb can read.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The `--json` document for one suggestion, in the order it was found.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const suggestionDocument = (suggestion: Checklist.Suggestion, position: number) => ({
  document: "suggestion" as const,
  position,
  id: suggestion.id,
  title: suggestion.title,
  why: suggestion.why,
  effort: suggestion.effort,
  followUp: suggestion.followUp,
  followUps: suggestion.followUps.map((entry) => entry.id),
  files: suggestion.files
})

/**
 * The `--json` document for the seat the scan and the implementation run on.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const seatDocument = (chosen: Providers.Chosen) => ({
  document: "seat" as const,
  seat: chosen.seat,
  source: chosen.source,
  label: chosen.label
})

/**
 * The `--json` document that closes the stream.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const outcomeDocument = (outcome: Outcome) => ({
  document: "outcome" as const,
  status: outcome.status,
  root: outcome.root,
  seat: outcome.seat,
  suggestions: outcome.suggestions,
  implemented: outcome.implemented
})

/**
 * The intro line, which names the seat before anything is read.
 *
 * An operator who is about to spend a subscription or a key has to be told
 * which one, and told it before the scan rather than beside the first
 * question.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const introLine = (chosen: Providers.Chosen): string =>
  `smthrs suggest on ${chosen.seat} (${chosen.source === "override" ? "--seat" : chosen.label})`

/**
 * The one line a streamed suggestion prints.
 *
 * Complete on its own: the position, the title, how big the change is,
 * whether it was held back, and the files that triggered it. It is the whole
 * of what `--list` prints, so nothing an operator needs may sit anywhere else.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const streamLabel = (suggestion: Checklist.Suggestion, position: number): string =>
  `${position}. ${suggestion.title} (${suggestion.effort}${
    suggestion.followUp ? ", follow-up" : ""
  }): ${suggestion.why}`

/**
 * The note printed after an implementation: every file, then the command that
 * runs them, then what the agent wanted the reader to know.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const wroteNote = (implemented: SuggestFlow.Implemented): string =>
  [
    ...(implemented.files.length === 0 ? ["No files were written."] : implemented.files.map((file) => `- ${file}`)),
    "",
    `Run it with: ${implemented.command}`,
    ...(implemented.notes.trim() === "" ? [] : ["", implemented.notes.trim()])
  ].join("\n")

const failed = (message: string): CliError.UnsupportedError => new CliError.UnsupportedError({ message })

const nodeImplement = (options: Options, seat: string): Implement => (brief) =>
  Effect.try({
    try: () =>
      SuggestFlow.layerNode({
        root: options.root,
        seat,
        environment: options.environment,
        evaluator: options.evaluator
      }),
    catch: (error) => new Error(SuggestFlow.failureMessage(error))
  }).pipe(
    Effect.flatMap((host) =>
      SuggestFlow.run(brief).pipe(
        Effect.provide(host),
        Effect.mapError((error) => new Error(SuggestFlow.failureMessage(error)))
      )
    )
  )

/** Collects the scan without a renderer, for the `--json` and listing paths. */
const collect = (
  repository: Checklist.Repository,
  onFound: (suggestion: Checklist.Suggestion, position: number) => void
): Effect.Effect<ReadonlyArray<Checklist.Suggestion>, CliError.UnsupportedError> =>
  Effect.tryPromise({
    try: async () => {
      const found: Array<Checklist.Suggestion> = []
      for await (const suggestion of Checklist.scan(repository)) {
        found.push(suggestion)
        onFound(suggestion, found.length)
      }
      return found
    },
    catch: (cause) => failed(`the scan of ${repository.root} failed: ${String(cause)}`)
  })

const settledLine = (count: number): string => count === 1 ? "1 suggestion" : `${count} suggestions`

/**
 * Runs the implementing step behind a spinner and prints what it wrote.
 */
const carryOut = (
  ui: Ui.Service,
  implement: Implement,
  title: string,
  brief: string
): Effect.Effect<SuggestFlow.Implemented, CliError.UnsupportedError> =>
  Effect.gen(function*() {
    const implemented = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const spinner = ui.spinner()
        spinner.start(title)
        return spinner
      }),
      () => Effect.suspend(() => implement(brief)),
      (spinner, exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) {
            spinner.stop(`${title}: ${settledFiles(exit.value.files.length)}`)
          } else if (Exit.hasInterrupts(exit)) {
            spinner.cancel(`${title}: cancelled`)
          } else {
            spinner.error(`${title}: failed`)
          }
        })
    ).pipe(Effect.mapError((error) => failed(`${title}: ${error.message}`)))
    yield* ui.note(wroteNote(implemented), title)
    return implemented
  })

const settledFiles = (count: number): string => count === 1 ? "1 file written" : `${count} files written`

const jsonRendering = (
  options: Options,
  chosen: Providers.Chosen,
  repository: Checklist.Repository
): Effect.Effect<Outcome, CliError.UnsupportedError> =>
  Effect.gen(function*() {
    const emit = options.emit ?? writeLine
    const found = yield* collect(
      repository,
      (suggestion, position) => emit(JSON.stringify(suggestionDocument(suggestion, position)))
    )
    emit(JSON.stringify(seatDocument(chosen)))
    const outcome: Outcome = {
      status: "listed",
      root: options.root,
      seat: chosen.seat,
      suggestions: found.map((suggestion) => suggestion.id),
      implemented: []
    }
    emit(JSON.stringify(outcomeDocument(outcome)))
    return outcome
  })

const humanRendering = (
  options: Options,
  chosen: Providers.Chosen,
  repository: Checklist.Repository
): Effect.Effect<Outcome, CliError.UnsupportedError> =>
  Effect.gen(function*() {
    const ui = yield* Ui.current
    yield* ui.intro(introLine(chosen))
    const streamed = yield* ui.streamSuggestions(Checklist.scan(repository), {
      label: streamLabel,
      scanning: `Reading ${options.root}`,
      settled: settledLine
    }).pipe(Effect.mapError((error) => failed(`the scan of ${options.root} failed: ${error.message}`)))
    const found = streamed.items
    const outcome = (status: Outcome["status"], implemented: ReadonlyArray<Implementation>): Outcome => ({
      status,
      root: options.root,
      seat: chosen.seat,
      suggestions: found.map((suggestion) => suggestion.id),
      implemented
    })
    // `--list` was asked for, and a session that is not a terminal is asked
    // the same thing by its shape: a question nobody can answer is a hang, so
    // a pipe reads the list and stops.
    if (options.list || !ui.interactive) {
      yield* ui.outro(
        found.length === 0
          ? "Nothing to suggest for this project yet"
          : "Nothing implemented; run `smthrs suggest` in a terminal, without --list, to pick one"
      )
      return outcome("listed", [])
    }
    const candidates = found.filter((suggestion) => !suggestion.followUp)
    if (candidates.length === 0) {
      yield* ui.outro("Nothing small enough to implement first")
      return outcome("nothing", [])
    }
    const picked = yield* ui.pickSuggestion(candidates, {
      message: "Which one should I implement?",
      label: (suggestion) => suggestion.title,
      hint: (suggestion) => suggestion.effort
    })
    if (Option.isNone(picked)) {
      yield* ui.outro("Cancelled, nothing was written")
      return outcome("cancelled", [])
    }
    const chosenSuggestion = picked.value
    const context: Brief.Context = { seat: chosen.seat, facts: Checklist.evidence(repository) }
    const implement = options.implement ??
      nodeImplement({ ...options, environment: { ...options.environment, ...chosen.environment } }, chosen.seat)
    const implemented: Array<Implementation> = []
    const first = yield* carryOut(ui, implement, chosenSuggestion.title, Brief.suggestion(context, chosenSuggestion))
    implemented.push({ kind: "suggestion", suggestion: chosenSuggestion.id, ...first })
    // The follow-ups of the suggestion that just landed, then the suggestions
    // the checklist held back. Both are offered only now, which is the whole
    // point of holding them back: a large change is a reasonable question
    // once a small one has proved the seat and the layout.
    for (const followUp of chosenSuggestion.followUps) {
      const accepted = yield* ui.confirm({ message: followUp.question, initialValue: false, nonInteractive: false })
      if (!accepted) continue
      const done = yield* carryOut(
        ui,
        implement,
        followUp.question,
        Brief.followUp(context, chosenSuggestion, first, followUp)
      )
      implemented.push({ kind: "follow-up", suggestion: chosenSuggestion.id, followUp: followUp.id, ...done })
    }
    for (const held of found.filter((suggestion) => suggestion.followUp)) {
      const accepted = yield* ui.confirm({
        message: `Also implement: ${held.title}?`,
        initialValue: false,
        nonInteractive: false
      })
      if (!accepted) continue
      const done = yield* carryOut(ui, implement, held.title, Brief.suggestion(context, held))
      implemented.push({ kind: "held-back", suggestion: held.id, ...done })
    }
    yield* ui.outro(
      `${implemented.length === 1 ? "1 change" : `${implemented.length} changes`} written, nothing committed`
    )
    return outcome("implemented", implemented)
  })

/**
 * Runs one `smthrs suggest`.
 *
 * The seat is decided before anything is read, so a machine with no seat is
 * told so before a scan it cannot act on. A malformed `--seat` is a usage
 * error (2); no seat at all, a failed scan, and a failed implementation are
 * failures (1); a cancelled prompt is reported in the outcome and becomes 130
 * through {@link exitStatus}.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const run = (options: Options): Effect.Effect<Outcome, CliError.CliError> =>
  Effect.gen(function*() {
    const detections = Providers.detect({
      environment: options.environment,
      homeDirectory: options.homeDirectory ?? homedir(),
      readFile: options.readFile ?? readText
    })
    const chosen = Providers.chooseSeat(detections, options.seat)
    if (chosen instanceof Providers.SeatSyntaxError) {
      return yield* Effect.fail(new CliError.UsageError({ message: chosen.message }))
    }
    if (chosen instanceof Providers.NoSeatError) return yield* Effect.fail(failed(chosen.message))
    const repository = options.repository ?? Checklist.repository(options.root)
    return yield* options.json
      ? jsonRendering(options, chosen, repository)
      : humanRendering(options, chosen, repository)
  })
