/**
 * Bounded-parallel execution of planned targets.
 *
 * Targets execute in dependency order with keep-going semantics: a failure
 * fails the run but skips only its dependent cone, every other target still
 * runs, and every result is collected. Each target's Flow runs through the
 * same in-memory flows runtime the install command uses, with the shared exec
 * action implemented by `ExecLive`, the generated-file actions implemented by
 * `WriteFileLive` and `CheckFileLive`, the documentation-parity action
 * implemented by `CheckDocsLive`, the file-group expansion implemented by
 * `ExpandFilegroupLive`, and cacheable green results stored in the
 * workspace cache.
 *
 * @since 0.1.0
 */
import * as Target from "@smthrs/targets/Target"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Queue from "effect/Queue"
import * as SchemaIssue from "effect/SchemaIssue"
import type * as Scope from "effect/Scope"
import * as Os from "node:os"
import * as NodeUtil from "node:util/types"
import { entryLimit } from "./Cache.ts"
import * as Diagnostic from "./Diagnostic.ts"
import { byCodeUnit } from "./internal/Text.ts"
import type * as Planner from "./Planner.ts"

/**
 * One target's reported execution outcome.
 *
 * `hit` answered from the cache, `ran` executed green, `failed` executed and
 * failed, and `skipped` never ran because a dependency did not succeed.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface TargetReport {
  readonly label: string
  readonly target: string
  readonly status: "hit" | "ran" | "failed" | "skipped"
  readonly durationMs: number
  readonly key: string
  readonly error?: string | undefined
  /** The dependency whose red outcome kept a `skipped` target from running. */
  readonly blockedBy?: string | undefined
}

/**
 * Per-status result counts for one execution.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface StatusCounts {
  readonly hit: number
  readonly ran: number
  readonly failed: number
  readonly skipped: number
}

/**
 * What one execution reports: every target's outcome in plan order plus the
 * verdict `ok`, false when any target failed.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Summary {
  readonly verb: string
  readonly pattern: string
  readonly jobs: number
  readonly durationMs: number
  readonly counts: StatusCounts
  readonly ok: boolean
  readonly results: ReadonlyArray<TargetReport>
}

/**
 * Options accepted by {@link execute}.
 *
 * `jobs` bounds concurrent targets, must be a positive integer, and defaults
 * to the host parallelism.
 * `readCache` false bypasses cache reads while green results are still
 * written. `remoteCache` is resolved host state and never key material. `signal`
 * interrupts every running target. `reporter` receives every execution event;
 * without one, `log` receives one plain status line per settled target and
 * the end summary, and defaults to standard error.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
/**
 * Several verb plans over one pattern merged into a single execution set.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MergedPlan {
  readonly roots: ReadonlyArray<string>
  readonly targets: ReadonlyArray<Planner.PlannedTarget>
  readonly edges: ReadonlyArray<Planner.Edge>
  readonly warnings: ReadonlyArray<string>
}

/**
 * Merges verb plans into the closure of the selected per-label views.
 *
 * Equal-key duplicate views collapse. When lint and a writing verb disagree,
 * lint wins so CI checks drift without mutating it. Two different non-lint
 * views are ambiguous and fail instead of silently dropping one action. The
 * dependency closure and edges are rebuilt from the winning views; otherwise
 * a dependency that belonged only to a discarded build view would still run.
 *
 * @category planning
 * @since 0.1.0
 * @slop
 */
export const mergePlans = (plans: ReadonlyArray<Planner.Plan>): MergedPlan => {
  const roots: Array<string> = []
  const warnings: Array<string> = []
  const seenRoots = new Set<string>()
  const selectedTargets = new Map<
    string,
    { readonly target: Planner.PlannedTarget; readonly verb: Planner.Plan["verb"] }
  >()
  const seenWarnings = new Set<string>()
  for (const plan of plans) {
    for (const root of plan.roots) {
      if (seenRoots.has(root)) continue
      seenRoots.add(root)
      roots.push(root)
    }
    for (const target of plan.targets) {
      const selected = selectedTargets.get(target.label)
      if (selected === undefined) {
        selectedTargets.set(target.label, { target, verb: plan.verb })
        continue
      }
      if (selected.target.keyPreview === target.keyPreview) continue
      if (plan.verb === "lint" && selected.verb !== "lint") {
        selectedTargets.set(target.label, { target, verb: plan.verb })
        continue
      }
      if (selected.verb === "lint" && plan.verb !== "lint") continue
      throw new Error(
        `cannot merge ${selected.verb} and ${plan.verb} plans: ${target.label} has incompatible execution views`
      )
    }
    for (const warning of plan.warnings) {
      if (seenWarnings.has(warning)) continue
      seenWarnings.add(warning)
      warnings.push(warning)
    }
  }
  const targets: Array<Planner.PlannedTarget> = []
  const edges: Array<Planner.Edge> = []
  const complete = new Set<string>()
  const visiting = new Set<string>()
  const visit = (label: string): void => {
    if (complete.has(label)) return
    if (visiting.has(label)) throw new Error(`merged dependency cycle reaches ${label}`)
    const selected = selectedTargets.get(label)
    if (selected === undefined) throw new Error(`merged plan depends on missing target ${label}`)
    visiting.add(label)
    for (const dependency of selected.target.dependencies) {
      visit(dependency)
      edges.push({ from: dependency, to: label })
    }
    visiting.delete(label)
    complete.add(label)
    targets.push(selected.target)
  }
  for (const root of roots) visit(root)
  return { roots, targets, edges, warnings }
}

/**
 * Resolves the concurrency bound one execution runs under.
 *
 * The CLI validates its own flag, so this guards the programmatic call. A
 * non-integer bound is rejected instead of clamped: `NaN` silently scheduled
 * zero targets and reported a green summary for a run that never happened.
 *
 * @category execution
 * @since 0.1.0
 * @slop
 */
export const resolveJobs = (jobs?: number | undefined): number => {
  if (jobs === undefined) return Math.max(1, Os.availableParallelism())
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new TypeError(
      `jobs must be a positive integer, received ${typeof jobs === "number" ? String(jobs) : typeof jobs}`
    )
  }
  return jobs
}

/**
 * Validates a work list before anything is dispatched.
 *
 * Every one of these was previously either accepted silently or discovered
 * only by the scheduler running out of ready work. A duplicate label makes two
 * targets share one completion slot, so one of them is dropped and the other's
 * dependents are released early. An unknown dependency used to be filtered out,
 * which released a dependent whose dependency was never in the graph. A
 * self-dependency and a cycle are both unsatisfiable and used to be reported
 * only after every acyclic target had already executed. Reporting them here
 * means an unschedulable graph never runs half of itself first.
 *
 * Diagnostics are deterministic: offenders are listed in code-unit order.
 */
const validateWorkList = (targets: ReadonlyArray<Planner.PlannedTarget>): string | undefined => {
  const labels = new Set<string>()
  const duplicates = new Set<string>()
  for (const target of targets) {
    if (labels.has(target.label)) duplicates.add(target.label)
    labels.add(target.label)
  }
  if (duplicates.size > 0) {
    return `the work list names ${[...duplicates].sort(byCodeUnit).join(", ")} more than once`
  }
  for (const target of targets) {
    const seen = new Set<string>()
    for (const dependency of target.dependencies) {
      if (dependency === target.label) return `${target.label} depends on itself`
      if (seen.has(dependency)) return `${target.label} lists the dependency ${dependency} more than once`
      seen.add(dependency)
      if (!labels.has(dependency)) {
        return `${target.label} depends on ${dependency}, which is not in the work list`
      }
    }
  }
  // Kahn's algorithm over the validated graph. Whatever it cannot reach lies on
  // or below a cycle.
  const remaining = new Map(targets.map((target) => [target.label, target.dependencies.length]))
  const dependents = new Map<string, Array<string>>()
  for (const target of targets) {
    for (const dependency of target.dependencies) {
      const entry = dependents.get(dependency)
      if (entry === undefined) dependents.set(dependency, [target.label])
      else entry.push(target.label)
    }
  }
  const queue = targets.filter((target) => target.dependencies.length === 0).map((target) => target.label)
  let settled = 0
  for (let index = 0; index < queue.length; index += 1) {
    settled += 1
    for (const dependent of dependents.get(queue[index]!) ?? []) {
      const left = remaining.get(dependent)! - 1
      remaining.set(dependent, left)
      if (left === 0) queue.push(dependent)
    }
  }
  if (settled !== targets.length) {
    const stalled = targets
      .filter((target) => (remaining.get(target.label) ?? 0) > 0)
      .map((target) => target.label)
      .sort(byCodeUnit)
    return `${targets.length - settled} of ${targets.length} targets never became ready ` +
      `(dependency graph is not satisfiable): ${stalled.join(", ")}`
  }
  return undefined
}

/**
 * Runs a dependency frontier with scoped workers. Each worker releases its
 * resources before its completion can make a dependent ready.
 * @category execution
 * @since 1.0.0
 */
export const scheduleEffect = <E, R>(
  targets: ReadonlyArray<Planner.PlannedTarget>,
  jobs: number,
  runOne: (label: string) => Effect.Effect<void, E, R>,
  signal?: AbortSignal | undefined
): Effect.Effect<void, Error, Exclude<R, Scope.Scope>> =>
  Effect.scoped(Effect.gen(function*() {
    if (!Number.isInteger(jobs) || jobs < 1) {
      return yield* Effect.fail(
        new TypeError(
          `jobs must be a positive integer, received ${typeof jobs === "number" ? String(jobs) : typeof jobs}`
        )
      )
    }
    const invalid = validateWorkList(targets)
    if (invalid !== undefined) return yield* Effect.fail(new Error(`scheduler refused the work list: ${invalid}`))
    const exclusiveLabels = new Set(
      targets.filter((target) => Target.isExclusive(target.attrs)).map((target) => target.label)
    )
    const remaining = new Map<string, number>()
    const dependents = new Map<string, Array<string>>()
    const ready: Array<string> = []
    for (const target of targets) {
      remaining.set(target.label, target.dependencies.length)
      if (target.dependencies.length === 0) ready.push(target.label)
      for (const dependency of target.dependencies) {
        const entry = dependents.get(dependency)
        if (entry === undefined) dependents.set(dependency, [target.label])
        else entry.push(target.label)
      }
    }
    const completed = yield* Queue.make<{ readonly label: string; readonly exit: Exit.Exit<void, E> }>({
      capacity: jobs
    })
    let active = 0
    let exclusiveActive = false
    let dispatched = 0
    let failure: Error | undefined
    while (true) {
      if (signal?.aborted) failure ??= Diagnostic.error(signal.reason, "execution aborted")
      while (failure === undefined && !exclusiveActive && active < jobs && ready.length > 0) {
        const ordinary = ready.findIndex((label) => !exclusiveLabels.has(label))
        if (ordinary < 0 && active > 0) break
        const label = ready.splice(ordinary < 0 ? 0 : ordinary, 1)[0]!
        exclusiveActive = exclusiveLabels.has(label)
        active += 1
        dispatched += 1
        yield* Effect.scoped(Effect.suspend(() => runOne(label))).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Queue.offer(completed, { label, exit })),
          Effect.forkScoped({ startImmediately: true })
        )
        if (signal?.aborted) failure ??= Diagnostic.error(signal.reason, "execution aborted")
      }
      if (active === 0) {
        if (failure !== undefined) return yield* Effect.fail(failure)
        if (dispatched !== targets.length) {
          return yield* Effect.fail(
            new Error(`scheduler stalled after dispatching ${dispatched} of ${targets.length} targets`)
          )
        }
        return
      }
      const { label, exit } = yield* Queue.take(completed)
      if (signal?.aborted) failure ??= Diagnostic.error(signal.reason, "execution aborted")
      active -= 1
      if (exclusiveLabels.has(label)) exclusiveActive = false
      if (Exit.isFailure(exit)) {
        failure ??= Diagnostic.error(Cause.squash(exit.cause), "scheduled target rejected")
      } else {
        for (const dependent of dependents.get(label) ?? []) {
          const left = (remaining.get(dependent) ?? 1) - 1
          remaining.set(dependent, left)
          if (left === 0) ready.push(dependent)
        }
      }
    }
  }))

/**
 * Drains a dependency-ordered work list with at most `jobs` in flight.
 *
 * Targets with `exclusive: true` attrs run alone. Ready ordinary work drains
 * first, then each ready exclusive target gets its own window. Dependencies
 * still run first, including exclusive prerequisites of ordinary targets.
 *
 * The work list and the concurrency bound are validated before anything is
 * dispatched, and an invalid one rejects without running a target. See
 * {@link validateWorkList}: a duplicate label, a duplicate or unknown or
 * self-referential dependency edge, and any cycle are all refused up front.
 * `jobs` must be a positive integer, because a fractional or non-finite bound
 * made the dispatch loop's `active < jobs` comparison false forever and
 * resolved a summary for a run that never happened.
 *
 * `runOne` reports an ordinary target failure itself and still resolves, which
 * is what keeps the run going. A rejection, or a synchronous throw, is
 * therefore an internal fault: no further target is dispatched, the targets
 * already in flight are awaited so nothing keeps mutating the workspace or the
 * cache after the caller has resumed, and the first rejection is the one
 * reported.
 *
 * Once `signal` aborts, no new target is dispatched. Targets already in flight
 * are still drained before the abort is reported, so they cannot keep mutating
 * the workspace after the caller regains control.
 *
 * The scheduler therefore always settles: it resolves only after dispatching
 * every target, and rejects in every other case.
 *
 * @category execution
 * @since 0.1.0
 * @slop
 */
export const schedule = (
  targets: ReadonlyArray<Planner.PlannedTarget>,
  jobs: number,
  runOne: (label: string) => Promise<void>,
  signal?: AbortSignal | undefined
): Promise<void> =>
  Effect.runPromise(scheduleEffect(
    targets,
    jobs,
    // Legacy Promise callers own cancellation of their work; always join it.
    (label) => Effect.tryPromise({ try: () => runOne(label), catch: (cause) => cause }).pipe(Effect.uninterruptible),
    signal
  ))

/** Effect's own rendering of a schema issue tree, built once. */
const formatSchemaIssue = SchemaIssue.makeFormatterDefault()

/**
 * Whether the failure renderer walks this object, or leaves it to
 * {@link Diagnostic.describe}.
 *
 * Exactly the values {@link cloneJson} accepts at the top level: a plain
 * object or a plain array. Everything else — an `Error`, a class instance, a
 * `Map` — renders better as its message than as the handful of own properties
 * a walk would find, and that is the rendering `Diagnostic.describe` gives.
 */
const rendersAsJson = (value: object): boolean => {
  if (NodeUtil.isProxy(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value)) return prototype === Array.prototype
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

/**
 * Walks a failure value into JSON that one diagnostic message carries whole.
 *
 * The walk budgets bytes, and JSON escaping then inflates them: a stream tail
 * of newlines doubles, and one of control characters sextuples. Rendering
 * once and letting {@link Diagnostic.message} cut the overflow would drop the
 * very markers that say what was cut, so an over-long render is walked again
 * under a budget scaled by its own overshoot. The bound is a backstop, not the
 * truncation.
 */
const renderFailureJson = (value: object): string | undefined => {
  let limit = Diagnostic.maximumMessageCodeUnits
  let encoded = JSON.stringify(cloneJson(value, new Set(), lossyBudget(limit), "failure", 0))
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (encoded === undefined || encoded.length <= Diagnostic.maximumMessageCodeUnits) return encoded
    const next = Math.floor(limit * Diagnostic.maximumMessageCodeUnits / encoded.length) - 64
    if (next < 1024 || next >= limit) return encoded
    limit = next
    encoded = JSON.stringify(cloneJson(value, new Set(), lossyBudget(limit), "failure", 0))
  }
  return encoded
}

/**
 * Renders a failure value compactly for a status line.
 *
 * The walk is lossy and total: a member JSON cannot carry is replaced by a
 * marker naming what it was, and a value larger than one diagnostic may hold
 * is truncated where it overruns. Refusing instead — which is what the cache
 * encoder does, and what this shared with it — cost an operator the whole
 * reason: a `//apps/app:unitTests` failure carrying a 64 KiB stderr tail and a
 * 64 KiB stdout tail overran the byte budget, the clone threw, and the CI log
 * read `//apps/app:unitTests  failed  86.1s  target failed` and nothing else.
 *
 * Members are rendered in sorted key order, so `argv`, `code`, `cwd` and
 * `exitCode` all precede the stream tails and survive any later truncation.
 *
 * @category diagnostics
 * @since 0.1.0
 */
export const describeFailure = (value: unknown): string => {
  if (typeof value === "object" && value !== null && !NodeUtil.isProxy(value)) {
    // A schema refusal reaches here as the bare issue tree as often as it
    // reaches here wrapped in a SchemaError, and the tree carries no `message`
    // of any kind. Effect's own formatter is what turns it back into the
    // sentence naming the path and the expectation.
    try {
      if (SchemaIssue.isIssue(value)) return Diagnostic.message(formatSchemaIssue(value), "target failed")
    } catch {
      // Fall through to the generic renderings.
    }
  }
  if (typeof value === "object" && value !== null && rendersAsJson(value)) {
    try {
      const encoded = renderFailureJson(value)
      if (encoded !== undefined && encoded !== "{}" && encoded !== "[]") {
        return Diagnostic.message(encoded, "target failed")
      }
    } catch {
      // Total by construction; kept so a future member type that escapes the
      // walk degrades to the generic rendering instead of losing the failure.
    }
  }
  // Every Error reaches this line: `rendersAsJson` above admits only a plain
  // prototype. `Diagnostic.describe` is what makes the reason survive that,
  // including for the Effect errors whose message is a prototype accessor.
  return Diagnostic.describe(value, "target failed")
}

/**
 * Encodes a flow result as a value that survives the JSON cache unchanged, or
 * explains why it cannot.
 *
 * The previous implementation ran `JSON.parse(JSON.stringify(value))` in a
 * `try` and cached `null` when it threw, so a result holding a cycle or a
 * bigint was stored as the JSON value `null` and every later run answered that
 * action with it. Even without a throw the round trip is lossy: `NaN` and
 * `Infinity` become `null`, an undefined object member disappears, a `Date`
 * becomes a string, and a `Map` becomes `{}`.
 *
 * Only the supported JSON domain is stored: null, booleans, finite numbers,
 * strings, plain-prototype objects, and dense arrays of the same. Anything else
 * leaves the target green and skips publication with a diagnostic, because a
 * result that cannot be recorded faithfully is not a result worth replaying.
 *
 * A top-level `undefined` is the one accepted non-JSON value: it is what a target
 * whose success schema is `Void` returns. An explicit tagged envelope records
 * it without confusing it with `null`. A nested `undefined` is refused,
 * because there `null`, an absent member, and `undefined` are distinct values.
 *
 * @category execution
 * @since 0.1.0
 */
const cacheUndefinedTag = "smithers-build/cache-output/undefined-v1"
const cacheValueTag = "smithers-build/cache-output/value-v1"
const maximumCacheOutputDepth = 256
const maximumCacheOutputMembers = 500_000

/**
 * What one walk of a value may spend, and whether overspending refuses.
 *
 * `limit` is the ceiling for `bytes`: the cache stores a whole entry, a
 * diagnostic only what one message shows. `lossy` distinguishes the two
 * callers — the cache encoder must refuse anything JSON would change, while
 * the failure renderer exists to name a failure and so renders a marker and
 * keeps going. `exhausted` records that a lossy walk has spent its budget, so
 * the containing object stops and says how many members it dropped.
 */
interface OutputBudget {
  bytes: number
  members: number
  readonly limit: number
  readonly lossy: boolean
  exhausted: boolean
}

const cacheBudget = (): OutputBudget => ({
  bytes: 0,
  members: 0,
  limit: entryLimit,
  lossy: false,
  exhausted: false
})

/**
 * The budget one rendered failure walks under.
 *
 * It starts at what {@link Diagnostic.message} keeps, because rendering more
 * than that only builds a string the bound then throws away.
 */
const lossyBudget = (limit: number): OutputBudget => ({
  bytes: 0,
  members: 0,
  limit,
  lossy: true,
  exhausted: false
})

const spendOutputBudget = (budget: OutputBudget, bytes: number, path: string): void => {
  budget.bytes += bytes
  budget.members += 1
  const overBytes = budget.bytes > budget.limit
  const overMembers = budget.members > maximumCacheOutputMembers
  if (!overBytes && !overMembers) return
  if (budget.lossy) {
    budget.exhausted = true
    return
  }
  if (overBytes) throw new Error(`${path} exceeds the ${budget.limit}-byte cache output limit`)
  throw new Error(`${path} exceeds the ${maximumCacheOutputMembers}-member cache output limit`)
}

/**
 * Refuses one member, or renders it as a marker naming what it was.
 *
 * The cache path must refuse: storing `<undefined>` where a value stood would
 * replay a lie. The failure path must not: the member it refused was often the
 * whole reason the target failed.
 */
const refuseMember = (budget: OutputBudget, path: string, reason: string, rendered: string): string => {
  if (!budget.lossy) throw new Error(`${path} ${reason}`)
  spendOutputBudget(budget, rendered.length + 2, path)
  return rendered
}

/** Names a function without reading a `name` any caller could have made an accessor. */
const functionMarker = (member: object): string => {
  if (NodeUtil.isProxy(member)) return "<function proxy>"
  try {
    const descriptor = Object.getOwnPropertyDescriptor(member, "name")
    const name = descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : ""
    return name === "" ? "<function>" : `<function ${name}>`
  } catch {
    return "<function>"
  }
}

/**
 * Keeps both ends of one string that still fits, and says how much it cut.
 *
 * The member that overruns a failure budget is almost always the largest one,
 * which is the captured output of whatever failed. Replacing the whole of it
 * with a marker would drop the evidence. Keeping only its prefix also loses
 * a test runner's final failure list, since Exec already retained a stream
 * tail. The middle is omitted so both the context and summary survive.
 */
const truncateToBudget = (member: string, budget: OutputBudget): string => {
  const total = Buffer.byteLength(member, "utf8")
  const note = (cut: number): string => `...<${cut} more bytes truncated>`
  const room = Math.max(0, budget.limit - budget.bytes - 2 - note(total).length)
  let keep = Math.min(Math.floor(member.length / 2), Math.floor(room / 2))
  let head: string
  let tail: string
  let bytes: number
  do {
    // Never introduce a lone surrogate when a cut crosses a code point.
    head = member.slice(0, keep).replace(/[\ud800-\udbff]$/, "")
    tail = member.slice(member.length - keep).replace(/^[\udc00-\udfff]/, "")
    bytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8")
    keep = Math.floor(keep / 2)
  } while (bytes > room)
  budget.bytes = budget.limit
  budget.members += 1
  budget.exhausted = true
  return `${head}${note(total - bytes)}${tail}`
}

/**
 * Clones exactly the JSON value the cache will serialize, without invoking
 * user code, or — under a lossy budget — the closest total rendering of it.
 */
const cloneJson = (
  member: unknown,
  seen: Set<object>,
  budget: OutputBudget,
  path: string,
  depth: number
): unknown => {
  if (depth > maximumCacheOutputDepth) {
    return refuseMember(
      budget,
      path,
      `exceeds the maximum cache output depth of ${maximumCacheOutputDepth}`,
      "<depth limit>"
    )
  }
  if (member === null) {
    spendOutputBudget(budget, 4, path)
    return null
  }
  switch (typeof member) {
    case "boolean":
      spendOutputBudget(budget, member ? 4 : 5, path)
      return member
    case "string": {
      const bytes = Buffer.byteLength(member, "utf8") + 2
      if (!budget.lossy || budget.bytes + bytes <= budget.limit) {
        spendOutputBudget(budget, bytes, path)
        return member
      }
      return truncateToBudget(member, budget)
    }
    case "number":
      if (!Number.isFinite(member)) {
        return refuseMember(budget, path, `is the non-finite number ${String(member)}`, `<${String(member)}>`)
      }
      if (Object.is(member, -0)) {
        return refuseMember(budget, path, "is negative zero, which JSON would change to zero", "<-0>")
      }
      spendOutputBudget(budget, String(member).length, path)
      return member
    case "undefined":
      return refuseMember(
        budget,
        path,
        "is undefined, which JSON cannot distinguish from an absent member",
        "<undefined>"
      )
    case "bigint":
      return refuseMember(budget, path, "is a bigint", `<bigint ${String(member)}>`)
    case "symbol":
      return refuseMember(budget, path, "is a symbol", `<${String(member)}>`)
    case "function":
      return refuseMember(budget, path, "is a function", functionMarker(member))
    case "object":
      break
    default:
      throw new Error(`${path} is an unsupported ${typeof member} value`)
  }
  const object = member
  if (NodeUtil.isProxy(object)) return refuseMember(budget, path, "is a Proxy", "<proxy>")
  if (seen.has(object)) return refuseMember(budget, path, "closes a reference cycle", "<circular>")
  const prototype = Object.getPrototypeOf(object)
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      if (prototype !== Array.prototype && !budget.lossy) throw new Error(`${path} is an array subclass instance`)
      const names = Object.getOwnPropertyNames(object)
      if (
        !budget.lossy && (
          names.length !== object.length + 1 ||
          names.at(-1) !== "length" ||
          Object.getOwnPropertySymbols(object).length > 0
        )
      ) {
        throw new Error(`${path} is a sparse array or carries extra own properties`)
      }
      spendOutputBudget(budget, 2, path)
      const encoded: Array<unknown> = []
      for (let index = 0; index < object.length; index += 1) {
        const childPath = `${path}[${index}]`
        if (!budget.lossy && names[index] !== String(index)) {
          throw new Error(`${path} is a sparse array or carries extra own properties`)
        }
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index))
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          if (!budget.lossy) throw new Error(`${childPath} is an accessor or non-enumerable property`)
        }
        // A hole reads as JSON's `null`, exactly as `JSON.stringify` renders it.
        encoded.push(
          descriptor === undefined
            ? null
            : "value" in descriptor
            ? cloneJson(descriptor.value, seen, budget, childPath, depth + 1)
            : "<accessor>"
        )
        if (budget.exhausted) {
          const dropped = object.length - index - 1
          if (dropped > 0) encoded.push(`<${dropped} more items omitted>`)
          break
        }
      }
      return encoded
    }
    if (prototype !== Object.prototype && prototype !== null && !budget.lossy) {
      throw new Error(`${path} is an object whose prototype is not a plain object`)
    }
    if (Object.getOwnPropertySymbols(object).length > 0 && !budget.lossy) {
      throw new Error(`${path} carries symbol-keyed own properties`)
    }
    spendOutputBudget(budget, 2, path)
    const encoded = Object.create(null) as Record<string, unknown>
    const keys = Object.getOwnPropertyNames(object).sort()
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!
      const childPath = path === "" ? key : `${path}.${key}`
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      if (descriptor === undefined) {
        if (!budget.lossy) throw new Error(`${childPath} is an accessor or non-enumerable property`)
        continue
      }
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        // A lossy walk keeps a non-enumerable data property — that is where a
        // native Error holds its message — and names an accessor rather than
        // invoking one while a failure is being reported.
        if (!budget.lossy) throw new Error(`${childPath} is an accessor or non-enumerable property`)
      }
      spendOutputBudget(budget, Buffer.byteLength(key, "utf8") + 3, childPath)
      encoded[key] = "value" in descriptor
        ? cloneJson(descriptor.value, seen, budget, childPath, depth + 1)
        : "<accessor>"
      if (budget.exhausted) {
        const dropped = keys.length - index - 1
        if (dropped > 0) encoded["<truncated>"] = `${dropped} more members omitted`
        break
      }
    }
    return encoded
  } finally {
    seen.delete(object)
  }
}

/**
 * Encodes one schema-level wire value in an unambiguous cache envelope.
 *
 * @category caching
 * @since 0.1.0
 * @slop
 */
export const encodeCacheOutput = (
  value: unknown
): { readonly output: unknown } | { readonly reason: string } => {
  if (value === undefined) return { output: { _tag: cacheUndefinedTag } }
  try {
    return {
      output: {
        _tag: cacheValueTag,
        value: cloneJson(value, new Set(), cacheBudget(), "result", 0)
      }
    }
  } catch (cause) {
    return { reason: describeFailure(cause) }
  }
}

/**
 * Decodes and revalidates the cache envelope without trusting its object shape.
 *
 * @category caching
 * @since 0.1.0
 * @slop
 */
export const decodeCacheOutput = (
  output: unknown
): { readonly value: unknown } | { readonly reason: string } => {
  try {
    if (typeof output !== "object" || output === null || NodeUtil.isProxy(output)) {
      throw new Error("cached output is not a plain envelope")
    }
    if (Object.getPrototypeOf(output) !== Object.prototype || Object.getOwnPropertySymbols(output).length > 0) {
      throw new Error("cached output is not a plain envelope")
    }
    const names = Object.getOwnPropertyNames(output).sort()
    const tagDescriptor = Object.getOwnPropertyDescriptor(output, "_tag")
    if (
      tagDescriptor === undefined ||
      !("value" in tagDescriptor) ||
      tagDescriptor.enumerable !== true ||
      typeof tagDescriptor.value !== "string"
    ) {
      throw new Error("cached output has no data tag")
    }
    if (tagDescriptor.value === cacheUndefinedTag) {
      if (names.length !== 1 || names[0] !== "_tag") throw new Error("cached undefined output has extra fields")
      return { value: undefined }
    }
    if (tagDescriptor.value !== cacheValueTag || names.length !== 2 || names[0] !== "_tag" || names[1] !== "value") {
      throw new Error("cached output has an unknown or malformed envelope")
    }
    const valueDescriptor = Object.getOwnPropertyDescriptor(output, "value")
    if (valueDescriptor === undefined || !("value" in valueDescriptor) || valueDescriptor.enumerable !== true) {
      throw new Error("cached output value is not a data property")
    }
    return {
      value: cloneJson(valueDescriptor.value, new Set(), cacheBudget(), "cached result", 0)
    }
  } catch (cause) {
    return { reason: describeFailure(cause) }
  }
}
