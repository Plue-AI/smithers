/*
 * DesignWorld: THE ONE MOCK SEAM (Will, 2026-10-03, mock-first mount).
 *
 * Every seeded row and every stub mutation the mounted design cards need where
 * no real seam exists yet lives in this directory. Card files read it through
 * ./hooks.ts; stub flows call the mutations on `actions.design`; nothing else
 * may import it. Deleting it is one change: remove this directory, the
 * `design` member and its two lines in state/AppController.ts, and each
 * card's `useDesign*` read, then `grep -r DesignWorld src` must be empty.
 *
 * What replaces each part (mvp.md §6.3 routes, §7.2 live topics):
 *   repo (stack order, main, capacity, parallel, setup)
 *                         -> topic `home`, GET /api/stack; `install` + InstallSeam (Setup/Settings)
 *   todos, drafts         -> topic `todo:<n>`, /api/todos via TodoSeam (cards row `todo:<n>`, `draft:<uuid>`)
 *   branches, terminals, files
 *                         -> topics `branch:<id>`, `:activity`, `:files`; /api/branches; CloudTerminalClient
 *   members               -> topic `members`, MembersSeam
 *   secrets               -> topic `secrets`, /api/secrets
 *   runs, traces          -> topic `run:<id>`, /api/runs (background runs ride `home`)
 *   flowVersions, agents  -> topics `flows`, `agents`
 *   issues, prs           -> IssuesSeam, GitHub sync (GitHubSeam)
 *   wiki                  -> the wiki collections and wiki.* flows
 *   acts                  -> topic `confirmations:<member>` (ConfirmView one_click)
 *   reviews, proposals, forms
 *                         -> the /review flow result, learning runs, FlowFormCards
 *   the scheduler         -> the factory on the install (Go), observed through those topics
 *
 * Rules kept here: rows live in local-only TanStack DB collections owned by
 * this instance (one per AppController); timers are instance fields; there is
 * no module-level mutable state. Rows are design-mock shaped (./world.ts), not
 * rpc wire models: each card file maps them to its View's props.
 */
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import {
  agentOf, MAYA, shaOf, STACK,
  type ActorId, type DesignAct, type DesignActivity, type DesignAgent, type DesignBranch, type DesignDraft, type DesignEvidence,
  type DesignFile, type DesignFlowVersion, type DesignForm, type DesignIssue, type DesignMember, type DesignPhase,
  type DesignPr, type DesignProposal, type DesignRepo, type DesignReview, type DesignRun, type DesignSecret,
  type DesignTerminal, type DesignTodo, type DesignTrace, type DesignWikiPage, type DesignWorldRows, seedDesignWorld
} from "./world"

export * from "./world"

/* ── Collections ──────────────────────────────────────────── */

export interface DesignRowMap {
  readonly repo: DesignRepo
  readonly members: DesignMember
  readonly todos: DesignTodo
  readonly branches: DesignBranch
  readonly terminals: DesignTerminal
  readonly files: DesignFile
  readonly issues: DesignIssue
  readonly drafts: DesignDraft
  readonly runs: DesignRun
  readonly flowVersions: DesignFlowVersion
  readonly traces: DesignTrace
  readonly wiki: DesignWikiPage
  readonly prs: DesignPr
  readonly secrets: DesignSecret
  readonly agents: DesignAgent
  readonly acts: DesignAct
  readonly reviews: DesignReview
  readonly proposals: DesignProposal
  readonly forms: DesignForm
}
export type DesignKind = keyof DesignRowMap
export type DesignKey = string | number

const KEY: { readonly [K in DesignKind]: (row: DesignRowMap[K]) => DesignKey } = {
  repo: row => row.id, members: row => row.id, todos: row => row.id, branches: row => row.id, terminals: row => row.id,
  files: row => row.id, issues: row => row.number, drafts: row => row.id, runs: row => row.id, flowVersions: row => row.id,
  traces: row => row.id, wiki: row => row.id, prs: row => row.number, secrets: row => row.name, agents: row => row.id,
  acts: row => row.id, reviews: row => row.id, proposals: row => row.id, forms: row => row.id
}

const makeCollection = <T extends object>(kind: DesignKind, getKey: (row: T) => DesignKey, initialData: Array<T>) =>
  createCollection(localOnlyCollectionOptions<T, DesignKey>({ id: `design-${kind}`, getKey, initialData }))

export type DesignCollections = { readonly [K in DesignKind]: ReturnType<typeof makeCollection<DesignRowMap[K]>> }

const KINDS = Object.keys(KEY) as ReadonlyArray<DesignKind>

const createCollections = (seed: DesignWorldRows): DesignCollections => Object.fromEntries(KINDS.map(kind => {
  const value = (seed as unknown as Record<string, unknown>)[kind]
  const rows = (Array.isArray(value) ? value : [value]).map(row => structuredClone(row) as object)
  return [kind, makeCollection(kind, KEY[kind] as (row: object) => DesignKey, rows)]
})) as unknown as DesignCollections

/** TanStack virtual fields describe the reader, not the row. */
const strip = <T>(row: T): T => {
  if (typeof row !== "object" || row === null) return row
  const { $synced: _synced, $origin: _origin, $key: _key, $collectionId: _collectionId, ...data } = row as Record<string, unknown>
  /* A field written as `undefined` is removed: a draft `delete` never reaches a TanStack collection. */
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as T
}

/* ── Selectors (pure, over a world snapshot) ──────────────── */

export const todoOf = (world: DesignWorldRows, id: string): DesignTodo | undefined => world.todos.find(each => each.id === id)
export const branchOf = (world: DesignWorldRows, id: string): DesignBranch | undefined => world.branches.find(each => each.id === id)
export const memberOf = (world: DesignWorldRows, who: ActorId): DesignMember | undefined =>
  world.members.find(each => each.id === who.split("~")[0])
export const traceOf = (world: DesignWorldRows, todo: string): DesignTrace | undefined =>
  world.traces.filter(each => each.todo === todo).sort((left, right) => right.attempt - left.attempt)[0]
export const prOf = (world: DesignWorldRows, todo: DesignTodo): DesignPr | undefined =>
  todo.pr === undefined ? undefined : world.prs.find(each => each.number === todo.pr)

/** Stack items in merge order, merged and dropped left out. */
export const openItems = (world: DesignWorldRows): ReadonlyArray<DesignTodo> => world.repo.stack
  .flatMap(id => todoOf(world, id) ?? [])
  .filter(each => each.state !== "merged" && each.state !== "dropped")

/** Every stack item in merge order, settled ones included. */
export const stackItems = (world: DesignWorldRows): ReadonlyArray<DesignTodo> => world.repo.stack.flatMap(id => todoOf(world, id) ?? [])

/** Merging is for maintainers and the owner (M-05). */
export const canMerge = (world: DesignWorldRows, who: ActorId): boolean => {
  const role = memberOf(world, who)?.role
  return role === "owner" || role === "maintainer"
}

export type DesignMergeReadiness =
  | { readonly state: "ready" }
  | { readonly state: "done" }
  | { readonly state: "waiting" | "blocked"; readonly reason: string; readonly github?: boolean; readonly failed?: boolean }

/** world.ts mergeReadiness: the one rule the Home row, TODO card and Review & merge read. */
export const mergeReadiness = (world: DesignWorldRows, item: DesignTodo): DesignMergeReadiness => {
  if (item.state === "merged") return { state: "done" }
  const evidence = item.evidence
  if (item.state !== "in-review" || evidence === undefined) {
    return item.state === "needs-you" || item.state === "paused"
      ? { state: "blocked", reason: item.state === "paused" ? "Paused" : "Needs you" }
      : { state: "waiting", reason: "Not in review yet" }
  }
  const open = openItems(world)
  const prior = open[open.findIndex(each => each.id === item.id) - 1]
  if (prior !== undefined) return { state: "waiting", reason: `Merges after ${prior.ref}` }
  const on = evidence.rev === undefined ? "" : ` on ${evidence.rev}`
  const failed = evidence.checks.find(check => check.state === "failed")?.name
  if (failed !== undefined) return { state: "blocked", reason: `${failed} failed${on}`, failed: true }
  if (evidence.checks.some(check => check.state === "running")) return { state: "waiting", reason: `Checks running${on}` }
  if (evidence.reviewing === true) return { state: "waiting", reason: `Review running${on}` }
  if (evidence.github.failing !== undefined) return { state: "blocked", reason: `${evidence.github.failing} failed`, github: true, failed: true }
  if (evidence.github.passed < evidence.github.total) return { state: "waiting", reason: "GitHub checks running", github: true }
  if (item.mergeBlock !== undefined) return { state: "blocked", reason: item.mergeBlock, github: true }
  return { state: "ready" }
}

/** The one action a Needs you item offers. */
export const needsAction = (item: DesignTodo): "Return" | "Resolve" | "Review" | "Move" | "Answer" =>
  item.needs === "moved_off" ? "Return"
    : item.needs === "conflict" || item.failure === "conflict" ? "Resolve"
    : item.needs === "foreign_push" || item.needs === "force_push" ? "Review"
    : item.needs === "order" ? "Move" : "Answer"

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`

/** "next to merge", "3rd in stack"; undefined once settled. */
export const placeOf = (world: DesignWorldRows, item: DesignTodo): string | undefined => {
  const index = openItems(world).findIndex(each => each.id === item.id)
  return index < 0 ? undefined : index === 0 ? "next to merge" : `${ordinal(index + 1)} in stack`
}

const STATE_WORDS: Readonly<Record<DesignTodo["state"], string>> = {
  queued: "Queued", starting: "Starting", working: "Working", "needs-you": "Needs you", paused: "Paused",
  "in-review": "In review", merged: "Merged", failed: "Failed", dropped: "Dropped"
}

/** The state word: "Waiting for a machine · #1", "Working · Implement". */
export const stateLabel = (world: DesignWorldRows, item: DesignTodo): string => {
  if (item.state === "queued" && item.queue !== undefined) return `Waiting for a machine · #${item.queue}`
  if (item.state === "working" && item.step !== undefined) {
    const steps = item.steps ?? world.repo.flow
    return `Working · ${steps.find(step => step.id === item.step)?.title ?? item.step}`
  }
  return STATE_WORDS[item.state]
}

/** Home's filter counts; Working counts Starting too. */
export const homeCounts = (world: DesignWorldRows) => {
  const open = openItems(world)
  const count = (...states: ReadonlyArray<DesignTodo["state"]>) => open.filter(each => states.includes(each.state)).length
  return { needsYou: count("needs-you"), working: count("working", "starting"), queued: count("queued"), inReview: count("in-review") }
}

/** Who must press an A✓ on this TODO ("Needs Ben"). */
export const waitingOn = (world: DesignWorldRows, todo: string): ActorId | undefined =>
  world.acts.find(each => each.todo === todo && each.state === "asked")?.by

/** Machines in use: awake or waking branches, then running background runs, up to capacity. */
export const machineSlots = (world: DesignWorldRows): ReadonlyArray<{ readonly kind: "branch"; readonly branch: DesignBranch } | { readonly kind: "run"; readonly run: DesignRun } | { readonly kind: "free" }> => {
  const used = [
    ...world.branches.filter(each => each.machine === "awake" || each.machine === "waking").map(branch => ({ kind: "branch" as const, branch })),
    ...world.runs.filter(each => each.state === "running" && each.queue === undefined).map(run => ({ kind: "run" as const, run }))
  ].slice(0, world.repo.capacity)
  return [...used, ...Array.from({ length: world.repo.capacity - used.length }, () => ({ kind: "free" as const }))]
}

export const nextRef = (world: DesignWorldRows): string =>
  `T${Math.max(0, ...world.todos.map(each => Number(each.ref.slice(1)) || 0)) + 1}`

/* ── Scheduler script ─────────────────────────────────────── */

/** One TODO attempt, ~21.5 s at speed 1: Starting, then Plan → Propose, then In review with its evidence. */
export const DESIGN_SCRIPT: ReadonlyArray<{ readonly state: "starting" | "working"; readonly step?: string; readonly ms: number; readonly activity?: string }> = [
  { state: "starting", ms: 1500 },
  { state: "working", step: "plan", ms: 4000, activity: "Planned the change" },
  { state: "working", step: "implement", ms: 6000, activity: "Edited 2 files" },
  { state: "working", step: "verify", ms: 5000, activity: "typecheck, test, lint passed" },
  { state: "working", step: "review", ms: 3000, activity: "Reviewed its own change" },
  { state: "working", step: "propose", ms: 2000, activity: "Opened the PR" }
]
/** GitHub's required checks finish this long after the PR opens; rechecks after a rebase take the same. */
export const GITHUB_CHECKS_MS = 3000
/** A learning run after a merge. */
export const LEARNING_MS = 3000

export interface DesignTimers {
  readonly set: (run: () => void, ms: number) => unknown
  readonly clear: (handle: unknown) => void
}

export interface DesignWorldOptions {
  /** Injected in tests; defaults to setTimeout/clearTimeout. */
  readonly timers?: DesignTimers
  /** 10 runs the script ten times faster. */
  readonly speed?: number
  readonly seed?: () => DesignWorldRows
  /** The member this browser acts as; defaults to `?as=<id|login>` or Maya (the owner). */
  readonly viewer?: ActorId
}

/** `?speed=10` runs the simulated factory ten times faster. */
const speedFromLocation = (): number => {
  try {
    const speed = typeof location === "undefined" ? NaN : Number(new URLSearchParams(location.search).get("speed"))
    return Number.isFinite(speed) && speed > 0 ? speed : 1
  } catch {
    return 1
  }
}

/** `?as=ben` or `?as=benortiz` picks who this tab acts as (two tabs, two people). */
const viewerFromLocation = (rows: DesignWorldRows): ActorId => {
  try {
    const as = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("as")
    const member = as === null ? undefined : rows.members.find(each => each.id === as || each.login === as)
    return member?.id ?? MAYA
  } catch {
    return MAYA
  }
}

export type DesignResult = { readonly ok: true; readonly ack: string; readonly id?: string } | { readonly ok: false; readonly refusal: string }
const ok = (ack: string, id?: string): DesignResult => (id === undefined ? { ok: true, ack } : { ok: true, ack, id })
const refuse = (refusal: string): DesignResult => ({ ok: false, refusal })

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 3).join("-") || "todo"

const passedEvidence = (rev: string, prior?: DesignEvidence): DesignEvidence => ({
  rev, files: prior?.files ?? 2, added: prior?.added ?? 24, removed: prior?.removed ?? 9,
  checks: [{ name: "typecheck", state: "passed", took: "12s" }, { name: "test", state: "passed", took: "48s" }, { name: "lint", state: "passed", took: "8s" }],
  github: { passed: 0, total: 5 },
  review: prior?.review ?? "No blocking issues."
})

/* ── The instance ─────────────────────────────────────────── */

export const createDesignWorld = (options: DesignWorldOptions = {}) => {
  const timers: DesignTimers = options.timers ?? { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  const speed = options.speed ?? speedFromLocation()
  const seeded = (options.seed ?? seedDesignWorld)()
  const viewer: ActorId = options.viewer ?? viewerFromLocation(seeded)
  const collections = createCollections(seeded)
  const pending = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  let version = 0
  let started = false
  let disposed = false
  let cached: { readonly version: number; readonly world: DesignWorldRows } | undefined

  /* Reads */
  /* Rows read back in seed-then-insert order, not key order (members, stack rows). */
  const order = new Map<string, number>()
  const place = (kind: DesignKind, key: DesignKey): void => { if (!order.has(`${kind}:${key}`)) order.set(`${kind}:${key}`, order.size) }
  for (const kind of KINDS) {
    const value = (seeded as unknown as Record<string, unknown>)[kind]
    for (const each of Array.isArray(value) ? value : [value]) place(kind, (KEY[kind] as (row: object) => DesignKey)(each as object))
  }
  const rank = (kind: DesignKind, key: DesignKey): number => order.get(`${kind}:${key}`) ?? Number.MAX_SAFE_INTEGER
  const rows = <K extends DesignKind>(kind: K): ReadonlyArray<DesignRowMap[K]> =>
    [...(collections[kind] as unknown as { values(): Iterable<DesignRowMap[K]> }).values()].map(strip)
      .sort((left, right) => rank(kind, KEY[kind](left)) - rank(kind, KEY[kind](right)))
  const row = <K extends DesignKind>(kind: K, key: DesignKey): DesignRowMap[K] | undefined =>
    strip((collections[kind] as unknown as { get(key: DesignKey): DesignRowMap[K] | undefined }).get(key))
  const world = (): DesignWorldRows => {
    if (cached?.version === version) return cached.world
    const next = Object.fromEntries(KINDS.map(kind => [kind, kind === "repo" ? row("repo", "repo") : rows(kind)])) as unknown as DesignWorldRows
    cached = { version, world: next }
    return next
  }

  /* Writes. The helpers below are the path in; a direct `collections.<kind>` write still notifies. */
  let writing = 0
  const changed = (): void => {
    version += 1
    for (const listener of [...listeners]) listener()
  }
  const collectionSubscriptions = KINDS.map(kind =>
    (collections[kind] as unknown as { subscribeChanges(callback: () => void): { unsubscribe(): void } })
      .subscribeChanges(() => { if (writing === 0) changed() }))
  const put = <K extends DesignKind>(kind: K, next: DesignRowMap[K]): void => {
    const collection = collections[kind] as unknown as {
      has(key: DesignKey): boolean
      insert(row: DesignRowMap[K]): unknown
      update(key: DesignKey, mutate: (draft: Record<string, unknown>) => void): unknown
    }
    const key = KEY[kind](next)
    const value = structuredClone(next) as unknown as Record<string, unknown>
    place(kind, key)
    writing += 1
    try {
      if (!collection.has(key)) collection.insert(value as unknown as DesignRowMap[K])
      else collection.update(key, draft => {
        for (const field of Object.keys(draft)) if (!field.startsWith("$") && !Object.hasOwn(value, field)) draft[field] = undefined
        for (const [field, fieldValue] of Object.entries(value)) draft[field] = fieldValue
      })
    } finally {
      writing -= 1
    }
    changed()
  }
  /** A partial merges (an `undefined` field removes it); a function returns the next row. */
  const patch = <K extends DesignKind>(kind: K, key: DesignKey,
    change: Partial<DesignRowMap[K]> | ((current: DesignRowMap[K]) => DesignRowMap[K])): DesignRowMap[K] | undefined => {
    const current = row(kind, key)
    if (current === undefined) return undefined
    const next = typeof change === "function" ? change(current) : drop({ ...current, ...change }) as DesignRowMap[K]
    put(kind, next)
    return next
  }
  const remove = (kind: DesignKind, key: DesignKey): boolean => {
    const collection = collections[kind] as unknown as { has(key: DesignKey): boolean; delete(key: DesignKey): unknown }
    if (!collection.has(key)) return false
    writing += 1
    try { collection.delete(key) } finally { writing -= 1 }
    changed()
    return true
  }
  const repo = (): DesignRepo => row("repo", "repo")!
  const setRepo = (change: Partial<DesignRepo>): void => { patch("repo", "repo", current => ({ ...current, ...change })) }
  const setTodo = (id: string, change: Partial<DesignTodo>): DesignTodo | undefined =>
    patch("todos", id, current => drop({ ...current, ...change, seq: version + 1 }))
  const setBranch = (id: string, change: Partial<DesignBranch>): DesignBranch | undefined =>
    patch("branches", id, current => drop({ ...current, ...change }))
  /** `undefined` in a patch removes the field. */
  const drop = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T

  const activity = (branch: string, entry: Omit<DesignActivity, "id" | "seq">): void => {
    patch("branches", branch, current => ({ ...current, activity: [...current.activity, drop({ ...entry, id: `${branch}-a${current.activity.length + 1}`, seq: version + 1 })] }))
  }
  const present = (branch: string, who: ActorId, where: DesignBranch["presence"][number]["where"] | undefined): void => {
    patch("branches", branch, current => ({ ...current, presence: [...current.presence.filter(each => each.who !== who), ...(where === undefined ? [] : [{ who, where }])] }))
  }

  /* Timers: instance-held, one per key. */
  const cancel = (key: string): void => {
    const handle = pending.get(key)
    if (handle !== undefined) timers.clear(handle)
    pending.delete(key)
  }
  const after = (key: string, ms: number, run: () => void): void => {
    cancel(key)
    if (disposed) return
    pending.set(key, timers.set(() => { pending.delete(key); if (!disposed) run() }, ms / speed))
  }

  /* Traces: the scheduler writes the current attempt's phases so Inspect is live. */
  const traceFor = (todo: DesignTodo): DesignTrace | undefined => traceOf(world(), todo.id)
  const ensureTrace = (todo: DesignTodo): void => {
    const attempt = todo.attempts ?? 1
    const current = traceFor(todo)
    if (current !== undefined && current.attempt >= attempt) {
      if (current.state !== "running") put("traces", { ...current, state: "running" })
      return
    }
    put("traces", { id: `run-${todo.id}-${attempt}`, title: todo.title, todo: todo.id, attempt, branch: todo.branch, state: "running", phases: [] })
  }
  const tracePhase = (todo: DesignTodo, phase: Omit<DesignPhase, "cells"> & { readonly cells?: DesignPhase["cells"] }): void => {
    const trace = traceFor(todo)
    if (trace === undefined) return
    const settled = trace.phases.map(each => each.tone === "live" ? { ...each, tone: "ok" as const } : each)
    put("traces", { ...trace, phases: [...settled, { cells: [], ...phase }] })
  }
  const setTrace = (todo: DesignTodo, state: DesignTrace["state"]): void => {
    const trace = traceFor(todo)
    if (trace !== undefined) put("traces", drop({ ...trace, state, phases: trace.phases.map(each => each.tone === "live" ? { ...each, tone: "ok" as const } : each),
      held: state === "held" ? { since: "now" } : undefined }))
  }

  /* Admission: queued items start in stack order while a TODO slot and a machine are free. */
  const busy = (snapshot: DesignWorldRows): number => snapshot.todos.filter(each => {
    if (each.state === "starting" || each.state === "working") return true
    const machine = branchOf(snapshot, each.branch)?.machine
    return each.state === "needs-you" && (machine === "awake" || machine === "waking")
  }).length
  const awake = (snapshot: DesignWorldRows): number => snapshot.branches.filter(each => each.machine === "awake" || each.machine === "waking").length
  const renumber = (): void => {
    const queued = stackItems(world()).filter(each => each.state === "queued")
    queued.forEach((item, index) => {
      if (item.queue !== index + 1) setTodo(item.id, { queue: index + 1 })
      const branch = branchOf(world(), item.branch)
      if (branch !== undefined && (branch.waitPosition !== index + 1 || branch.machine !== "waiting")) setBranch(item.branch, { machine: "waiting", waitPosition: index + 1 })
    })
  }
  const admit = (): void => {
    if (!started) { renumber(); return }
    for (const item of stackItems(world()).filter(each => each.state === "queued")) {
      const snapshot = world()
      if (busy(snapshot) >= snapshot.repo.parallel || awake(snapshot) >= snapshot.repo.capacity) break
      begin(item.id)
    }
    renumber()
  }

  /* The lifecycle. Index 0 is Starting; 1..5 are the flow steps; past the end is In review. */
  const stepIndex = (step: string | undefined): number => {
    const index = DESIGN_SCRIPT.findIndex(each => each.step === step)
    return index < 1 ? 1 : index
  }
  const begin = (id: string): void => {
    const item = setTodo(id, { state: "starting", queue: undefined })
    if (item === undefined) return
    setBranch(item.branch, { machine: "waking", waitPosition: undefined })
    ensureTrace(item)
    const resumeAt = stepIndex(item.step)
    after(id, DESIGN_SCRIPT[0]!.ms, () => enter(id, resumeAt))
  }
  const enter = (id: string, index: number): void => {
    const item = row("todos", id)
    if (item === undefined || (item.state !== "starting" && item.state !== "working")) return
    if (index >= DESIGN_SCRIPT.length) { review(id); return }
    const script = DESIGN_SCRIPT[index]!
    const steps = item.steps ?? repo().flow
    const next = setTodo(id, { state: "working", step: script.step, steps, flowVersion: item.flowVersion ?? "v1" })!
    setBranch(item.branch, { machine: "awake" })
    present(item.branch, agentOf(item.branch), { kind: "step", step: script.step! })
    if (script.activity !== undefined) activity(item.branch, { who: agentOf(item.branch), kind: "step", text: script.activity, tone: "ok" })
    tracePhase(next, { id: `p-${script.step}-${version}`, step: script.step!, title: steps.find(each => each.id === script.step)?.title ?? script.step!,
      summary: script.activity ?? "", tone: "live" })
    after(id, script.ms, () => enter(id, index + 1))
  }
  /** Propose finished: In review with evidence, the PR open, the machine asleep, GitHub checks pending. */
  const review = (id: string): void => {
    const item = row("todos", id)
    if (item === undefined) return
    const pr = item.pr ?? repo().nextPr
    if (item.pr === undefined) setRepo({ nextPr: pr + 1 })
    const rev = shaOf(`${id}#${item.attempts ?? 1}#${version}`).slice(0, 7)
    const next = setTodo(id, { state: "in-review", step: undefined, pr, evidence: passedEvidence(rev, item.evidence) })!
    const open = openItems(world())
    const prior = open[open.findIndex(each => each.id === id) - 1]
    put("prs", drop({ number: pr, todo: id, title: item.title, base: "main", head: `smithers/${branchOf(world(), item.branch)?.name ?? item.branch}`,
      sha: shaOf(`pr#${pr}#${rev}`), state: "open" as const, requestedBy: item.owner, body: [item.prompt], approvals: [], required: 0,
      draftAfter: prior?.ref }))
    activity(item.branch, { who: STACK, kind: "step", text: `Opened PR #${pr}`, tone: "ok" })
    present(item.branch, agentOf(item.branch), undefined)
    setBranch(item.branch, { machine: "asleep" })
    setTrace(next, "held")
    after(`github:${id}`, GITHUB_CHECKS_MS, () => githubPassed(id))
    admit()
  }
  const githubPassed = (id: string): void => {
    const item = row("todos", id)
    if (item?.evidence === undefined || item.state !== "in-review") return
    const { reviewing: _reviewing, ...evidence } = item.evidence
    setTodo(id, { evidence: { ...evidence, checks: evidence.checks.map(check => ({ ...check, state: "passed" as const })), github: { passed: evidence.github.total, total: evidence.github.total } } })
  }
  /** A clean rebase: checks rerun on a new revision; the review stands. */
  const rebase = (id: string, onto: string): void => {
    const item = row("todos", id)
    if (item?.evidence === undefined || item.state !== "in-review") return
    const rev = shaOf(`${id}#rebase#${version}`).slice(0, 7)
    const prior = item.evidence
    setTodo(id, { approvalCleared: item.approvedRev === undefined ? undefined : true, evidence: drop({ ...prior, rev,
      checks: prior.checks.map(check => ({ name: check.name, state: "running" as const })), github: { passed: 0, total: prior.github.total },
      previous: prior.rev === undefined ? undefined : { rev: prior.rev, review: prior.review } }) })
    activity(item.branch, { who: STACK, kind: "step", text: `Rebased onto ${onto} · checks rerun on ${rev}`, tone: "run" })
    after(`github:${id}`, GITHUB_CHECKS_MS, () => githubPassed(id))
  }

  /* ── Mutation helpers for stub flows ─────────────────────── */

  const answer = (id: string, text: string, by: ActorId): DesignResult => {
    const item = row("todos", id)
    if (item?.question === undefined || item.state !== "needs-you") return refuse("Nothing to answer")
    if (item.question.answer !== undefined) return refuse(`${memberOf(world(), item.question.answer.by)?.name ?? "Someone"} already answered`)
    const next = setTodo(id, { question: { ...item.question, answer: { by, text } }, needs: undefined, state: "working" })!
    activity(item.branch, { who: by, kind: "answer", text })
    const trace = traceFor(next)
    if (trace !== undefined) put("traces", { ...trace, state: "running", phases: trace.phases.map(phase => phase.tone !== "wait" ? phase
      : drop({ ...phase, tone: "ok" as const, indicator: undefined, summary: "Answered.", cells: [...phase.cells, { id: `c-answer-${version}`, kind: "answer" as const, explain: text, who: by }] })) })
    const machine = branchOf(world(), item.branch)?.machine
    if (machine === "awake" || machine === "waking") enter(id, stepIndex(item.step))
    else { setTodo(id, { state: "queued" }); setBranch(item.branch, { machine: "waiting" }); admit() }
    return ok(`Answered ${item.ref}`)
  }

  const steer = (id: string, text: string, by: ActorId): DesignResult => {
    const item = row("todos", id)
    if (item === undefined) return refuse("No such TODO")
    if (item.state === "merged" || item.state === "dropped") return refuse(`${item.ref} is ${STATE_WORDS[item.state].toLowerCase()}`)
    setTodo(id, { steers: [...(item.steers ?? []), { by, text }] })
    activity(item.branch, { who: by, kind: "steer", text })
    if (item.state === "in-review") {
      cancel(`github:${id}`)
      setTodo(id, { state: "working", step: "implement" })
      ensureTrace(row("todos", id)!)
      enter(id, stepIndex("implement"))
    }
    return ok(`Steered ${item.ref}`)
  }

  const stop = (id: string, by: ActorId): DesignResult => {
    const item = row("todos", id)
    if (item === undefined || !["starting", "working"].includes(item.state)) return refuse("Only working TODOs stop")
    cancel(id)
    setTodo(id, { state: "paused" })
    present(item.branch, agentOf(item.branch), undefined)
    setBranch(item.branch, { machine: "asleep" })
    activity(item.branch, { who: STACK, kind: "step", text: `Stopped ${item.ref}`, asked: by })
    admit()
    return ok(`Stopped ${item.ref}`)
  }

  /** Resume requeues; the attempt continues from its last step once a machine frees. */
  const resume = (id: string, by: ActorId): DesignResult => {
    const item = row("todos", id)
    if (item?.state !== "paused") return refuse("Only paused TODOs resume")
    setTodo(id, { state: "queued" })
    setBranch(item.branch, { machine: "waiting" })
    activity(item.branch, { who: STACK, kind: "step", text: `Resumed ${item.ref}`, asked: by })
    admit()
    return ok(`Resumed ${item.ref}`)
  }

  /** Retry starts attempt n + 1 from Plan, queued until a machine frees. */
  const retry = (id: string, by: ActorId, text?: string): DesignResult => {
    const item = row("todos", id)
    if (item === undefined || !["failed", "paused"].includes(item.state)) return refuse("Only failed TODOs retry")
    cancel(id)
    const traceBefore = traceFor(item)
    if (traceBefore !== undefined && traceBefore.state !== "failed") put("traces", { ...traceBefore, state: "failed" })
    setTodo(id, { state: "queued", step: undefined, failure: undefined, needs: undefined, attempts: (item.attempts ?? 1) + 1 })
    if (text !== undefined && text.trim() !== "") activity(item.branch, { who: by, kind: "steer", text })
    setBranch(item.branch, { machine: "waiting" })
    admit()
    return ok(`Retrying ${item.ref} · attempt ${(item.attempts ?? 1) + 1}`)
  }

  const dropTodo = (id: string, by: ActorId): DesignResult => {
    const item = row("todos", id)
    if (item === undefined || item.state === "merged" || item.state === "dropped") return refuse("Only unmerged TODOs drop")
    cancel(id)
    cancel(`github:${id}`)
    setTodo(id, { state: "dropped", queue: undefined })
    setBranch(item.branch, { machine: "closed", waitPosition: undefined, presence: [] })
    activity(item.branch, { who: STACK, kind: "step", text: `Dropped ${item.ref}`, tone: "ok", asked: by })
    if (item.pr !== undefined) patch("prs", item.pr, current => ({ ...current, state: "closed" }))
    const trace = traceFor(item)
    if (trace !== undefined) setTrace(item, "failed")
    admit()
    return ok(`Dropped ${item.ref}`)
  }

  const move = (id: string, direction: "up" | "down", by: ActorId): DesignResult => {
    const open = openItems(world())
    const index = open.findIndex(each => each.id === id)
    const other = open[direction === "up" ? index - 1 : index + 1]
    if (index < 0 || other === undefined) return refuse(direction === "up" ? "Already first" : "Already last")
    const stack = [...repo().stack]
    const from = stack.indexOf(id)
    const to = stack.indexOf(other.id)
    stack[from] = other.id
    stack[to] = id
    setRepo({ stack })
    const item = open[index]!
    activity(item.branch, { who: STACK, kind: "step", text: `Moved ${direction}`, tone: "ok", asked: by })
    for (const moved of [item, other]) rebase(moved.id, direction === "up" && moved.id === id ? "main" : item.ref)
    renumber()
    return ok(`Moved ${item.ref} ${direction}`)
  }

  /** Merge: owner or maintainer, ready, bound to the PR head when given. Main moves; later items rebase; learning starts. */
  const merge = (id: string, by: ActorId, reviewedHeadSha?: string): DesignResult => {
    const snapshot = world()
    const item = todoOf(snapshot, id)
    if (item === undefined) return refuse("No such TODO")
    if (!canMerge(snapshot, by)) return refuse("A maintainer merges")
    const readiness = mergeReadiness(snapshot, item)
    if (readiness.state === "done") return refuse(`${item.ref} already merged`)
    if (readiness.state !== "ready") return refuse(readiness.reason)
    const pr = prOf(snapshot, item)
    /* The cards show the evidence revision (or the short PR head); a press bound to what they showed merges. */
    const shown = [pr?.sha, pr?.sha.slice(0, 7), item.evidence?.rev]
    if (reviewedHeadSha !== undefined && pr !== undefined && !shown.includes(reviewedHeadSha)) return refuse("The PR changed since you reviewed it")
    cancel(`github:${id}`)
    setTodo(id, { state: "merged", queue: undefined })
    setBranch(item.branch, { machine: "closed", presence: [], waitPosition: undefined })
    if (pr !== undefined) put("prs", { ...pr, state: "merged", mergedBy: by })
    const number = item.pr ?? 0
    setRepo({ mainSha: shaOf(`main#${number}#${version}`), mainHead: { text: `#${number} merged` }, mergedSinceLook: repo().mergedSinceLook + 1 })
    if (item.issue !== undefined && item.fixes !== false) patch("issues", item.issue, current => ({ ...current, open: false }))
    activity(item.branch, { who: STACK, kind: "step", text: `Merged #${number}`, tone: "ok", asked: by })
    setTrace(item, "merged")
    const learning = `learn-${number}`
    put("runs", { id: learning, title: `Learning from #${number}`, state: "running", todo: id })
    after(learning, LEARNING_MS, () => {
      patch("runs", learning, current => ({ ...current, state: "done", detail: "2 lessons" }))
      setTodo(id, { lessons: 2 })
    })
    for (const later of openItems(world()).filter(each => each.state === "in-review")) rebase(later.id, "main")
    admit()
    return ok(`Merged #${number}`)
  }

  const amend = (id: string, text: string, by: ActorId): DesignResult => {
    const item = row("todos", id)
    if (item === undefined || item.state === "merged" || item.state === "dropped") return refuse("Only unmerged TODOs change")
    setTodo(id, { amendments: [...(item.amendments ?? []), { by, text }] })
    activity(item.branch, { who: STACK, kind: "step", text: `Amended ${item.ref}'s prompt`, tone: "ok", asked: by })
    return ok(`Amended ${item.ref}`)
  }

  /* Drafts: private to their author until Commit. */
  const newDraft = (by: ActorId, init: Partial<Omit<DesignDraft, "id" | "by">> = {}): DesignResult => {
    const id = `d-${version + 1}-${rows("drafts").length + 1}`
    put("drafts", drop({ id, by, title: init.title ?? "", prompt: init.prompt ?? "", issue: init.issue, fixes: init.fixes ?? init.issue !== undefined,
      place: init.place ?? { kind: "append" as const } }))
    return ok("New TODO", id)
  }
  const setDraft = (id: string, change: Partial<Pick<DesignDraft, "title" | "prompt" | "fixes" | "place">>): DesignResult =>
    patch("drafts", id, current => ({ ...current, ...change })) === undefined ? refuse("No such draft") : ok("Saved")
  const discardDraft = (id: string): DesignResult => remove("drafts", id) ? ok("Discarded") : refuse("No such draft")

  /** Commit: append or before joins the stack queued and starts when a machine frees; amend folds into its target. */
  const commitDraft = (id: string, by: ActorId): DesignResult => {
    const draft = row("drafts", id)
    if (draft === undefined) return refuse("No such draft")
    if (draft.by !== by) return refuse("Only its author commits a draft")
    if (draft.committed !== undefined) return refuse("Already committed")
    if (draft.prompt.trim() === "") return refuse("Write the prompt first")
    if (draft.place.kind === "amend") {
      const result = amend(draft.place.id, draft.prompt, by)
      if (result.ok) put("drafts", { ...draft, committed: draft.place.id })
      return result
    }
    const snapshot = world()
    const ref = nextRef(snapshot)
    const todoId = `t-${ref.toLowerCase()}`
    const title = draft.title.trim() === "" ? draft.prompt.split(/[.\n]/)[0]!.slice(0, 60) : draft.title
    const branchId = `b-${ref.toLowerCase()}`
    put("todos", drop({ id: todoId, ref, title, prompt: draft.prompt, owner: by, branch: branchId, state: "queued" as const, attempts: 1,
      issue: draft.issue, fixes: draft.issue === undefined ? undefined : draft.fixes, seq: version + 1 }))
    put("branches", { id: branchId, name: slug(title), item: todoId, from: "main", machine: "waiting", presence: [], activity: [], terminals: [] })
    const stack = [...snapshot.repo.stack]
    const before = draft.place.kind === "before" ? stack.indexOf(draft.place.id) : -1
    if (before < 0) stack.push(todoId)
    else stack.splice(before, 0, todoId)
    setRepo({ stack })
    const target = draft.place.kind === "before" ? todoOf(snapshot, draft.place.id)?.ref : undefined
    activity(branchId, { who: STACK, kind: "step", text: target === undefined ? `Placed ${ref} last` : `Placed ${ref} before ${target}`, tone: "ok", asked: by })
    if (draft.issue !== undefined) patch("issues", draft.issue, current => ({ ...current, todo: todoId, fixes: draft.fixes }))
    put("drafts", { ...draft, committed: todoId })
    admit()
    return ok(`Committed as ${ref}`, todoId)
  }

  /* Branches */
  const fork = (branchId: string, by: ActorId): DesignResult => {
    const from = row("branches", branchId)
    if (from === undefined) return refuse("No such branch")
    const name = `${by}/${from.name}`
    const id = `b-fork-${version + 1}`
    put("branches", { id, name, from: branchId, machine: "waking", presence: [{ who: by, where: { kind: "branch" } }], activity: [], terminals: [] })
    for (const file of rows("files").filter(each => each.branch === branchId)) put("files", { ...file, id: `${id}:${file.path}`, branch: id, editors: [] })
    activity(id, { who: STACK, kind: "step", text: `Forked from ${from.name}`, tone: "ok", asked: by })
    present(branchId, by, undefined)
    after(`wake:${id}`, 1500, () => setBranch(id, { machine: "awake" }))
    return ok(`Forked ${name}`, id)
  }
  const visit = (branchId: string, who: ActorId): DesignResult => {
    if (row("branches", branchId) === undefined) return refuse("No such branch")
    for (const other of rows("branches")) if (other.id !== branchId && other.presence.some(each => each.who === who && each.where.kind === "branch")) present(other.id, who, undefined)
    if (!row("branches", branchId)!.presence.some(each => each.who === who)) present(branchId, who, { kind: "branch" })
    return ok(`Opened ${row("branches", branchId)!.name}`)
  }

  /* Settings, members, secrets */
  const setCapacity = (capacity: number): DesignResult => { setRepo({ capacity: Math.max(1, Math.round(capacity)) }); admit(); return ok(`${repo().capacity} machines`) }
  const setParallel = (parallel: number): DesignResult => { setRepo({ parallel: Math.max(1, Math.round(parallel)) }); admit(); return ok(`${repo().parallel} TODOs at once`) }
  const addMember = (login: string, permission: "admin" | "maintain" | "write" = "write"): DesignResult => {
    const id = login.toLowerCase().replace(/[^a-z0-9-]/g, "")
    if (id === "") return refuse("Enter a GitHub username")
    if (row("members", id) !== undefined || rows("members").some(each => each.login === login)) return refuse(`${login} is already a member`)
    const used = new Set(rows("members").map(each => each.lane))
    put("members", { id, name: login, login, initials: login.slice(0, 2).toUpperCase(), lane: [0, 1, 2, 3, 4, 5].find(each => !used.has(each)) ?? 3,
      role: permission === "write" ? "member" : "maintainer", permission })
    return ok(`Added ${login}`, id)
  }
  const setRole = (id: string, role: "maintainer" | "member"): DesignResult => {
    const member = row("members", id)
    if (member === undefined) return refuse("No such member")
    if (member.role === "owner") return refuse("The owner's role is fixed")
    put("members", { ...member, role })
    return ok(`${member.name} is a ${role}`)
  }
  const removeMember = (id: string): DesignResult => {
    const member = row("members", id)
    if (member === undefined) return refuse("No such member")
    if (member.role === "owner") return refuse("The owner stays")
    remove("members", id)
    return ok(`Removed ${member.name}`)
  }
  const setSecret = (name: string, scope: DesignSecret["scope"]): DesignResult => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return refuse("Use a NAME like STRIPE_KEY")
    put("secrets", { name, scope })
    return ok(`Saved ${name}`)
  }
  const deleteSecret = (name: string): DesignResult => remove("secrets", name) ? ok(`Deleted ${name}`) : refuse("No such secret")

  /* Background runs and GitHub sync */
  const retryRun = (id: string): DesignResult => {
    if (patch("runs", id, current => drop({ ...current, state: "running" as const, detail: undefined })) === undefined) return refuse("No such run")
    after(`run:${id}`, LEARNING_MS, () => patch("runs", id, current => ({ ...current, state: "done", detail: "Done" })))
    return ok("Retrying")
  }
  const dismissRun = (id: string): DesignResult => remove("runs", id) ? ok("Dismissed") : refuse("No such run")
  const syncRetry = (): DesignResult => { patch("repo", "repo", current => drop({ ...current, syncedAgo: 3, mainHealth: undefined })); return ok("Synced") }

  /* A✓ */
  const ask = (act: Omit<DesignAct, "id" | "state">): DesignResult => {
    const id = `act-${version + 1}`
    put("acts", { ...act, id, state: "asked" })
    return ok(`${act.verb} ${act.target}?`, id)
  }
  /** Only the asker presses; a Drop act drops its TODO. */
  const pressAct = (id: string, by: ActorId): DesignResult => {
    const act = row("acts", id)
    if (act === undefined || act.state !== "asked") return refuse("Nothing to confirm")
    if (act.by !== by) return refuse("Only the person asked can confirm")
    if (act.verb === "Drop" && act.todo !== undefined) {
      const result = dropTodo(act.todo, by)
      if (!result.ok) return result
    }
    put("acts", { ...act, state: "done" })
    return ok(act.receipt)
  }
  const cancelAct = (id: string, by: ActorId): DesignResult => {
    const act = row("acts", id)
    if (act === undefined || act.state !== "asked" || act.by !== by) return refuse("Nothing to cancel")
    put("acts", { ...act, state: "cancelled" })
    return ok("Cancelled")
  }

  /* Review findings, wiki, agents, forms, proposals */
  const actOnFinding = (reviewId: string, index: number, acted: "fix" | "not-useful", by: ActorId): DesignResult => {
    const review = row("reviews", reviewId)
    const finding = review?.findings[index]
    if (review === undefined || finding === undefined || finding.acted !== undefined) return refuse("Nothing to act on")
    put("reviews", { ...review, findings: review.findings.map((each, at) => at === index ? { ...each, acted } : each) })
    if (acted === "fix") {
      const item = rows("todos").find(each => each.branch === review.branch)
      if (item !== undefined) return steer(item.id, `Please fix ${finding.path}:${finding.line}: ${finding.text}`, by)
    }
    return ok(acted === "fix" ? "Sent as a steer" : "Dismissed")
  }
  const wikiEdit = (pageId: string, n: number, text: string, by: ActorId): DesignResult =>
    patch("wiki", pageId, page => ({ ...page, editors: [...(page.editors ?? []).filter(each => each.who !== by), { who: by, line: n }],
      lines: page.lines.map(line => line.n !== n ? line : { n, text, by, was: line.by === by ? line.was : line.text }) })) === undefined ? refuse("No such page") : ok("Saving…")
  const wikiSave = (pageId: string): DesignResult => {
    const page = row("wiki", pageId)
    if (page === undefined) return refuse("No such page")
    const authors = [...new Set(page.lines.flatMap(line => line.by === undefined || line.was === undefined ? [] : [line.by]))]
    put("wiki", { ...page, rev: page.rev + 1, authors: authors.length === 0 ? page.authors : authors, editors: [],
      lines: page.lines.map(({ was: _was, ...line }) => line) })
    return ok(`Saved r${page.rev + 1}`)
  }
  const setAgentModel = (agentId: string, model: string, by: ActorId): DesignResult => {
    const agent = row("agents", agentId)
    if (agent === undefined) return refuse("No such agent")
    if (memberOf(world(), by)?.role !== "owner") return refuse("The owner sets models")
    put("agents", { ...agent, model, changed: { from: agent.model, by } })
    return ok(`${agent.model} → ${model}`)
  }
  const openForm = (form: Omit<DesignForm, "receipt">): DesignResult => { put("forms", form); return ok(form.title, form.id) }
  const submitForm = (id: string, values: Readonly<Record<string, string>>, receipt: string): DesignResult => {
    const form = row("forms", id)
    if (form === undefined || form.receipt !== undefined) return refuse("Nothing to submit")
    const fields = form.fields.map(field => ({ ...field, value: values[field.id] ?? field.value }))
    const missing = fields.find(field => field.required === true && field.value.trim() === "")
    if (missing !== undefined) return refuse(`${missing.label} is required`)
    put("forms", { ...form, fields, receipt })
    return ok(receipt)
  }
  const dismissProposal = (id: string): DesignResult => remove("proposals", id) ? ok("Dismissed") : refuse("No such suggestion")

  /* Branch banners and GitHub events */
  const rebaseNow = (branchId: string, by: ActorId): DesignResult => {
    const branch = row("branches", branchId)
    if (branch === undefined) return refuse("No such branch")
    const onto = branch.rebasePending ?? "main"
    setBranch(branchId, { rebasePending: undefined })
    const item = branch.item === undefined ? undefined : row("todos", branch.item)
    if (item?.state === "in-review") rebase(item.id, onto)
    else activity(branchId, { who: STACK, kind: "step", text: `Rebased onto ${onto}`, tone: "ok", asked: by })
    return ok(`Rebased onto ${onto}`)
  }
  const returnToItem = (branchId: string, by: ActorId): DesignResult => {
    const branch = row("branches", branchId)
    if (branch?.movedOff === undefined) return refuse("Nothing to return")
    setBranch(branchId, { movedOff: undefined })
    const item = row("todos", branch.movedOff.item)
    if (item !== undefined) setTodo(item.id, { needs: undefined, state: "working" })
    activity(branchId, { who: STACK, kind: "step", text: `Returned to ${item?.ref ?? "its item"}`, tone: "ok", asked: by })
    if (item !== undefined) enter(item.id, stepIndex(item.step))
    return ok(`Returned to ${item?.ref ?? "its item"}`)
  }
  const keepMoved = (branchId: string, by: ActorId): DesignResult => {
    const branch = row("branches", branchId)
    if (branch?.movedOff === undefined) return refuse("Nothing to keep")
    setBranch(branchId, { movedOff: undefined })
    const item = row("todos", branch.movedOff.item)
    if (item !== undefined) setTodo(item.id, { needs: undefined })
    activity(branchId, { who: STACK, kind: "step", text: "Kept the move", tone: "ok", asked: by })
    return ok("Kept the move")
  }
  /** Bring in a laptop push: the commit joins the change; checks and review rerun. */
  const bringIn = (id: string, by: ActorId): DesignResult => {
    const item = row("todos", id)
    if (item === undefined || (item.needs !== "foreign_push" && item.needs !== "force_push")) return refuse("Nothing to bring in")
    const who = memberOf(world(), item.pushedBy ?? "")?.name.split(" ")[0] ?? "their"
    setTodo(id, { state: "in-review", needs: undefined, pushedBy: undefined, question: undefined, step: undefined })
    activity(item.branch, { who: STACK, kind: "step", text: `Brought in ${who}'s commit`, tone: "ok", asked: by })
    rebase(id, "the push")
    return ok(`Brought in ${who}'s commit`)
  }
  const discardForeign = (id: string, by: ActorId): DesignResult => {
    const item = row("todos", id)
    if (item === undefined || (item.needs !== "foreign_push" && item.needs !== "force_push")) return refuse("Nothing to discard")
    if (!canMerge(world(), by)) return refuse("A maintainer discards")
    setTodo(id, { state: "in-review", needs: undefined, pushedBy: undefined, question: undefined, step: undefined })
    activity(item.branch, { who: STACK, kind: "step", text: "Discarded the commit · kept in history", tone: "ok", asked: by })
    return ok("Discarded")
  }
  /** A scratch branch joins the stack as a TODO after its origin item (or last). */
  const addToStack = (branchId: string, by: ActorId): DesignResult => {
    const branch = row("branches", branchId)
    if (branch === undefined || branch.item !== undefined) return refuse("Only scratch branches join the stack")
    const snapshot = world()
    const ref = nextRef(snapshot)
    const todoId = `t-${ref.toLowerCase()}`
    const origin = branchOf(snapshot, branch.from)?.item
    put("todos", { id: todoId, ref, title: branch.name.split("/").pop() ?? branch.name, prompt: `The change on ${branch.name}.`, owner: by,
      branch: branchId, state: "working", step: "verify", steps: snapshot.repo.flow, attempts: 1, seq: version + 1 })
    const stack = [...snapshot.repo.stack]
    const at = origin === undefined ? -1 : stack.indexOf(origin)
    if (at < 0) stack.push(todoId)
    else stack.splice(at + 1, 0, todoId)
    setRepo({ stack })
    setBranch(branchId, { item: todoId, from: "main", machine: "awake" })
    const afterRef = origin === undefined ? undefined : todoOf(snapshot, origin)?.ref
    activity(branchId, { who: STACK, kind: "step", text: afterRef === undefined ? `Placed ${ref} last` : `Placed ${ref} after ${afterRef}`, tone: "ok", asked: by })
    ensureTrace(row("todos", todoId)!)
    enter(todoId, stepIndex("verify"))
    return ok(`Added as ${ref}`, todoId)
  }
  /** Make TODO from an issue: a private draft prefilled from the discussion. */
  const draftFromIssue = (number: number, by: ActorId): DesignResult => {
    const issue = row("issues", number)
    if (issue === undefined) return refuse("No such issue")
    if (issue.todo !== undefined) return refuse(`Already ${row("todos", issue.todo)?.ref ?? "a TODO"}`)
    return newDraft(by, { title: issue.title, prompt: issue.body, issue: number, fixes: true })
  }
  /** Make TODO from a learning suggestion: queued at the end of the stack. */
  const proposalTodo = (id: string, by: ActorId): DesignResult => {
    const proposal = row("proposals", id)
    if (proposal === undefined || proposal.todo !== undefined) return refuse("Nothing to make")
    const draft = newDraft(by, { title: proposal.title, prompt: proposal.evidence })
    if (!draft.ok || draft.id === undefined) return draft
    const committed = commitDraft(draft.id, by)
    if (committed.ok && committed.id !== undefined) put("proposals", { ...proposal, todo: committed.id })
    return committed
  }

  /* Terminals and files */
  const newTerminal = (branchId: string, by: ActorId): DesignResult => {
    const branch = row("branches", branchId)
    if (branch === undefined) return refuse("No such branch")
    const id = `term-${version + 1}`
    put("terminals", { id, branch: branchId, title: `terminal ${branch.terminals.length + 1}`, owner: by, lines: [], watchers: [] })
    setBranch(branchId, { terminals: [...branch.terminals, id] })
    present(branchId, by, { kind: "terminal", id })
    return ok("Opened a terminal", id)
  }
  /** The owner types a command; the seed answers with a canned line. */
  const typeTerminal = (id: string, command: string, by: ActorId): DesignResult => {
    const terminal = row("terminals", id)
    if (terminal === undefined) return refuse("No such terminal")
    if (terminal.owner !== by) return refuse("Only its owner types here")
    const branch = row("branches", terminal.branch)?.name ?? terminal.branch
    const prompt = `${by}@${branch} $ ${command}`
    const output = command.trim() === "" ? [] : command.startsWith("pnpm test") ? [{ text: "✓ 42 passed", tone: "ok" as const }] : [{ text: "ok", tone: "dim" as const }]
    put("terminals", { ...terminal, lines: [...terminal.lines, { text: prompt, tone: "prompt" }, ...output] })
    return ok("Ran")
  }
  const watchTerminal = (id: string, by: ActorId): DesignResult =>
    patch("terminals", id, current => ({ ...current, watchers: current.watchers.includes(by) ? current.watchers : [...current.watchers, by] })) === undefined
      ? refuse("No such terminal") : ok("Watching")
  /** A live attributed line edit; the file saves itself. */
  const editFile = (fileId: string, n: number, text: string, by: ActorId): DesignResult => {
    const file = row("files", fileId)
    if (file === undefined) return refuse("No such file")
    put("files", { ...file, editors: [...(file.editors ?? []).filter(each => each.who !== by), { who: by, line: n }],
      lines: file.lines.map(line => line.n !== n ? line : { n, text, by, was: line.was ?? line.text }) })
    after(`save:${fileId}:${by}`, 1200, () => patch("files", fileId, current => drop({ ...current, editors: (current.editors ?? []).filter(each => each.who !== by) })))
    return ok("Saving…")
  }
  const restoreFile = (fileId: string): DesignResult =>
    patch("files", fileId, current => drop({ ...current, gone: undefined, outside: undefined })) === undefined ? refuse("No such file") : ok("Restored")
  const wikiOpen = (pageId: string, n: number, by: ActorId): DesignResult =>
    patch("wiki", pageId, page => ({ ...page, editors: [...(page.editors ?? []).filter(each => each.who !== by), { who: by, line: n }] })) === undefined
      ? refuse("No such page") : ok("Editing")

  /* Install */
  const setAddress = (address: string, listen?: DesignRepo["setup"]["listen"]): DesignResult => {
    const setup = repo().setup
    if (!/^https?:\/\/[^\s]+$/.test(address)) {
      setRepo({ setup: { ...setup, addressChange: { from: setup.addresses[0] ?? "", to: address, reason: "Not a valid address" } } })
      return refuse("Not a valid address")
    }
    const { addressChange: _change, ...rest } = setup
    setRepo({ setup: { ...rest, addresses: [address], listen: listen ?? setup.listen } })
    return ok(`Reachable at ${address}`)
  }
  const setSetup = (change: Partial<DesignRepo["setup"]>): DesignResult => { setRepo({ setup: drop({ ...repo().setup, ...change }) }); return ok("Saved") }

  /* Scheduler lifecycle */
  /** Start the simulated factory once: seeded Working items continue, queued ones wait for a slot. Idempotent. */
  const start = (): void => {
    if (started || disposed) return
    started = true
    for (const item of stackItems(world())) {
      if (item.state === "starting") after(item.id, DESIGN_SCRIPT[0]!.ms, () => enter(item.id, stepIndex(item.step)))
      if (item.state === "working") {
        ensureTrace(item)
        const index = stepIndex(item.step)
        after(item.id, DESIGN_SCRIPT[index]!.ms, () => enter(item.id, index + 1))
      }
      if (item.state === "in-review" && item.evidence !== undefined && item.evidence.github.passed < item.evidence.github.total)
        after(`github:${item.id}`, GITHUB_CHECKS_MS, () => githubPassed(item.id))
    }
    admit()
  }
  const dispose = (): void => {
    disposed = true
    for (const subscription of collectionSubscriptions) subscription.unsubscribe()
    for (const handle of pending.values()) timers.clear(handle)
    pending.clear()
    listeners.clear()
  }
  /** useSyncExternalStore subscribe: the first reader starts the factory. */
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    start()
    return () => { listeners.delete(listener) }
  }

  return {
    collections,
    /** The member this tab acts as. */
    viewer: (): ActorId => viewer,
    /* reads */
    world,
    version: () => version,
    subscribe,
    rows,
    row,
    /* scheduler */
    start,
    dispose,
    pendingTimers: (): ReadonlyArray<string> => [...pending.keys()],
    /* mutations */
    answer, steer, stop, resume, retry, drop: dropTodo, move, merge, amend,
    newDraft, setDraft, discardDraft, commitDraft,
    fork, visit,
    setCapacity, setParallel, addMember, setRole, removeMember, setSecret, deleteSecret,
    retryRun, dismissRun, syncRetry,
    ask, pressAct, cancelAct,
    actOnFinding, wikiEdit, wikiSave, setAgentModel, openForm, submitForm, dismissProposal,
    rebaseNow, returnToItem, keepMoved, bringIn, discardForeign, addToStack, draftFromIssue, proposalTodo,
    newTerminal, typeTerminal, watchTerminal, editFile, restoreFile, wikiOpen, setAddress, setSetup,
    /*
     * Generic writes, a stable surface for lane files (DesignWorld/<lane>.ts):
     * each writes its collection and notifies subscribers (bumps version).
     */
    put, patch, remove, setTodo, setBranch, setRepo, activity, present,
    /** Run once after `ms` (divided by speed); a second call with the same key replaces the first. Cleared on dispose. */
    after, cancel
  }
}

export type DesignWorld = ReturnType<typeof createDesignWorld>
