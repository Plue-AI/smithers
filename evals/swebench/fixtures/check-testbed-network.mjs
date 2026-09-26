/**
 * The sealed testbed, offline: the condition, the ledger field, and the
 * assertion the scoreboard makes out of them.
 *
 * The codex arm's environment seal was a seal on the tools an agent reaches
 * for. `shell_environment_policy.set` poisons the proxy variables of the
 * commands codex spawns on the host; a `docker exec <container> curl …` starts
 * its process as the docker daemon's child, inside a container that had the
 * network on. Two of the 45 `r90s` runs used exactly that to fetch the merged
 * upstream fix, and `r90sh` repeated it. Will ruled on 2026-08-24 that the
 * testbed gets a proper sandbox so it cannot cheat.
 *
 * What is pinned here is everything about that ruling which does not need
 * docker:
 *
 * - **the rule lives in one file.** Both run scripts resolve the condition
 *   through `lib/testbed-network.sh`, pass it to their `docker run`, and assert
 *   it back off the live container before an agent starts. A run script that
 *   grew its own `--network` literal would be a second rule.
 * - **the request and the observation are separate fields.** `testbedNetwork`
 *   is what the lane asked for; `testbedNetworkObserved` is what
 *   `docker inspect` said. A report that could only print the request would be
 *   printing a claim, so the scoreboard reads the observation.
 * - **a `none` lane is asserted, not described.** Every attempted row must have
 *   observed `none`, and every transcript must be free of in-container fetches.
 *   A row that observed `bridge`, a row that observed nothing, and a transcript
 *   with a breach each fail the lane, and the failure reaches the exit status
 *   rather than only the prose.
 * - **a `bridge` or unrecorded lane is unchanged.** The three lanes that ran
 *   before the field existed still render exactly as they did, with the hole
 *   they always had, and nothing about them is retroactively re-graded.
 * - **`mixed` is fatal on its own.** A lane whose rows disagree about their
 *   testbed is not one measurement.
 * - **the lane table is a quadruple now.** `sealed-high` and `none` share a
 *   network condition *and* an effort, so the uniqueness rule the rig already
 *   applied to the pair has to apply to the triple or the two lanes would read
 *   as one measurement under two names.
 *
 * The half that needs processes and a real daemon — `docker exec` working
 * against a `--network none` container, the inspect readback, the preflight
 * probe's two boots — is `./network-dryrun.sh`.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { compareLanes, render, sealFailures, testbed } from "../compare-codex-lanes.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-testbed-"))

const jsonl = (path, rows) => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

const flowsRows = (id, verdict) => [
  { kind: "instance", id, state: "graded", at: 2, verdict },
  { kind: "instance", id, state: "cleaned", at: 3 }
]

const codexRow = (id, verdict, extra = {}) => ({ kind: "instance", id, state: "graded", at: 2, verdict, ...extra })

try {
  // Run the production preflight with a fake daemon. Only the unknown-readback
  // cases replace the assertion helper, to pin the classifier's own guard even
  // if a successful helper ever returns an unknown condition.
  const preflightRoot = join(temporary, "preflight")
  const bin = join(preflightRoot, "bin")
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(preflightRoot, "lib"))
  copyFileSync(join(root, "preflight-network.sh"), join(preflightRoot, "preflight-network.sh"))
  for (const name of ["excluded.mjs", "fullbench-row.mjs", "testbed-network.sh"]) {
    copyFileSync(join(root, "lib", name), join(preflightRoot, "lib", name))
  }
  const executable = (path, text) => writeFileSync(path, text, { mode: 0o755 })
  executable(
    join(bin, "docker"),
    `#!/bin/bash
case "$1" in
  image|rm|ps) exit 0 ;;
  run)
    case "$PREFLIGHT_CASE:$*" in
      boot-failed:*swb-preflight-probe--probe-1-*) exit 1 ;;
    esac
    exit 0 ;;
  inspect)
    NAME="\${!#}"
    NETWORK="\${NAME##*-}"
    case "$PREFLIGHT_CASE:$NETWORK" in
      assert-none:none|assert-bridge:bridge|assert-both:*) echo host ;;
      *) echo "$NETWORK" ;;
    esac ;;
  exec)
    case "$PREFLIGHT_CASE:$*" in
      broken:*) echo 'FAILED test_bug'; exit 1 ;;
      slow:*) exit 124 ;;
      needs:*swb-preflight-probe--probe-1-none*) echo 'socket.gaierror'; exit 1 ;;
      noisy:*swb-preflight-probe--probe-1-bridge*) exit 1 ;;
    esac
    exit 0 ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
`
  )
  executable(join(bin, "image"), "#!/bin/sh\necho fixture-image\n")
  executable(join(bin, "testcmd"), "#!/bin/sh\necho true\n")
  const population = jsonl(join(preflightRoot, "manifest.jsonl"), [
    { kind: "instance", id: "probe__probe-1" },
    { kind: "instance", id: "works__works-1" }
  ])
  const cases = [
    { name: "boot-failed", exits: [255, 255], verdict: "inconclusive", status: 2 },
    { name: "assert-none", exits: [254, 0], verdict: "inconclusive", status: 2 },
    { name: "assert-bridge", exits: [0, 254], verdict: "inconclusive", status: 2 },
    { name: "assert-both", exits: [254, 254], verdict: "inconclusive", status: 2 },
    { name: "unknown-none", exits: [0, 0], verdict: "inconclusive", status: 2 },
    { name: "unknown-bridge", exits: [0, 0], verdict: "inconclusive", status: 2 },
    {
      name: "boot-failed",
      exits: [255, 255],
      verdict: "inconclusive",
      status: 2,
      instances: "probe__probe-1 works__works-1"
    },
    { name: "works", exits: [0, 0], verdict: "ok", status: 0 },
    { name: "broken", exits: [1, 1], verdict: "ok", status: 0 },
    { name: "slow", exits: [124, 124], verdict: "ok", status: 0 },
    { name: "needs", exits: [1, 0], verdict: "flagged", status: 2 },
    { name: "noisy", exits: [0, 1], verdict: "noisy", status: 0 }
  ]
  for (const fixture of cases) {
    const helper = join(preflightRoot, "lib", "testbed-network.sh")
    if (fixture.name.startsWith("unknown-")) {
      executable(
        helper,
        `#!/bin/sh
if [ "$3" = "${fixture.name.slice("unknown-".length)}" ]; then echo unknown; else echo "$3"; fi
`
      )
    } else {
      copyFileSync(join(root, "lib", "testbed-network.sh"), helper)
    }
    const reportPath = join(preflightRoot, "report.json")
    const result = spawnSync("bash", [join(preflightRoot, "preflight-network.sh"), "--report", reportPath], {
      cwd: preflightRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PREFLIGHT_CASE: fixture.name,
        SWB_PREFLIGHT_INSTANCES: fixture.instances ?? "probe__probe-1",
        SWB_PREFLIGHT_IMAGE_CMD: join(bin, "image"),
        SWB_PREFLIGHT_TEST_CMD: join(bin, "testcmd"),
        SWB_PREFLIGHT_MANIFEST: population,
        SWB_PREFLIGHT_LOGS: join(preflightRoot, "logs"),
        SWB_PREFLIGHT_TIMEOUT: "5",
        SWB_PREFLIGHT_SHELL: "sh"
      }
    })
    assert.ifError(result.error)
    const report = JSON.parse(readFileSync(reportPath, "utf8"))
    const row = report.rows[0]
    assert.deepEqual([row.noneExit, row.bridgeExit], fixture.exits, fixture.name)
    assert.equal(row.verdict, fixture.verdict, `${fixture.name}: ${result.stdout}`)
    assert.equal(result.status, fixture.status, `${fixture.name}: ${result.stderr}`)
    const inconclusive = fixture.verdict === "inconclusive"
    const total = fixture.instances === undefined ? 1 : 2
    assert.equal(report.rows.length, total, fixture.name)
    assert.equal(report.inconclusive, inconclusive ? 1 : 0, fixture.name)
    assert.equal(report.probes, total - (inconclusive ? 1 : 0), fixture.name)
    assert.equal(report.flagged, fixture.verdict === "flagged" ? 1 : 0, fixture.name)
    assert.equal(report.systemic, fixture.verdict === "flagged", fixture.name)
    if (inconclusive) {
      assert.ok(result.stdout.includes(`not probed: probe:1${total === 1 ? " works:1" : " —"}`), fixture.name)
      assert.ok(result.stdout.includes(`1 of ${total} probes inconclusive`), fixture.name)
      assert.doesNotMatch(result.stdout, /probes clear|SYSTEMIC/u, fixture.name)
    }
  }
  console.log(`check-testbed-network: ${cases.length} offline preflight cases passed`)

  // -------------------------------------------------------------------------
  // The condition, read off a lane's own rows.
  // -------------------------------------------------------------------------
  const attemptedRow = (id, extra) => ({ id, attempted: true, ...extra })

  assert.equal(testbed([attemptedRow("a__a-1", { testbedObserved: "none" })]).claim, "none")
  assert.equal(testbed([attemptedRow("a__a-1", { testbedObserved: "bridge" })]).claim, "bridge")
  assert.equal(testbed([]).claim, "unrecorded", "a lane with no rows claims nothing")

  // The claim comes from the request and the assertion from the observation.
  // The case that matters is the pair disagreeing: a lane that asked for `none`
  // and got `bridge` is a failed `none` lane, and reading the claim off the
  // observation would silently re-label it a `bridge` lane and clear it.
  const lied = testbed([attemptedRow("a__a-1", { testbedObserved: "bridge", testbedRequested: "none" })])
  assert.equal(lied.claim, "none", "the claim is what the lane asked for")
  assert.deepEqual(lied.unsealed.map((row) => row.id), ["a__a-1"])
  assert.ok(
    sealFailures({ breaches: [], required: undefined, testbedState: lied }).length > 0,
    "asking for none and running on bridge fails the lane"
  )
  assert.equal(
    testbed([attemptedRow("a__a-1", { testbedRequested: "none" })]).claim,
    "none",
    "a request with no observation still claims none, and fails for having measured nothing"
  )
  assert.equal(
    testbed([
      attemptedRow("a__a-1", { testbedObserved: "none" }),
      attemptedRow("b__b-2", { testbedObserved: "bridge" })
    ]).claim,
    "mixed",
    "rows that disagree are not one measurement"
  )
  assert.equal(
    testbed([
      attemptedRow("a__a-1", { testbedObserved: "none", testbedRequested: "none" }),
      attemptedRow("b__b-2", { testbedObserved: "bridge", testbedRequested: "bridge" })
    ]).claim,
    "mixed",
    "and neither are rows that asked for different things"
  )
  // A row the lane never attempted says nothing about the lane's containers.
  assert.equal(
    testbed([{ id: "c__c-3", attempted: false }, attemptedRow("a__a-1", { testbedObserved: "none" })]).claim,
    "none"
  )
  // A `bridge` observation and a missing one are different repairs, so they are
  // counted apart even though both fail a `none` lane.
  const split = testbed([
    attemptedRow("a__a-1", { testbedObserved: "bridge" }),
    attemptedRow("b__b-2", { testbedRequested: "none" })
  ])
  assert.deepEqual(split.unsealed.map((row) => row.id), ["a__a-1"])
  assert.deepEqual(split.missing.map((row) => row.id), ["b__b-2"])

  // -------------------------------------------------------------------------
  // What each claim obliges the lane to prove.
  // -------------------------------------------------------------------------
  const clean = { claim: "none", missing: [], observed: 3, unsealed: [] }
  assert.deepEqual(sealFailures({ breaches: [], required: undefined, testbedState: clean }), [])

  const networked = { claim: "none", missing: [], observed: 3, unsealed: [{ id: "a__a-1", observed: "bridge" }] }
  const networkedFailures = sealFailures({ breaches: [], required: undefined, testbedState: networked })
  assert.equal(networkedFailures.length, 1)
  assert.equal(networkedFailures[0].kind, "networked testbed")

  // A breach under `none` is a contradiction, and the report treats it as one
  // rather than as the reportable-but-tolerated finding it is under `bridge`.
  const breached = sealFailures({
    breaches: [{ id: "b__b-2" }],
    required: undefined,
    testbedState: clean
  })
  assert.equal(breached.length, 1)
  assert.equal(breached[0].kind, "in-container egress")

  // A `bridge` lane owes nothing new. This is the rule that keeps `r90s` and
  // `r90sh` readable.
  const bridged = { claim: "bridge", missing: [], observed: 45, unsealed: [{ id: "a__a-1", observed: "bridge" }] }
  assert.deepEqual(
    sealFailures({ breaches: [{ id: "b__b-2" }], required: undefined, testbedState: bridged }),
    [],
    "a bridge lane is reported with its hole, never failed for having it"
  )
  // Unless the caller demands the seal, which is how a lane is gated.
  assert.ok(
    sealFailures({ breaches: [], required: "none", testbedState: bridged }).length > 0,
    "--require none fails a bridge lane"
  )
  const unrecorded = { claim: "unrecorded", missing: [], observed: 0, unsealed: [] }
  assert.deepEqual(sealFailures({ breaches: [], required: undefined, testbedState: unrecorded }), [])
  assert.deepEqual(
    sealFailures({ breaches: [], required: "none", testbedState: unrecorded }).map((row) => row.kind),
    ["unmeasured testbed"],
    "a lane that measured nothing cannot claim a seal on demand"
  )
  // Mixed fails whatever anyone required.
  assert.deepEqual(
    sealFailures({
      breaches: [],
      required: undefined,
      testbedState: { claim: "mixed", missing: [], observed: 2, unsealed: [] }
    }).map((row) => row.kind),
    ["mixed testbed"]
  )

  // -------------------------------------------------------------------------
  // End to end, over ledgers.
  // -------------------------------------------------------------------------
  const manifest = jsonl(join(temporary, "manifest.jsonl"), [
    ...flowsRows("a__a-1", "resolved"),
    ...flowsRows("b__b-2", "unresolved")
  ])
  const net = jsonl(join(temporary, "net.jsonl"), [
    codexRow("a__a-1", "resolved"),
    codexRow("b__b-2", "resolved")
  ])
  const sealedNone = jsonl(join(temporary, "none.jsonl"), [
    codexRow("a__a-1", "resolved", { testbedNetwork: "none", testbedNetworkObserved: "none" }),
    codexRow("b__b-2", "unresolved", { testbedNetwork: "none", testbedNetworkObserved: "none" })
  ])
  const logs = join(temporary, "logs")
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, "a__a-1.run.log"), "docker exec box bash -lc 'pytest -q'\n")
  writeFileSync(join(logs, "b__b-2.run.log"), "nothing interesting\n")

  const sealed = compareLanes({
    label: "`r90n` (sealed, network none)",
    manifestPath: manifest,
    netPath: net,
    sealedPath: sealedNone,
    logsDirectory: logs
  })
  assert.equal(sealed.seal.testbed.claim, "none")
  assert.equal(sealed.seal.testbed.observed, 2)
  assert.deepEqual(sealed.seal.failures, [])
  const sealedMarkdown = render(sealed)
  assert.match(sealedMarkdown, /## The testbed/u)
  assert.match(sealedMarkdown, /\*\*Sealed by construction\.\*\*/u)
  assert.match(
    sealedMarkdown,
    /the breach count below has to be zero/u,
    "the report says why a redundant check is the one worth making"
  )

  // The same lane with one container that was never checked. That row is a
  // container nothing measured, which is not the same finding as a container
  // that was networked, and the report has to name it.
  const partial = jsonl(join(temporary, "partial.jsonl"), [
    codexRow("a__a-1", "resolved", { testbedNetwork: "none", testbedNetworkObserved: "none" }),
    codexRow("b__b-2", "unresolved", { testbedNetwork: "none" })
  ])
  const partialResult = compareLanes({ manifestPath: manifest, netPath: net, sealedPath: partial, logsDirectory: logs })
  assert.deepEqual(partialResult.seal.failures.map((row) => row.kind), ["unmeasured testbed"])
  assert.match(render(partialResult), /### The testbed was not sealed/u)
  assert.match(render(partialResult), /\*\*No number in this report is a sealed number\.\*\*/u)

  // A `none` lane whose transcript contains an in-container fetch. Under
  // `--network none` that is impossible, so it means the ledger did not see
  // what actually happened, and the lane fails.
  const breachLogs = join(temporary, "logs-breach")
  mkdirSync(breachLogs, { recursive: true })
  writeFileSync(
    join(breachLogs, "a__a-1.run.log"),
    "docker exec box bash -lc 'curl -fsSL https://github.com/o/r/pull/1.patch'\n"
  )
  // Keep this case about the breach; the other attempted row owes a trace too.
  writeFileSync(join(breachLogs, "b__b-2.run.log"), "pytest -q\n")
  const contradicted = compareLanes({
    manifestPath: manifest,
    netPath: net,
    sealedPath: sealedNone,
    logsDirectory: breachLogs
  })
  assert.deepEqual(contradicted.seal.failures.map((row) => row.kind), ["in-container egress"])

  // The three recorded lanes carry no field at all and must still render.
  const legacy = jsonl(join(temporary, "legacy.jsonl"), [
    codexRow("a__a-1", "resolved"),
    codexRow("b__b-2", "unresolved")
  ])
  const legacyResult = compareLanes({ manifestPath: manifest, netPath: net, sealedPath: legacy, logsDirectory: logs })
  assert.equal(legacyResult.seal.testbed.claim, "unrecorded")
  assert.deepEqual(legacyResult.seal.failures, [], "a lane that predates the field is reported, not judged")
  assert.match(render(legacyResult), /\*\*Unrecorded\.\*\*/u)

  // -------------------------------------------------------------------------
  // The exit status, which is what a script downstream reads.
  // -------------------------------------------------------------------------
  const run = (...argv) =>
    spawnSync(process.execPath, [join(root, "compare-codex-lanes.mjs"), ...argv], { cwd: root, encoding: "utf8" })

  const okRun = run("--manifest", manifest, "--net", net, "--sealed", sealedNone, "--logs", logs, "--json")
  assert.equal(okRun.status, 0, okRun.stderr)

  const failRun = run("--manifest", manifest, "--net", net, "--sealed", partial, "--logs", logs, "--json")
  assert.equal(failRun.status, 1, "a lane that fails its testbed assertions fails the process")
  assert.match(failRun.stderr, /this lane is not sealed/u)

  const gated = run(
    "--manifest",
    manifest,
    "--net",
    net,
    "--sealed",
    legacy,
    "--logs",
    logs,
    "--require",
    "none",
    "--json"
  )
  assert.equal(gated.status, 1, "--require none gates a lane that never measured its testbed")

  const ungated = run("--manifest", manifest, "--net", net, "--sealed", legacy, "--logs", logs, "--json")
  assert.equal(ungated.status, 0, "without the flag the same lane is reported and not judged")

  const badRequire = run("--manifest", manifest, "--net", net, "--sealed", legacy, "--require", "bridge")
  assert.equal(badRequire.status, 2, "--require takes only 'none'")

  // -------------------------------------------------------------------------
  // One rule, one file, and both run scripts obeying it.
  // -------------------------------------------------------------------------
  const rule = readFileSync(join(root, "lib", "testbed-network.sh"), "utf8")
  assert.match(rule, /SWB_TESTBED_NETWORK:-none/u, "the default is none")
  assert.match(rule, /none\|bridge\) printf/u, "only the two values are accepted")
  assert.match(rule, /HostConfig\.NetworkMode/u, "the mode is read off the live container")
  assert.match(rule, /NetworkSettings\.Networks/u, "and cross-checked against the attached network set")

  for (const script of ["run-instance.sh", "run-instance-codex.sh"]) {
    const text = readFileSync(join(root, script), "utf8")
    assert.match(
      text,
      /TESTBED_NETWORK="\$\("\$S\/lib\/testbed-network\.sh" resolve\)"/u,
      `${script} resolves the condition through the one file that knows it`
    )
    assert.match(
      text,
      /docker run -d --platform linux\/amd64 --name "\$CONTAINER" --network "\$TESTBED_NETWORK"/u,
      `${script} passes it to the docker run that starts the testbed`
    )
    assert.match(
      text,
      /testbed-network\.sh" assert "\$CONTAINER" "\$TESTBED_NETWORK"/u,
      `${script} reads the condition back off the live container`
    )
    assert.match(text, /"testbedNetwork": "%s"/u, `${script} stamps the request into its timings`)
    assert.match(text, /"testbedNetworkObserved": "%s"/u, `${script} stamps the observation into its timings`)
    assert.ok(
      !text.split("\n").some((line) =>
        !line.trimStart().startsWith("#") && /--network (none|bridge|host)\b/u.test(line)
      ),
      `${script} has no --network literal of its own; the rule lives in one file`
    )
  }

  // -------------------------------------------------------------------------
  // The lane table: a quadruple now, because two lanes share network and
  // effort and differ only in the testbed.
  // -------------------------------------------------------------------------
  const backfill = readFileSync(join(root, "codex-backfill.sh"), "utf8")
  const readme = readFileSync(join(root, "README.md"), "utf8")
  const declared = [...backfill.matchAll(
    /LANE_INDEX="(?<index>[A-Za-z0-9]+)"; LANE_RUN_ID="(?<runId>[A-Za-z0-9-]+)"; LANE_NETWORK="(?<network>[a-z]+)"; LANE_EFFORT="(?<effort>[a-z]+)"; LANE_TESTBED="(?<testbed>[a-z]+)"/gu
  )].map((match) => match.groups)
  assert.equal(declared.length, 4, `every lane pins a testbed, read ${declared.length}`)
  const triples = declared.map((lane) => `${lane.network}/${lane.effort}/${lane.testbed}`)
  assert.equal(new Set(triples).size, triples.length, "two lanes measure the same triple of conditions")
  assert.ok(
    declared.some((lane) => lane.testbed === "none"),
    "a lane runs its testbed on none, or the ruling is documentation"
  )
  for (const lane of declared) {
    const row = readme.split("\n").find((line) => line.startsWith("| `") && line.includes(`\`${lane.index}\``))
    assert.ok(row !== undefined, `README documents the lane whose index is ${lane.index}`)
    assert.ok(row.includes(`\`${lane.testbed}\``), `the README row for ${lane.index} names its testbed`)
  }
  assert.ok(
    backfill.includes("export SWB_CODEX_NETWORK SWB_CODEX_EFFORT SWB_TESTBED_NETWORK"),
    "the backfill hands all three conditions to the runner rather than letting any of them default"
  )
  assert.ok(
    backfill.includes("--testbedNetworkObserved $TESTBED_OBSERVED"),
    "the observation reaches the ledger row the scoreboard asserts on"
  )

  console.log(
    "check-testbed-network: the rule lives in one file, both run scripts resolve and assert it, the ledger carries"
      + " the observation and not only the request, a none lane fails its process when any container was networked"
      + " or unmeasured or any transcript breached, a bridge or unrecorded lane is unchanged, and no two lanes share"
      + " a triple of conditions."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
