/**
 * The codex backfill's lanes: one condition, four artifacts, one table.
 *
 * A lane names a whole measurement — the archive, the ledger, the run index, the
 * evaluator run id, and the conditions its runs are given. Moving only some of
 * them would grade one condition's patches into another condition's run id with
 * nothing on disk saying so, which is the same defect `run-45.sh`'s lane exists
 * to prevent on the flows side.
 *
 * Five things are pinned here, all offline:
 *
 * - **a lane reads its own ledger.** The same population, two lanes, two
 *   different remainders: an instance paid for in one lane is still owed in the
 *   other.
 * - **an unknown lane is refused**, rather than silently writing an archive
 *   nothing in the rig knows how to read.
 * - **the table in the script is the table in the README.** A lane added to one
 *   and not the other is a lane an operator cannot find, or a documented lane
 *   that does not exist.
 * - **no two lanes share an artifact.** Two lanes with one index, one ledger,
 *   one archive or one evaluator run id would produce artifacts that cannot be
 *   told apart after the fact.
 * - **no two lanes share a set of conditions, and every lane pins all of
 *   them.** `sealed` and `sealed-high` share a network condition and differ in
 *   effort; `sealed-high` and `none` share a network condition *and* an effort
 *   and differ in the testbed's own network, which is the whole point of the
 *   third one. Two lanes with the same triple would be one measurement under two
 *   names. A lane that left a condition to the runner's default would move when
 *   the default moves — which is exactly what happened to effort on 2026-08-23,
 *   and what the testbed's default did on 2026-08-24 — so all three are written
 *   down per lane.
 *
 * The process half — claims, slots, pulls, grading, deletion — is
 * `./codex-backfill-dryrun.sh`, which needs docker.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
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
import { test } from "node:test"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-lanes-"))

const jsonl = (path, rows) => writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)

const backfill = (fbDirectory, ...argv) =>
  spawnSync(join(root, "codex-backfill.sh"), argv, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FB_DIR: fbDirectory }
  })

// ---------------------------------------------------------------------------
// A lane reads its own ledger.
// ---------------------------------------------------------------------------
const fb = join(temporary, "fullbench")
mkdirSync(fb, { recursive: true })
const IDS = ["a__a-1", "b__b-2", "c__c-3"]
jsonl(
  join(fb, "manifest.jsonl"),
  IDS.flatMap((id) => [
    { kind: "instance", id, state: "graded", at: 1, verdict: "resolved" },
    { kind: "instance", id, state: "cleaned", at: 2 }
  ])
)
jsonl(join(fb, "codex-manifest.jsonl"), [
  { kind: "instance", id: "a__a-1", state: "graded", at: 3, verdict: "resolved" }
])
jsonl(join(fb, "codex-sealed-manifest.jsonl"), [
  { kind: "instance", id: "b__b-2", state: "graded", at: 3, verdict: "unresolved" }
])

const net = backfill(fb, "--list")
assert.equal(net.status, 0, net.stderr)
assert.deepEqual(net.stdout.trim().split("\n"), ["b__b-2", "c__c-3"], "the net lane reads codex-manifest.jsonl")

const sealed = backfill(fb, "--lane", "sealed", "--list")
assert.equal(sealed.status, 0, sealed.stderr)
assert.deepEqual(
  sealed.stdout.trim().split("\n"),
  ["a__a-1", "c__c-3"],
  "the sealed lane reads codex-sealed-manifest.jsonl"
)

const sealedStatus = backfill(fb, "--lane", "sealed", "--status")
assert.match(sealedStatus.stdout, /1 of 3 instances back filled, 2 left/u, "--status reads the lane's own ledger")

const bogus = backfill(fb, "--lane", "bogus", "--status")
assert.equal(bogus.status, 2, "an unknown lane is refused")
assert.match(bogus.stdout + bogus.stderr, /unknown lane/u)

const badJobs = backfill(fb, "--lane", "sealed", "--jobs", "0")
assert.equal(badJobs.status, 2, "--jobs must be a positive integer")

// ---------------------------------------------------------------------------
// The table in the script is the table in the README, and no two lanes share a
// value.
// ---------------------------------------------------------------------------
const script = readFileSync(join(root, "codex-backfill.sh"), "utf8")
const readme = readFileSync(join(root, "README.md"), "utf8")

const declared = [...script.matchAll(
  /^ {2}(?<lane>[a-z-]+)\)\n\s*FBC="\$FB\/(?<archive>[A-Za-z0-9_.-]+)"\n\s*CODEX_MANIFEST="\$FB\/(?<ledger>[A-Za-z0-9_.-]+)"\n\s*LANE_INDEX="(?<index>[A-Za-z0-9]+)"; LANE_RUN_ID="(?<runId>[A-Za-z0-9-]+)"; LANE_NETWORK="(?<network>[a-z]+)"; LANE_EFFORT="(?<effort>[a-z]+)"; LANE_TESTBED="(?<testbed>[a-z]+)" ;;$/gmu
)].map((match) => match.groups)

assert.ok(declared.length >= 2, `the script declares at least two lanes, read ${declared.length}`)
assert.deepEqual(
  declared.map((lane) => lane.lane).sort(),
  ["net", "none", "sealed", "sealed-high"],
  "the lanes are net, sealed, sealed-high and none"
)

// The artifacts a lane writes have to be tellable apart after the fact.
for (const key of ["archive", "ledger", "index", "runId"]) {
  const values = declared.map((lane) => lane[key])
  assert.equal(new Set(values).size, values.length, `two lanes share a ${key}`)
}

// The conditions may overlap one at a time — `sealed` and `sealed-high` share a
// network, `sealed-high` and `none` share a network *and* an effort — but never
// as a whole, or two lanes would be one measurement under two names. The tuple
// grew to three on 2026-08-24, when the testbed's own network became a
// condition; checking the old pair would now let `sealed-high` and `none` read
// as one lane.
const conditions = declared.map((lane) => `${lane.network}/${lane.effort}/${lane.testbed}`)
assert.equal(new Set(conditions).size, conditions.length, "two lanes measure the same triple of conditions")

for (const lane of declared) {
  const row = readme
    .split("\n")
    .find((line) => line.startsWith(`| \`${lane.lane}\``) && line.includes(lane.index))
  assert.ok(row !== undefined, `README documents the ${lane.lane} lane's index ${lane.index}`)
  for (const value of [lane.ledger, lane.runId, lane.network, lane.effort, lane.testbed]) {
    assert.ok(row.includes(value), `the README row for ${lane.lane} names ${value}`)
  }
  assert.ok(
    row.includes(`fullbench/${lane.archive}/`),
    `the README row for ${lane.lane} names fullbench/${lane.archive}/`
  )
}

// The sealed lane's condition is the one `run-instance-codex.sh` implements.
const runner = readFileSync(join(root, "run-instance-codex.sh"), "utf8")
for (const condition of declared.map((lane) => lane.network)) {
  assert.match(
    runner,
    new RegExp(`^\\s{2}${condition}\\)$`, "mu"),
    `run-instance-codex.sh implements the '${condition}' network condition`
  )
}
assert.ok(
  runner.includes("shell_environment_policy.set.${PROXY_VAR}") && runner.includes("HTTPS_PROXY"),
  "the sealed condition poisons every child command's HTTP proxy"
)
assert.ok(runner.includes("--sandbox workspace-write"), "the off condition uses codex's own sandbox")
// The seal has two surfaces, and the second one is the one that was got wrong:
// `tools.web_search=false` is ignored by codex-cli 0.149.0 and the model went on
// searching the web through the first r90s lane. `web_search=disabled` is the
// key that works, and the wrong one must not come back.
assert.ok(runner.includes("web_search=disabled"), "the sealed condition disables codex's own web-search tool")
assert.ok(
  !runner.split("\n").some((line) => !line.trimStart().startsWith("#") && line.includes("tools.web_search")),
  "tools.web_search is a key this build ignores; it must not be what the seal relies on"
)
assert.ok(
  runner.includes("\"$NETWORK\"") && runner.includes("\"network\": \"%s\""),
  "the condition a run was given is stamped into its timings"
)

// Effort is the second condition, and the one that was wrong: the codex arm was
// pinned to a literal `medium` while every flows wave ran at the `high` its own
// default gives, so the two older lanes measure medium codex against high flows.
// The runner takes it from the environment now, defaults to high, and every lane
// pins its own — which is what lets the older lanes keep reproducing.
assert.ok(
  runner.includes("EFFORT=\"${SWB_CODEX_EFFORT:-high}\""),
  "run-instance-codex.sh takes its effort from SWB_CODEX_EFFORT and defaults to high"
)
assert.ok(
  runner.includes("-c model_reasoning_effort=\"$EFFORT\""),
  "the effort a run was given is the one passed to codex"
)
assert.ok(
  !runner.split("\n").some((line) =>
    !line.trimStart().startsWith("#") && line.includes("model_reasoning_effort=\"medium\"")
  ),
  "the medium pin is gone from the runner; a lane that wants medium pins it itself"
)
assert.ok(
  runner.includes("\"$EFFORT\"") && runner.includes("\"effort\": \"%s\""),
  "the effort a run was given is stamped into its timings"
)
for (const effort of declared.map((lane) => lane.effort)) {
  assert.match(
    runner,
    new RegExp(`^\\s{2}[a-z|]*\\b${effort}\\b[a-z|]*\\)`, "mu"),
    `run-instance-codex.sh accepts the '${effort}' effort`
  )
}
assert.ok(
  script.includes("export SWB_CODEX_NETWORK SWB_CODEX_EFFORT"),
  "the backfill hands both conditions to the runner rather than letting it default"
)

rmSync(temporary, { recursive: true, force: true })
console.log(
  "check-codex-lanes: a lane reads its own ledger, an unknown lane is refused, no two lanes share an artifact"
    + " or a triple of conditions, every lane pins its effort and its testbed, and the script's table is the"
    + " README's."
)

// Exercise the actual runners with local command doubles: no Docker daemon,
// evaluator environment or paid model calls. State files stand for containers.
function runnerFixture(harness, scenario, check, overrideEnvironment = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swebench-runner-"))
  const put = (path, content) => writeFileSync(join(dir, path), content, { mode: 0o755 })
  try {
    for (const path of ["lib", "bin", "active", ".venv-swb/bin"]) {
      mkdirSync(join(dir, path), { recursive: true })
    }
    const script = harness === "codex" ? "run-instance-codex.sh" : "run-instance.sh"
    for (const path of [script, "lib/run-paths.sh", "lib/lock.sh", "lib/codex-auth.sh", "lib/transport.sh", "lib/run-with-timeout.py"]) {
      copyFileSync(join(root, path), join(dir, path))
    }
    put("swb-verified.json", "[]")
    put("bin/smithers-jj-export", "#!/bin/sh\nexit 0\n")
    // A GNU timeout on the fixture host must not hide the macOS failure.
    put("bin/timeout", "#!/bin/sh\nexit 127\n")
    put(".subject.json", "{\"stamp\":\"fixture\"}")
    put("lib/validate-instance.mjs", "console.log(\"base\")")
    put("lib/write-prompt-codex.mjs", "console.log(\"fix the bug\")")
    put(".venv-swb/bin/python", "#!/bin/bash\necho \"python -m pytest\"\n")
    put("lib/snapshot-base.sh", "#!/bin/bash\necho base\n")
    put("lib/interpreter.sh", "#!/bin/bash\necho python\n")
    put(
      "lib/testbed-network.sh",
      `#!/bin/bash
if [ "$1" = assert ] && [ "$FIXTURE_SCENARIO" = network-failure ]; then exit 7; fi
echo none
`
    )
    put(
      "lib/capture-patch.sh",
      `#!/bin/bash
case "$FIXTURE_SCENARIO" in
  capture-failure) exit 3 ;;
  missing-patch) exit 0 ;;
  empty-patch) : > "$2" ;;
  *) printf 'paid attempt patch\\n' > "$2" ;;
esac
: > "$2.untracked"
`
    )
    put(
      "bin/codex",
      `#!/bin/bash
if [ "$1" = login ] && [ "$2" = status ]; then echo 'Logged in using an API key'; exit 0; fi
if [ "$1" = login ]; then exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = -C ]; then printf 'paid edits\\n' > "$2/edited.txt"; break; fi
  shift
done
if [ "$FIXTURE_SCENARIO" = agent-timeout ]; then exit 124; fi
if [ "$FIXTURE_SCENARIO" = wall-timeout ]; then sleep 3; fi
`
    )
    put(
      "bin/docker",
      `#!${process.execPath}
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
const dir = process.env.FIXTURE_DIR
const scenario = process.env.FIXTURE_SCENARIO
const active = name => path.join(dir, "active", name)
const signal = () => process.kill(Number(process.env.FIXTURE_RUNNER_PID), "SIGTERM")
fs.appendFileSync(path.join(dir, "docker.log"), args.join(" ") + "\\n")
switch (args[0]) {
  case "image": break
  case "create": {
    const name = args.includes("--name") ? args[args.indexOf("--name") + 1] : "extraction"
    fs.writeFileSync(active(name), "")
    if (scenario === "term-create") signal()
    console.log(name)
    break
  }
  case "cp":
    if (scenario === "term-extraction") signal()
    if (scenario === "copy-failure") process.exit(9)
    fs.writeFileSync(path.join(args[2], "checkout.txt"), "image checkout")
    break
  case "rm": fs.rmSync(active(args.at(-1)), { force: true }); break
  case "run":
    fs.writeFileSync(active(args[args.indexOf("--name") + 1]), "")
    if (scenario === "term-testbed") signal()
    break
  default: throw new Error("unexpected docker command: " + args.join(" "))
}
`
    )
    const result = spawnSync("bash", [
      "-c",
      "export FIXTURE_RUNNER_PID=$$; exec bash \"$@\"",
      "fixture",
      join(dir, script),
      "a__a-1",
      ...(harness === "codex"
        ? [scenario === "wall-timeout" ? "1" : "10", "fixture-model", "r1"] :
        ["fixture-seat", "10", "r1"])
    ], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        SWB_DATASET: join(dir, "swb-verified.json"),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: join(dir, "bin/smithers-jj-export"),
        SWB_CODEX_NETWORK: "on",
        SWB_CODEX_EFFORT: "high",
        SWB_FLOWS_OPENAI_AUTH: "api-key",
        // The flows arm refuses to start an agent until its lane opts into the
        // unconfined host shell (`run-instance.sh`). This fixture IS a lane, and
        // its agent is a stub, so it opts in like the real ones do; the refusal
        // itself is covered by `check-prompts.mjs`. Without this every `flows`
        // scenario below exits 2 before the runner does anything it asserts on.
        SWB_FLOWS_HOST_SHELL: "allowed",
        FIXTURE_DIR: dir,
        FIXTURE_SCENARIO: scenario,
        ...overrideEnvironment
      }
    })
    assert.ifError(result.error)
    const work = join(dir, harness === "codex" ? "work-codex" : "work", "a__a-1-r1")
    check({ dir, work, result })
    assert.deepEqual(readdirSync(join(dir, "active")), [], "all acquired containers are removed")
    assert.ok(!existsSync(join(dir, ".extract-lock")), "extraction lock is released")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("flows refuses a missing native helper before pulling an image", () => {
  runnerFixture("flows", "success", ({ dir, result }) => {
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no executable workspace helper/u)
    assert.ok(!existsSync(join(dir, "docker.log")), "no image operation started")
  }, { SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: "/no-such-video-benchmark-helper" })
})

for (const scenario of ["capture-failure", "missing-patch"]) {
  test(`codex ${scenario} preserves paid edits and reports failure`, () => {
    runnerFixture("codex", scenario, ({ dir, work, result }) => {
      assert.equal(result.status, scenario === "capture-failure" ? 3 : 1, result.stdout + result.stderr)
      assert.equal(readFileSync(join(work, "edited.txt"), "utf8"), "paid edits\n")
      const marker = readFileSync(join(dir, "logs-codex/a__a-1-r1.capture-failed"), "utf8")
      assert.ok(marker.includes(work), "failure marker identifies the recovery workspace")
      assert.match(result.stderr, /CAPTURE FAILED/u)
    })
  })
}

for (const scenario of ["success", "empty-patch", "agent-timeout", "wall-timeout"]) {
  test(`codex ${scenario} captures before deleting its workspace`, () => {
    runnerFixture("codex", scenario, ({ dir, work, result }) => {
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.equal(existsSync(work), scenario === "empty-patch")
      const patch = readFileSync(join(dir, "patches-codex/a__a-1-r1.patch"), "utf8")
      assert.equal(patch, scenario === "empty-patch" ? "" : "paid attempt patch\n")
      assert.ok(!existsSync(join(dir, "logs-codex/a__a-1-r1.capture-failed")))
      if (scenario === "agent-timeout" || scenario === "wall-timeout") {
        assert.equal(JSON.parse(readFileSync(join(dir, "timings-codex/a__a-1-r1.json"))).exitCode, 124)
      }
    })
  })
}

for (const harness of ["codex", "flows"]) {
  for (const scenario of ["copy-failure", "network-failure", "term-create", "term-extraction", "term-testbed"]) {
    test(`${harness} ${scenario} cleans up and terminates`, () => {
      runnerFixture(harness, scenario, ({ dir, result }) => {
        if (scenario.startsWith("term-")) {
          assert.equal(result.signal, "SIGTERM", result.stdout + result.stderr)
        } else {
          assert.notEqual(result.status, 0, result.stdout + result.stderr)
        }
        const commands = readFileSync(join(dir, "docker.log"), "utf8")
        assert.match(commands, /^create /mu, "the extraction container was acquired")
        if (scenario === "term-testbed" || scenario === "network-failure") {
          assert.match(commands, /sleep infinity/mu, "the live testbed was acquired")
        }
        assert.ok(!result.stdout.includes("codex start"), "failed setup never starts a paid attempt")
      })
    })
  }
}
