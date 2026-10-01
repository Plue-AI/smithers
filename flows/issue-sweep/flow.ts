/**
 * `issue-sweep`: works every open GitHub issue that no other machine holds,
 * as a `Burndown` from `@smthrs/patterns`. Each round asks the Codex and
 * Claude account pools for capacity, lists the open issues, claims the ones
 * that are ours, fixes each in its own jj workspace (`issue-sweep/work`), lands
 * each result on `main` as its fix finishes, one at a time, and releases every
 * claim. A finished fix frees its slot for the next issue. With every
 * account out, the sweep parks until an operator resets accounts and signals
 * `issue-sweep/accounts-reset`.
 */
import { Action, Flow, type FlowRuntime, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import { Burndown } from "@smthrs/patterns"
import { Cause, Clock, Effect, Layer, Schedule, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { fileURLToPath } from "node:url"
import { capacity, perAccount, readPools } from "./accounts.ts"
import { api, openIssues } from "./github.ts"
import { HostFailed, repository, run, tail } from "./host.ts"
import { landChange, LandFailed } from "./land.ts"
import { infraCaused, noChangeLabel, recordVerdict, requalified } from "./verdict.ts"
import Work, { AgentFailed, NoChange, removeWorkspace, type Report, requeue } from "./work/flow.ts"

const Input = Schema.Struct({
  repo: Schema.String,
  // Never more than 32 agents on this machine; Smithers Cloud takes more.
  maxAgents: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32))),
  // Each issue's work child is keyed by this attempt, so a restarted sweep
  // reattaches to its children; a new attempt works failed issues afresh.
  attempt: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  // Where agents run: on this Mac in their own sandbox (default), or in local microVMs.
  placement: Schema.optional(Schema.Literals(["local", "vm"]))
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
    "proc:spawn:claude-rr *"
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
 * decide `blocked-on-will` issues, and a "Deferred" issue is parked past the
 * release by title; agents dispatched to them could only report no change.
 */
export const parkedFor = (issue: { readonly title: string; readonly labels: ReadonlyArray<string> }) =>
  issue.labels.includes("blocked-on-will")
    ? "blocked on the maintainer"
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

const listIssues = ListIssues.toLayer(({ input }) =>
  github(openIssues(input.repo)).pipe(
    Effect.map((rows) => rows.map((row) => ({ id: String(row.number), ...row })))
  )
)

// RR_MAX_PER_ACCOUNT agents per ready account, never more than maxAgents.
const readCapacity = (input: typeof Input.Type) =>
  Effect.map(readPools, (pools) =>
    capacity(
      // A microVM runs Codex only: the Claude login lives in the macOS keychain, which a guest cannot borrow.
      input.placement === "vm" ? { codex: pools.codex, claude: { ready: [], unavailable: [] } } : pools,
      perAccount,
      input.maxAgents ?? 4
    ))

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

const dispatch = Burndown.layer<"issue-sweep/dispatch", Item, Worked, Failure, Engine, string>(Dispatch, {
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
  work: (args) => {
    const input = args.input as typeof Input.Type
    const id = `${args.executionId}/attempt-${input.attempt ?? 1}`
    const execute = (executionId: string) =>
      Work.execute({ repo: input.repo, issue: args.item.number, placement: input.placement ?? "local" }, {
        executionId
      })
    return execute(id).pipe(
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
  },
  // An issue someone closed while its agent worked is already settled; landing
  // a second fix for it would only duplicate the first.
  land: ({ input, item, output }) =>
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
      return yield* landChange(output.workspace, output.change)
    }),
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
})

// The rounds are a flow of their own that no file declares, so this module
// registers them; the host registers only discovered file flows.
export const layer = Layer.mergeAll(
  listIssues,
  accounts,
  dispatch,
  Sleep.layer,
  WaitFor.layer,
  Interpreter.layer(Rounds)
)
