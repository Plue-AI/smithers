/**
 * The Go-backed durability cases (T-REL-04) and the tier each one runs in.
 *
 * `release` is `//packages/smithers:faults`, the release gate's "Exclusive
 * fault matrix". A case stays there only when it finishes in a few minutes, so
 * the gate keeps a budget a release can wait for. `long` is
 * `//packages/smithers:faultsLong`, which scheduled reliability runs nightly
 * with its own budget: cases measured in tens of minutes or budgeted in hours.
 * Every case is in exactly one tier; `test/FaultTiers.test.ts` checks that the
 * two targets, their configs and this table agree, so moving a case can never
 * drop it from both.
 *
 * Each budget is the case's measured duration with headroom: `go` bounds the
 * `go test` binary, `spawnMs` the harness's wait for it, and `testMs` the
 * Vitest case, each a little above the one inside it so the innermost timeout
 * reports first and its partial output survives.
 */
import { githubCrossings, githubPoints } from "./githubFaultMatrix.ts"
import { machineTodoPoints } from "./todoFaultMatrix.ts"

export type FaultTier = "release" | "long"

export interface GoFaultBudget {
  readonly go: string
  readonly spawnMs: number
  readonly testMs: number
}

export interface GoFaultCase {
  readonly check: "C-DUR-01" | "C-DUR-02" | "C-DUR-03" | "C-DUR-04"
  /** The case file, relative to packages/backend. */
  readonly file: string
  /** One named test, or `null` for every acceptance test in `file`. */
  readonly name: string | null
  /** The kill points the passing leaves must reach between them. */
  readonly points: readonly string[]
  readonly tier: FaultTier
  /** `reference` cases run only on the approved reference host. */
  readonly host: "any" | "reference"
  readonly budget: GoFaultBudget
}

// A route case drives one production door: about a minute with its compile.
const route: GoFaultBudget = { go: "2m", spawnMs: 150_000, testMs: 180_000 }
// Preserve the original per-case suite allowance as the GitHub matrix grows
// from 16. Production recovery still has its independent 60-second deadline.
export const githubRunMinutes = Math.ceil(44 * githubCrossings.length / 16)
const rebase: GoFaultBudget = { go: "4h", spawnMs: 14_500_000, testMs: 14_550_000 }
const referenceMachine: GoFaultBudget = { go: "44m", spawnMs: 2_700_000, testMs: 2_730_000 }

export const goFaultCases: ReadonlyArray<GoFaultCase> = [
  {
    check: "C-DUR-01",
    file: "internal/compose/todo_pause_delivery_fault_test.go",
    name: "TestTodoStopResumeDeliveryCrashComposed",
    points: ["stop-pre-delivery", "stop-delivery", "resume-pre-delivery", "resume-delivery"],
    tier: "release",
    host: "any",
    budget: route
  },
  {
    check: "C-DUR-01",
    file: "internal/compose/todo_pause_fault_test.go",
    name: "TestTodoStartCrashThroughRoute",
    points: ["start"],
    tier: "release",
    host: "any",
    budget: route
  },
  {
    // About 12 minutes: the packaged TODO plans before each pause boundary.
    check: "C-DUR-01",
    file: "internal/compose/todo_live_pause_fault_test.go",
    name: "TestTodoStartPauseResumeCrashThroughRoutes",
    points: ["stop", "resume"],
    tier: "long",
    host: "any",
    budget: { go: "12m", spawnMs: 750_000, testMs: 780_000 }
  },
  {
    check: "C-DUR-01",
    file: "internal/compose/postgres_kill_fault_test.go",
    name: "TestTodoPostgresCrashThroughRoute",
    points: ["postgres-transition"],
    tier: "release",
    host: "any",
    budget: route
  },
  {
    check: "C-DUR-03",
    file: "internal/compose/todo_merge_fault_test.go",
    name: "TestTodoMergeCrashThroughRoute",
    points: ["merge-pre-land", "merge-post-land", "merge-post-call"],
    tier: "release",
    host: "any",
    budget: route
  },
  {
    // 39 crossings, each a fresh install: budgeted at 108 minutes.
    check: "C-DUR-03",
    file: "internal/compose/github_outbound_kill_test.go",
    name: null,
    points: [...githubPoints, "github-production-propose"],
    tier: "long",
    host: "any",
    budget: {
      go: `${githubRunMinutes}m`,
      spawnMs: (githubRunMinutes + 1) * 60_000,
      testMs: (githubRunMinutes + 1.5) * 60_000
    }
  },
  {
    // Slow by design, not hung. On nyc-02 (2026-10-10) K4b held a real
    // 30-second outage in each of its 10 runs (329.7 s), and the three K7
    // drivers ran 70 real document installs (about 7 minutes).
    check: "C-DUR-04",
    file: "internal/machined/fault_test.go",
    name: null,
    points: ["K4", "K4b", "K7a", "K7b", "K7c", "K7d", "K7e"],
    tier: "long",
    host: "any",
    budget: { go: "30m", spawnMs: 1_830_000, testMs: 1_860_000 }
  },
  {
    // The reference-bundle case: it refuses off the approved reference host.
    check: "C-DUR-04",
    file: "internal/compose/rebase_fault_test.go",
    name: "TestRebaseFaultRootInputsValidatedBeforeUse",
    points: [],
    tier: "release",
    host: "any",
    budget: rebase
  },
  {
    // Sixty crossings, ten per point with and without people: 4 hours.
    check: "C-DUR-04",
    file: "internal/compose/rebase_fault_test.go",
    name: "TestRebaseCrashThroughDispatcher",
    points: ["rebase-post-capture", "rebase-mid", "rebase-post-apply"],
    tier: "long",
    host: "any",
    budget: rebase
  },
  {
    check: "C-DUR-04",
    file: "internal/compose/rebase_fault_test.go",
    name: "TestRebaseVMCrashThroughDispatcher",
    points: ["rebase-post-capture", "rebase-mid", "rebase-post-apply"],
    tier: "long",
    host: "reference",
    budget: rebase
  },
  {
    // The retained-disk transport control alone cannot qualify C-DUR-02.
    // Keep requiring the composed TODO kill marker until that case lands.
    check: "C-DUR-02",
    file: "flowhost/machine_kill_fault_test.go",
    name: null,
    points: ["machine-mid-command"],
    tier: "long",
    host: "reference",
    budget: referenceMachine
  },
  {
    check: "C-DUR-02",
    file: "internal/compose/todo_machine_kill_fault_test.go",
    name: "TestTodoMachineKillThroughInstall",
    points: [...machineTodoPoints],
    tier: "long",
    host: "reference",
    budget: referenceMachine
  }
]

/** The cases one tier runs on one host class. */
export const goFaultCasesFor = (tier: FaultTier, host: string | undefined): ReadonlyArray<GoFaultCase> =>
  goFaultCases.filter((entry) => entry.tier === tier && (entry.host === "any" || host === "reference"))

/**
 * The TypeScript cases that drive production Go boundaries. FaultSuite runs
 * them by file, so the tier is the directory: `test/faults/long/` is the long
 * tier. Absence fails rather than reducing the matrix silently.
 */
export const requiredFaultSiblings: Readonly<Record<string, FaultTier>> = {
  "long/case40-host-kill-todo-run.test.ts": "long",
  "engine/case39-kill-crossing.test.ts": "release"
}
