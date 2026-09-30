/**
 * Replays the re-run driver over a stub pipeline: no docker, no tokens.
 *
 * `run-45.sh` is the measurement `analysis/PROGRAM.md`'s eleven predictions are
 * settled against, so the parts that decide whether that measurement is honest
 * are checked here rather than discovered halfway through a run that costs real
 * money:
 *
 * - **the population is derived from the baseline ledger**, in the seeded draw
 *   order, with no flag that could add or drop one — a re-run cannot quietly
 *   become a re-run of an easier set;
 * - **the lane names one whole measurement** — ledger, archive, artifact index
 *   and evaluator run id — so a second wave over the same 45 instances is a
 *   second ledger and never an append to the first;
 * - **the resume boundary is the ledger**, so a driver restarted after a kill
 *   re-runs what did not finish and nothing else;
 * - **concurrency is bounded**, because three testbeds and three images share
 *   one 8 GiB disk gate;
 * - **`--limit` and `--stop` really stop it**, which is what makes an operator
 *   able to spend one evening's worth and read the ledger before committing the
 *   rest;
 * - **the budget gate reads this re-run's own ledger** and pauses rather than
 *   spending past it;
 * - and the header row records the knobs the run was made with, so a later
 *   reader can tell whether two ledgers are comparable at all.
 *
 * The per-instance pipeline itself — pull, extract, run, grade, delete — is
 * `lib/fullbench-instance.sh`, already proved by `./fullbench-dryrun.sh` against
 * real docker. Here it is replaced through `SWB_RERUN_INSTANCE_CMD`.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { read } from "../lib/fullbench-manifest.mjs"
import { population } from "../lib/rerun-queue.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-run45-"))

const IDS = ["a__a-1", "b__b-2", "c__c-3", "d__d-4", "e__e-5"]

const write = (path, text) => {
  writeFileSync(path, text)
  return path
}

const jsonl = (path, rows) => write(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)

const instance = (id, state, extra = {}) => ({ kind: "instance", id, state, at: 1, ...extra })

const gradedRows = (id, verdict = "resolved", usd = 0.1) => [
  instance(id, "pulled"),
  instance(id, "ran", { wallSeconds: 10, cost: { usd, frames: 2, spanMillis: 9000 } }),
  instance(id, "graded", { verdict }),
  instance(id, "cleaned")
]

try {
  const dataset = write(
    join(temporary, "dataset.json"),
    JSON.stringify(IDS.map((id) => ({ instance_id: id, repo: id.split("__")[0] })))
  )
  const baseline = jsonl(join(temporary, "baseline.jsonl"), [
    { kind: "header", at: 0, runId: "fullbench" },
    ...IDS.flatMap((id) => gradedRows(id)),
    // An instance the baseline started and never graded is not part of the
    // population: the re-run compares against verdicts, and there is none.
    instance("f__f-6", "pulled"),
    instance("f__f-6", "failed", { reason: "killed" })
  ])

  // -----------------------------------------------------------------------
  // The population is the baseline's graded set, in draw order, and nothing else.
  // -----------------------------------------------------------------------
  const rows = JSON.parse(readFileSync(dataset, "utf8"))
  const ordered = population(rows, baseline)
  assert.equal(ordered.length, 5)
  assert.ok(!ordered.includes("f__f-6"), "an ungraded baseline instance entered the population")
  assert.deepEqual([...ordered].sort(), [...IDS].sort())

  // A baseline that graded nothing has no population, and says so rather than
  // silently re-running zero instances.
  const emptyBaseline = jsonl(join(temporary, "empty.jsonl"), [{ kind: "header", at: 0 }])
  assert.throws(() => population(rows, emptyBaseline), /graded no instances/)

  // A baseline naming an instance the dataset does not hold is two different
  // benchmarks, not one comparison.
  const foreign = jsonl(join(temporary, "foreign.jsonl"), gradedRows("z__z-9"))
  assert.throws(() => population(rows, foreign), /does not contain 1 baseline instance/)

  // -----------------------------------------------------------------------
  // The stub pipeline. It records its own overlap so the test can measure the
  // concurrency the driver actually achieved, rather than the one it configured.
  // -----------------------------------------------------------------------
  const trace = join(temporary, "trace.log")
  const append = join(root, "lib", "manifest-append.mjs")
  const rowTool = join(root, "lib", "fullbench-row.mjs")
  const stub = write(
    join(temporary, "stub-instance.sh"),
    [
      "#!/bin/bash",
      "set -eu",
      "ID=\"$1\"",
      `printf 'start %s\\n' "$ID" >> ${JSON.stringify(trace)}`,
      "if [ \"${SWB_STUB_FAIL:-0}\" = 1 ]; then exit 1; fi",
      "sleep 0.4",
      `printf 'end %s\\n' "$ID" >> ${JSON.stringify(trace)}`,
      "USD=\"${SWB_STUB_USD:-0.05}\"",
      // Every append is checked by `set -e`: a stub whose rows silently failed
      // to land would make the budget gate look like it was never reached.
      `RAN="$(node ${JSON.stringify(rowTool)} --kind instance --id "$ID" --state ran --at 1 \\`,
      `  --wallSeconds 5 --cost-json "{\\"usd\\":$USD,\\"frames\\":1,\\"spanMillis\\":4000}")"`,
      `node ${JSON.stringify(append)} "$FB_DIR/manifest.jsonl" "$RAN"`,
      `GRADED="$(node ${JSON.stringify(rowTool)} --kind instance --id "$ID" --state graded --at 2 \\`,
      "  --verdict resolved)\"",
      `node ${JSON.stringify(append)} "$FB_DIR/manifest.jsonl" "$GRADED"`,
      // How the test asks for a stop from inside a live run, which is the only
      // way `--stop` is ever used: an operator types it while instances are in
      // flight.
      "if [ -n \"${SWB_STUB_STOP_AFTER:-}\" ]; then",
      `  DONE="$(grep -c '^start ' ${JSON.stringify(trace)} || printf 0)"`,
      "  if [ \"$DONE\" -ge \"$SWB_STUB_STOP_AFTER\" ]; then printf 'stop\\n' > \"$FB_DIR/STOP\"; fi",
      "fi",
      ""
    ].join("\n")
  )
  chmodSync(stub, 0o755)

  const drive = (fb, extra = [], env = {}) => {
    mkdirSync(fb, { recursive: true })
    return spawnSync(join(root, "run-45.sh"), ["--foreground", ...extra], {
      encoding: "utf8",
      env: {
        ...process.env,
        FB_DIR: fb,
        SWB_DATASET: dataset,
        SWB_RERUN_BASELINE: baseline,
        SWB_RERUN_INSTANCE_CMD: stub,
        SWB_RERUN_POLL_SECONDS: "1",
        ...env
      }
    })
  }

  // -----------------------------------------------------------------------
  // --list and --status read the derived population.
  // -----------------------------------------------------------------------
  const listFb = join(temporary, "fb-list")
  const list = drive(listFb, ["--list"])
  assert.equal(list.status, 0, list.stderr)
  assert.deepEqual(list.stdout.trim().split("\n").sort(), [...IDS].sort())
  const status = drive(listFb, ["--status"])
  assert.match(status.stdout, /0 of 5 instances re-run, 5 left/)

  // -----------------------------------------------------------------------
  // A whole re-run, three in flight.
  // -----------------------------------------------------------------------
  const fb = join(temporary, "fb-run")
  const run = drive(fb, [], { SWB_RERUN_JOBS: "3" })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  const ledger = read(join(fb, "manifest.jsonl"))
  assert.equal(ledger.states.size, 5)
  for (const id of IDS) {
    assert.equal(ledger.states.get(id).verdict, "resolved")
    // The cost column too, or a budget gate reading this ledger would read zero
    // and a later assertion about it would pass for the wrong reason.
    assert.equal(ledger.states.get(id).cost.usd, 0.05, `${id} recorded no cost`)
  }

  // The header records the knobs. Two ledgers whose headers disagree are not
  // two measurements of one thing.
  const header = ledger.header
  assert.equal(header.runId, "rerun-r91")
  assert.equal(header.index, "r91")
  assert.equal(header.lane, "r91")
  assert.equal(header.jobs, 3)
  assert.equal(header.instanceBudgetSeconds, 1200)
  assert.equal(header.baseline, baseline)

  // Every instance ran exactly once.
  const starts = readFileSync(trace, "utf8").trim().split("\n").filter((line) => line.startsWith("start "))
  assert.equal(starts.length, 5, `the stub ran ${starts.length} times, not 5`)

  // Concurrency was bounded by, and reached, the configured limit.
  let live = 0
  let peak = 0
  for (const line of readFileSync(trace, "utf8").trim().split("\n")) {
    if (line.startsWith("start ")) live += 1
    else live -= 1
    peak = Math.max(peak, live)
  }
  assert.ok(peak <= 3, `${peak} instances were in flight at once, over the limit of 3`)
  assert.ok(peak > 1, "the driver never ran two instances at once, so the limit is not doing anything")

  // -----------------------------------------------------------------------
  // Resume: a second pass over a finished ledger schedules nothing.
  // -----------------------------------------------------------------------
  writeFileSync(trace, "")
  const again = drive(fb, [], { SWB_RERUN_JOBS: "3" })
  assert.equal(again.status, 0, again.stderr)
  assert.equal(readFileSync(trace, "utf8").trim(), "", "a finished re-run scheduled work on resume")

  // -----------------------------------------------------------------------
  // --limit bounds one session, and the rest stay queued.
  // -----------------------------------------------------------------------
  writeFileSync(trace, "")
  const limited = join(temporary, "fb-limit")
  const limit = drive(limited, ["--limit", "2"], { SWB_RERUN_JOBS: "1" })
  assert.equal(limit.status, 0, limit.stderr)
  assert.equal(read(join(limited, "manifest.jsonl")).states.size, 2)
  const remaining = drive(limited, ["--status"])
  assert.match(remaining.stdout, /2 of 5 instances re-run, 3 left/)

  // One failed attempt must stop a one-slot wave before the next instance.
  writeFileSync(trace, "")
  const failed = join(temporary, "fb-failed")
  const failure = drive(failed, [], { SWB_RERUN_JOBS: "1", SWB_STUB_FAIL: "1" })
  assert.equal(failure.status, 0, failure.stderr)
  assert.equal(readFileSync(trace, "utf8").trim().split("\n").length, 1)
  assert.match(failure.stdout, /PAUSED: .* did not reach a valid graded attempt/u)

  // -----------------------------------------------------------------------
  // The budget gate pauses instead of spending past it.
  // -----------------------------------------------------------------------
  const retried = join(temporary, "fb-retry-budget")
  mkdirSync(retried)
  jsonl(join(retried, "manifest.jsonl"), [
    instance(ordered[0], "ran", { cost: { usd: 40 } }),
    instance(ordered[0], "pulled"),
    instance(ordered[0], "ran", { cost: { usd: 25 } })
  ])
  writeFileSync(trace, "")
  const retryBudget = drive(retried, [], { SWB_RERUN_JOBS: "1", SWB_RERUN_BUDGET_USD: "60" })
  assert.equal(retryBudget.status, 0, retryBudget.stderr)
  assert.equal(readFileSync(trace, "utf8"), "", "the $60 gate must count both the $40 and $25 attempts")
  assert.ok(read(join(retried, "manifest.jsonl")).notes.some((note) => note.note === "paused"))

  for (const seat of ["openai:gpt-5.6-sol", "openai:unpriced-fixture"]) {
    const unknown = join(temporary, `fb-unknown-${seat.split(":")[1]}`)
    mkdirSync(unknown)
    // The priced seat exercises missing accounting; the unpriced seat must be
    // refused on an empty ledger, before the first worker starts.
    if (seat === "openai:gpt-5.6-sol") {
      jsonl(join(unknown, "manifest.jsonl"), [instance(ordered[0], "ran", { cost: {} })])
    }
    writeFileSync(trace, "")
    const refused = drive(unknown, [], { SWB_SEAT: seat, SWB_RERUN_JOBS: "1" })
    assert.equal(refused.status, 0, refused.stderr)
    assert.equal(readFileSync(trace, "utf8"), "", "unknown cost or price must prevent scheduling")
    assert.match(refused.stdout, /PAUSED: the ledger's cumulative cost could not be read/)
  }

  const broke = join(temporary, "fb-budget")
  const budget = drive(broke, [], { SWB_RERUN_JOBS: "1", SWB_RERUN_BUDGET_USD: "0.06", SWB_STUB_USD: "0.05" })
  assert.equal(budget.status, 0, budget.stderr)
  const brokeLedger = read(join(broke, "manifest.jsonl"))
  // Two launches: the first at $0, the second at $0.05. The third waits for the
  // second's slot, then reads $0.10 and pauses.
  assert.equal(brokeLedger.states.size, 2, "the budget gate let an instance start past the budget")
  assert.ok(
    brokeLedger.notes.some((note) => note.note === "paused" && /budget/.test(note.reason)),
    "the ledger does not record why the driver stopped"
  )

  // A worker that crosses the budget while the next launch waits for its slot:
  // the next launch reads the ledger after the wait and never starts. The $1
  // control, with the same per-instance cost, runs the whole population.
  for (const [lane, budgetUsd, expected] of [["fb-cross", "0.01", 1], ["fb-cross-control", "1", 5]]) {
    writeFileSync(trace, "")
    const crossed = join(temporary, lane)
    const result = drive(crossed, [], { SWB_RERUN_JOBS: "1", SWB_RERUN_BUDGET_USD: budgetUsd, SWB_STUB_USD: "0.02" })
    assert.equal(result.status, 0, result.stderr)
    const started = readFileSync(trace, "utf8").trim().split("\n").filter((line) => line.startsWith("start "))
    assert.equal(
      started.length,
      expected,
      `a $${budgetUsd} budget started ${started.length} instances\n${result.stdout}`
    )
    assert.equal(/PAUSED: cumulative API cost reached/.test(result.stdout), expected < 5)
  }

  // -----------------------------------------------------------------------
  // --stop halts a live driver after its in-flight instances finish, and the
  // start that follows clears the marker so the run is resumable, not wedged.
  // -----------------------------------------------------------------------
  const stopped = join(temporary, "fb-stop")
  mkdirSync(stopped, { recursive: true })
  const stop = drive(stopped, ["--stop"])
  assert.equal(stop.status, 0, stop.stderr)
  assert.match(stop.stdout, /stop after its in-flight instances finish/)

  writeFileSync(trace, "")
  const halted = drive(stopped, [], { SWB_RERUN_JOBS: "1", SWB_STUB_STOP_AFTER: "2" })
  assert.equal(halted.status, 0, halted.stderr)
  assert.match(halted.stdout, /stop requested/)
  const halfway = read(join(stopped, "manifest.jsonl")).states.size
  assert.ok(halfway >= 2 && halfway < 5, `a stop after 2 instances left ${halfway} graded`)

  writeFileSync(trace, "")
  const resumed = drive(stopped, [], { SWB_RERUN_JOBS: "1" })
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.equal(read(join(stopped, "manifest.jsonl")).states.size, 5, "a stopped run did not resume")

  // -----------------------------------------------------------------------
  // The detached launch. A re-run of 45 instances outlives the session that
  // started it, so the double fork is the normal path and the foreground one is
  // the exception — and the child must not mistake the pid its own launcher
  // wrote into `driver.pid` for another driver already running.
  // -----------------------------------------------------------------------
  const detached = join(temporary, "fb-detached")
  mkdirSync(detached, { recursive: true })
  const launch = spawnSync(join(root, "run-45.sh"), ["--limit", "2"], {
    encoding: "utf8",
    env: {
      ...process.env,
      FB_DIR: detached,
      SWB_DATASET: dataset,
      SWB_RERUN_BASELINE: baseline,
      SWB_RERUN_INSTANCE_CMD: stub,
      SWB_RERUN_JOBS: "2",
      SWB_RERUN_POLL_SECONDS: "1"
    }
  })
  assert.equal(launch.status, 0, launch.stderr)
  assert.match(launch.stdout, /driver detached as pid \d+/)
  const deadline = Date.now() + 30_000
  let detachedLedger = read(join(detached, "manifest.jsonl"))
  while (detachedLedger.states.size < 2 && Date.now() < deadline) {
    spawnSync("sleep", ["0.5"])
    detachedLedger = read(join(detached, "manifest.jsonl"))
  }
  assert.equal(detachedLedger.states.size, 2, "the detached driver did not run its two instances")
  const driverLog = readFileSync(join(detached, "driver.log"), "utf8")
  assert.ok(
    !/already running as pid/.test(driverLog),
    `the detached child refused to start: ${driverLog}`
  )

  // -----------------------------------------------------------------------
  // The lane. It decides which ledger a wave writes, which index its artifacts
  // carry and which evaluator run id grades them; all three move together, and
  // a lane that moved only some of them would grade one wave's patches into
  // another wave's run id.
  // -----------------------------------------------------------------------
  writeFileSync(trace, "")
  const laned = join(temporary, "fb-lane")
  const lane = drive(laned, ["--lane", "r92", "--limit", "1"], { SWB_RERUN_JOBS: "1" })
  assert.equal(lane.status, 0, `${lane.stdout}\n${lane.stderr}`)
  const laneHeader = read(join(laned, "manifest.jsonl")).header
  assert.equal(laneHeader.lane, "r92")
  assert.equal(laneHeader.index, "r92")
  assert.equal(laneHeader.runId, "rerun-r92")

  // …and the directory it writes, which the header cannot show because the test
  // above pins it. Named lanes live beside each other under `fullbench/`.
  const derived = join(root, "fullbench", "rerun-check-run-45")
  rmSync(derived, { recursive: true, force: true })
  try {
    const listed = spawnSync(join(root, "run-45.sh"), ["--lane", "check-run-45", "--list"], {
      encoding: "utf8",
      env: { ...process.env, FB_DIR: "", SWB_DATASET: dataset, SWB_RERUN_BASELINE: baseline }
    })
    assert.equal(listed.status, 0, listed.stderr)
    assert.deepEqual(listed.stdout.trim().split("\n").sort(), [...IDS].sort())
    assert.ok(existsSync(derived), "a named lane did not derive its own directory under fullbench/")
  } finally {
    rmSync(derived, { recursive: true, force: true })
  }

  // A lane is a path component and an evaluator run id at once, so a name that
  // is neither is refused before it can escape either.
  for (const bad of ["../escape", "", "a b", "-r92"]) {
    const refused = drive(join(temporary, "fb-lane-bad"), ["--lane", bad, "--status"])
    assert.equal(refused.status, 2, `--lane '${bad}' was accepted`)
    assert.match(refused.stdout + refused.stderr, /--lane must be a name/)
  }

  // A lane's index is the run index every artifact carries, and
  // `lib/run-paths.sh` accepts only `r<digits>[<lowercase tag>]`. A lane named
  // any other way must name its index, or the driver would pull an image for
  // each instance and fail every one of them at run-paths.
  writeFileSync(trace, "")
  const unindexed = drive(join(temporary, "fb-lane-index"), ["--lane", "jev1", "--limit", "1"], { SWB_RERUN_JOBS: "1" })
  assert.equal(unindexed.status, 2, `a lane whose index run-paths refuses was started\n${unindexed.stdout}`)
  assert.match(unindexed.stdout + unindexed.stderr, /run index must match r<digits>/)
  assert.equal(readFileSync(trace, "utf8"), "", "an instance started under an index run-paths refuses")
  const indexedFb = join(temporary, "fb-lane-indexed")
  const indexed = drive(indexedFb, ["--lane", "jev1", "--limit", "1"], {
    SWB_RERUN_INDEX: "r99jev",
    SWB_RERUN_JOBS: "1"
  })
  assert.equal(indexed.status, 0, `${indexed.stdout}\n${indexed.stderr}`)
  const indexedHeader = read(join(indexedFb, "manifest.jsonl")).header
  assert.equal(indexedHeader.lane, "jev1")
  assert.equal(indexedHeader.index, "r99jev")
  assert.equal(indexedHeader.runId, "rerun-jev1")

  // -----------------------------------------------------------------------
  // Refusals.
  // -----------------------------------------------------------------------
  const noBaseline = spawnSync(join(root, "run-45.sh"), ["--status"], {
    encoding: "utf8",
    env: { ...process.env, FB_DIR: join(temporary, "fb-none"), SWB_RERUN_BASELINE: join(temporary, "nope.jsonl") }
  })
  assert.equal(noBaseline.status, 1)
  assert.match(noBaseline.stderr, /no baseline ledger/)

  const badJobs = drive(join(temporary, "fb-bad"), ["--status"], { SWB_RERUN_JOBS: "0" })
  assert.equal(badJobs.status, 2)
  assert.match(badJobs.stdout + badJobs.stderr, /JOBS must be a positive integer/)

  console.log("check-run-45: the population is the baseline's, concurrency is bounded, and the budget gate pauses.")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
