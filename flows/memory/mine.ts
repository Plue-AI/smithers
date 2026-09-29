/**
 * `memory/mine`: what a finished run leaves behind for the next one, read
 * from its journal after the run ends.
 *
 * A thin wrapper over `@smthrs/agent/MemoryMine`, which `Agent.run` also runs
 * at run end: the journal's candidates and decisions come from
 * `MemoryMine.extract`, the one `memory/mine` reading from `MemoryMine.judge`,
 * and each accepted fact is written by `MemoryMine.write`. This file adds
 * what only a journal reader does: it parses JSONL, skips candidates already
 * stored before asking Jev, appends decisions to
 * `factory/wiki/decisions/<item>.md` (`MemoryMine.decisionsDirectory`, which
 * `memory`'s wiki source reads back as pages) as one section per run with
 * each line citing the run id and journal sequence (a page's existing bytes
 * are never rewritten), and returns issues, never filing them.
 *
 * {@link mine} is the plain function a host calls after a launch ends; `root`
 * and `bank` are the host's, never a model's.
 *
 * An unreachable or timed-out Jev writes nothing and answers `unjudged`. Every
 * other Jev failure is a typed `MineFailed`.
 */
import * as MemoryMine from "@smthrs/agent/MemoryMine"
import { Fault } from "@smthrs/flow"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, FileSystem, Path, Schema } from "effect"
import * as Bank from "../../packages/smithers/agent/memory/src/Bank.ts"
import * as MemoryStore from "../../packages/smithers/agent/memory/src/MemoryStore.ts"

/** One journal row: its sequence, its event type and its payload. */
export const Row = MemoryMine.Row
export type Row = MemoryMine.Row

/** What a caller names: the run, its item and its journal. */
export const Payload = {
  runId: Schema.String.check(Schema.isPattern(/^[^\s<>`]+$/)),
  item: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  /** JSONL text, one row per line, or the rows themselves. */
  journal: Schema.Union([Schema.String, Schema.Array(Row)])
}

/** What the host binds: the workspace the decisions page is written under, and the memory bank. */
export const Host = { root: Schema.String, bank: Schema.String }
export type Host = Schema.Struct<typeof Host>["Type"]

export const Input = Schema.Struct({ ...Payload, ...Host })
export type Input = typeof Input.Type

const Cited = MemoryMine.Cited

export const Output = Schema.Union([
  Schema.TaggedStruct("mined", {
    /** Note ids written by this run. */
    remembered: Schema.Array(Schema.String),
    /** Candidates skipped because the same fact was already stored. */
    known: Schema.Int,
    /** Candidates Jev did not accept as facts. */
    rejected: Schema.Int,
    /** The decisions page, relative to `root`, or null when nothing was appended. */
    page: Schema.NullOr(Schema.String),
    issues: Schema.Array(Cited)
  }),
  Schema.TaggedStruct("unjudged", { reason: Schema.String, detail: Schema.String })
])
export type Output = typeof Output.Type

export class MineFailed extends Schema.TaggedError<MineFailed>()("flows/memory/MineFailed", {
  code: Schema.Literals(["invalid_input", "invalid_journal", "judge_failed", "memory_failed", "wiki_failed"]),
  message: Schema.String
}) {}
Fault.register(
  "flows/memory/MineFailed",
  {
    // The host builds the payload; a bad one is ours.
    invalid_input: "bug",
    invalid_journal: "infra",
    judge_failed: "dependency",
    memory_failed: "infra",
    wiki_failed: "infra"
  } satisfies Fault.Rows<MineFailed["code"]>
)

const fail = (code: MineFailed["code"], message: string) => Effect.fail(new MineFailed({ code, message }))

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : {}

/** Parses JSONL or rows into rows; a line without `seq` takes its 1-based line number. */
export const rows = (journal: Input["journal"]): Effect.Effect<ReadonlyArray<Row>, MineFailed> =>
  Effect.gen(function*() {
    if (typeof journal !== "string") return journal
    const out: Array<Row> = []
    for (const [index, line] of journal.split("\n").entries()) {
      if (line.trim() === "") continue
      let parsed: Readonly<Record<string, unknown>>
      let payload: unknown
      try {
        parsed = record(JSON.parse(line))
        payload = typeof parsed.payload_json === "string" ? JSON.parse(parsed.payload_json) : parsed.payload
      } catch {
        return yield* fail("invalid_journal", `journal line ${index + 1} is not JSON`)
      }
      const eventType = parsed.eventType ?? parsed.event_type
      if (typeof eventType !== "string") {
        return yield* fail("invalid_journal", `journal line ${index + 1} has no event type`)
      }
      out.push({ seq: typeof parsed.seq === "number" ? parsed.seq : index + 1, eventType, payload })
    }
    return out
  })

/**
 * One decision as one Markdown line: whitespace folded, so it never starts a
 * line of its own, and `<!--` escaped, so it never opens a comment or forges
 * a {@link marker}. `MemoryMine` has already clipped it.
 */
const line = (text: string): string => text.replace(/\s+/g, " ").trim().replaceAll("<!--", "&lt;!--")

/** The marker that keys one run's section on a decisions page. */
export const marker = (runId: string): string => `<!-- memory/mine run=${runId} -->`

/**
 * Appends this run's section to `factory/wiki/decisions/<item>.md`. A page
 * with a line that is the run's marker is left as it is; otherwise its bytes
 * are kept and the section follows them.
 */
const appendPage = (input: Input, decisions: ReadonlyArray<MemoryMine.Cited>) =>
  Effect.gen(function*() {
    if (decisions.length === 0) return null
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const relative = `${MemoryMine.decisionsDirectory}/${input.item}.md`
    const file = path.join(input.root, relative)
    const existing = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : `# Decisions: ${input.item}\n`
    if (existing.split("\n").includes(marker(input.runId))) return null
    const section = [
      "",
      marker(input.runId),
      `## Run ${input.runId}`,
      "",
      ...decisions.map((entry) =>
        `- Decision: ${line(entry.text)} (journal: run \`${input.runId}\`, event ${entry.seq})`
      ),
      ""
    ].join("\n")
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, `${existing.endsWith("\n") ? existing : `${existing}\n`}${section}`)
    return relative
  }).pipe(Effect.mapError((error) => new MineFailed({ code: "wiki_failed", message: error.message })))

/**
 * Mines one finished run: its journal rows or JSONL transcript in; accepted
 * facts written to `bank`, decisions appended to the item's page under
 * `root`, and issues returned. Input is decoded first, so a caller that is
 * not the flow meets the same `runId` and `item` rules.
 */
export const mine = (
  raw: Input
): Effect.Effect<
  Output,
  MineFailed,
  MemoryStore.MemoryStore | Evaluator.Evaluator | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const invalid = (error: { readonly message: string }) =>
      new MineFailed({ code: "invalid_input", message: error.message })
    const input = yield* Schema.decodeUnknownEffect(Input)(raw).pipe(Effect.mapError(invalid))
    yield* Bank.parse(input.bank).pipe(Effect.mapError(invalid))
    const store = yield* MemoryStore.MemoryStore
    const memoryFailed = (error: { readonly message: string }) =>
      new MineFailed({ code: "memory_failed", message: error.message })
    const { candidates, decisions } = MemoryMine.extract(yield* rows(input.journal))
    const fresh: Array<MemoryMine.Cited> = []
    for (const candidate of candidates) {
      const held = yield* store.getNote({ id: MemoryMine.noteId(input.bank, candidate.text) }).pipe(
        Effect.mapError(memoryFailed)
      )
      if (held === undefined) fresh.push(candidate)
    }
    const judged = yield* MemoryMine.judge(input.item, fresh).pipe(
      Effect.map((value) => ({ _tag: "judged" as const, ...value })),
      Effect.catch((unjudged) =>
        unjudged.reason === "unreachable" || unjudged.reason === "timeout"
          ? Effect.succeed({ _tag: "unjudged" as const, ...unjudged })
          : fail("judge_failed", `${unjudged.reason}: ${unjudged.detail}`)
      )
    )
    if (judged._tag === "unjudged") {
      return { _tag: "unjudged", reason: judged.reason, detail: judged.detail } satisfies Output
    }
    const remembered: Array<string> = []
    for (const fact of judged.facts) {
      const note = yield* MemoryMine.write(store, { bank: input.bank, runId: input.runId, text: fact.text }).pipe(
        Effect.mapError(memoryFailed)
      )
      remembered.push(note.id)
    }
    const page = yield* appendPage(input, decisions)
    return {
      _tag: "mined",
      remembered,
      known: candidates.length - fresh.length,
      rejected: fresh.length - remembered.length,
      page,
      issues: judged.issues
    } satisfies Output
  })
