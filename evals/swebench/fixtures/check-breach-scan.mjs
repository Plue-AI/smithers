/**
 * The one-lane seal scan, over recorded rows rather than a live daemon.
 *
 * `compare-codex-lanes.mjs` asserts the seal as one column of a two-lane
 * comparison, which is a codex-shaped question. `breach-scan.mjs` asks it of a
 * single lane of **either** arm, because from 2026-08-24 both arms run their
 * testbed on `--network none` and a claim made for one is worth nothing unless
 * the same evidence is produced for the other.
 *
 * What this pins:
 *
 * - **the assertion reads the observation, never the request.** A lane that
 *   asked for `none` and ran on `bridge` fails. A lane with no observation at
 *   all fails the same way, because an unmeasured container is not a sealed one.
 * - **the flows arm's trace is its journal.** A codex run's commands are in its
 *   transcript; a flows run's are in `flows_journal_events.payload_json`, and a
 *   scan that read only the driver's log would clear every flows lane by
 *   looking in the wrong file.
 * - **an untraced instance is a failure, not a pass.** Scanning a missing file
 *   as the empty string is how a lane clears itself by losing its evidence.
 * - **a lane that claims nothing is reported, not graded.** The three lanes
 *   that ran before the field existed render their counts and say outright that
 *   the verdict is not asserted, so an unrecorded lane can never print the word
 *   the sealed lanes earn.
 *
 * The half that needs a real daemon — `docker exec` against a `--network none`
 * container, the inspect readback — is `./network-dryrun.sh`.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { foldLedger, render, scan } from "../breach-scan.mjs"
import { countedBreaches, inContainerEgress } from "../compare-codex-lanes.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-breach-"))

const jsonl = (path, rows) => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

/** A flows journal holding exactly the payloads a scan has to see. */
const journal = (directory, payloads) => {
  mkdirSync(directory, { recursive: true })
  const db = new DatabaseSync(join(directory, "engine.db"))
  db.exec("create table flows_journal_events (payload_json text, meta_json text)")
  const insert = db.prepare("insert into flows_journal_events values (?, ?)")
  for (const payload of payloads) insert.run(payload, "null")
  db.close()
}

try {
  // -------------------------------------------------------------------------
  // The fold: several rows per instance, and the testbed fields on any of them.
  // -------------------------------------------------------------------------
  const folded = foldLedger(
    [
      { kind: "instance", id: "a__a-1", state: "started", at: 1 },
      { kind: "instance", id: "a__a-1", state: "ran", at: 2, testbedNetwork: "none", testbedNetworkObserved: "none" },
      { kind: "instance", id: "a__a-1", state: "graded", at: 3, verdict: "resolved" },
      { kind: "checkpoint", at: 4 },
      "not json"
    ].map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n")
  )
  assert.equal(folded.length, 1, "one instance, however many rows it wrote")
  assert.equal(folded[0].observed, "none")
  assert.equal(folded[0].requested, "none")
  assert.equal(folded[0].verdict, "resolved")

  // -------------------------------------------------------------------------
  // A sealed flows lane: the commands live in the journal, and there are none.
  // -------------------------------------------------------------------------
  const sealedDirectory = join(temporary, "sealed")
  mkdirSync(join(sealedDirectory, "logs"), { recursive: true })
  journal(join(sealedDirectory, "journals", "a__a-1"), [
    JSON.stringify({ flow: "bash", input: { command: "python -m pytest tests/test_a.py" } })
  ])
  writeFileSync(join(sealedDirectory, "logs", "a__a-1.run.log"), "[a__a-1-r98] agent start\n")
  const sealedLedger = jsonl(join(sealedDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" },
    { kind: "instance", id: "a__a-1", state: "graded", at: 2, verdict: "resolved" }
  ])
  const sealed = scan({
    journals: join(sealedDirectory, "journals"),
    ledger: sealedLedger,
    logs: join(sealedDirectory, "logs"),
    require: "none"
  })
  assert.equal(sealed.rows[0].traceStatus, "traced")
  assert.equal(sealed.rows[0].traceDiagnostics.length, 1)
  assert.equal(sealed.claim, "none")
  assert.deepEqual(sealed.failures, [], "a sealed lane passes")
  assert.equal(sealed.totals.attempts, 0)
  assert.equal(sealed.totals.breaches, 0)
  assert.ok(render(sealed, { label: "x", ledger: sealedLedger }).includes("**Verdict: sealed.**"))

  // Losing agent evidence must fail even when the driver log survives.
  for (const scenario of ["deleted", "empty", "no-events", "wrong-run", "missing-root"]) {
    const directory = join(temporary, `lost-journal-${scenario}`)
    const logs = join(directory, "logs")
    const journals = join(directory, "journals")
    const database = join(journals, "a__a-1", "engine.db")
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, "a__a-1.run.log"), "[a__a-1-r98] agent start\n")
    journal(join(journals, "a__a-1"), scenario === "no-events" ? [] : ["agent call"])
    if (scenario === "deleted") rmSync(database)
    if (scenario === "empty") writeFileSync(database, "")
    if (scenario === "wrong-run") {
      rmSync(join(journals, "a__a-1"), { recursive: true })
      journal(join(journals, "b__b-2"), ["unrelated agent call"])
    }
    if (scenario === "missing-root") rmSync(journals, { recursive: true })
    const lost = scan({ journals, ledger: sealedLedger, logs, require: "none" })
    assert.equal(lost.rows[0].traced, false, `${scenario}: a driver log is not agent evidence`)
    assert.equal(lost.rows[0].traceStatus, "missing-agent-evidence", scenario)
    assert.equal(lost.missingAgentEvidence.length, 1, scenario)
    assert.equal(lost.untraced.length, 1, scenario)
    assert.ok(lost.failures.some((failure) => failure.includes("missing agent evidence")), scenario)
    const report = render(lost, { label: scenario, ledger: sealedLedger })
    assert.ok(report.includes("Missing agent evidence"), scenario)
    assert.ok(report.includes("**Verdict: FAILED.**"), scenario)
    assert.ok(!report.includes("**Verdict: sealed.**"), scenario)
    assert.ok(!report.includes("No run issued an egress command."), scenario)
    const cli = spawnSync(process.execPath, [
      join(root, "breach-scan.mjs"),
      "--ledger",
      sealedLedger,
      "--logs",
      logs,
      "--journals",
      journals,
      "--require",
      "none",
      "--json"
    ], { encoding: "utf8", timeout: 30_000 })
    assert.equal(cli.status, 1, `${scenario}: ${cli.stderr}`)
    assert.equal(JSON.parse(cli.stdout).rows[0].traced, false, scenario)
  }

  // A flows journal is sufficient without a driver, including suffixed runs.
  const suffixedJournals = join(temporary, "suffixed-journals")
  journal(join(suffixedJournals, "a__a-1-r98"), ["agent call"])
  const journalWithoutDriver = scan({ journals: suffixedJournals, ledger: sealedLedger, require: "none" })
  assert.equal(journalWithoutDriver.rows[0].traceStatus, "traced")
  assert.deepEqual(journalWithoutDriver.failures, [])

  // Driver diagnostics are excluded from the agent's calls.
  const diagnosticLogs = join(temporary, "diagnostic-logs")
  mkdirSync(diagnosticLogs)
  writeFileSync(join(diagnosticLogs, "a__a-1.run.log"), "docker exec swb curl https://example.com/\n")
  const diagnostics = scan({
    journals: suffixedJournals,
    ledger: sealedLedger,
    logs: diagnosticLogs,
    require: "none"
  })
  assert.equal(diagnostics.totals.attempts, 0, "driver diagnostics are not agent calls")
  assert.deepEqual(diagnostics.failures, [])

  // Codex needs a non-empty transcript, not just its final message.
  const codexLogs = join(temporary, "codex-evidence")
  mkdirSync(codexLogs)
  writeFileSync(join(codexLogs, "a__a-1.last.txt"), "done\n")
  for (const contents of [undefined, "", "  \n"]) {
    if (contents !== undefined) writeFileSync(join(codexLogs, "a__a-1.run.log"), contents)
    const missing = scan({ ledger: sealedLedger, logs: codexLogs, require: "none" })
    assert.equal(missing.rows[0].traceStatus, "missing-agent-evidence")
    assert.equal(missing.rows[0].traced, false)
    assert.equal(missing.failures.length, 1)
    assert.ok(!render(missing, { label: "codex", ledger: sealedLedger }).includes("**Verdict: sealed.**"))
  }
  writeFileSync(join(codexLogs, "a__a-1.codex.log"), "agent call\n")
  const codexTranscript = scan({ ledger: sealedLedger, logs: codexLogs, require: "none" })
  assert.equal(codexTranscript.rows[0].traceStatus, "traced")
  assert.deepEqual(codexTranscript.failures, [])

  // -------------------------------------------------------------------------
  // The flows arm's trace is the journal. A fetch recorded only there is found.
  // -------------------------------------------------------------------------
  const journalOnly = join(temporary, "journal-only")
  mkdirSync(join(journalOnly, "logs"), { recursive: true })
  journal(join(journalOnly, "journals", "a__a-1"), [
    JSON.stringify({ flow: "bash", input: { command: "docker exec swb curl -sL https://example.com/fix.patch" } })
  ])
  writeFileSync(
    join(journalOnly, "logs", "a__a-1.run.log"),
    "docker exec swb curl https://example.com/driver-probe\n"
      + "curl: (6) Could not resolve host: example.com\n"
  )
  const journalLedger = jsonl(join(journalOnly, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" }
  ])
  const fetched = scan({
    journals: join(journalOnly, "journals"),
    ledger: journalLedger,
    logs: join(journalOnly, "logs"),
    require: "none"
  })
  assert.equal(fetched.totals.attempts, 1, "driver refusals cannot clear the agent fetch")
  assert.equal(fetched.totals.breaches, 1, "a fetch recorded only in the journal is still a breach")
  assert.equal(fetched.breached[0].id, "a__a-1")
  assert.ok(fetched.failures.some((failure) => failure.includes("fetched from inside the testbed")))
  assert.ok(render(fetched, { label: "x", ledger: journalLedger }).includes("Where the seal did not hold"))

  // -------------------------------------------------------------------------
  // The generated flow names its container in a field rather than typing a
  // docker line. A fetch in that form is still an in-container fetch, bound to
  // that container, and on an unmeasured container it is a breach.
  // -------------------------------------------------------------------------
  const structuredDirectory = join(temporary, "structured")
  mkdirSync(join(structuredDirectory, "logs"), { recursive: true })
  const structuredCall = {
    flow: "bash",
    input: {
      mode: "unhermetic",
      container: "a__a-1-r98",
      cwd: "/testbed",
      command: "curl https://example.invalid/fix.patch"
    }
  }
  journal(join(structuredDirectory, "journals", "a__a-1"), [JSON.stringify(structuredCall)])
  const structuredLedger = jsonl(join(structuredDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "graded", at: 1, verdict: "resolved" }
  ])
  const structured = scan({
    journals: join(structuredDirectory, "journals"),
    ledger: structuredLedger,
    logs: join(structuredDirectory, "logs"),
    require: "none"
  })
  assert.equal(structured.totals.attempts, 1)
  assert.equal(structured.totals.inContainerAttempts, 1, "a structured container fetch is an in-container fetch")
  assert.equal(structured.totals.breaches, 1, "on an unmeasured container it is a breach")
  assert.match(structured.rows[0].breaches[0], /^docker exec a__a-1-r98 curl https:\/\/example\.invalid\/fix\.patch/u)
  assert.deepEqual(
    inContainerEgress(JSON.stringify(structuredCall)).map((one) => one.container),
    ["a__a-1-r98"],
    "the structured form carries its container identity"
  )
  const nested = JSON.stringify({ payload: JSON.stringify(structuredCall) })
  assert.equal(inContainerEgress(nested).length, 1, "an event that embeds the call as a JSON string is read too")
  assert.deepEqual(
    inContainerEgress(JSON.stringify({ input: { command: "curl https://example.invalid/" } })),
    [],
    "a host command with no container is not an in-container fetch"
  )

  // -------------------------------------------------------------------------
  // An in-container fetch the trace shows dying is the seal working, not a
  // breach. A `--network none` container cannot resolve a name, and reporting
  // the attempt as a successful fetch failed the first sealed lane that ran.
  // -------------------------------------------------------------------------
  const refusedDirectory = join(temporary, "refused")
  mkdirSync(join(refusedDirectory, "logs"), { recursive: true })
  writeFileSync(
    join(refusedDirectory, "logs", "a__a-1.run.log"),
    "docker exec swb bash -lc 'curl -fsSL https://example.com/fix.patch'\n"
      + "curl: (6) Could not resolve host: example.com\n"
  )
  const refusedLedger = jsonl(join(refusedDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" }
  ])
  const refused = scan({ ledger: refusedLedger, logs: join(refusedDirectory, "logs"), require: "none" })
  assert.equal(refused.totals.inContainerAttempts, 1, "the attempt is still counted and printed")
  assert.equal(refused.totals.inContainerRefused, 1)
  assert.equal(refused.totals.breaches, 0, "a fetch the trace shows failing is not a breach")
  assert.deepEqual(refused.failures, [], "and the lane passes")
  assert.ok(render(refused, { label: "x", ledger: refusedLedger }).includes("**Verdict: sealed.**"))

  // -------------------------------------------------------------------------
  // ...and the reading fails closed. Same container, same command, no recorded
  // outcome: a fetch that left no evidence of failing is not excused by the
  // observation, or `observed none` would be a blanket amnesty.
  // -------------------------------------------------------------------------
  const silentDirectory = join(temporary, "silent")
  mkdirSync(join(silentDirectory, "logs"), { recursive: true })
  writeFileSync(
    join(silentDirectory, "logs", "a__a-1.run.log"),
    "docker exec swb bash -lc 'curl -fsSL https://example.com/fix.patch'\nok\n"
  )
  const silentLedger = jsonl(join(silentDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" }
  ])
  const silent = scan({ ledger: silentLedger, logs: join(silentDirectory, "logs"), require: "none" })
  assert.equal(silent.totals.breaches, 1, "an unrefuted in-container fetch still counts against the lane")
  assert.equal(silent.rows[0].unnetworked, false, "a trace with nothing refused proves nothing")
  assert.ok(silent.failures.some((failure) => failure.includes("fetched from inside the testbed")))

  // -------------------------------------------------------------------------
  // ...unless the same container is shown elsewhere to have had no network at
  // all. `curl --silent | grep` prints no diagnostic and exits with grep's
  // status, so a fetch that returned nothing can leave no refusal text; one
  // command that did resolves the container, which is what the seal is a
  // property of.
  // -------------------------------------------------------------------------
  const quietDirectory = join(temporary, "quiet")
  mkdirSync(join(quietDirectory, "logs"), { recursive: true })
  writeFileSync(
    join(quietDirectory, "logs", "a__a-1.run.log"),
    "docker exec swb bash -lc 'curl --fail --silent https://example.com/one.patch | grep -n x'\n exited 1\n"
      + "docker exec swb bash -lc 'curl -I -L https://example.com/one.patch'\n"
      + "curl: (6) Could not resolve host: example.com\n"
  )
  const quietLedger = jsonl(join(quietDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" }
  ])
  const quiet = scan({ ledger: quietLedger, logs: join(quietDirectory, "logs"), require: "none" })
  assert.equal(quiet.totals.inContainerAttempts, 2)
  assert.equal(quiet.rows[0].unnetworked, true)
  assert.equal(quiet.totals.breaches, 0, "a container shown to have no DNS did not fetch on the quiet command either")
  assert.deepEqual(quiet.failures, [])

  // A refusal in the measured testbed cannot clear a fetch in another
  // container reached through the same Docker socket.
  const otherTrace = "docker exec swb bash -lc 'curl https://example.com/one.patch'\n"
    + "curl: (6) Could not resolve host: example.com\n"
    + "docker exec otherbox bash -lc 'curl https://example.com/two.patch'\n"
    + "diff --git a/a b/a\n"
  writeFileSync(join(quietDirectory, "logs", "a__a-1.run.log"), otherTrace)
  const other = scan({ ledger: quietLedger, logs: join(quietDirectory, "logs"), require: "none" })
  assert.equal(other.totals.breaches, 1, "a refused fetch in swb does not clear otherbox")
  assert.equal(other.totals.inContainerAttempts, 2)
  assert.equal(other.totals.inContainerRefused, 1)
  assert.equal(other.rows[0].unnetworked, false)
  assert.match(other.rows[0].breaches[0], /^docker exec otherbox/u)
  assert.ok(other.failures.some((failure) => failure.includes("fetched from inside the testbed")))
  assert.ok(!render(other, { label: "x", ledger: quietLedger }).includes("**Verdict: sealed.**"))
  const otherRead = inContainerEgress(otherTrace)
  assert.deepEqual(otherRead.map((one) => one.container), ["swb", "otherbox"])
  assert.deepEqual(otherRead.map((one) => one.refused), [true, false])
  assert.ok(otherRead[0].end <= otherTrace.indexOf("docker exec otherbox"))
  // Refusal order and unresolved identities must not restore the exemption.
  const otherStart = otherTrace.indexOf("docker exec otherbox")
  const reversedTrace = otherTrace.slice(otherStart) + otherTrace.slice(0, otherStart)
  assert.equal(countedBreaches(reversedTrace, "none").length, 1)
  for (const target of ["$BOX", "-i swb"]) {
    const unknownTrace = otherTrace.replace("docker exec swb", `docker exec ${target}`)
      .replace("docker exec otherbox", `docker exec ${target}`)
    assert.equal(countedBreaches(unknownTrace, "none").length, 1, "unknown identities cannot share refusals")
  }

  // A refused port proves nothing about the container: a successful fetch from
  // it next is a breach, through the library and the CLI alike. So is a fetch
  // that contradicts a name-resolution failure in the same container, while a
  // refusal still clears its own command and a proof clears a quiet one.
  const sealCases = [
    [
      "connection refused, then a successful fetch",
      "docker exec client wget -qO- http://svc:1/marker\n"
      + "wget: can't connect to remote host (172.17.0.3): Connection refused\n"
      + "docker exec client wget -qO- http://svc:8080/marker\nreview-successful-network-fetch\n",
      1
    ],
    [
      "the successful fetch alone",
      "docker exec client wget -qO- http://svc:8080/marker\nreview-successful-network-fetch\n",
      1
    ],
    [
      "a name that did not resolve, then a successful fetch",
      "docker exec swb curl https://nowhere.example/x\ncurl: (6) Could not resolve host: nowhere.example\n"
      + "docker exec swb curl https://example.com/y\ndiff --git a/a b/a\n",
      1
    ],
    [
      "a refused fetch alone",
      "docker exec swb curl http://localhost:1/\ncurl: (7) Failed to connect to localhost port 1: Connection refused\n",
      0
    ],
    [
      "a quiet fetch beside only a refused port",
      "docker exec swb bash -lc 'curl --fail --silent https://example.com/one.patch | grep -n x'\n exited 1\n"
      + "docker exec swb curl http://localhost:1/\ncurl: (7) Failed to connect to localhost port 1: Connection refused\n",
      1
    ],
    [
      "a quiet fetch beside a name that did not resolve",
      "docker exec swb bash -lc 'curl --fail --silent https://example.com/one.patch | grep -n x'\n exited 1\n"
      + "docker exec swb curl https://example.com/two.patch\ncurl: (6) Could not resolve host: example.com\n",
      0
    ]
  ]
  for (const [name, trace, expected] of sealCases) {
    writeFileSync(join(quietDirectory, "logs", "a__a-1.run.log"), trace)
    const sealed = scan({ ledger: quietLedger, logs: join(quietDirectory, "logs"), require: "none" })
    assert.equal(sealed.totals.breaches, expected, `${name}: breaches`)
    assert.equal(countedBreaches(trace, "none").length, expected, `${name}: countedBreaches`)
    const cli = spawnSync(process.execPath, [
      join(root, "breach-scan.mjs"),
      "--ledger",
      quietLedger,
      "--logs",
      join(quietDirectory, "logs"),
      "--require",
      "none",
      "--json"
    ], { encoding: "utf8", timeout: 30_000 })
    assert.equal(cli.status, expected === 0 ? 0 : 1, `${name}: CLI exit\n${cli.stdout}${cli.stderr}`)
    assert.equal(JSON.parse(cli.stdout).totals.breaches, expected, `${name}: CLI breaches`)
  }

  writeFileSync(join(quietDirectory, "logs", "a__a-1.run.log"), "web search: upstream fix\n")
  const searched = scan({ ledger: quietLedger, logs: join(quietDirectory, "logs"), require: "none" })
  assert.equal(searched.totals.webSearches, 1)
  assert.deepEqual(searched.failures, ["1 run(s) used a web-search tool"])
  assert.ok(!render(searched, { label: "x", ledger: quietLedger }).includes("**Verdict: sealed.**"))

  // -------------------------------------------------------------------------
  // ...and that rule is withdrawn the moment the trace shows a network being
  // attached, which is the only way a running container can acquire one.
  // -------------------------------------------------------------------------
  const connectDirectory = join(temporary, "connect")
  mkdirSync(join(connectDirectory, "logs"), { recursive: true })
  writeFileSync(
    join(connectDirectory, "logs", "a__a-1.run.log"),
    "docker exec swb bash -lc 'curl -I -L https://example.com/one.patch'\n"
      + "curl: (6) Could not resolve host: example.com\n"
      + "docker network connect bridge swb\n"
      + "docker exec swb bash -lc 'curl --fail --silent https://example.com/two.patch | grep -n x'\n"
  )
  const connectLedger = jsonl(join(connectDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" }
  ])
  const connected = scan({ ledger: connectLedger, logs: join(connectDirectory, "logs"), require: "none" })
  assert.equal(connected.rows[0].unnetworked, false, "attaching a network withdraws the container-level reading")
  assert.equal(connected.totals.breaches, 1)
  assert.ok(connected.failures.some((failure) => failure.includes("fetched from inside the testbed")))

  // -------------------------------------------------------------------------
  // The outcome reading applies only where the container was observed `none`.
  // A bridge lane's report does not move: there the attempt is the finding.
  // -------------------------------------------------------------------------
  const bridgeDirectory = join(temporary, "bridge")
  mkdirSync(join(bridgeDirectory, "logs"), { recursive: true })
  writeFileSync(
    join(bridgeDirectory, "logs", "a__a-1.run.log"),
    "docker exec swb bash -lc 'curl -fsSL https://example.com/fix.patch'\n"
      + "curl: (6) Could not resolve host: example.com\n"
  )
  const bridgeLedger = jsonl(join(bridgeDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "bridge", testbedNetworkObserved: "bridge" }
  ])
  const bridge = scan({ ledger: bridgeLedger, logs: join(bridgeDirectory, "logs") })
  assert.equal(bridge.totals.breaches, 1, "on a bridge container the attempt is the finding, as it always was")

  // -------------------------------------------------------------------------
  // Per command, one command's failure is never credited to the next: the
  // window a refusal is read from ends where the next `docker exec` begins.
  // (What the *lane* then does with an unrefuted attempt is the container-level
  // question above; this pins the reading the container rule is built on.)
  // -------------------------------------------------------------------------
  const pairRead = inContainerEgress(
    "docker exec swb bash -lc 'curl -fsSL https://example.com/one.patch'\nok\n"
      + "docker exec swb bash -lc 'curl -fsSL https://example.com/two.patch'\n"
      + "curl: (6) Could not resolve host: example.com\n"
  )
  assert.equal(pairRead.length, 2)
  assert.equal(pairRead[0].refused, false, "the quiet one is not absolved by the next command's failure")
  assert.equal(pairRead[1].refused, true)

  // -------------------------------------------------------------------------
  // The assertion reads the observation, never the request.
  // -------------------------------------------------------------------------
  const liedDirectory = join(temporary, "lied")
  mkdirSync(join(liedDirectory, "logs"), { recursive: true })
  const liedLedger = jsonl(join(liedDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "bridge" }
  ])
  writeFileSync(join(liedDirectory, "logs", "a__a-1.run.log"), "quiet\n")
  const lied = scan({ ledger: liedLedger, logs: join(liedDirectory, "logs"), require: "none" })
  assert.equal(lied.claim, "none", "the claim is what the lane asked for")
  assert.ok(
    lied.failures.some((failure) => failure.includes("not observed `none`")),
    "and the assertion is what the container reported"
  )

  // -------------------------------------------------------------------------
  // An instance with no trace at all fails rather than passing on emptiness.
  // -------------------------------------------------------------------------
  const untracedDirectory = join(temporary, "untraced")
  mkdirSync(join(untracedDirectory, "logs"), { recursive: true })
  const untracedLedger = jsonl(join(untracedDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" }
  ])
  const untraced = scan({ ledger: untracedLedger, logs: join(untracedDirectory, "logs"), require: "none" })
  assert.equal(untraced.untraced.length, 1)
  assert.equal(untraced.rows[0].traceStatus, "no-evidence")
  assert.deepEqual(untraced.missingAgentEvidence, [])
  assert.ok(untraced.failures.some((failure) => failure.includes("left no trace")))

  // -------------------------------------------------------------------------
  // A lane that claims nothing is read, not graded.
  // -------------------------------------------------------------------------
  const oldDirectory = join(temporary, "old")
  mkdirSync(join(oldDirectory, "logs"), { recursive: true })
  writeFileSync(join(oldDirectory, "logs", "a__a-1.run.log"), "curl https://example.com/x\n")
  const oldLedger = jsonl(join(oldDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1 }
  ])
  const old = scan({ ledger: oldLedger, logs: join(oldDirectory, "logs") })
  assert.equal(old.claim, "unrecorded")
  assert.equal(old.asserted, false)
  assert.deepEqual(old.failures, [], "an unrecorded lane is not failed for being old")
  assert.equal(old.totals.attempts, 1, "its attempts are still counted and printed")
  const oldReport = render(old, { label: "x", ledger: oldLedger })
  assert.ok(oldReport.includes("**Verdict: not asserted.**"))
  assert.ok(!oldReport.includes("**Verdict: sealed.**"), "an unrecorded lane never prints the sealed verdict")

  // -------------------------------------------------------------------------
  // A lane measured under two conditions is not one measurement.
  // -------------------------------------------------------------------------
  const mixedDirectory = join(temporary, "mixed")
  mkdirSync(join(mixedDirectory, "logs"), { recursive: true })
  for (const id of ["a__a-1", "b__b-2"]) writeFileSync(join(mixedDirectory, "logs", `${id}.run.log`), "quiet\n")
  const mixedLedger = jsonl(join(mixedDirectory, "manifest.jsonl"), [
    { kind: "instance", id: "a__a-1", state: "ran", at: 1, testbedNetwork: "none", testbedNetworkObserved: "none" },
    { kind: "instance", id: "b__b-2", state: "ran", at: 2, testbedNetwork: "bridge", testbedNetworkObserved: "bridge" }
  ])
  const mixed = scan({ ledger: mixedLedger, logs: join(mixedDirectory, "logs"), require: "none" })
  assert.equal(mixed.claim, "mixed")
  assert.ok(mixed.failures.length > 0, "a mixed lane fails a none requirement")

  console.log(
    "check-breach-scan: one lane of either arm, asserted off the observation and not the request, with the flows"
      + " arm's commands read out of its journal, an untraced instance failed rather than cleared, and a lane that"
      + " recorded no condition reported rather than graded."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
