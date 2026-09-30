import { NodeCrypto } from "@effect/platform-node"
import { Action, FlowRuntime, Graph, Interpreter, Sleep } from "@smthrs/flow"
import * as Seat from "@smthrs/agent/Seat"
import { Effect, Layer } from "effect"
import { layerWired } from "../../packages/smithers/flows/flow/test/MemoryFlowRuntime.ts"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import Monitor from "../burndown/monitor/flow.ts"
import { captureEvidence, inspectRun, layer as hostLayer, reportRun } from "../burndown/monitor/host.ts"
import { Diagnose, Inspect, Loop, Report } from "../burndown/monitor/loop.ts"

// A real executable fixture exercises cwd, argv, exit status and timeout at
// the monitor's subprocess boundary without requiring a running host database.
test("inspectRun reads the selected host and preserves failed inspections", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-monitor-")))
  const bin = join(root, "bin")
  const host = join(root, "host")
  const originalPath = process.env.PATH
  const routingKeys = ["SMITHERS_REMOTE", "SMITHERS_TOKEN", "SMITHERS_BACKEND", "DATABASE_URL"]
  const originalRouting = routingKeys.map((key) => [key, process.env[key]] as const)
  await mkdir(bin)
  await mkdir(host)
  const executable = join(bin, "smthrs")
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
if (![ ['runs','show','watched-run','--json','--root',process.cwd()], ['runs','list','--limit','40','--json','--root',process.cwd()] ].some(expected => JSON.stringify(args) === JSON.stringify(expected))) {
  process.stderr.write('wrong inspection argv'); process.exit(23)
}
if (['SMITHERS_REMOTE','SMITHERS_TOKEN','SMITHERS_BACKEND','DATABASE_URL'].some(key => process.env[key] !== undefined)) process.exit(24)
const response = JSON.parse(fs.readFileSync('response.json', 'utf8'))
if (response.wait) { setTimeout(() => {}, 60000) }
else { process.stdout.write(response.stdout || ''); process.stderr.write(response.stderr || ''); process.exit(response.code || 0) }
`
  )
  await chmod(executable, 0o755)
  const pgrep = join(bin, "pgrep")
  await writeFile(
    pgrep,
    `#!${process.execPath}
const fs = require('node:fs')
if (['SMITHERS_REMOTE','SMITHERS_TOKEN','SMITHERS_BACKEND','DATABASE_URL'].some(key => process.env[key] !== undefined)) process.exit(24)
const response = JSON.parse(fs.readFileSync('response.json', 'utf8'))
process.stdout.write(response.stdout || '')
process.exit(response.code || 0)
`
  )
  await chmod(pgrep, 0o755)
  await writeFile(join(bin, "osascript"), "#!/bin/sh\nexit 0\n")
  await chmod(join(bin, "osascript"), 0o755)
  process.env.PATH = `${bin}:${originalPath ?? ""}`
  for (const key of routingKeys) process.env[key] = "fixture-routing-value"
  const response = async (value: object) => writeFile(join(host, "response.json"), JSON.stringify(value))
  const run = () => inspectRun("watched-run", host)
  try {
    for (const status of ["accepted", "running", "parked", "waiting-approval"]) {
      await response({ stdout: JSON.stringify({ runId: "watched-run", status }) })
      const result = await run()
      assert.equal(result.state, "live", status)
      assert.equal(result.healthy, true, status)
      assert.match(result.evidence, new RegExp(status))
    }
    for (const status of ["completed", "failed", "cancelled"]) {
      await response({ stdout: JSON.stringify({ runId: "watched-run", status }) })
      const result = await run()
      assert.equal(result.state, "terminal", status)
      assert.equal(result.healthy, status === "completed", status)
      assert.match(result.evidence, new RegExp(status))
    }
    await response({ stdout: JSON.stringify({ _tag: "runs", items: [{ runId: "watched-run", status: "running" }] }) })
    assert.equal((await run()).state, "live")
    for (
      const stdout of [
        "",
        "not JSON",
        "null",
        "[]",
        "{}",
        JSON.stringify({ runId: "other-run", status: "running" }),
        JSON.stringify({ runId: "watched-run", status: "future-status" }),
        JSON.stringify({ _tag: "runs", items: [] }),
        JSON.stringify({ _tag: "runs", items: {} }),
        JSON.stringify({ _tag: "runs", items: [{ runId: "other-run", status: "running" }] })
      ]
    ) {
      await response({ stdout })
      const result = await run()
      assert.equal(result.state, "unknown", stdout)
      assert.equal(result.healthy, false, stdout)
      assert.match(result.evidence, /failed|invalid|unknown|missing|mismatch/i)
    }
    await response({
      stdout: "{\"runId\":\"watched-run\",\"status\":\"completed\"}",
      stderr: "host database unavailable",
      code: 4
    })
    const failed = await run()
    assert.equal(failed.state, "unknown")
    assert.match(failed.evidence, /failed/i)
    assert.ok(!failed.evidence.includes("host database unavailable"), "raw subprocess diagnostics may contain secrets")
    assert.equal((await inspectRun("watched-run", join(root, "missing"), 1000)).state, "unknown")
    await response({ stdout: JSON.stringify({ runId: "watched-run", status: "running" }) })
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 2_147_483_648]) {
      const started = Date.now()
      const invalidTimeout = await inspectRun("watched-run", host, timeoutMs)
      assert.equal(invalidTimeout.state, "unknown", `unsafe timeout ${timeoutMs} must be rejected`)
      assert.equal(invalidTimeout.healthy, false)
      assert.ok(Date.now() - started < 1000, "unsafe timeout must fail promptly")
    }
    await response({ wait: true })
    const started = Date.now()
    const timedOut = await inspectRun("watched-run", host, 100)
    assert.equal(timedOut.state, "unknown")
    assert.match(timedOut.evidence, /timeout|timed out|killed|failed/i)
    assert.ok(Date.now() - started < 3000, "hung CLI must be bounded")
    const reportRoot = join(root, "reports")
    for (
      const [status, inspectedHealthy, verdictHealthy, keepWatching, label] of [
        ["running", true, true, true, "HEALTHY"],
        ["running", false, true, true, "UNHEALTHY"],
        ["running", true, false, true, "UNHEALTHY"],
        ["failed", true, true, false, "UNHEALTHY"],
        ["cancelled", true, true, false, "UNHEALTHY"],
        ["completed", true, true, false, "HEALTHY"],
        ["unknown", true, true, true, "UNHEALTHY"]
      ] as const
    ) {
      await response({ stdout: JSON.stringify({ runId: "watched-run", status }) })
      assert.equal(
        await reportRun({
          runId: "watched-run",
          hostRoot: host,
          reportRoot,
          inspectedHealthy,
          verdict: { healthy: verdictHealthy, findings: ["fixture finding"], actions: ["fixture action"] }
        }),
        keepWatching,
        status
      )
      const lines = (await readFile(join(reportRoot, "monitor.log"), "utf8")).trim().split("\n")
      assert.match(lines.at(-1)!, new RegExp(`watched-run ${label} `))
      assert.match(lines.at(-1)!, /fixture finding => fixture action/)
      if (status === "unknown") assert.match(lines.at(-1)!, /Run inspection unknown/)
    }
    await response({ stdout: JSON.stringify({ runId: "watched-run", status: "running" }) })
    const noisyReportRoot = join(root, "noisy-reports")
    const reportPayload = {
      runId: "watched-run\nforged HEALTHY\r\u001b",
      hostRoot: host,
      reportRoot: noisyReportRoot,
      inspectedHealthy: true,
      verdict: { healthy: true, findings: ["finding\nforged HEALTHY\r\u001b"], actions: ["action\t\nnext"] }
    }
    await reportRun(reportPayload)
    const log = await readFile(join(noisyReportRoot, "monitor.log"), "utf8")
    assert.equal(log.trim().split("\n").length, 1, "one report must append exactly one line")
    assert.ok(
      !["\r", "\u001b", "\t"].some((character) => log.includes(character)),
      "control characters must not forge log records"
    )
    const reportFile = join(root, "report-file")
    await writeFile(reportFile, "existing file")
    await assert.rejects(reportRun({ ...reportPayload, reportRoot: reportFile }))
    await response({ code: 1 })
    assert.deepEqual(await captureEvidence("dispatchers", "pgrep", ["-fl", "dispatch.py"], host), { failed: false, evidence: "## dispatchers\n(none)" })
    await response({ code: 2 })
    assert.deepEqual(await captureEvidence("dispatchers", "pgrep", ["-fl", "dispatch.py"], host), { failed: true, evidence: "## dispatchers (failed)\nInspection failed or timed out." })
    await response({ stdout: "123 fixture dispatcher" })
    assert.deepEqual(
      await captureEvidence("dispatchers", "pgrep", ["-fl", "dispatch.py"], host),
      { failed: false, evidence: "## dispatchers\n123 fixture dispatcher" }
    )
    await response({ stdout: JSON.stringify({ runId: "watched-run", status: "running", note: "historic (failed) evidence" }) })
    const handlers = new Map<string, (input: unknown) => { execute: Effect.Effect<unknown, unknown> }>()
    const runtime = {
      register: (declared: { _tag: string }, handler: never) => Effect.sync(() => handlers.set(declared._tag, handler))
    }
    const snapshot = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* Layer.build((hostLayer as Layer.Layer<never, never, Action.Implementations | FlowRuntime.FlowRuntime>).pipe(Layer.provide([
        Action.layerImplementations,
        Layer.succeed(FlowRuntime.FlowRuntime, runtime as never)
      ])))
      const handler = handlers.get(Inspect.name)!
      return yield* handler({ runId: "watched-run", hostRoot: host, reportRoot }).execute.pipe(
        Effect.provideService(FlowRuntime.FlowInstance, { executionId: "monitor-evidence-test" } as never)
      )
    }))) as { healthy: boolean; evidence: string }
    assert.equal(snapshot.healthy, true, "literal failure text in successful evidence must not mark inspection unhealthy")
    assert.match(snapshot.evidence, /historic \(failed\) evidence/)
    await response({ stdout: "123 fixture dispatcher (failed)" })
    assert.deepEqual(await captureEvidence("dispatchers", "pgrep", [], host), { failed: false, evidence: "## dispatchers\n123 fixture dispatcher (failed)" })
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    for (const [key, value] of originalRouting) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("monitor plans retain stable callback identities", () => {
  const payload = {
    runId: "watched-run",
    hostRoot: "/watched/host",
    reportRoot: "/watched/reports",
    seat: "claude-code:sonnet",
    everyMinutes: 1
  }
  for (const flow of [Monitor, Loop]) {
    const first = Graph.build(flow, payload, { callbackIdentity: "stable" })
    assert.deepEqual(first.diagnostics, [])
    assert.doesNotThrow(() => Graph.drafts(first))
    assert.deepEqual(Graph.drafts(first), Graph.drafts(Graph.build(flow, payload, { callbackIdentity: "stable" })))
    assert.notDeepEqual(
      Graph.drafts(first),
      Graph.drafts(Graph.build(flow, { ...payload, hostRoot: "/different/host" }, { callbackIdentity: "stable" }))
    )
  }
})

// Typed action failures are injected at their public boundary so both recovery
// branches run deterministically without spending a live model subscription.
for (const failure of ["inspection", "diagnosis"] as const) {
  test(`monitor ${failure} failure reports unhealthy and continues to the next round`, async () => {
    const events: string[] = []
    const reports: Array<typeof Report.payloadSchema.Type> = []
    let inspections = 0
    const layers = layerWired(Layer.mergeAll(
      Inspect.toLayer(() => Effect.suspend(() => {
        events.push("inspect")
        inspections++
        return inspections === 1 && failure === "inspection"
          ? Effect.fail("private inspection error")
          : Effect.succeed({ healthy: true, now: 0, evidence: "running" })
      }), { implementationVersion: Inspect.implementationVersion }),
      Diagnose.toLayer(({ snapshot }) => Effect.suspend(() => {
        if (inspections === 1 && failure === "inspection") {
          assert.equal(snapshot.healthy, false)
          assert.equal(snapshot.evidence, "Monitor inspection failed")
        }
        events.push("diagnose")
        return inspections === 1 && failure === "diagnosis"
          ? Effect.fail(new Seat.SeatUnresolved({ seat: "fixture", message: "private provider error" }))
          : Effect.succeed({ healthy: true, findings: [], actions: [] })
      })),
      Report.toLayer((payload) => Effect.sync(() => {
        events.push("report")
        reports.push(payload)
        return reports.length === 1
      }), { implementationVersion: Report.implementationVersion }),
      Sleep.action.toLayer(({ millis }) => Effect.sync(() => {
        assert.equal(millis, 60_000)
        events.push("sleep")
      })),
      Interpreter.layer(Loop)
    ))
    const input = {
      runId: "watched-run", hostRoot: "/watched/host", reportRoot: "/watched/reports",
      seat: "fixture", everyMinutes: 1
    }
    const result = await Effect.runPromise(Effect.gen(function*() {
      const next = yield* Loop.execute(input, { executionId: "monitor-first-round" })
      assert.equal(typeof next, "object")
      assert.equal((next as { _tag: string })._tag, "Handoff")
      assert.equal(reports.length, 1, "unhealthy round must report before handing off")
      assert.ok(events.includes("sleep"), "next round must wait for its scheduled interval")
      return yield* Loop.execute((next as { payload: typeof input }).payload, { executionId: "monitor-next-round" })
    }).pipe(Effect.provide(layers.pipe(Layer.provideMerge(NodeCrypto.layer)))))
    assert.equal(result, "burndown run watched-run settled")
    assert.equal(reports.length, 2)
    if (failure === "diagnosis") {
      assert.deepEqual(reports[0]!.verdict, {
        healthy: false, findings: ["Monitor diagnosis failed"], actions: ["Retry diagnosis on the next round"]
      })
    }
    assert.equal(reports[0]!.inspectedHealthy && reports[0]!.verdict.healthy, false)
    assert.equal(reports[1]!.inspectedHealthy && reports[1]!.verdict.healthy, true)
    assert.ok(!JSON.stringify(reports).includes("private"), "error diagnostics must not leak to reports")
    assert.deepEqual(events.filter((event) => event !== "diagnose"), ["inspect", "report", "sleep", "inspect", "report"])
  })
}
