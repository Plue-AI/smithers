/*
 * The issue-sweep burndown, projected from its run journal.
 *
 * `issue-sweep` (flows/issue-sweep/flow.ts) is a `Burndown` from
 * `@smthrs/patterns`: each round asks the account pools for capacity
 * (`issue-sweep/accounts`), lists the open issues (`issue-sweep/list-issues`),
 * and dispatches one `issue-sweep/work` child per issue that is ours; the
 * child's first step, `issue-sweep/fetch-issue`, reads the issue. The
 * child's execution id is `issue-sweep/<number>/attempt-<k>`, and the
 * placement it runs in (local, vm, or cloud for overflow) is the payload its
 * `created` decision carries. Remote work that conflicted with main is
 * applied again by `<child>/readopt-<n>` executions. Landing,
 * release and selection happen inside `issue-sweep/dispatch` and are journaled
 * only when the dispatch settles, as `Burndown.RoundResult` rows.
 *
 * The journal carries each settled step's result as a preview cut at about
 * 2 KB (`result.truncated`), so every result is read with {@link salvage},
 * which keeps the complete leading fields of a cut JSON text and never throws.
 * Nothing here is inferred beyond what the journal says.
 */

/** Every state an issue passes through, in board order. */
export const BURNDOWN_STATES = ["skip", "ours", "claimed", "working", "adopting", "landing", "landed", "held", "failed"] as const

export type BurndownState = typeof BURNDOWN_STATES[number]

export const isBurndownState = (value: unknown): value is BurndownState =>
  typeof value === "string" && (BURNDOWN_STATES as ReadonlyArray<string>).includes(value)

export interface DiffStat {
  readonly files: number
  readonly insertions: number
  readonly deletions: number
}

export interface BurndownItem {
  readonly number: number
  readonly state: BurndownState
  readonly title?: string
  readonly agent?: string
  readonly account?: string
  readonly placement?: "local" | "vm" | "cloud"
  readonly executionId?: string
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly diff?: DiffStat
  /** The agent's patch, present only when the journal held it whole. */
  readonly patch?: string
  /** The landed commit, from the dispatch row. */
  readonly commit?: string
  readonly reason?: string
  /** A pull request a dispatch row names. */
  readonly pr?: string
}

export type BurndownParked =
  | { readonly kind: "none" }
  | { readonly kind: "wait-until"; readonly at: number }
  /** `since` is the journal sequence the open wait was scheduled at: a later park has a later one. */
  | { readonly kind: "exhausted"; readonly since: number; readonly accounts: ReadonlyArray<{ readonly label: string; readonly state: string }> }

export interface BurndownAccount {
  readonly label: string
  readonly items: number
  readonly active: number
  readonly landed: number
  readonly failed: number
  readonly needsReset: boolean
  /** The pool's word for an account that is out ("limited until 18:00"). */
  readonly state?: string
}

export type BurndownStatus = "running" | "parked" | "cancelled" | "completed" | "failed"

export interface BurndownView {
  readonly status: BurndownStatus
  /** The sweep's input: the journal's own (its rounds' payload) when read, else the one this client launched with. */
  readonly input?: Readonly<Record<string, unknown>>
  readonly items: ReadonlyArray<BurndownItem>
  /** Whether a round's `issue-sweep/list-issues` has answered: an empty board before it is unread, after it is empty. */
  readonly discovered: boolean
  /** A cancel the engine recorded on the run's own execution and has not finished. */
  readonly stopping: boolean
  /** The failed run's message, from its summary. */
  readonly failure?: string
  readonly counts: Readonly<Record<BurndownState, number>>
  /** In-flight children (claimed, working, adopting) against the latest round's slots. */
  readonly capacity: { readonly slots?: number; readonly active: number }
  readonly parked: BurndownParked
  readonly accounts: ReadonlyArray<BurndownAccount>
  readonly machine: {
    readonly health?: string
    readonly freshness?: string
    readonly observedAt?: number
    /** Remote fixes in flight in local microVMs. */
    readonly vms: number
    readonly maxAgents?: number
    /** Overflow fixes in flight in Smithers Cloud, against the run's `cloudAgents`; both only when it asked for cloud agents. */
    readonly cloud?: { readonly active: number; readonly agents: number }
  }
}

/* ---------------------------------------------------------------- salvage */

type Scanned = { readonly value: unknown; readonly complete: boolean; readonly end: number } | undefined

const WS = /\s/
const skip = (text: string, at: number): number => {
  let i = at
  while (i < text.length && WS.test(text[i]!)) i += 1
  return i
}

const LITERAL = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/

const scan = (text: string, at: number, depth: number): Scanned => {
  const i = skip(text, at)
  if (i >= text.length || depth > 64) return undefined
  const head = text[i]
  if (head === "\"") {
    let j = i + 1
    while (j < text.length) {
      const char = text[j]
      if (char === "\\") j += 2
      else if (char === "\"") break
      else j += 1
    }
    if (j >= text.length) return undefined
    try {
      return { value: JSON.parse(text.slice(i, j + 1)), complete: true, end: j + 1 }
    } catch {
      return undefined
    }
  }
  if (head === "{" || head === "[") {
    const array = head === "["
    const out: Array<unknown> | Record<string, unknown> = array ? [] : {}
    let j = skip(text, i + 1)
    if (text[j] === (array ? "]" : "}")) return { value: out, complete: true, end: j + 1 }
    for (;;) {
      let key: string | undefined
      if (!array) {
        const name = scan(text, j, depth + 1)
        if (name === undefined || typeof name.value !== "string") return { value: out, complete: false, end: text.length }
        key = name.value
        j = skip(text, name.end)
        if (text[j] !== ":") return { value: out, complete: false, end: text.length }
        j += 1
      }
      const item = scan(text, j, depth + 1)
      if (item === undefined) return { value: out, complete: false, end: text.length }
      if (array) (out as Array<unknown>).push(item.value)
      else (out as Record<string, unknown>)[key!] = item.value
      if (!item.complete) return { value: out, complete: false, end: text.length }
      j = skip(text, item.end)
      if (text[j] === ",") {
        j += 1
        continue
      }
      if (text[j] === (array ? "]" : "}")) return { value: out, complete: true, end: j + 1 }
      return { value: out, complete: false, end: text.length }
    }
  }
  const match = LITERAL.exec(text.slice(i))
  // A literal that runs to the end of a cut text may itself be cut: 12 of 1234.
  if (match === null || i + match[0].length >= text.length) return undefined
  return { value: JSON.parse(match[0]), complete: true, end: i + match[0].length }
}

/**
 * The JSON value a possibly cut text begins: complete leading fields and
 * elements, the cut tail dropped (a nested value cut midway keeps its own
 * complete part). `undefined` when nothing complete precedes the cut.
 */
export const salvage = (text: string): { readonly value: unknown; readonly complete: boolean } | undefined => {
  const scanned = scan(text, 0, 0)
  return scanned === undefined ? undefined : { value: scanned.value, complete: scanned.complete }
}

/* ---------------------------------------------------------------- journal */

type Rec = Readonly<Record<string, unknown>>
const record = (value: unknown): Rec | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Rec : undefined
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined

interface Step {
  readonly executionId: string
  readonly action: string
  readonly nodeId: string
  readonly sequence: number
  readonly settled?: { readonly outcome: string; readonly value: unknown; readonly complete: boolean }
}

interface Execution {
  readonly id: string
  /** Whether a parent execution is recorded; the run's own has none. */
  child?: boolean
  /** The placement the execution's own payload names, from its `created` decision. */
  placement?: "local" | "vm" | "cloud"
  cancelRequested?: boolean
  flowName?: string
  status?: string
  createdAt?: number
  startedAt?: number
  finishedAt?: number
  readonly steps: Map<string, Step>
}

/* A work child, a rerun of one under its round, and a re-application of its conflicted work; never the placement choice beside it. */
const WORK_ID = /^issue-sweep\/(\d+)(?:\/attempt-\d+(?:\/round-\d+)?)?$/
const READOPT_ID = /^issue-sweep\/(\d+)\/attempt-\d+(?:\/round-\d+)?\/readopt-\d+$/
const ADOPT_CONFLICTED = "issue-sweep/AdoptConflicted"

const placementOf = (value: unknown): "local" | "vm" | "cloud" | undefined =>
  value === "local" || value === "vm" || value === "cloud" ? value : undefined

const resultOf = (payload: Rec): { readonly value: unknown; readonly complete: boolean } | undefined => {
  const result = record(payload.result)
  const preview = str(result?.preview)
  if (preview === undefined || preview === "") return undefined
  const salvaged = salvage(preview)
  if (salvaged === undefined) return undefined
  return { value: salvaged.value, complete: salvaged.complete && result?.truncated !== true }
}

const STAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/

/** `jj diff --stat`'s summary line as numbers. */
export const diffStat = (changed: string): DiffStat | undefined => {
  const match = STAT.exec(changed)
  if (match === null) return undefined
  return { files: Number(match[1]), insertions: Number(match[2] ?? 0), deletions: Number(match[3] ?? 0) }
}

/* A state may hold one parenthesis of its own: `codex-1 (cooling (codex-1@gpt-6.1-sol))`. */
const OUT = /([^\s,(]+) \(((?:[^()]|\([^()]*\))*)\)/g

/** The accounts an `Exhausted` capacity names: `reset accounts: codex-1 (limited), claude-2 (signed out)`. */
export const exhaustedAccounts = (detail: string): ReadonlyArray<{ readonly label: string; readonly state: string }> =>
  [...detail.replace(/^reset accounts:\s*/, "").matchAll(OUT)].map((match) => ({ label: match[1]!, state: match[2]! }))

/*
 * The account a failure message names (flows/issue-sweep/work/flow.ts), when
 * the failure carries no `account` field: a local run's `codex codex-1: exit
 * 1: ...`, then a remote one's `codex-1 on issue-sweep:<repo>#<n>: ...` or
 * `codex-1 on vm: exit 1: ...`, then a login's `claude-1: no usable
 * oauth-token file ...`. The rotator's "unknown" names nobody.
 */
const LOCAL_FAILED_ACCOUNT = /^(?:codex|claude) (\S+): /
const REMOTE_FAILED_ACCOUNT = /^(\S+) on \S+: /
const LOGIN_FAILED_ACCOUNT = /^((?:codex|claude)-[\w-]+): /
/* The agent a failure message names: a local run's `codex codex-1: ...` or `codex: no answer ...`, a guest's `claude on vm: no answer ...`. */
const FAILED_AGENT = /^(codex|claude)(?::| \S+: | on \S+: )/
/* Not accounts: the rotator's "unknown", and the agent a guest timeout names (`codex on vm: no answer within 1h`). */
const NOT_ACCOUNTS: ReadonlySet<string> = new Set(["unknown", "codex", "claude"])
const failedAccount = (failure: Record<string, unknown> | undefined, message: string | undefined): string | undefined => {
  const account = str(failure?.account) ??
    (message === undefined ? undefined
      : LOCAL_FAILED_ACCOUNT.exec(message)?.[1] ?? REMOTE_FAILED_ACCOUNT.exec(message)?.[1] ?? LOGIN_FAILED_ACCOUNT.exec(message)?.[1])
  return account === undefined || NOT_ACCOUNTS.has(account) ? undefined : account
}
/** A landed row: `<commit> by <agent> <account>`. */
const LANDED = /^(\S+) by (\S+) (\S+)/
const PULL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

interface Row { readonly id: string; readonly status: string; readonly detail: string }

const rowsOf = (value: unknown): ReadonlyArray<Row> => {
  const rows = record(value)?.rows
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const fields = record(row)
    const id = str(fields?.id), status = str(fields?.status)
    return id === undefined || status === undefined ? [] : [{ id, status, detail: str(fields?.detail) ?? "" }]
  })
}

const IN_FLIGHT: ReadonlySet<BurndownState> = new Set(["claimed", "working", "adopting"])

const order = (state: BurndownState): number => BURNDOWN_STATES.indexOf(state)

/**
 * The burndown a run journal describes.
 *
 * @param events the run's control events (`run-events` rows), journal order
 * @param run the run card's phase and launch input
 */
export const burndownOf = (
  events: ReadonlyArray<Rec>,
  run: { readonly phase?: string; readonly error?: string | undefined; readonly input?: Readonly<Record<string, unknown>> | undefined } = {}
): BurndownView => {
  const executions = new Map<string, Execution>()
  const execution = (id: string): Execution => {
    let found = executions.get(id)
    if (found === undefined) executions.set(id, found = { id, steps: new Map() })
    return found
  }
  let discovered: ReadonlyArray<{ readonly number: number; readonly title: string }> = []
  let listed = false
  // A landed issue is closed, so a later round no longer lists it; its title is the one an earlier round read.
  const titles = new Map<number, string>()
  let capacity: { readonly tag: string; readonly slots?: number; readonly at?: number; readonly detail?: string } | undefined
  const rows = new Map<string, Row>()
  let status: { readonly health?: string; readonly freshness?: string; readonly observedAt?: number } = {}
  let runKind: string | undefined
  let journaledInput: Rec | undefined
  let sequence = 0
  for (const event of events) {
    sequence += 1
    const kind = str(event.kind)
    const payload = record(event.payload)
    if (kind === undefined || payload === undefined) continue
    if (kind.startsWith("control.run.")) runKind = kind.slice("control.run.".length)
    if (kind === "control.status.observed") {
      status = { health: str(payload.health), freshness: str(payload.freshness), observedAt: num(payload.observedAt) }
      continue
    }
    if (kind !== "control.engine.event") continue
    const executionId = str(payload.executionId)
    const body = record(payload.payload)
    const eventType = str(payload.eventType)
    if (executionId === undefined || body === undefined) continue
    if (eventType === "flows.engine.run-decision") {
      const observation = record(record(body.executionFact)?.observation)
      if (observation === undefined) continue
      const target = execution(str(observation.executionId) ?? executionId)
      target.flowName = str(observation.flowName) ?? target.flowName
      target.status = str(observation.status) ?? target.status
      target.createdAt = num(observation.createdAtMs) ?? target.createdAt
      target.startedAt = num(observation.startedAtMs) ?? target.startedAt
      target.finishedAt = num(observation.finishedAtMs) ?? target.finishedAt
      target.child = str(observation.parentRunId) !== undefined
      target.cancelRequested = num(observation.cancelRequestedAtMs) !== undefined
      if (str(body.decision) === "created") {
        const created = record(record(body.state)?.payload)
        target.placement = placementOf(created?.placement) ?? target.placement
        if (target.flowName === "issue-sweep/rounds") journaledInput = record(created?.input) ?? journaledInput
      }
      continue
    }
    const action = str(body.action), nodeId = str(body.nodeId)
    if (action === undefined || nodeId === undefined) continue
    const owner = execution(executionId)
    const key = `${nodeId}#${action}`
    if (eventType === "flows.engine.node-scheduled") {
      owner.steps.set(key, { executionId, action, nodeId, sequence: num(event.sequence) ?? sequence })
      continue
    }
    if (eventType !== "flows.engine.node-settled") continue
    const outcome = str(body.outcome) ?? "built"
    const result = resultOf(body)
    const previous = owner.steps.get(key)
    owner.steps.set(key, {
      executionId, action, nodeId, sequence: previous?.sequence ?? num(event.sequence) ?? sequence,
      settled: { outcome, value: result?.value, complete: result?.complete ?? false }
    })
    if (outcome !== "built" || result === undefined) continue
    if (action === "issue-sweep/accounts") {
      const answer = record(result.value)
      const tag = str(answer?.["_tag"])
      if (tag !== undefined) capacity = { tag, slots: num(answer?.slots), at: num(answer?.at), detail: str(answer?.detail) }
    } else if (action === "issue-sweep/list-issues" && Array.isArray(result.value)) {
      listed = true
      discovered = result.value.flatMap((issue) => {
        const fields = record(issue)
        const number = num(fields?.number), title = str(fields?.title)
        return number === undefined || title === undefined ? [] : [{ number, title }]
      })
      for (const issue of discovered) titles.set(issue.number, issue.title)
    } else if (action === "issue-sweep/dispatch") {
      // Burndown.make's merge: a settled row is final; a skipped or requeued row yields to the item's latest.
      for (const row of rowsOf(result.value)) {
        const held = rows.get(row.id)
        if (held === undefined || held.status === "skipped" || held.status === "requeued") rows.set(row.id, row)
      }
    }
  }

  // The newest work child per issue: a cancelled attempt reruns under `/round-<n>`. Likewise the newest re-application.
  const newest = (pattern: RegExp): Map<number, Execution> => {
    const found = new Map<number, Execution>()
    for (const each of executions.values()) {
      const match = pattern.exec(each.id)
      if (match === null) continue
      const number = Number(match[1])
      const held = found.get(number)
      if (held === undefined || (each.createdAt ?? 0) >= (held.createdAt ?? 0)) found.set(number, each)
    }
    return found
  }
  const children = newest(WORK_ID)
  const readopts = newest(READOPT_ID)

  const input = journaledInput ?? run.input
  // A child whose own payload is not journaled ran remote work in the run's placement.
  const placementInput = input?.placement === "vm" ? "vm" : undefined
  const numbers = new Set<number>([...discovered.map((issue) => issue.number), ...children.keys()])
  for (const id of rows.keys()) if (/^\d+$/.test(id)) numbers.add(Number(id))

  const items: Array<BurndownItem> = [...numbers].map((number) => {
    const child = children.get(number)
    const row = rows.get(String(number))
    const steps = child === undefined ? [] : [...child.steps.values()]
    const step = (action: string) => steps.filter((each) => each.action === action).at(-1)
    const work = step("issue-sweep/work"), fix = step("issue-sweep/fix"), remote = step("issue-sweep/remote-fix")
    const adopt = step("issue-sweep/adopt")
    // Conflicted remote work is not a failure: the sweep applies it again once main moves (`<child>/readopt-<n>`).
    const builtOf = (each: Step | undefined) => each?.settled?.outcome === "built" ? record(each.settled.value) : undefined
    const failedOf = (each: Step | undefined) => each?.settled?.outcome === "failed" ? record(each.settled.value) : undefined
    const conflicted = [work, adopt].some((each) => str(failedOf(each)?.["_tag"]) === ADOPT_CONFLICTED)
    const readopt = conflicted ? readopts.get(number) : undefined
    const readopted = readopt === undefined ? undefined : [...readopt.steps.values()].filter((each) => each.action === "issue-sweep/adopt").at(-1)
    const readoptFailure = str(failedOf(readopted)?.["_tag"]) === ADOPT_CONFLICTED ? undefined : failedOf(readopted)
    const report = [work, adopt, readopted].map(builtOf).find((each) => each !== undefined)
    const remoteAnswer = record(builtOf(remote)?.result)
    const failure = conflicted ? readoptFailure
      : [work, adopt, remote, fix].map(failedOf).find((each) => each !== undefined)
    const message = str(failure?.message)
    let state: BurndownState
    let reason: string | undefined
    let commit: string | undefined
    let rowAgent: string | undefined, rowAccount: string | undefined
    // A requeued row is an item back in the queue: the next round works it again, and a child still at it says how far it got.
    const requeued = row?.status === "requeued"
    const childLive = child !== undefined && child.status !== "failed" && child.status !== "cancelled" && child.status !== "completed"
    if (requeued && !childLive) {
      state = "ours"
    } else if (row !== undefined && !requeued) {
      state = row.status === "landed" ? "landed" : row.status === "held" ? "held" : row.status === "skipped" ? "skip" : "failed"
      if (state === "landed") {
        const landed = LANDED.exec(row.detail)
        commit = landed?.[1]
        rowAgent = landed?.[2]
        rowAccount = landed?.[3]
      } else if (row.detail !== "") reason = row.detail
    } else if (child === undefined) {
      state = "ours"
    } else if (conflicted) {
      if (readoptFailure !== undefined) {
        state = "failed"
        reason = message
      } else state = builtOf(readopted) === undefined ? "adopting" : "landing"
    } else if (child.status === "failed" || child.status === "cancelled" || work?.settled?.outcome === "failed") {
      state = "failed"
      reason = message ?? (child.status === "cancelled" ? "cancelled" : undefined)
    } else if (child.status === "completed" || work?.settled?.outcome === "built") {
      state = "landing"
    } else if (remote?.settled?.outcome === "built" && adopt !== undefined && adopt.settled === undefined) {
      state = "adopting"
    } else if ((fix !== undefined && fix.settled === undefined) || (remote !== undefined && remote.settled === undefined)) {
      state = "working"
    } else {
      state = "claimed"
    }
    const changed = str(report?.changed)
    const patch = str(report?.patch)
    const account = str(report?.account) ?? str(remoteAnswer?.account) ?? rowAccount ?? failedAccount(failure, message)
    const agent = str(report?.agent) ?? str(remoteAnswer?.agent) ?? rowAgent ?? (message === undefined ? undefined : FAILED_AGENT.exec(message)?.[1])
    const placement = child?.placement ?? (fix !== undefined && fix.settled?.outcome !== "skipped" ? "local"
      : remote !== undefined && remote.settled?.outcome !== "skipped" ? placementInput : undefined)
    const pr = row === undefined ? undefined : PULL.exec(row.detail)?.[0]
    const diff = changed === undefined ? undefined : diffStat(changed)
    // Discovery's title wins; else the child's fetched issue (`{ title, body, comments }`), whose title leads its cut preview.
    const fetched = step("issue-sweep/fetch-issue")
    const title = titles.get(number) ??
      (fetched?.settled?.outcome === "built" ? str(record(fetched.settled.value)?.title) : undefined)
    return {
      number, state,
      ...(title === undefined ? {} : { title }),
      ...(agent === undefined ? {} : { agent }),
      ...(account === undefined ? {} : { account }),
      ...(placement === undefined ? {} : { placement }),
      ...(child === undefined ? {} : { executionId: child.id }),
      ...(child?.startedAt === undefined ? {} : { startedAt: child.startedAt }),
      ...(child?.finishedAt === undefined ? {} : { finishedAt: child.finishedAt }),
      ...(diff === undefined ? {} : { diff }),
      ...(patch === undefined || patch === "" ? {} : { patch }),
      ...(commit === undefined ? {} : { commit }),
      ...(reason === undefined ? {} : { reason }),
      ...(pr === undefined ? {} : { pr })
    }
  })
  items.sort((a, b) => order(a.state) - order(b.state) || b.number - a.number)

  const counts = Object.fromEntries(BURNDOWN_STATES.map((state) => [state, 0])) as Record<BurndownState, number>
  for (const item of items) counts[item.state] += 1

  // A park is a capacity wait still open: WaitFor on Exhausted, Sleep on WaitUntil.
  const open = (action: string): Step | undefined => [...executions.values()].flatMap((each) =>
    each.status === "completed" || each.status === "failed" || each.status === "cancelled" ? []
      : [...each.steps.values()].filter((one) => one.action === action && one.settled === undefined)).at(-1)
  const exhausted = capacity?.tag === "Exhausted" ? exhaustedAccounts(capacity.detail ?? "") : []
  const waiting = open("system/wait-for")
  const parked: BurndownParked = waiting !== undefined
    ? { kind: "exhausted", since: waiting.sequence, accounts: exhausted }
    : open("system/sleep") !== undefined && capacity?.at !== undefined
      ? { kind: "wait-until", at: capacity.at }
      : { kind: "none" }

  const accounts = new Map<string, { items: number; active: number; landed: number; failed: number; state?: string }>()
  const account = (label: string) => {
    let held = accounts.get(label)
    if (held === undefined) accounts.set(label, held = { items: 0, active: 0, landed: 0, failed: 0 })
    return held
  }
  for (const out of exhausted) account(out.label).state = out.state
  for (const item of items) {
    if (item.account === undefined) continue
    const held = account(item.account)
    held.items += 1
    if (IN_FLIGHT.has(item.state)) held.active += 1
    if (item.state === "landed") held.landed += 1
    if (item.state === "failed") held.failed += 1
  }
  const resetting = new Set(parked.kind === "exhausted" ? parked.accounts.map((out) => out.label) : [])

  const phase = run.phase
  const settledStatus: BurndownStatus | undefined =
    phase === "cancelled" || runKind === "cancelled" ? "cancelled"
      : phase === "failed" || runKind === "failed" ? "failed"
      : phase === "completed" || runKind === "completed" ? "completed"
      : undefined
  const maxAgents = num(input?.maxAgents)
  const cloudAgents = num(input?.cloudAgents)
  const runStatus = settledStatus ?? (parked.kind === "none" ? "running" : "parked")
  return {
    status: runStatus,
    ...(input === undefined ? {} : { input }),
    items,
    discovered: listed,
    stopping: settledStatus === undefined && [...executions.values()].some((each) => each.child !== true && each.cancelRequested === true),
    ...(runStatus === "failed" && run.error !== undefined && run.error !== "" ? { failure: run.error } : {}),
    counts,
    capacity: {
      ...(capacity?.tag === "Available" && capacity.slots !== undefined ? { slots: capacity.slots } : {}),
      active: items.filter((item) => IN_FLIGHT.has(item.state)).length
    },
    parked,
    accounts: [...accounts].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([label, held]) => ({
      label, items: held.items, active: held.active, landed: held.landed, failed: held.failed,
      needsReset: resetting.has(label),
      ...(held.state === undefined ? {} : { state: held.state })
    })),
    machine: {
      ...status,
      vms: items.filter((item) => item.placement === "vm" && item.state === "working").length,
      ...(maxAgents === undefined ? {} : { maxAgents }),
      ...(cloudAgents === undefined || cloudAgents <= 0 ? {} : {
        cloud: { active: items.filter((item) => item.placement === "cloud" && item.state === "working").length, agents: cloudAgents }
      })
    }
  }
}

/* ------------------------------------------------------------------ words */

/** The flow's own placement words, as a row and a detail say them. */
export const PLACEMENT_WORDS = { local: "Local", vm: "VM", cloud: "Cloud" } as const satisfies Record<NonNullable<BurndownItem["placement"]>, string>

/**
 * Who worked an issue, as the journal names them: the account, which carries
 * its agent's name (`claude-1`); the agent before an account that does not;
 * the agent alone when no account is journaled. Nothing is derived: an issue
 * still being worked has neither.
 */
export const burndownAgent = (item: Pick<BurndownItem, "agent" | "account">): string | undefined =>
  item.account === undefined ? item.agent
    : item.agent === undefined || item.account.startsWith(`${item.agent}-`) ? item.account
    : `${item.agent} ${item.account}`

/* ------------------------------------------------------------ card states */

/** What the card can show: nothing yet (the run is starting), a run whose journal is unread, or the board. */
export type BurndownStage = "launching" | "loading" | "ready"

/** A run card with no run yet is launching; one whose journal has not been read is loading. */
export const burndownStage = (run: { readonly phase?: string; readonly runId?: string; readonly events?: ReadonlyArray<unknown> | undefined }): BurndownStage =>
  run.phase === "launching" || run.runId === undefined || run.runId === "" || run.runId.startsWith("pending-") ? "launching"
    : run.events === undefined ? "loading"
    : "ready"

/** This client's watch of the run (workflow-pump.ts): the phases that are about the watcher, not the run. */
export type BurndownObserver = "connected" | "reconnecting" | "quiet" | "stopped"

export const burndownObserver = (phase: string | undefined): BurndownObserver =>
  phase === "reconnecting" || phase === "quiet" || phase === "stopped" ? phase : "connected"

export interface BurndownControls {
  /** Stop a run that is still going and still watched. */
  readonly stop: boolean
  /** Resume: the reset signal for a park on exhausted accounts, a restart with the same input for a stopped or failed run. */
  readonly resume?: "signal" | "restart"
  /** Check again: the watch went quiet or stopped. */
  readonly retry: boolean
}

/** The controls a state offers; one that does not apply is absent. */
export const burndownControls = (view: BurndownView, stage: BurndownStage, observer: BurndownObserver): BurndownControls => {
  if (stage === "launching") return { stop: false, retry: false }
  // A journal not read yet says nothing the controls could act on: they appear with the board.
  if (stage === "loading") return { stop: false, retry: observer === "quiet" || observer === "stopped" }
  const live = view.status === "running" || view.status === "parked"
  const resume = view.parked.kind === "exhausted" && live ? "signal" as const
    : view.status === "cancelled" || view.status === "failed" ? "restart" as const
    : undefined
  return {
    stop: live && observer !== "stopped",
    ...(resume === undefined ? {} : { resume }),
    retry: observer === "quiet" || observer === "stopped"
  }
}

export interface BurndownMove { readonly number: number; readonly from: BurndownState; readonly to: BurndownState }

/** The issues whose state differs between two readings of one run; an issue new to the board is not a move. */
export const burndownMoves = (previous: BurndownView, next: BurndownView): ReadonlyArray<BurndownMove> => {
  const before = new Map(previous.items.map((item) => [item.number, item.state]))
  return next.items.flatMap((item) => {
    const from = before.get(item.number)
    return from === undefined || from === item.state ? [] : [{ number: item.number, from, to: item.state }]
  })
}
