/** Persistence contracts shared by the burndown round and its workers. */
import { Schema } from "effect"

export const Tool = Schema.Literals(["claude", "codex"])
export type Tool = typeof Tool.Type

export const IssueRef = Schema.Struct({
  repo: Schema.String,
  n: Schema.Number,
  title: Schema.String
})
export type IssueRef = typeof IssueRef.Type

/** One issue bundle on one account: the unit a worker runs. */
export const Assignment = Schema.Struct({
  key: Schema.String,
  repo: Schema.String,
  lead: IssueRef,
  extras: Schema.Array(IssueRef),
  account: Schema.String,
  tool: Tool,
  model: Schema.String,
  attempt: Schema.Number,
  placement: Schema.Literals(["local", "cloud"]),
  fix: Schema.optional(Schema.String)
})
export type Assignment = typeof Assignment.Type

export const WorkerStatus = Schema.Literals(["ready", "closed", "blocked", "limited", "failed"])

export const WorkerResult = Schema.Struct({
  key: Schema.String,
  status: WorkerStatus,
  commits: Schema.Array(Schema.Struct({ issue: Schema.Number, commit: Schema.String })),
  notes: Schema.String,
  agentHours: Schema.Number
})
export type WorkerResult = typeof WorkerResult.Type

export const InFlight = Schema.Struct({
  assignment: Assignment,
  executionId: Schema.String,
  startedAt: Schema.Number
})
export type InFlight = typeof InFlight.Type

/** A worker that reported READY commits and waits for the merge queue. */
export const Ready = Schema.Struct({ assignment: Assignment, result: WorkerResult }).check(
  Schema.makeFilter(({ assignment, result }) => {
    const members = [assignment.lead, ...assignment.extras]
    return result.status === "ready" && result.key === assignment.key &&
      result.commits.length === members.length && result.commits.every((commit, index) =>
        commit.issue === members[index]?.n && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit.commit)
      )
  }, { message: "READY requires matching assignment identity and complete commits in issue order" })
)
export type Ready = typeof Ready.Type

/** One account's reading: remaining slot ceiling plus the windows behind it. */
export const Capacity = Schema.Struct({
  account: Schema.String,
  tool: Tool,
  email: Schema.String,
  slots: Schema.Number,
  inFlight: Schema.Number,
  hardStop: Schema.Boolean,
  windows: Schema.Array(Schema.Struct({
    name: Schema.String,
    used: Schema.Number,
    resetsAt: Schema.NullOr(Schema.Number)
  })),
  problem: Schema.NullOr(Schema.String)
})
export type Capacity = typeof Capacity.Type

export const Candidate = Schema.Struct({
  repo: Schema.String,
  lead: IssueRef,
  extras: Schema.Array(IssueRef),
  severity: Schema.String,
  effort: Schema.String,
  fix: Schema.optional(Schema.String)
})
export type Candidate = typeof Candidate.Type

/** What a round reads before it decides anything. */
export const Observation = Schema.Struct({
  now: Schema.Number,
  target: Schema.Number,
  candidates: Schema.Array(Candidate),
  openIssues: Schema.Number,
  inFlight: Schema.Array(InFlight),
  finished: Schema.Array(WorkerResult),
  capacity: Schema.Array(Capacity),
  exhausted: Schema.Boolean,
  earliestReset: Schema.NullOr(Schema.Number),
  pending: Schema.Boolean,
  readings: Schema.Json,
  rates: Schema.Json
})
export type Observation = typeof Observation.Type

/** The pacer's answer: which candidates start now, on which account. */
export const PacePlan = Schema.Struct({
  launches: Schema.Array(Schema.Struct({ repo: Schema.String, n: Schema.Number, account: Schema.String })),
  nextTarget: Schema.Number,
  note: Schema.String
})
export type PacePlan = typeof PacePlan.Type

export const LandReport = Schema.Struct({
  landed: Schema.Array(Schema.String),
  quarantined: Schema.Array(Schema.Struct({ key: Schema.String, error: Schema.String }))
})
export type LandReport = typeof LandReport.Type

export const Options = Schema.Struct({
  repos: Schema.Array(Schema.String),
  placement: Schema.Literals(["local", "cloud"]),
  maxAgents: Schema.Number,
  tickMinutes: Schema.Number
})
export type Options = typeof Options.Type

/** A failed queue member retains everything needed to repair it after restart. */
export const Quarantined = Schema.Struct({
  key: Schema.String,
  error: Schema.String,
  assignment: Assignment,
  result: WorkerResult
})
export type Quarantined = typeof Quarantined.Type

/** A round's payload: everything the next round needs, carried as data. */
export const RoundState = Schema.Struct({
  options: Options,
  round: Schema.Number,
  target: Schema.Number,
  inFlight: Schema.Array(InFlight),
  quarantined: Schema.Array(Quarantined),
  ready: Schema.Array(Ready),
  readings: Schema.Json,
  rates: Schema.Json,
  history: Schema.Json,
  landed: Schema.Number
})
export type RoundState = typeof RoundState.Type

export const Settlement = Schema.Struct({
  done: Schema.Boolean,
  wakeAt: Schema.Number,
  next: RoundState,
  summary: Schema.String
})
export type Settlement = typeof Settlement.Type
