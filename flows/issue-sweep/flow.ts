/**
 * `issue-sweep`: works every open GitHub issue that no other machine holds,
 * as a `Burndown` from `@smthrs/patterns`. Each round asks the Codex and
 * Claude account pools for capacity, lists the open issues, claims the ones
 * that are ours, fixes each in its own jj workspace (`issue-sweep/work`), lands
 * the results on `main` one at a time, and releases every claim. With every
 * account out, the sweep parks until an operator resets accounts and signals
 * `issue-sweep/accounts-reset`.
 */
import { Action, Flow, type FlowRuntime, Sleep, WaitFor } from "@smthrs/flow"
import { Burndown } from "@smthrs/patterns"
import { Clock, Effect, Layer, Schedule, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { capacity, perAccount, readPools } from "./accounts.ts"
import { HostFailed, output, repository, run, tail } from "./host.ts"
import { landChange, LandFailed } from "./land.ts"
import Work, { AgentFailed, layer as workLayer, removeWorkspace, type Report } from "./work/flow.ts"

const Input = Schema.Struct({
  repo: Schema.String,
  // Never more than 32 agents on this machine; Smithers Cloud takes more.
  maxAgents: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32)))
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

export default Flow.make("issue-sweep", {
  description: "Work every open GitHub issue that no other machine holds.",
  capabilities: [
    "proc:spawn:gh *",
    "proc:spawn:node *",
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

/** Skip an issue only while the Mac mini holds an unexpired claim on it. */
export const decide = (claim: string | undefined, nowMillis: number): "skip" | "ours" => {
  const match = claim === undefined ? null : claimLine.exec(claim)
  if (match === null) return "ours"
  const [, , host, , expires] = match
  return host === macMini && Date.parse(expires ?? "") > nowMillis ? "skip" : "ours"
}

const gh = (args: ReadonlyArray<string>) =>
  Effect.mapError(output("gh", args), (cause) => new GhFailed({ message: cause.message }))

// What `gh issue list --json number,title,labels` prints.
const GhIssues = Schema.fromJsonString(Schema.Array(Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String }))
})))

const listIssues = ListIssues.toLayer(({ input }) =>
  gh(["issue", "list", "--repo", input.repo, "--state", "open", "--limit", "1000", "--json", "number,title,labels"])
    .pipe(
      Effect.flatMap(Schema.decodeEffect(GhIssues)),
      Effect.mapError((cause) => cause instanceof GhFailed ? cause : new GhFailed({ message: String(cause) })),
      Effect.map((rows) =>
        rows.map((row) => ({
          id: String(row.number),
          number: row.number,
          title: row.title,
          labels: row.labels.map((label) => label.name)
        }))
      )
    )
)

// RR_MAX_PER_ACCOUNT agents per ready account, never more than maxAgents.
const accounts = Accounts.toLayer(({ input }) =>
  Effect.map(readPools, (pools) => capacity(pools, perAccount, input.maxAgents ?? 4))
)

/** The first line of the newest claim comment on `issue`, if any. */
const newestClaim = (repo: string, issue: number) =>
  gh([
    "api",
    "--paginate",
    `repos/${repo}/issues/${issue}/comments?per_page=100`,
    "--jq",
    ".[].body | select(startswith(\"Claimed by\")) | split(\"\\n\")[0]"
  ]).pipe(Effect.map((stdout) => stdout.split("\n").filter((line) => line !== "").at(-1)))

// scripts/issue-claim.mjs: exit 0 done, 2 held by someone else, 75 rate limited.
const claimTool = `${repository}/scripts/issue-claim.mjs`
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
  | HostFailed
  | LandFailed
  | Schema.SchemaError
  | FlowRuntime.FlowCycleDetected
/** What running the work child needs from the engine that executes the sweep. */
type Engine = FlowRuntime.FlowRuntime | Crypto.Crypto
const repoOf = (args: { readonly input: unknown }) => (args.input as typeof Input.Type).repo
const ref = (args: Args) => `${repoOf(args)}#${args.item.number}`

const dispatch = Burndown.layer<"issue-sweep/dispatch", Item, Worked, Failure, Engine, string>(Dispatch, {
  key: "issue-sweep",
  // The round's capacity slots bound how many launch; this is only the ceiling.
  concurrency: 32,
  select: (args) =>
    Effect.gen(function*() {
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
  // The work flow's plan does not name its requirements, so the engine's are stated here.
  work: (args) =>
    Burndown.child(
      Work,
      (item: Args) => ({ repo: repoOf(item), issue: item.item.number, placement: "local" as const })
    )(args)
      .pipe(Effect.provide(workLayer)) as Effect.Effect<Worked, Failure, Engine>,
  land: ({ output }) =>
    output.change === ""
      ? Effect.fail(new LandFailed({ message: `${output.workspace}: only local changes land` }))
      : landChange(output.workspace, output.change),
  detail: (report, landed) =>
    `${landed === undefined ? report.change : landed.slice(0, 12)} by ${report.agent} ${report.account}`,
  release: (args) =>
    Effect.gen(function*() {
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

export const layer = Layer.mergeAll(listIssues, accounts, dispatch, Sleep.layer, WaitFor.layer)
