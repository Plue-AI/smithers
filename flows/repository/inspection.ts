/** Measured source and repository history; no generated knowledge prerequisite. */
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { NativeCoding } from "../coding/native.ts"
import { collectSources, extractPaths, normalizePath, reader, repositoryContextPaths, type SourceReader } from "../coding/planning-sources.ts"
import { CodingError } from "../coding/schema.ts"
import { RepositoryRemote } from "./remote.ts"
import { ensureSource, heldSourceCommits } from "./retention.ts"
import { withCapturedCommit } from "./source.ts"
import type { ImmutableSourceOptions } from "../coding/immutable-source.ts"
import { Event, RepositoryEvidence } from "./schema.ts"

export const deploymentMinutes = 120
export const deploymentTokens = 200_000
export const CaptureRepository = Action.make("repository/capture", {
  payload: { repo: Schema.NonEmptyString, prompt: Schema.String, sourceRevision: Schema.optionalKey(Schema.String),
    heldOut: Schema.optionalKey(Schema.Boolean), event: Schema.optionalKey(Event) }, success: RepositoryEvidence, error: CodingError,
  nondeterministic: true
})
export type InspectionOptions = ImmutableSourceOptions
const unavailable = (message: string) => new CodingError({ code: "unavailable", message })
/** The job already receives its reviewed configuration explicitly. Repository
 * links cannot smuggle its retained eval expectations into model evidence. */
export const repositorySourceReader = (root: string, fs: FileSystem.FileSystem): Effect.Effect<SourceReader, never, Path.Path> => Effect.gen(function*() {
  const path = yield* Path.Path, source = yield* reader(root, fs).pipe(Effect.provideService(FileSystem.FileSystem, fs))
  const base = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root))
  const internal = (relative: string) => /^\.smithers\/repository-jobs(?:\/|$)/i.test(relative)
  return { ...source, read: relative => Effect.gen(function*() {
    if (normalizePath(relative) === null || internal(relative)) return { kind: "unreadable" as const }
    const target = yield* fs.realPath(path.resolve(base, relative)).pipe(Effect.orElseSucceed(() => ""))
    if (target && internal(path.relative(base, target))) return { kind: "unreadable" as const }
    return yield* source.read(relative)
  }) }
})
/** The paths the prompt names, this repository's own CI workflow files, and its
 * standing guidance and manifests, each read through the same sandboxed reader. */
export const readRepositorySources = (options: InspectionOptions, root: string, prompt: string) => Effect.gen(function*() {
  const path = yield* Path.Path, fs = options.fs
  const sourceReader = yield* repositorySourceReader(root, fs)
  const directory = yield* fs.realPath(path.join(root, ".github/workflows")).pipe(Effect.orElseSucceed(() => ""))
  const ciNames = directory.startsWith(root + path.sep)
    ? yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as Array<string>)) : []
  const ciPaths = ciNames.filter(name => /^[^/\\]+\.(?:yml|yaml)$/.test(name)).sort().slice(0, 12).map(name => `.github/workflows/${name}`)
  const first = yield* collectSources(sourceReader, [...extractPaths(prompt), ".github/workflows", ...ciPaths, ...(yield* repositoryContextPaths(sourceReader))])
  return yield* collectSources(sourceReader, [...first.sources.map(file => file.path), ...first.missing,
    ...extractPaths(...first.sources.map(file => file.text))])
})
export const captureRepository = (options: InspectionOptions, input: typeof CaptureRepository.payloadSchema.Type, mode: "snapshot" | "immutable" = "snapshot") => Effect.gen(function*() {
  const remote = yield* Effect.serviceOption(RepositoryRemote)
  if (Option.isSome(remote) && remote.value.repo !== input.repo) return yield* unavailable("This host belongs to a different repository")
  // A capture of the source an event names retains it from the repository first,
  // exactly as the live job does, so a workspace that never fetched that commit
  // reads it instead of scoring whatever source it happens to hold.
  const execution = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
  if (input.event !== undefined && Option.isSome(execution)) yield* ensureSource(options, input.event, input.event.payload, execution.value.executionId)
  if (mode === "snapshot") yield* (yield* Jj.Jj).snapshot("repository automation inspection")
  const native = yield* NativeCoding, before = yield* native.read([], mode === "snapshot" ? 50 : undefined)
  if (before.head.kind !== "resolved") return yield* unavailable("Resolve native source conflicts before repository setup")
  const readFiles = (root: string) => readRepositorySources(options, root, input.prompt)
  // A held-out revision outlives the workspace that recorded it, and a replaced
  // workspace never held that commit. Current source is what this host can capture,
  // and only a lookup that answered "absent" may substitute it: a refused or
  // unreachable lookup fails with its own code instead of scoring other source.
  // The working copy is this workspace's own commit and dies with it, so a case
  // pinned to it is unevaluable anywhere else. An empty snapshot adds nothing to
  // the commit it sits on, so that commit is the published source it read.
  const canonical = before.head.empty === true && before.head.parentCommitIds.length === 1
    ? before.head.parentCommitIds[0]! : before.head.commitId
  const pinned = input.sourceRevision !== undefined && input.sourceRevision !== canonical &&
    (input.heldOut !== true || (yield* heldSourceCommits(options, [input.sourceRevision], before.operationId)))
    ? input.sourceRevision : undefined
  const captured = mode === "immutable" || pinned !== undefined || canonical !== before.head.commitId
    ? yield* withCapturedCommit(options, pinned ?? canonical, before.operationId, (root, source) => readFiles(root).pipe(Effect.map(files => ({ files, source }))))
    : { files: yield* readFiles(yield* options.fs.realPath(options.repositoryPath)), source: before.head }
  const files = captured.files
  const history = Option.isSome(remote) ? yield* remote.value.history : {
    records: [], sources: [{ path: "repository:issues-and-prs", status: "failed" as const, summary: "Connect the repository API to inspect issues and PRs." }]
  }
  const after = yield* native.read([], mode === "snapshot" ? 50 : undefined)
  if (before.operationId !== after.operationId || JSON.stringify(before.head) !== JSON.stringify(after.head)) {
    return yield* new CodingError({ code: "stale_revision", message: "Source changed during repository inspection; retry" })
  }
  return { repo: input.repo, source: captured.source, files: files.sources, missing: files.missing,
    history: (before.history ?? []).map(row => ({ commitId: row.commitId, description: row.description ?? "" })),
    records: history.records, sources: [
      ...files.sources.map(file => ({ path: file.path, status: "read" as const,
        summary: file.truncated ? "Read bounded prefix" : "Read", revision: file.digest })),
      ...files.missing.map(path => ({ path, status: "missing" as const, summary: "Not present" })),
      ...history.sources
    ] }
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : unavailable("Repository inspection could not capture consistent source")))

/** Captures one deadline for the whole durable invocation, never per subflow. */
export const StartBudget = Action.make("repository/start-budget", {
  payload: { minutes: Schema.Number }, success: Schema.Number, error: CodingError, nondeterministic: true
})
export const AssertBudget = Action.make("repository/assert-budget", {
  payload: { deadlineAt: Schema.Number }, success: Schema.Void, error: CodingError, nondeterministic: true
})
export const inspectionLayers = (options: InspectionOptions) => Layer.mergeAll(
  CaptureRepository.toLayer(input => captureRepository(options, input)),
  StartBudget.toLayer(({ minutes }) => !Number.isSafeInteger(minutes) || minutes < 1 || minutes > deploymentMinutes
    ? Effect.fail(unavailable(`Choose a job budget of 1–${deploymentMinutes} minutes`))
    : Effect.sync(() => Date.now() + minutes * 60_000)),
  AssertBudget.toLayer(({ deadlineAt }) => Date.now() >= deadlineAt
    ? Effect.fail(unavailable("This repository job reached its configured time limit")) : Effect.void)
)

export const currentExecutionId = Effect.map(FlowRuntime.FlowInstance, instance => instance.executionId)
