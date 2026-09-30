/**
 * The promote tool: turn the script the agent just ran into a saved flow.
 *
 * `flows/show-script` hands the model its own current turn back — the source of
 * every cell it executed, in order — plus the house rules a saved flow has to
 * follow and the file template to fill in. `flows/write-flow` takes the three
 * files that come back and writes them through a {@link FlowStore}.
 *
 * `flows/show-script` reads the harness's `CellHistory`; the Durable Object
 * `FlowStore` lives here.
 */
import { isRouteSegment } from "@smthrs/create-app/app"
import * as Flow from "@smthrs/core/Flow"
import * as CellHistory from "@smthrs/harness/CellHistory"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as ts from "typescript"
import type { FlowSummary } from "../src/api.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The one failure either binding reports to a cell. */
export class PromoteError extends Schema.TaggedError<PromoteError>()("aomi/tools/PromoteError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

// ---------------------------------------------------------------------------
// FlowStore
// ---------------------------------------------------------------------------

/**
 * Where a saved flow's files land.
 *
 * The app root writes into the session's Durable Object (`worker/FlowStore.ts`)
 * so a flow saved in the browser survives without a filesystem. Upstream ships
 * the filesystem implementation of the same interface.
 */
export interface FlowStoreService {
  readonly write: (
    id: string,
    files: Record<string, string>,
    description?: string
  ) => Effect.Effect<{ readonly files: ReadonlyArray<string> }, PromoteError>
  readonly list: () => Effect.Effect<ReadonlyArray<FlowSummary>, PromoteError>
}

/** Service tag for saved-flow storage. */
export class FlowStore extends Context.Service<FlowStore, FlowStoreService>()("aomi/tools/FlowStore") {}

/**
 * An in-memory store over `written`, keyed by path.
 *
 * Good enough for a test and for the milestone-1 composition; it forgets
 * everything when the isolate goes away, which is exactly why the Worker binds
 * the Durable Object one instead.
 */
export const makeMemoryStore = (written: Map<string, string> = new Map()): FlowStoreService =>
  FlowStore.of({
    write: (_id, files) =>
      Effect.sync(() => {
        for (const [path, source] of Object.entries(files)) written.set(path, source)
        return { files: Object.keys(files) }
      }),
    list: () => Effect.succeed([])
  })

/** A store that accepts nothing. */
export const makeNoopStore = (overrides: Partial<FlowStoreService> = {}): FlowStoreService => {
  const unavailable = (method: string) =>
    Effect.fail(
      new PromoteError({ message: `FlowStore.${method} is unavailable in this composition; no flow was saved.` })
    )
  return FlowStore.of({
    write: () => unavailable("write"),
    list: () => unavailable("list"),
    ...overrides
  })
}

/** Provides the in-memory store. */
export const layerMemoryStore = (written: Map<string, string> = new Map()): Layer.Layer<FlowStore> =>
  Layer.succeed(FlowStore)(makeMemoryStore(written))

/** Provides a store that refuses every call with a message the model can read. */
export const layerNoopStore = (overrides: Partial<FlowStoreService> = {}): Layer.Layer<FlowStore> =>
  Layer.sync(FlowStore)(() => makeNoopStore(overrides))

// ---------------------------------------------------------------------------
// The house rules and the file template
// ---------------------------------------------------------------------------

/**
 * What a saved flow has to get right, in the order it matters.
 *
 * This text is teaching, not documentation: the model reads it once, then
 * writes three files. Every line names a decision it is about to make.
 */
export const bestPractices = [
  "Inputs are idempotent. A saved flow runs again on a payload, so every value the script read from the conversation becomes a payload field. Nothing is hardcoded from this turn.",
  "No secrets in the source. Keys, tokens, and signed URLs come from the host, never from the flow file.",
  "One ctx.call per boundary. Each call is separately journaled and replayed, so do not batch two chain reads into one call or wrap a call in a retry loop the engine already owns.",
  "The output is typed. Declare a Schema.Struct for what the flow returns and fill every field; a caller must never parse prose.",
  "The e2e test is fixture-cached. Write flow.e2e.ts with cachedModelTest against a recorded fixture so the test runs offline; re-record with SMTHRS_RECORD=1."
].join("\n")

/** The flow.ts skeleton `flows/write-flow` expects back, filled in. */
export const flowTemplate = `import { Flow } from "@smthrs/flow"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Schema from "effect/Schema"

export default Flow.make("<flow-id>", {
  description: "<one line the flow list shows>",
  payload: { /* every value this script read from the conversation */ },
  success: Schema.Struct({ /* typed fields, no prose blobs */ }),
  error: AgentAction.AgentFailure,
  prompt: (payload) => \`<the instruction, built from payload>\`,
  system: ["<anything the root AGENT.ts does not already teach>"]
})
`

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ShowScriptInput = Schema.Struct({
  bestPractices: Schema.optionalKey(
    Schema.String.annotate({ description: "Extra guidance to append after the house rules" })
  )
})
export type ShowScriptInput = typeof ShowScriptInput.Type

export const ShowScriptOutput = Schema.Struct({
  cells: Schema.Array(Schema.Struct({
    ordinal: Schema.Number.annotate({ description: "Zero-based execution order within this turn" }),
    source: Schema.String.annotate({ description: "The cell's JavaScript, as it ran" })
  })),
  bestPractices: Schema.String.annotate({ description: "House rules a saved flow has to follow" }),
  template: Schema.String.annotate({ description: "The flow.ts skeleton to fill in" })
})
export type ShowScriptOutput = typeof ShowScriptOutput.Type

export const WriteFlowInput = Schema.Struct({
  id: Schema.String.annotate({
    description: "Flow id and directory name; lowercase letters, digits, and hyphens, starting with a letter"
  }),
  description: Schema.String.annotate({ description: "One line the flow list shows" }),
  flowSource: Schema.String.annotate({ description: "Complete flow.ts source" }),
  testSource: Schema.String.annotate({ description: "Complete flow.e2e.ts source, using cachedModelTest" }),
  fixtureJson: Schema.String.annotate({ description: "Recorded model fixture as JSON text" })
})
export type WriteFlowInput = typeof WriteFlowInput.Type

export const WriteFlowOutput = Schema.Struct({
  files: Schema.Array(Schema.String).annotate({ description: "Paths written, app-root relative" })
})
export type WriteFlowOutput = typeof WriteFlowOutput.Type

// ---------------------------------------------------------------------------
// Flow declarations
// ---------------------------------------------------------------------------

const showScriptFlow = Flow.make({
  name: "flows/show-script",
  description:
    "Return the source of every cell this turn has executed, plus the house rules and the file template a saved flow uses. Call it before flows/write-flow.",
  input: ShowScriptInput,
  output: ShowScriptOutput,
  capabilities: [],
  effects: undefined
})

/** The authority `flows/write-flow` needs: writing files under `/flows/`. */
export const writeFlowCapabilities = ["fs:write:/flows/**"]

const writeFlowFlow = Flow.make({
  name: "flows/write-flow",
  description:
    "Save a flow: writes flow.ts, flow.e2e.ts, and its fixture under flows/<id>/. The id must be lowercase letters, digits, and hyphens.",
  input: WriteFlowInput,
  output: WriteFlowOutput,
  // Saving creates flow files the app routes, so the turn's grant must
  // include this write; a TOOLS.ts that omits it refuses the call.
  capabilities: writeFlowCapabilities,
  effects: undefined
})

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Check self-contained TypeScript diagnostics without touching the store.
 * The Worker has no project filesystem: external imports cannot be resolved
 * here, so their module-resolution diagnostics are left to the app build.
 */
const typecheckFlow = (id: string, source: string): string | undefined => {
  const path = `flows/${id}/flow.ts`
  const options: ts.CompilerOptions = {
    noEmit: true,
    noLib: true,
    noResolve: true,
    strict: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext
  }
  const file = ts.createSourceFile(path, source, options.target!, true)
  const host: ts.CompilerHost = {
    getSourceFile: (name) => name === path ? file : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === path,
    readFile: (name) => name === path ? source : undefined,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n"
  }
  const program = ts.createProgram([path], options, host)
  const diagnostic = ts.getPreEmitDiagnostics(program, file)
    .find((entry) => entry.file === file && entry.code !== 2307 && entry.code !== 2792)
  if (diagnostic === undefined) return undefined
  const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
  return `${path}:${(position?.line ?? 0) + 1}:${(position?.character ?? 0) + 1} TS${diagnostic.code}: ${message}`
}

const filesFor = (input: WriteFlowInput): Record<string, string> => ({
  [`flows/${input.id}/flow.ts`]: input.flowSource,
  [`flows/${input.id}/flow.e2e.ts`]: input.testSource,
  [`flows/${input.id}/fixtures/${input.id}.json`]: input.fixtureJson
})

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/** The promote flows, bound to the history and store the host built. */
export const promoteSource = (services: Context.Context<CellHistory.CellHistory | FlowStore>): FlowBinding.Source =>
  FlowBinding.source("flows", [
    FlowBinding.provide(
      FlowBinding.make({
        flow: showScriptFlow,
        handler: (input) =>
          Effect.gen(function*() {
            const history = yield* CellHistory.CellHistory
            const cells = yield* history.cells()
            const extra = input.bestPractices
            return {
              cells: cells.map((cell) => ({ ordinal: cell.ordinal, source: cell.source })),
              bestPractices: extra === undefined ? bestPractices : `${bestPractices}\n${extra}`,
              template: flowTemplate
            }
          })
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: writeFlowFlow,
        publicError: (error: PromoteError) => error.message,
        handler: (input) =>
          Effect.gen(function*() {
            // The router's own rule, imported rather than restated: a saved
            // flow whose id this accepts is a flow `pnpm routes` will route.
            // One segment, so `filesFor` writes `flows/<id>/flow.ts` and not a
            // nested tree.
            if (!isRouteSegment(input.id)) {
              return yield* Effect.fail(
                new PromoteError({
                  message:
                    `"${input.id}" is not a routable flow id. Use lowercase letters, digits, and hyphens, starting with a letter, then reissue flows/write-flow.`
                })
              )
            }
            const diagnostic = typecheckFlow(input.id, input.flowSource)
            if (diagnostic !== undefined) {
              return yield* Effect.fail(new PromoteError({
                message: `Flow source failed typecheck: ${diagnostic}. Fix flowSource and reissue flows/write-flow; no files were saved.`
              }))
            }
            const store = yield* FlowStore
            const written = yield* store.write(input.id, filesFor(input), input.description)
            return { files: written.files }
          })
      }),
      services
    )
  ])

/**
 * The source TOOLS.ts composes: an empty cell history and an in-memory store.
 * A Worker turn replaces it with {@link sessionSource}.
 */
export const promote: FlowBinding.Source = promoteSource(
  Context.add(Context.make(CellHistory.CellHistory, CellHistory.makeNoop()), FlowStore, makeMemoryStore())
)

/** The half of a session `flows/write-flow` writes through. */
export interface SessionFlows {
  readonly writeFlow: (
    id: string,
    description: string,
    files: Record<string, string>
  ) => { readonly files: ReadonlyArray<string> }
  readonly listFlows: () => ReadonlyArray<FlowSummary>
}

/**
 * The source a Worker turn binds: `flows/show-script` reads `cells`, the array
 * the turn appends each executed cell to, and `flows/write-flow` saves into
 * the session's Durable Object.
 */
export const sessionSource = (
  session: SessionFlows,
  cells: ReadonlyArray<CellHistory.ExecutedCell>
): FlowBinding.Source =>
  promoteSource(
    Context.add(
      Context.make(CellHistory.CellHistory, CellHistory.makeNoop({ cells: () => Effect.sync(() => [...cells]) })),
      FlowStore,
      FlowStore.of({
        write: (id, files, description) =>
          Effect.try({
            try: () => session.writeFlow(id, description ?? id, files),
            catch: (cause) => new PromoteError({ message: `Saving flow "${id}" failed; retry flows/write-flow.`, cause })
          }),
        list: () => Effect.sync(() => session.listFlows())
      })
    )
  )
