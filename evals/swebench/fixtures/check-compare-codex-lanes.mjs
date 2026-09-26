/**
 * Replays the two-codex-lane scoreboard over synthesised ledgers and traces.
 *
 * The question that report answers — how much of the codex column came from the
 * network — has three ways to be answered dishonestly, and all three are pinned
 * here:
 *
 * - **a verdict that is not a grading is not a loss.** An `eval error` in either
 *   lane leaves the movement sets and is named instead. Counting one would
 *   manufacture a "lost with the seal" out of a docker fault, which is the
 *   headline the report exists to state.
 * - **both denominators, always.** `lib/excluded.mjs` keeps two `psf/requests`
 *   rows out of every rate; the scored count and the raw count are printed in
 *   one sentence, and an excluded row is in neither movement set.
 * - **a claimed seal is read back off the traces.** A run that never reached for
 *   the network and a run that reached and was refused are different findings,
 *   so the transcripts are counted rather than assumed, and an instance that
 *   attempted egress is named whatever its verdict. Both surfaces are counted:
 *   the child commands' proxy, and codex's own web-search tool, which no proxy
 *   reaches and which the first r90s attempt left live without noticing.
 * - **the lane the report scores is the lane it names.** The same script reads
 *   whichever sealed lane its flags point at, so an `r90sh` column under the
 *   `r90s` heading would be a number quoted under conditions it was never
 *   measured under.
 *
 * The report is also asserted to be a pure function of its inputs: the same
 * ledgers twice produce the same bytes.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { breaches, compareLanes, egress, inContainerEgress, readVerdict, render } from "../compare-codex-lanes.mjs"
import { EXCLUDED } from "../lib/excluded.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-lanes-report-"))
const excludedId = [...EXCLUDED.keys()][0]

const jsonl = (path, rows) => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

const flowsRows = (id, verdict) => [
  { kind: "instance", id, state: "pulled", at: 1 },
  { kind: "instance", id, state: "graded", at: 2, verdict },
  { kind: "instance", id, state: "cleaned", at: 3 }
]

const codexRow = (id, verdict, extra = {}) => ({ kind: "instance", id, state: "graded", at: 2, verdict, ...extra })

try {
  // What each verdict means, stated once.
  assert.equal(readVerdict("resolved").resolved, true)
  assert.equal(readVerdict("empty patch").graded, true)
  assert.equal(readVerdict("eval error").graded, false)
  assert.equal(readVerdict(undefined).verdict, "not run")

  // What a transcript is read for.
  assert.deepEqual(egress("nothing here").attempts, 0)
  const reached = egress("$ curl -sS https://api.github.com/repos/x/y\ncurl: (7) Failed to connect to 127.0.0.1 port 1")
  assert.equal(reached.attempts, 1)
  assert.equal(reached.refusals, 1)
  assert.equal(reached.breaches.length, 0)

  // A fetch on the far side of a `docker exec` is the one way out the proxy
  // seal does not reach, so it is counted apart from an attempt the proxy
  // refused. Proving both halves: a host fetch is never a breach, and a
  // container fetch is one even when it is also counted as an attempt.
  const breached = egress(
    "/bin/zsh -lc \"docker exec box bash -lc 'curl -fsSL https://github.com/o/r/pull/1.patch'\" in /tmp/w"
  )
  assert.equal(breached.attempts, 1)
  assert.equal(breached.breaches.length, 1)
  assert.match(breached.breaches[0], /^docker exec box/u)
  // `docker exec` on its own is how both arms run the project's tests, so it is
  // a breach only when it carries a fetch.
  assert.equal(egress("/bin/zsh -lc \"docker exec box bash -lc 'pytest -q'\" in /tmp/w").breaches.length, 0)

  // The seal's second surface. The tool is codex's own, so no proxy reaches it
  // and only the transcript says whether it ran. The first r90s attempt is why
  // this is counted rather than assumed: it set a key this build ignores and
  // searched the web 126 times without anything noticing.
  assert.equal(egress("nothing here").webSearches.length, 0)
  assert.equal(egress("web search: django ticket 12345\nweb search:\n").webSearches.length, 2)
  // Prose that merely mentions the phrase is not a call: the line has to be the
  // tool's own, from the start of the line.
  assert.equal(egress("I could web search: but the tool is off\n").webSearches.length, 0)

  const manifest = join(temporary, "manifest.jsonl")
  const net = join(temporary, "codex-manifest.jsonl")
  const sealed = join(temporary, "codex-sealed-manifest.jsonl")
  const logs = join(temporary, "logs")
  mkdirSync(logs, { recursive: true })

  jsonl(manifest, [
    ...flowsRows("a__a-1", "resolved"),
    ...flowsRows("b__b-2", "unresolved"),
    ...flowsRows("c__c-3", "resolved"),
    ...flowsRows("d__d-4", "resolved"),
    ...flowsRows(excludedId, "resolved")
  ])
  jsonl(net, [
    codexRow("a__a-1", "resolved", { wallSeconds: 10, tokens: 100 }),
    codexRow("b__b-2", "resolved"),
    codexRow("c__c-3", "unresolved"),
    codexRow("d__d-4", "eval error"),
    codexRow(excludedId, "resolved")
  ])
  jsonl(sealed, [
    codexRow("a__a-1", "resolved", { wallSeconds: 12, tokens: 120 }),
    codexRow("b__b-2", "unresolved"),
    codexRow("c__c-3", "resolved"),
    codexRow("d__d-4", "resolved"),
    codexRow(excludedId, "unresolved")
  ])
  writeFileSync(join(logs, "a__a-1.run.log"), "docker exec box bash -lc 'pytest -q'\n")
  writeFileSync(
    join(logs, "b__b-2.run.log"),
    "curl -sS https://api.github.com/repos/x/y/pulls/1\ncurl: (7) Failed to connect to 127.0.0.1 port 1 after 0 ms\n"
  )
  // The run that got out anyway: the fetch is on the far side of a `docker
  // exec`, so the proxy the seal set never applied to it.
  writeFileSync(
    join(logs, "c__c-3.run.log"),
    "/bin/zsh -lc \"docker exec box bash -lc 'curl -fsSL https://github.com/x/y/pull/3.patch'\" in /tmp/w\n"
  )

  const result = compareLanes({ manifestPath: manifest, netPath: net, sealedPath: sealed, logsDirectory: logs })

  // An eval error in either lane is outside the movement sets, and named.
  assert.ok(!result.movement.lostWithTheSeal.includes("d__d-4"))
  assert.ok(!result.movement.gainedWithTheSeal.includes("d__d-4"))
  assert.deepEqual(result.notComparable.map((row) => row.id), ["d__d-4"])

  // The seal moved exactly one row each way, over the scored, comparable rows.
  assert.deepEqual(result.movement.lostWithTheSeal, ["b__b-2"])
  assert.deepEqual(result.movement.gainedWithTheSeal, ["c__c-3"])
  assert.equal(result.totals.comparable, 3)

  // An excluded instance is in no movement set and in both denominators.
  for (const set of Object.values(result.movement)) assert.ok(!set.includes(excludedId))
  assert.equal(result.totals.raw, 5)
  assert.equal(result.totals.scored, 4)
  assert.equal(
    result.totals.netResolvedRaw,
    result.totals.netResolvedScored + 1,
    "the excluded row is in the raw count"
  )

  // The traces are counted rather than assumed.
  assert.equal(result.seal.transcriptsRead, 3)
  assert.deepEqual(result.seal.instancesWithAttempts.map((row) => row.id), ["b__b-2", "c__c-3"])
  assert.equal(result.seal.instancesWithAttempts[0].refusals, 1)

  // A refused attempt is the seal working; a container fetch is the seal not
  // holding, and only the second one may void a verdict. They are separate
  // columns because they are separate findings.
  assert.equal(result.seal.instancesWithAttempts[0].breaches, 0)
  assert.deepEqual(result.seal.instancesWithBreaches.map((row) => row.id), ["c__c-3"])
  assert.equal(
    result.seal.instancesWithBreaches[0].sealed,
    "resolved",
    "a breach carries the verdict it casts doubt on"
  )

  // The web-search surface: zero over these traces, which is the claim a sealed
  // lane makes, and it is read off the transcripts rather than remembered.
  assert.equal(result.seal.webSearchLines, 0)
  assert.deepEqual(result.seal.instancesWithWebSearches, [])

  const markdown = render(result)
  assert.match(
    markdown,
    /\*\*0 `web search:` lines across 3 transcripts\.\*\*/u,
    "the seal's second surface is counted"
  )
  assert.match(markdown, /4 scored of 5 run/u, "both denominators are stated before any rate")
  assert.match(markdown, /lost with the seal\*\* \(1\): b__b-2/u)
  assert.match(markdown, /gained with the seal\*\* \(1\): c__c-3/u)
  assert.match(markdown, /d__d-4` — network: eval error/u, "a row one lane never graded is named")
  assert.match(markdown, /Excluded from the scoreboard, by name/u)
  assert.match(markdown, /Where the seal did not hold/u)
  assert.match(
    markdown,
    /A verdict on this list is not a sealed verdict/u,
    "a breach is stated, not left to be inferred"
  )
  assert.match(markdown, /\| `c__c-3` \| resolved \| 1 \|/u)
  assert.equal(
    markdown,
    render(compareLanes({
      manifestPath: manifest,
      netPath: net,
      sealedPath: sealed,
      logsDirectory: logs
    })),
    "the same ledgers twice produce the same bytes"
  )

  // A lane whose search tool was live says so, names the runs, and says what it
  // costs their verdicts — the same treatment a breach gets, because it is the
  // same finding: the run read the network.
  const searchedLogs = join(temporary, "logs-searched")
  mkdirSync(searchedLogs, { recursive: true })
  writeFileSync(join(searchedLogs, "a__a-1.run.log"), "web search: xarray groupby bug upstream issue\nweb search:\n")
  const searched = compareLanes({
    manifestPath: manifest,
    netPath: net,
    sealedPath: sealed,
    logsDirectory: searchedLogs
  })
  assert.equal(searched.seal.webSearchLines, 2)
  assert.deepEqual(searched.seal.instancesWithWebSearches.map((row) => row.id), ["a__a-1"])
  const searchedMarkdown = render(searched)
  assert.match(searchedMarkdown, /\*\*2 `web search:` lines across 1 of 1 transcripts\.\*\*/u)
  assert.match(
    searchedMarkdown,
    /A verdict on this list is not a sealed verdict\*\*, and a lane with a non-zero total/u,
    "a live search tool voids the verdicts it touched, stated rather than inferred"
  )

  // The lane the report scores is the lane it names.
  assert.match(markdown, /\| codex `r90s` \(sealed\) \|/u, "the default label is the sealed lane")
  const labelled = render({ ...result, label: "`r90sh` (sealed, high effort)" })
  assert.match(labelled, /\| codex `r90sh` \(sealed, high effort\) \|/u)
  assert.match(labelled, /\| instance \| flows `r90` \| codex `r90c` \| codex `r90sh` \| sealed wall \(s\) \|/u)

  // Neither a missing transcript nor host-side web search can earn a seal,
  // even when the testbed observation is none. Pin the CLI gate as well.
  const gateManifest = jsonl(join(temporary, "gate-flows.jsonl"), [
    ...flowsRows("a__a-1", "resolved"),
    ...flowsRows("not__attempted-1", "resolved")
  ])
  const gateLedger = jsonl(join(temporary, "gate-codex.jsonl"), [
    codexRow("a__a-1", "resolved", { testbedNetwork: "none", testbedNetworkObserved: "none" })
  ])
  const gateLogs = join(temporary, "gate-logs")
  mkdirSync(gateLogs)
  const gateCases = [
    { name: "missing transcript", text: undefined, kind: "missing trace" },
    { name: "host web search", text: "web search: upstream fix\n", kind: "web search" },
    { name: "complete quiet trace", text: "pytest -q\nok\n", kind: undefined },
    {
      name: "another container fetched",
      text: "docker exec swb curl https://example.com/one.patch\n"
        + "curl: (6) Could not resolve host: example.com\n"
        + "docker exec otherbox curl https://example.com/two.patch\ndiff --git a/a b/a\n",
      kind: "in-container egress"
    }
  ]
  const gateFailures = []
  for (const entry of gateCases) {
    if (entry.text !== undefined) writeFileSync(join(gateLogs, "a__a-1.run.log"), entry.text)
    for (const required of [undefined, "none"]) {
      const gated = compareLanes({
        manifestPath: gateManifest,
        netPath: gateLedger,
        sealedPath: gateLedger,
        logsDirectory: gateLogs,
        require: required
      })
      const expected = entry.kind === undefined ? [] : [entry.kind]
      if (JSON.stringify(gated.seal.failures.map((failure) => failure.kind)) !== JSON.stringify(expected)) {
        gateFailures.push(`${entry.name} (require ${required}): ${JSON.stringify(gated.seal.failures)}`)
      }
      if (render(gated).includes("**Sealed by construction.**") !== (entry.kind === undefined)) {
        gateFailures.push(`${entry.name}: incorrect Sealed headline`)
      }
    }
    const cli = spawnSync(process.execPath, [
      resolve(import.meta.dirname, "../compare-codex-lanes.mjs"),
      "--manifest",
      gateManifest,
      "--net",
      gateLedger,
      "--sealed",
      gateLedger,
      "--logs",
      gateLogs,
      "--require",
      "none",
      "--json"
    ], { encoding: "utf8", timeout: 30_000 })
    if (cli.status !== (entry.kind === undefined ? 0 : 1)) {
      gateFailures.push(`${entry.name}: CLI exited ${cli.status}: ${cli.stderr}`)
    }
  }
  assert.deepEqual(gateFailures, [], "every seal obligation gates the verdict and exit status")

  // Codex transcripts and older flows traces type the docker line themselves.
  // Reading the structured form must not change how that line is read.
  const literalTrace = "$ docker exec swb bash -lc 'curl -fsSL https://example.com/fix.patch'\n"
    + "curl: (6) Could not resolve host: example.com\n"
    + "docker exec otherbox wget https://example.com/two.patch\nok\n"
  assert.deepEqual(breaches(literalTrace), [
    "docker exec swb bash -lc 'curl -fsSL https://example.com/fix.patch'",
    "docker exec otherbox wget https://example.com/two.patch"
  ])
  assert.deepEqual(inContainerEgress(literalTrace), [
    {
      command: "docker exec swb bash -lc 'curl -fsSL https://example.com/fix.patch'",
      container: "swb",
      start: 69,
      end: 116,
      refused: true
    },
    {
      command: "docker exec otherbox wget https://example.com/two.patch",
      container: "otherbox",
      start: 171,
      end: 175,
      refused: false
    }
  ])

  console.log(
    "check-compare-codex-lanes: an eval error is never a loss, an exclusion is in no movement set and in both"
      + " denominators, both surfaces of the seal are counted off the traces, the report names the lane it scored,"
      + " and it is deterministic."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
