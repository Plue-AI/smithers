/** Private operator input, loaded once before the configured host is constructed. */
import { TokenWeights } from "@smthrs/agent/Budget"
import * as Seat from "@smthrs/agent/Seat"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { seatRefusal } from "../../packages/smithers/src/Providers.ts"
import { PageSpec } from "../wiki/schema.ts"
import { LocalLander } from "./landing-schema.ts"
import type { MemoryOptions } from "./planning-memory.ts"
import { Check } from "./schema.ts"
import { separateWikiOutput } from "./wiki-output.ts"

const { flowDigest: _flowDigest, ...checkFields } = Check.fields
const text = Schema.NonEmptyString
const positiveMs = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(6 * 60 * 60 * 1000))
export const ProjectLimits = Schema.Struct({
  modelCallMs: positiveMs,
  toolMs: positiveMs,
  taskMs: positiveMs,
  weights: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, TokenWeights))
})
const Project = Schema.Struct({
  limits: Schema.optionalKey(ProjectLimits),
  wiki: Schema.optionalKey(Schema.Boolean),
  wikiOutput: Schema.optionalKey(text),
  pages: Schema.optionalKey(Schema.Array(PageSpec).check(Schema.isMinLength(1), Schema.isMaxLength(30))),
  implementation: text,
  checks: Schema.Array(Schema.Struct(checkFields)),
  historyLimit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))),
  maxMemoryBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024), Schema.isLessThanOrEqualTo(90 * 1024))
  ),
  reviewer: Schema.optionalKey(text),
  /** Role id to seat alias, `provider:model` or `auto`, e.g. `"coding/implement": "auto"`. */
  seats: Schema.optionalKey(Schema.Record(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9/_-]{0,63}$/)), text)),
  /** How a host without a provisioned repository binding lands `coding/vibe`; a binding lands through the backend. */
  landing: Schema.optionalKey(LocalLander)
})
export type ProjectConfig = Omit<MemoryOptions, "repositoryPath"> & {
  readonly limits?: typeof ProjectLimits.Type
  readonly reviewer?: string
  readonly seats?: Readonly<Record<string, string>>
  readonly landing?: LocalLander
}
/**
 * Why a role cannot take `seat`, or `undefined` when it can: a seat alias, a
 * `provider:model`, or `auto`, which routes the role by the routing graph.
 */
export const roleSeatRefusal = (seat: string): string | undefined => seat === Seat.auto ? undefined : seatRefusal(seat)

const invalid = (message: string, filename?: string) =>
  new Error(`Invalid SMITHERS_CODING_PROJECT${filename === undefined ? "" : ` at ${filename}`}: ${message}`)
const maximumBytes = 256 * 1024

/** The repository default is optional; an explicit filename always takes precedence. */
export const loadProject = (repositoryPath: string, filename: string | undefined): Effect.Effect<
  ProjectConfig | undefined,
  Error,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    if (filename !== undefined && (!filename.trim() || filename.includes("\0"))) {
      return yield* Effect.fail(invalid("the explicit filename must be nonempty"))
    }
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    const selected = path.resolve(repositoryPath, filename ?? ".smithers/coding-project.json")
    const fail = (message: string) => invalid(message, selected)
    if (filename === undefined && !(yield* fs.exists(selected))) return undefined
    // bytesToRead bounds even a growing file; the extra byte distinguishes an
    // exact-bound document from a truncated one. Check emitted bytes as well.
    const data = yield* Stream.runFoldEffect(
      fs.stream(selected, {
        bytesToRead: maximumBytes + 1,
        chunkSize: 16 * 1024
      }),
      () => ({ chunks: [] as Array<Uint8Array>, bytes: 0 }),
      (state, chunk) => {
        if (state.bytes + chunk.length > maximumBytes) return Effect.fail(fail("JSON exceeds 256 KiB"))
        state.chunks.push(chunk)
        state.bytes += chunk.length
        return Effect.succeed(state)
      }
    ).pipe(Effect.mapError((error) =>
      error instanceof Error && error.message.startsWith("Invalid SMITHERS_CODING_PROJECT")
        ? error :
        fail("cannot read the file")
    ))
    const bytes = new Uint8Array(data.bytes)
    let offset = 0
    for (const chunk of data.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    const input = yield* Effect.try({
      try: () =>
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      catch: () => fail("expected UTF-8 JSON")
    })
    const project = yield* Schema.decodeUnknownEffect(Project, { onExcessProperty: "error" })(input).pipe(
      // Do not print operator configuration contents in startup diagnostics.
      Effect.mapError(() => fail("fields must match the project schema; unknown fields are refused"))
    )
    const pages = project.pages ?? []
    if (
      project.wiki === true && (!pages.length || project.wikiOutput === undefined || project.reviewer === undefined)
    ) {
      return yield* Effect.fail(fail("enabled Wiki requires pages, wikiOutput and reviewer"))
    }
    const pageIds = new Set(pages.map((page) => page.id))
    if (pageIds.size !== pages.length || pages.some((page) => !/^[a-z][a-z0-9-]{0,80}$/.test(page.id))) {
      return yield* Effect.fail(fail("wiki page IDs must be valid and unique"))
    }
    if (pages.some((page) => page.related.some((id) => !pageIds.has(id)))) {
      return yield* Effect.fail(fail("related wiki pages must exist in this configuration"))
    }
    if (new Set(project.checks.map((check) => check.id)).size !== project.checks.length) {
      return yield* Effect.fail(fail("check IDs must be unique"))
    }
    if (
      (project.wikiOutput !== undefined && (!project.wikiOutput.trim() || project.wikiOutput.includes("\0"))) ||
      (project.reviewer !== undefined && !project.reviewer.trim()) || !project.implementation.trim()
    ) {
      return yield* Effect.fail(fail("output, reviewer and implementation must be nonempty"))
    }
    for (const [role, seat] of Object.entries(project.seats ?? {})) {
      const refusal = roleSeatRefusal(seat)
      if (refusal !== undefined) return yield* Effect.fail(fail(`seat ${role}: ${refusal}`))
    }
    const wikiOutput = project.wikiOutput === undefined ?
      undefined :
      yield* separateWikiOutput(repositoryPath, project.wikiOutput).pipe(
        Effect.mapError(() => fail("wikiOutput must resolve outside the source workspace, including .flows"))
      )
    return { ...project, wiki: project.wiki ?? false, ...(wikiOutput === undefined ? {} : { wikiOutput }) }
  })
