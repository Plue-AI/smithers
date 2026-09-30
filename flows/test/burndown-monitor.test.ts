import { NodeCrypto } from "@effect/platform-node"
import * as Seat from "@smthrs/agent/Seat"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Graph, Interpreter, Sleep } from "@smthrs/flow"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Jj } from "@smthrs/kernel"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Context, Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { layerWired } from "../../packages/smithers/flows/flow/test/MemoryFlowRuntime.ts"
import Burndown from "../burndown/flow.ts"
import Monitor from "../burndown/monitor/flow.ts"
import {
  captureEvidence,
  inspectProgress,
  inspectRun,
  layer as hostLayer,
  reportRun
} from "../burndown/monitor/host.ts"
import { Diagnose, Inspect, Loop, Report } from "../burndown/monitor/loop.ts"
import { Pace } from "../burndown/pace.ts"
import { Land, Launch, Observe, Round, Settle } from "../burndown/round.ts"

// Native read-only inspection fixture; legacy mutating readers are trapped.
const nativeFixture = `
const emit=(text)=>{
  const args=process.argv.slice(2)
  if(['show','devtools'].includes(args[1])) {fs.writeFileSync('forbidden-mutation','invoked');process.exit(31)}
  const expected=args[1]==='inspect'?['runs','inspect',args[2],'--json','--root',process.cwd()]:['runs','logs',args[2],'--limit','10000','--json','--root',process.cwd()]
  if(JSON.stringify(args)!==JSON.stringify(expected))process.exit(23)
  let data;try{data=JSON.parse(text)}catch{process.stdout.write(text);return}
  if(args[1]==='inspect') {
    if(data && typeof data.runId==='string') process.stdout.write(JSON.stringify({position:{runId:data.runId,frame:{seq:1}},status:data.status,host:data.host,executionFlow:data.flowId,waiting:data.waitingReason}))
    else process.stdout.write(text)
  }else if(data && Array.isArray(data.inspection?.frames)){
    const rows=Object.fromEntries(data.inspection.frames.map((f,i)=>[String(i),{sequence:f.sequence,kind:f.kind,runId:data.runId,occurredAt:f.at,payload:f.payload}]))
    if(data.inspection.frameCount!==data.inspection.frames.length) {for(let i=Object.keys(rows).length;i<10000;i++)rows[String(i)]={sequence:i,kind:"control.notice",runId:data.runId,occurredAt:1,payload:{}}}
    process.stdout.write(JSON.stringify(data.numeric ? {...rows,cta:{commands:[]}} : Object.values(rows)))
  }else process.stdout.write(text)
}
`

// A real executable fixture exercises cwd, argv, exit status and timeout at
// the monitor's subprocess boundary without requiring a running host database.
test("inspectRun reads the selected host and preserves failed inspections", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-monitor-")))
  const bin = join(root, "bin")
  const host = join(root, "host")
  const originalPath = process.env.PATH
  const routingKeys = [
    "SMITHERS_REMOTE",
    "SMITHERS_TOKEN",
    "SMITHERS_BACKEND",
    "DATABASE_URL",
    "SMITHERS_POSTGRES_URL",
    "NODE_OPTIONS",
    "NODE_PATH",
    "AWS_SECRET_ACCESS_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY"
  ]
  const originalRouting = routingKeys.map((key) => [key, process.env[key]] as const)
  await mkdir(bin)
  await mkdir(host)
  await mkdir(join(host, "packages/smithers/bin"), { recursive: true })
  const executable = join(host, "packages/smithers/bin/smithers.mjs")
  await writeFile(
    executable,
    `import fs from 'node:fs'
${nativeFixture}
const args = process.argv.slice(2)
if (![ ['runs','inspect','watched-run','--json','--root',process.cwd()], ['runs','logs','watched-run','--limit','10000','--json','--root',process.cwd()] ].some(expected => JSON.stringify(args) === JSON.stringify(expected))) {
  process.stderr.write('wrong inspection argv'); process.exit(23)
}
if (['SMITHERS_REMOTE','SMITHERS_TOKEN','SMITHERS_BACKEND','DATABASE_URL','SMITHERS_POSTGRES_URL','NODE_OPTIONS','NODE_PATH','AWS_SECRET_ACCESS_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY'].some(key => process.env[key] !== undefined)) process.exit(24)
const fixture = JSON.parse(fs.readFileSync('response.json', 'utf8'))
const response = fixture[args[1]] || fixture
if(args[1]==='logs' && !fixture.logs) {
  let status='running';try{status=JSON.parse(fixture.stdout).status}catch{}
  const frame={sequence:1,at:1,kind:'control.engine.event',payload:{executionId:'watched-run',generation:0,eventType:'flows.engine.run-decision',payload:{executionFact:{observation:{executionId:'watched-run',flowName:'burndown/round',status}}}}}
  emit(JSON.stringify({runId:'watched-run',status:'running',nodes:[{id:'run',kind:'run',status:'running',label:'root',startedAt:1}],inspection:{frames:[frame,{sequence:2,at:1,kind:'control.engine.event',payload:{executionId:'watched-run',generation:0,eventType:'flows.engine.node-settled',payload:{action:'burndown/land',nodeId:'land',outcome:'built',result:{preview:JSON.stringify({done:status==='completed',landed:0}),truncated:false}}}}],frameCount:2}}));process.exit(0)
}
if (response.wait) { setTimeout(() => {}, 60000) }
else { emit(response.stdout || ''); process.stderr.write(response.stderr || ''); process.exit(response.code || 0) }
`
  )
  await writeFile(
    join(bin, "smthrs"),
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${
      JSON.stringify(join(root, "poison-invoked"))
    }, 'invoked\\n'); process.exit(29)\n`
  )
  await chmod(join(bin, "smthrs"), 0o755)
  const poisonedNodeMarker = join(root, "poison-node-invoked")
  await writeFile(
    join(bin, "node"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${
      JSON.stringify(poisonedNodeMarker)
    }, 'invoked'); process.exit(30)\n`
  )
  await chmod(join(bin, "node"), 0o755)
  const pgrep = join(bin, "pgrep")
  await writeFile(
    pgrep,
    `#!${process.execPath}
const fs = require('node:fs')
if (['SMITHERS_REMOTE','SMITHERS_TOKEN','SMITHERS_BACKEND','DATABASE_URL','SMITHERS_POSTGRES_URL','NODE_OPTIONS','NODE_PATH','AWS_SECRET_ACCESS_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY'].some(key => process.env[key] !== undefined)) process.exit(24)
const fixture = JSON.parse(fs.readFileSync('response.json', 'utf8'))
const response = fixture.pgrep || fixture
process.stdout.write(response.stdout || '')
process.exit(response.code || 0)
`
  )
  await chmod(pgrep, 0o755)
  await writeFile(
    join(bin, "osascript"),
    `#!${process.execPath}
if (['AWS_SECRET_ACCESS_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY'].some(key=>process.env[key]!==undefined)) {require('node:fs').writeFileSync(${
      JSON.stringify(join(root, "notification-secret"))
    },'leaked');process.exit(24)}
process.exit(0)
`
  )
  await chmod(join(bin, "osascript"), 0o755)
  process.env.PATH = `${bin}:${originalPath ?? ""}`
  for (const key of routingKeys) process.env[key] = "fixture-routing-value"
  const response = async (value: object) => writeFile(join(host, "response.json"), JSON.stringify(value))
  const run = () => inspectRun("watched-run", host)
  try {
    const secondHost = join(root, "second-host")
    await mkdir(join(secondHost, "packages/smithers/bin"), { recursive: true })
    await writeFile(
      join(secondHost, "packages/smithers/bin/smithers.mjs"),
      `import fs from 'node:fs'
${nativeFixture}
const expected = ['runs','inspect','watched-run','--json','--root',process.cwd()]
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(23)
emit(fs.readFileSync('response.json','utf8'))
`
    )
    await writeFile(
      join(secondHost, "response.json"),
      JSON.stringify({ runId: "watched-run", status: "failed", host: "second-host" })
    )
    await response({ stdout: JSON.stringify({ runId: "watched-run", status: "running", host: "first-host" }) })
    const firstResult = await run()
    assert.equal(firstResult.state, "live", "poisoned PATH must not override the watched CLI")
    assert.match(firstResult.evidence, /first-host/)
    const hostAlias = join(root, "host-alias")
    await symlink(host, hostAlias)
    const aliasResult = await inspectRun("watched-run", hostAlias)
    assert.equal(aliasResult.state, "live", "symlinked watched root must resolve its pinned CLI")
    assert.equal(aliasResult.healthy, true)
    assert.match(aliasResult.evidence, /first-host/)
    assert.equal(
      (await inspectProgress("watched-run", hostAlias)).healthy,
      true,
      "symlinked host must use canonical cwd and --root for native run logs"
    )
    await assert.rejects(
      readFile(poisonedNodeMarker),
      { code: "ENOENT" },
      "inspection must use absolute process.execPath instead of PATH node"
    )
    const secondResult = await inspectRun("watched-run", secondHost)
    assert.equal(secondResult.state, "terminal")
    assert.equal(secondResult.healthy, false)
    assert.match(secondResult.evidence, /second-host/, "distinct watched roots must read their own stores")
    assert.equal((await inspectProgress("watched-run", host)).healthy, true)
    await assert.rejects(
      readFile(join(host, "forbidden-mutation")),
      { code: "ENOENT" },
      "observer must never invoke store-mutating show/devtools"
    )
    const noCliHost = join(root, "no-cli-host")
    await mkdir(noCliHost)
    assert.equal((await inspectRun("watched-run", noCliHost)).state, "unknown")
    assert.equal((await inspectProgress("watched-run", noCliHost)).healthy, false)
    const missingReportRoot = join(root, "missing-cli-reports")
    assert.equal(
      await reportRun({
        runId: "watched-run",
        hostRoot: noCliHost,
        reportRoot: missingReportRoot,
        inspectedHealthy: true,
        verdict: { healthy: true, findings: [], actions: [] }
      }),
      true,
      "missing watched CLI must continue monitoring"
    )
    assert.match(
      await readFile(join(missingReportRoot, "monitor.log"), "utf8"),
      /watched-run UNHEALTHY Run inspection unknown/
    )
    const escapingHost = join(root, "escaping-host")
    await mkdir(join(escapingHost, "packages/smithers/bin"), { recursive: true })
    const escapedMarker = join(root, "escaped-invoked")
    const escapedCli = join(root, "escaped.mjs")
    await writeFile(
      escapedCli,
      `import fs from 'node:fs'; fs.writeFileSync(${
        JSON.stringify(escapedMarker)
      }, 'invoked'); console.log(JSON.stringify({runId:'watched-run',status:'running'}))`
    )
    await symlink(escapedCli, join(escapingHost, "packages/smithers/bin/smithers.mjs"))
    assert.equal(
      (await inspectRun("watched-run", escapingHost)).state,
      "unknown",
      "CLI symlink must not escape the watched root"
    )
    assert.equal((await inspectProgress("watched-run", escapingHost)).healthy, false)
    await assert.rejects(readFile(escapedMarker), { code: "ENOENT" }, "escaping CLI must never execute")
    await assert.rejects(
      readFile(join(root, "poison-invoked")),
      { code: "ENOENT" },
      "global CLI must never execute, including when pinned CLI is missing"
    )
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
    await response({
      stdout: JSON.stringify({ position: { runId: "watched-run", frame: { seq: 1 } }, status: "running" })
    })
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
      stdout: JSON.stringify({
        runId: "watched-run",
        status: "running",
        host: "h".repeat(2000),
        flowId: "f".repeat(2000),
        waitingReason: "w".repeat(2000),
        diagnosis: { turns: 0, private: "DO-NOT-RETAIN" },
        updatedAt: 1
      })
    })
    const bounded = await run()
    assert.equal(bounded.healthy, true)
    assert.ok(bounded.evidence.length <= 2000, "selected metadata must be bounded independently of subprocess output")
    assert.ok(!bounded.evidence.includes("diagnosis"))
    assert.ok(!bounded.evidence.includes("updatedAt"))
    assert.ok(!bounded.evidence.includes("DO-NOT-RETAIN"))
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
    assert.deepEqual(
      log.split(" ").slice(1, 3),
      ["watched-run_forged_HEALTHY", "UNHEALTHY"],
      "the run identity must remain one log field even when it contains whitespace"
    )
    assert.ok(
      !["\r", "\u001b", "\t"].some((character) => log.includes(character)),
      "control characters must not forge log records"
    )
    await assert.rejects(
      readFile(join(root, "notification-secret")),
      { code: "ENOENT" },
      "notification subprocess must clear provider credentials"
    )
    const reportFile = join(root, "report-file")
    await writeFile(reportFile, "existing file")
    await assert.rejects(reportRun({ ...reportPayload, reportRoot: reportFile }))
    await response({ code: 1 })
    assert.deepEqual(await captureEvidence("dispatchers", ["-fl", "dispatch.py"], host), {
      failed: false,
      evidence: "## dispatchers\n(none)"
    })
    await response({ code: 2 })
    assert.deepEqual(await captureEvidence("dispatchers", ["-fl", "dispatch.py"], host), {
      failed: true,
      evidence: "## dispatchers (failed)\nInspection failed or timed out."
    })
    await response({ stdout: "123 fixture dispatcher" })
    assert.deepEqual(
      await captureEvidence("dispatchers", ["-fl", "dispatch.py"], host),
      { failed: false, evidence: "## dispatchers\n123 fixture dispatcher" }
    )
    await response({
      stdout: JSON.stringify({ runId: "watched-run", status: "running", note: "historic (failed) evidence" })
    })
    const handlers = new Map<string, (input: unknown) => { execute: Effect.Effect<unknown, unknown> }>()
    const runtime = {
      register: (declared: { _tag: string }, handler: never) => Effect.sync(() => handlers.set(declared._tag, handler))
    }
    const getSnapshot = () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        yield* Layer.build(
          (hostLayer as Layer.Layer<never, never, Action.Implementations | FlowRuntime.FlowRuntime>).pipe(
            Layer.provide([
              Action.layerImplementations,
              Layer.succeed(FlowRuntime.FlowRuntime, runtime as never)
            ])
          )
        )
        const handler = handlers.get(Inspect.name)!
        return yield* handler({ runId: "watched-run", hostRoot: host, reportRoot }).execute.pipe(
          Effect.provideService(FlowRuntime.FlowInstance, { executionId: "monitor-evidence-test" } as never)
        )
      }))) as Promise<{ healthy: boolean; evidence: string }>
    await writeFile(join(reportRoot, "status.txt"), "historic (failed) evidence")
    const snapshot = await getSnapshot()
    assert.equal(
      snapshot.healthy,
      true,
      "literal failure text in successful evidence must not mark inspection unhealthy"
    )
    assert.match(snapshot.evidence, /historic \(failed\) evidence/)
    await writeFile(join(reportRoot, "status.txt"), "historic (failed) receipt")
    assert.equal((await getSnapshot()).healthy, true, "status text is evidence, not a failure flag")
    for (const command of ["logs", "pgrep"]) {
      await response({
        stdout: JSON.stringify({ runId: "watched-run", status: "running" }),
        [command]: { code: 2 }
      })
      const failedSnapshot = await getSnapshot()
      assert.equal(failedSnapshot.healthy, false, `${command} failure must be unhealthy`)
      assert.match(failedSnapshot.evidence, /Inspection failed(?: or timed out|, missing or incomplete)/)
    }
    await response({ stdout: "123 fixture dispatcher (failed)" })
    assert.deepEqual(await captureEvidence("dispatchers", [], host), {
      failed: false,
      evidence: "## dispatchers\n123 fixture dispatcher (failed)"
    })
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
    const events: Array<string> = []
    const reports: Array<typeof Report.payloadSchema.Type> = []
    let inspections = 0
    const layers = layerWired(Layer.mergeAll(
      Inspect.toLayer(() =>
        Effect.suspend(() => {
          events.push("inspect")
          inspections++
          return inspections === 1 && failure === "inspection"
            ? Effect.fail("private inspection error")
            : Effect.succeed({ healthy: true, now: 0, evidence: "running" })
        }), { implementationVersion: Inspect.implementationVersion }),
      Diagnose.toLayer(({ snapshot }) =>
        Effect.suspend(() => {
          if (inspections === 1 && failure === "inspection") {
            assert.equal(snapshot.healthy, false)
            assert.equal(snapshot.evidence, "Monitor inspection failed")
          }
          events.push("diagnose")
          return inspections === 1 && failure === "diagnosis"
            ? Effect.fail(new Seat.SeatUnresolved({ seat: "fixture", message: "private provider error" }))
            : Effect.succeed({ healthy: true, findings: [], actions: [] })
        })
      ),
      Report.toLayer((payload) =>
        Effect.sync(() => {
          events.push("report")
          reports.push(payload)
          return reports.length === 1
        }), { implementationVersion: Report.implementationVersion }),
      Sleep.action.toLayer(({ millis }) =>
        Effect.sync(() => {
          assert.equal(millis, 60_000)
          events.push("sleep")
        })
      ),
      Interpreter.layer(Loop)
    ))
    const input = {
      runId: "watched-run",
      hostRoot: "/watched/host",
      reportRoot: "/watched/reports",
      seat: "fixture",
      everyMinutes: 1
    }
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const next = yield* Loop.execute(input, { executionId: "monitor-first-round" })
        assert.equal(typeof next, "object")
        assert.equal((next as unknown as { _tag: string })._tag, "Handoff")
        assert.deepEqual(
          (next as unknown as { payload: typeof input }).payload,
          input,
          "next round preserves watched run and host"
        )
        assert.equal(reports.length, 1, "unhealthy round must report before handing off")
        assert.ok(events.includes("sleep"), "next round must wait for its scheduled interval")
        return yield* Loop.execute((next as unknown as { payload: typeof input }).payload, {
          executionId: "monitor-next-round"
        })
      }).pipe(Effect.provide(layers.pipe(Layer.provideMerge(NodeCrypto.layer))))
    )
    assert.equal(result, "burndown run watched-run settled")
    assert.equal(reports.length, 2)
    if (failure === "diagnosis") {
      assert.deepEqual(reports[0]!.verdict, {
        healthy: false,
        findings: ["Monitor diagnosis failed"],
        actions: ["Retry diagnosis on the next round"]
      })
    }
    assert.equal(reports[0]!.inspectedHealthy && reports[0]!.verdict.healthy, false)
    assert.equal(reports[1]!.inspectedHealthy && reports[1]!.verdict.healthy, true)
    assert.ok(!JSON.stringify(reports).includes("private"), "error diagnostics must not leak to reports")
    assert.deepEqual(events.filter((event) => event !== "diagnose"), [
      "inspect",
      "report",
      "sleep",
      "inspect",
      "report"
    ])
  })
}

test("monitor public handoff resolves host and report roots and pins the default seat", async () => {
  const currentHost = process.cwd()
  for (
    const [configuration, hostRoot, reportRoot] of [
      [{}, currentHost, join(currentHost, ".smithers", "burndown")],
      [{ hostRoot: "watched" }, resolve(currentHost, "watched"), resolve(currentHost, "watched/.smithers/burndown")],
      [{ hostRoot: "/watched/host" }, "/watched/host", "/watched/host/.smithers/burndown"],
      [{ hostRoot: "watched", reportRoot: "reports" }, resolve(currentHost, "watched"), resolve(currentHost, "reports")]
    ] as const
  ) {
    const result = await Effect.runPromise(
      Monitor.execute({ runId: "watched-run", ...configuration }, {
        executionId: `monitor-roots-${JSON.stringify(configuration)}`
      }).pipe(Effect.provide(
        layerWired(Interpreter.layer(Monitor, { callbackIdentity: "stable" })).pipe(
          Layer.provideMerge(NodeCrypto.layer)
        )
      ))
    )
    assert.equal(typeof result, "object")
    assert.equal((result as unknown as { _tag: string })._tag, "Handoff")
    assert.deepEqual((result as unknown as { payload: unknown }).payload, {
      runId: "watched-run",
      hostRoot,
      reportRoot,
      seat: "claude-code:sonnet",
      everyMinutes: 10
    })
  }
})

test("both monitor entry points require an explicit operator launch", () => {
  assert.equal(Context.get(Monitor.annotations, Flow.ModelInvocable), false)
  assert.equal(Context.get(Loop.annotations, Flow.ModelInvocable), false)
})

test("inspectRun rejects option-shaped and malformed identities before launching a process", async () => {
  for (const runId of ["--root", "-h", "", "watched run", "watched\nrun", "watched\u001brun"]) {
    assert.deepEqual(await inspectRun(runId, "/missing-monitor-fixture-host"), {
      state: "unknown",
      healthy: false,
      evidence: "## run (unknown)\nInvalid run identity."
    }, `invalid identity ${JSON.stringify(runId)} must fail before inspecting the host`)
  }
})

for (const [name, flow] of [["Monitor", Monitor], ["Loop", Loop]] as const) {
  test(`${name} rejects unsafe intervals and run identities before inspection or diagnosis`, async () => {
    const events: Array<string> = []
    const layers = layerWired(Layer.mergeAll(
      Inspect.toLayer(() =>
        Effect.sync(() => {
          events.push("inspect")
          return { healthy: true, now: 0, evidence: "running" }
        }), { implementationVersion: Inspect.implementationVersion }),
      Diagnose.toLayer(() =>
        Effect.sync(() => {
          events.push("diagnose")
          return { healthy: true, findings: [], actions: [] }
        })
      ),
      Report.toLayer(() =>
        Effect.sync(() => {
          events.push("report")
          return false
        }), { implementationVersion: Report.implementationVersion }),
      Sleep.action.toLayer(() =>
        Effect.sync(() => {
          events.push("sleep")
        })
      ),
      name === "Monitor" ? Interpreter.layer(Monitor) : Interpreter.layer(Loop)
    )).pipe(Layer.provideMerge(NodeCrypto.layer))
    const payload = { runId: "watched-run", hostRoot: "/watched/host", reportRoot: "/watched/reports", seat: "fixture" }
    for (
      const [index, everyMinutes] of [
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER / 60_000 + 1
      ].entries()
    ) {
      await assert.rejects(
        Effect.runPromise(
          flow.execute({ ...payload, everyMinutes }, {
            executionId: `${name}-invalid-interval-${index}`
          }).pipe(Effect.provide(layers))
        ),
        `unsafe interval ${everyMinutes} must be rejected`
      )
      assert.deepEqual(events, [], "invalid intervals must not inspect, diagnose, report or sleep")
    }
    for (const [index, runId] of ["", "--root", "-h", "watched run", "watched\nrun", "watched\u001brun"].entries()) {
      await assert.rejects(
        Effect.runPromise(
          flow.execute({ ...payload, runId, everyMinutes: 1 }, {
            executionId: `${name}-invalid-run-identity-${index}`
          }).pipe(Effect.provide(layers))
        ),
        `invalid run identity ${JSON.stringify(runId)} must be rejected`
      )
      assert.deepEqual(events, [], "invalid run identities must not inspect, diagnose, report or sleep")
    }
  })
}

test("monitor accepts a fractional positive interval and sleeps for its duration", async () => {
  const sleeps: Array<number> = []
  const layers = layerWired(Layer.mergeAll(
    Inspect.toLayer(() => Effect.succeed({ healthy: true, now: 0, evidence: "running" }), {
      implementationVersion: Inspect.implementationVersion
    }),
    Diagnose.toLayer(() => Effect.succeed({ healthy: true, findings: [], actions: [] })),
    Report.toLayer(() => Effect.succeed(true), { implementationVersion: Report.implementationVersion }),
    Sleep.action.toLayer(({ millis }) =>
      Effect.sync(() => {
        assert.ok(millis !== undefined, "fractional intervals supply a millisecond duration")
        sleeps.push(millis)
      })
    ),
    Interpreter.layer(Loop)
  )).pipe(Layer.provideMerge(NodeCrypto.layer))
  const result = await Effect.runPromise(
    Loop.execute({
      runId: "watched-run",
      hostRoot: "/watched/host",
      reportRoot: "/watched/reports",
      seat: "fixture",
      everyMinutes: 0.5
    }, { executionId: "monitor-fractional-interval" }).pipe(Effect.provide(layers))
  )
  assert.deepEqual(sleeps, [30_000])
  assert.equal((result as unknown as { _tag: string })._tag, "Handoff")
  assert.equal((result as unknown as { payload: { everyMinutes: number } }).payload.everyMinutes, 0.5)
})

// The executable fixture is the public inspection boundary; two independent
// stores deliberately return different action progress for the same identity.
test("inspectProgress grounds long checks in selected-host durable actions", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-progress-")))
  try {
    for (const [name, outcome] of [["first", undefined], ["second", "built"]] as const) {
      const host = join(root, name)
      await mkdir(join(host, "packages/smithers/bin"), { recursive: true })
      await writeFile(
        join(host, "packages/smithers/bin/smithers.mjs"),
        `import fs from 'node:fs'
${nativeFixture}
emit(fs.readFileSync('response.json','utf8'))
`
      )
      const frames = [
        {
          sequence: 1,
          at: 1,
          kind: "control.engine.event",
          payload: {
            executionId: "watched-run",
            generation: 0,
            eventType: "flows.engine.run-decision",
            payload: {
              executionFact: {
                observation: {
                  executionId: "watched-run",
                  flowName: "burndown/round",
                  roundOrdinal: 22,
                  status: "running"
                }
              }
            }
          }
        },
        {
          sequence: 2,
          at: 1,
          kind: "control.engine.event",
          payload: {
            executionId: "watched-run",
            generation: 0,
            eventType: "flows.engine.node-scheduled",
            payload: { action: "burndown/land", nodeId: "check", kind: "action" }
          }
        },
        ...(outcome === undefined ? [] : [{
          sequence: 3,
          at: 2,
          kind: "control.engine.event",
          payload: {
            executionId: "watched-run",
            generation: 0,
            eventType: "flows.engine.node-settled",
            payload: {
              action: "burndown/land",
              nodeId: "check",
              outcome,
              result: {
                preview: JSON.stringify({ landed: 1, quarantined: 2, ready: 3, secret: "DO-NOT-RETAIN" }),
                truncated: false
              }
            }
          }
        }])
      ]
      await writeFile(
        join(host, "response.json"),
        JSON.stringify({
          runId: "watched-run",
          status: "running",
          numeric: name === "second",
          diagnosis: { turns: 0 },
          updatedAt: 1,
          nodes: [{ id: "run", kind: "run", status: "running", label: "root", startedAt: 1 }, {
            id: "attempt",
            kind: "attempt",
            status: outcome === undefined ? "running" : "completed",
            label: "check",
            startedAt: 1
          }],
          inspection: { frameCount: frames.length, frames }
        })
      )
    }
    const running = await inspectProgress("watched-run", join(root, "first"))
    assert.equal(running.healthy, true, "an old active durable action is a long check, not a stalled wrapper")
    const runningSummary = JSON.parse(running.evidence.slice(running.evidence.indexOf("\n") + 1))
    assert.equal(runningSummary.actions[0].action, "burndown/land")
    assert.equal(runningSummary.actions[0].status, "running")
    assert.ok(!/diagnosis|updatedAt/.test(running.evidence))
    assert.match(running.evidence, /"roundOrdinal":22/)
    assert.ok(!running.evidence.includes("DO-NOT-RETAIN"))
    const settled = await inspectProgress("watched-run", join(root, "second"))
    assert.equal(settled.healthy, false, "quarantined changes require attention")
    const settledSummary = JSON.parse(settled.evidence.slice(settled.evidence.indexOf("\n") + 1))
    assert.equal(settledSummary.actions[0].status, "completed")
    assert.equal(settledSummary.receipts[0].landed, 1)
    assert.equal(settledSummary.receipts[0].quarantined, 2)
    assert.equal(settledSummary.receipts[0].ready, 3)
    assert.ok(!settled.evidence.includes("DO-NOT-RETAIN"))
    assert.ok(settled.evidence.length <= 24000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("inspectProgress fails closed on missing, mismatched and partial durable evidence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-progress-invalid-")))
  try {
    await mkdir(join(root, "packages/smithers/bin"), { recursive: true })
    await writeFile(
      join(root, "packages/smithers/bin/smithers.mjs"),
      `import fs from 'node:fs'
${nativeFixture}
const fixture=JSON.parse(fs.readFileSync('response.json','utf8'))
if(fixture.wait)setTimeout(()=>{},60000)
else {emit(fixture.stdout||'');process.stderr.write('private-token');process.exit(fixture.code||0)}
`
    )
    const frame = {
      sequence: 1,
      at: 1,
      kind: "control.engine.event",
      payload: {
        executionId: "watched-run",
        generation: 0,
        eventType: "flows.engine.run-decision",
        payload: {
          executionFact: { observation: { executionId: "watched-run", flowName: "burndown/round", status: "running" } }
        }
      }
    }
    const valid = { runId: "watched-run", status: "running", nodes: [], inspection: { frameCount: 1, frames: [frame] } }
    for (
      const value of [
        null,
        {},
        { ...valid, runId: "other-run" },
        { ...valid, inspection: { frameCount: 2, frames: [frame] } },
        { ...valid, inspection: { frameCount: 0, frames: [] } },
        {
          ...valid,
          inspection: {
            frameCount: 1,
            frames: [{ sequence: 1, at: 1, kind: "control.agent.turn-opened", payload: {} }]
          }
        },
        {
          ...valid,
          inspection: {
            frameCount: 1,
            frames: [{
              ...frame,
              payload: {
                ...frame.payload,
                executionId: "unrelated-run",
                payload: {
                  executionFact: {
                    observation: { executionId: "unrelated-run", flowName: "unrelated", status: "running" }
                  }
                }
              }
            }]
          }
        }
      ]
    ) {
      await writeFile(join(root, "response.json"), JSON.stringify({ stdout: JSON.stringify(value) }))
      const result = await inspectProgress("watched-run", root)
      assert.equal(result.healthy, false, JSON.stringify(value))
      assert.ok(!result.evidence.includes("private-token"))
      assert.ok(!result.evidence.includes("unrelated-run"))
    }
    for (const fixture of [{ stdout: "not JSON" }, { stdout: JSON.stringify(valid), code: 2 }, { wait: true }]) {
      await writeFile(join(root, "response.json"), JSON.stringify(fixture))
      const started = Date.now()
      const result = await inspectProgress("watched-run", root, 100)
      assert.equal(result.healthy, false)
      assert.ok(Date.now() - started < 3000, "hung progress inspection must be bounded")
      assert.ok(!result.evidence.includes("private-token"))
    }
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 2_147_483_648]) {
      assert.equal((await inspectProgress("watched-run", root, timeoutMs)).healthy, false)
    }
    for (const runId of ["--root", "", "wrong run"]) assert.equal((await inspectProgress(runId, root)).healthy, false)
    assert.equal((await inspectProgress("watched-run", join(root, "missing"))).healthy, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("inspectProgress retains selected worker exports and check failures without private payloads", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-progress-worker-")))
  try {
    await mkdir(join(root, "packages/smithers/bin"), { recursive: true })
    await writeFile(
      join(root, "packages/smithers/bin/smithers.mjs"),
      `import fs from 'node:fs';${nativeFixture}
emit(fs.readFileSync('response.json','utf8'))`
    )
    let sequence = 0
    const event = (executionId: string, eventType: string, payload: object) => ({
      sequence: ++sequence,
      at: sequence,
      kind: "control.engine.event",
      payload: { executionId, generation: 0, eventType, payload }
    })
    const frames = [
      event("watched-run", "flows.engine.run-decision", {
        executionFact: { observation: { executionId: "watched-run", flowName: "burndown/root", status: "running" } }
      }),
      event("worker", "flows.engine.run-decision", {
        executionFact: {
          observation: {
            executionId: "worker",
            parentRunId: "watched-run",
            flowName: "burndown/worker",
            status: "completed"
          }
        }
      }),
      event("worker", "flows.engine.node-settled", {
        action: "burndown/run-agent",
        nodeId: "export",
        outcome: "built",
        result: {
          preview: JSON.stringify({
            status: "ready",
            commits: [{ issue: 2948, commit: "a".repeat(40) }],
            token: "DO-NOT-RETAIN"
          }),
          truncated: false
        }
      }),
      event("watched-run", "flows.engine.node-settled", {
        action: "burndown/land",
        nodeId: "check",
        outcome: "failed",
        error: "DO-NOT-RETAIN"
      }),
      event("stranger", "flows.engine.run-decision", {
        executionFact: { observation: { executionId: "stranger", flowName: "UNRELATED-SECRET", status: "failed" } }
      })
    ]
    await writeFile(
      join(root, "response.json"),
      JSON.stringify({
        runId: "watched-run",
        status: "running",
        nodes: [{ id: "run", kind: "run", status: "running", label: "root", startedAt: 1 }],
        inspection: { frameCount: frames.length, frames }
      })
    )
    const result = await inspectProgress("watched-run", root)
    assert.equal(result.healthy, false, "a failed selected check must remain unhealthy")
    const summary = JSON.parse(result.evidence.slice(result.evidence.indexOf("\n") + 1))
    assert.ok(summary.executions.some((row: { flow: string }) => row.flow === "burndown/worker"))
    assert.equal(summary.receipts[0].status, "ready")
    assert.equal(summary.receipts[0].commits, 1)
    assert.deepEqual(summary.receipts[0].commitIds, ["a".repeat(40)])
    assert.ok(
      summary.actions.some((row: { action: string; status: string }) =>
        row.action === "burndown/land" && row.status === "failed"
      )
    )
    assert.ok(!result.evidence.includes("DO-NOT-RETAIN"))
    assert.ok(!result.evidence.includes("UNRELATED-SECRET"))
    assert.ok(!result.evidence.includes("stranger"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Each case goes through a real pinned executable. Engine events are synthetic
// because the observer must remain read-only while live hosts keep running.
test("inspectProgress evaluates the current handoff frontier and typed outcomes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-frontier-")))
  const runId = "run-22"
  const child = "a".repeat(40)
  const grandchild = "b".repeat(40)
  let sequence = 0
  const event = (executionId: string, eventType: string, payload: object) => ({
    sequence: ++sequence,
    at: Date.now(),
    kind: "control.engine.event",
    payload: { executionId, generation: 0, eventType, payload }
  })
  const decision = (executionId: string, roundOrdinal: number, parentRunId?: string, extra: object = {}) =>
    event(executionId, "flows.engine.run-decision", {
      executionFact: {
        observation: {
          executionId,
          lineageId: "c".repeat(40),
          flowName: "burndown/round",
          status: "running",
          roundOrdinal,
          ...(parentRunId ? { parentRunId } : {}),
          ...extra
        }
      },
      state: { payload: { options: { tickMinutes: 1 } } }
    })
  const settled = (
    executionId: string,
    outcome: string,
    value: unknown = {},
    action = "burndown/land",
    truncated = false
  ) =>
    event(executionId, "flows.engine.node-settled", {
      nodeId: "land",
      action,
      outcome,
      ...(value === undefined ? {} : { result: { preview: JSON.stringify(value), truncated } })
    })
  const inspect = async (frames: Array<object>) => {
    await writeFile(
      join(root, "response.json"),
      JSON.stringify({ runId, status: "running", nodes: [], inspection: { frameCount: frames.length, frames } })
    )
    const result = await inspectProgress(runId, root)
    const body = result.evidence.slice(result.evidence.indexOf("\n") + 1)
    return { ...result, summary: body.startsWith("{") ? JSON.parse(body) : undefined }
  }
  try {
    await mkdir(join(root, "packages/smithers/bin"), { recursive: true })
    await writeFile(
      join(root, "packages/smithers/bin/smithers.mjs"),
      `import fs from 'node:fs';${nativeFixture}
emit(fs.readFileSync('response.json','utf8'))`
    )
    const history: Array<object> = []
    let parent = runId
    for (let round = 0; round < 80; round++) {
      const id = round === 0 ? runId : round.toString(16).padStart(40, "0")
      history.push(
        decision(id, round, round === 0 ? undefined : parent),
        settled(id, "failed", { quarantined: 1 }, "burndown/land", true)
      )
      parent = id
    }
    history.push(
      decision(child, 80, parent),
      decision(grandchild, 80, child, { flowName: "burndown/worker" }),
      event(grandchild, "flows.engine.node-scheduled", {
        nodeId: "worker",
        action: "burndown/run-agent",
        kind: "action"
      })
    )
    const frontier = await inspect(history)
    assert.equal(frontier.healthy, true, "old failures and truncated receipts must not poison the current grandchild")
    assert.equal(frontier.summary.partial, false)
    assert.ok(frontier.summary.executions.some((row: { executionId: string }) => row.executionId === grandchild))
    assert.ok(frontier.summary.executions.every((row: { roundOrdinal?: number }) => row.roundOrdinal === 80))
    for (
      const [outcome, healthy, status] of [
        ["built", true, "completed"],
        ["clean", true, "completed"],
        ["skipped", false, "skipped"],
        ["deferred", false, "pending"],
        ["unexpected", false, "unknown"]
      ] as const
    ) {
      const result = await inspect([decision(runId, 0), settled(runId, outcome, { landed: 0 })])
      assert.equal(result.healthy, healthy, outcome)
      assert.equal(result.summary.actions[0].status, status, outcome)
    }
    for (
      const value of [
        { next: { status: "blocked" } },
        { next: { quarantined: 1 } },
        { ready: [{ result: { status: "failed" } }] },
        { status: "limited" },
        { status: "unknown" }
      ]
    ) {
      assert.equal(
        (await inspect([decision(runId, 0), settled(runId, "built", value)])).healthy,
        false,
        JSON.stringify(value)
      )
    }
    for (const action of ["burndown/land", "burndown/observe", "burndown/settle"]) {
      // Explicitly omit result rather than using the helper's default argument.
      const missing = event(runId, "flows.engine.node-settled", { nodeId: "missing", action, outcome: "built" })
      const result = await inspect([decision(runId, 0), missing])
      assert.equal(result.healthy, false, action)
      assert.equal(result.summary.partial, true, action)
    }
    for (const value of [null, [], {}, "invalid"]) {
      const empty = await inspect([decision(runId, 0), settled(runId, "built", value)])
      assert.equal(empty.healthy, false, JSON.stringify(value))
      assert.equal(empty.summary.partial, true)
    }
    const truncated = await inspect([decision(runId, 0), settled(runId, "built", { landed: 1 }, "burndown/land", true)])
    assert.equal(truncated.healthy, false)
    assert.equal(truncated.summary.partial, true)
    for (const [wakeAt, healthy] of [[Date.now() + 60_000, true], [Date.now() - 180_000, false]] as const) {
      const result = await inspect([
        decision(runId, 0, undefined, { waiting: { reason: "timer", wakeAtMs: wakeAt } }),
        event(runId, "flows.engine.node-settled", { nodeId: "sleep", action: "system/sleep", outcome: "deferred" })
      ])
      assert.equal(result.healthy, healthy, `timer ${wakeAt}`)
      assert.equal(result.summary.actions[0].status, "pending")
    }
    const oversized = await inspect([
      decision(runId, 0),
      settled(runId, "built", {
        ready: Array.from({ length: 2000 }, () => ({ result: { commits: [{ commit: child }], status: "ready" } }))
      })
    ])
    assert.equal(oversized.healthy, false)
    assert.ok(oversized.evidence.length <= 24000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("monitor report failure waits and retries without claiming a receipt", async () => {
  const events: Array<string> = []
  let calls = 0
  const input = {
    runId: "run-22",
    hostRoot: "/watched/host",
    reportRoot: "/watched/reports",
    seat: "fixture",
    everyMinutes: 1
  }
  const layers = layerWired(Layer.mergeAll(
    Inspect.toLayer(() => Effect.succeed({ healthy: true, now: 0, evidence: "running" }), {
      implementationVersion: Inspect.implementationVersion
    }),
    Diagnose.toLayer(() => Effect.succeed({ healthy: true, findings: [], actions: [] })),
    Report.toLayer(() =>
      Effect.suspend(() => {
        calls++
        events.push(calls === 1 ? "report-failed" : "receipt-retained")
        return calls === 1 ? Effect.fail("private write error") : Effect.succeed(false)
      }), { implementationVersion: Report.implementationVersion }),
    Sleep.action.toLayer(() =>
      Effect.sync(() => {
        events.push("sleep")
      })
    ),
    Interpreter.layer(Loop)
  )).pipe(Layer.provideMerge(NodeCrypto.layer))
  const first = await Effect.runPromise(
    Loop.execute(input, { executionId: "report-retry-first" }).pipe(Effect.provide(layers))
  )
  assert.equal((first as unknown as { _tag: string })._tag, "Handoff")
  assert.deepEqual(events, ["report-failed", "sleep"], "no retained receipt exists until retry succeeds")
  const last = await Effect.runPromise(
    Loop.execute((first as unknown as { payload: typeof input }).payload, { executionId: "report-retry-second" }).pipe(
      Effect.provide(layers)
    )
  )
  assert.equal(last, "burndown run run-22 settled")
  assert.deepEqual(events, ["report-failed", "sleep", "receipt-retained"])
})

// Provider and issue/landing actions are mocked at their declared ports: this
// test drives the actual production interpreter and journal without writes to
// GitHub, the live queue, or a model subscription.
for (const large of [false, true]) {
  test(
    `inspectProgress reads a clean terminal Round from production interpreter journal${
      large ? " with truncated informational previews" : ""
    }`,
    { timeout: 120000 },
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-round-journal-")))
      const runId = "run-22"
      const state = {
        options: { repos: ["smithersai/smithers"], placement: "local" as const, maxAgents: 1, tickMinutes: 1 },
        round: 0,
        target: 1,
        inFlight: [],
        quarantined: [],
        ready: [],
        readings: large ? { large: "x".repeat(4096) } : {},
        rates: {},
        history: {},
        landed: 0
      }
      const observation = {
        now: Date.now(),
        target: 1,
        candidates: [],
        openIssues: 0,
        inFlight: [],
        finished: [],
        capacity: [],
        exhausted: true,
        earliestReset: null,
        pending: false,
        readings: large ? { large: "x".repeat(4096) } : {},
        rates: {}
      }
      try {
        const nodes = Graph.nodes(Graph.build(Round, state))
        const innerActions = nodes.filter((node) => node.ast._tag === "ActionCall").map((node) => ({
          id: node.id,
          action: node.ast._tag === "ActionCall" ? node.ast.action : undefined
        }))
        assert.ok(innerActions.some((node) => node.action === "burndown/land"))
        const jj = Layer.succeed(
          Jj.Jj,
          Jj.make({
            snapshot: () => Effect.succeed({ commitId: "fixture", changeId: "fixture" }),
            restore: () => Effect.void,
            diff: () => Effect.succeed(""),
            workspaceAdd: () => Effect.void,
            workspaceForget: () => Effect.void,
            status: () => Effect.succeed("")
          })
        )
        const entries = await Effect.runPromise(Effect.scoped(
          Effect.gen(function*() {
            const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
            const journal = Context.get(native, Journal.Journal)
            const engine = yield* EngineStore.make({
              owner: { hostId: "monitor-test" },
              journalSource: "monitor-test",
              isAlive: () => Effect.succeed(false)
            }).pipe(Effect.provide(native))
            const implementations = Layer.mergeAll(
              Observe.toLayer(() => Effect.succeed(observation), {
                implementationVersion: Observe.implementationVersion
              }),
              Launch.toLayer(() => Effect.succeed([]), { implementationVersion: Launch.implementationVersion }),
              Land.toLayer(() => Effect.succeed({ landed: [], quarantined: [] }), {
                implementationVersion: Land.implementationVersion
              }),
              Settle.toLayer(
                () => Effect.succeed({ done: true, wakeAt: Date.now(), next: state, summary: "settled" }),
                {
                  implementationVersion: Settle.implementationVersion
                }
              ),
              Pace.toLayer(() => Effect.succeed({ launches: [], nextTarget: 1, note: "fixture" })),
              Sleep.action.toLayer(() => Effect.void)
            )
            const layer = Layer.mergeAll(implementations, Interpreter.layer(Round)).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
            )
            const result = yield* Round.execute(state, { executionId: runId }).pipe(
              Effect.provide(layer),
              Effect.provide(native),
              Effect.timeout("20 seconds")
            )
            assert.equal(result, "settled")
            return (yield* journal.entries({ runId: runId as never, limit: 4000 })).entries
          }).pipe(Effect.provide(jj), Effect.provide(StepBoundary.layerTest()), Effect.provide(NodeCrypto.layer))
        ))
        const frames = entries.map((entry, index) => ({
          sequence: index + 1,
          at: Date.now(),
          kind: "control.engine.event",
          payload: { executionId: runId, generation: 0, eventType: entry.eventType, payload: entry.payload }
        }))
        assert.ok(frames.some((frame) => frame.payload.eventType === "flows.engine.node-settled"))
        assert.ok(
          frames.some((frame) =>
            frame.payload.eventType === "flows.engine.node-settled" &&
            (frame.payload.payload as { action?: string; outcome?: string }).action === "burndown/land" &&
            (frame.payload.payload as { outcome?: string }).outcome === "skipped"
          )
        )
        if (large) {
          for (const action of ["burndown/observe", "burndown/settle"]) {
            assert.ok(
              frames.some((frame) =>
                frame.payload.eventType === "flows.engine.node-settled" &&
                (frame.payload.payload as { action?: string; result?: { truncated?: boolean } }).action === action &&
                (frame.payload.payload as { result?: { truncated?: boolean } }).result?.truncated === true
              ),
              action
            )
          }
        }
        await writeFile(join(root, "interpreter-frames.json"), JSON.stringify(frames))
        await mkdir(join(root, "packages/smithers/bin"), { recursive: true })
        await writeFile(
          join(root, "packages/smithers/bin/smithers.mjs"),
          `import fs from 'node:fs';${nativeFixture}
emit(fs.readFileSync('response.json','utf8'))`
        )
        await writeFile(
          join(root, "response.json"),
          JSON.stringify({ runId, status: "completed", nodes: [], inspection: { frameCount: frames.length, frames } })
        )
        const result = await inspectProgress(runId, root)
        assert.equal(result.healthy, true, "clean Flow.done with untaken branch nodes must remain healthy")
        const summary = JSON.parse(result.evidence.slice(result.evidence.indexOf("\n") + 1))
        assert.ok(
          summary.actions.some((action: { action: string; status: string }) =>
            action.action === "burndown/land" && action.status === "completed"
          )
        )
        await writeFile(
          join(root, "response.json"),
          JSON.stringify({ runId, status: "running", nodes: [], inspection: { frameCount: frames.length, frames } })
        )
        const authoritative = await inspectProgress(runId, root)
        assert.equal(
          authoritative.healthy,
          true,
          "completed frontier with its own success receipt outranks stale native entry status"
        )
        assert.equal(authoritative.state, "terminal")
        assert.equal(authoritative.status, "completed")
        if (process.env.SMITHERS_MONITOR_TEST_RECEIPT) {
          await writeFile(
            process.env.SMITHERS_MONITOR_TEST_RECEIPT,
            JSON.stringify({ innerActions, frames }, null, 2)
          )
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
}

test("inspectProgress selects current referenced detached workers and stable frontier ties", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-detached-")))
  const runId = "run-22",
    first = "a".repeat(40),
    latest = "b".repeat(40),
    worker = "c".repeat(40),
    stranger = "d".repeat(40),
    launched = "f".repeat(40)
  let sequence = 0
  const event = (id: string, type: string, payload: object) => ({
    sequence: ++sequence,
    at: Date.now(),
    kind: "control.engine.event",
    payload: { executionId: id, generation: 0, eventType: type, payload }
  })
  const observation = (
    id: string,
    parent: string | undefined,
    createdAtMs: number,
    flowName = "burndown/round",
    parentPolicy = "cancel",
    inFlight: Array<object> = []
  ) =>
    event(id, "flows.engine.run-decision", {
      executionFact: {
        observation: {
          executionId: id,
          lineageId: "e".repeat(40),
          flowName,
          status: "running",
          roundOrdinal: 1,
          createdAtMs,
          parentPolicy,
          ...(parent ? { parentRunId: parent } : {})
        }
      },
      state: { payload: { inFlight } }
    })
  try {
    await mkdir(join(root, "packages/smithers/bin"), { recursive: true })
    await writeFile(
      join(root, "packages/smithers/bin/smithers.mjs"),
      `import fs from 'node:fs';${nativeFixture}
emit(fs.readFileSync('response.json','utf8'))`
    )
    const frames = [
      observation(runId, undefined, 1),
      observation(first, runId, 2),
      event(first, "flows.engine.node-settled", { nodeId: "land", action: "burndown/land", outcome: "failed" }),
      observation(latest, first, 3, "burndown/round", "cancel", [{ executionId: worker }]),
      observation(worker, latest, 4, "burndown/worker", "detach"),
      observation(stranger, latest, 5, "burndown/worker", "detach"),
      event(latest, "flows.engine.node-scheduled", { nodeId: "launch", action: "burndown/launch", kind: "action" }),
      event(latest, "flows.engine.node-settled", {
        nodeId: "launch",
        action: "burndown/launch",
        outcome: "built",
        result: { preview: JSON.stringify([{ executionId: launched }]), truncated: false }
      }),
      observation(launched, latest, 6, "burndown/worker", "detach"),
      event(launched, "flows.engine.node-scheduled", { nodeId: "work", action: "burndown/run-agent" }),
      event(worker, "flows.engine.node-scheduled", { nodeId: "work", action: "burndown/run-agent" }),
      event(stranger, "flows.engine.node-settled", { nodeId: "work", action: "burndown/run-agent", outcome: "failed" })
    ]
    const inspect = async (frameCount: number) => {
      await writeFile(
        join(root, "response.json"),
        JSON.stringify({ runId, status: "running", nodes: [], inspection: { frameCount, frames } })
      )
      return await inspectProgress(runId, root)
    }
    const result = await inspect(frames.length)
    assert.equal(result.healthy, true)
    const summary = JSON.parse(result.evidence.slice(result.evidence.indexOf("\n") + 1))
    assert.equal(summary.frontier, latest, "equal roundOrdinal uses newest createdAtMs")
    assert.ok(summary.executions.some((row: { executionId: string }) => row.executionId === worker))
    assert.ok(
      summary.executions.some((row: { executionId: string }) => row.executionId === launched),
      "current Launch receipt authorizes detached new worker"
    )
    assert.ok(!summary.executions.some((row: { executionId: string }) => row.executionId === stranger))
    const partial = await inspect(frames.length + 10001)
    assert.equal(partial.healthy, false, "missing frame window remains fail closed")
    assert.equal(JSON.parse(partial.evidence.slice(partial.evidence.indexOf("\n") + 1)).partial, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("inspectProgress rejects cancelled receipts and clears superseded results on reschedule", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-reschedule-")))
  const runId = "run-22"
  let sequence = 0
  const event = (eventType: string, payload: object) => ({
    sequence: ++sequence,
    at: Date.now(),
    kind: "control.engine.event",
    payload: { executionId: runId, generation: 0, eventType, payload }
  })
  const decision = event("flows.engine.run-decision", {
    executionFact: {
      observation: { executionId: runId, flowName: "burndown/round", status: "running", roundOrdinal: 1 }
    },
    state: { payload: { quarantined: [], ready: [], inFlight: [], options: { tickMinutes: 1 } } }
  })
  const settle = (value: unknown, truncated = false) =>
    event("flows.engine.node-settled", {
      action: "burndown/land",
      nodeId: "land",
      outcome: "built",
      result: { preview: JSON.stringify(value), truncated }
    })
  try {
    await mkdir(join(root, "packages/smithers/bin"), { recursive: true })
    await writeFile(
      join(root, "packages/smithers/bin/smithers.mjs"),
      `import fs from 'node:fs';${nativeFixture}
emit(fs.readFileSync('response.json','utf8'))`
    )
    const inspect = async (frames: Array<object>) => {
      await writeFile(
        join(root, "response.json"),
        JSON.stringify({ runId, status: "running", nodes: [], inspection: { frameCount: frames.length, frames } })
      )
      const result = await inspectProgress(runId, root)
      return { ...result, summary: JSON.parse(result.evidence.slice(result.evidence.indexOf("\n") + 1)) }
    }
    assert.equal((await inspect([decision, settle({ status: "cancelled" })])).healthy, false)
    for (const old of [settle({ quarantined: 1 }), settle({ landed: 1 }, true)]) {
      const result = await inspect([
        decision,
        old,
        event("flows.engine.node-scheduled", { action: "burndown/land", nodeId: "land", kind: "action" })
      ])
      assert.equal(result.healthy, true, "new running attempt supersedes previous blocked or incomplete receipt")
      assert.equal(result.summary.partial, false)
      assert.equal(result.summary.actions[0].status, "running")
      assert.ok(!result.summary.receipts.some((row: { quarantined?: number }) => row.quarantined === 1))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test(
  "real pinned CLI logs returns its native streaming shape from an isolated seeded store",
  { timeout: 120000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-real-cli-")))
    const runId = "run-22"
    try {
      await mkdir(join(root, ".flows"), { recursive: true })
      // The seed is ownerless test admission; only this disposable database is
      // written. The CLI observes it through the production read-only layer.
      await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const native = yield* Layer.build(TestStores.layerAt(join(root, ".flows/control.db")))
          const journal = Context.get(native, Journal.Journal)
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: runId as never,
              sourceId: "fixture" as never,
              sourceSeq: 0 as never,
              eventType: "control.engine.event",
              payload: {
                executionId: runId,
                generation: 0,
                eventType: "flows.engine.node-scheduled",
                payload: { nodeId: "land", action: "burndown/land" }
              }
            })
          )
        }).pipe(Effect.provide(NodeCrypto.layer))
      ))
      const cliHome = join(root, "cli-home")
      await mkdir(cliHome)
      const executable = resolve("packages/smithers/bin/smithers.mjs")
      const { stdout } = await promisify(execFile)(process.execPath, [
        executable,
        "runs",
        "logs",
        runId,
        "--limit",
        "10000",
        "--json",
        "--root",
        root
      ], {
        timeout: 60000,
        maxBuffer: 8 << 20,
        env: {
          PATH: process.env.PATH,
          HOME: cliHome,
          TMPDIR: process.env.TMPDIR,
          SMITHERS_SKIP_UPDATE_CHECK: "1"
        }
      })
      const value = JSON.parse(stdout)
      const entries = Array.isArray(value)
        ? value
        : Object.entries(value).filter(([key]) => /^\d+$/.test(key)).map(([, row]) => row)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].runId, runId)
      assert.equal(entries[0].kind, "control.engine.event")
      assert.equal(entries[0].payload.eventType, "flows.engine.node-scheduled")
      if (process.env.SMITHERS_MONITOR_TEST_RECEIPT) {
        await writeFile(
          `${process.env.SMITHERS_MONITOR_TEST_RECEIPT}.cli.json`,
          JSON.stringify({ shape: Array.isArray(value) ? "array" : "numeric-object", value }, null, 2)
        )
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test(
  "production burndown handoff keeps monitoring the live frontier after root completes",
  { timeout: 120000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-root-handoff-")))
    const runId = "run-22"
    const jj = Layer.succeed(
      Jj.Jj,
      Jj.make({
        snapshot: () => Effect.succeed({ commitId: "fixture", changeId: "fixture" }),
        restore: () => Effect.void,
        diff: () => Effect.succeed(""),
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void,
        status: () => Effect.succeed("")
      })
    )
    try {
      const captured = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const native = yield* Layer.build(TestStores.layerAt(":memory:"))
          const runs = Context.get(native, RunStore.RunStore)
          const journal = Context.get(native, Journal.Journal)
          const engine = yield* EngineStore.make({
            owner: { hostId: "handoff-test" },
            journalSource: "handoff-test",
            isAlive: () => Effect.succeed(false)
          }).pipe(Effect.provide(native))
          // External observation intentionally remains unresolved while the real
          // engine hands the product entry flow to its first round.
          const layer = Layer.mergeAll(
            Interpreter.layer(Burndown),
            Interpreter.layer(Round),
            Observe.toLayer(() => Effect.never, { implementationVersion: Observe.implementationVersion }),
            Launch.toLayer(() => Effect.succeed([]), { implementationVersion: Launch.implementationVersion }),
            Land.toLayer(() => Effect.succeed({ landed: [], quarantined: [] }), {
              implementationVersion: Land.implementationVersion
            }),
            Settle.toLayer(() => Effect.never, { implementationVersion: Settle.implementationVersion }),
            Pace.toLayer(() => Effect.never),
            Sleep.action.toLayer(() => Effect.void)
          ).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
          )
          yield* Burndown.execute({ repos: ["smithersai/smithers"] }, { executionId: runId }).pipe(
            Effect.provide(layer),
            Effect.provide(native),
            Effect.forkChild
          )
          const latest = yield* Effect.gen(function*() {
            for (let i = 0; i < 200; i++) {
              const row = yield* runs.latestRound(runId).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (row && row.runId !== runId && row.status === "running") return row
              yield* Effect.sleep("10 millis")
            }
            return yield* Effect.fail("handoff frontier not observed")
          }).pipe(Effect.timeout("20 seconds"))
          const original = yield* runs.get(runId)
          assert.equal(original.status, "completed")
          const entries = [
            ...(yield* journal.entries({ runId: runId as never, limit: 4000 })).entries,
            ...(yield* journal.entries({ runId: latest.runId as never, limit: 4000 })).entries
          ]
          return { rootStatus: original.status, frontier: latest.runId, entries }
        }).pipe(Effect.provide(jj), Effect.provide(StepBoundary.layerTest()), Effect.provide(NodeCrypto.layer))
      ))
      const frames = captured.entries.map((entry, index) => ({
        sequence: index + 1,
        at: Date.now(),
        kind: "control.engine.event",
        payload: { executionId: entry.runId, generation: 0, eventType: entry.eventType, payload: entry.payload }
      }))
      await mkdir(join(root, "packages/smithers/bin"), { recursive: true })
      await writeFile(
        join(root, "packages/smithers/bin/smithers.mjs"),
        `import fs from 'node:fs';${nativeFixture};emit(fs.readFileSync('response.json','utf8'))`
      )
      await writeFile(
        join(root, "response.json"),
        JSON.stringify({ runId, status: captured.rootStatus, inspection: { frameCount: frames.length, frames } })
      )
      assert.equal((await inspectRun(runId, root)).state, "terminal", "native exact-row status really completed")
      const live = await inspectProgress(runId, root)
      assert.equal(live.state, "live")
      assert.equal(live.healthy, true, "actual long Observe remains live after completed entry handoff")
      assert.equal(
        await reportRun({
          runId,
          hostRoot: root,
          reportRoot: join(root, "reports"),
          inspectedHealthy: true,
          verdict: { healthy: true, findings: [], actions: [] }
        }),
        true,
        "live frontier must keep watching a completed entry row"
      )
      for (const status of ["failed", "cancelled"]) {
        const terminal = [...frames, {
          sequence: frames.length + 1,
          at: Date.now(),
          kind: "control.engine.event",
          payload: {
            executionId: captured.frontier,
            generation: 0,
            eventType: "flows.engine.run-decision",
            payload: {
              executionFact: {
                observation: {
                  executionId: captured.frontier,
                  parentRunId: runId,
                  flowName: "burndown/round",
                  roundOrdinal: 1,
                  status
                }
              }
            }
          }
        }]
        await writeFile(
          join(root, "response.json"),
          JSON.stringify({ runId, status: "completed", inspection: { frameCount: terminal.length, frames: terminal } })
        )
        const progress = await inspectProgress(runId, root)
        assert.equal(progress.healthy, false, status)
        assert.equal(
          await reportRun({
            runId,
            hostRoot: root,
            reportRoot: join(root, "reports"),
            inspectedHealthy: true,
            verdict: { healthy: true, findings: [], actions: [] }
          }),
          false,
          status
        )
        assert.match(await readFile(join(root, "reports/monitor.log"), "utf8"), /UNHEALTHY/)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test("inspectProgress authorizes large Launch windows and refuses selected projection gaps", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-large-launch-")))
  const runId = "run-22", now = Date.now()
  let sequence = 0
  const event = (id: string, type: string, payload: object, at = now) => ({
    sequence: ++sequence,
    at,
    kind: "control.engine.event",
    payload: { executionId: id, generation: 0, eventType: type, payload }
  })
  const observation = (id: string, parentRunId?: string, createdAtMs = now) =>
    event(id, "flows.engine.run-decision", {
      executionFact: {
        observation: {
          executionId: id,
          flowName: parentRunId ? "burndown/worker" : "burndown/round",
          status: "running",
          roundOrdinal: 1,
          parentPolicy: parentRunId ? "detach" : "cancel",
          createdAtMs,
          ...(parentRunId ? { parentRunId } : {})
        }
      },
      state: { payload: { inFlight: [], quarantined: [], ready: [], options: { tickMinutes: 1 } } }
    })
  const gap = (id: string) => ({
    sequence: ++sequence,
    at: now,
    kind: "control.engine.projection-gap",
    payload: { executionId: id, reason: "compacted", error: "DO-NOT-RETAIN" }
  })
  const workers = Array.from({ length: 8 }, (_, i) => ({
    executionId: (i + 10).toString(16).padStart(40, "0"),
    startedAt: now,
    assignment: {
      key: `smithers-issue-${i}`,
      repo: "smithersai/smithers",
      lead: {
        repo: "smithersai/smithers",
        n: 2948 + i,
        title: "A realistic title requiring durable implementation and behavioral validation"
      },
      extras: [],
      account: "codex-test",
      tool: "codex",
      model: "gpt-6.1-sol",
      attempt: 1,
      placement: "cloud"
    }
  }))
  assert.ok(JSON.stringify(workers).length > 2048)
  try {
    await mkdir(join(root, "packages/smithers/bin"), { recursive: true })
    await writeFile(
      join(root, "packages/smithers/bin/smithers.mjs"),
      `import fs from 'node:fs';${nativeFixture};emit(fs.readFileSync('response.json','utf8'))`
    )
    const inspect = async (frames: Array<object>) => {
      await writeFile(
        join(root, "response.json"),
        JSON.stringify({ runId, status: "completed", inspection: { frameCount: frames.length, frames } })
      )
      return await inspectProgress(runId, root)
    }
    const launch = [
      observation(runId),
      event(
        runId,
        "flows.engine.node-scheduled",
        { nodeId: "launch", action: "burndown/launch", kind: "action" },
        now - 100
      ),
      event(runId, "flows.engine.node-settled", {
        nodeId: "launch",
        action: "burndown/launch",
        outcome: "built",
        result: { preview: JSON.stringify(workers).slice(0, 2048), truncated: true }
      }, now + 100),
      ...workers.flatMap(
        (worker) => [
          observation(worker.executionId, runId, now),
          event(worker.executionId, "flows.engine.node-scheduled", {
            nodeId: "work",
            action: "burndown/run-agent",
            kind: "action"
          })
        ]
      )
    ]
    const healthy = await inspect(launch)
    assert.equal(healthy.state, "live")
    assert.equal(
      healthy.healthy,
      true,
      "eight real-sized Launch assignments cannot invalidate native selected children"
    )
    const summary = JSON.parse(healthy.evidence.slice(healthy.evidence.indexOf("\n") + 1))
    assert.equal(summary.executions.length, 9)
    for (const id of [runId, workers[0]!.executionId]) {
      const result = await inspect([...launch, gap(id)])
      assert.equal(result.state, "unknown", id)
      assert.equal(result.healthy, false, id)
      assert.ok(!result.evidence.includes("DO-NOT-RETAIN"))
      const rescheduled = await inspect([
        ...launch,
        gap(id),
        event(runId, "flows.engine.node-scheduled", { nodeId: "launch", action: "burndown/launch", kind: "action" })
      ])
      assert.equal(rescheduled.state, "unknown", "rescheduling cannot erase explicit projection loss")
    }
    assert.equal(
      (await inspect([...launch, observation("f".repeat(40), "e".repeat(40), now), gap("f".repeat(40))])).healthy,
      true,
      "unrelated execution gap cannot poison selected work"
    )
    const absent = "e".repeat(40)
    const referenced = event(runId, "flows.engine.run-decision", {
      executionFact: {
        observation: { executionId: runId, flowName: "burndown/round", status: "running", roundOrdinal: 1 }
      },
      state: {
        payload: { inFlight: [{ executionId: absent }], quarantined: [], ready: [], options: { tickMinutes: 1 } }
      }
    })
    const checking = event(runId, "flows.engine.node-scheduled", {
      nodeId: "land",
      action: "burndown/land",
      kind: "action"
    })
    for (const frames of [[referenced, checking], [referenced, checking, gap(absent)], [...launch, gap(absent)]]) {
      const missing = await inspect(frames)
      assert.equal(
        missing.state,
        "unknown",
        "unobserved referenced or possible truncated-Launch worker cannot disappear"
      )
      assert.equal(missing.healthy, false)
    }
    const missingWindow = await inspect(
      launch.filter((frame) =>
        !("payload" in frame && frame.payload.executionId === runId &&
          frame.payload.eventType === "flows.engine.node-scheduled")
      )
    )
    assert.equal(missingWindow.healthy, false, "truncated Launch without native scheduled window fails closed")
    const oldWorker = "1".repeat(40), newWorker = "2".repeat(40)
    const scheduled = (at: number) =>
      event(runId, "flows.engine.node-scheduled", { nodeId: "retry", action: "burndown/launch", kind: "action" }, at)
    const retryResult = event(runId, "flows.engine.node-settled", {
      nodeId: "retry",
      action: "burndown/launch",
      outcome: "built",
      result: { preview: "[", truncated: true }
    }, now + 400)
    const retry = await inspect([
      observation(runId),
      scheduled(now),
      observation(oldWorker, runId, now + 100),
      event(
        oldWorker,
        "flows.engine.node-settled",
        { nodeId: "work", action: "burndown/run-agent", outcome: "failed" },
        now + 100
      ),
      scheduled(now + 200),
      observation(newWorker, runId, now + 300),
      event(newWorker, "flows.engine.node-scheduled", { nodeId: "work", action: "burndown/run-agent" }, now + 300),
      retryResult
    ])
    assert.equal(retry.healthy, false, "a worker spawned before retry cannot disappear with its failed check")
    const retrySummary = JSON.parse(retry.evidence.slice(retry.evidence.indexOf("\n") + 1))
    assert.ok(retrySummary.executions.some((row: { executionId: string }) => row.executionId === oldWorker))
    assert.ok(retrySummary.executions.some((row: { executionId: string }) => row.executionId === newWorker))
    const unknownTimestamp = scheduled(now + 200)
    const { at: _ignored, ...withoutTimestamp } = unknownTimestamp
    for (const secondSchedule of [scheduled(now + 200), withoutTimestamp]) {
      const idempotent = await inspect([
        observation(runId),
        scheduled(now),
        observation(oldWorker, runId, now + 100),
        event(oldWorker, "flows.engine.node-scheduled", { nodeId: "work", action: "burndown/run-agent" }, now + 100),
        secondSchedule,
        retryResult
      ])
      assert.equal(
        idempotent.healthy,
        true,
        "idempotent retry retains oldest valid launch time even if retry timing is absent"
      )
      assert.ok(
        JSON.parse(idempotent.evidence.slice(idempotent.evidence.indexOf("\n") + 1)).executions.some((
          row: { executionId: string }
        ) => row.executionId === oldWorker)
      )
    }
    const sixtyFour = Array.from({ length: 64 }, (_, i) => (i + 100).toString(16).padStart(40, "0"))
    const fleet = await inspect([
      observation(runId),
      event(
        runId,
        "flows.engine.node-scheduled",
        { nodeId: "launch", action: "burndown/launch", kind: "action" },
        now - 100
      ),
      event(runId, "flows.engine.node-settled", {
        nodeId: "launch",
        action: "burndown/launch",
        outcome: "built",
        result: { preview: "[", truncated: true }
      }, now + 100),
      ...sixtyFour.flatMap(
        (id) => [
          observation(id, runId, now),
          event(id, "flows.engine.node-scheduled", { nodeId: "work", action: "burndown/run-agent", kind: "action" })
        ]
      )
    ])
    assert.ok(fleet.evidence.length <= 24000, "default-scale evidence stays bounded")
    if (fleet.state === "unknown") assert.equal(fleet.healthy, false, "bound overflow stays explicitly unknown")
    else assert.equal(fleet.healthy, true, "all 64 active native workers remain healthy when summary fits")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
