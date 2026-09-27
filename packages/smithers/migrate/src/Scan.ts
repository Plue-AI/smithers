/**
 * The scan pipeline: detection, run state, inventory, mapping, hints, and the
 * unit plan, composed into one value, and the report that value renders to.
 *
 * `scan` is pure with respect to the project. It reads and returns; it never
 * writes, installs, evaluates project code, or opens a database for writing.
 * That is what makes `scan` and `plan` safe to run on a project the operator
 * has not decided about yet.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as Detect from "./Detect.ts"
import * as Sort from "./internal/Sort.ts"
import * as Ts from "./internal/Ts.ts"
import * as Inventory from "./Inventory.ts"
import * as Mapping from "./Mapping.ts"
import { make, type MigrateError } from "./MigrateError.ts"
import * as PromptHints from "./PromptHints.ts"
import * as Report from "./Report.ts"
import * as RunState from "./RunState.ts"
import * as Units from "./Units.ts"
import * as ZodSchemaHints from "./ZodSchemaHints.ts"

/**
 * Everything one scan found.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ScanResult {
  readonly root: string
  readonly detection: Detect.Detection
  readonly runState: RunState.RunStateReport
  readonly inventory: ReadonlyArray<Inventory.InventoryEntry>
  readonly mapping: ReadonlyArray<Report.MappingDecision>
  readonly hints: {
    readonly zod: ReadonlyArray<ZodSchemaHints.ZodHint>
    readonly prompt: ReadonlyArray<PromptHints.PromptHint>
  }
  readonly units: ReadonlyArray<Units.UnitPlan>
}

/**
 * Options for {@link scan}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly ignore?: ReadonlyArray<string> | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly flowsDir?: string | undefined
  readonly commands?: Units.CommandOverrides | undefined
  readonly units?: ReadonlyArray<string> | undefined
  readonly runState?: RunState.Options | undefined
}

/** How much freedom each class leaves, so a merge can keep the least. */
const severity: Record<Mapping.MappingClass, number> = { automatic: 0, guided: 1, unsafe: 2 }

/**
 * The mapping decisions one inventory implies: one row per distinct construct,
 * with how many times it occurs, the worst class any occurrence has, and every
 * reason any of them gave.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const decisions = (
  hits: ReadonlyArray<Inventory.InventoryEntry>,
  parse: typeof Ts.parse = Ts.parse
): ReadonlyArray<Report.MappingDecision> => {
  const byConstruct = new Map<string, Report.MappingDecision>()
  const reasonsByConstruct = new Map<string, Array<string>>()
  for (const hit of hits) {
    const row = Mapping.byConstruct(hit.construct)
    if (row === undefined) continue
    const classified = Mapping.classifyWithReason(hit, parse)
    const existing = byConstruct.get(hit.construct)
    const occurrences = (existing?.occurrences ?? 0) + 1
    // One row stands for every occurrence of a construct, so it has to carry
    // the worst class any of them has and every reason any of them gave. The
    // last occurrence's class is not the row's class: a file holding one plain
    // `<Task>` and one `<Task hijack>` needs the row to say `unsafe`, whichever
    // order the two were read in.
    const reasons = reasonsByConstruct.get(hit.construct) ?? []
    for (const reason of (classified.reason ?? "").split("; ")) {
      if (reason !== "" && !reasons.includes(reason)) reasons.push(reason)
    }
    reasonsByConstruct.set(hit.construct, reasons)
    const merged = existing !== undefined && severity[existing.class] > severity[classified.class]
      ? existing.class
      : classified.class
    byConstruct.set(hit.construct, {
      construct: row.construct,
      target: row.target,
      rule: row.rule,
      class: merged,
      decidedBy: "scanner",
      occurrences,
      ...(reasons.length === 0 ? {} : { reason: [...reasons].sort(Sort.byText).join("; ") })
    })
  }
  return [...byConstruct.values()].sort(Sort.by((decision: Report.MappingDecision) => decision.construct))
}

/**
 * Reads a project and returns everything the migration needs to decide what to
 * do with it.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const scan = (
  root: string,
  options: Options = {}
): Effect.Effect<ScanResult, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const parse = yield* Ts.session
    const detection = yield* Detect.scan(root, {
      ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
      ...(options.environment === undefined ? {} : { environment: options.environment })
    }, parse)
    const runState = yield* RunState.scan(root, detection, options.runState ?? {})
    const inventory = yield* Inventory.scan(detection, parse)
    const hints = {
      zod: ZodSchemaHints.hints(detection, parse),
      prompt: PromptHints.hints(detection)
    }
    // The whole plan first, then the selection. A `--unit` id the plan does
    // not carry used to filter every unit away: nothing ran, no unit was
    // `failed` or `blocked`, and the run reported a successful migration that
    // did nothing. The plan is also the only place a duplicate id is visible,
    // because everything downstream keys units by that id.
    const planned = Units.plan({ detection, inventory, hints }, {
      ...(options.flowsDir === undefined ? {} : { flowsDir: options.flowsDir }),
      ...(options.commands === undefined ? {} : { commands: options.commands })
    }, parse)
    const duplicates = Units.duplicateIds(planned)
    if (duplicates.length > 0) {
      return yield* Effect.fail(make(
        "unsupported-project",
        `two units share one id, so one would overwrite the other: ${
          duplicates
            .map((entry) => `"${entry.id}" is planned for ${entry.sources.map((file) => `"${file}"`).join(" and ")}`)
            .join("; ")
        }`
      ))
    }
    const asked = options.units
    if (asked !== undefined) {
      const known = new Set(planned.map((unit) => unit.id))
      const unknown = [...new Set(asked)].filter((id) => !known.has(id)).sort(Sort.byText)
      if (unknown.length > 0) {
        return yield* Effect.fail(make(
          "unsupported-project",
          `no unit is planned for ${unknown.map((id) => `"${id}"`).join(", ")}; this project plans ${
            planned.map((unit) => `"${unit.id}"`).join(", ")
          }`
        ))
      }
    }
    const units = asked === undefined ? planned : planned.filter((unit) => asked.includes(unit.id))
    return { root, detection, runState, inventory, mapping: decisions(inventory, parse), hints, units }
  }).pipe(Effect.scoped)

/**
 * The operator decisions one unit carries, as report `unresolved` entries.
 *
 * Design 8.4: a CLI subprocess agent and a `fallbackAgents` pool are answered
 * by a person, not by the tool, and each one is an entry that stays unresolved
 * until it is answered. Without these the plan report would name the rule in
 * the mapping table and record nothing an operator can act on.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const operatorDecisions = (
  unit: Units.UnitPlan
): ReadonlyArray<Report.UnresolvedEntry> =>
  unit.constructs
    .filter((hit) => Mapping.subscriptionAgents.includes(hit.construct))
    .map((hit) => ({
      construct: hit.construct,
      reason: Mapping.byConstruct(hit.construct)?.rule ?? "an operator decision",
      file: hit.file,
      line: hit.line,
      suggestion: Mapping.subscriptionSuggestion
    }))

/**
 * Renders a scan as a report. Units come back `planned`: nothing has been
 * migrated yet, and `scan` and `plan` never migrate anything.
 *
 * Pass `{ acknowledgeRunState: true }` when the operator passed
 * `--acknowledge-run-state`; without it a project holding 0.x run state exits 3
 * in `apply` mode.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const toReport = (
  result: ScanResult,
  mode: Report.Mode,
  generatedAt: string,
  options: Report.FinalizeOptions = {}
): Report.MigrationReport => {
  const base = Report.empty(result.root, mode, generatedAt)
  const withProject = new Report.MigrationReport({
    ...base,
    project: Report.project(result.detection),
    runState: Report.runState(result.runState),
    inventory: Report.inventory(result.inventory, Mapping.classify),
    mapping: result.mapping
  })
  const withUnits = result.units.reduce(
    (report, unit) =>
      Report.withUnit(report, {
        id: unit.id,
        kind: unit.kind,
        sources: unit.sources,
        targets: unit.targets,
        status: unit.unsafe.length > 0 ? "blocked" : "planned",
        changedFiles: [],
        decisions: [],
        unresolved: [...operatorDecisions(unit), ...unit.notes],
        unsupported: unit.unsafe.map((construct) => ({
          construct,
          reason: Mapping.byConstruct(construct)?.rule ?? "no counterpart",
          file: unit.constructs.find((hit) => hit.construct === construct)?.file ?? unit.sources[0] ?? result.root,
          line: unit.constructs.find((hit) => hit.construct === construct)?.line ?? 1,
          closest: Mapping.byConstruct(construct)?.rule ?? "none"
        })),
        repairRounds: 0,
        durationMs: 0
      }),
    withProject
  )
  return Report.finalize(withUnits, options)
}
