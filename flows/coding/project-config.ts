/** Private operator input, loaded once before the configured host is constructed. */
import { TokenWeights } from "@smthrs/agent/Budget"
import * as Seat from "@smthrs/agent/Seat"
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { seatRefusal } from "../../packages/smithers/src/Providers.ts"
import type { CheckCommand } from "../register-repository/schema.ts"
import { checkCommands, FILE_BYTES, type SourceFile } from "../register-repository/tree.ts"
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
  /** Omitted, the built-in `coding/implementation`. */
  implementation: Schema.optionalKey(text),
  /** Omitted, the checks detected from the repository's files (`detectChecks`). */
  checks: Schema.optionalKey(Schema.Array(Schema.Struct(checkFields))),
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
/**
 * A detected command the host provisions as a built-in check flow
 * (`provisionBuiltins`): the body `coding/CommandCheck` runs.
 */
export interface DetectedCheck {
  readonly flow: string
  readonly argv: ReadonlyArray<string>
  readonly timeoutMs: number
}
export type ProjectConfig = Omit<MemoryOptions, "repositoryPath"> & {
  readonly limits?: typeof ProjectLimits.Type
  readonly reviewer?: string
  readonly seats?: Readonly<Record<string, string>>
  readonly landing?: LocalLander
  /** The check flows `checks` names that the host must provision; present only for detected checks. */
  readonly detected?: ReadonlyArray<DetectedCheck>
}

/** The implementation flow every configured host ships as a built-in. */
export const builtinImplementation = "coding/implementation"
/**
 * The files the detector (`checkCommands`) reads, by repository-relative path.
 * Detection opens no other file and runs nothing.
 */
const detectionFiles = [
  "package.json",
  "Makefile",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "pytest.ini",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock"
] as const
/** The detector reads these files' text; for the others it needs only that they exist. */
const detectionTexts: ReadonlySet<string> = new Set(["package.json", "Makefile"])
/** Lint, typecheck and build gate each atom; tests run as the slow check. */
const detectedTiers: Readonly<Record<CheckCommand["kind"], "fast" | "slow">> = {
  lint: "fast",
  typecheck: "fast",
  format: "fast",
  build: "fast",
  test: "slow"
}
/** A bound for a runaway command, not an expectation: 30 minutes. */
const detectedTimeoutMs = 30 * 60 * 1000

/**
 * The checks a repository that declares none runs (spec §11.2): one required
 * check per command the existing detector finds, in its order, each a
 * built-in `checks/<kind>` flow. A file that is missing, not a regular file,
 * over the detector's read limit or unreadable is no evidence.
 */
export const detectChecks = (repositoryPath: string): Effect.Effect<
  { readonly checks: MemoryOptions["checks"]; readonly detected: ReadonlyArray<DetectedCheck> },
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    const paths: Array<string> = [], files: Array<SourceFile> = []
    for (const name of detectionFiles) {
      const file = path.join(repositoryPath, name)
      if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) continue
      const info = yield* fs.stat(file).pipe(Effect.option)
      if (Option.isNone(info) || info.value.type !== "File") continue
      paths.push(name)
      if (!detectionTexts.has(name) || Number(info.value.size) > FILE_BYTES) continue
      const content = yield* fs.readFileString(file).pipe(Effect.option)
      if (Option.isSome(content)) files.push({ path: name, text: content.value })
    }
    const commands = checkCommands({ paths, files })
    return {
      checks: commands.map((command) => ({
        id: command.kind,
        target: ".",
        flow: `checks/${command.kind}`,
        tier: detectedTiers[command.kind],
        required: true
      })),
      detected: commands.map((command) => ({
        flow: `checks/${command.kind}`,
        argv: command.argv,
        timeoutMs: detectedTimeoutMs
      }))
    }
  })
/**
 * Why a role cannot take `seat`, or `undefined` when it can: a seat alias, a
 * `provider:model`, or `auto`, which routes the role by the routing graph.
 */
export const roleSeatRefusal = (seat: string): string | undefined => seat === Seat.auto ? undefined : seatRefusal(seat)

const invalid = (message: string, filename?: string) =>
  new Error(`Invalid SMITHERS_CODING_PROJECT${filename === undefined ? "" : ` at ${filename}`}: ${message}`)
const maximumBytes = 256 * 1024

/**
 * The repository default is optional; an explicit filename always takes
 * precedence. Without either, and for each of `implementation` and `checks`
 * a file omits, the built-in implementation and the detected checks apply,
 * so a repository with no Smithers declarations still serves coding requests
 * (mvp.md J1.4).
 */
export const loadProject = (repositoryPath: string, filename: string | undefined): Effect.Effect<
  ProjectConfig,
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
    const detect = () =>
      detectChecks(repositoryPath).pipe(
        Effect.map(({ checks, detected }) => ({ checks, ...(detected.length === 0 ? {} : { detected }) }))
      )
    if (filename === undefined && !(yield* fs.exists(selected))) {
      return { wiki: false, implementation: builtinImplementation, ...(yield* detect()) }
    }
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
    if (
      project.checks !== undefined && new Set(project.checks.map((check) => check.id)).size !== project.checks.length
    ) {
      return yield* Effect.fail(fail("check IDs must be unique"))
    }
    if (
      (project.wikiOutput !== undefined && (!project.wikiOutput.trim() || project.wikiOutput.includes("\0"))) ||
      (project.reviewer !== undefined && !project.reviewer.trim()) ||
      (project.implementation !== undefined && !project.implementation.trim())
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
    // The repository's field wins; only an omitted one takes its default.
    const checks = project.checks === undefined ? yield* detect() : { checks: project.checks }
    return {
      ...project,
      implementation: project.implementation ?? builtinImplementation,
      ...checks,
      wiki: project.wiki ?? false,
      ...(wikiOutput === undefined ? {} : { wikiOutput })
    }
  })
