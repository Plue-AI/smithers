/**
 * Partitions a scan into ordered migration units.
 *
 * A unit is one checkpoint, one agent frame, and one verification. Keeping
 * them small is what makes a failure recoverable: the tool restores the unit's
 * checkpoint, marks it failed, and carries on with the next one, so a project
 * never ends up half rewritten with no way back.
 *
 * The order is fixed. Dependencies first, so the new packages are installed
 * beside the old ones and every later unit can import them. Then one unit per
 * workflow, with each shared component or library attached to the first
 * workflow that needs it. Then one unit per integration. Then the project unit,
 * which removes the old packages, the JSX settings, and the old CLI scripts
 * once nothing depends on them.
 *
 * @since 1.0.0-rc.0
 */

import * as Schema from "effect/Schema"
import type { Detection, SpecifierContext } from "./Detect.ts"
import { localPackageName } from "./Detect.ts"
import * as CommandLine from "./internal/CommandLine.ts"
import * as FlowNames from "./internal/FlowNames.ts"
import * as Sort from "./internal/Sort.ts"
import * as Ts from "./internal/Ts.ts"
import type { InventoryEntry } from "./Inventory.ts"
import * as Mapping from "./Mapping.ts"
import type { PromptHint } from "./PromptHints.ts"
import type { ZodHint } from "./ZodSchemaHints.ts"

/**
 * What a unit migrates.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type UnitKind = "dependencies" | "workflow" | "integration" | "project"

/**
 * A repository-derived command: an executable and its literal arguments,
 * spawned with no shell in between.
 *
 * A path the scanner found on disk is an argument here, never a fragment of
 * a command line. `tsconfig; rm -rf .json` is a legal file name, and as an
 * argv element it is exactly that name and nothing more.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ArgvCommand = Schema.Struct({
  _tag: Schema.Literal("argv"),
  executable: Schema.String,
  args: Schema.Array(Schema.String)
})

/**
 * A repository-derived command whose arguments never pass through a shell.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ArgvCommand = typeof ArgvCommand.Type

/**
 * One verification command.
 *
 * A structured command is derived from repository metadata and executes as a
 * literal argv. A bare string is reserved for an explicit operator override
 * (`--verify-*`) and deliberately keeps shell semantics: the operator typed
 * the line and is the one person allowed to.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const VerificationCommand = Schema.Union([Schema.String, ArgvCommand])

/**
 * One structured or explicitly shell-backed verification command.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type VerificationCommand = typeof VerificationCommand.Type

/**
 * Builds a structured command.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const argv = (executable: string, ...args: ReadonlyArray<string>): ArgvCommand => ({
  _tag: "argv",
  executable,
  args
})

/**
 * The commands that verify one unit.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface VerifyCommands {
  readonly install: VerificationCommand | undefined
  readonly format: VerificationCommand | undefined
  readonly typecheck: ReadonlyArray<VerificationCommand>
  readonly test: VerificationCommand | undefined
  readonly discovery: { readonly flowsDir: string }
  /**
   * What the derivation could not honor, so the report says which command
   * really ran. A `smithers.config.ts` test line that needs a shell is not run
   * as written: the tool runs no repository-authored shell syntax.
   */
  readonly notes: ReadonlyArray<UnitNote>
}

/**
 * Something the plan itself could not settle, in the shape the report's
 * `unresolved` table takes.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface UnitNote {
  readonly construct: string
  readonly reason: string
  readonly file: string
  readonly line: number
  readonly suggestion: string
}

/**
 * One migration unit.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface UnitPlan {
  readonly id: string
  readonly kind: UnitKind
  readonly sources: ReadonlyArray<string>
  readonly targets: ReadonlyArray<string>
  readonly constructs: ReadonlyArray<InventoryEntry>
  readonly mapping: ReadonlyArray<Mapping.MappingRow>
  readonly hints: { readonly zod: ReadonlyArray<ZodHint>; readonly prompt: ReadonlyArray<PromptHint> }
  /** Distinct constructs in this unit that have no safe automatic translation. */
  readonly unsafe: ReadonlyArray<string>
  /** What planning this unit could not settle. Reaches the report unresolved. */
  readonly notes: ReadonlyArray<UnitNote>
  /**
   * What the project's manifests said about the names that exist in both
   * trees, so a check can tell an old import from a new one.
   */
  readonly specifiers: SpecifierContext
  readonly verification: VerifyCommands
}

/**
 * What {@link plan} reads. A `ScanResult` satisfies it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PlanInput {
  readonly detection: Detection
  readonly inventory: ReadonlyArray<InventoryEntry>
  readonly hints: { readonly zod: ReadonlyArray<ZodHint>; readonly prompt: ReadonlyArray<PromptHint> }
}

/**
 * Command overrides, from the CLI.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CommandOverrides {
  readonly install?: string | undefined
  readonly format?: string | undefined
  readonly typecheck?: ReadonlyArray<string> | undefined
  readonly test?: string | undefined
}

/**
 * Options for {@link plan}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly flowsDir?: string | undefined
  readonly commands?: CommandOverrides | undefined
  /** Restrict the plan to these unit ids. */
  readonly units?: ReadonlyArray<string> | undefined
}

const installByManager: ReadonlyArray<[string, VerificationCommand]> = [
  ["bun", argv("bun", "install")],
  ["pnpm", argv("pnpm", "install")],
  ["yarn", argv("yarn", "install")],
  ["npm", argv("npm", "install")]
]

const installByLockfile: ReadonlyArray<[string, VerificationCommand]> = [
  ["bun.lock", argv("bun", "install")],
  ["bun.lockb", argv("bun", "install")],
  ["pnpm-lock.yaml", argv("pnpm", "install")],
  ["yarn.lock", argv("yarn", "install")],
  ["package-lock.json", argv("npm", "install")]
]

const runner = (manager: string | undefined): readonly [string, ReadonlyArray<string>] => {
  if (manager === "bun" || manager === "pnpm") return [manager, ["run"]]
  if (manager === "yarn") return [manager, []]
  return ["npm", ["run"]]
}

/**
 * A repository-authored command line as an argv, when it is one.
 *
 * Only a line made of plain words qualifies: no quotes, no `$`, `;`, `|`,
 * `&`, redirections, globs, or newlines, and an executable that is not a
 * flag. Anything else would need a shell to mean what it says, and the tool
 * gives repository text no shell. The caller records what it did instead.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const simpleCommand = (line: string): ArgvCommand | undefined => {
  if (!/^[A-Za-z0-9_@%+=:,./ -]+$/.test(line) || /[\r\n\0]/.test(line)) return undefined
  const [executable, ...args] = line.trim().split(/ +/)
  return executable === undefined || executable === "" || executable.startsWith("-")
    ? undefined
    : argv(executable, ...args)
}

/**
 * Derives the commands that verify a migrated project: install from the
 * lockfile, format from the formatter the project already configures,
 * typecheck once per `tsconfig.json`, and test from `smithers.config.ts`
 * `repoCommands.test` or the root `package.json` test script.
 *
 * Every derived command is an {@link ArgvCommand}: the executable and its
 * arguments are spawned as they are, so a file name the scanner read off the
 * disk can never become shell syntax. The formatter runs in check mode
 * (`dprint check`, `prettier --check .`) because a verification is a
 * question, and a formatter that rewrites the whole repository answers it by
 * editing files the unit does not own.
 *
 * Every one of them is overridable, because the tool must never invent a
 * command that runs the operator's code. An override is the operator's own
 * line and keeps its shell semantics.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const verifyCommands = (
  detection: Detection,
  overrides: CommandOverrides = {},
  flowsDir = "flows"
): VerifyCommands => {
  const lockfiles = new Set(detection.lockfiles.map((file) => file.split("/").pop() ?? file))
  const byLock = installByLockfile.find(([name]) => lockfiles.has(name))?.[1]
  const declared = detection.packageManager
  const byManager = declared === undefined
    ? undefined
    : installByManager.find(([name]) => declared.startsWith(name))?.[1]
  const install = overrides.install ?? byManager ?? byLock
  const manager = declared === undefined
    ? installByLockfile.find(([name]) => lockfiles.has(name))?.[1]
    : installByManager.find(([name]) => declared.startsWith(name))?.[1]
  const managerName = typeof manager === "object" ? manager.executable : undefined

  const hasDprint = detection.files.some((file) => file.endsWith("dprint.json"))
  const hasPrettier = detection.files.some((file) => /(^|\/)\.?prettierrc([^/]*)$/.test(file)) ||
    detection.manifests.some((manifest) => manifest.path === "package.json" && manifest.name === "prettier")
  const format = overrides.format ?? (hasDprint
    ? argv("dprint", "check")
    : hasPrettier
    ? argv("prettier", "--check", ".")
    : undefined)

  const typecheck = overrides.typecheck ??
    detection.tsconfigs
      .map((entry) => entry.path)
      .filter((path) => !path.includes("tsconfig.test.json"))
      .sort(Sort.byText)
      .map((path) => argv("tsc", "--noEmit", "-p", path))

  const scriptTest = detection.manifests.find((manifest) => manifest.kind === "root")?.scripts.find((script) =>
    script.name === "test"
  )
  const configuredTest = detection.config.smithersConfig?.repoCommands.get("test")
  const configured = configuredTest === undefined ? undefined : simpleCommand(configuredTest)
  const [testRunner, testPrefix] = runner(managerName)
  const scripted = scriptTest === undefined ? undefined : argv(testRunner, ...testPrefix, "test")
  const test = overrides.test ?? configured ?? scripted
  const notes: Array<UnitNote> = []
  if (overrides.test === undefined && configuredTest !== undefined && configured === undefined) {
    notes.push({
      construct: "smithers.config.ts repoCommands.test",
      reason: `\`${configuredTest}\` needs a shell to run, and the tool runs no repository-authored shell syntax; ${
        scripted === undefined ? "no test command ran" : `\`${renderArgv(scripted)}\` ran instead`
      }`,
      file: detection.config.smithersConfig?.path ?? "smithers.config.ts",
      line: 1,
      suggestion: `pass --verify-test ${JSON.stringify(configuredTest)} to run the line as written`
    })
  }

  return { install, format, typecheck, test, discovery: { flowsDir }, notes }
}

const renderArgv = (command: ArgvCommand): string => CommandLine.renderArgv(command.executable, command.args)

/**
 * The flow name a workflow file becomes, in registry path naming.
 *
 * A file under `.smithers/workflows/` keeps its position, so
 * `.smithers/workflows/pipelines/ci-fast.tsx` becomes `pipelines/ci-fast` and
 * lands at `flows/pipelines/ci-fast/flow.ts`. Anything else keeps its own
 * directories, so `examples/hello.jsx` becomes `examples/hello` and
 * `src/wf/hello.tsx` becomes `src/wf/hello`.
 *
 * The directories are kept because the name is a unit id and a target path at
 * once. Collapsing to the basename gave two workflows in different directories
 * one id and one `flow.ts`: the second agent overwrote the first agent's flow,
 * one unit's outcome vanished from the report because `Report.withUnit`
 * replaces by id, and both units wrote the same artifact file. A root-level
 * file is unaffected, because it has no directories to keep.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const flowName = FlowNames.fromPath

/**
 * Every unit id carried by more than one plan, with the sources behind it.
 *
 * {@link flowName} makes a collision rare rather than impossible: a project
 * holding both `.smithers/workflows/hello.tsx` and `hello.tsx` still names one
 * flow twice. A duplicate id cannot be caught downstream — the stale-plan gate
 * joins the ids into one string, so both strings carry the duplicate — so the
 * plan is checked here and the scan refuses.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const duplicateIds = (
  units: ReadonlyArray<UnitPlan>
): ReadonlyArray<{ readonly id: string; readonly sources: ReadonlyArray<string> }> => {
  const byId = new Map<string, { count: number; sources: Array<string> }>()
  for (const unit of units) {
    const seen = byId.get(unit.id)
    if (seen === undefined) byId.set(unit.id, { count: 1, sources: [...unit.sources] })
    else {
      seen.count += 1
      seen.sources.push(...unit.sources)
    }
  }
  return [...byId.entries()]
    .filter(([, seen]) => seen.count > 1)
    .map(([id, seen]) => ({ id, sources: [...new Set(seen.sources)].sort(Sort.byText) }))
    .sort(Sort.by((entry: { readonly id: string }) => entry.id))
}

/**
 * What the manifests decided about the specifiers that exist in both trees.
 *
 * Design 3.2 gates the import rules on 3.1: the bare name `smithers` and every
 * `@smthrs/<name>` that survived into 1.0 are old only where a manifest said
 * so, and a check that runs after the transform has to be told the same thing
 * the scan was.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const specifierContext = (detection: Detection): SpecifierContext => ({
  localFacade: detection.manifests.some((manifest) =>
    manifest.oldPackages.some((entry) => entry.name === localPackageName)
  ),
  oldScoped: [
    ...new Set(
      detection.manifests.flatMap((manifest) =>
        manifest.oldPackages
          .filter((entry) => entry.name.startsWith("@smthrs/"))
          .map((entry) => entry.name.slice("@smthrs/".length))
      )
    )
  ].sort(Sort.byText)
})

/**
 * Orders workflow files so a workflow another one imports is migrated first.
 *
 * Design 5.2 asks for dependency order, not path order: a pack whose
 * `a-first.tsx` imports `./z-last.tsx` has to migrate `z-last` first, or the
 * unit that rewrites `a-first` has nothing to point its child-flow reference
 * at. The sort is a depth-first topological walk with a lexical tie-break, so
 * two independent workflows always come out in the same order, and a cycle
 * falls back to the lexical order of the files in it.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const orderWorkflows = <A extends { readonly path: string }>(
  workflows: ReadonlyArray<A>,
  imports: ReadonlyArray<{ readonly file: string; readonly specifier: string; readonly kind: string }>
): { readonly ordered: ReadonlyArray<A>; readonly cycles: ReadonlyArray<ReadonlyArray<string>> } => {
  const sorted = [...workflows].sort(Sort.by((entry: { path: string }) => entry.path))
  const byPath = new Map(sorted.map((entry) => [entry.path, entry]))
  const dependencies = new Map<string, Array<string>>()
  for (const entry of sorted) dependencies.set(entry.path, [])
  for (const hit of imports) {
    if (hit.kind !== "relative") continue
    const list = dependencies.get(hit.file)
    if (list === undefined || !byPath.has(hit.specifier) || hit.specifier === hit.file) continue
    if (!list.includes(hit.specifier)) list.push(hit.specifier)
  }

  const ordered: Array<A> = []
  const done = new Set<string>()
  const stack: Array<string> = []
  const cycles: Array<ReadonlyArray<string>> = []
  const visit = (path: string): void => {
    if (done.has(path)) return
    if (stack.includes(path)) {
      cycles.push([...stack.slice(stack.indexOf(path)), path])
      return
    }
    stack.push(path)
    for (const next of [...(dependencies.get(path) ?? [])].sort(Sort.byText)) visit(next)
    stack.pop()
    if (done.has(path)) return
    done.add(path)
    const entry = byPath.get(path)
    if (entry !== undefined) ordered.push(entry)
  }
  for (const entry of sorted) visit(entry.path)
  return { ordered, cycles }
}

const unsafeConstructs = (hits: ReadonlyArray<InventoryEntry>, parse: typeof Ts.parse): ReadonlyArray<string> =>
  [...new Set(hits.filter((hit) => Mapping.classify(hit, parse) === "unsafe").map((hit) => hit.construct))].sort(
    Sort.byText
  )

const mappingRows = (hits: ReadonlyArray<InventoryEntry>): ReadonlyArray<Mapping.MappingRow> => {
  const rows = new Map<string, Mapping.MappingRow>()
  for (const hit of hits) {
    const row = Mapping.byConstruct(hit.construct)
    if (row !== undefined) rows.set(row.construct, row)
  }
  return [...rows.values()].sort(Sort.by((row: Mapping.MappingRow) => row.construct))
}

/**
 * Plans the migration.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const plan = (
  input: PlanInput,
  options: Options = {},
  parse: typeof Ts.parse = Ts.parse
): ReadonlyArray<UnitPlan> => {
  const flowsDir = options.flowsDir ?? "flows"
  const verification = verifyCommands(input.detection, options.commands ?? {}, flowsDir)
  const specifiers = specifierContext(input.detection)
  const byFile = new Map<string, Array<InventoryEntry>>()
  for (const hit of input.inventory) {
    const list = byFile.get(hit.file) ?? []
    list.push(hit)
    byFile.set(hit.file, list)
  }
  const zodByFile = new Map<string, Array<ZodHint>>()
  for (const hint of input.hints.zod) {
    const list = zodByFile.get(hint.file) ?? []
    list.push(hint)
    zodByFile.set(hint.file, list)
  }
  const promptByFile = new Map(input.hints.prompt.map((hint) => [hint.file, hint]))

  const units: Array<UnitPlan> = []

  const manifests = input.detection.manifests.filter((manifest) => manifest.oldPackages.length > 0)
  units.push({
    id: "dependencies",
    kind: "dependencies",
    sources: manifests.map((manifest) => manifest.path).sort(Sort.byText),
    targets: manifests.map((manifest) => manifest.path).sort(Sort.byText),
    constructs: [],
    mapping: [Mapping.byConstruct("package.json")!],
    hints: { zod: [], prompt: [] },
    unsafe: [],
    // What the command derivation could not honor is reported once, on the
    // first unit, because every unit verifies with the same commands.
    notes: verification.notes,
    specifiers,
    verification
  })

  // Shared components and libraries attach to the first workflow that imports
  // them, so no file is migrated twice and nothing is migrated by a unit that
  // does not know what it is for.
  const claimed = new Set<string>()
  const shared = new Set([...input.detection.components, ...input.detection.libs])
  // A file already written against Smithers 1.0 gets no unit. It has nothing
  // to migrate, and planning one would hand the agent its own output and write
  // the result to a second path named after `flow.ts`. Running the tool twice
  // has to be safe: the second run reports the file as already migrated and
  // leaves it where it is.
  const { cycles, ordered: workflows } = orderWorkflows(
    input.detection.workflowFiles.filter((workflow) => workflow.api !== "flows"),
    input.detection.imports
  )
  // A cycle is broken lexically so the plan stays deterministic, and the
  // operator is told which order the tool had to choose for itself.
  const cycleNotes = (path: string): ReadonlyArray<UnitNote> =>
    cycles
      .filter((cycle) => cycle.includes(path))
      .map((cycle) => ({
        construct: "workflow import cycle",
        reason: `${cycle.join(" -> ")} import each other, so no dependency order exists`,
        file: path,
        line: 1,
        suggestion: "migrate these workflows together, or break the cycle before running apply"
      }))

  // Breadth-first with a visited set, and computed once per workflow. The
  // depth-first spelling this replaces re-walked every path to every file, so
  // its cost was the fan-out to the power of the cap: ten relative imports per
  // file at depth 8 is a hundred million calls, which hangs `plan` — the mode
  // the README calls safe to run on any project. Every other traversal in the
  // package keeps a `seen` set for the same reason.
  const reachable = (from: string, depth: number): ReadonlySet<string> => {
    const visited = new Set<string>()
    let frontier = [from]
    for (let remaining = depth; remaining > 0 && frontier.length > 0; remaining -= 1) {
      const next: Array<string> = []
      for (const file of frontier) {
        for (const hit of input.detection.imports) {
          if (hit.file !== file) continue
          if (hit.kind !== "relative" && hit.kind !== "mdx") continue
          if (visited.has(hit.specifier)) continue
          visited.add(hit.specifier)
          next.push(hit.specifier)
        }
      }
      frontier = next
    }
    return visited
  }

  for (const workflow of workflows) {
    const closure = reachable(workflow.path, 8)
    const attached = [...closure]
      .filter((file) => shared.has(file) && !claimed.has(file))
      .sort(Sort.byText)
    for (const file of attached) claimed.add(file)
    // A prompt is claimed like a component: two workflows can import the same
    // `.mdx`, and migrating it twice would give one prompt two homes.
    const prompts = [...closure]
      .filter((file) => promptByFile.has(file) && !claimed.has(file))
      .sort(Sort.byText)
    for (const file of prompts) claimed.add(file)
    const sources = [workflow.path, ...attached, ...prompts]
    const constructs = sources.flatMap((file) => byFile.get(file) ?? [])
    const name = flowName(workflow.path)
    units.push({
      id: `workflow:${name}`,
      kind: "workflow",
      sources,
      targets: [`${flowsDir}/${name}/flow.ts`],
      constructs,
      mapping: mappingRows(constructs),
      hints: {
        zod: sources.flatMap((file) => zodByFile.get(file) ?? []),
        prompt: prompts.flatMap((file) => {
          const hint = promptByFile.get(file)
          return hint === undefined ? [] : [hint]
        })
      },
      unsafe: unsafeConstructs(constructs, parse),
      notes: cycleNotes(workflow.path),
      specifiers,
      verification
    })
  }

  const integrations = [...new Set(input.detection.integrations.map((hit) => hit.integration))].sort(Sort.byText)
  for (const integration of integrations) {
    const sources = [
      ...new Set(input.detection.integrations.filter((hit) => hit.integration === integration).map((hit) => hit.file))
    ]
      .sort(Sort.byText)
    const constructs = sources.flatMap((file) => byFile.get(file) ?? [])
    units.push({
      id: `integration:${integration}`,
      kind: "integration",
      sources,
      targets: [],
      constructs,
      mapping: mappingRows(constructs),
      hints: { zod: [], prompt: [] },
      unsafe: unsafeConstructs(constructs, parse),
      notes: [],
      specifiers,
      verification
    })
  }

  // The root ignore file is the project unit's to rewrite: `.flows/` is
  // runtime state a migrated project writes on its first run. A project
  // without one gets it as a target, so creating it is inside the unit's set.
  const rootGitignore = input.detection.config.gitignore.includes(".gitignore")
  const projectSources = [
    ...input.detection.manifests.map((manifest) => manifest.path),
    ...input.detection.tsconfigs.map((entry) => entry.path),
    ...input.detection.config.preload.map((entry) => entry.path),
    ...input.detection.config.bunfig.map((entry) => entry.path),
    ...input.detection.config.gateway,
    ...input.detection.config.agents,
    ...(input.detection.config.smithersConfig === undefined ? [] : [input.detection.config.smithersConfig.path]),
    ...input.detection.config.assetTypes,
    ...new Set(input.detection.scripts.map((hit) => hit.file)),
    ...(rootGitignore ? [".gitignore"] : [])
  ]
  units.push({
    id: "project",
    kind: "project",
    sources: [...new Set(projectSources)].sort(Sort.byText),
    targets: [...(rootGitignore ? [] : [".gitignore"]), `${flowsDir}/seats.ts`],
    constructs: [],
    mapping: [
      Mapping.byConstruct("package.json")!,
      Mapping.byConstruct("tsconfig.json")!,
      Mapping.byConstruct("smithers.config.ts")!,
      Mapping.byConstruct("docs")!
    ],
    hints: { zod: [], prompt: [] },
    unsafe: [],
    notes: [],
    specifiers,
    verification
  })

  return options.units === undefined ? units : units.filter((unit) => options.units!.includes(unit.id))
}
