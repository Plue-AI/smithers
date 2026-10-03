/**
 * The model-backed step that rewrites one unit, and the host it runs inside.
 *
 * Everything deterministic has already happened by the time this action runs:
 * the project has been scanned, the constructs inventoried, the mapping rows
 * and rewrite snippets chosen, the zod chains and MDX prompts translated where
 * the translation is mechanical, and the unit's own sources captured. What is
 * left is judgment — which of two shapes a `Loop` really is, what a fan-out was
 * for, where a decision belongs in the report — and that is what the agent is
 * asked for.
 *
 * The host it works inside is narrow on purpose. It offers the standard
 * filesystem flows over kernel-guarded services rooted at the
 * project, the mapping lookup, and a capability envelope that
 * grants the project and nothing else. A write to `.smithers/smithers.db` is
 * refused by the kernel rather than by a sentence in the prompt, and agent process execution is unavailable. The orchestrator verifies each
 * rewrite after the agent answers.
 *
 * @since 1.0.0-rc.0
 */

import * as AgentAction from "@smthrs/agent/AgentAction"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import { Action } from "@smthrs/flow"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Fs from "../internal/Fs.ts"
import type * as Inventory from "../Inventory.ts"
import * as Mapping from "../Mapping.ts"
import { io, MigrateError } from "../MigrateError.ts"
import * as Report from "../Report.ts"
import type * as Scan from "../Scan.ts"
import type * as Units from "../Units.ts"
import * as Checkpoint from "./Checkpoint.ts"
import * as Contract from "./Contract.ts"
import * as Options from "./Options.ts"

/**
 * What the agent hands back for one unit.
 *
 * `changedFiles` is the agent's own account of what it touched. It is not
 * trusted: the checkpoint diff is what the report records. The two are compared
 * so a unit that edited a file it never declared shows up as a finding rather
 * than as silence.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const UnitResult = Schema.Struct({
  unit: Schema.String,
  changedFiles: Schema.Array(Schema.String),
  decisions: Schema.Array(Report.Decision),
  unresolved: Schema.Array(Report.UnresolvedEntry),
  unsupported: Schema.Array(Report.UnsupportedEntry),
  notes: Schema.String
})

/**
 * What the agent hands back for one unit.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type UnitResult = typeof UnitResult.Type

/**
 * A unit as the plan carries it: everything {@link Contract.UnitBrief} has,
 * with the sources named rather than captured.
 *
 * The split is what keeps the captured-source rule honest across a run. The
 * outline is plan-time topology, so it has to be in the flow's payload; the
 * source text is what the files hold *when the unit starts*, and an earlier
 * unit may already have rewritten them. Capturing the text inside the unit's
 * own execution is the only way the agent is shown the file it is about to
 * edit rather than the file the run began with.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const UnitOutline = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["dependencies", "workflow", "integration", "project"]),
  root: Schema.String,
  sources: Schema.Array(Schema.String),
  targets: Schema.Array(Schema.String),
  constructs: Schema.Array(Contract.ConstructRow),
  mapping: Schema.Array(Contract.MappingRow),
  hints: Schema.Array(Contract.Hint),
  unsafe: Schema.Array(Schema.String),
  operatorDecisions: Schema.Array(Schema.String),
  runStatePaths: Schema.Array(Schema.String),
  approvedPackages: Schema.Array(Schema.String),
  commands: Contract.Commands,
  /**
   * The scanner's own warnings about this unit's sources, as one line each.
   *
   * They travel with the unit because a warning is the only thing the scanner
   * has to say about a file it could not classify, and a file it could not
   * classify is exactly the file an agent is most likely to guess at.
   */
  warnings: Schema.Array(Schema.String),
  /**
   * What the project's manifests said about the names that exist in both
   * trees. The deterministic checks read it to tell an old import from a new
   * one, so it has to travel with the unit.
   */
  specifiers: Schema.Struct({
    localFacade: Schema.optional(Schema.Boolean),
    oldScoped: Schema.optional(Schema.Array(Schema.String))
  }),
  /**
   * Whether a flow is supposed to exist by the time this unit verifies. It is
   * cross-unit knowledge — the dependency unit writes no flow, and a project
   * with no workflow at all never gets a `flows/` directory — so it is decided
   * where every unit is visible rather than inside one.
   */
  expectFlows: Schema.Boolean
})

/**
 * A unit as the plan carries it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type UnitOutline = typeof UnitOutline.Type

/**
 * The packages every migrated project may need whatever its constructs: the
 * authoring model, the runtime, the standard flows, and the test harness.
 */
const basePackages: ReadonlyArray<string> = [
  "@smthrs/agent",
  // A bound tool flow is a body-less `@smthrs/core` `Flow.make` signature,
  // which is what `FlowBinding.make({ flow, handler })` takes; a list without
  // it forbids the import a migrated `workflowTool` needs.
  "@smthrs/core",
  "@smthrs/engine",
  "@smthrs/flow",
  "@smthrs/flows",
  "@smthrs/patterns",
  "@smthrs/plan",
  "@smthrs/registry",
  "@smthrs/std",
  "@smthrs/testing",
  "@effect/vitest",
  "effect"
]

/**
 * The packages a unit is allowed to add. Nothing else may be installed, and
 * the prompt says so.
 *
 * The list is the base set plus every `@smthrs/*` package a mapping row names
 * as a target or a target module, derived from the table rather than
 * restated beside it: the prompt tells the agent to reach for the row's
 * module and, in the same breath, not to install anything off this list, so
 * the two have to agree or a guided rewrite of `smthrs/memory` is forbidden
 * from importing the package it is told to use.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const approvedPackages: ReadonlyArray<string> = [
  ...new Set([
    ...basePackages,
    ...Mapping.rows.flatMap((row) => `${row.target ?? ""} ${row.targetModule ?? ""}`.match(/@smthrs\/[a-z-]+/g) ?? [])
  ])
].sort()

const constructRow = (
  hit: Inventory.InventoryEntry
): typeof Contract.ConstructRow.Type => ({
  file: hit.file,
  line: hit.line,
  column: hit.column,
  construct: hit.construct,
  props: hit.props,
  class: Mapping.classify(hit)
})

const mappingRows = (
  unit: Units.UnitPlan
): ReadonlyArray<typeof Contract.MappingRow.Type> => {
  const bySnippet = new Map<string, string>()
  for (const hit of unit.constructs) {
    if (bySnippet.has(hit.construct)) continue
    const text = Mapping.snippet(hit)
    if (text !== undefined) bySnippet.set(hit.construct, text)
  }
  return unit.mapping.map((row) => {
    const text = bySnippet.get(row.construct)
    return {
      construct: row.construct,
      target: row.target,
      targetModule: row.targetModule,
      rule: row.rule,
      class: row.class,
      ...(text === undefined ? {} : { snippet: text })
    }
  })
}

const hintRows = (
  unit: Units.UnitPlan
): ReadonlyArray<typeof Contract.Hint.Type> => [
  ...unit.hints.zod.map((hint) => ({
    kind: "zod" as const,
    file: hint.file,
    name: hint.name,
    captured: hint.chain,
    ...(hint.schema === undefined ? {} : { translation: hint.schema }),
    ...(hint.reason === undefined ? {} : { note: hint.reason })
  })),
  ...unit.hints.prompt.map((hint) => ({
    kind: "prompt" as const,
    file: hint.file,
    name: hint.file,
    captured: hint.props.length === 0 ? "(no interpolations)" : hint.props.join(", "),
    ...(hint.template === undefined ? {} : { translation: hint.template }),
    ...(hint.classification === "jsx"
      ? { note: "This prompt imports or renders components, so its translation is yours to write." }
      : {})
  }))
]

/**
 * Every path that holds 0.x run state, which no unit may read, write, move,
 * or resume.
 *
 * Project-relative, except the gateway state files, which live outside the
 * project and stay absolute on purpose: the deny rules and the run-state
 * digests both take an absolute entry as it is, so the files that are really
 * on disk are the ones covered.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const runStatePaths = (result: Scan.ScanResult): ReadonlyArray<string> =>
  [
    ...result.runState.databases.map((database) => database.path),
    ...result.runState.stateDirs.map((entry) => entry.path),
    ...result.runState.gatewayState
  ].sort()

/**
 * Builds the plan-time outline of one unit.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const outline = (
  result: Scan.ScanResult,
  unit: Units.UnitPlan,
  options: Options.MigrateOptions,
  expectFlows = true
): UnitOutline => ({
  id: unit.id,
  kind: unit.kind,
  root: result.root,
  sources: [...unit.sources].sort(),
  targets: [...unit.targets].sort(),
  constructs: unit.constructs.map(constructRow),
  mapping: mappingRows(unit),
  hints: hintRows(unit),
  unsafe: [...unit.unsafe].sort(),
  operatorDecisions: operatorDecisionLines(unit),
  runStatePaths: runStatePaths(result),
  approvedPackages,
  warnings: warningLines(result, unit),
  expectFlows,
  specifiers: {
    ...(unit.specifiers.localFacade === undefined ? {} : { localFacade: unit.specifiers.localFacade }),
    ...(unit.specifiers.oldScoped === undefined ? {} : { oldScoped: unit.specifiers.oldScoped })
  },
  commands: {
    ...(unit.verification.install === undefined ? {} : { install: unit.verification.install }),
    ...(unit.verification.format === undefined ? {} : { format: unit.verification.format }),
    typecheck: unit.verification.typecheck,
    ...(unit.verification.test === undefined ? {} : { test: unit.verification.test }),
    flowsDir: options.layout?.flowsDir ?? Options.defaultFlowsDir
  }
})

/**
 * The scanner's warnings about the files this unit owns, newest rules first,
 * as one readable line each.
 */
const warningLines = (
  result: Scan.ScanResult,
  unit: Units.UnitPlan
): ReadonlyArray<string> => {
  const owned = new Set(unit.sources)
  return result.detection.warnings
    .filter((warning) => owned.has(warning.file))
    .map((warning) => `${warning.code}: ${warning.message}`)
    .sort()
}

const operatorDecisionLines = (
  unit: Units.UnitPlan
): ReadonlyArray<string> => {
  return unit.constructs
    .filter((hit) => Mapping.subscriptionAgents.includes(hit.construct))
    .map((hit) => `${hit.construct} at ${hit.file}:${hit.line}`)
    .filter((line, index, all) => all.indexOf(line) === index)
    .sort()
}

/**
 * Dotenv files are integration inventories, not model-visible file contents.
 * Match the scanner's entire `.env*` family, including nested files. Only
 * assignment names survive; values, comments and unrelated keys stay local.
 */
const sourceView = (file: string, text: string): string => {
  if (!/(^|\/)\.env[^/]*$/.test(file)) return text
  const names = new Set<string>()
  for (const match of text.matchAll(/^[ \t]*(?:export[ \t]+)?(SMITHERS_[A-Z0-9_]+)[ \t]*=/gm)) {
    names.add(match[1]!)
  }
  return [...names].sort().map((name) => `${name}=[REDACTED]`).join("\n")
}

/**
 * Reads the unit's sources as they are right now and returns the brief the
 * agent is given. Dotenv sources contain only sorted Smithers assignment
 * names with redacted values; original bytes remain in the host checkpoint.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const capture = (
  outlined: UnitOutline,
  checkpoint: Checkpoint.Ref,
  current = false
): Effect.Effect<Contract.UnitBrief, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // Two answers, and which one is right depends on who is asking.
    //
    // The first round is shown the checkpoint's copy. That is what makes the
    // captured-source rule exact for ordinary sources: the prompt, checks and
    // restore use one set of bytes. Dotenv is the exception: only its redacted
    // inventory enters the brief, while checks and restore keep the originals.
    // A replay of that round decodes the same sanitized prompt.
    //
    // A repair round is shown the disk. The round before it edited these files,
    // and a prompt that showed the original would ask for the same rewrite
    // again and describe a failure the agent cannot see the cause of.
    const recorded = yield* Checkpoint.sources(checkpoint)
    const sources: Array<typeof Contract.SourceFile.Type> = []
    // A file that is gone is shown from the checkpoint; a file that cannot be
    // read is a failure, because a prompt built from stale text would ask for
    // a rewrite of a file the agent is not looking at.
    const fromDisk = (file: string) =>
      Fs.readIfExists(path.join(outlined.root, ...file.split("/")), file).pipe(
        Effect.provideService(FileSystem.FileSystem, fs)
      )
    for (const file of outlined.sources) {
      const onDisk = current ? yield* fromDisk(file) : undefined
      if (onDisk !== undefined) {
        sources.push({ path: file, text: onDisk })
        continue
      }
      const captured = recorded.get(file)
      if (captured !== undefined) {
        sources.push({ path: file, text: captured })
        continue
      }
      const text = yield* fromDisk(file)
      if (text !== undefined) sources.push({ path: file, text })
    }
    return {
      ...outlined,
      sources: sources.map(({ path, text }) => ({ path, text: sourceView(path, text) }))
    }
  }).pipe(Effect.mapError(io(`could not capture the sources of unit "${outlined.id}"`)))

/**
 * The capture step. Sealed: reading the unit's own files has no effect the
 * project can observe, and a replay wants the text the attempt it is replaying
 * saw.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const captureAction = Action.make("smithers/migrate-v1/Capture", {
  payload: {
    outline: UnitOutline,
    checkpoint: Checkpoint.Ref,
    /**
     * Whether to read the sources from disk rather than from the checkpoint's
     * copy. Repair rounds pass `true`; the first round does not.
     *
     * It is also what keeps the two captures apart in the journal. A sealed
     * action with the same payload is the same call, so without this a repair
     * round's capture would be answered by the first round's recorded result.
     */
    current: Schema.optional(Schema.Boolean)
  },
  success: Contract.UnitBrief,
  error: MigrateError
})

/**
 * The capture step's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const captureLayer = captureAction.toLayer(({ checkpoint, current, outline }) =>
  capture(outline, checkpoint, current === true)
)

/**
 * The seat every model-backed migration step declares.
 *
 * It is a role, not a model: the resolver owns the vocabulary, so a host binds
 * `migrate` to whatever the operator chose with `--seat`. No model id appears
 * anywhere in this package — not in the resolver, not in the tests, and not in
 * the worked pairs the prompt teaches, whose one seat is a placeholder rather
 * than the literal the example it was copied from carries.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const seat = "migrate"

/**
 * How many cell frames one unit gets before the step fails.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const maxFrames = 60

/**
 * The sandbox budget every migration cell runs under.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const limits: Sandbox.Limits = {
  calls: 400,
  memoryBytes: 256 * 1024 * 1024,
  steps: 50_000_000,
  callMs: 900_000,
  totalMs: 3_600_000
}

/**
 * The transform step: one unit in, one {@link UnitResult} out.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const action = AgentAction.make("smithers/migrate-v1/Transform", {
  payload: { unit: Contract.UnitBrief },
  output: UnitResult,
  seat,
  system: [Contract.text],
  prompt: ({ unit }) => Contract.unitPrompt(unit),
  corrections: 1,
  maxFrames
})

/**
 * The transform step's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = action.layer

/**
 * The capability envelope one unit runs under.
 *
 * It reads wider than the confinement, and that is not a mistake. An envelope
 * has to *subsume* what a bound flow declares, and `@smthrs/std` declares
 * `fs:read:/**` and `fs:write:/**` — the declarations of a
 * capability whose real bounds the host decides. An envelope narrowed to the
 * project root refuses `write` outright, which is how the first version of
 * this module failed: the agent was offered an editing flow it could never
 * call, and answered that it had migrated a file it had not touched.
 *
 * The confinement is underneath, where it can be enforced rather than
 * declared: `Workspace.layer(root)` pins the root, the kernel filesystem
 * resolves and executes every operation relative to that descriptor, and the
 * grant store in {@link module:Layers.rules} denies every write under a 0.x
 * run-state path. A pattern string cannot express "everything but
 * these"; a rule set can, and the kernel asks it on every operation.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const envelope = (): ReadonlyArray<string> => [
  "fs:read:/**",
  "fs:write:/**",
  "model:call:typesafe-ai/jev"
]

/**
 * The mapping lookup, as one ordinary flow.
 *
 * @category flows
 * @since 1.0.0-rc.0
 */
export const mappingFlow = {
  capabilities: [],
  name: "migrate/mapping",
  description:
    "Look up the migration mapping row for one 0.x construct: its 1.0 target, the module the target lives in, the translation rule, and the class the scanner gave it.",
  input: Schema.Struct({ construct: Schema.String }),
  output: Contract.MappingRow,
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
} as const

/**
 * The mapping table this package binds into the agent's catalog.
 *
 * A binding rather than a prompt section because the mapping table is large and
 * the agent should pay for the row it wants, not for all of them.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const bindings = (): Effect.Effect<FlowBinding.Source> =>
  Effect.succeed(FlowBinding.source("migrate", [
    FlowBinding.make({
      flow: mappingFlow,
      handler: (input) => {
        const row = Mapping.byConstruct(input.construct)
        return Effect.succeed(
          row === undefined
            ? {
              construct: input.construct,
              target: null,
              targetModule: null,
              rule: "no mapping row",
              class: "unsafe" as const
            }
            : {
              construct: row.construct,
              target: row.target,
              targetModule: row.targetModule,
              rule: row.rule,
              class: row.class
            }
        )
      }
    })
  ]))

/**
 * The host every model-backed migration step shares: the standard filesystem
 * flows over the services the caller guarded, the `jev` flow over
 * the host's judge, the mapping lookup, the capability envelope,
 * and the sandbox budget. Every step is judged: a migration host always holds
 * a real judge.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const hostLayer = (options: {
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
} = {}): Layer.Layer<
  AgentAction.Host,
  never,
  FileSystem.FileSystem | Path.Path | Evaluator.Evaluator
> => {
  const stance = AgentAction.supervisorStance(options.environment ?? {})
  return Layer.effect(
    AgentAction.Host,
    Effect.gen(function*() {
      const filesystem = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const judge = yield* Effect.context<Evaluator.Evaluator>()
      const registry = yield* Registry.Registry
      const own = yield* bindings()
      return AgentAction.makeHost({
        registry,
        limits,
        flows: [
          StandardFlows.filesystem(filesystem),
          StandardFlows.jev(judge),
          own
        ],
        capabilityEnvelope: AgentSession.patterns(envelope()),
        maxFrames,
        // A migration always runs with a real judge: the host refuses to
        // compose without one.
        judged: true,
        supervisor: { stance }
      })
    })
  ).pipe(Layer.provide(Registry.layerFromDescriptors([])))
}
