/**
 * `issue-sweep`: works every open GitHub issue that no other machine holds,
 * as a `Burndown` from `@smthrs/patterns`. Each round asks the Codex and
 * Claude account pools for capacity, lists the open issues, claims the ones
 * that are ours, fixes each in its own jj workspace (`issue-sweep/work`), lands
 * each result on `main` as its fix finishes, checking up to `landers` changes
 * at once and pushing one at a time, and releases every claim. A finished fix
 * frees its slot for the next issue. With every account out, the sweep parks
 * until an operator resets accounts and signals
 * `issue-sweep/accounts-reset`.
 */
import { Action, Flow, type FlowRuntime, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import { Burndown } from "@smthrs/patterns"
import { Cause, Clock, Effect, Layer, Schedule, Schema, Semaphore } from "effect"
import type * as Crypto from "effect/Crypto"
import { readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { capacity, perAccount, type Pools, readPools } from "./accounts.ts"
import { api, openIssues } from "./github.ts"
import { HostFailed, repository, run, tail, workspaces } from "./host.ts"
import { landChange, LandFailed } from "./land.ts"
import { infraCaused, noChangeLabel, recordVerdict, requalified } from "./verdict.ts"
import { statfsFree } from "./vm.ts"
import Work, { AgentFailed, checkoutIssue, type NoChange, removeWorkspace, type Report, requeue } from "./work/flow.ts"

// The most landings one round runs at once; `landers` picks fewer.
const maxLanders = 16

export const Input = Schema.Struct({
  repo: Schema.String,
  // Local agents only; microVMs additionally obey the sustainable host limit of 24.
  maxAgents: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32))),
  cloudAgents: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  // Each issue's work child is keyed by this attempt, so a restarted sweep
  // reattaches to its children; a new attempt works failed issues afresh.
  attempt: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  // Where agents run: on this Mac in their own sandbox (default), or in local microVMs.
  placement: Schema.optional(Schema.Literals(["local", "vm"])),
  // How many changes run their landing checks at once (default 6); pushes stay serial.
  landers: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(maxLanders))
  )
})

const Issue = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  labels: Schema.Array(Schema.String)
})

export class GhFailed extends Schema.TaggedError<GhFailed>()("issue-sweep/GhFailed", {
  message: Schema.String
}) {}

const RoundPayload = { input: Input, round: Schema.Number }

export const ListIssues = Action.make("issue-sweep/list-issues", {
  payload: RoundPayload,
  success: Schema.Array(Issue),
  error: GhFailed,
  nondeterministic: true
})

export const Accounts = Action.make("issue-sweep/accounts", {
  payload: RoundPayload,
  success: Burndown.Capacity,
  error: HostFailed,
  nondeterministic: true
})

export const Dispatch = Burndown.dispatch("issue-sweep/dispatch")

/** The operator signal a sweep parked on exhausted accounts waits for. */
export const accountsReset = "issue-sweep/accounts-reset"

const Rounds = Burndown.make({
  name: "issue-sweep/rounds",
  description: "One issue-sweep round per handoff, until no open issue is ours.",
  discover: ListIssues,
  capacity: Accounts,
  dispatch: Dispatch,
  maxRounds: 500,
  signal: accountsReset
})

// scripts/issue-claim.mjs: exit 0 done, 2 held by someone else, 75 rate limited.
// The copy beside this flow, never the shared checkout's: another session's
// half-made edit there failed every claim and release of a running sweep.
export const claimTool = fileURLToPath(new URL("../../scripts/issue-claim.mjs", import.meta.url))

// Discovery reads capabilities only as a string-literal array with no
// comments, so the checkout path in the GitHub proxy and claim tool grants is a
// wildcard.
export default Flow.make("issue-sweep", {
  description: "Work every open GitHub issue that no other machine holds.",
  capabilities: [
    "proc:spawn:gh api *",
    "proc:spawn:node /*/scripts/github-proxy.mjs --ensure",
    "proc:spawn:node /*/scripts/issue-claim.mjs *",
    "proc:spawn:jj -R *",
    "proc:spawn:lockf *",
    "proc:spawn:pnpm *",
    "proc:spawn:codex *",
    "proc:spawn:codex-rr *",
    "proc:spawn:claude-rr *",
    "proc:spawn:claude-as *"
  ],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "compensable" },
  modelInvocable: false,
  payload: Input,
  success: Burndown.Result,
  error: Schema.Unknown,
  body: (input) => Rounds.child({ input })
})

// The machine whose live claims we leave alone.
const macMini = "Williams-Mac-mini.local"

// The issue-claim comment: "Claimed by <who> on <host> at <UTC>; expires <UTC>".
const claimLine = /^Claimed by (.+) on (\S+) at (\S+); expires (\S+?)\.?(?:\s|$)/

/**
 * Why an issue is not agent work at all, or `undefined`. A maintainer must
 * decide `blocked-on-will` issues, `benchmark` issues belong to the separate
 * benchmark program, and a "Deferred" issue is parked past the release by
 * title; agents dispatched to them could only report no change.
 */
export const parkedFor = (issue: { readonly title: string; readonly labels: ReadonlyArray<string> }) =>
  issue.labels.includes("blocked-on-will")
    ? "blocked on the maintainer"
    : issue.labels.includes("benchmark")
    ? "benchmark: separate program"
    : /^deferred\b/i.test(issue.title.trim())
    ? "deferred"
    : undefined

/** Skip an issue only while the Mac mini holds an unexpired claim on it. */
export const decide = (claim: string | undefined, nowMillis: number): "skip" | "ours" => {
  const match = claim === undefined ? null : claimLine.exec(claim)
  if (match === null) return "ours"
  const [, , host, , expires] = match
  return host === macMini && Date.parse(expires ?? "") > nowMillis ? "skip" : "ours"
}

const github = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.mapError(
    effect,
    (cause) => new GhFailed({ message: String((cause as { message?: unknown }).message ?? cause) })
  )

/**
 * The issue workspaces left beside the checkout whose issue is no longer open.
 * A cancelled run, or a requeued item never worked again, leaves its
 * workspace with installed dependencies behind; 51 of them held 24 GiB.
 */
export const staleWorkspaces = (entries: ReadonlyArray<string>, open: ReadonlySet<number>): ReadonlyArray<number> =>
  entries.flatMap((entry) => {
    const match = /^issue-(\d+)$/.exec(entry)
    return match === null || open.has(Number(match[1])) ? [] : [Number(match[1])]
  })

const reapWorkspaces = (open: ReadonlySet<number>) =>
  Effect.gen(function*() {
    const entries = yield* Effect.promise(() => readdir(workspaces).catch(() => [] as Array<string>))
    yield* Effect.forEach(staleWorkspaces(entries, open), removeWorkspace, { discard: true })
  })

const listIssues = ListIssues.toLayer(({ input }) =>
  github(openIssues(input.repo)).pipe(
    Effect.tap((rows) => reapWorkspaces(new Set(rows.map((row) => row.number)))),
    Effect.map((rows) => rows.map((row) => ({ id: String(row.number), ...row })))
  )
)

export const maxLocalVms = 24
export const minFreeBytes = 25 * 1024 ** 3

type Placement = "local" | "vm" | "cloud"
const Placement = Schema.Literals(["local", "vm", "cloud"])

export const localLimit = (input: typeof Input.Type, freeBytes: number): number =>
  input.placement === "vm"
    ? freeBytes < minFreeBytes ? 0 : Math.min(maxLocalVms, input.maxAgents ?? 4)
    : input.maxAgents ?? 4

/** A total ceiling, including in-flight sweep work; Burndown compares it to work still running. */
export const placementCapacity = (input: typeof Input.Type, pools: Pools, limit: number, freeBytes: number) => {
  const local = localLimit(input, freeBytes)
  const cloud = input.cloudAgents ?? 0
  const codex = pools.codex.ready.reduce(
    (n, account) => n + Math.max(0, limit - (pools.codex.active?.[account] ?? 0)),
    0
  )
  const claude = pools.claude.ready.reduce(
    (n, account) => n + Math.max(0, limit - (pools.claude.active?.[account] ?? 0)),
    0
  )
  const slots = Math.min(local + cloud, codex + claude)
  return slots > 0
    ? Burndown.available(slots)
    : capacity(pools, limit, 0)
}

/** Reserve a placement atomically, preferring the host whenever its slot is free. */
export const makePlacementSlots = () => {
  let local = 0
  let cloud = 0
  return {
    reserve: (input: typeof Input.Type, freeBytes: number, preferred?: Placement) => {
      const placement: Placement | undefined = preferred === "cloud"
        ? cloud < (input.cloudAgents ?? 0) ? "cloud" : undefined
        : local < localLimit(input, freeBytes) ?
        input.placement ?? "local"
        : preferred === undefined && cloud < (input.cloudAgents ?? 0)
        ? "cloud"
        : undefined
      if (placement === undefined) return undefined
      if (placement === "cloud") cloud++
      else local++
      let released = false
      return {
        placement,
        release: () => {
          if (released) return
          released = true
          if (placement === "cloud") cloud--
          else local--
        }
      }
    }
  }
}
const placements = new Map<string, ReturnType<typeof makePlacementSlots>>()
const placementLeases = new Map<string, { readonly placement: Placement; release(): void }>()
const releasePlacement = (executionId: string) =>
  Effect.sync(() => {
    placementLeases.get(executionId)?.release()
    placementLeases.delete(executionId)
  })

const reservePlacement = (input: typeof Input.Type, executionId: string, preferred?: Placement) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const slots = placements.get(input.repo) ?? makePlacementSlots()
      placements.set(input.repo, slots)
      for (;;) {
        const reserved = slots.reserve(input, input.placement === "vm" ? statfsFree() : Infinity, preferred)
        if (reserved !== undefined) {
          placementLeases.set(executionId, reserved)
          return reserved.placement
        }
        yield* restore(Effect.sleep("1 second"))
      }
    })
  )

/** The choice is journaled separately so the work child's payload survives a resumed dispatch. */
export const ChoosePlacement = Action.make("issue-sweep/choose-placement", {
  payload: { executionId: Schema.String },
  success: Placement,
  error: AgentFailed,
  nondeterministic: true
})
export const PlacementChoice = Flow.make("issue-sweep/placement", {
  description: "Keep an issue's original placement when its sweep resumes.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "compensable" },
  modelInvocable: false,
  payload: ChoosePlacement.payloadSchema,
  success: Placement,
  error: AgentFailed,
  body: (input) => ChoosePlacement.call(input)
})
const choosePlacement = ChoosePlacement.toLayer(({ executionId }) => {
  const reserved = placementLeases.get(executionId)
  return reserved === undefined
    ? Effect.fail(new AgentFailed({ message: `${executionId}: placement reservation was released` }))
    : Effect.succeed(reserved.placement)
})

const readCapacity = (input: typeof Input.Type) =>
  Effect.gen(function*() {
    const pools = yield* readPools
    const free = input.placement === "vm" ? statfsFree() : Infinity
    const result = placementCapacity(input, pools, perAccount, free)
    // Occupied jobs and disk pressure are temporary; retry without an account reset.
    return result._tag === "Exhausted" &&
        (pools.codex.ready.length + pools.claude.ready.length) > 0
      ? Burndown.waitUntil((yield* Clock.currentTimeMillis) + 30_000)
      : result
  })

const accounts = Accounts.toLayer(({ input }) => readCapacity(input))

/** The first line of the newest claim comment on `issue`, if any. */
const newestClaim = (repo: string, issue: number) =>
  github(api(`repos/${repo}/issues/${issue}/comments?per_page=100`, [
    "--paginate",
    "--jq",
    ".[].body | select(startswith(\"Claimed by\")) | split(\"\\n\")[0]"
  ])).pipe(Effect.map((stdout) => stdout.split("\n").filter((line) => line !== "").at(-1)))

const by = "issue-sweep"

class RateLimited extends Schema.TaggedError<RateLimited>()("issue-sweep/RateLimited", {
  message: Schema.String
}) {}

/** Runs one issue-claim command, retrying while GitHub rate limits it. */
const claimCommand = (args: ReadonlyArray<string>) =>
  run("node", [claimTool, ...args]).pipe(
    Effect.mapError((cause) => new AgentFailed({ message: cause.message })),
    Effect.flatMap((exited) =>
      exited.code === 75
        ? Effect.fail(new RateLimited({ message: exited.stderr.trim() || exited.stdout.trim() }))
        : Effect.succeed(exited)
    ),
    Effect.retry({
      while: (error) => error._tag === "issue-sweep/RateLimited",
      schedule: Schedule.exponential("30 seconds"),
      times: 6
    }),
    Effect.catchTag("issue-sweep/RateLimited", (error) =>
      Effect.fail(new AgentFailed({ message: `issue-claim: rate limited: ${error.message}` })))
  )

type Item = typeof Issue.Type
type Args = Burndown.ItemArgs<unknown, Item>
type Worked = typeof Report.Type
/** Every typed failure a member reports; the round renders each by its message. */
type Failure =
  | GhFailed
  | AgentFailed
  | NoChange
  | HostFailed
  | LandFailed
  | Schema.SchemaError
  | FlowRuntime.FlowCycleDetected
/** What running the work child needs from the engine that executes the sweep. */
type Engine = FlowRuntime.FlowRuntime | Crypto.Crypto
const repoOf = (args: { readonly input: unknown }) => (args.input as typeof Input.Type).repo
const ref = (args: Args) => `${repoOf(args)}#${args.item.number}`

/**
 * Whether settling a row releases its claim and removes its workspace. A
 * `requeued` row keeps both: the run was released (a lapsed lease), and on
 * resume its children carry on in those workspaces and land under that
 * claim; removing them failed every resumed landing (run-4, 07:18Z). The next
 * round's claim by the same holder refreshes it, and a fresh workspace
 * replaces the old one.
 */
export const releasesClaim = (status: Burndown.Status): boolean => status !== "requeued"

/**
 * Records a no-change verdict on the issue, then fails with it, so the item
 * settles `failed` and the label keeps later runs off it. A verdict our own
 * infrastructure caused is not recorded: the next run retries the issue.
 */
const settleNoChange = (repo: string, issue: number, verdict: NoChange) =>
  Effect.gen(function*() {
    if (infraCaused(verdict.report) !== undefined) return yield* verdict
    const at = new Date(yield* Clock.currentTimeMillis).toISOString()
    yield* github(recordVerdict(repo, issue, verdict.report, at)).pipe(
      Effect.catch((failed) =>
        Effect.fail(new AgentFailed({ message: `${verdict.message}; verdict not recorded: ${failed.message}` }))
      )
    )
    return yield* verdict
  })

// One gate per `landers` value: at most that many landings check at once.
const landGates = new Map<number, Semaphore.Semaphore>()
const landGate = (landers: number) => {
  const gate = landGates.get(landers) ?? Semaphore.makeUnsafe(landers)
  landGates.set(landers, gate)
  return gate
}

const dispatchOptions: Burndown.RoundOptions<unknown, Item, Worked, Failure, Engine, string> = {
  key: "issue-sweep",
  // The round's capacity slots bound how many work at once; this is only the
  // ceiling. A freed slot takes the next issue while the accounts still allow.
  concurrency: 32,
  capacity: (args) => readCapacity(args.input as typeof Input.Type),
  select: (args) =>
    Effect.gen(function*() {
      const parked = parkedFor(args.item)
      if (parked !== undefined) return Burndown.skip(parked)
      if (args.item.labels.includes(noChangeLabel) && !(yield* github(requalified(repoOf(args), args.item.number)))) {
        return Burndown.skip("no change; waiting on a human")
      }
      if (!args.item.labels.includes("in-progress")) return Burndown.ours
      const now = yield* Clock.currentTimeMillis
      const claim = yield* newestClaim(repoOf(args), args.item.number)
      return decide(claim, now) === "skip" ? Burndown.skip(`claimed on ${macMini}`) : Burndown.ours
    }),
  claim: (args) =>
    Effect.flatMap(
      claimCommand(["claim", ref(args), "--by", by]),
      (exited): Effect.Effect<void, AgentFailed | Burndown.Held> =>
        exited.code === 0
          ? Effect.void
          : exited.code === 2
          ? Effect.fail(new Burndown.Held({ message: exited.stdout.trim() || exited.stderr.trim() }))
          : Effect.fail(new AgentFailed({ message: `issue-claim claim: exit ${exited.code}: ${tail(exited.stderr)}` }))
    ),
  // The host registers issue-sweep/work and its implementations from its own
  // file; providing them again per call registers a conflicting second copy.
  // Its plan does not name its requirements, so the engine's are stated here.
  // A child keeps its outcome under its id, so the sweep's attempt is part of
  // the id. A child an operator cancelled stays cancelled, and joining it
  // again only reports the interruption; that issue then runs afresh under an
  // id scoped to this round, which a replay of the round still reattaches to.
  // Remote work that conflicts with main is applied again from its journaled
  // diff once main moves, without running the agent again.
  work: (args) =>
    Effect.scoped(Effect.gen(function*() {
      const input = args.input as typeof Input.Type
      const id = `${args.executionId}/attempt-${input.attempt ?? 1}`
      yield* Effect.addFinalizer(() => releasePlacement(id))
      const tentative = yield* reservePlacement(input, id)
      const placement = yield* PlacementChoice.execute({ executionId: id }, {
        executionId: `${id}/placement`
      }) as Effect.Effect<Placement, Failure, Engine>
      if (placement !== tentative) {
        yield* releasePlacement(id)
        yield* reservePlacement(input, id, placement)
      }
      const execute = (executionId: string) =>
        Work.execute({ repo: input.repo, issue: args.item.number, placement }, {
          executionId
        })
      return yield* execute(id).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? execute(`${id}/round-${args.round}`) : Effect.failCause(cause)
        ),
        Effect.catchTag(
          "issue-sweep/AdoptConflicted",
          (conflict) => requeue(conflict, { repo: input.repo, issue: args.item.number, executionId: id, repository })
        ),
        // A workspace this machine cannot prepare would fail every issue the
        // same way: stop the sweep (its claims are released) instead.
        Effect.catchTag("issue-sweep/WorkspaceFailed", (error) => Effect.die(error)),
        Effect.catchTag("issue-sweep/NoChange", (verdict) => settleNoChange(input.repo, args.item.number, verdict))
      ) as Effect.Effect<Worked, Failure, Engine>
    })),
  landConcurrency: maxLanders,
  // An issue someone closed while its agent worked is already settled; landing
  // a second fix for it would only duplicate the first. The change's
  // workspace exists only while it lands: release removes it.
  land: ({ input, item, output }) =>
    Semaphore.withPermit(
      landGate((input as typeof Input.Type).landers ?? 6),
      Effect.gen(function*() {
        const state = yield* github(api(`repos/${(input as typeof Input.Type).repo}/issues/${item.number}`, [
          "--jq",
          ".state"
        ]))
        if (state.trim() !== "open") {
          return yield* new LandFailed({
            message: `#${item.number} is ${state.trim().toLowerCase()}; change ${output.change} not landed`
          })
        }
        const workspace = yield* checkoutIssue(item.number, output.change).pipe(
          Effect.mapError((cause) => new LandFailed({ message: `checkout: ${cause.message}` }))
        )
        return yield* landChange(workspace, output.change)
      })
    ),
  detail: (report, landed) =>
    `${landed === undefined ? report.change : landed.slice(0, 12)} by ${report.agent} ${report.account}`,
  release: (args) =>
    Effect.gen(function*() {
      if (!releasesClaim(args.status)) return
      const note = args.detail.replaceAll("\n", " ").slice(0, 300)
      const released = args.status === "landed"
        ? claimCommand([
          "comment",
          ref(args),
          "--body",
          `Landed on main by issue-sweep: ${note}`,
          "--close",
          "--release",
          "--by",
          by,
          "--note",
          note
        ])
        : claimCommand(["release", ref(args), "--by", by, "--note", `${args.status}: ${note}`])
      const exited = yield* released
      yield* removeWorkspace(args.item.number)
      if (exited.code !== 0) {
        return yield* new AgentFailed({ message: `issue-claim release: exit ${exited.code}: ${tail(exited.stderr)}` })
      }
    })
}

const dispatch = Dispatch.toLayer((payload) =>
  Burndown.round({
    input: payload.input,
    round: payload.round,
    items: payload.items as ReadonlyArray<Item>,
    settled: payload.settled,
    slots: payload.slots
  }, {
    ...dispatchOptions,
    concurrency: Math.max(
      1,
      Math.min(
        Array.isArray(payload.items) ? payload.items.length : 1,
        ((payload.input as typeof Input.Type).maxAgents ?? 4) + ((payload.input as typeof Input.Type).cloudAgents ?? 0)
      )
    )
  })
)

// The rounds are a flow of their own that no file declares, so this module
// registers them; the host registers only discovered file flows.
export const layer = Layer.mergeAll(
  listIssues,
  accounts,
  dispatch,
  choosePlacement,
  Interpreter.layer(PlacementChoice),
  Sleep.layer,
  WaitFor.layer,
  Interpreter.layer(Rounds)
)
