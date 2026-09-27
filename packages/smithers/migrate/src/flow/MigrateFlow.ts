/**
 * The migration itself, as one flow over two.
 *
 * The top flow scans, gates, and writes the report. Each unit is a child
 * execution of its own, so the lineage a person reads afterwards has one child
 * per workflow file rather than one long chain nobody can bisect.
 *
 * ## Why the units are in the payload
 *
 * A flow body is plan time: `Node.bindPlanned`'s builder runs once, against a
 * placeholder, before anything executes. A graph therefore cannot fan out over
 * a list the scan step returns at run time — the same constraint
 * `@smthrs/patterns`' `MapReduce` states as "the flow input must be a literal
 * `{ shards }` available while planning". So the unit list is topology and
 * travels in the payload, while the scan still runs inside the flow, is still
 * journaled, and is still what the gate and the report read. A payload whose
 * units disagree with what the in-flow scan found fails the gate rather than
 * migrating a plan the project has outgrown.
 *
 * The unit payload carries the outline, not the captured source: the text a
 * unit is shown has to be the text on disk when that unit starts, and an
 * earlier unit may have rewritten it.
 *
 * @since 1.0.0-rc.0
 */

import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import * as Checks from "../Checks.ts"
import * as Detect from "../Detect.ts"
import * as Fs from "../internal/Fs.ts"
import * as Ts from "../internal/Ts.ts"
import { io, make, MigrateError } from "../MigrateError.ts"
import * as Report from "../Report.ts"
import * as RunState from "../RunState.ts"
import * as Scan from "../Scan.ts"
import type * as Units from "../Units.ts"
import * as Archive from "./Archive.ts"
import * as Checkpoint from "./Checkpoint.ts"
import * as Gate from "./Gate.ts"
import * as Canonical from "./internal/Canonical.ts"
import * as Options from "./Options.ts"
import * as Repair from "./Repair.ts"
import * as Transform from "./Transform.ts"
import * as Verify from "./Verify.ts"

/**
 * Everything one unit's graph needs implemented.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type UnitRequires =
  | Action.Requirement<"smithers/migrate-v1/Checkpoint">
  | Action.Requirement<"smithers/migrate-v1/Capture">
  | Action.Requirement<"smithers/migrate-v1/Transform">
  | Action.Requirement<"smithers/migrate-v1/Repair">
  | Action.Requirement<"smithers/migrate-v1/Verify">
  | Action.Requirement<"smithers/migrate-v1/Finish">

/**
 * Everything the top-level graph needs implemented. A child execution provides
 * its own context, so the unit's requirements are not the caller's.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Requires =
  | Action.Requirement<"smithers/migrate-v1/Scan">
  | Action.Requirement<"smithers/migrate-v1/Gate">
  | Action.Requirement<"smithers/migrate-v1/Seal">
  | Action.Requirement<"smithers/migrate-v1/Settle">
  | Action.Requirement<"smithers/migrate-v1/WriteReport">

/**
 * The flow tag the control plane registers this migration under.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const tag = "smithers/migrate-v1"

/**
 * The child flow tag, one execution per unit.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const unitTag = "smithers/migrate-v1/unit"

const scanOptions = (options: Options.MigrateOptions): Scan.Options => ({
  // The tool's own directory is never project source: it holds the archive
  // of what a previous run replaced, and a second run must not plan to
  // migrate the archive.
  ignore: [Options.reportDir(options)],
  // The host's state paths reach the scanners here, so the global state
  // directory and the gateway's temporary files are found by the run's own
  // scan and not only by a scanner test that passed them by hand.
  environment: Options.scanEnvironment(options.state),
  ...(options.state?.tmpdir === undefined ? {} : { runState: { tmpdir: options.state.tmpdir } }),
  flowsDir: Options.flowsDir(options),
  ...(options.units === undefined ? {} : { units: options.units }),
  ...(options.commands === undefined ? {} : {
    commands: {
      ...(options.commands.install === undefined ? {} : { install: options.commands.install }),
      ...(options.commands.format === undefined ? {} : { format: options.commands.format }),
      ...(options.commands.typecheck === undefined ? {} : { typecheck: options.commands.typecheck }),
      ...(options.commands.test === undefined ? {} : { test: options.commands.test })
    }
  })
})

/**
 * Why the report directory or the flows directory collides with what the
 * scan found, or `undefined` when neither does.
 *
 * The text checks in {@link module:Options.layoutIssue} and the filesystem
 * checks in {@link module:Options.validateLayout} run before anything is read.
 * This one needs the scan: a flows directory or a report directory under a
 * 0.x run-state root, or holding one, would write where the tool has promised
 * never to write.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const layoutConflict = (
  result: Scan.ScanResult,
  options: Options.MigrateOptions
): string | undefined => {
  const report = Options.reportDir(options)
  const flows = Options.flowsDir(options)
  const under = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}/`)
  const guarded = [...new Set([...RunState.roots(result.runState), ...Transform.runStatePaths(result)])].sort()
  for (const [label, directory] of [["reportDir", report], ["layout.flowsDir", flows]] as const) {
    for (const root of guarded) {
      if (under(directory, root) || under(root, directory)) {
        return `${label} "${directory}" overlaps the 0.x run-state path "${root}"`
      }
    }
  }
  return undefined
}

/**
 * Scans the project and renders the plan report.
 *
 * The layout is validated first, before a byte is read, and again against
 * what the scan found, before a byte is written: the report directory and the
 * flows directory have to name places inside the project that hold nothing
 * the migration reads or protects.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const scan = (
  options: Options.MigrateOptions
): Effect.Effect<Scan.ScanResult, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    yield* Options.validateLayout(options)
    const result = yield* Scan.scan(options.root, scanOptions(options))
    const conflict = layoutConflict(result, options)
    if (conflict !== undefined) return yield* Effect.fail(make("invalid-layout", conflict))
    return result
  })

/**
 * The scan step. Deterministic and read only, so a replay reuses what the
 * first attempt saw instead of walking the project again.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const scanAction = Action.make("smithers/migrate-v1/Scan", {
  payload: {
    options: Options.MigrateOptions,
    generatedAt: Schema.String
  },
  success: Report.MigrationReport,
  error: MigrateError
})

/**
 * The scan step's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const scanLayer = scanAction.toLayer(({ generatedAt, options }) =>
  Effect.map(scan(options), (result) =>
    Scan.toReport(result, options.mode, generatedAt, {
      ...(options.acknowledgeRunState === undefined ? {} : { acknowledgeRunState: options.acknowledgeRunState })
    }))
)

/**
 * The gate step: the two operator decisions, evaluated against what this run's
 * own scan found.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const gateAction = Action.make("smithers/migrate-v1/Gate", {
  payload: {
    report: Report.MigrationReport,
    options: Options.MigrateOptions,
    unitIds: Schema.Array(Schema.String)
  },
  success: Options.MigrateOptions,
  error: MigrateError
})

/**
 * The gate step's implementation. It also refuses a payload whose unit list no
 * longer matches the project, because that plan was made against a tree that
 * has since changed.
 *
 * It answers with the options it approved rather than with nothing, and every
 * step downstream takes them from here. That is what makes the gate a gate: a
 * plan is a dataflow graph, so a node nothing depends on is a node the run is
 * free to skip, and a checkpoint that ran before the refusal would have
 * touched a project the operator had not agreed to touch.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const gateLayer = gateAction.toLayer(({ options, report, unitIds }) =>
  Effect.gen(function*() {
    yield* Gate.evaluateReport(report, {
      mode: options.mode,
      ...(options.acknowledgeRunState === undefined ? {} : { acknowledgeRunState: options.acknowledgeRunState }),
      ...(options.allowUnsafe === undefined ? {} : { allowUnsafe: options.allowUnsafe })
    })
    if (options.mode !== "apply") return options
    const found = report.units.map((unit) => unit.id).join(", ")
    const asked = [...unitIds].join(", ")
    if (found !== asked) {
      return yield* Effect.fail(make(
        "unsupported-project",
        "The project has changed since this migration was planned, so the plan no longer describes it. Rerun the plan and apply that.",
        `planned: ${asked}\nfound: ${found}`
      ))
    }
    return options
  })
)

/**
 * The checkpoint-time state of one path a plan covers.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const SealedFile = Schema.Struct({
  path: Schema.String,
  state: Schema.Literals(["absent", "file"]),
  digest: Schema.optional(Schema.String)
})

/**
 * A plan, sealed: a digest over everything the plan says about the project,
 * and the per-path record the digest was taken from.
 *
 * A unit id is a name, and a name survives every edit to what it names. The
 * seal covers the rest: every outline field, the run-state roots, the layout,
 * and a digest of every source and target path. `files` travels beside the
 * digest so a refusal can name what changed rather than say that something
 * did.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const PlanSeal = Schema.Struct({
  digest: Schema.String,
  files: Schema.Array(SealedFile)
})

/**
 * A plan, sealed.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type PlanSeal = typeof PlanSeal.Type

const sha256 = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex")

/**
 * Seals a plan: reads every source and target the outlines name and digests
 * them together with the outlines, the run-state roots, and the layout.
 *
 * Read only, and deterministic for a given tree: two seals of the same
 * project agree byte for byte, and one changed byte in one source changes the
 * digest.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const planSeal = (
  result: Scan.ScanResult,
  options: Options.MigrateOptions
): Effect.Effect<PlanSeal, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const units = outlines(result, options)
    const paths = [...new Set(units.flatMap((unit) => [...unit.sources, ...unit.targets]))].sort()
    const files: Array<typeof SealedFile.Type> = []
    for (const relative of paths) {
      const bytes = yield* Fs.optionalNotFound(fs.readFile(path.join(result.root, ...relative.split("/")))).pipe(
        Effect.mapError(io(`could not read "${relative}" to seal the plan`))
      )
      files.push(
        bytes._tag === "None"
          ? { path: relative, state: "absent" }
          : { path: relative, state: "file", digest: sha256(bytes.value) }
      )
    }
    const digest = sha256(Canonical.stringify({
      version: 1,
      layout: { reportDir: Options.reportDir(options), flowsDir: Options.flowsDir(options) },
      runStateRoots: runStateRoots(result),
      outlines: units,
      files
    }))
    return { digest, files }
  })

/**
 * Every path whose sealed state differs between two seals, and every unit
 * that exists in one and not the other.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const sealDifferences = (planned: PlanSeal, current: PlanSeal): ReadonlyArray<string> => {
  const before = new Map(planned.files.map((file) => [file.path, file] as const))
  const after = new Map(current.files.map((file) => [file.path, file] as const))
  const lines: Array<string> = []
  for (const file of planned.files) {
    const now = after.get(file.path)
    if (now === undefined) lines.push(`${file.path}: no longer part of the plan`)
    else if (now.state !== file.state) lines.push(`${file.path}: was ${file.state}, is now ${now.state}`)
    else if (now.digest !== file.digest) lines.push(`${file.path}: content changed`)
  }
  for (const file of current.files) {
    if (!before.has(file.path)) lines.push(`${file.path}: newly part of the plan`)
  }
  return lines
}

/**
 * The seal step: read the project once more, immediately before the first
 * checkpoint, and refuse when it is no longer the project the plan describes.
 *
 * `irreversible`, so a durable host runs it in every execution rather than
 * replaying a recorded answer: an approved plan that is run a day later is
 * exactly the case this step exists for. It also clears the unit artifacts of
 * any earlier run, so every artifact the report step reads back was written
 * by this run.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const sealAction = Action.make("smithers/migrate-v1/Seal", {
  payload: {
    options: Options.MigrateOptions,
    seal: PlanSeal
  },
  success: Schema.Struct({ root: Schema.String, digest: Schema.String }),
  error: MigrateError,
  tier: "irreversible"
})

/**
 * Checks the sealed plan against a fresh read without changing artifacts.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const validateSeal = (payload: {
  readonly options: Options.MigrateOptions
  readonly seal: PlanSeal
}): Effect.Effect<
  { readonly root: string; readonly digest: string },
  MigrateError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const result = yield* scan(payload.options)
    const current = yield* planSeal(result, payload.options)
    if (current.digest !== payload.seal.digest) {
      const changed = sealDifferences(payload.seal, current)
      return yield* Effect.fail(make(
        "stale-plan",
        "The project has changed since this migration was planned, so the plan no longer describes it. Rerun the plan and apply that.",
        changed.length === 0
          ? "a unit outline, the run-state roots, or the layout changed"
          : changed.join("\n")
      ))
    }
    return { root: payload.options.root, digest: current.digest }
  })

/**
 * Checks the sealed plan, then clears earlier unit artifacts under the lock.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const seal = (payload: {
  readonly options: Options.MigrateOptions
  readonly seal: PlanSeal
}): Effect.Effect<
  { readonly root: string; readonly digest: string },
  MigrateError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const validated = yield* validateSeal(payload)
    const artifacts = path.join(payload.options.root, ...Options.reportDir(payload.options).split("/"), "units")
    yield* fs.remove(artifacts, { recursive: true, force: true }).pipe(
      Effect.mapError(io(`could not clear the unit artifacts under "${artifacts}"`))
    )
    return validated
  })

/**
 * The seal step's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const sealLayer = sealAction.toLayer(seal)

/**
 * What one unit's execution settles on.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const UnitOutcome = Report.UnitReport

/**
 * What one unit's execution settles on.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type UnitOutcome = typeof UnitOutcome.Type

/**
 * The file one unit's own report is written to, relative to the project root.
 *
 * Per-unit artifacts are how the run carries results forward. A plan is a
 * dataflow graph and a `Planned` array cannot be spread at plan time, so the
 * alternative would be threading every outcome through every later payload —
 * which is both unreadable and a lot of journal. Writing each unit's report as
 * it settles is also what a crashed run wants: the units that finished are on
 * disk, in the directory the operator was told to commit.
 *
 * The name is the id made readable, then a digest of the id itself. The
 * readable half is lossy on purpose (`workflow:a/b` and `workflow:a-b` both
 * read `workflow-a-b`); the digest is what keeps two ids from sharing a file,
 * on a case-insensitive filesystem included, and the artifact carries the id
 * inside so the reader can check it was written for the unit it was asked
 * for.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const unitArtifact = (options: Options.MigrateOptions, id: string): string =>
  `${Options.reportDir(options)}/units/${id.replace(/[^A-Za-z0-9._-]+/g, "-")}-${sha256(id).slice(0, 16)}.json`

/**
 * The step that decides what a unit's rewrite was worth: it runs the
 * deterministic checks against the checkpoint, archives the old sources when
 * they hold, restores the checkpoint when they do not, and writes the unit's
 * own report artifact.
 *
 * `irreversible` because it moves files and restores a checkpoint.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const finishAction = Action.make("smithers/migrate-v1/Finish", {
  payload: {
    options: Options.MigrateOptions,
    outline: Transform.UnitOutline,
    checkpoint: Checkpoint.Ref,
    /** The exact roots used when taking this checkpoint. */
    runStateRoots: Schema.Array(Schema.String),
    /** Absent when the agent itself failed and there is no rewrite to judge. */
    result: Schema.NullOr(Transform.UnitResult),
    verification: Schema.NullOr(Report.VerificationResult),
    /** Why the agent failed, when it did. */
    failure: Schema.optional(Schema.String),
    repairRounds: Schema.Int
  },
  success: UnitOutcome,
  error: MigrateError,
  tier: "irreversible"
})

const unitPlanFor = (
  outline: Transform.UnitOutline,
  options: Options.MigrateOptions
): Units.UnitPlan => ({
  id: outline.id,
  kind: outline.kind,
  sources: outline.sources,
  targets: outline.targets,
  constructs: outline.constructs.map((row) => ({
    file: row.file,
    line: row.line,
    column: row.column,
    construct: row.construct,
    props: row.props
  })),
  mapping: outline.mapping.map((row) => ({
    construct: row.construct,
    target: row.target,
    targetModule: row.targetModule,
    rule: row.rule,
    class: row.class
  })),
  hints: { zod: [], prompt: [] },
  unsafe: outline.unsafe,
  notes: [],
  specifiers: outline.specifiers,
  verification: {
    install: outline.commands.install,
    format: outline.commands.format,
    typecheck: outline.commands.typecheck,
    test: outline.commands.test,
    discovery: { flowsDir: Options.flowsDir(options) },
    notes: []
  }
})

/**
 * Every check a unit's *kind* has to satisfy before it is called migrated.
 *
 * The content checks read the files a unit changed, so a unit that changed
 * nothing passes all of them vacuously — which is how an agent that answered
 * with an empty result used to be recorded as `migrated`. These ask the
 * opposite question: whatever the unit did or did not do, is the project now in
 * the state this kind of unit exists to produce?
 *
 * A file the check needs has to be there. A manifest, a tsconfig, an ignore
 * file, or an integration source that is gone is a finding, not a pass: a unit
 * may edit the files it owns and may never delete the evidence a check reads.
 * Absence is the platform's typed `NotFound` and nothing else; any other read
 * failure fails the step, and the checkpoint's restoring scope answers it.
 *
 * They run after {@link module:Archive.run}, because the deterministic rewrites
 * are part of what produces that state.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const postconditions = (
  root: string,
  outline: Transform.UnitOutline
): Effect.Effect<ReadonlyArray<Checks.CheckResult>, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const read = (file: string) => Fs.readIfExists(path.join(root, ...file.split("/")), file)
    const results: Array<Checks.CheckResult> = []
    type Finding = { file: string; line: number; message: string }
    const check = (name: string, findings: ReadonlyArray<Finding>): void => {
      results.push({ name, ok: findings.length === 0, findings })
    }
    const deleted = (file: string, what: string): Finding => ({
      file,
      line: 1,
      message: `the ${what} was deleted; a unit may rewrite it and may never remove it`
    })
    const parseJson = (file: string, text: string, strip = false) =>
      Effect.try({
        try: () => JSON.parse(strip ? Archive.withoutComments(text) : text) as Record<string, unknown>,
        catch: io(`the migrated "${file}" is not valid JSON`)
      })

    if (outline.kind === "workflow") {
      const missing: Array<Finding> = []
      for (const target of outline.targets) {
        const text = yield* read(target)
        if (text === undefined || text.trim() === "") {
          missing.push({ file: target, line: 1, message: "the unit produced no flow at the path it was given" })
        }
      }
      check("the unit wrote the flow it was planned for", missing)
    }

    if (outline.kind === "dependencies" || outline.kind === "project") {
      const manifests = outline.sources.filter((file) => (file.split("/").pop() ?? file) === "package.json")
      const present: Array<{ file: string; parsed: Record<string, unknown> }> = []
      const gone: Array<Finding> = []
      for (const file of manifests) {
        const text = yield* read(file)
        if (text === undefined) {
          gone.push(deleted(file, "manifest"))
          continue
        }
        present.push({ file, parsed: yield* parseJson(file, text) })
      }
      check("every manifest the unit owns still exists", gone)

      if (outline.kind === "project") {
        const declared: Array<Finding> = []
        for (const { file, parsed } of present) {
          for (const field of Archive.dependencyFields) {
            const map = parsed[field]
            if (typeof map !== "object" || map === null) continue
            for (const [name, version] of Object.entries(map as Record<string, string>)) {
              if (Detect.classifyPackage(name, typeof version === "string" ? version : "") === undefined) continue
              declared.push({
                file,
                line: 1,
                message: `${field}."${name}" still declares a 0.x package`
              })
            }
          }
        }
        check("no manifest declares a 0.x package", declared)
      }

      const pins: Array<Finding> = []
      for (const { file, parsed } of present) {
        for (const field of Archive.dependencyFields) {
          const map = parsed[field]
          if (typeof map !== "object" || map === null) continue
          const version = (map as Record<string, string>)["effect"]
          if (version === undefined || version === Archive.effectVersion) continue
          pins.push({
            file,
            line: 1,
            message: `${field}."effect" is ${version}; 1.0 runs on ${Archive.effectVersion}`
          })
        }
      }
      check("effect is pinned to the version this release ships", pins)
    }

    if (outline.kind === "project") {
      const tsconfigs = outline.sources.filter((file) => /^tsconfig(\..+)?\.json$/.test(file.split("/").pop() ?? file))
      const settings: Array<Finding> = []
      for (const file of tsconfigs) {
        const text = yield* read(file)
        if (text === undefined) {
          settings.push(deleted(file, "TypeScript configuration"))
          continue
        }
        const parsed = yield* parseJson(file, text, true)
        const compiler = parsed.compilerOptions
        if (typeof compiler !== "object" || compiler === null) continue
        const options = compiler as Record<string, unknown>
        for (const key of ["jsx", "jsxImportSource"]) {
          if (options[key] !== undefined) {
            settings.push({ file, line: 1, message: `compilerOptions.${key} still points at the 0.x JSX runtime` })
          }
        }
        const paths = options.paths
        if (typeof paths === "object" && paths !== null) {
          for (const key of Object.keys(paths)) {
            // The predicate the rewrite filters `paths` with, imported
            // rather than restated: a check and the rewrite meant to satisfy
            // it that disagree is a unit that can never pass.
            if (Archive.isOldPathsKey(key, outline.specifiers)) {
              settings.push({ file, line: 1, message: `compilerOptions.paths."${key}" still maps a 0.x specifier` })
            }
          }
        }
      }
      check("no tsconfig configures the 0.x JSX runtime", settings)

      // The root ignore file is the unit's own source or target, so the unit
      // is answerable for it either way: absent is a finding, not a pass.
      const ignore = yield* read(".gitignore")
      check(
        "the ignore file covers the 1.0 runtime state",
        ignore === undefined
          ? [{
            file: ".gitignore",
            line: 1,
            message: "there is no .gitignore, so `.flows/` runtime state would be committed"
          }]
          : ignore.split("\n").some((line) => line.trim().replace(/\/$/, "") === ".flows")
          ? []
          : [{ file: ".gitignore", line: 1, message: "`.flows/` is not ignored, so runtime state would be committed" }]
      )
    }

    if (outline.kind === "integration") {
      const remaining: Array<Finding> = []
      for (const file of outline.sources) {
        const text = yield* read(file)
        if (text === undefined) {
          remaining.push(deleted(file, "integration source"))
          continue
        }
        if (!/\.(ts|tsx|js|jsx|mjs|mts|cjs|cts)$/.test(file)) continue
        for (const record of Ts.moduleSpecifiers(Ts.parse(file, text))) {
          if (!Detect.isOldSpecifier(record.specifier, outline.specifiers)) continue
          remaining.push({
            file,
            line: record.line,
            message: `${record.form} "${record.specifier}" still reaches the 0.x facade`
          })
        }
      }
      check("the integration no longer imports the 0.x facade", remaining)
    }

    return results
  })

/**
 * Runs the deterministic checks and settles the unit.
 *
 * The order is the point. The rewrite is verified once by the unit flow, then
 * the checks run, then the archive moves the replaced sources aside and
 * rewrites the manifests, and only then is the tree the migration leaves
 * behind. So that final tree is what gets the last word: the postconditions,
 * the whole verification again (install, format, every typecheck, the tests,
 * discovery), the whole-tree confinement check, and the run-state digests all
 * run over it, and the unit is called migrated after they pass and not
 * before. A verification of the tree before the archive would vouch for a
 * tree nobody ends up with.
 *
 * Every fallible operation runs inside one restoring scope: an exception
 * in the initial comparisons, the checks, the archive, or the final verification
 * puts the unit's files back before it propagates. Without it a failing
 * archive would leave a half-moved tree and no report, because the failure
 * escapes the flow and `WriteReport` never runs.
 *
 * The scope restores by re-reading the tree when it fires, so it covers what
 * the archive did as well as what the agent did, and it covers whatever a
 * later version of this function adds below the archive without anyone
 * remembering to extend a list. {@link module:Checkpoint.rollback} is where
 * that is written down.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const finish = (payload: typeof finishAction.payloadSchema.Type): Effect.Effect<
  UnitOutcome,
  MigrateError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> =>
  Effect.gen(function*() {
    const { checkpoint, options, outline, result, verification } = payload
    const root = options.root
    const owned = [...new Set([...outline.sources, ...outline.targets])].sort()
    const ownedSet = new Set(owned)
    // What a failure undoes is read from the tree at the moment it fails, not
    // from anything computed here: the archive runs below, and a set fixed
    // before it cannot put back what it moved. A file the unit added outside
    // its set is still removed, and a file it modified or deleted outside its
    // set still cannot be byte-restored — the checkpoint copied the unit's own
    // files aside and nothing else — so that one is reported with the path and
    // the checkpoint's own restore command.
    const putBack = Checkpoint.rollback(root, checkpoint, {
      paths: owned,
      archiveDir: archiveDir(options)
    })

    return yield* Effect.gen(function*() {
      // An agent that failed needs restoration, not comparisons of its output.
      if (verification === null) {
        const rollback = yield* putBack
        return canonical({
          payload,
          status: "failed",
          changedFiles: [],
          checks: [],
          rollback,
          now: yield* Clock.currentTimeMillis
        })
      }

      // What the unit really did, read from the tree rather than from what it
      // said. The agent's own `changedFiles` is advisory: a unit that edits a
      // file it never declares is exactly the unit whose declaration is wrong,
      // so the declaration cannot be what the report is built from.
      const changedOwned = yield* Checkpoint.diff(root, checkpoint, owned)
      const wholeTree = yield* Checkpoint.treeDiff(root, checkpoint)
      const beyond = wholeTree.filter((file) => !ownedSet.has(file.path))
      // The install this unit ran rewrites the project's lockfile, so that write
      // is the tool's own and no unit is blamed for it. It is still the unit's
      // report's business: the exemption is from the refusal, not from the
      // record, and it is anchored to the exact root paths an install writes.
      const installed = beyond.filter((file) => Checkpoint.generated.includes(file.path))
      const outside = beyond.filter((file) => !Checkpoint.generated.includes(file.path))
      const outsideCheck: Checks.CheckResult = {
        name: "no write outside the unit's file set",
        ok: outside.length === 0,
        findings: outside.map((file) => ({
          file: file.path,
          line: 1,
          message: file.change === "added"
            ? "the unit added a file it does not own; rollback deleted it after preserving a recovery copy"
            : `the unit ${file.change} a file it does not own; put it back with \`${checkpoint.restore}\``
        }))
      }
      const changed = [...changedOwned, ...outside, ...installed].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      )

      const sources = yield* Checkpoint.sources(checkpoint)
      if (Verify.verdict(verification) === "fail") {
        const rollback = yield* putBack
        return canonical({
          payload,
          status: "failed",
          changedFiles: [],
          checks: [outsideCheck],
          rollback,
          now: yield* Clock.currentTimeMillis
        })
      }

      const checkpointFiles: Checks.CheckpointFiles = {
        sources,
        digests: new Map(checkpoint.digests.map((entry) => [entry.path, entry.digest] as const)),
        runStateRoots: payload.runStateRoots,
        owned
      }
      const checks = [
        ...yield* Checks.run(
          root,
          unitPlanFor(outline, options),
          changed.map((file) => file.path),
          checkpointFiles,
          result === null ? [] : [
            ...result.unsupported.map((entry) => ({ construct: entry.construct, file: entry.file })),
            ...result.unresolved.map((entry) => ({ construct: entry.construct, file: entry.file }))
          ],
          result === null ? [] : result.decisions.map((entry) => entry.construct)
        ),
        outsideCheck
      ]

      if (!Checks.ok(checks)) {
        const rollback = yield* putBack
        return canonical({
          payload,
          status: "failed",
          changedFiles: [],
          checks,
          rollback,
          now: yield* Clock.currentTimeMillis
        })
      }

      const archived = yield* Archive.run({
        root,
        unit: outline.id,
        kind: outline.kind,
        sources: outline.sources,
        targets: outline.targets,
        archiveDir: archiveDir(options),
        keepOldSources: options.keepOldSources === true,
        runStatePaths: outline.runStatePaths,
        specifiers: outline.specifiers
      })

      const settled = [...checks, ...yield* postconditions(root, outline)]
      if (!Checks.ok(settled)) {
        const rollback = yield* putBack
        return canonical({
          payload,
          status: "failed",
          changedFiles: [],
          checks: settled,
          rollback,
          now: yield* Clock.currentTimeMillis
        })
      }

      // The final tree, verified as the final tree. This is the verification
      // the report records: the one before the archive vouched for sources
      // that are no longer there and manifests that have since been rewritten.
      const final = yield* Verify.run({
        root,
        commands: outline.commands,
        changedFiles: [...changed, ...archived.changed].map((file) => file.path),
        expectFlows: outline.expectFlows
      })
      const finalVerification: Checks.CheckResult = {
        name: "the final tree verifies",
        ok: Verify.verdict(final) === "pass",
        findings: Verify.failures(final).map((line) => ({
          file: outline.sources[0] ?? outline.id,
          line: 1,
          message: line
        }))
      }
      // And confined as the final tree: the archive and the final verification
      // both ran commands, and a command writes where no rule can see.
      const finalOutside = (yield* Checkpoint.treeDiff(root, checkpoint))
        .filter((file) => !ownedSet.has(file.path) && !Checkpoint.generated.includes(file.path))
      const finalConfinement: Checks.CheckResult = {
        name: "no write outside the unit's file set after the archive",
        ok: finalOutside.length === 0,
        findings: finalOutside.map((file) => ({
          file: file.path,
          line: 1,
          message: file.change === "added"
            ? "a command run after the archive added a file the unit does not own; rollback deleted it after preserving a recovery copy"
            : `a command run after the archive ${file.change} a file the unit does not own; put it back with \`${checkpoint.restore}\``
        }))
      }
      const finalRunState = yield* Checks.runState(root, checkpointFiles)
      const verified = [...settled, finalVerification, finalConfinement, finalRunState]
      if (!Checks.ok(verified)) {
        const rollback = yield* putBack
        return canonical({
          payload,
          status: "failed",
          changedFiles: [],
          checks: verified,
          rollback,
          verification: final,
          now: yield* Clock.currentTimeMillis
        })
      }

      return canonical({
        payload,
        status: "migrated",
        changedFiles: mergedChanges(changed, archived.changed),
        checks: verified,
        scripts: archived.unsupportedScripts,
        verification: final,
        now: yield* Clock.currentTimeMillis
      })
      // Any failure below the checkpoint restores it. The explicit branches
      // above return a failed unit rather than failing, so this is only for
      // the ones nobody wrote a branch for: an unreadable file, a full disk, a
      // refused archive, an interrupt.
    }).pipe(Effect.onError(() =>
      putBack.pipe(
        Effect.flatMap((rollback) => Checkpoint.recordRollback(backupDir(options), checkpoint, rollback)),
        Effect.ignore
      )
    ))
  })

/**
 * One entry per path: what the archive did to a path is the last word on it,
 * because the archive ran last.
 */
const mergedChanges = (
  before: ReadonlyArray<Report.ChangedFile>,
  archived: ReadonlyArray<Report.ChangedFile>
): ReadonlyArray<Report.ChangedFile> => {
  const byPath = new Map<string, Report.ChangedFile>()
  for (const file of before) byPath.set(file.path, file)
  for (const file of archived) byPath.set(file.path, file)
  return [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

const archiveDir = (options: Options.MigrateOptions): string => `${options.root}/${Options.reportDir(options)}/archive`

const backupDir = (options: Options.MigrateOptions): string => `${options.root}/${Options.reportDir(options)}/backup`

const canonical = (input: {
  readonly payload: typeof finishAction.payloadSchema.Type
  readonly status: "migrated" | "failed"
  readonly changedFiles: ReadonlyArray<Report.ChangedFile>
  readonly checks: ReadonlyArray<Checks.CheckResult>
  readonly rollback?: Checkpoint.Rollback | undefined
  readonly scripts?: ReadonlyArray<typeof Archive.UnsupportedScript.Type> | undefined
  /** The verification the report records, when a final one ran; the payload's otherwise. */
  readonly verification?: Report.VerificationResult | undefined
  readonly now: number
}): UnitOutcome => {
  const { changedFiles, checks, payload, status } = input
  const result = payload.result
  const failedChecks = checks.filter((check) => !check.ok)
  const verification = input.verification ?? payload.verification
  return {
    id: payload.outline.id,
    kind: payload.outline.kind,
    sources: payload.outline.sources,
    targets: payload.outline.targets,
    status,
    checkpoint: Checkpoint.toReport(payload.checkpoint),
    changedFiles,
    decisions: result === null ? [] : result.decisions,
    unresolved: [
      ...(result === null ? [] : result.unresolved),
      ...(payload.failure === undefined ? [] : [{
        construct: "the migration agent",
        reason: payload.failure,
        file: payload.outline.sources[0] ?? payload.outline.id,
        line: 1,
        suggestion: "Read the failure, then rerun this unit with --unit " + payload.outline.id
      }]),
      ...failedChecks.flatMap((check) =>
        check.findings.map((finding) => ({
          construct: check.name,
          reason: finding.message,
          file: finding.file,
          line: finding.line,
          suggestion: "The check that refused this unit names the file and the line; fix it and rerun the unit."
        }))
      ),
      ...(input.rollback?.unrestored ?? []).map((file) => ({
        construct: "rollback could not restore a file",
        reason: "The file changed outside the unit's declared set, and its original bytes were not in the unit backup.",
        file,
        line: 1,
        suggestion:
          `From "${payload.options.root}", run \`${payload.checkpoint.restore}\`. If the file was untracked, recover it from editor history or another backup.`
      })),
      ...(input.rollback?.deletedAdds ?? []).map((entry) => ({
        construct: "rollback deleted a post-checkpoint file",
        reason:
          `The file did not exist at checkpoint time. Rollback deleted it and kept a recovery copy at "${entry.backup}".`,
        file: entry.path,
        line: 1,
        suggestion:
          `Copy "${entry.backup}" back to "${entry.path}" under "${payload.options.root}" if it was operator work.`
      })),
      // A script naming a verb 1.0 does not have is left exactly as it was and
      // reported: deleting a script an operator depends on would be worse than
      // leaving one that fails loudly.
      ...(input.scripts ?? []).map((script) => ({
        construct: `script "${script.script}"`,
        reason: script.reason,
        file: script.file,
        line: 1,
        suggestion: "Replace the script with the 1.0 command that does the same job, or remove it."
      }))
    ],
    unsupported: result === null ? [] : result.unsupported,
    ...(verification === null ? {} : { verification }),
    repairRounds: payload.repairRounds,
    // From this unit's own checkpoint, not from the run's start: a report whose
    // last unit claims every earlier unit's minutes tells a reader nothing.
    durationMs: Math.max(0, input.now - payload.checkpoint.takenAt)
  }
}

/**
 * The finish step's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const finishLayer = finishAction.toLayer((payload) =>
  Effect.tap(finish(payload), (outcome) =>
    writeUnitReport(payload.options, outcome).pipe(
      Effect.flatMap(() => Checkpoint.clearPending(backupDir(payload.options), payload.checkpoint))
    ))
)

const decodeUnit = Schema.decodeUnknownSync(Report.UnitReport)
const encodeUnit = Schema.encodeUnknownSync(Report.UnitReport)

const writeUnitReport = (
  options: Options.MigrateOptions,
  outcome: UnitOutcome
): Effect.Effect<void, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(options.root, ...unitArtifact(options, outcome.id).split("/"))
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    // Atomically: a crashed run is read back through these artifacts, so one
    // must never hold half a report.
    yield* Fs.writeAtomic(file, `${JSON.stringify(encodeUnit(outcome), null, 2)}\n`)
  }).pipe(Effect.mapError(io(`could not record the report of unit "${outcome.id}"`)))

/**
 * One unit's recorded outcome, or `undefined` when none was ever written.
 *
 * Absent is the platform's `NotFound` and nothing else. An artifact that
 * cannot be read, cannot be decoded, or was written for a different unit is a
 * failure of this step, never a unit quietly left out of the report.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const readUnitReport = (
  options: Options.MigrateOptions,
  id: string
): Effect.Effect<UnitOutcome | undefined, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const relative = unitArtifact(options, id)
    const text = yield* Fs.readIfExists(path.join(options.root, ...relative.split("/")), relative)
    if (text === undefined) return undefined
    const parsed = yield* Effect.try({
      try: () => decodeUnit(JSON.parse(text)),
      catch: io(`the recorded report of unit "${id}" at "${relative}" could not be read back`)
    })
    if (parsed.id !== id) {
      return yield* Effect.fail(make(
        "io",
        `the recorded report at "${relative}" belongs to unit "${parsed.id}", not to "${id}"`
      ))
    }
    return parsed
  })

/**
 * The outcome the report records for a unit that never wrote one.
 *
 * A planned unit with no durable outcome is not a unit that was skipped: it
 * is a unit the run cannot account for, and a report that omitted it would
 * exit 0 over work that may have stopped halfway.
 */
const unaccounted = (
  planned: Report.MigrationReport,
  options: Options.MigrateOptions,
  id: string
): UnitOutcome => {
  const unit = planned.units.find((entry) => entry.id === id)
  return {
    id,
    kind: unit?.kind ?? "workflow",
    sources: unit?.sources ?? [],
    targets: unit?.targets ?? [],
    status: "failed",
    changedFiles: [],
    decisions: [],
    unresolved: [{
      construct: "no recorded outcome",
      reason: `the run recorded no outcome for unit ${id}, so it cannot say what the unit did or left behind`,
      file: unit?.sources[0] ?? id,
      line: 1,
      suggestion: `read ${
        Options.reportDir(options)
      }/pending-unit.json if it exists, restore its checkpoint, then rerun with --unit ${id}`
    }],
    unsupported: [],
    repairRounds: 0,
    durationMs: 0
  }
}

/**
 * The settle step: record a unit that failed with this package's own error
 * before its finish step could write an outcome.
 *
 * A checkpoint that cannot be taken, a verification that cannot spawn, an
 * archive that cannot move a file: each fails its unit's execution with a
 * `MigrateError` after the unit's restoring scope has put its files back. The
 * error is the operator's evidence, so it is written into the unit's own
 * artifact as the reason the unit failed, and the run goes on to the next
 * unit; every finished unit keeps its outcome and the report exits nonzero.
 *
 * One code is not a unit's failure: `no-vcs` is a refusal of the whole run
 * before it has written anything, so it is raised again unchanged and the
 * operator sees `--allow-no-vcs` in the refusal rather than a report.
 *
 * `irreversible` because it writes the artifact.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const settleAction = Action.make("smithers/migrate-v1/Settle", {
  payload: {
    options: Options.MigrateOptions,
    outline: Transform.UnitOutline,
    failure: MigrateError
  },
  success: Schema.String,
  error: MigrateError,
  tier: "irreversible"
})

/**
 * Records a unit-level failure as the unit's outcome and answers with the
 * unit id, or re-raises a refusal that belongs to the whole run.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const settle = (payload: {
  readonly options: Options.MigrateOptions
  readonly outline: Transform.UnitOutline
  readonly failure: MigrateError
}): Effect.Effect<string, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const { failure, options, outline } = payload
    if (failure.code === "no-vcs") return yield* Effect.fail(failure)
    const outcome: UnitOutcome = {
      id: outline.id,
      kind: outline.kind,
      sources: outline.sources,
      targets: outline.targets,
      status: "failed",
      changedFiles: [],
      decisions: [],
      unresolved: [{
        construct: "the unit could not finish",
        reason: `${failure.code}: ${failure.message}${failure.details === undefined ? "" : `\n${failure.details}`}`,
        file: outline.sources[0] ?? outline.id,
        line: 1,
        suggestion: `The unit's files were restored from its checkpoint. Read ${
          Options.reportDir(options)
        }/pending-unit.json if it exists, fix the cause, then rerun with --unit ${outline.id}`
      }],
      unsupported: [],
      repairRounds: 0,
      durationMs: 0
    }
    yield* writeUnitReport(options, outcome)
    return outline.id
  })

/**
 * The settle step's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const settleLayer = settleAction.toLayer(settle)

/**
 * The report step: fold every unit outcome into the scan's report and write
 * `report.json` and `report.md`.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const writeReportAction = Action.make("smithers/migrate-v1/WriteReport", {
  payload: {
    options: Options.MigrateOptions,
    report: Report.MigrationReport,
    unitIds: Schema.Array(Schema.String),
    after: Schema.String
  },
  success: Report.MigrationReport,
  error: MigrateError,
  tier: "irreversible"
})

/**
 * Folds the unit outcomes into the report and writes it.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const writeReport = (payload: {
  readonly options: Options.MigrateOptions
  readonly report: Report.MigrationReport
  readonly unitIds: ReadonlyArray<string>
}): Effect.Effect<Report.MigrationReport, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const units: Array<UnitOutcome> = []
    for (const id of payload.unitIds) {
      const recorded = yield* readUnitReport(payload.options, id)
      units.push(recorded ?? unaccounted(payload.report, payload.options, id))
    }
    const merged = units.reduce((report, unit) => Report.withUnit(report, unit), payload.report)
    const verification = units.reduce<Report.VerificationResult | undefined>(
      (last, unit) => unit.verification ?? last,
      undefined
    )
    const withVerification = verification === undefined
      ? merged
      : new Report.MigrationReport({ ...merged, verification })
    const final = Report.finalize(withVerification, {
      ...(payload.options.acknowledgeRunState === undefined
        ? {}
        : { acknowledgeRunState: payload.options.acknowledgeRunState })
    })
    if (payload.options.mode !== "scan") {
      yield* Report.write(`${payload.options.root}/${Options.reportDir(payload.options)}`, final)
    }
    return final
  })

/**
 * The report step's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const writeReportLayer = writeReportAction.toLayer(writeReport)

/**
 * One unit's migration, as its own durable execution.
 *
 * @category flows
 * @since 1.0.0-rc.0
 */
export const unit = Flow.make(unitTag, {
  payload: {
    options: Options.MigrateOptions,
    outline: Transform.UnitOutline,
    runStateRoots: Schema.Array(Schema.String),
    /**
     * What this unit runs after: the previous unit's id, or the approved root
     * for the first one. It is the run's ordering constraint expressed as
     * data, because a plan orders what depends on something and nothing else.
     */
    after: Schema.String
  },
  success: UnitOutcome,
  error: MigrateError,
  body: ({ options, outline, runStateRoots }) => {
    const rounds = Options.maxRepairRounds(options)

    // Every node below takes a value from the one before it, and that is the
    // ordering. A plan is a dataflow graph: a step nothing depends on may run
    // whenever the engine likes, so "checkpoint, then rewrite, then verify"
    // has to be expressed as data or it is not expressed at all. The
    // checkpoint's own record feeds the capture, the capture feeds the
    // rewrite, the rewrite's account of what it changed feeds the
    // verification, and both feed the step that settles the unit.
    return Node.bindPlanned(
      Checkpoint.action.call({
        root: options.root,
        unit: outline.id,
        // Existing targets are user data too. Recording the union makes an
        // absent target an explicit manifest fact and preserves exact bytes
        // when a migration overwrites a target that was already present.
        files: [...new Set([...outline.sources, ...outline.targets])].sort(),
        backupDir: backupDir(options),
        allowNoVcs: options.allowNoVcs === true,
        runStateRoots,
        // What the whole-tree manifest leaves out: the tool's own directory,
        // the 1.0 runtime state a migrated project writes, and the run-state
        // roots, which the digests and their own check already cover.
        treeExclude: [Options.reportDir(options), Options.defaultReportDir, ".flows"]
      }),
      (checkpoint) => {
        const settleWith = (
          result: Planned.Planned<Transform.UnitResult>,
          verification: Planned.Planned<Report.VerificationResult>,
          repairRounds: number
        ): Node.Node<UnitOutcome, MigrateError, UnitRequires> =>
          finishAction.call({
            options,
            outline,
            checkpoint,
            runStateRoots,
            result,
            verification,
            repairRounds
          })

        // An agent that fails is a unit that failed, not a migration that
        // stopped: the checkpoint is restored, the report says why, and the
        // next unit runs.
        const settleUnrun = (
          failure: Planned.Planned<string>
        ): Node.Node<UnitOutcome, MigrateError, UnitRequires> =>
          finishAction.call({
            options,
            outline,
            checkpoint,
            runStateRoots,
            result: null,
            verification: null,
            failure,
            repairRounds: rounds
          })

        const round = (
          attempt: number,
          rewrite: Node.Node<Transform.UnitResult, MigrateError | AgentAction.AgentFailure, UnitRequires>
        ): Node.Node<UnitOutcome, MigrateError | AgentAction.AgentFailure, UnitRequires> =>
          Node.bindPlanned(rewrite, (result) =>
            Node.branch(
              Verify.action.call({
                root: options.root,
                commands: outline.commands,
                changedFiles: result.changedFiles,
                expectFlows: outline.expectFlows
              }),
              {
                if: (verification) => Verify.verdict(verification) === "pass",
                then: (verification) => settleWith(result, verification, attempt),
                else: (verification) =>
                  attempt >= rounds
                    ? settleWith(result, verification, attempt)
                    : Node.bindPlanned(
                      // A repair round is shown the sources as they are now,
                      // not as the unit found them: the previous round edited
                      // them, and a prompt that hid that would ask for the
                      // same rewrite again. `current` is what says so; without
                      // it the capture answers from the checkpoint's copy, and
                      // the payload would be the round-0 payload byte for byte.
                      Transform.captureAction.call({ outline, checkpoint, current: true }),
                      (brief) =>
                        round(
                          attempt + 1,
                          Repair.action.call({
                            unit: brief,
                            round: attempt + 1,
                            failures: verification
                          })
                        )
                    )
              }
            ))

        const settled = Node.catch(
          Node.bindPlanned(
            Transform.captureAction.call({ outline, checkpoint }),
            (brief) => round(0, Transform.action.call({ unit: brief }))
          ),
          {
            error: AgentAction.AgentFailure,
            onFailure: (failure) => settleUnrun(failure.message)
          }
        )
        // A schema-filtered catch conservatively retains its input errors:
        // refinements can reject values without narrowing their TypeScript type.
        // AgentFailure is the same complete union declared by Transform and
        // Repair, so this catch handles every member of that union. Exclude
        // only those errors; migration errors still propagate to the parent.
        return settled as Node.Node<
          UnitOutcome,
          Exclude<Node.Error<typeof settled>, AgentAction.AgentFailure>,
          UnitRequires
        >
      }
    )
  }
})

/**
 * The migration.
 *
 * @category flows
 * @since 1.0.0-rc.0
 */
export const flow = Flow.make(tag, {
  payload: {
    options: Options.MigrateOptions,
    units: Schema.Array(Transform.UnitOutline),
    runStateRoots: Schema.Array(Schema.String),
    generatedAt: Schema.String,
    /** What the survey sealed; the seal step refuses a tree that no longer matches it. */
    seal: PlanSeal
  },
  success: Report.MigrationReport,
  error: MigrateError,
  body: ({ generatedAt, options, runStateRoots, seal, units }) =>
    Node.bindPlanned(
      scanAction.call({ options, generatedAt }),
      (report) =>
        Node.bindPlanned(
          gateAction.call({ report, options, unitIds: units.map((outlined) => outlined.id) }),
          (approved) => {
            if (options.mode !== "apply") {
              return writeReportAction.call({
                options: approved,
                report,
                unitIds: [],
                after: approved.root
              })
            }
            const unitIds = units.map((outlined) => outlined.id)
            const step = (
              index: number,
              after: string | Planned.Planned<string>
            ): Node.Node<Report.MigrationReport, MigrateError, Requires> => {
              const outlined = units[index]
              if (outlined === undefined) {
                return writeReportAction.call({ options: approved, report, unitIds, after })
              }
              // A unit that fails is a unit that failed, not a migration that
              // stopped. An agent failure already settles its unit, and a
              // `MigrateError` raised by the checkpoint, the verification, the
              // archive, or the artifact write is settled the same way here:
              // the unit's restoring scope has already put its files back, the
              // next unit runs, and the report is written. A unit with no
              // recorded outcome is reported `failed` by `writeReport`, so the
              // run still exits nonzero and the operator reads what happened
              // in the report instead of losing every finished unit with it.
              // The catch wraps only this unit's call, never the recursion, so
              // one failure cannot re-enter the rest of the plan.
              const settled = Node.catch(
                Node.map(
                  unit.child({ options: approved, outline: outlined, runStateRoots, after }),
                  (outcome) => outcome.id
                ),
                {
                  error: MigrateError,
                  onFailure: (failure) => settleAction.call({ options: approved, outline: outlined, failure })
                }
              )
              return Node.bindPlanned(settled, (id) => step(index + 1, id))
            }
            // The seal runs after the gate and reads the tree once more; the
            // first unit runs after the seal, and says so with the root the
            // seal approved. Every later unit runs after the one before it.
            return Node.bindPlanned(
              sealAction.call({ options: approved, seal }),
              (sealed) => step(0, sealed.root)
            )
          }
        )
    )
})

/**
 * Planning registrations contain no agent actions or unit interpreter. A
 * caller cannot turn this keyless composition into an agent run.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerPlan = Layer.mergeAll(
  scanLayer,
  gateLayer,
  sealLayer,
  settleLayer,
  writeReportLayer,
  Interpreter.layer(flow)
).pipe(Layer.provideMerge(Action.layerImplementations))

/**
 * Every action implementation and both flow registrations, over the table the
 * implementations file themselves in.
 *
 * `Archive` is merged even though {@link finish} calls `Archive.run` directly:
 * the archive, the deterministic checks, and the restore-on-failure are one
 * decision about one unit, and splitting them across two nodes would leave a
 * window where a unit is archived and unchecked. The action stays implemented
 * because it is public API.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = Layer.mergeAll(
  Checkpoint.layer,
  Transform.captureLayer,
  Transform.layer,
  Repair.layer,
  Verify.layer,
  Archive.layer,
  finishLayer,
  layerPlan,
  Interpreter.layer(unit)
).pipe(Layer.provideMerge(Action.layerImplementations))

/**
 * The run-state roots a scan implies, in the shape the unit flow takes.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const runStateRoots = (result: Scan.ScanResult): ReadonlyArray<string> => RunState.roots(result.runState)

/**
 * The plan-time outlines of every unit a scan found.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const outlines = (
  result: Scan.ScanResult,
  options: Options.MigrateOptions
): ReadonlyArray<Transform.UnitOutline> => {
  const flowsDir = Options.flowsDir(options)
  const writesFlows = (unit: Units.UnitPlan): boolean =>
    unit.targets.some((target) => target === flowsDir || target.startsWith(`${flowsDir}/`))
  // A project with no workflow never grows a `flows/` directory, and the unit
  // that only adds packages runs before the one that does. Demanding registry
  // discovery of either would fail a unit for doing exactly what it was asked.
  const anyFlows = result.units.some(writesFlows)
  return result.units.map((planned) =>
    Transform.outline(result, planned, options, anyFlows && planned.kind !== "dependencies")
  )
}
