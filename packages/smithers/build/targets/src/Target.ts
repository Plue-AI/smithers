/**
 * Opaque build declarations with an explicit plan-lowering boundary.
 *
 * @since 0.1.0
 */

import { Action, type Flow, type FlowRuntime } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { createHash } from "node:crypto"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { getCallSites } from "node:util"
import * as NodeUtil from "node:util/types"
import * as Config from "./Config.ts"
import * as Input from "./Input.ts"

/**
 * CLI verbs a target can participate in.
 *
 * `docs` is the documentation-parity verb. It remains independently
 * addressable and also participates in the aggregate `ci` command.
 *
 * `run` and `review` do not. `run` is the manual verb, and `review` is the
 * model-assisted one: a review target spawns a model CLI against the diff of
 * the checkout it runs in, which is neither a reproducible function of its
 * inputs nor something a hosted runner has the binary or the credential for.
 * A target that declares `review` alone is therefore invisible to
 * `lint`, `ci`, `test`, and `build` over a wildcard, and reachable only
 * through `smithers-build review` or its exact label.
 *
 * @category models
 * @since 0.1.0
 */
export const Kind = Schema.Literals(["build", "test", "lint", "run", "docs", "review"])

/**
 * CLI verbs a target can participate in.
 *
 * @category models
 * @since 0.1.0
 */
export type Kind = typeof Kind.Type

/** Runtime membership check kept independent of schema internals. */
const kindNames: ReadonlySet<string> = new Set(["build", "test", "lint", "run", "docs", "review"])

const isKind = (value: unknown): value is Kind => typeof value === "string" && kindNames.has(value)

/**
 * Whether validated target attrs require an exclusive execution window.
 *
 * Rules opt into this tier with an `exclusive` boolean attr. Wildcard test
 * and CI selections omit these targets unless explicitly opted in; once
 * selected, each runs alone within its executor invocation.
 *
 * @category guards
 * @since 0.1.0
 */
export const isExclusive = (attrs: unknown): boolean => Predicate.isObject(attrs) && attrs["exclusive"] === true

/**
 * Runtime marker shared by source and installed copies of this package.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TargetTypeId: unique symbol = Symbol.for("smithers-build/Target") as never

/**
 * The output tree a target promises one execution will produce.
 *
 * `cwd` is the workspace-relative directory the declared paths resolve
 * against, and `paths` is the complete, ordered list of them. This is target
 * metadata rather than something read back out of attrs at admission time: an
 * untrusted cache entry must never get to choose which paths are verified, and
 * an implementation must not get to decide after the fact that it produced
 * fewer outputs than it declared.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeclaredOutputs {
  readonly cwd: string
  readonly paths: ReadonlyArray<string>
}

/** Matches an absolute path on any host this can run on. */
const absolutePath = /^([/\\]|[A-Za-z]:)/

/**
 * Splits one workspace-relative declaration into segments, or names the reason
 * it is unusable.
 *
 * `.` and empty segments are dropped, so `dist`, `./dist`, and `dist/` all
 * reduce to the same segments and are recognised as the same declaration.
 */
const segmentsOf = (value: string): ReadonlyArray<string> | string => {
  if (value === "") return "is empty"
  if (absolutePath.test(value)) return "is absolute"
  if (value.includes("\0")) return "contains a null byte"
  const segments = value.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".")
  if (segments.includes("..")) return "leaves the directory it is declared against"
  return segments
}

/**
 * Directories a declared output may never name or sit inside.
 *
 * The default cache directory is the result store: an output captured from
 * inside it would be digested out of the same tree that stores the digest, and
 * a cache admission would then verify a stored entry against a copy of itself.
 * `.git` is refused for the same structural reason.
 */
const reservedRoots: ReadonlySet<string> = new Set([Config.defaultCacheDirectory, ".git"])

/**
 * Returns the reason one declared output path is unusable, or undefined.
 *
 * This is the single definition of a legal declaration. Target metadata applies
 * it when a target is constructed, and execution applies it again to the paths
 * that arrive in an action payload or a cache entry.
 *
 * @category validation
 * @since 0.1.0
 */
export const declaredOutputFailure = (cwd: string, path: string): string | undefined => {
  const base = segmentsOf(cwd)
  if (typeof base === "string") return `the output cwd ${JSON.stringify(cwd)} ${base}`
  const own = segmentsOf(path)
  if (typeof own === "string") return `the output path ${JSON.stringify(path)} ${own}`
  if (own.length === 0) return `the output path ${JSON.stringify(path)} names its own directory rather than an output`
  const resolved = [...base, ...own]
  if (reservedRoots.has(resolved[0]!)) {
    return `the output path ${JSON.stringify(path)} resolves inside the reserved directory ${resolved[0]}`
  }
  return undefined
}

/**
 * Returns the reason one declared output set is unusable, or undefined.
 *
 * A duplicate is refused because the manifest contract is an exact, positional
 * match: a target that names one output twice could never be satisfied by a
 * manifest that also refuses duplicates. Duplication is judged after the
 * declarations resolve, so `dist` and `./dist` collide, and so do names that
 * differ only in Unicode normal form or letter case. An overlap is refused
 * for the same reason one step out: `dist` and `dist/index.js` would put one
 * file in the manifest twice, under two different digests that no longer have
 * to agree.
 *
 * @category validation
 * @since 0.1.0
 */
export const declaredOutputsFailure = (value: DeclaredOutputs): string | undefined => {
  const base = segmentsOf(value.cwd)
  if (typeof base === "string") return `the output cwd ${JSON.stringify(value.cwd)} ${base}`
  const resolved: Array<{ readonly path: string; readonly segments: ReadonlyArray<string> }> = []
  for (const path of value.paths) {
    const failure = declaredOutputFailure(value.cwd, path)
    if (failure !== undefined) return failure
    const own = segmentsOf(path) as ReadonlyArray<string>
    // Compare the way the strictest supported filesystem would: a normalizing,
    // case-insensitive one (the macOS and Windows defaults) stores `A.js` and
    // `a.js`, or two Unicode forms of one name, as one file.
    resolved.push({ path, segments: [...base, ...own].map((segment) => segment.normalize("NFC").toLowerCase()) })
  }
  for (const [index, entry] of resolved.entries()) {
    for (const other of resolved.slice(index + 1)) {
      const shorter = entry.segments.length <= other.segments.length ? entry : other
      const longer = shorter === entry ? other : entry
      if (!shorter.segments.every((segment, at) => longer.segments[at] === segment)) continue
      return shorter.segments.length === longer.segments.length
        ? `the output paths ${JSON.stringify(entry.path)} and ${JSON.stringify(other.path)} name the same output`
        : `the output path ${JSON.stringify(longer.path)} is already covered by ${JSON.stringify(shorter.path)}`
    }
  }
  return undefined
}

/**
 * Validates one declared output set, or throws naming the target that declared
 * it.
 *
 * @category validation
 * @since 0.1.0
 */
export const declaredOutputs = (target: string, value: DeclaredOutputs): DeclaredOutputs => {
  const failure = declaredOutputsFailure(value)
  if (failure !== undefined) throw new Error(`${target} declared outputs it cannot produce: ${failure}`)
  return { cwd: value.cwd, paths: [...value.paths] }
}

/**
 * The attrs, declared inputs, declared outputs, and cacheability one verb sees
 * for a target.
 *
 * @category models
 * @since 0.1.0
 */
export interface KindView {
  readonly attrs: unknown
  readonly dependencies: ReadonlyArray<AnyTarget>
  /** Workspace targets selected without importing their PACKAGE.ts modules. */
  readonly dependencySelectors: ReadonlyArray<DependencySelector>
  readonly inputs: ReadonlyArray<Input.Declared>
  readonly cacheable: boolean
  readonly outputs: DeclaredOutputs | undefined
}

/**
 * An attr a rule resolves from the workspace declaration.
 *
 * The workspace declares the package manager and the runtime once, in
 * `WORKSPACE.ts`. A rule that names one of these here is telling the executor
 * to fill it from that declaration whenever a PACKAGE.ts omits it, which is
 * what keeps the tool identity out of every package's declaration file. A
 * declaration that passes the attr explicitly still wins: that is how a
 * package runs its suite under a second interpreter.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkspaceAttr = "packageManager" | "runtime"

/**
 * How a declaration presents its target to a person: the one-line `summary`
 * a listing or the app shows under the label, and whether the target is
 * `featured` (an essential of its repository, leading the app's Featured
 * view). Both ride the declaration itself (`Smithers.Vitest({ ...,
 * summary: "..." })`) so the prose lives beside the target it describes;
 * the label is never declared, it is the package path and export name.
 * Neither is an attr: they do not reach the schema, the plan, or the cache
 * key, so annotating a target changes nothing about what it runs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Presentation {
  readonly summary?: string | undefined
  readonly featured?: boolean | undefined
}

/**
 * A declaration's presentation with the defaults applied: the trimmed
 * one-line summary, or undefined, and whether the declaration is featured.
 *
 * @category models
 * @since 1.0.0
 */
export interface DeclaredPresentation {
  readonly summary: string | undefined
  readonly featured: boolean
}

/** The keys a declaration may carry beside its attrs. */
const presentationKeys: ReadonlySet<string> = new Set(["summary", "featured"])

/**
 * Separates the presentation from the attrs of one snapshotted declaration,
 * or names the reason the presentation is unusable.
 *
 * Exported so every declaration that carries a `summary` and `featured`
 * pair, a target or a `Smithers.Flow`, validates the pair through one rule.
 *
 * @category validation
 * @since 1.0.0
 */
export const splitPresentation = (
  snapshot: unknown
): { readonly attrs: unknown; readonly presentation: DeclaredPresentation } | string => {
  const none = { summary: undefined, featured: false }
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return { attrs: snapshot, presentation: none }
  }
  const record = snapshot as Record<string, unknown>
  if (!("summary" in record) && !("featured" in record)) return { attrs: snapshot, presentation: none }
  const attrs: Record<string, unknown> = {}
  for (const key of Object.keys(record)) if (!presentationKeys.has(key)) attrs[key] = record[key]
  let summary: string | undefined
  if ("summary" in record && record.summary !== undefined) {
    if (typeof record.summary !== "string") return "summary must be a string"
    if (record.summary.trim() === "") return "summary must not be empty"
    if (/[\r\n]/.test(record.summary)) return "summary must be one line"
    summary = record.summary.trim()
  }
  let featured = false
  if ("featured" in record && record.featured !== undefined) {
    if (typeof record.featured !== "boolean") return "featured must be a boolean"
    featured = record.featured
  }
  return { attrs, presentation: { summary, featured } }
}

/**
 * Planner metadata attached to a target Flow.
 *
 * `forKind` resolves the attrs a verb executes with. A target without an
 * `attrsForKind` mapping returns the declared view for every verb. A target
 * with one, for example a generator whose `build` writes and whose `lint`
 * checks drift, returns re-derived inputs, outputs, and cacheability for the
 * mapped attrs. `implementationDigest` identifies the implementation and every
 * optional function that derives attrs, inputs, outputs, or cacheability. It
 * hashes each callback's source text, so the same definition evaluated by two
 * processes agrees; a callback built with `Node.capture` hashes its captured
 * values too, so changing a captured tool or version changes the digest.
 * Source text is not the whole implementation: an ordinary closure over a
 * value JavaScript cannot inspect keeps one digest across every value it
 * closes over, and a helper the callback calls is not hashed at all. The
 * digest is therefore stable enough to key on but too coarse to be a complete
 * content key on its own. Consumers that need one, the package executor and
 * the agent verdict cache, leave it out and key on an ambient fingerprint of
 * the shipped sources instead.
 *
 * `outputs` is the declared output tree, undefined for a target that promises
 * none. Dependencies are re-derived from verb-effective attrs and may vary by
 * verb. `verbGate`, when present, is the complete set of verbs
 * whose graph may include this target, including through a dependency edge.
 *
 * @category models
 * @since 0.1.0
 */
export interface Metadata {
  readonly target: string
  readonly implementationDigest: string
  /** JSON-schema identity of the payload, success, and error contracts. */
  readonly schemaIdentity: unknown
  readonly kinds: ReadonlyArray<Kind>
  readonly attrs: unknown
  readonly attrsSchema: Flow.AnyStructSchema
  /**
   * The attrs this rule resolves from the workspace declaration when the
   * declaration omits them. The executor fills each named attr from
   * `WORKSPACE.ts` before it keys and executes the node, so a PACKAGE.ts
   * never restates the workspace's package manager or runtime.
   */
  readonly workspaceAttrs: ReadonlyArray<WorkspaceAttr>
  /** Validates an untrusted cached value against the success type in this package's Schema runtime. */
  readonly decodeSuccess: (value: unknown) => unknown
  readonly dependencies: ReadonlyArray<AnyTarget>
  readonly dependencySelectors: ReadonlyArray<DependencySelector>
  readonly inputs: ReadonlyArray<Input.Declared>
  readonly cacheable: boolean
  readonly outputs: DeclaredOutputs | undefined
  readonly verbGate: ReadonlyArray<Kind> | undefined
  /** The host platforms the target runs on, or undefined for every host. */
  readonly hosts: ReadonlyArray<string> | undefined
  /**
   * Whether a bare wildcard (`//...`, `//pkg/...`) skips the target. A label
   * or a named subtree pattern (`//pkg/...:name`) still selects it.
   */
  readonly manual: boolean
  readonly sourceFile: string | undefined
  /** The declaration's one-line summary, when it carries one; see {@link Presentation}. */
  readonly summary: string | undefined
  /** Whether the declaration marks the target featured; see {@link Presentation}. */
  readonly featured: boolean
  readonly forKind: (kind: Kind) => KindView
}

/**
 * An opaque build declaration. Execute it through the package executor;
 * use {@link plan} only to lower its action-backed implementation explicitly.
 *
 * @category models
 * @since 0.1.0
 */
export type Target<
  Id extends string = string,
  Attrs extends Flow.AnyStructSchema = Flow.AnyStructSchema,
  Success extends Schema.Top = Schema.Top,
  Error extends Schema.Top = Schema.Top,
  Requires = unknown
> = {
  readonly _tag: Id
  readonly [TargetTypeId]: Metadata
  readonly [TargetTypes]?: {
    readonly attrs: Attrs
    readonly success: Success
    readonly error: Error
    readonly requires: Requires
  }
}

/**
 * Type-erased target used for dependency edges and discovery.
 *
 * @category models
 * @since 0.1.0
 */
export type AnyTarget = { readonly _tag: string; readonly [TargetTypeId]: Metadata }

declare const TargetTypes: unique symbol
const PlanTypeId = Symbol.for("smithers-build/Target/plan")

/**
 * Lowers a target's validated declaration to its action plan without executing it.
 *
 * Package-executor-only rules produce a typed NotImplemented refusal in this
 * plan. Dependencies, tool resolution and package services must be supplied by
 * the package executor; this operation does not claim to execute those rules.
 * A host can embed an action-backed target in a Flow with `body: () => plan(target)`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const plan = <
  Id extends string,
  Attrs extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  target: Target<Id, Attrs, Success, Error, Requires>,
  attrs?: Attrs["~type.make.in"]
): Node.Node<Success["Type"], Error["Type"], Requires> => {
  const descriptor = Object.getOwnPropertyDescriptor(target, PlanTypeId)
  const implementation = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  if (typeof implementation !== "function") throw new TypeError("target has no registered plan implementation")
  return implementation(
    attrs === undefined ? metadata(target).attrs : metadata(target).attrsSchema.make(attrs, strictMake)
  )
}

/**
 * Opaque Effect Schema for direct target references in target attrs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Target = Schema.declare<AnyTarget>(
  (value): value is AnyTarget => isTarget(value),
  {
    identifier: "smithers-build/Target",
    title: "PACKAGE.ts target reference",
    description: "A direct import of another PACKAGE.ts target"
  }
)

const dependencySubtreePattern = /^\/\/(?:[A-Za-z0-9_@+=,.-]+\/)*\.\.\.$/
const dependencyTargetPattern = /^[A-Za-z0-9_@+=,.-]+$/

/**
 * A graph dependency selected from every package below one workspace subtree.
 *
 * This is the graph-native form for aggregate PACKAGE.ts targets whose
 * dependencies include synthesized packages and therefore cannot be imported
 * as target objects. Selection is intentionally narrow: a recursive package
 * pattern plus one exact exported target name.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DependencySelector = Schema.TaggedStruct("TargetDependencySelector", {
  pattern: Schema.NonEmptyString.check(
    Schema.isMaxLength(4_096),
    Schema.isPattern(dependencySubtreePattern)
  ),
  target: Schema.NonEmptyString.check(
    Schema.isMaxLength(256),
    Schema.isPattern(dependencyTargetPattern)
  )
})

/**
 * A graph dependency selected from every package below one workspace subtree.
 *
 * @category models
 * @since 0.1.0
 */
export type DependencySelector = typeof DependencySelector.Type

/**
 * A direct target dependency or a workspace subtree selection.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Dependency = Schema.Union([Target, DependencySelector])

/**
 * A direct target dependency or a workspace subtree selection.
 *
 * @category models
 * @since 0.1.0
 */
export type Dependency = typeof Dependency.Type

/**
 * Selects one exported target name from every package in a subtree.
 *
 * @example
 * ```ts
 * Smithers.Target.subtree("//packages/...", "lib")
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const subtree = (pattern: string, target: string): DependencySelector =>
  Object.freeze(DependencySelector.make({ pattern, target }))

/**
 * Error returned by every catalog stub when someone executes it.
 *
 * @category errors
 * @since 0.1.0
 */
export class NotImplemented extends Schema.TaggedError<NotImplemented>()(
  "smithers-build/NotImplemented",
  {
    target: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}

/**
 * Shared action used by catalog stubs.
 *
 * @category actions
 * @since 0.1.0
 */
export const NotImplementedAction = Action.make("smithers-build/not-implemented", {
  payload: { target: Schema.NonEmptyString },
  success: Schema.Never,
  error: NotImplemented,
  tier: "sealed"
})

/**
 * Layer that turns a catalog stub node into its typed failure.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNotImplemented: Layer.Layer<
  Action.Requirement<"smithers-build/not-implemented">,
  never,
  FlowRuntime.FlowRuntime
> = NotImplementedAction.toLayer(({ target }) =>
  Effect.fail(new NotImplemented({ target, message: `NotImplemented: ${target}` }))
)

/**
 * Produces the plan node shared by catalog target stubs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const notImplemented = (
  target: string
): Node.Node<never, NotImplemented, Action.Requirement<"smithers-build/not-implemented">> =>
  NotImplementedAction.call({ target })

/**
 * Shared placeholder for catalog rules executed by the package executor.
 *
 * @category constructors
 * @since 0.1.0
 */
export const catalogNotImplemented = () => notImplemented("catalog target")

/**
 * Checks whether a value is a PACKAGE.ts target.
 *
 * @category guards
 * @since 0.1.0
 */
export const isTarget = (value: unknown): value is AnyTarget => {
  if (!(typeof value === "function" || Predicate.isObject(value)) || NodeUtil.isProxy(value)) return false
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, TargetTypeId)
  } catch {
    return false
  }
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== false ||
    descriptor.writable !== false
  ) return false
  return isMetadata(descriptor.value)
}

const missingProperty: unique symbol = Symbol("missing metadata property")

/** Reads an own data property without invoking user code. */
const ownData = (value: object, key: PropertyKey): unknown | typeof missingProperty => {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return missingProperty
  }
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : missingProperty
}

/**
 * Checks whether a value is a workspace dependency selector.
 *
 * @category guards
 * @since 0.1.0
 */
export const isDependencySelector = (value: unknown): value is DependencySelector => {
  if (!Predicate.isObject(value) || NodeUtil.isProxy(value)) return false
  const tag = ownData(value, "_tag")
  const pattern = ownData(value, "pattern")
  const target = ownData(value, "target")
  return tag === "TargetDependencySelector" &&
    typeof pattern === "string" && dependencySubtreePattern.test(pattern) && pattern.length <= 4_096 &&
    typeof target === "string" && dependencyTargetPattern.test(target) && target.length <= 256
}

/** Whether a value is a non-proxy array whose entries satisfy a predicate. */
const isArrayOf = <A>(value: unknown, guard: (entry: unknown) => entry is A): value is ReadonlyArray<A> => {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    NodeUtil.isProxy(value) ||
    !Array.isArray(value)
  ) return false
  const length = ownData(value, "length")
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return false
  for (let index = 0; index < length; index += 1) {
    const entry = ownData(value, String(index))
    if (entry === missingProperty || !guard(entry)) return false
  }
  return true
}

/** Validates the metadata object carried by a target marker. */
const isMetadata = (value: unknown): value is Metadata => {
  if (!Predicate.isObject(value) || NodeUtil.isProxy(value)) return false
  const target = ownData(value, "target")
  const implementationDigest = ownData(value, "implementationDigest")
  const kinds = ownData(value, "kinds")
  const dependencies = ownData(value, "dependencies")
  const dependencySelectors = ownData(value, "dependencySelectors")
  const inputs = ownData(value, "inputs")
  const cacheable = ownData(value, "cacheable")
  const outputs = ownData(value, "outputs")
  const verbGate = ownData(value, "verbGate")
  const source = ownData(value, "sourceFile")
  const attrsSchema = ownData(value, "attrsSchema")
  const decodeSuccess = ownData(value, "decodeSuccess")
  const forKind = ownData(value, "forKind")
  if (
    typeof target !== "string" || target === "" ||
    typeof implementationDigest !== "string" || !/^[0-9a-f]{64}$/.test(implementationDigest) ||
    !isArrayOf(kinds, isKind) ||
    !isArrayOf(dependencies, (_entry): _entry is AnyTarget => true) ||
    !isArrayOf(dependencySelectors, isDependencySelector) ||
    !isArrayOf(inputs, (_entry): _entry is Input.Declared => true) ||
    typeof cacheable !== "boolean" ||
    (source !== undefined && typeof source !== "string") ||
    attrsSchema === missingProperty ||
    typeof decodeSuccess !== "function" ||
    typeof forKind !== "function"
  ) return false
  if (
    verbGate !== undefined &&
    !isArrayOf(verbGate, isKind)
  ) return false
  if (outputs !== undefined) {
    if (!Predicate.isObject(outputs) || NodeUtil.isProxy(outputs)) return false
    const cwd = ownData(outputs, "cwd")
    const paths = ownData(outputs, "paths")
    if (typeof cwd !== "string" || !isArrayOf(paths, (path): path is string => typeof path === "string")) return false
  }
  return ownData(value, "attrs") !== missingProperty && ownData(value, "schemaIdentity") !== missingProperty
}

/**
 * Wraps a definition in a pre-validation without erasing what it is.
 *
 * A catalog rule that has to refuse something the schema cannot express — one
 * crate selector, one artifact source — used to be written as a bare arrow
 * annotated `: Target.AnyTarget`, which threw away the `id`, `attrs` schema,
 * and `kinds` that every unwrapped rule carries, and collapsed the Flow's
 * success and error types to `Schema.Top`. Half the catalog exported one shape
 * and half the other, so no tool could read a rule's attrs schema for
 * validation, documentation, or editor support without knowing which half it
 * had. This keeps one shape: the guard runs first, and the value is still a
 * {@link Definition}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const guard = <
  Id extends string,
  Attrs extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  definition: Definition<Id, Attrs, Success, Error, Requires>,
  validate: (attrs: Attrs["~type.make.in"]) => void
): Definition<Id, Attrs, Success, Error, Requires> =>
  Object.assign(
    (attrsInput: Attrs["~type.make.in"] & Presentation): Target<Id, Attrs, Success, Error, Requires> => {
      // The pre-validation used to read the author's own object, which put a
      // read ahead of the construction boundary: a Proxy sprang its traps and
      // an enumerable getter ran before either guard refused the declaration,
      // and a getter answering differently on its two reads would be
      // validated on one value and planned on another. Validating the
      // snapshot puts every read behind the same boundary, and passing the
      // snapshot on costs a second copy of plain data rather than a second
      // read of author code.
      const site = sourceSite()
      let snapshot: Attrs["~type.make.in"] & Presentation
      try {
        snapshot = snapshotAttrs(attrsInput, 0, { count: 0 }, new Map()) as Attrs["~type.make.in"] & Presentation
      } catch (cause) {
        throw declarationRejected(definition.id, site, cause)
      }
      // The pre-validation sees the attrs alone: presentation is not its
      // business, and a validator that counts keys must not count it.
      // `splitPresentation` widens to `unknown` because it rebuilds the record
      // key by key; `validate` takes the same unresolved `Attrs` view the
      // schema's own `make` takes below, so the value passes without a cast.
      const split = splitPresentation(snapshot)
      if (typeof split === "string") throw declarationRejected(definition.id, site, new TypeError(split))
      validate(split.attrs)
      return definition(snapshot)
    },
    { id: definition.id, attrs: definition.attrs, kinds: definition.kinds }
  )

/**
 * Restores a rule's identity on the callable the catalog exports in its place.
 *
 * A few rules cannot be exported as their {@link Definition}: one takes no
 * attrs in its BUILD-era form, another returns the target with a `files`
 * projection attached. Each was written as a bare arrow, which threw away the
 * `id`, `attrs` schema, and `kinds` that every other rule carries, so a tool
 * reading a rule's attrs schema for validation, documentation, or editor
 * support saw a hole where a rule should be. This keeps the wrapper's own
 * call signature and puts the rule identity back on it.
 *
 * Use {@link guard} instead whenever the wrapper only pre-validates: it also
 * moves the validation behind the construction boundary, which this does not.
 *
 * @category constructors
 * @since 0.1.0
 */
export const rule = <
  Id extends string,
  Attrs extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires,
  Callable extends (...args: never) => unknown
>(
  definition: Definition<Id, Attrs, Success, Error, Requires>,
  callable: Callable
): Callable & { readonly id: Id; readonly attrs: Attrs; readonly kinds: ReadonlyArray<Kind> } =>
  Object.assign(callable, { id: definition.id, attrs: definition.attrs, kinds: definition.kinds })

/**
 * Reads the planner metadata attached by {@link make}.
 *
 * @category accessors
 * @since 0.1.0
 */
export const metadata = (target: AnyTarget): Metadata => {
  if (!isTarget(target)) throw new TypeError("value is not a well-formed smithers build target")
  return ownData(target, TargetTypeId) as Metadata
}

/**
 * A callable target definition.
 *
 * @category models
 * @since 0.1.0
 */
export interface Definition<
  Id extends string,
  Attrs extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
> {
  (attrs: Attrs["~type.make.in"] & Presentation): Target<Id, Attrs, Success, Error, Requires>
  readonly id: Id
  readonly attrs: Attrs
  readonly kinds: ReadonlyArray<Kind>
}

/**
 * Declaration-site context passed to a target implementation.
 *
 * `packageDirectory` is the absolute directory containing the declaring
 * PACKAGE.ts file. It is undefined only when a target was constructed outside a
 * PACKAGE.ts module.
 *
 * @category models
 * @since 0.1.0
 */
export interface ImplementationContext {
  readonly sourceFile: string | undefined
  readonly packageDirectory: string | undefined
}

type ResultSchema<S extends Schema.Top, A> = [S] extends [never] ? Schema.Schema<A> : S

/**
 * Options accepted by {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<
  Attrs extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
> {
  readonly attrs: Attrs
  readonly kinds: ReadonlyArray<Kind>
  /**
   * The attrs the executor fills from the workspace declaration when the
   * declaration omits them; see {@link Metadata.workspaceAttrs}.
   */
  readonly workspaceAttrs?: ReadonlyArray<WorkspaceAttr> | undefined
  readonly success?: Success | undefined
  readonly error?: Error | undefined
  readonly implementation: (
    attrs: Attrs["Type"],
    context: ImplementationContext
  ) => Node.Node<ResultSchema<Success, unknown>["Type"], ResultSchema<Error, unknown>["Type"], Requires>
  readonly inputs?: ((attrs: Attrs["Type"]) => ReadonlyArray<Input.Declared>) | undefined
  /**
   * The complete output tree this target promises to produce, derived from
   * decoded attrs. A target that declares one must return a matching output
   * manifest from every successful execution; see
   * {@link ToolBuild.captureOutputs}.
   */
  readonly outputs?: ((attrs: Attrs["Type"]) => DeclaredOutputs) | undefined
  /**
   * Whether executor results may be replayed across runs. The default is
   * false: arbitrary target bodies can consult tools, services, or host state
   * that attrs and declared inputs do not identify. A target opts in only after
   * its implementation has a complete deterministic input contract.
   */
  readonly cache?: boolean | ((attrs: Attrs["Type"]) => boolean) | undefined
  readonly attrsForKind?: ((kind: Kind, attrs: Attrs["Type"]) => Attrs["Type"]) | undefined
  /**
   * The host platforms, as `process.platform` names them, a declaration may
   * run on; undefined, or no option, means every host. The package planner
   * omits a restricted target from wildcard selections on other hosts and
   * refuses it by name there.
   */
  readonly hosts?: ((attrs: Attrs["Type"]) => ReadonlyArray<string> | undefined) | undefined
  /**
   * Whether a declaration is manual: the package planner omits it from bare
   * wildcard selections (`//...`, `//pkg/...`) and selects it only by label or
   * by a named subtree pattern (`//pkg/...:name`), the way Bazel treats a
   * `manual` tag. Use it for an expensive target a person asks for by name.
   */
  readonly manual?: ((attrs: Attrs["Type"]) => boolean) | undefined
  readonly verbGate?:
    | ReadonlyArray<Kind>
    | ((attrs: Attrs["Type"]) => ReadonlyArray<Kind> | undefined)
    | undefined
}

const collect = (
  value: unknown,
  inputs: Array<Input.Declared>,
  dependencies: Array<AnyTarget>,
  dependencySelectors: Array<DependencySelector>,
  seen: Set<object>
): void => {
  if (
    (typeof value === "object" && value !== null || typeof value === "function") &&
    NodeUtil.isProxy(value)
  ) {
    throw new TypeError("target attrs must not contain a Proxy")
  }
  if (isTarget(value)) {
    dependencies.push(value)
    return
  }
  if (isDependencySelector(value)) {
    dependencySelectors.push(subtree(value.pattern, value.target))
    return
  }
  if (Input.isDeclared(value)) {
    inputs.push(value)
    return
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value)
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      names.length !== value.length + 1 ||
      names.at(-1) !== "length" ||
      Object.getOwnPropertySymbols(value).length > 0
    ) return
    for (let index = 0; index < value.length; index += 1) {
      if (names[index] !== String(index)) return
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined) return
      // A non-data element is rejected rather than skipped: skipping the rest
      // would drop a declared input the target still reads, which keys the
      // target on fewer inputs than it consumes.
      if (!("value" in descriptor)) throw nonDataProperty(String(index))
      if (descriptor.enumerable !== true) continue
      collect(descriptor.value, inputs, dependencies, dependencySelectors, seen)
    }
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  if (Object.getOwnPropertySymbols(value).length > 0) return
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) return
    if (!("value" in descriptor)) throw nonDataProperty(key)
    if (descriptor.enumerable !== true) continue
    collect(descriptor.value, inputs, dependencies, dependencySelectors, seen)
  }
}

const nonDataProperty = (key: string): TypeError =>
  new TypeError(`target attrs must contain only enumerable data properties; ${JSON.stringify(key)} is an accessor`)

/**
 * Names the constructor of a value the snapshot refuses to walk.
 *
 * The name is read off the prototype's own `constructor` descriptor rather
 * than through a property access, so a hostile prototype cannot run a getter
 * while the declaration is being rejected.
 */
const exoticValue = (value: object): TypeError => {
  const prototype = Object.getPrototypeOf(value) as object | null
  const descriptor = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "constructor")
  const constructor = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  const name = typeof constructor === "function" && typeof constructor.name === "string" && constructor.name !== ""
    ? constructor.name
    : "an object with a prototype of its own"
  return new TypeError(
    `target attrs must contain only plain data, targets, dependency selectors, and declared inputs; got ${name}`
  )
}

/**
 * Attrs nesting one declaration may reach.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumAttrsDepth = 64

/**
 * Members one declaration's attrs may carry, counted across the whole tree.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumAttrsMembers = 100_000

/**
 * Copies author input into a bounded, null-hostile snapshot before anything
 * reads it as attrs.
 *
 * The schema decode used to run first, which meant the Proxy and descriptor
 * guards only ever saw the decoded value: a Proxy sprang its traps and an
 * enumerable getter was invoked — twice — before either guard could refuse it.
 * A getter that answers differently on its two reads would key the target on
 * one value and plan another, so the author's object is read exactly once,
 * as data, and every later read is of this copy.
 *
 * Targets and dependency selectors retain their handle identity. Declared
 * inputs are plain records and are copied so even an Unknown schema owns
 * the data it will later freeze. Other non-plain values are refused.
 */
const snapshotAttrs = (
  value: unknown,
  depth: number,
  budget: { count: number },
  seen: Map<object, unknown>
): unknown => {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    if (NodeUtil.isProxy(value)) throw new TypeError("target attrs must not contain a Proxy")
  }
  if (typeof value !== "object" || value === null) return value
  if (isTarget(value) || isDependencySelector(value)) return value
  const prototype = Object.getPrototypeOf(value)
  const isPlainArray = Array.isArray(value) && prototype === Array.prototype
  // Targets and dependency selectors are recognized handles. Anything else
  // carrying a prototype of its own used to pass through
  // unwalked, which let a class instance reach the schema with its accessors
  // intact: the decode invoked them, so the accessor guard this snapshot
  // exists to enforce was skipped for exactly the values that could defeat
  // it. An unrecognized exotic value is refused instead of trusted.
  if (!isPlainArray && prototype !== Object.prototype && prototype !== null) throw exoticValue(value)
  // A value reached twice keeps one copy, which is also what makes a cyclic
  // declaration terminate here instead of running out the depth bound.
  const existing = seen.get(value)
  if (existing !== undefined) return existing
  if (depth >= maximumAttrsDepth) throw new RangeError("target attrs nest deeper than the declaration bound")
  const spend = (): void => {
    budget.count += 1
    if (budget.count > maximumAttrsMembers) {
      throw new RangeError("target attrs carry more members than the declaration bound")
    }
  }
  if (isPlainArray) {
    const copy: Array<unknown> = []
    seen.set(value, copy)
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor !== undefined && !("value" in descriptor)) throw nonDataProperty(String(index))
      spend()
      copy.push(descriptor === undefined ? undefined : snapshotAttrs(descriptor.value, depth + 1, budget, seen))
    }
    return copy
  }
  const copy: Record<string, unknown> = {}
  seen.set(value, copy)
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) continue
    if (!("value" in descriptor)) throw nonDataProperty(key)
    if (descriptor.enumerable !== true) continue
    spend()
    copy[key] = snapshotAttrs(descriptor.value, depth + 1, budget, seen)
  }
  return copy
}

/**
 * Freezes a decoded value and everything the target owns inside it.
 *
 * Targets and dependency selectors are handles the author still holds, so
 * they are left alone. Declared input records, like the other plain data,
 * were copied by {@link snapshotAttrs} or the schema and belong to this target.
 */
const freezeOwned = (value: unknown): void => {
  if (typeof value !== "object" || value === null) return
  if (Object.isFrozen(value)) return
  if (isTarget(value) || isDependencySelector(value)) return
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return
  Object.freeze(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && "value" in descriptor) freezeOwned(descriptor.value)
  }
}

/**
 * Freezes a schema-identity document and everything reachable inside it.
 *
 * The `Metadata` record was frozen while the JSON-schema documents hanging off
 * `schemaIdentity` were not, so the one part of the metadata that is key
 * material for the planner stayed writable after the checks that validated it:
 * assigning `metadata.schemaIdentity.attrs` changed what every later reader
 * saw. These documents are produced here and belong to this definition, so
 * nothing outside may write them. A `Set` of visited objects, rather than the
 * `Object.isFrozen` shortcut, is what terminates on a `$ref` cycle.
 */
const freezeDocument = <A>(document: A, seen: Set<object> = new Set()): A => {
  if (typeof document !== "object" || document === null || seen.has(document)) return document
  seen.add(document)
  Object.freeze(document)
  for (const key of Object.getOwnPropertyNames(document)) {
    const descriptor = Object.getOwnPropertyDescriptor(document, key)
    if (descriptor !== undefined && "value" in descriptor) freezeDocument(descriptor.value, seen)
  }
  return document
}

const freezeView = (view: KindView): KindView => {
  freezeOwned(view.attrs)
  Object.freeze(view.dependencies)
  Object.freeze(view.dependencySelectors)
  Object.freeze(view.inputs)
  if (view.outputs !== undefined) {
    Object.freeze(view.outputs.paths)
    Object.freeze(view.outputs)
  }
  return Object.freeze(view)
}

/**
 * The PACKAGE.ts call site a declaration was written at.
 *
 * `path` alone identifies the declaring package. `line` and `column` are
 * reported back to the author when a declaration is rejected, and are absent
 * when the host does not expose them.
 */
interface SourceSite {
  readonly path: string
  readonly line: number | undefined
  readonly column: number | undefined
}

const sourceSite = (): SourceSite | undefined => {
  let sites: ReturnType<typeof getCallSites>
  try {
    sites = getCallSites(100, { sourceMap: true })
  } catch {
    return undefined
  }
  for (const site of sites) {
    let file = site.scriptName
    try {
      if (file.startsWith("file:")) file = fileURLToPath(file)
    } catch {
      continue
    }
    // PACKAGE.ts and WORKSPACE.ts are the routed declarations. The site is
    // diagnostic context only — build-system
    // labels come exclusively from the package index, never from this stack.
    const basename = NodePath.basename(file)
    if (basename !== "PACKAGE.ts" && basename !== "WORKSPACE.ts") continue
    const positive = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
    return { path: NodePath.resolve(file), line: positive(site.lineNumber), column: positive(site.columnNumber) }
  }
  return undefined
}

/**
 * Maximum UTF-16 code units of formatted schema detail admitted into one
 * declaration-rejected message.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumRejectionDetailCodeUnits = 8 * 1024

const formatIssue = SchemaIssue.makeFormatterDefault()

/**
 * Maximum accepted keys listed in one unknown-property line before the rest
 * are elided. A struct with a long attr list would otherwise bury the
 * suggestion under its own inventory.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumListedKeys = 12

/**
 * Maximum unknown-property lines appended to one rejection. An author who
 * mistyped a dozen keys is told about the first few and fixes the rest by the
 * same rule.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumGuidanceLines = 5

/** Levenshtein distance, bounded: it stops caring once the edit count exceeds `limit`. */
const distance = (a: string, b: string, limit: number): number => {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[b.length]!
}

/**
 * The accepted key an author most likely meant, or `undefined` when none is
 * close enough to name. A case-only difference always wins; otherwise the
 * nearest key within a third of its own length, so `cwdd` suggests `cwd` and
 * `zzzzzzzz` suggests nothing.
 */
const nearest = (rejected: string, accepted: ReadonlyArray<string>): string | undefined => {
  const folded = rejected.toLowerCase()
  const sameLetters = accepted.find((key) => key.toLowerCase() === folded)
  if (sameLetters !== undefined) return sameLetters
  let best: { readonly key: string; readonly edits: number } | undefined
  for (const key of accepted) {
    const limit = Math.max(1, Math.floor(Math.max(key.length, rejected.length) / 3))
    const edits = distance(folded, key.toLowerCase(), limit)
    if (edits <= limit && (best === undefined || edits < best.edits)) best = { key, edits }
  }
  return best?.key
}

/** The property names one struct AST accepts, read as own data so no author code runs. */
const acceptedKeys = (ast: unknown): ReadonlyArray<string> => {
  if (typeof ast !== "object" || ast === null || NodeUtil.isProxy(ast)) return []
  const descriptor = Object.getOwnPropertyDescriptor(ast, "propertySignatures")
  if (descriptor === undefined || !("value" in descriptor) || !Array.isArray(descriptor.value)) return []
  const names: Array<string> = []
  for (const signature of descriptor.value) {
    if (typeof signature !== "object" || signature === null) continue
    const name = Object.getOwnPropertyDescriptor(signature, "name")
    if (name !== undefined && "value" in name && typeof name.value === "string") names.push(name.value)
  }
  return names
}

/**
 * Turns every `UnexpectedKey` in one issue tree into a line an author can act
 * on: the rejected key, where it sits, the nearest accepted key, and the keys
 * the enclosing struct does accept.
 *
 * The formatted issue alone reports that a property is not accepted and never
 * what is, so an author has to open the rule's source to learn the rest. The
 * enclosing struct's AST travels on the `UnexpectedKey` issue itself, so the
 * remedy costs no schema plumbing.
 */
const unknownPropertyGuidance = (issue: unknown): ReadonlyArray<string> => {
  const lines: Array<string> = []
  const visit = (node: unknown, path: ReadonlyArray<PropertyKey>): void => {
    if (lines.length >= maximumGuidanceLines) return
    if (typeof node !== "object" || node === null || NodeUtil.isProxy(node)) return
    const tag = Object.getOwnPropertyDescriptor(node, "_tag")
    const name = tag !== undefined && "value" in tag ? tag.value : undefined
    if (name === "Pointer") {
      const own = Object.getOwnPropertyDescriptor(node, "path")
      const segments = own !== undefined && "value" in own && Array.isArray(own.value) ? own.value : []
      const inner = Object.getOwnPropertyDescriptor(node, "issue")
      if (inner !== undefined && "value" in inner) visit(inner.value, [...path, ...segments])
      return
    }
    if (name === "Composite") {
      const own = Object.getOwnPropertyDescriptor(node, "issues")
      const children = own !== undefined && "value" in own && Array.isArray(own.value) ? own.value : []
      for (const child of children) visit(child, path)
      return
    }
    if (name !== "UnexpectedKey") return
    const rejected = path[path.length - 1]
    if (typeof rejected !== "string") return
    const ast = Object.getOwnPropertyDescriptor(node, "ast")
    const accepted = acceptedKeys(ast !== undefined && "value" in ast ? ast.value : undefined)
    const parents = path.slice(0, -1).filter((segment) => typeof segment === "string")
    const where = parents.length === 0 ? "" : ` at ${JSON.stringify(parents.join("."))}`
    const suggestion = nearest(rejected, accepted)
    const listed = accepted.length > maximumListedKeys
      ? `${accepted.slice(0, maximumListedKeys).join(", ")}, and ${accepted.length - maximumListedKeys} more`
      : accepted.join(", ")
    // A question mark ends the clause, so the key list that follows it opens
    // with a space rather than another semicolon.
    const asked = suggestion === undefined ? "" : `; did you mean ${JSON.stringify(suggestion)}?`
    const separator = listed === "" ? "" : asked === "" ? "; " : " "
    lines.push(
      `unknown property ${JSON.stringify(rejected)}${where}${asked}` +
        `${separator}${listed === "" ? "" : `accepted: ${listed}`}`
    )
  }
  visit(issue, [])
  return lines
}

/**
 * Renders why one declaration was rejected, without running author code.
 *
 * A rejected `Schema.make` carries the structured issue on `cause`. Reporting
 * only the constructor's own `"Schema validation failed"` loses the path and
 * the expectation, which is the whole content of the failure: an author is
 * told a BUILD file is invalid without being told which attr is wrong. The
 * issue is formatted when it is one, and otherwise the message is taken from
 * an own data property so an author-supplied accessor or Proxy cannot run.
 */
const rejectionDetail = (cause: unknown): string | undefined => {
  const bound = (text: string): string | undefined => {
    const wellFormed = text.isWellFormed() ? text : text.toWellFormed()
    if (wellFormed === "") return undefined
    return wellFormed.length <= maximumRejectionDetailCodeUnits
      ? wellFormed
      : `${wellFormed.slice(0, maximumRejectionDetailCodeUnits - 3)}...`
  }
  if (typeof cause !== "object" || cause === null || NodeUtil.isProxy(cause)) return undefined
  const issue = Object.getOwnPropertyDescriptor(cause, "cause")
  if (issue !== undefined && "value" in issue && SchemaIssue.isIssue(issue.value)) {
    try {
      const guidance = unknownPropertyGuidance(issue.value)
      const formatted = formatIssue(issue.value)
      return bound(guidance.length === 0 ? formatted : `${formatted}\n  ${guidance.join("\n  ")}`)
    } catch {
      // Fall through to the plain message below.
    }
  }
  const message = Object.getOwnPropertyDescriptor(cause, "message")
  return message !== undefined && "value" in message && typeof message.value === "string"
    ? bound(message.value)
    : undefined
}

/**
 * Rejects one declaration with the target, the authoring site, and the reason.
 *
 * @category errors
 * @since 0.1.0
 */
export const declarationRejected = (id: string, site: SourceSite | undefined, cause: unknown): Error => {
  const where = site === undefined
    ? ""
    : ` at ${site.path}${
      site.line === undefined ? "" : `:${site.line}${site.column === undefined ? "" : `:${site.column}`}`
    }`
  const detail = rejectionDetail(cause)
  return new Error(
    `${id} declaration${where} is invalid${detail === undefined ? "" : `: ${detail}`}`,
    { cause }
  )
}

/**
 * Every target constructor validates attrs with excess properties as errors.
 *
 * `Schema.Struct.make` strips unknown keys by default, so a misspelled attr
 * (`gate` for `gates`, `approvals` for `approval`) would construct a green
 * target with the edge or safety attr silently absent. Declaration input is
 * author-written and there is no other guard in the pipeline (PACKAGE.ts is
 * loaded without typechecking), so an unknown key is a rejected declaration,
 * never a dropped one. The option applies recursively, so a nested struct
 * such as `readiness` rejects unknown keys too.
 */
const strictMake = { parseOptions: { onExcessProperty: "error" } } as const

/**
 * Identifies a declaration function by its source text alone, so the same
 * definition evaluated in two processes hashes to the same value. A function
 * declared with `Node.capture` keeps its capture-aware identity, which is
 * stable too: it folds in the captured values, never a process nonce.
 */
const sourceIdentity = (operation: unknown): Node.FunctionIdentity => {
  if (typeof operation !== "function") throw new TypeError("function identity requires a function")
  const identity = Node.functionIdentity(operation)
  if (identity.algorithm === "sha256-source-captures/v5") return identity
  return {
    _tag: "FunctionIdentity",
    algorithm: "static-node/v1",
    digest: createHash("sha256").update(Function.prototype.toString.call(operation)).digest("hex")
  }
}

/**
 * Creates an opaque target with validated attrs and a pure plan implementation.
 *
 * Supplied success and error schemas constrain the implementation node. An
 * omitted channel is inferred from the node and uses Unknown at runtime,
 * preserving its value without applying schema validation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  const Id extends string,
  Attrs extends Flow.AnyStructSchema,
  Success extends Schema.Top = never,
  Error extends Schema.Top = never,
  Requires = never,
  Implementation extends Node.Node<unknown, unknown, Requires> = Node.Node<unknown, unknown, Requires>
>(
  id: Id,
  options: MakeOptions<Attrs, Success, Error, Requires> & {
    readonly implementation: (attrs: Attrs["Type"], context: ImplementationContext) => Implementation
  }
): Definition<
  Id,
  Attrs,
  ResultSchema<Success, Node.Success<Implementation>>,
  ResultSchema<Error, Node.Error<Implementation>>,
  Requires
> => {
  const workspaceAttrs: ReadonlyArray<WorkspaceAttr> = Object.freeze([...new Set(options.workspaceAttrs ?? [])])
  const successSchema = options.success ?? Schema.Unknown
  const errorSchema = options.error ?? Schema.Unknown
  const decodeSuccess = Schema.decodeUnknownSync(Schema.toType(successSchema))
  const schemaIdentity = freezeDocument({
    attrs: Schema.toJsonSchemaDocument(options.attrs, { onExcessProperty: "error" }),
    success: Schema.toJsonSchemaDocument(successSchema, { onExcessProperty: "error" }),
    error: Schema.toJsonSchemaDocument(errorSchema, { onExcessProperty: "error" })
  })
  // The digest identifies the text of the functions a declaration passes in.
  // `Node.functionIdentity` is the wrong tool for that: for an uncaptured
  // function it folds in a per-process nonce, which is right for a plan node
  // (two closures with one source may hold different state) and fatal here,
  // because the digest is content-key material and a key that changes per
  // process can never hit a cache another process filled. A captured
  // function keeps its capture-aware identity; a plain one is its source.
  const functionIdentity = (operation: unknown): Node.FunctionIdentity | null =>
    operation === undefined ? null : sourceIdentity(operation)
  const implementationDigest = createHash("sha256").update(JSON.stringify({
    implementation: functionIdentity(options.implementation),
    attrsForKind: functionIdentity(options.attrsForKind),
    cache: typeof options.cache === "function"
      ? ["function", sourceIdentity(options.cache)]
      : ["constant", options.cache ?? false],
    inputs: functionIdentity(options.inputs),
    outputs: functionIdentity(options.outputs),
    hosts: functionIdentity(options.hosts),
    manual: functionIdentity(options.manual),
    verbGate: typeof options.verbGate === "function"
      ? sourceIdentity(options.verbGate)
      : options.verbGate ?? null,
    schemas: schemaIdentity
  })).digest("hex")
  const definition = (attrsInput: Attrs["~type.make.in"] & Presentation) => {
    // Resolved before the attrs are constructed so a rejection can name the
    // PACKAGE.ts line the author has to edit.
    const site = sourceSite()
    let attrs: Attrs["Type"]
    let presentation: DeclaredPresentation
    try {
      const split = splitPresentation(snapshotAttrs(attrsInput, 0, { count: 0 }, new Map()))
      if (typeof split === "string") throw new TypeError(split)
      presentation = split.presentation
      attrs = options.attrs.make(split.attrs, strictMake)
    } catch (cause) {
      throw declarationRejected(id, site, cause)
    }
    const declarationSourceFile = site?.path
    const context: ImplementationContext = {
      sourceFile: declarationSourceFile,
      packageDirectory: declarationSourceFile === undefined ? undefined : NodePath.dirname(declarationSourceFile)
    }
    const inputs: Array<Input.Declared> = []
    const dependencies: Array<AnyTarget> = []
    const dependencySelectors: Array<DependencySelector> = []
    collect(attrs, inputs, dependencies, dependencySelectors, new Set())
    if (options.inputs !== undefined) inputs.push(...options.inputs(attrs))
    const cacheableFor = (value: Attrs["Type"]): boolean =>
      typeof options.cache === "function" ? options.cache(value) : options.cache ?? false
    const resolvedVerbGate = typeof options.verbGate === "function" ? options.verbGate(attrs) : options.verbGate
    const verbGate = resolvedVerbGate === undefined ? undefined : [...new Set(resolvedVerbGate)]
    const hosts = options.hosts?.(attrs)
    const outputsFor = (value: Attrs["Type"]): DeclaredOutputs | undefined =>
      options.outputs === undefined ? undefined : declaredOutputs(id, options.outputs(value))
    const baseView: KindView = freezeView({
      attrs,
      dependencies: [...new Set(dependencies)],
      dependencySelectors: [...new Map(dependencySelectors.map((selector) => [
        `${selector.pattern}\0${selector.target}`,
        selector
      ])).values()],
      inputs: [...new Set(inputs)],
      cacheable: cacheableFor(attrs),
      outputs: outputsFor(attrs)
    })
    const kindViews = new Map<Kind, KindView>()
    const forKind = (kind: Kind): KindView => {
      if (options.attrsForKind === undefined) return baseView
      const cached = kindViews.get(kind)
      if (cached !== undefined) return cached
      const candidate = options.attrsForKind(kind, attrs)
      if (candidate === attrs) {
        kindViews.set(kind, baseView)
        return baseView
      }
      let mapped: Attrs["Type"]
      try {
        mapped = options.attrs.make(snapshotAttrs(candidate, 0, { count: 0 }, new Map()), strictMake)
      } catch (cause) {
        throw declarationRejected(`${id} (${kind})`, site, cause)
      }
      const mappedInputs: Array<Input.Declared> = []
      const mappedDependencies: Array<AnyTarget> = []
      const mappedDependencySelectors: Array<DependencySelector> = []
      collect(mapped, mappedInputs, mappedDependencies, mappedDependencySelectors, new Set())
      if (options.inputs !== undefined) mappedInputs.push(...options.inputs(mapped))
      const dependenciesForKind = [...new Set(mappedDependencies)]
      const view: KindView = freezeView({
        attrs: mapped,
        dependencies: dependenciesForKind,
        dependencySelectors: [...new Map(mappedDependencySelectors.map((selector) => [
          `${selector.pattern}\0${selector.target}`,
          selector
        ])).values()],
        inputs: [...new Set(mappedInputs)],
        cacheable: cacheableFor(mapped),
        outputs: outputsFor(mapped)
      })
      kindViews.set(kind, view)
      return view
    }
    const target = { _tag: id }
    const value: Metadata = Object.freeze({
      target: id,
      implementationDigest,
      schemaIdentity,
      kinds: Object.freeze([...new Set(options.kinds)]),
      attrs,
      attrsSchema: options.attrs,
      workspaceAttrs,
      decodeSuccess,
      dependencies: baseView.dependencies,
      dependencySelectors: baseView.dependencySelectors,
      inputs: baseView.inputs,
      cacheable: baseView.cacheable,
      outputs: baseView.outputs,
      verbGate: verbGate === undefined ? undefined : Object.freeze(verbGate),
      hosts: hosts === undefined ? undefined : Object.freeze([...hosts]),
      manual: options.manual?.(attrs) === true,
      sourceFile: declarationSourceFile,
      summary: presentation.summary,
      featured: presentation.featured,
      forKind
    })
    Object.defineProperty(target, TargetTypeId, {
      configurable: false,
      enumerable: false,
      value,
      writable: false
    })
    const declaration = target as unknown as Target<
      Id,
      Attrs,
      ResultSchema<Success, Node.Success<Implementation>>,
      ResultSchema<Error, Node.Error<Implementation>>,
      Requires
    >
    Object.defineProperty(declaration, PlanTypeId, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (value: unknown) => options.implementation(value as Attrs["Type"], context)
    })
    return declaration
  }
  return Object.assign(definition, {
    id,
    attrs: options.attrs,
    kinds: [...new Set(options.kinds)]
  })
}
