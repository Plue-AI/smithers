import { Effect, Schema } from "effect"
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  byPriority,
  claimTool,
  decide,
  Input,
  localLimit,
  makeIssueDiscovery,
  makePlacementSlots,
  minFreeBytes,
  parkedFor,
  releasesClaim,
  roundStats,
  staleWorkspaces,
  urgent
} from "../flow.ts"
import { vmOptions } from "../vm-options.ts"
import Work, { RemoteFix } from "../work/flow.ts"

const claim = (host: string, expires: string) =>
  `Claimed by codex-root-3276 on ${host} at 2026-09-30T23:28:42.882Z; expires ${expires}`
const expires = "2026-10-01T05:28:42.882Z"
const at = Date.parse(expires)

test("an issue with no claim comment is ours", () => {
  assert.equal(decide(undefined, at), "ours")
})

test("a comment that is not a claim is ours", () => {
  assert.equal(decide("Claimed it, will look tomorrow", at), "ours")
})

test("a live Mac mini claim is skipped up to the millisecond before it expires", () => {
  assert.equal(decide(claim("Williams-Mac-mini.local", expires), at - 1), "skip")
})

test("a Mac mini claim is ours from the moment it expires", () => {
  assert.equal(decide(claim("Williams-Mac-mini.local", expires), at), "ours")
  assert.equal(decide(claim("Williams-Mac-mini.local", expires), at + 1), "ours")
})

test("a live claim from any other machine is ours", () => {
  assert.equal(decide(claim("Williams-MacBook-Pro-3.local", expires), at - 1), "ours")
})

test("a claim line ending in a period still parses", () => {
  assert.equal(decide(`${claim("Williams-Mac-mini.local", expires)}.`, at - 1), "skip")
})

test("an unparseable expiry is treated as expired", () => {
  assert.equal(decide(claim("Williams-Mac-mini.local", "soon"), at), "ours")
})

// A peer's half-made edit to the shared checkout's issue-claim.mjs failed every claim of a running sweep.
test("the claim tool is the copy in this flow's own checkout", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  assert.equal(claimTool, `${root}scripts/issue-claim.mjs`)
})

// run-4: a requeued row's release removed the workspaces its resumed children landed from.
test("a requeued row keeps its claim and workspace; every final row releases them", () => {
  assert.equal(releasesClaim("requeued"), false)
  for (const status of ["landed", "held", "failed", "skipped"] as const) assert.equal(releasesClaim(status), true)
})

// run-4: agents spent their run on #2845 (blocked-on-will) and #3165/#3166 ("Deferred past 1.0").
test("issues for the maintainer or deferred by title are not dispatched", () => {
  assert.equal(
    parkedFor({ title: "Release: publish installers", labels: ["blocked-on-will"] }),
    "blocked on the maintainer"
  )
  assert.equal(parkedFor({ title: "Deferred past 1.0: Npm.Downstream build target", labels: [] }), "deferred")
  // Owner ruling 2026-10-01: Terminal-Bench, ALE and DeepSWE work is its own program.
  assert.equal(parkedFor({ title: "Terminal-Bench harness", labels: ["benchmark"] }), "benchmark: separate program")
  assert.equal(parkedFor({ title: "  deferred: x", labels: ["bug"] }), "deferred")
  assert.equal(parkedFor({ title: "Defer the cache flush until close", labels: [] }), undefined)
  assert.equal(parkedFor({ title: "Retire the legacy Workers", labels: ["bug", "in-progress"] }), undefined)
})

// 51 leftover issue workspaces held 24 GiB after cancelled runs.
test("only workspaces of issues no longer open are stale", () => {
  assert.deepEqual(
    staleWorkspaces(["issue-1", "issue-2", "issue-30", "notes.txt", "issue-x"], new Set([2])),
    [1, 30]
  )
  assert.deepEqual(staleWorkspaces([], new Set()), [])
})

test("VM capacity counts agent slots and preserves the host ceiling", () => {
  const input = { repo: "o/r", placement: "vm" as const, maxAgents: 32, agentsPerVm: 3, maxVms: 2 }
  assert.equal(localLimit(input, minFreeBytes), 6)
  assert.equal(localLimit({ ...input, maxAgents: 4 }, minFreeBytes), 4)
  assert.equal(localLimit({ ...input, maxVms: 12 }, minFreeBytes), 24)
  assert.equal(localLimit(input, minFreeBytes - 1), 0)
  assert.equal(localLimit({ ...input, placement: "local" }, minFreeBytes - 1), 32)
})

test("VM options survive the sweep, work, and remote payload schemas", () => {
  const options = { agentsPerVm: 3, maxVms: 2, memoryBaseMib: 512, memoryPerAgentMib: 768, cpusPerAgent: 2, maxCpus: 8 }
  const input = Schema.decodeUnknownSync(Input)({ repo: "o/r", placement: "vm", ...options })
  const work = Schema.decodeUnknownSync(Work.payloadSchema)({
    repo: input.repo,
    issue: 7,
    placement: input.placement,
    ...vmOptions(input)
  })
  const remote = Schema.decodeUnknownSync(RemoteFix.payloadSchema)({
    repo: work.repo,
    issue: work.issue,
    placement: work.placement,
    text: { title: "t", body: "b", comments: [] },
    ...vmOptions(work)
  })
  assert.deepEqual(vmOptions(input), options)
  assert.deepEqual(vmOptions(work), options)
  assert.deepEqual(vmOptions(remote), options)
  for (const field of Object.keys(options)) {
    for (const invalid of [0, -1, 1.5]) {
      assert.throws(() => Schema.decodeUnknownSync(Input)({ repo: "o/r", ...options, [field]: invalid }))
    }
  }
})

test("placement leases admit all VM agent slots, then cloud, and release idempotently", () => {
  const slots = makePlacementSlots()
  const input = { repo: "o/r", placement: "vm" as const, maxAgents: 8, agentsPerVm: 3, maxVms: 2, cloudAgents: 1 }
  const local = Array.from({ length: 6 }, () => slots.reserve(input, minFreeBytes))
  for (const lease of local) assert.equal(lease?.placement, "vm")
  const cloud = slots.reserve(input, minFreeBytes)
  assert.equal(cloud?.placement, "cloud")
  assert.equal(slots.reserve(input, minFreeBytes), undefined)
  local[0]!.release()
  local[0]!.release()
  assert.equal(slots.reserve(input, minFreeBytes)?.placement, "vm")
  assert.equal(slots.reserve(input, minFreeBytes), undefined)
  cloud!.release()
  assert.equal(slots.reserve(input, minFreeBytes, "cloud")?.placement, "cloud")
})

// Triage spends agents only on code changes, so bugs and fresh activity go first.
test("bugs, regressions, severities and failing titles come first, then the newest activity", () => {
  const issue = (number: number, title: string, labels: ReadonlyArray<string>, updatedAt?: string) => ({
    number,
    title,
    labels,
    ...(updatedAt === undefined ? {} : { updatedAt })
  })
  const order = [
    issue(1, "Add a docs page", [], "2026-10-01T12:00:00Z"),
    issue(2, "Old report", ["bug"], "2026-09-01T00:00:00Z"),
    issue(3, "CI red on main", [], "2026-09-30T00:00:00Z"),
    issue(4, "Refactor the planner", [], "2026-10-01T13:00:00Z"),
    issue(5, "Sign-in", ["severity:high"], "2026-10-01T00:00:00Z"),
    issue(6, "No timestamp", []),
    issue(7, "Tie broken by number", ["regression"], "2026-10-01T00:00:00Z")
  ].toSorted(byPriority).map((found) => found.number)
  assert.deepEqual(order, [5, 7, 3, 2, 4, 1, 6])
})

test("urgency reads labels and whole words of the title", () => {
  for (
    const title of [
      "Tests fail on Linux",
      "flow test failing",
      "Failure to boot",
      "CI red",
      "Broken link",
      "Crash on start",
      "crashes",
      "Errors in the log",
      "error: x"
    ]
  ) {
    assert.equal(urgent({ title, labels: [] }), true, title)
  }
  for (const title of ["Required fields", "Reduce allocations", "Failover for the proxy", "Shared cache", "Terror"]) {
    assert.equal(urgent({ title, labels: [] }), false, title)
  }
  for (const label of ["bug", "regression", "severity:low", "severity:high"]) {
    assert.equal(urgent({ title: "x", labels: [label] }), true, label)
  }
  assert.equal(urgent({ title: "x", labels: ["enhancement", "documentation", "in-progress"] }), false)
})

// Measurement: the fraction of claimed issues that produced a change.
test("round stats count claimed issues and those whose agent produced a change", () => {
  const row = (status: "landed" | "held" | "failed" | "skipped" | "requeued", detail: string) => ({
    id: String(Math.random()),
    status,
    detail
  })
  assert.deepEqual(
    roundStats([
      row("landed", "abc by codex codex-1"),
      row("failed", "land: conflict in a.ts"),
      row("failed", "work: codex-2 on issue-9: no change: needs a deploy"),
      row("failed", "work: claude-1 on x: no change: y; verdict not recorded: rate limited"),
      row("failed", "work: agent exited 1"),
      row("failed", "claim: issue-claim claim: exit 1"),
      row("held", "Claimed by someone"),
      row("skipped", "triage: operator: asks for a deploy (confidence 0.90)"),
      row("skipped", "select failed: triage: invalid_answer: no choice"),
      row("skipped", "no change; waiting on a human"),
      row("requeued", "work: interrupted")
    ]),
    { claimed: 5, changed: 2, noChange: 2, triaged: 1 }
  )
  assert.deepEqual(roundStats([]), { claimed: 0, changed: 0, noChange: 0, triaged: 0 })
})

test("issue selector accepts positive integers and rejects invalid input", () => {
  assert.equal(Schema.decodeUnknownSync(Input)({ repo: "o/r" }).issue, undefined)
  for (const issue of [1, 3399]) {
    assert.equal(Schema.decodeUnknownSync(Input)({ repo: "o/r", issue }).issue, issue)
  }
  for (const issue of [0, -1, 1.5, "3399", null, Infinity, NaN]) {
    assert.throws(() => Schema.decodeUnknownSync(Input)({ repo: "o/r", issue }))
  }
})

test("discovery narrows selected open issue after preserving all open workspaces", async () => {
  const rows = [
    { number: 1, title: "later", labels: [] },
    { number: 2, title: "urgent", labels: ["priority:p0"] }
  ]
  const events: string[] = []
  const discover = makeIssueDiscovery({
    open: (repo) =>
      Effect.sync(() => {
        events.push(`open:${repo}`)
        return rows
      }),
    reap: (open) =>
      Effect.sync(() => {
        events.push(`reap:${[...open].join(",")}`)
        assert.deepEqual(staleWorkspaces(["issue-1", "issue-2", "issue-3"], open), [3])
      })
  })
  const selected = await Effect.runPromise(discover({ repo: "o/r", issue: 1 }))
  assert.deepEqual(selected, [{ id: "1", ...rows[0] }])
  assert.deepEqual(events, ["open:o/r", "reap:1,2"])
  for (const issue of [3, 999]) {
    assert.deepEqual(await Effect.runPromise(discover({ repo: "o/r", issue })), [])
  }
  const all = await Effect.runPromise(discover({ repo: "o/r" }))
  assert.deepEqual(all.map((row) => row.number).toSorted(), [1, 2])
  assert.deepEqual(all, rows.map((row) => ({ id: String(row.number), ...row })).toSorted(byPriority))
})
