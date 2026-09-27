/*
 * The end-to-end proof: this app's own gateway seam drives a run.
 *
 * The script stands up
 *
 *   - a real workspace gateway (`@smthrs/gateway` over a real SQLite control
 *     plane, journal, and run store) on a loopback port, behind a bearer
 *     credential;
 *   - the product Worker's relay, using the Worker's own frame adapter
 *     (`smithers-server/gatewayRpc`), which holds the credential the browser
 *     cannot;
 *   - this app's seam (`createGatewaySeam`), unmodified, pointed at the relay,
 *
 * and then does what a human does: list the flows, launch one, watch it,
 * approve the gate it parks on, read what a node produced, and cancel it.
 *
 * What is real and what is scripted. The gateway, the relay, the seam, the
 * control plane, and every mutation are real: each step below is an HTTP call
 * that crosses all three. The run's own ACTIVITY is scripted: only an agent
 * run parks on a permission gate, an agent run needs a provider credential
 * (`ANTHROPIC_API_KEY` or another seat), and a proof that skipped without one
 * would prove nothing in the environments this is run in. So the turn, the
 * cell call, and the gate are journaled here with the exact payloads
 * `@smthrs/agent` `AgentSession` writes: `{seat, contextDigest}`,
 * `{flowName, input}`, `{flowName, outcome, message, value}`, and the
 * approval `AgentSession.authorize` registers. A run the durable engine really
 * executes is proven separately, in `packages/smithers/gateway/test/RealEngineRun.test.ts`.
 *
 * The load-bearing assertion is the approval: ONE call decides the gate and
 * resumes the run. The relay counts every procedure it forwards, so a second
 * `Resume` would be visible here and fails the proof.
 *
 * And the plan: `Plan` answers with the keyed nodes the flow will run, which
 * is what the flow graph draws.
 *
 * Run it with: pnpm --filter smithers-app proof:gateway (tsx, not bun: the
 * script loads the workspace's TypeScript sources through tsx's loader).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import { Control } from "@smthrs/control/Control"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalTarget } from "@smthrs/control/ControlSchema"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import type { DurableFlow } from "@smthrs/control/SqlControlRuntime"
import { plannable } from "@smthrs/control/SystemFlows"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as GatewayProjections from "@smthrs/gateway/Projections"
import { Migrations, SqlJournal } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Action, Flow } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import { Node } from "@smthrs/plan"
import * as PersistedPlan from "@smthrs/plan/Plan"
import { Effect, Layer, Schema } from "effect"
import { HttpServer } from "effect/unstable/http"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { relayRpc, writeResponse } from "./workerRelay"
import { createGatewaySeam } from "../src/mainview/state/controller/gateway"

const CREDENTIAL = "proof-bearer-credential"
const REPO = "codeplanesmithers/smithers-demo"
const PLANNED = "proof/planned"
/** The box every call names: the relay refuses a call that names none. */
const BOX = "5b0c4f7e-2d1a-4c3b-9e8f-1a2b3c4d5e6f"

/*
 * A workspace flow with a plan hook, the shape the native host registers
 * (`NativeControl.ts`): graph the flow, key it, hand over the compiled plan
 * and the labelled edges. Two dependent steps, so `dependsOn` and the edges
 * carry something a graph can draw.
 */
const Probe = Action.make("proof/Probe", {
  payload: { value: Schema.String },
  success: Schema.String,
  error: Schema.Unknown
})

const PlannedFlow = Flow.make(PLANNED, {
  payload: Schema.Struct({ value: Schema.String }),
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ value }) => Probe.call({ value }).pipe(Node.andThen(Probe.call({ value: `${value}/second` })))
})

const plannedFlow: DurableFlow = {
  flowId: PLANNED,
  description: "A flow whose plan names its own nodes.",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} },
  plan: (input, planId) => {
    const graph = Graph.build(PlannedFlow, input)
    return PersistedPlan.compile({ planId, flow: PLANNED, nodes: Graph.drafts(graph) }).pipe(
      Effect.map((plan) => ({ plan, graph: { edges: Graph.edges(graph) } })),
      Effect.orDie,
      // The keyer hashes, so the compiler asks for Crypto; the hook's type has
      // no requirements, so the host discharges it here (NativeControl.ts:479).
      Effect.provide(NodeCrypto.layer)
    )
  }
}

/** The reserved catalog the runtime configures by default, plus the planned flow. */
const flows: ReadonlyArray<DurableFlow> = [
  ...plannable.map((entry): DurableFlow => ({
    flowId: entry.flowId,
    description: `Reserved ${entry.verb} system flow`,
    deployClass: entry.deployClass,
    envelope: { capabilities: [], flows: [], budget: {} }
  })),
  plannedFlow
]

const check = (condition: boolean, what: string): void => {
  if (!condition) throw new Error(`FAILED: ${what}`)
  console.log(`  ok  ${what}`)
}

const directory = mkdtempSync(join(tmpdir(), "smithers-ui-proof-"))
const filename = join(directory, "control.db")

const storage = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.merge(Migrations.layer, RunStoreMigrations.layer),
      Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
    )
  )
)

const workspace = Layer.mergeAll(GatewayProjections.layer, SyncServer.layer, SyncAuth.layer).pipe(
  Layer.provideMerge(Layer.merge(RunCatalog.layerNoop, WorkspaceShare.layerNoop)),
  Layer.provideMerge(ControlLive.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      // The gateway attributes every relayed call to its bearer identity, and
      // `launch` submits the plan approval through it. Without this
      // delegation the proof's own workspace refuses its own approval, which
      // is what a workspace serving a credential does when nobody configured
      // one: NativeControl.ts makes the same delegation for the same reason.
      SqlControlRuntime.layer({
        flows,
        approvalAuthority: Effect.runSync(ApprovalAuthority.make([
          { principal: NodeGateway.bearerPrincipal, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] }
        ]))
      }).pipe(Layer.orDie),
      NotificationQueue.layer,
      ControlExecutor.layer(ControlExecutor.makeNoop()),
      Registry.layerNoop()
    )
  ),
  Layer.provideMerge(Layer.merge(storage, NodeCrypto.layer))
)

const served = NodeGateway.layer(
  { workspaceHash: "proof", gatewayId: "proof-gateway", protocolVersion: "1", version: "1.0.0-rc.0" },
  { host: "127.0.0.1", port: 0, credential: CREDENTIAL }
).pipe(Layer.provideMerge(workspace))

/** Every procedure the relay forwarded, so a second resume would be visible. */
const relayed: Array<string> = []

/** The product Worker's relay, with the Worker's own frame adapter. */
const startRelay = (gatewayUrl: string): Promise<{ url: string; close: () => void }> =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        const answer = (status: number, body: unknown): void => {
          response.writeHead(status, { "content-type": "application/json" })
          response.end(JSON.stringify(body))
        }
        // Every rejection is answered. A malformed body or a refused upstream
        // fetch is an unhandled rejection otherwise, and Node takes the whole
        // proof down with it rather than failing the one call.
        void (async () => {
          try {
            const url = new URL(request.url ?? "/", "http://relay.local")
            if (url.pathname === "/api/workflow/provision") return answer(200, { status: "ready", repo: REPO })
            if (url.pathname !== "/api/workflow/rpc") return answer(404, { status: "error", message: "no route" })
            await writeResponse(await relayRpc(new Request(url, { method: "POST", body: Buffer.concat(chunks).toString("utf8") }),
              gatewayUrl, CREDENTIAL, procedure => relayed.push(procedure)), response)
          } catch (error) {
            answer(502, { status: "error", message: String(error) })
          }
        })()
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("no relay address")
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => server.close() })
    })
  })

const program = Effect.gen(function*() {
  const gateway = yield* HttpServer.HttpServer
  if (gateway.address._tag !== "InetAddressV4" && gateway.address._tag !== "InetAddressV6") throw new Error("no gateway address")
  const gatewayUrl = `http://127.0.0.1:${gateway.address.port}`
  const relay = yield* Effect.promise(() => startRelay(gatewayUrl))
  yield* Effect.addFinalizer(() => Effect.sync(relay.close))

  // The app's own seam, unmodified, over the relay.
  const seam = createGatewaySeam({
    baseUrl: relay.url,
    bindingFor: () => ({ workspaceId: BOX }),
    fetch: (url, init) => fetch(url, init),
    errorMessageOf: async (response, fallback) => `${fallback} (HTTP ${response.status})`
  })

  console.log("\n1. the workspace's flows")
  const flows = yield* Effect.promise(() => seam.listFlows(REPO))
  check(flows.status === "ok", "the seam lists the workspace's flows")
  check(
    flows.status === "ok" && flows.value.some((flow) => flow.flowId === "system/test"),
    "the listing names a real flow"
  )

  console.log("\n2. launch")
  const launched = yield* Effect.promise(() => seam.launch(REPO, "system/test", { proof: true }))
  // `launch` is three calls; naming the one that refused is the difference
  // between a diagnosable proof and a bare red line.
  check(launched.status === "ok", `the seam launched a run${launched.status === "ok" ? "" : `: ${launched.message}`}`)
  if (launched.status !== "ok") return
  const runId = launched.value.runId
  check(runId.length > 0, `the run is named: ${runId}`)

  console.log("\n2b. plan: the nodes a run would execute")
  const planned = yield* Effect.promise(() => seam.plan(REPO, PLANNED, { value: "proof" }))
  check(planned.status === "ok", `the seam planned a flow${planned.status === "ok" ? "" : `: ${planned.message}`}`)
  if (planned.status !== "ok") return
  check(planned.value.nodes.length > 0, `the plan names ${planned.value.nodes.length} nodes`)
  check(
    planned.value.nodes.some((node) => node.dependsOn.length > 0),
    "the nodes carry the edges between them"
  )
  check(
    planned.value.nodes.every((node) => node.key.length > 0 && node.status === "run"),
    "every node is keyed and claims no cache hit"
  )
  check(
    !Object.prototype.hasOwnProperty.call(planned.value, "envelope"),
    "the signed envelope never leaves the seam"
  )

  console.log("\n3. watch")
  const watched = yield* Effect.promise(() => seam.run(REPO, runId))
  check(watched.status === "ok" && watched.value !== undefined, "the run reads back through the projection")
  check(
    watched.status === "ok" && watched.value?.flowId === "system/test",
    "the run carries the flow it was launched from"
  )
  check(
    watched.status === "ok" && typeof watched.value?.diagnosis === "string",
    "the run carries its diagnosis, which the old wire called whatHappened"
  )

  console.log("\n4. a node produces output, and the run parks on a gate")
  const journal = yield* Journal.Journal
  const runtime = yield* ControlRuntime
  let source = 0
  const emit = (eventType: string, payload: unknown) =>
    Effect.orDie(
      journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId: JournalEvent.SourceId.make("proof"),
          sourceSeq: JournalEvent.SourceSeq.make((source += 1)),
          eventType,
          payload: JSON.parse(JSON.stringify(payload))
        })
      )
    )
  yield* emit("control.agent.turn-opened", { seat: "proof-seat", contextDigest: "proof-context" })
  yield* emit("control.agent.cell-call-started", { flowName: "write", input: { path: "docs/proof.md" } })
  yield* emit("control.agent.cell-call-settled", {
    flowName: "write",
    outcome: "success",
    value: "wrote docs/proof.md"
  })
  const target: ApprovalTarget = {
    _tag: "Node",
    runId,
    requestId: "proof-gate",
    digest: "proof-digest",
    envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
  }
  // Exactly what `AgentSession.authorize` does when a run asks for a decision.
  yield* runtime.registerApproval(target)
  yield* emit("control.approval.requested", {
    runId,
    requestId: "proof-gate",
    question: "Open a pull request?",
    payload: { target, scope: "run", idempotencyKey: "approve:proof-gate" }
  })

  const gates = yield* Effect.promise(() => seam.approvals(REPO, runId))
  check(gates.status === "ok" && gates.value.length === 1, "the parked gate reaches the seam")
  if (gates.status !== "ok" || gates.value[0] === undefined) return
  const gate = gates.value[0]
  check(gate.title === "Open a pull request?", "the gate carries the question the run asked")

  console.log("\n5. approve: one call, no second resume")
  const before = relayed.length
  const decided = yield* Effect.promise(() => seam.submitApproval(REPO, gate.payload, "approve"))
  check(decided.status === "ok", "the decision was accepted")
  check(relayed.length === before + 1, "the decision was ONE relayed call")
  check(relayed.at(-1) === "Approval.Submit", "that call was Approval.Submit")
  check(!relayed.includes("Resume"), "no second manual resume was ever issued")
  // The receipt names the run the decision landed on. `Approval.Submit` is a
  // transport adapter over `Control.approve`, which takes the decision and the
  // durable resume in one transaction, so the accepted receipt beside the
  // absence of a relayed `Resume` above is the whole claim.
  check(
    decided.status === "ok" && decided.value.decision._tag === "Accepted",
    "the workspace accepted the decision and named the run it resumed"
  )

  console.log("\n6. node output")
  // The emitter names no node, so the projection keys a call by the ordinal it
  // opened on. `call-1` is this run's first call.
  const output = yield* Effect.promise(() => seam.nodeOutput(REPO, runId, "call-1"))
  check(output.status === "ok" && output.value !== undefined, "the node's output reaches the seam")
  check(
    output.status === "ok" && output.value?.output === "wrote docs/proof.md",
    "the output is what the node produced"
  )

  console.log("\n7. explain")
  const explained = yield* Effect.promise(() => seam.explain(REPO, runId))
  check(explained.status === "ok" && (explained.value ?? "").length > 0, "the run explains itself in one line")

  console.log("\n8. cancel")
  const cancelled = yield* Effect.promise(() => seam.cancel(REPO, runId))
  check(cancelled.status === "ok", "the cancel was accepted")
  const after = yield* Effect.promise(() => seam.run(REPO, runId))
  check(after.status === "ok" && after.value?.status === "cancelled", "the cancel is durable: the run reads cancelled")

  // The control plane and the seam agree, because there is only one of them.
  const control = yield* Control
  const listed = yield* control.list({ _tag: "runs", filters: { runId } })
  check(
    listed._tag === "runs" && listed.items[0]?.status === "cancelled",
    "the control plane itself says the same"
  )

  console.log(`\nRelayed procedures: ${relayed.join(", ")}`)
  console.log("\nPROOF PASSED")
}).pipe(Effect.provide(served), Effect.scoped)

Effect.runPromise(program).then(
  () => {
    rmSync(directory, { recursive: true, force: true })
    process.exit(0)
  },
  (error: unknown) => {
    rmSync(directory, { recursive: true, force: true })
    console.error(error)
    process.exit(1)
  }
)
