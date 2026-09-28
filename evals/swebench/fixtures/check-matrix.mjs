/**
 * Replays the matrix driver's scheduler over a stub harness command.
 *
 * `run-matrix.sh` is the piece of the best-of-n rig that cannot be checked by
 * reading it: whether the schedule it produces really holds two invariants at
 * once — at most `jobs` runs in flight, and never two runs of the same instance
 * — is a statement about interleaving, and interleaving is what a stub can
 * exercise for nothing. `SWB_RUN_CMD` replaces the per-run command with a script
 * that records its own start and end, sleeps, writes a patch, and exits with a
 * chosen status.
 *
 * Every assertion is read off that ledger and the manifest the driver wrote:
 * the driver's own view (`matrix-<harness>.json`) has to agree with what the
 * runs actually did.
 *
 * Spends no tokens, needs no docker, needs no dataset, and runs no harness.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-matrix-"))

/**
 * Fake instances, named so that nothing can mistake them for dataset members.
 *
 * Their artifacts go under this run's own temporary directory, named by the
 * same `lib/run-paths.sh` the rig uses, through the `SWB_ARTIFACT_ROOT`
 * override: the point of the test is still that the stub and the driver read
 * one answer, and the ids are fixed, so writing them under the checkout's
 * `patches/` would put two verification runs on one set of files — each
 * measuring sizes the other was rewriting and deleting.
 */
const instances = ["stub__alpha", "stub__beta", "stub__gamma"]
const rounds = 3
const jobs = 2

/**
 * The instance the solo pass runs, where `jobs` is larger than the sample.
 *
 * With three instances and two jobs the concurrency bound already serializes an
 * instance's rounds, so that pass cannot tell whether the same-instance rule is
 * enforced or merely implied: deleting the rule's wait leaves that schedule
 * unchanged. One instance and three jobs isolates it — the only thing that can
 * keep two rounds of one instance apart is the rule itself.
 */
const solo = "stub__solo"

const ledger = join(temporary, "ledger.txt")
const soloLedger = join(temporary, "solo-ledger.txt")

// Every artifact root a run derives, rebased onto the temporary directory by
// `SWB_ARTIFACT_ROOT`. A real run's `run-instance.sh` creates them; a stubbed
// run does not, so the fixture creates the one its stub writes into.
const artifactRoots = [
  "work",
  "work-codex",
  "patches",
  "patches-codex",
  "timings",
  "timings-codex",
  "logs-agent",
  "logs-codex",
  "journals"
]

// What the checkout's artifact roots hold, so the same reading after the runs
// can say the fixture neither added to them nor took from them. Compared as a
// before and after rather than as an emptiness, because a wave's own artifacts
// are none of this fixture's business.
const checkoutArtifacts = () =>
  Object.fromEntries(artifactRoots.map((name) => [
    name,
    existsSync(join(root, name)) ? readdirSync(join(root, name)).sort() : []
  ]))

const before = checkoutArtifacts()

try {
  mkdirSync(join(temporary, "patches"), { recursive: true })
  writeFileSync(
    join(temporary, "dataset.json"),
    JSON.stringify(instances.map((id) => ({
      instance_id: id,
      repo: "stub/stub",
      version: "1.0",
      base_commit: "abc123",
      problem_statement: "stub"
    })))
  )
  writeFileSync(join(temporary, "sample.json"), JSON.stringify({ instances }))
  writeFileSync(ledger, "")

  // The stub harness: one line when it starts, one when it ends, a patch whose
  // size names the run, and an exit status that is non-zero for exactly one run
  // so the manifest's exit column is exercised by something other than success.
  const stub = join(temporary, "stub-run.sh")
  writeFileSync(
    stub,
    `#!/bin/bash
set -u
ID="$1"
INDEX="$4"
eval "$("${root}/lib/run-paths.sh" flows "$ID" "$INDEX")"
printf 'S %s %s\\n' "$ID" "$INDEX" >> "${ledger}"
sleep 0.4
printf 'x%.0s' $(seq 1 "\${#RUN_ID}") > "$PATCH"
printf 'E %s %s\\n' "$ID" "$INDEX" >> "${ledger}"
if [ "$ID" = "stub__beta" ] && [ "$INDEX" = "r2" ]; then exit 3; fi
exit 0
`
  )
  chmodSync(stub, 0o755)

  const manifest = join(temporary, "matrix.json")
  const driver = spawnSync(
    join(root, "run-matrix.sh"),
    ["flows", String(rounds), String(jobs)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SWB_ARTIFACT_ROOT: temporary,
        SWB_RUN_CMD: stub,
        SWB_SAMPLE: join(temporary, "sample.json"),
        SWB_DATASET: join(temporary, "dataset.json"),
        SWB_SAMPLE_COUNT: String(instances.length),
        SWB_MATRIX_OUT: manifest
      }
    }
  )
  // One stub run exits 3, so the driver's own status is that run's, by the same
  // rule `run-sample.sh` follows.
  assert.equal(driver.status, 3, `${driver.stdout}\n${driver.stderr}`)

  // ---------------------------------------------------------------------
  // What the runs actually did
  // ---------------------------------------------------------------------
  const events = readFileSync(ledger, "utf8").split("\n").filter((line) => line !== "")
  assert.equal(events.length, instances.length * rounds * 2, "every run starts once and ends once")

  const live = new Set()
  let peak = 0
  const firstStarts = []
  for (const line of events) {
    const [kind, id, index] = line.split(" ")
    const key = `${id}-${index}`
    if (kind === "S") {
      for (const running of live) {
        assert.notEqual(
          running.slice(0, running.lastIndexOf("-")),
          id,
          `two runs of ${id} were in flight at once (${running} and ${key})`
        )
      }
      live.add(key)
      peak = Math.max(peak, live.size)
      if (firstStarts.length < jobs) firstStarts.push(id)
    } else {
      live.delete(key)
    }
  }
  assert.equal(live.size, 0, "every run that started also ended")
  assert.ok(peak <= jobs, `at most ${jobs} runs in flight, saw ${peak}`)
  assert.ok(peak > 1, "the driver did overlap runs, so the bound means something")
  assert.equal(new Set(firstStarts).size, firstStarts.length, "the schedule interleaves instances")

  // ---------------------------------------------------------------------
  // What the driver says they did
  // ---------------------------------------------------------------------
  const written = JSON.parse(readFileSync(manifest, "utf8"))
  assert.equal(written.harness, "flows")
  assert.equal(written.countPerInstance, rounds)
  assert.equal(written.jobs, jobs)
  assert.deepEqual([...written.instances].sort(), [...instances].sort())
  assert.equal(written.runs.length, instances.length * rounds)

  const rows = new Map(written.runs.map((run) => [run.runId, run]))
  for (const id of instances) {
    for (let round = 1; round <= rounds; round++) {
      const row = rows.get(`${id}-r${round}`)
      assert.ok(row !== undefined, `manifest is missing ${id}-r${round}`)
      assert.equal(row.instance, id)
      assert.equal(row.index, `r${round}`)
      assert.equal(row.patchBytes, `${id}-r${round}`.length, "the manifest measured this run's own patch")
      assert.equal(row.exit, id === "stub__beta" && round === 2 ? 3 : 0)
      assert.ok(row.wallClockSeconds >= 0)
      assert.ok(row.endedAt >= row.startedAt)
    }
  }

  // Manifest order is the matrix, not the finishing order.
  assert.deepEqual(
    written.runs.map((run) => run.runId),
    instances.flatMap((id) => [1, 2, 3].map((round) => `${id}-r${round}`))
  )

  // ---------------------------------------------------------------------
  // The same-instance rule on its own, with the concurrency bound removed
  // as an explanation: one instance, three jobs, three rounds.
  // ---------------------------------------------------------------------
  writeFileSync(
    join(temporary, "solo-dataset.json"),
    JSON.stringify([{
      instance_id: solo,
      repo: "stub/stub",
      version: "1.0",
      base_commit: "abc123",
      problem_statement: "stub"
    }])
  )
  writeFileSync(join(temporary, "solo-sample.json"), JSON.stringify({ instances: [solo] }))
  writeFileSync(soloLedger, "")

  const soloStub = join(temporary, "solo-run.sh")
  writeFileSync(
    soloStub,
    `#!/bin/bash
set -u
eval "$("${root}/lib/run-paths.sh" flows "$1" "$4")"
printf 'S %s\\n' "$4" >> "${soloLedger}"
sleep 0.4
printf 'x' > "$PATCH"
printf 'E %s\\n' "$4" >> "${soloLedger}"
exit 0
`
  )
  chmodSync(soloStub, 0o755)

  const soloDriver = spawnSync(join(root, "run-matrix.sh"), ["flows", String(rounds), "3"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SWB_ARTIFACT_ROOT: temporary,
      SWB_RUN_CMD: soloStub,
      SWB_SAMPLE: join(temporary, "solo-sample.json"),
      SWB_DATASET: join(temporary, "solo-dataset.json"),
      SWB_SAMPLE_COUNT: "1",
      SWB_MATRIX_OUT: join(temporary, "solo-matrix.json")
    }
  })
  assert.equal(soloDriver.status, 0, `${soloDriver.stdout}\n${soloDriver.stderr}`)

  // Strictly serial: every start is followed by its own end before the next
  // start. Removing the rule's wait from run-matrix.sh turns this into three
  // starts and then three ends.
  assert.deepEqual(
    readFileSync(soloLedger, "utf8").split("\n").filter((line) => line !== ""),
    ["S r1", "E r1", "S r2", "E r2", "S r3", "E r3"],
    "three rounds of one instance run one at a time, with three jobs available"
  )
  // ---------------------------------------------------------------------
  // Where the artifacts went. The override is the whole reason this fixture
  // can run twice at once: every patch the stub wrote is under the temporary
  // root, and the checkout's own artifact roots hold exactly what they held
  // before, which a wave running beside this one may be adding to as it does.
  // ---------------------------------------------------------------------
  for (const id of instances) {
    for (let round = 1; round <= rounds; round++) {
      assert.ok(
        existsSync(join(temporary, "patches", `${id}-r${round}.patch`)),
        `${id}-r${round}.patch was written under the artifact root`
      )
    }
  }
  for (let round = 1; round <= rounds; round++) {
    assert.ok(
      existsSync(join(temporary, "patches", `${solo}-r${round}.patch`)),
      `${solo}-r${round}.patch was written under the artifact root`
    )
  }
  assert.deepEqual(
    checkoutArtifacts(),
    before,
    "the fixture neither wrote to nor deleted from the checkout's artifact roots"
  )
  // ---------------------------------------------------------------------
  // A codex wave refuses a bad network condition before its first run. The
  // matrix does not stop on a failing run, so without the up-front check every
  // run would be recorded as a failure.
  // ---------------------------------------------------------------------
  const refusedLedger = join(temporary, "refused-ledger.txt")
  const refusedStub = join(temporary, "refused-stub.sh")
  writeFileSync(refusedStub, `#!/bin/bash\nprintf 'ran\\n' >> "${refusedLedger}"\nexit 2\n`)
  chmodSync(refusedStub, 0o755)
  for (
    const [network, optIn, message] of [
      ["on", undefined, /run-matrix\.sh: SWB_CODEX_NETWORK=on .*set SWB_CODEX_UNCONFINED=allowed to opt in/u],
      ["bogus", "allowed", /run-matrix\.sh: SWB_CODEX_NETWORK must be on, sealed or off, got 'bogus'/u]
    ]
  ) {
    const env = {
      ...process.env,
      SWB_ARTIFACT_ROOT: temporary,
      SWB_RUN_CMD: refusedStub,
      SWB_SAMPLE: join(temporary, "sample.json"),
      SWB_DATASET: join(temporary, "dataset.json"),
      SWB_SAMPLE_COUNT: String(instances.length),
      SWB_MATRIX_OUT: join(temporary, "refused-matrix.json"),
      SWB_CODEX_NETWORK: network
    }
    delete env.SWB_CODEX_UNCONFINED
    if (optIn !== undefined) env.SWB_CODEX_UNCONFINED = optIn
    const refused = spawnSync(join(root, "run-matrix.sh"), ["codex", "1", "1"], { encoding: "utf8", env })
    assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}`)
    assert.match(refused.stderr, message)
    assert.equal(existsSync(refusedLedger), false, "no codex run started")
    assert.equal(existsSync(join(temporary, "refused-matrix.json")), false, "no manifest recorded")
    const sample = spawnSync(join(root, "run-sample.sh"), ["codex", "1"], { encoding: "utf8", env })
    assert.equal(sample.status, 2, `${sample.stdout}\n${sample.stderr}`)
    assert.match(sample.stderr, new RegExp(message.source.replace("run-matrix", "run-sample"), "u"))
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-matrix.mjs: the schedule bounds concurrency and never doubles an instance.")
