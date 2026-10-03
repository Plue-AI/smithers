/**
 * `issue-sweep`: works every open GitHub issue that no other machine holds,
 * as a `Burndown` from `@smthrs/patterns`. Each round asks the Codex and
 * Claude account pools for capacity, lists the open issues, claims the ones
 * that are ours, triages each (`triage.ts`) so only an issue that needs a code
 * change is claimed, fixes each in its own jj workspace (`issue-sweep/work`), lands
 * each result on `main` as its fix finishes, checking up to `landers` changes
 * at once and pushing one at a time, and releases every claim. A finished fix
 * frees its slot for the next issue. With every account out, the sweep parks
 * until an operator resets accounts and signals
 * `issue-sweep/accounts-reset`.
 */
import { Action, Fault, Flow, type FlowRuntime, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import { Unreachable } from "@smthrs/kernel"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Burndown, PatternError } from "@smthrs/patterns"
import { Cause, Clock, Effect, Layer, Schedule, Schema, Semaphore } from "effect"
import type * as Crypto from "effect/Crypto"
import { randomUUID } from "node:crypto"
import { appendFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { capacity, perAccount, type Pools, readPools } from "./accounts.ts"
import { configureDiskReaper, DiskAdmission, diskLayer, makeSettledWorkspaceReaper, workspaceBytes } from "./disk.ts"
import { api, issue as readIssue, openIssues } from "./github.ts"
import { HostFailed, repository, run, tail, workspaces } from "./host.ts"
import { terminalIdentityConflict } from "./identity.ts"
import { landChange, LandFailed } from "./land.ts"
import {
  cachePath,
  classify,
  fileCache,
  preflight,
  screen,
  type Seams,
  type Text,
  type TriageFailed
} from "./triage.ts"
import { infraCaused, noChangeLabel, recordVerdict, requalified } from "./verdict.ts"
import { vmFields, vmOptions } from "./vm-options.ts"
import { statfsFree } from "./vm.ts"
import Work, { AgentFailed, checkoutIssue, type NoChange, removeWorkspace, type Report, requeue } from "./work/flow.ts"

// The most landings one round runs at once; `landers` picks fewer.
const maxLanders = 16

export const Input = Schema.Struct({
  ...vmFields,
  repo: Schema.String,
  issue: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  // Local agents only; microVMs additionally obey the sustainable host limit of 24.
  maxAgents: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32))),
  cloudAgents: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  // Each issue's work child is keyed by this attempt, so a restarted sweep
  // reattaches to its children; a new attempt works failed issues afresh.
  attempt: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  // Where agents run: on this Mac in their own sandbox (default), or in local microVMs.
  placement: Schema.optional(Schema.Literals(["local", "vm", "cloud"])),
  // How many changes run their landing checks at once (default 6); pushes stay serial.
  landers: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(maxLanders))
  )
})

const Issue = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  labels: Schema.Array(Schema.String),
  // Optional so a run journaled before triage still decodes its issue lists.
  updatedAt: Schema.optional(Schema.String)
})

export class GhFailed extends Schema.TaggedError<GhFailed>()("issue-sweep/GhFailed", {
  message: Schema.String,
  // `unreachable`: GitHub or the proxy did not answer (network, 429, 5xx), so
  // a read is retried; `refused`: it answered no (auth, not found). Optional
  // so failures journaled before the field decode as refused.
  code: Schema.optional(Schema.Literals(["unreachable", "refused"]))
}) {}
Fault.register("issue-sweep/GhFailed", { unreachable: "infra", refused: "dependency" })

/** A GitHub failure, classed by what git, gh or the proxy said: run-13's discovery died on one proxy 502. */
export const ghFailed = (message: string): GhFailed =>
  new GhFailed({ message, code: Unreachable.classifyExit(message) === undefined ? "refused" : "unreachable" })

const RoundPayload = { input: Input, round: Schema.Number }

export const ListIssues = Action.make("issue-sweep/list-issues", {
  payload: RoundPayload,
  success: Schema.Array(Issue),
  error: GhFailed,
  nondeterministic: true,
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize" }
})

export const Accounts = Action.make("issue-sweep/accounts", {
  payload: RoundPayload,
  success: Burndown.Capacity,
  error: HostFailed,
  nondeterministic: true,
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize" }
})

export const Dispatch = Burndown.dispatch("issue-sweep/dispatch")

/** The operator signal a sweep parked on exhausted accounts waits for. */
export const accountsReset = "issue-sweep/accounts-reset"

/**
 * Every failure a sweep can settle with. The run's result is journaled
 * through this schema; an undeclared `Schema.Unknown` error could not encode a
 * typed failure, so run-13's discovery failure surfaced as UnencodableResult.
 */
export const SweepFailure = Schema.Union([GhFailed, HostFailed, Burndown.Stop, PatternError.PatternError])

const Rounds = Burndown.make({
  name: "issue-sweep/rounds",
  error: SweepFailure,
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
    "proc:spawn:claude-as *",
    "model:call:typesafe-ai/jev"
  ],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "compensable" },
  modelInvocable: false,
  payload: Input,
  success: Burndown.Result,
  error: SweepFailure,
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

// Labels and whole title words that mark a bug, a test failure, or a regression.
const urgentLabel = /^(?:bug|regression|severity:.+)$/
const urgentTitle = /\b(?:fail(?:s|ed|ing|ures?)?|reds?|broken|crash(?:es|ed|ing)?|errors?)\b/i

/** Whether `issue` reports a bug, a test failure, or a regression, by its labels or its title. */
export const urgent = (issue: { readonly title: string; readonly labels: ReadonlyArray<string> }): boolean =>
  issue.labels.some((label) => urgentLabel.test(label)) || urgentTitle.test(issue.title)

const updated = (issue: { readonly updatedAt?: string | undefined }) => {
  const at = Date.parse(issue.updatedAt ?? "")
  return Number.isNaN(at) ? -Infinity : at
}

/**
 * The order the sweep works issues in, which is the order a round launches
 * them: {@link urgent} issues first, then the most recently updated, then
 * the lowest number.
 */
export const byPriority = (
  a: {
    readonly number: number
    readonly title: string
    readonly labels: ReadonlyArray<string>
    readonly updatedAt?: string | undefined
  },
  b: {
    readonly number: number
    readonly title: string
    readonly labels: ReadonlyArray<string>
    readonly updatedAt?: string | undefined
  }
): number => Number(urgent(b)) - Number(urgent(a)) || updated(b) - updated(a) || a.number - b.number

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
    (cause) => cause instanceof GhFailed ? cause : ghFailed(String((cause as { message?: unknown }).message ?? cause))
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

/** Discovery reaps against every open issue before narrowing a smoke run. */
export const makeIssueDiscovery = <E, R>(options: {
  readonly open: (repo: string) => Effect.Effect<
    ReadonlyArray<{
      readonly number: number
      readonly title: string
      readonly labels: ReadonlyArray<string>
      readonly updatedAt?: string | undefined
    }>,
    E,
    R
  >
  readonly reap: (open: ReadonlySet<number>) => Effect.Effect<unknown, E, R>
}) =>
(input: Pick<typeof Input.Type, "repo" | "issue">) =>
  github(options.open(input.repo)).pipe(
    Effect.tap((rows) => github(options.reap(new Set(rows.map((row) => row.number))))),
    Effect.map((rows) =>
      rows
        .filter((row) => input.issue === undefined || row.number === input.issue)
        .map((row) => ({ id: String(row.number), ...row }))
        .toSorted(byPriority)
    )
  )

const discoverIssues = makeIssueDiscovery({ open: openIssues, reap: reapWorkspaces })
const listIssues = ListIssues.toLayer(({ input }) => discoverIssues(input))

export const maxLocalAgents = 24
export const minFreeBytes = 25 * 1024 ** 3

type Placement = "local" | "vm" | "cloud"
const Placement = Schema.Literals(["local", "vm", "cloud"])

export const localLimit = (input: typeof Input.Type, freeBytes: number): number =>
  input.placement === "cloud"
    ? 0
    : input.placement === "vm"
    ? freeBytes < minFreeBytes
      ? 0
      : Math.min(maxLocalAgents, input.maxAgents ?? 4, (input.maxVms ?? 24) * (input.agentsPerVm ?? 1))
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
Fault.register("issue-sweep/RateLimited", "wait")

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
  | FlowRuntime.ExecutionIdentityConflict
  | TriageFailed
  | Burndown.Stop
/** What running the work child needs from the engine that executes the sweep. */
type Engine = FlowRuntime.FlowRuntime | Crypto.Crypto | Action.Requirement<"issue-sweep/ensure-disk">
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

/** Release the claim and record the outcome without claiming acceptance evidence. @since 0.1.0 */
export const releaseCommand = (issue: string, by: string, status: Burndown.Status, note: string): ReadonlyArray<string> =>
  ["release", issue, "--by", by, "--note", `${status}: ${note}`]


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

/** What selection reaches beyond the issue itself; tests replace each one. */
export interface SelectSeams<E, R> extends Seams<E, R> {
  readonly requalified: (repo: string, issue: number) => Effect.Effect<boolean, E, R>
  readonly newestClaim: (repo: string, issue: number) => Effect.Effect<string | undefined, E, R>
}

const excludedLabels: ReadonlySet<string> = new Set([
  "do-not-implement",
  "needs-human-approval",
  "wontfix",
  "epic",
  "invalid",
  "duplicate",
  "question"
])

/**
 * Whether an issue is ours. A parked issue, a `sweep:no-change` issue no human
 * acted on, and one the Mac mini holds are skipped without reading it; any
 * other is ours only when triage finds it needs a code change. A failed
 * reading fails selection (see `screen`).
 */
export const selectWith =
  <E, R>(seams: SelectSeams<E, R>) =>
  (args: Burndown.ItemArgs<unknown, Item>): Effect.Effect<Burndown.Selection, E | TriageFailed | Burndown.Stop, R> =>
    Effect.gen(function*() {
      const repo = repoOf(args)
      const excluded = args.item.labels.find((label) => excludedLabels.has(label))
      if (excluded !== undefined) return Burndown.skip(`label: ${excluded}`)
      const parked = parkedFor(args.item)
      if (parked !== undefined) return Burndown.skip(parked)
      if (args.item.labels.includes(noChangeLabel) && !(yield* seams.requalified(repo, args.item.number))) {
        return Burndown.skip("no change; waiting on a human")
      }
      if (args.item.labels.includes("in-progress")) {
        const now = yield* Clock.currentTimeMillis
        if (decide(yield* seams.newestClaim(repo, args.item.number), now) === "skip") {
          return Burndown.skip(`claimed on ${macMini}`)
        }
      }
      return yield* screen(repo, args.item, seams)
    })

// At most this many triage readings at once, whatever a round's width.
const readings = Semaphore.makeUnsafe(8)

/**
 * Triage readings on `judged`, the sweep's own judge. It is bound here, at
 * the call, because an action runs with the host's run context merged over
 * the services its layer was built with: a judge provided only to the
 * dispatch layer loses to the host's Evaluator, built from the host's
 * environment (run-11, 2026-10-01).
 */
export const judging = (judged: Evaluator.Evaluator) => (text: Text) =>
  Semaphore.withPermit(readings, classify(text).pipe(Effect.provideService(Evaluator.Evaluator, judged)))

const cache = fileCache(cachePath)

const liveSeams = (judged: Evaluator.Evaluator): SelectSeams<GhFailed, never> => ({
  cache,
  requalified: (repo, issue) => github(requalified(repo, issue)),
  newestClaim,
  read: (repo, issue) => github(readIssue(repo, issue)),
  classify: judging(judged),
  record: (repo, issue, triaged, need) =>
    Effect.flatMap(
      Clock.currentTimeMillis,
      (now) => github(recordVerdict(repo, issue, triaged.reason, new Date(now).toISOString(), need))
    )
})

/**
 * The triage judge: Jev through the AI Gateway when `AI_GATEWAY_API_KEY` is
 * set, and otherwise GPT-6 Luna on the operator's ChatGPT login, the
 * subscription the sweep's Codex agents already run on. With neither, each
 * round's preflight fails the sweep with that cause before any claim. Readings
 * bind this judge at the call ({@link judging}), so the host's own Evaluator
 * never replaces it. The host judge takes seconds to import, so it loads when
 * the sweep starts, not when its flow is planned.
 */
const judge = Layer.unwrap(
  Effect.promise(() => import("@smthrs/cli/NodeControl")).pipe(
    Effect.map((NodeControl) => {
      const environment = { ...process.env, SMITHERS_OPENAI_AUTH: process.env["SMITHERS_OPENAI_AUTH"] ?? "chatgpt" }
      return NodeControl.layerSeatEvaluator(environment).pipe(
        Layer.provide(NodeControl.layerRebuildableRequestExecutor(NodeControl.environmentDispatcher(environment)))
      )
    })
  )
)

/**
 * What a round spent agents on: `claimed` issues an agent worked to an end,
 * `changed` those whose agent produced a change (landed, or failed only at
 * landing), `noChange` those whose agent edited nothing, and `triaged` the
 * issues triage kept from an agent. A requeued issue counts in the round
 * that settles it.
 */
export const roundStats = (rows: ReadonlyArray<Burndown.Row>) => {
  const claimed = rows.filter((row) =>
    (row.status === "landed" || row.status === "failed") && !row.detail.startsWith("claim: ")
  )
  return {
    claimed: claimed.length,
    changed: claimed.filter((row) => row.status === "landed" || row.detail.startsWith("land: ")).length,
    noChange: claimed.filter((row) => row.detail.startsWith("work: ") && row.detail.includes(": no change: ")).length,
    triaged: rows.filter((row) => row.status === "skipped" && row.detail.startsWith("triage: ")).length
  }
}

/** Each round appends one JSON line of {@link roundStats} here, keyed by repository, attempt and round. */
export const roundsLog = `${workspaces}/rounds.jsonl`

const logRound = (input: typeof Input.Type, round: number, rows: ReadonlyArray<Burndown.Row>) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.promise(() =>
      appendFile(
        roundsLog,
        `${
          JSON.stringify({
            at: new Date(now).toISOString(),
            repo: input.repo,
            attempt: input.attempt ?? 1,
            round,
            ...roundStats(rows)
          })
        }\n`
      ).catch(() => undefined)
    ))

// One gate per `landers` value: at most that many landings check at once.
const landGates = new Map<number, Semaphore.Semaphore>()
const landGate = (landers: number) => {
  const gate = landGates.get(landers) ?? Semaphore.makeUnsafe(landers)
  landGates.set(landers, gate)
  return gate
}

// Only journaled final rows are candidates; a fresh claim check protects a
// workspace another run has since acquired. Failed/unknown checks keep it.
const settledReaper = makeSettledWorkspaceReaper({
  check: (repo, issue) =>
    Effect.map(
      run("node", [claimTool, "check", `${repo}#${issue}`, "--by", "issue-sweep-disk-reaper"]),
      (checked) => {
        if (checked.code !== 0) return false
        try {
          return JSON.parse(checked.stdout.trim()).free === true
        } catch {
          return false
        }
      }
    ),
  remove: removeWorkspace
})
export const rememberSettledWorkspaces = settledReaper.remember
configureDiskReaper(settledReaper.reap)

const dispatchOptions: Burndown.RoundOptions<unknown, Item, Worked, Failure, Engine, string> = {
  key: "issue-sweep",
  // The round's capacity slots bound how many work at once; this is only the
  // ceiling. A freed slot takes the next issue while the accounts still allow.
  concurrency: 32,
  capacity: (args) => readCapacity(args.input as typeof Input.Type),
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
        Work.execute({ repo: input.repo, issue: args.item.number, placement, ...vmOptions(input) }, {
          executionId
        })
      return yield* execute(id).pipe(
        Effect.catchIf(terminalIdentityConflict, () => execute(`${id}/round-${args.round}`)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? execute(`${id}/round-${args.round}`) : Effect.failCause(cause)
        ),
        Effect.catchTag(
          "issue-sweep/AdoptConflicted",
          (conflict) => requeue(conflict, { repo: input.repo, issue: args.item.number, executionId: id, repository })
        ),
        // A workspace this machine cannot prepare would fail every issue the
        // same way: stop the sweep (its claims are released) instead.
        Effect.catchTag("issue-sweep/WorkspaceFailed", (error) =>
          Effect.fail(new Burndown.Stop({ message: error.message }))),
        Effect.catchTag("issue-sweep/NoChange", (verdict) =>
          settleNoChange(input.repo, args.item.number, verdict))
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
        // Disk clearance is fresh for each allocation, never replayed from a
        // previous successful check while the host's free space has changed.
        const workspace = yield* checkoutIssue(
          item.number,
          output.change,
          DiskAdmission.execute({ reserveBytes: workspaceBytes }, { executionId: randomUUID() }).pipe(
            Effect.mapError((cause) => cause instanceof HostFailed ? cause : new HostFailed({ message: cause.message }))
          )
        ).pipe(
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
      // This flow has no named-check receipts; leave closure to the owner.
      const released = claimCommand(releaseCommand(ref(args), by, args.status, note))
      const exited = yield* released
      if (exited.code !== 0) {
        return yield* new AgentFailed({ message: `issue-claim release: exit ${exited.code}: ${tail(exited.stderr)}` })
      }
      yield* removeWorkspace(args.item.number)
    })
}

/**
 * One sweep round: the judge {@link preflight}, then the Burndown round,
 * selecting through `seams`. A judge this host can never use fails the round
 * before any claim.
 */
export const sweepRound = <W, E, R, L, SE, SR>(
  input: Burndown.RoundInput<unknown, Item>,
  options: Burndown.RoundOptions<unknown, Item, W, E | SE | TriageFailed | Burndown.Stop, R | SR, L>,
  seams: SelectSeams<SE, SR>
) => Effect.andThen(preflight(seams.classify), Burndown.round(input, { ...options, select: selectWith(seams) }))

const dispatch = Layer.unwrap(
  Effect.map(Effect.service(Evaluator.Evaluator), (judged) =>
    Dispatch.toLayer((payload) => {
      rememberSettledWorkspaces((payload.input as typeof Input.Type).repo, payload.rows ?? [])
      return sweepRound({
        input: payload.input,
        round: payload.round,
        items: payload.items as ReadonlyArray<Item>,
        settled: payload.settled,
        rows: payload.rows,
        slots: payload.slots
      }, {
        ...dispatchOptions,
        concurrency: Math.max(
          1,
          Math.min(
            Array.isArray(payload.items) ? payload.items.length : 1,
            ((payload.input as typeof Input.Type).maxAgents ?? 4) +
              ((payload.input as typeof Input.Type).cloudAgents ?? 0)
          )
        )
      }, liveSeams(judged)).pipe(
        Effect.tap((result) => logRound(payload.input as typeof Input.Type, payload.round, result.rows))
      )
    }))
).pipe(Layer.provide(judge))

// The rounds are a flow of their own that no file declares, so this module
// registers them; the host registers only discovered file flows.
export const layer = Layer.mergeAll(
  diskLayer,
  listIssues,
  accounts,
  dispatch,
  choosePlacement,
  Interpreter.layer(PlacementChoice),
  Sleep.layer,
  WaitFor.layer,
  Interpreter.layer(Rounds)
)
