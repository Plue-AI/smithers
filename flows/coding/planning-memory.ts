/** Default gathering uses native JJ history and what `memory` selects for the
 * request: authorized wiki revisions selected by shared preflight and files
 * from the existing README-guided Jev walk. Generated pages participate only
 * while their inputs remain fresh. Projects can replace GatherContext's action
 * layer with their own workflow.
 */
import * as Memory from "@smthrs/agent/Memory"
import * as Digest from "@smthrs/core/Digest"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, FileSystem, Layer, Schema } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { operations as wikiOperations } from "../wiki/operations.ts"
import type { PageSpec } from "../wiki/schema.ts"
import { acceptedLearnings, type Learning } from "./learnings.ts"
import { NativeCoding } from "./native.ts"
import { collectSources, extractPaths, reader as sourceReader, staleSources } from "./planning-sources.ts"
import {
  changedPaths,
  driftOf,
  GatherContext,
  memoryRevision,
  PlanningContext,
  type PlanningInput,
  staleRevisionMessage,
  VerifyContext
} from "./planning.ts"
import { type Check, CodingError } from "./schema.ts"

export interface MemoryOptions {
  readonly repositoryPath: string
  readonly wikiCitations?: boolean
  readonly wikiProvider?: PlanningWikiProvider
  readonly wiki?: boolean
  readonly wikiOutput?: string
  readonly pages?: ReadonlyArray<PageSpec>
  readonly implementation: string
  readonly checks: ReadonlyArray<Omit<Check, "flowDigest">>
  readonly historyLimit?: number
  readonly maxMemoryBytes?: number
}
const failure = (message: string) => new CodingError({ code: "stale_revision", message })
/**
 * The refusal of a gathered context that breaks its own schema, with the
 * schema's reason. Coded `execution`, a host fault no replan fixes, not
 * `stale_revision`: the 2026-10-05 walk's one-check repository failed here
 * three times as "stale" and its card said only Failed.
 */
export const contractFailure = (reason: string) =>
  new CodingError({
    code: "execution",
    message: `Gathered planning context violates its contract: ${reason.replace(/\s+/g, " ").trim().slice(0, 1_000)}`
  })
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

type WikiPage = {
  readonly id: string
  readonly title: string
  readonly kind: "current" | "intent"
  readonly body: string
  readonly inputDigest: string
}

/** The pages whose inputs still hash to this source under this host's own catalog. */
const freshWikiPages = (
  options: MemoryOptions,
  pages: ReadonlyArray<WikiPage>,
  hostFilesystem?: FileSystem.FileSystem
) =>
  Effect.gen(function*() {
    const ops = wikiOperations({
      root: options.repositoryPath,
      output: options.wikiOutput ?? options.repositoryPath,
      fs: hostFilesystem
    })
    const fresh: Array<WikiPage> = []
    for (const page of pages) {
      const spec = options.pages?.find((spec) => spec.id === page.id)
      if (spec === undefined) continue
      const current = yield* Effect.result(ops.collect(spec))
      if (current._tag === "Success" && current.success.inputDigest === page.inputDigest) fresh.push(page)
    }
    return fresh
  })

/** Trusted host adapter: the shared preflight selector and authorized relay
 * reads. No adapter is installed by default; repository code cannot authorize
 * itself or substitute local snapshots. Calls belong to the recorded gather.
 */
export interface PlanningWikiProvider {
  readonly authorize: () => Effect.Effect<void, CodingError>
  readonly select: (
    request: { readonly prompt: string; readonly kinds: readonly ["wiki"] }
  ) => Effect.Effect<ReadonlyArray<{ readonly slug: string }>, CodingError>
  readonly read: (slug: string) => Effect.Effect<{
    readonly pageID: string
    readonly slug: string
    readonly revision: number
    readonly digest: string
    readonly title: string
    readonly markdown: string
    readonly generated?: { readonly id: string; readonly inputDigest: string; readonly sourceRevision: string }
  }, CodingError>
}

/** API reads capture identity and bytes together, after wiki-only selection.
 * The trusted authorizer refuses missing config/evidence/selector providers,
 * disabled wiki and run scopes; it refuses non-machine dispatch with
 * isolation_required. Nothing here opens a host process or a pointer file.
 */
export const wikiMemory = (
  options: MemoryOptions,
  input: typeof PlanningInput.Type,
  hostFilesystem?: FileSystem.FileSystem
) =>
  Effect.gen(function*() {
    const provider = options.wikiProvider
    if (!provider) {
      return yield* new CodingError({
        code: "unavailable",
        message: "Authorized planning wiki provider is unavailable"
      })
    }
    yield* provider.authorize()
    // An empty pinned declaration is valid for an authored-only vault.
    if (options.pages === undefined) {
      return yield* new CodingError({
        code: "unavailable",
        message: "Pinned generated-page declaration is unavailable"
      })
    }
    const selected = yield* provider.select({ prompt: input.prompt, kinds: ["wiki"] })
    const pages: Array<
      WikiPage & {
        readonly sourceRevision: string
        readonly generated: boolean
        readonly citation: NonNullable<typeof PlanningContext.Type["wikiCitations"]>[number]
      }
    > = []
    for (const { slug } of selected) {
      if (pages.some((page) => page.citation.slug === slug)) continue
      const page = yield* provider.read(slug)
      if (
        !page.markdown || pages.length >= 30 || page.slug !== slug || !page.pageID ||
        !Number.isSafeInteger(page.revision) || page.revision < 1 ||
        !/^[0-9a-f]{64}$/.test(page.digest) || Digest.digest(page.markdown) !== page.digest
      ) continue
      const generated = page.generated
      const captured = {
        id: generated?.id ?? page.pageID,
        title: page.title,
        kind: generated
          ? (options.pages.find((spec) => spec.id === generated.id)?.kind ?? "current")
          : "current" as const,
        body: page.markdown,
        inputDigest: generated?.inputDigest ?? page.digest,
        sourceRevision: generated?.sourceRevision ?? `wiki:${page.pageID}:${page.revision}`,
        generated: generated !== undefined,
        citation: { slug, pageID: page.pageID, revision: page.revision, digest: page.digest }
      }
      if (generated && !(yield* freshWikiPages(options, [captured], hostFilesystem)).length) continue
      pages.push(captured)
    }
    return { pages, digest: Digest.digest(Digest.canonical(pages.map((page) => page.citation))) }
  })

/** The notes whose page inputs no longer hash to this source. */
export const staleWikiNotes = (
  options: MemoryOptions,
  notes: typeof PlanningContext.Type["memory"],
  hostFilesystem?: FileSystem.FileSystem
) =>
  Effect.gen(function*() {
    notes = notes.filter((note) => note.generated !== false)
    if (notes.length === 0) return []
    const pages = notes.map((note) => ({
      id: note.id,
      title: note.title,
      kind: note.kind,
      body: note.markdown,
      inputDigest: note.inputDigest
    }))
    const fresh = new Set((yield* freshWikiPages(options, pages, hostFilesystem)).map((page) => page.id))
    return notes.filter((note) => !fresh.has(note.id)).map((note) => note.id)
  })

/** Shared preflight selects wiki revisions; `memory` selects files, so
 * the gather is nondeterministic: `GatherContext` is a nondeterministic action
 * whose context the journal records and replays. A selection Jev did not judge
 * (unreachable, timed out, or no judge bound) fails `unavailable` rather than
 * planning with the seeds alone. */
export const gather = (
  options: MemoryOptions,
  input: typeof PlanningInput.Type,
  hostFilesystem?: FileSystem.FileSystem
) =>
  Effect.gen(function*() {
    const limit = options.historyLimit ?? 100, maximum = options.maxMemoryBytes ?? 48 * 1024
    if (
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maximum) || maximum < 1024 ||
      maximum > 90 * 1024
    ) {
      return yield* failure("Planning memory requires historyLimit 1..100 and maxMemoryBytes 1024..92160")
    }
    const wiki = options.wikiCitations === true
      ? yield* wikiMemory(options, input, hostFilesystem)
      : { pages: [], digest: null }
    const native = yield* NativeCoding, jj = yield* Jj.Jj
    // The configured Jj captures current bytes in the SAME native atom. It never
    // opens a new change merely because memory needs an immutable code identity.
    yield* jj.snapshot("coding planning memory")
    const before = yield* native.read([], limit)
    if (
      !before.history?.length || before.history.some((row) => row.kind !== "resolved") ||
      before.head.kind !== "resolved"
    ) {
      return yield* failure(
        "Planning requires bounded resolved native history; inspect conflicts or update the installed adapter"
      )
    }
    const wikiDigest = wiki?.digest ?? null
    // File selection retains the existing README-guided Jev walk. Wiki
    // selection is already captured by the shared preflight provider.
    const selection = yield* Memory.select(
      { task: `${input.prompt}\n${input.feedback}`, sources: ["repo"], maxBytes: Memory.maxMaxBytes },
      {
        root: options.repositoryPath,
        pages: []
      }
    ).pipe(Effect.mapError((error) => failure(`Planning memory could not be selected: ${error.message}`)))
    // Unjudged, `memory` keeps only the request's own paths and drops every
    // wiki page and walked file. Planning on that would be a silent exclusion
    // neither the planner nor the reviewer can see.
    if (selection.unjudged !== undefined) {
      return yield* new CodingError({
        code: "unavailable",
        message: `Jev could not select planning memory (${selection.unjudged.reason}: ${selection.unjudged.detail})`
      })
    }
    const memory: Array<typeof PlanningContext.Type["memory"][number]> = []
    const wikiCitations: NonNullable<typeof PlanningContext.Type["wikiCitations"]>[number][] = []
    for (const page of wiki.pages) {
      const note = {
        id: page.id,
        title: page.title || page.id,
        kind: page.kind,
        markdown: page.body,
        sourceRevision: page.sourceRevision,
        inputDigest: page.inputDigest,
        generated: page.generated
      }
      if (bytes([...memory, note]) <= maximum) {
        memory.push(note)
        wikiCitations.push(page.citation)
      }
    }
    // Accepted learnings share the memory budget; the newest are kept when it runs out.
    const accepted = yield* acceptedLearnings.pipe(Effect.mapError((error) =>
      new CodingError({ code: "unavailable", message: `Accepted coding learnings are unreadable: ${error.message}` })
    ))
    const learnings: Array<Learning> = []
    for (const learning of accepted.toReversed()) {
      if (bytes([...memory, ...learnings, learning]) <= maximum) {
        learnings.unshift(learning)
      }
    }
    const catalog = yield* Executable.Catalog
    const identity = (name: string) => {
      const entry = catalog.executables.find((entry) =>
        entry.descriptor.name === name
      )
      const digest = entry && Descriptor.executionDigest(entry.descriptor)
      if (!digest) {
        throw new CodingError({
          code: "unavailable",
          message: `Planning executable is unavailable or unverified: ${name}`
        })
      }
      return digest
    }
    const checks = options.checks.filter((check) => {
      const descriptor = catalog.executables.find((entry) => entry.descriptor.name === check.flow)?.descriptor
      const generatedWiki = check.flow === "checks/wiki" || descriptor?.flows.includes("coding/WikiCheck") === true
      return options.wiki === true || !generatedWiki
    })
    if (options.checks.some((check) => check.required && !checks.includes(check))) {
      return yield* failure(
        "A required generated-Wiki check is configured while Wiki is disabled; explicitly update the operator policy or enable Wiki"
      )
    }
    const definitions = yield* Effect.try({
      try: () => ({
        implementation: options.implementation,
        implementationDigest: identity(options.implementation),
        checks: checks.map((check) => ({ ...check, flowDigest: identity(check.flow) }))
      }),
      catch: (error) => error instanceof CodingError ? error : failure(String(error))
    })
    const after = yield* native.read([], limit)
    if (before.operationId !== after.operationId || JSON.stringify(before.history) !== JSON.stringify(after.history)) {
      return yield* failure("Native history changed while gathering memory; gather a new coherent view")
    }
    const history = before.history.map((row) => {
      if (row.kind !== "resolved") throw failure("Conflicted native history cannot be used to plan")
      return {
        changeId: row.changeId,
        commitId: row.commitId,
        treeId: row.treeId,
        operationId: row.operationId,
        parentCommitIds: row.parentCommitIds,
        description: row.description ?? ""
      }
    })
    // The planner asked humans to paste files it could have read. Attach the
    // request's own paths, then the files `memory` chose, in that priority
    // order, under the per-file and total caps.
    const reader = yield* sourceReader(options.repositoryPath, hostFilesystem)
    const collected = yield* collectSources(reader, [
      ...extractPaths(input.prompt, input.feedback),
      ...selection.needed.filter((item) => item.kind === "file").map((item) => item.id)
    ])
    const context = {
      head: before.head,
      history,
      memory,
      ...(options.wikiCitations === true ? { wikiCitations } : {}),
      ...(learnings.length ? { learnings } : {}),
      ...definitions,
      ...collected,
      memoryRevision: memoryRevision({
        wiki: wikiDigest,
        history,
        memory,
        wikiCitations,
        ...(learnings.length ? { learnings } : {}),
        definitions,
        sources: collected.sources.map(({ digest, path }) => ({ path, digest })),
        missing: collected.missing
      })
    }
    // Attached file text carries its own per-file and total caps, so the budget
    // here still bounds the native history, the wiki notes and the definitions.
    if (bytes({ ...context, sources: [] }) > 128 * 1024) {
      return yield* failure("Planning context exceeds 128 KiB; narrow the native history or wiki budget")
    }
    // A context this host gathered that its own contract refuses is a host
    // fault, not a source that moved: name the field that broke the contract.
    return yield* Schema.decodeUnknownEffect(PlanningContext)(context).pipe(
      Effect.mapError((error) => contractFailure(error.message))
    )
  }).pipe(Effect.mapError((error) =>
    error instanceof CodingError ? error : failure(
      "Planning memory is unavailable or source-stale: " + (error instanceof Error ? error.message : String(error))
    )
  ))

/** The caller supplies existing host services; no storage or platform is opened.
 * Explicit host filesystem injection survives native action context restoration.
 */
export const memoryLayer = (options: MemoryOptions, hostFilesystem?: FileSystem.FileSystem) =>
  Layer.mergeAll(
    GatherContext.toLayer((input) => gather(options, input, hostFilesystem)),
    VerifyContext.toLayer(({ context }) =>
      Effect.gen(function*() {
        const jj = yield* Jj.Jj, native = yield* NativeCoding
        yield* jj.snapshot("coding planning freshness")
        const current = yield* native.read(context.history.map((row) => row.changeId))
        const headDrift = driftOf(context.head, current.head)
        const drift = [
          ...(headDrift === undefined ? [] : [`head ${headDrift}`]),
          ...context.history.flatMap((row) => {
            const reason = driftOf(row, current.revisions.find((value) => value.changeId === row.changeId))
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
              Effect.map(changedPaths),
              Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>))
            )
            : []
          return yield* failure(staleRevisionMessage(drift, paths))
        }
        // A plan may not be finalized against file text the planner no longer sees.
        const stale = yield* staleSources(yield* sourceReader(options.repositoryPath, hostFilesystem), {
          sources: context.sources ?? [],
          missing: context.missing ?? []
        })
        if (stale.length > 0) {
          return yield* failure(
            `Attached source files changed during planning or clarification; gather and plan again: ${stale.join(", ")}`
          )
        }
        // Every wiki note still explains exactly the source the plan is made against.
        const stalePages = yield* staleWikiNotes(options, context.memory, hostFilesystem)
        if (stalePages.length > 0) {
          return yield* failure(
            `Wiki pages changed source during planning or clarification; gather and plan again: ${
              stalePages.join(", ")
            }`
          )
        }
        return context
      }).pipe(Effect.mapError((error) =>
        error instanceof CodingError ? error : failure(
          "Planning context no longer matches current source: " +
            (error instanceof Error ? error.message : String(error))
        )
      ))
    )
  )
