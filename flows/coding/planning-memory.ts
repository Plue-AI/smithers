/** Default gathering uses source files and native JJ history. Generated Wiki
 * memory participates when a stack request carries the published pages or the
 * operator's own verified snapshot exists, and only while it is fresh.
 * Projects can replace GatherContext's action layer with their own workflow.
 */
import * as RecallKeyword from "../../packages/smithers/agent/memory/src/RecallKeyword.ts"
import * as Digest from "@smthrs/core/Digest"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { operations as wikiOperations } from "../wiki/operations.ts"
import type { PageSpec } from "../wiki/schema.ts"
import { NativeCoding } from "./native.ts"
import { collectSources, extractPaths, repositoryContextPaths, reader as sourceReader, staleSources } from "./planning-sources.ts"
import { changedPaths, driftOf, GatherContext, memoryRevision, PlanningContext, type PlanningInput, staleRevisionMessage, VerifyContext } from "./planning.ts"
import { type Check, CodingError } from "./schema.ts"

export interface MemoryOptions {
  readonly repositoryPath: string
  readonly wiki?: boolean
  readonly wikiOutput?: string
  readonly pages?: ReadonlyArray<PageSpec>
  readonly implementation: string
  readonly checks: ReadonlyArray<Omit<Check, "flowDigest">>
  readonly historyLimit?: number
  readonly maxMemoryBytes?: number
}
const Page = Schema.Struct({
  id: Schema.NonEmptyString, title: Schema.String,
  kind: Schema.Literals(["current", "intent"]), body: Schema.NonEmptyString,
  inputDigest: Schema.NonEmptyString
})
const Pointer = Schema.Struct({
  artifactDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  sourceRevision: Schema.NonEmptyString, verification: Schema.Literal("verified"),
  pages: Schema.Array(Page).check(Schema.isMinLength(1), Schema.isMaxLength(30))
})
const failure = (message: string) => new CodingError({ code: "stale_revision", message })
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

type WikiPage = { readonly id: string; readonly title: string; readonly kind: "current" | "intent"; readonly body: string; readonly inputDigest: string }

/** The pages whose inputs still hash to this source under this host's own catalog. */
const freshWikiPages = (options: MemoryOptions, pages: ReadonlyArray<WikiPage>, hostFilesystem?: FileSystem.FileSystem) =>
  Effect.gen(function*() {
    const ops = wikiOperations({ root: options.repositoryPath, output: options.wikiOutput ?? options.repositoryPath, fs: hostFilesystem })
    const fresh: Array<WikiPage> = []
    for (const page of pages) {
      const spec = options.pages?.find(spec => spec.id === page.id)
      if (spec === undefined) continue
      const current = yield* Effect.result(ops.collect(spec))
      if (current._tag === "Success" && current.success.inputDigest === page.inputDigest) fresh.push(page)
    }
    return fresh
  })

/**
 * Wiki memory is optional context: planning never generates the wiki and never
 * waits on it. A stack request carries the stack's published pages (or null);
 * any other request reads this host's own verified snapshot when one exists.
 * Either way only pages still fresh against this source are used.
 */
export const wikiMemory = (options: MemoryOptions, input: typeof PlanningInput.Type, hostFilesystem?: FileSystem.FileSystem) =>
  Effect.gen(function*() {
    if (input.wiki === null || !options.pages?.length) return undefined
    if (input.wiki !== undefined) {
      const pages = yield* freshWikiPages(options, input.wiki.pages, hostFilesystem)
      if (pages.length === 0) return undefined
      return { sourceRevision: input.wiki.sourceRevision, pages,
        digest: Digest.digest(Digest.canonical(pages.map(page => ({ id: page.id, inputDigest: page.inputDigest, body: Digest.digest(page.body) })))) }
    }
    if (options.wiki !== true || !options.wikiOutput) return undefined
    const fs = hostFilesystem ?? (yield* FileSystem.FileSystem), path = yield* Path.Path
    const pointer = path.resolve(options.wikiOutput, "current.json")
    if (!(yield* fs.exists(pointer)) || (yield* fs.stat(pointer)).size > BigInt(16 * 1024 * 1024)) return undefined
    const captured = yield* fs.readFileString(pointer)
    // Use the owning verifier. Digest equality alone does not prove semantic
    // review, nor may old generated explanations silently stand in for new code.
    const checked = yield* Effect.result(wikiOperations({ root: options.repositoryPath, output: options.wikiOutput, fs: hostFilesystem }).check(options.pages, true))
    if (checked._tag === "Failure" || (yield* fs.readFileString(pointer)) !== captured) return undefined
    const wiki = yield* Effect.try({ try: () => JSON.parse(captured) as unknown, catch: () => failure("Invalid verified wiki pointer") }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Pointer)), Effect.option)
    if (wiki._tag === "None") return undefined
    return { sourceRevision: wiki.value.sourceRevision, pages: wiki.value.pages, digest: wiki.value.artifactDigest }
  })

/** The notes whose page inputs no longer hash to this source. */
export const staleWikiNotes = (options: MemoryOptions, notes: typeof PlanningContext.Type["memory"], hostFilesystem?: FileSystem.FileSystem) =>
  Effect.gen(function*() {
    if (notes.length === 0) return []
    const pages = notes.map(note => ({ id: note.id, title: note.title, kind: note.kind, body: note.markdown, inputDigest: note.inputDigest }))
    const fresh = new Set((yield* freshWikiPages(options, pages, hostFilesystem)).map(page => page.id))
    return notes.filter(note => !fresh.has(note.id)).map(note => note.id)
  })

/** No model or database participates in selecting and identifying source facts. */
export const gather = (options: MemoryOptions, input: typeof PlanningInput.Type, hostFilesystem?: FileSystem.FileSystem) => Effect.gen(function*() {
  const limit = options.historyLimit ?? 100, maximum = options.maxMemoryBytes ?? 48 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 90 * 1024) {
    return yield* failure("Planning memory requires historyLimit 1..100 and maxMemoryBytes 1024..92160")
  }
  const native = yield* NativeCoding, jj = yield* Jj.Jj
  // The configured Jj captures current bytes in the SAME native atom. It never
  // opens a new change merely because memory needs an immutable code identity.
  yield* jj.snapshot("coding planning memory")
  const before = yield* native.read([], limit)
  if (!before.history?.length || before.history.some(row => row.kind !== "resolved") || before.head.kind !== "resolved") {
    return yield* failure("Planning requires bounded resolved native history; inspect conflicts or update the installed adapter")
  }
  const memory: Array<typeof PlanningContext.Type["memory"][number]> = []
  const wiki = yield* wikiMemory(options, input, hostFilesystem)
  const wikiDigest = wiki?.digest ?? null
  if (wiki !== undefined) {
    const terms = RecallKeyword.normalizeQueryTerms(`${input.prompt}\n${input.feedback}`)
    const ranked = wiki.pages.map(page => ({ page, score: RecallKeyword.scoreRow(terms, {
      key: `${page.id} ${page.title}`, text: page.body, tags: [], updatedAtMs: 0
    }) })).sort((left, right) => right.score - left.score || (left.page.id < right.page.id ? -1 : left.page.id > right.page.id ? 1 : 0))
    for (const { page } of ranked) {
      const note = { id: page.id, title: page.title || page.id, kind: page.kind, markdown: page.body,
        sourceRevision: wiki.sourceRevision, inputDigest: page.inputDigest }
      // Keep complete pages. A truncated quotation or omitted caveat is not an
      // equivalent explanation; a project can supply a finer-grained gather flow.
      if (bytes([...memory, note]) <= maximum) memory.push(note)
    }
  }
  const catalog = yield* Executable.Catalog
  const identity = (name: string) => {
    const entry = catalog.executables.find(entry => entry.descriptor.name === name)
    const digest = entry && Descriptor.executionDigest(entry.descriptor)
    if (!digest) throw new CodingError({ code: "unavailable", message: `Planning executable is unavailable or unverified: ${name}` })
    return digest
  }
  const checks = options.checks.filter(check => {
    const descriptor = catalog.executables.find(entry => entry.descriptor.name === check.flow)?.descriptor
    const generatedWiki = check.flow === "checks/wiki" || descriptor?.flows.includes("coding/WikiCheck") === true
    return options.wiki === true || !generatedWiki
  })
  if (options.checks.some(check => check.required && !checks.includes(check))) {
    return yield* failure("A required generated-Wiki check is configured while Wiki is disabled; explicitly update the operator policy or enable Wiki")
  }
  const definitions = yield* Effect.try({ try: () => ({
    implementation: options.implementation, implementationDigest: identity(options.implementation),
    checks: checks.map(check => ({ ...check, flowDigest: identity(check.flow) }))
  }), catch: error => error instanceof CodingError ? error : failure(String(error)) })
  const after = yield* native.read([], limit)
  if (before.operationId !== after.operationId || JSON.stringify(before.history) !== JSON.stringify(after.history)) {
    return yield* failure("Native history changed while gathering memory; gather a new coherent view")
  }
  const history = before.history.map(row => {
    if (row.kind !== "resolved") throw failure("Conflicted native history cannot be used to plan")
    return { changeId: row.changeId, commitId: row.commitId, treeId: row.treeId,
      operationId: row.operationId, parentCommitIds: row.parentCommitIds, description: row.description ?? "" }
  })
  // The planner asked humans to paste files it could have read. Attach the
  // request's own paths, the paths its chosen notes cite, and the repository
  // README, in that priority order, under the per-file and total caps.
  const reader = yield* sourceReader(options.repositoryPath, hostFilesystem)
  const named = extractPaths(input.prompt, input.feedback)
  const cited = extractPaths(...memory.map(note => note.markdown))
  const initial = yield* collectSources(reader, [...named, ...cited, ...(yield* repositoryContextPaths(reader))])
  // Follow one bounded layer of paths cited by existing project documents.
  // This gives a new repository useful code evidence without generating a Wiki.
  const collected = yield* collectSources(reader, [...initial.sources.map(source => source.path), ...initial.missing,
    ...extractPaths(...initial.sources.map(source => source.text))])
  const context = {
    head: before.head, history, memory, ...definitions, ...collected,
    memoryRevision: memoryRevision({ wiki: wikiDigest, history, memory, definitions,
      sources: collected.sources.map(({ digest, path }) => ({ path, digest })), missing: collected.missing })
  }
  // Attached file text carries its own per-file and total caps, so the budget
  // here still bounds the native history, the wiki notes and the definitions.
  if (bytes({ ...context, sources: [] }) > 128 * 1024) return yield* failure("Planning context exceeds 128 KiB; narrow the native history or wiki budget")
  return yield* Schema.decodeUnknownEffect(PlanningContext)(context).pipe(
    Effect.mapError(() => failure("Gathered planning context violates its native or catalog contract"))
  )
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : failure(
  "Planning memory is unavailable or source-stale: " + (error instanceof Error ? error.message : String(error))
)))

/** The caller supplies existing host services; no storage or platform is opened.
 * Explicit host filesystem injection survives native action context restoration.
 */
export const memoryLayer = (options: MemoryOptions, hostFilesystem?: FileSystem.FileSystem) => Layer.mergeAll(
  GatherContext.toLayer(input => gather(options, input, hostFilesystem)),
  VerifyContext.toLayer(({ context }) => Effect.gen(function*() {
    const jj = yield* Jj.Jj, native = yield* NativeCoding
    yield* jj.snapshot("coding planning freshness")
    const current = yield* native.read(context.history.map(row => row.changeId))
    const headDrift = driftOf(context.head, current.head)
    const drift = [
      ...(headDrift === undefined ? [] : [`head ${headDrift}`]),
      ...context.history.flatMap(row => {
        const reason = driftOf(row, current.revisions.find(value => value.changeId === row.changeId))
        return reason === undefined ? [] : [reason]
      })
    ]
    if (drift.length > 0) {
      // The paths are the whole diagnosis. The 2026-09-15 workspace failure was
      // the host's own `.flows/control.db` and `.flows/engine.db-wal` landing
      // inside the working copy it was planning against, and the run card said
      // only that native code had changed. `diff` is best effort: a plan must
      // still be refused when the adapter cannot explain why.
      const paths = current.head.kind === "resolved" && context.head.commitId !== current.head.commitId
        ? yield* jj.diff(context.head.commitId, current.head.commitId).pipe(
          Effect.map(changedPaths), Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>))
        )
        : []
      return yield* failure(staleRevisionMessage(drift, paths))
    }
    // A plan may not be finalized against file text the planner no longer sees.
    const stale = yield* staleSources(yield* sourceReader(options.repositoryPath, hostFilesystem),
      { sources: context.sources ?? [], missing: context.missing ?? [] })
    if (stale.length > 0) return yield* failure(`Attached source files changed during planning or clarification; gather and plan again: ${stale.join(", ")}`)
    // Every wiki note still explains exactly the source the plan is made against.
    const stalePages = yield* staleWikiNotes(options, context.memory, hostFilesystem)
    if (stalePages.length > 0) return yield* failure(`Wiki pages changed source during planning or clarification; gather and plan again: ${stalePages.join(", ")}`)
    return context
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : failure(
    "Planning context no longer matches current source: " + (error instanceof Error ? error.message : String(error))
  ))))
)
