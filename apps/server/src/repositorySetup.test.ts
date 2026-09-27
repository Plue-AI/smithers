import { afterEach, expect, test } from "bun:test"
import { initialSetup, setupCandidate, type SetupHostInput, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import worker from "./index"
import { setupPointerKey, type SetupRecord } from "./repositorySetupStore"
import type { NativeNamespace } from "./DurableStorage"
import { memoryDurableObjects } from "./memoryDurableObjects"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const frame = (value: unknown) => new Response(`${JSON.stringify({ _tag: "Exit", requestId: 1, exit: { _tag: "Success", value } })}\n`)
const gate = () => { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve }); return { wait, release } }
async function fixture() {
  const settings = { ASSETS: { fetch: async () => new Response("SPA") }, IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "synthetic-service", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" }
  const durable = memoryDurableObjects({ env: settings, nativeAlarms: true })
  const env = { ...settings, GATEWAY_SESSIONS: durable.GATEWAY_SESSIONS, TURN_CANCELS: durable.TURN_CANCELS }
  const workspaceIds = { alice: "11111111-1111-4111-8111-111111111111", bob: "22222222-2222-4222-8222-222222222222" }
  for (const login of ["alice", "bob"] as const) await durable.seedGatewayRecord(login, "org/repo", { gatewayId: `gateway-${login}`, baseUrl: `https://cloud.test/api/gateways/gateway-${login}`, token: `synthetic-${login}`, vmId: null, workspaceId: workspaceIds[login],
    expiresAt: Date.now() + 3_600_000, renewAfter: Date.now() + 1_800_000, provisionedAt: Date.now() })
  const setup = initialSetup("org/repo", "issues", "alice")
  const input = { requestId: "setup-test", repo: setup.repo, job: setup.job, revision: setup.revision, draft: setup.draft, digest: setupCandidate(setup) }
  const background: Promise<unknown>[] = []
  const calls: Array<{ login: string; tag: string; payload: Record<string, unknown> }> = []
  const options: { beforePlan?: Promise<void>; beforeWorkspace?: Promise<void>; onWorkspace?: () => void; workspaceState: string; runState: string; readError?: boolean; wrongFlow?: boolean; wrongResult?: boolean; incompatibleHost?: boolean;
    sleepBefore?: string; rejectResumedHost?: boolean; resultPayload?: "missing" | "malformed"; onSnapshot?: () => Promise<void>;
    lostWorkspace?: string; lostGateway?: string; newWorkspace?: string; boundReplacement?: boolean; lostRelay?: boolean;
    workspaceRefusal?: { status: number; code: string; message: string }; workspaceRaw?: { status: number; text: string }; registrations?: unknown; registrationError?: boolean; userError?: boolean; holdRegistrations?: Promise<void>; relayStatus?: number } = { runState: "running", workspaceState: "running" }
  const workspaceCalls: Array<{ method: string; path: string; body?: unknown }> = []
  const capabilityCalls: unknown[] = []
  const plans = new Map<string, Record<string, unknown>>()
  const launched = new Set<string>()
  globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
    const request = target instanceof Request ? target : new Request(String(target), init)
    const url = new URL(request.url)
    if (url.hostname === "identity.test") {
      if (url.pathname === "/api/identity/cloud-token") return Response.json({ found: true, token: `cloud-${(await request.json() as { login: string }).login}` })
      const login = request.headers.get("cookie")?.split("=")[1]
      return !login || login === "expired" ? Response.json({}, { status: 401 }) : Response.json({ login, allowlisted: login !== "visitor", admin: false })
    }
    const relayed = url.hostname === "cloud.test" && url.pathname.startsWith("/api/gateways/")
    if (url.hostname === "cloud.test" && !relayed) {
      if (url.pathname === "/api/user") return Response.json(options.userError ? {} : { id: request.headers.get("authorization") === "Bearer cloud-alice" ? 1 : 2 }, { status: options.userError ? 503 : 200 })
      if (url.pathname.endsWith("/repository-jobs")) {
        if (options.holdRegistrations) await options.holdRegistrations
        return Response.json(options.registrations ?? [], { status: options.registrationError ? 503 : 200 })
      }
      options.onWorkspace?.()
      if (options.beforeWorkspace) await options.beforeWorkspace
      const login = request.headers.get("authorization")?.replace("Bearer cloud-", "") as keyof typeof workspaceIds
      expect(workspaceIds[login]).toBeDefined()
      if (url.pathname.endsWith("/gateway")) {
        const body = await request.json() as { workspace_id?: string; required_capability?: string }
        capabilityCalls.push(body)
        // Cloud answers a bound workspace it no longer has with its own typed
        // not-found, exactly as it does on the workspace route.
        if (options.lostGateway && body.workspace_id === options.lostGateway) return Response.json({ code: "not_found", fault: "user", message: "workspace not found" }, { status: 404 })
        expect(body).toEqual({ workspace_id: options.newWorkspace ?? workspaceIds[login], required_capability: "repository-jobs/v1" })
        if (options.incompatibleHost) return Response.json({ code: "coding_host_upgrade_required", message: "This workspace needs a compatible coding host." }, { status: 409 })
        return Response.json({ gateway_id: `gateway-${login}`, workspace_id: body.workspace_id, base_url: `https://cloud.test/api/gateways/gateway-${login}`,
          token: `synthetic-${login}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      }
      workspaceCalls.push({ method: request.method, path: url.pathname, ...(request.method === "POST" ? { body: await request.json() } : {}) })
      if (options.workspaceRefusal) return Response.json(options.workspaceRefusal, { status: options.workspaceRefusal.status })
      if (options.workspaceRaw) return new Response(options.workspaceRaw.text, { status: options.workspaceRaw.status, headers: { "content-type": "text/html" } })
      if (options.lostWorkspace && url.pathname.endsWith(`/${options.lostWorkspace}`)) return Response.json({ code: "not_found", fault: "user", message: "workspace not found" }, { status: 404 })
      // Cloud keeps the deleted workspace's capability binding, so the
      // allocation that would replace it is refused as a conflict.
      if (options.boundReplacement && request.method === "POST") return Response.json({ code: "conflict", fault: "user", message: "the selected repository workspace is unavailable; its existing binding is preserved" }, { status: 409 })
      return Response.json({ id: request.method === "POST" ? options.newWorkspace ?? workspaceIds[login] : url.pathname.split("/").pop(),
        status: options.workspaceState, kind: "vm", repo_full_name: "org/repo" })
    }
    if (!relayed) throw Error("Unexpected upstream")
    const login = url.pathname.split("/")[3]!.replace(/^gateway-/, "")
    expect(request.headers.get("authorization")).toBe(`Bearer synthetic-${login}`)
    const body = JSON.parse(await request.text()) as { tag: string; payload: Record<string, unknown> }
    calls.push({ login, ...body })
    // Cloud's relay authorizer refuses a call bound to a workspace it no
    // longer has before the workspace's own host ever sees the frame.
    if (options.lostRelay) return Response.json({ code: "not_found", fault: "user", message: "workspace not found" }, { status: 404 })
    if (body.tag === "Projection.Snapshot" && options.relayStatus) return Response.json({ message: "Unavailable" }, { status: options.relayStatus })
    if (options.sleepBefore === body.tag) {
      options.sleepBefore = undefined
      options.incompatibleHost = options.rejectResumedHost
      return Response.json({ code: "conflict", message: "bound workspace is not running at the recorded VM" }, { status: 409 })
    }
    // One fixture models more than one durable request: every frame names its
    // own through the idempotency key or the run selector it carries.
    const selector = body.payload.selector as { runId?: string } | undefined
    const requestId = typeof body.payload.idempotencyKey === "string" ? body.payload.idempotencyKey.split(":")[1]!
      : typeof selector?.runId === "string" ? selector.runId.split(":")[1]! : input.requestId
    const id = `${login}:${requestId}`
    if (body.tag === "Plan") {
      if (options.beforePlan) await options.beforePlan
      if (!plans.has(id)) plans.set(id, { planId: `plan-${id}`, flowId: options.wrongFlow ? "unrelated/flow" : "repository/setup", digest: "d".repeat(64), executionDigest: "e".repeat(64),
        envelope: { capabilities: ["repository:read"], flows: ["repository/RunSetup"], budget: { tokens: 120000, milliseconds: 600000 } } })
      return frame(plans.get(id))
    }
    if (body.tag === "Approval.Submit") return frame({ approved: true })
    if (body.tag === "Run") { launched.add(`${login}:${String(body.payload.idempotencyKey)}`); return frame({ runId: `run-${id}` }) }
    if (body.tag !== "Projection.Snapshot") throw Error("Unexpected RPC")
    if (options.onSnapshot) await options.onSnapshot()
    if (options.readError) throw Error("Observation disconnected")
    const operation = (calls.find(call => call.login === login && call.tag === "Plan"
      && (call.payload.input as { requestId: string }).requestId === requestId)!.payload.input as { operation: string }).operation
    const receipt = { requestId: options.wrongResult ? "different-request" : requestId, runId: `run-${id}`, revision: input.revision, digest: input.digest,
      operation, phase: "completed", updatedAt: Date.now(), results: [], evidence: ["actual-host-artifact"],
      ...(operation === "run" ? { jobRunId: "actual-manual-job" } : {}),
      ...(operation === "apply" ? { registrationId: "registration-1", sourceRevision: "a".repeat(40) } : {}) }
    return frame({ selector: body.payload.selector, rows: [{ runId: `run-${id}`, flowId: "repository/setup", status: options.runState, updatedAt: Date.now(), verdict: "Run failed",
      ...(options.runState === "completed" && options.resultPayload !== "missing" ? { finalOutput: options.resultPayload === "malformed" ? "not JSON" : JSON.stringify({ requestId: receipt.requestId, revision: input.revision, digest: input.digest, receipt }) } : {}) }] })
  }) as typeof fetch
  const send = (method: string, suffix: string, login = "alice", body?: unknown) => worker.fetch(new Request(`https://app.test/api/repository-setup/${suffix}`, {
    method, headers: { "content-type": "application/json", ...(login ? { cookie: `session=${login}` } : {}), "x-user-login": "forged" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), env, { waitUntil: promise => { background.push(promise) } })
  const settle = async () => { for (let index = 0; index < background.length; index++) await background[index] }
  const read = (login = "alice") => send("GET", `request?requestId=${input.requestId}&repo=org%2Frepo&job=issues`, login)
  return { durable, env, input, calls, options, launched, plans, background, send, read, settle, workspaceCalls, workspaceIds, capabilityCalls }
}

test("fresh setup acknowledges while workspace creation is unresolved, pins the compatible VM and resumes after reload", async () => {
  const t = await fixture(), held = gate()
  t.options.beforeWorkspace = held.wait; t.options.workspaceState = "starting"
  try {
    const response = await Promise.race([t.send("POST", "evaluate", "alice", t.input), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 150))])
    expect(response?.status).toBe(202)
    expect(t.calls).toHaveLength(0)
    held.release(); await t.settle()
    expect(t.workspaceCalls).toEqual([{ method: "POST", path: "/api/repos/org/repo/workspaces", body: { kind: "vm", name: "Repository", required_capability: "repository-jobs/v1" } }])
    t.durable.restart()
    t.options.workspaceState = "running"
    const saved = await (await t.read()).json() as { workspaceId: string; receipt: { runId?: string; phase: string } }
    expect(saved.workspaceId).toBe(t.workspaceIds.alice)
    expect(saved.receipt.runId).toBeUndefined()
    expect(saved.receipt.phase).toBe("queued")
    await t.settle()
    expect(t.workspaceCalls[1]).toEqual({ method: "GET", path: `/api/repos/org/repo/workspaces/${t.workspaceIds.alice}` })
    expect(t.workspaceCalls.filter(call => call.method === "POST")).toHaveLength(1)
    expect((t.calls.find(call => call.tag === "Plan")!.payload.input as { workspaceId: string }).workspaceId).toBe(t.workspaceIds.alice)
    expect(t.launched.size).toBe(1)
    expect(t.capabilityCalls).toHaveLength(1)
  } finally { held.release(); await t.settle() }
})

test("a cold unverified primary stays queued across reload without pinning or launching", async () => {
  const t = await fixture()
  t.options.workspaceRefusal = { status: 409, code: "repository_workspace_pending", message: "The repository workspace is starting" }
  expect((await t.send("POST", "evaluate", "alice", t.input)).status).toBe(202)
  await t.settle()
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  const waiting = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as {
    workspaceId?: string; binding?: unknown; observationError?: string; receipt: { phase: string }
  }
  expect(waiting.workspaceId).toBeUndefined()
  expect(waiting.binding).toBeUndefined()
  expect(waiting.observationError).toBeUndefined()
  expect(waiting.receipt.phase).toBe("queued")
  expect(t.capabilityCalls).toHaveLength(0)
  expect(t.launched.size).toBe(0)
  expect(t.workspaceCalls.length).toBeGreaterThanOrEqual(2)
  expect(t.workspaceCalls.every(call => call.method === "POST")).toBe(true)
  t.options.workspaceRefusal = undefined
  await t.durable.runGatewayAlarms()
  const selected = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { workspaceId: string }
  expect(selected.workspaceId).toBe(t.workspaceIds.alice)
  expect(t.launched.size).toBe(1)
  expect((t.calls.find(call => call.tag === "Plan")!.payload.input as { workspaceId: string }).workspaceId).toBe(t.workspaceIds.alice)
})

test("only typed pending clears a previous selection error; generic conflicts remain visible", async () => {
  const t = await fixture()
  t.options.workspaceRefusal = { status: 409, code: "conflict", message: "The workspace identity changed" }
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  let stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { observationError?: string; workspaceId?: string }
  expect(stored.observationError).toBe("The workspace identity changed")
  expect(stored.workspaceId).toBeUndefined()
  t.options.workspaceRefusal = { status: 503, code: "repository_workspace_pending", message: "Provider unavailable" }
  await t.durable.runGatewayAlarms()
  stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as typeof stored
  expect(stored.observationError).toBe("Provider unavailable")
  t.options.workspaceRefusal = { status: 409, code: "repository_workspace_pending", message: "The repository workspace is starting" }
  await t.durable.runGatewayAlarms()
  stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as typeof stored
  expect(stored.observationError).toBeUndefined()
  expect(stored.workspaceId).toBeUndefined()
  expect(t.launched.size).toBe(0)
})

test("a non-JSON or oversized workspace answer is a visible selection error, not a silent queue", async () => {
  const t = await fixture()
  const stored = () => t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { observationError?: string; workspaceId?: string }
  t.options.workspaceRaw = { status: 502, text: "<html><body>502 Bad Gateway</body></html>" }
  const response = await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(response.status).toBe(202)
  expect(stored().observationError).toBe("The repository workspace is having trouble right now (HTTP 502).")
  expect((await t.read()).status).toBe(503)
  await t.settle()
  t.options.workspaceRaw = { status: 200, text: "x".repeat(20_000) }
  await t.durable.runGatewayAlarms()
  expect(stored().observationError).toBe("Cloud returned an unreadable repository workspace")
  expect(stored().workspaceId).toBeUndefined()
  expect(t.launched.size).toBe(0)
})

const captureJsonLines = () => {
  const originals = { warn: console.warn, error: console.error }
  const lines: Array<Record<string, unknown>> = []
  const capture = (original: (...args: unknown[]) => void) => (...args: unknown[]) => {
    const parsed = typeof args[0] === "string" && args[0].startsWith("{") ? JSON.parse(args[0]) as Record<string, unknown> : undefined
    if (parsed === undefined) original(...args)
    else lines.push(parsed)
  }
  console.warn = capture(originals.warn)
  console.error = capture(originals.error)
  return {
    of: (event: string) => lines.filter(line => line.event === event),
    clear: () => { lines.length = 0 },
    restore: () => { console.warn = originals.warn; console.error = originals.error }
  }
}

/**
 * The setup store's Durable Object, failing each command `fail` selects. It is
 * installed before the first request: the Worker keeps its bindings per env.
 */
const failingSetupStore = (t: Awaited<ReturnType<typeof fixture>>) => {
  const inner: NativeNamespace = t.env.GATEWAY_SESSIONS
  const state: { fail: (action: string) => Error | undefined } = { fail: () => undefined }
  t.env.GATEWAY_SESSIONS = {
    idFromName: name => inner.idFromName(name),
    get: id => ({ fetch: async request => {
      const failure = new URL(request.url).pathname === "/repository-setup"
        ? state.fail((await request.clone().json() as { action: string }).action) : undefined
      return failure === undefined ? inner.get(id).fetch(request) : Promise.reject(failure)
    } })
  }
  return state
}

test("an observation failure whose record write also fails is logged, never swallowed", async () => {
  const t = await fixture()
  const store = failingSetupStore(t)
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  store.fail = action => action === "update" ? new Error("SQLITE_FULL") : undefined
  t.options.readError = true
  const lines = captureJsonLines()
  try {
    await t.read(); await t.settle()
    expect(lines.of("worker_seam_failure")).toContainEqual({
      event: "worker_seam_failure", seam: "repository setup observation",
      cause: "SetupStoreError: StorageFailure(repository-setup): Error: SQLITE_FULL"
    })
    expect(JSON.stringify(lines.of("worker_seam_failure"))).not.toContain("synthetic-alice")
  } finally { lines.restore() }
})

test("a cached old gateway cannot admit setup before live capability proof or move the pinned workspace", async () => {
  const t = await fixture()
  t.options.incompatibleHost = true
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, workspaceId: t.workspaceIds.alice })).status).toBe(202)
  await t.settle()
  expect(t.capabilityCalls).toHaveLength(1)
  expect(t.calls).toHaveLength(0)
  expect(t.launched.size).toBe(0)
  expect(t.workspaceCalls.every(call => call.method === "GET" && call.path.endsWith(t.workspaceIds.alice))).toBe(true)
  const response = await t.read()
  expect(response.status).toBe(503)
  const pending = await response.json() as { message: string }
  expect(pending.message).toContain("compatible coding host")
  const retained = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { workspaceId: string }
  expect(retained.workspaceId).toBe(t.workspaceIds.alice)
  await t.settle()
  t.options.incompatibleHost = false
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  expect(t.launched.size).toBe(1)
  expect((t.calls.find(call => call.tag === "Plan")!.payload.input as { workspaceId: string }).workspaceId).toBe(t.workspaceIds.alice)
})

test.each(["Plan", "Run", "Projection.Snapshot"])("a bound setup rechecks resumed capability before forwarding %s", async (procedure) => {
  const t = await fixture()
  t.options.sleepBefore = procedure
  t.options.rejectResumedHost = true
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.capabilityCalls).toHaveLength(2)
  expect(t.calls.filter(call => call.tag === procedure)).toHaveLength(1)
  expect(t.launched.size).toBe(procedure === "Projection.Snapshot" ? 1 : 0)
  const stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as {
    binding: { workspaceId: string }; observationError?: string
  }
  expect(stored.binding.workspaceId).toBe(t.workspaceIds.alice)
  expect(stored.observationError).toContain("compatible coding host")
  const callsBeforeRestart = t.calls.length
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  expect(t.calls).toHaveLength(callsBeforeRestart)
  expect(t.capabilityCalls).toHaveLength(3)
  expect(t.workspaceCalls.filter(call => call.method === "POST")).toHaveLength(1)
})

test("a sleeping setup Run is not replayed inline and a durable retry retains its original key", async () => {
  const t = await fixture()
  t.options.sleepBefore = "Run"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.capabilityCalls).toHaveLength(2)
  expect(t.calls.filter(call => call.tag === "Run")).toHaveLength(1)
  expect(t.launched.size).toBe(0)
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  const attempts = t.calls.filter(call => call.tag === "Run")
  expect(attempts).toHaveLength(2)
  expect(attempts[1]?.payload).toEqual(attempts[0]?.payload)
  expect(t.launched.size).toBe(1)
  expect(t.workspaceCalls.filter(call => call.method === "POST")).toHaveLength(1)
})

test("a closed browser and a restarted Durable Object still launch and finish the admitted setup", async () => {
  const t = await fixture()
  t.options.workspaceState = "starting"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.launched.size).toBe(0)
  expect(t.durable.pendingGatewayAlarms()).toEqual(["alice"])
  t.durable.restart()
  t.options.workspaceState = "running"
  await t.durable.runGatewayAlarms()
  expect(t.launched.size).toBe(1)
  t.options.runState = "completed"
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  const stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { receipt: { phase: string }; result: unknown }
  expect(stored.receipt.phase).toBe("completed")
  expect(stored.result).toBeDefined()
  await t.durable.runGatewayAlarms()
  expect(t.durable.pendingGatewayAlarms()).toEqual([])
  expect(t.launched.size).toBe(1)
})

test("completed setup waits for its typed output across restart without replaying work", async () => {
  const t = await fixture()
  t.options.runState = "completed"; t.options.resultPayload = "missing"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const waiting = await t.read()
  expect(waiting.status).toBe(202)
  expect((await waiting.json() as { receipt: { phase: string } }).receipt.phase).toBe("running")
  await t.settle()
  const key = `repository-setup:request:${t.input.requestId}`
  const pending = t.durable.gatewayRows("alice").get(key) as { resultPendingSince?: number; result?: unknown; observationError?: string }
  expect(pending.resultPendingSince).toBeGreaterThan(0)
  expect(pending.result).toBeUndefined()
  expect(pending.observationError).toBeUndefined()
  t.durable.restart()
  t.options.resultPayload = undefined
  await t.durable.runGatewayAlarms()
  const completed = await t.read()
  expect(completed.status).toBe(200)
  expect((await completed.json() as { receipt: { phase: string } }).receipt.phase).toBe("completed")
  expect(t.calls.filter(call => call.tag === "Plan")).toHaveLength(1)
  expect(t.calls.filter(call => call.tag === "Run")).toHaveLength(1)
  expect(t.launched.size).toBe(1)
})

test("a missing completed output has a persisted observation deadline and can reconnect to its eventual receipt", async () => {
  const t = await fixture()
  t.options.runState = "completed"; t.options.resultPayload = "missing"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const key = `repository-setup:request:${t.input.requestId}`
  const rows = t.durable.gatewayRows("alice")
  const pending = rows.get(key) as Record<string, unknown>
  rows.set(key, { ...pending, resultPendingSince: Date.now() - 61_000 })
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  const expired = await t.read()
  expect(expired.status).toBe(503)
  const stored = rows.get(key) as { result?: unknown; receipt: { phase: string }; observationError?: string }
  expect(stored.result).toBeUndefined()
  expect(stored.receipt.phase).toBe("running")
  expect(stored.observationError).toContain("without a valid result receipt")
  await t.settle()
  t.options.resultPayload = undefined
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect((await t.read()).status).toBe(200)
  expect(t.calls.filter(call => call.tag === "Run")).toHaveLength(1)
})

test("malformed completed output is refused without receiving the absent-output grace period", async () => {
  const t = await fixture()
  t.options.runState = "completed"; t.options.resultPayload = "malformed"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect((await t.read()).status).toBe(503)
  const stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { result?: unknown; resultPendingSince?: number }
  expect(stored.result).toBeUndefined()
  expect(stored.resultPendingSince).toBeUndefined()
  await t.settle()
  expect(t.calls.filter(call => call.tag === "Run")).toHaveLength(1)
})

const PHASE_INSTANTS = ["createdAt", "workspaceSelectedAt", "workspaceReadyAt", "gatewayReadyAt", "plannedAt", "approvedAt", "runStartedAt"] as const

test("each setup phase instant is stamped once in order and survives a replayed advance", async () => {
  const t = await fixture()
  t.options.workspaceState = "starting"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const key = `repository-setup:request:${t.input.requestId}`
  const rows = t.durable.gatewayRows("alice")
  const queued = rows.get(key) as SetupRecord
  expect(queued.createdAt).toBeGreaterThan(0)
  expect(queued.workspaceSelectedAt).toBeGreaterThanOrEqual(queued.createdAt!)
  expect(queued.workspaceReadyAt).toBeUndefined()
  expect(queued.runStartedAt).toBeUndefined()
  t.options.workspaceState = "running"
  await t.durable.runGatewayAlarms()
  const started = { ...rows.get(key) as SetupRecord }
  for (let index = 1; index < PHASE_INSTANTS.length; index++) {
    expect(started[PHASE_INSTANTS[index]!]).toBeGreaterThanOrEqual(started[PHASE_INSTANTS[index - 1]!]!)
  }
  expect(t.launched.size).toBe(1)
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  await t.durable.runGatewayAlarms()
  const replayed = rows.get(key) as SetupRecord
  for (const instant of PHASE_INSTANTS) expect(replayed[instant]).toBe(started[instant])
  expect(t.launched.size).toBe(1)
})

test("a stored setup record without phase instants still decodes and finishes", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const key = `repository-setup:request:${t.input.requestId}`
  const rows = t.durable.gatewayRows("alice")
  const legacy = { ...rows.get(key) as Record<string, unknown> }
  for (const instant of PHASE_INSTANTS) delete legacy[instant]
  rows.set(key, legacy)
  t.durable.restart()
  t.options.runState = "completed"
  await t.durable.runGatewayAlarms()
  const response = await t.read()
  expect(response.status).toBe(200)
  expect((await response.json() as { receipt: { phase: string } }).receipt.phase).toBe("completed")
  expect(t.launched.size).toBe(1)
})

test("the phase instants never reach the setup response, which still carries the completed receipt", async () => {
  const t = await fixture()
  t.options.runState = "completed"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const response = await t.read()
  expect(response.status).toBe(200)
  const body = await response.text()
  for (const instant of PHASE_INSTANTS) expect(body.includes(instant)).toBe(false)
  const result = JSON.parse(body) as { requestId: string; revision: number; digest: string; workspaceId: string
    receipt: { requestId: string; runId: string; revision: number; digest: string; operation: string; phase: string; evidence: string[] } }
  expect(result.requestId).toBe(t.input.requestId)
  expect(result.revision).toBe(t.input.revision)
  expect(result.digest).toBe(t.input.digest)
  expect(result.workspaceId).toBe(t.workspaceIds.alice)
  expect(result.receipt.phase).toBe("completed")
  expect(result.receipt.operation).toBe("evaluate")
  expect(result.receipt.runId).toBe("run-alice:setup-test")
  expect(result.receipt.requestId).toBe(t.input.requestId)
  expect(result.receipt.digest).toBe(t.input.digest)
  expect(result.receipt.evidence).toEqual(["actual-host-artifact"])
})

const capturePhaseLines = () => {
  const original = console.log
  const lines: Array<Record<string, unknown>> = []
  console.log = (...args: unknown[]) => {
    const parsed = typeof args[0] === "string" && args[0].startsWith("{") ? JSON.parse(args[0]) as Record<string, unknown> : undefined
    if (parsed?.event === "repository_setup_phases") lines.push(parsed)
    else original(...args)
  }
  return { lines, restore: () => { console.log = original } }
}

test("a finished setup logs its phase durations exactly once across replayed advances and alarms", async () => {
  const t = await fixture()
  t.options.workspaceState = "starting"
  const log = capturePhaseLines()
  try {
    await t.send("POST", "evaluate", "alice", t.input); await t.settle()
    expect(log.lines).toHaveLength(0)
    t.options.workspaceState = "running"
    await t.durable.runGatewayAlarms()
    expect(log.lines).toHaveLength(0)
    t.options.runState = "completed"
    await t.durable.runGatewayAlarms()
    expect(log.lines).toHaveLength(1)
    const line = log.lines[0]!
    expect(line).toMatchObject({ event: "repository_setup_phases", requestId: t.input.requestId, job: "issues",
      operation: "evaluate", phase: "completed", runId: "run-alice:setup-test" })
    for (const name of ["totalMs", "workspaceSelectedMs", "workspaceReadyMs", "gatewayReadyMs", "plannedMs", "approvedMs", "runStartedMs", "runMs"]) {
      expect(typeof line[name]).toBe("number")
      expect(line[name] as number).toBeGreaterThanOrEqual(0)
    }
    const text = JSON.stringify(line)
    for (const secret of ["synthetic-", "cloud-", "Classify the issue", "org/repo"]) expect(text.includes(secret)).toBe(false)
    t.durable.restart()
    await t.durable.runGatewayAlarms()
    await t.read(); await t.settle()
    expect(log.lines).toHaveLength(1)
  } finally { log.restore() }
})

test("two observers that reach the same finished run log its phases exactly once", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const key = `repository-setup:request:${t.input.requestId}`
  const before = (t.durable.gatewayRows("alice").get(key) as SetupRecord).version
  t.options.runState = "completed"
  // Both observers read version `before` and only then race the terminal write.
  let waiting = 0; const held = gate()
  t.options.onSnapshot = async () => { if (++waiting === 2) held.release(); await held.wait }
  const log = capturePhaseLines()
  try {
    const observe = () => t.send("GET", `observe?repo=org%2Frepo&job=issues&requestId=${t.input.requestId}`)
    const responses = await Promise.all([observe(), observe()])
    await t.settle()
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(log.lines).toHaveLength(1)
    const stored = t.durable.gatewayRows("alice").get(key) as SetupRecord
    expect(stored.version).toBe(before + 1)
    expect(stored.result).toBeDefined()
    expect(stored.receipt.phase).toBe("completed")
  } finally { held.release(); log.restore() }
})

test("competing terminal updates at one expectedVersion produce one winner and one log line", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const key = `repository-setup:request:${t.input.requestId}`
  const base = t.durable.gatewayRows("alice").get(key) as SetupRecord
  const stub = t.durable.GATEWAY_SESSIONS.get(t.durable.GATEWAY_SESSIONS.idFromName("alice"))
  const terminal = (phase: "completed" | "failed"): SetupRecord => ({ ...base,
    receipt: { ...base.receipt, phase, updatedAt: Date.now() },
    result: { requestId: base.input.requestId, revision: base.input.revision, digest: base.input.digest,
      receipt: { ...base.receipt, phase, updatedAt: Date.now() } } })
  const update = (record: SetupRecord) => stub.fetch(new Request("https://gateway-sessions.internal/repository-setup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "update", requestId: base.input.requestId, expectedVersion: base.version, record })
  }))
  const log = capturePhaseLines()
  try {
    const answers = await Promise.all([update(terminal("completed")), update(terminal("failed"))])
    const records = await Promise.all(answers.map(async answer => (await answer.json() as { record: SetupRecord }).record))
    expect(log.lines).toHaveLength(1)
    const winner = t.durable.gatewayRows("alice").get(key) as SetupRecord
    expect(winner.version).toBe(base.version + 1)
    // The loser is answered with the winner's terminal record, not its own.
    expect(records.map(record => record.version)).toEqual([base.version + 1, base.version + 1])
    for (const record of records) expect(record.receipt.phase).toBe(winner.receipt.phase)
    expect(log.lines[0]).toMatchObject({ event: "repository_setup_phases", requestId: t.input.requestId,
      job: "issues", operation: "evaluate", phase: winner.receipt.phase })
  } finally { log.restore() }
})

test("a failed setup logs once and a logging failure never fails the request", async () => {
  const t = await fixture()
  t.options.runState = "failed"
  const log = capturePhaseLines()
  const broken = console.log
  console.log = () => { throw Error("log sink is gone") }
  try {
    await t.send("POST", "evaluate", "alice", t.input); await t.settle()
    const failed = await t.read()
    expect(failed.status).toBe(200)
    expect((await failed.json() as { receipt: { phase: string } }).receipt.phase).toBe("failed")
  } finally { console.log = broken; log.restore() }
})

test("retry can echo the server-pinned workspace but cannot move an admitted request", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  t.durable.restart()
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, workspaceId: t.workspaceIds.alice })).status).toBe(202)
  await t.settle()
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, workspaceId: t.workspaceIds.bob })).status).toBe(409)
  expect(t.launched.size).toBe(1)
})

test("manual work survives restart and retries only its original subject and prompt", async () => {
  const t = await fixture()
  const manual = { stepId: "poc", prompt: "Try the reported fix", subject: { source: "smithers-cloud", kind: "issue", number: 12 } }
  expect((await t.send("POST", "run", "alice", { ...t.input, manual })).status).toBe(202)
  await t.settle(); t.durable.restart()
  expect((await t.send("POST", "run", "alice", { ...t.input, manual })).status).toBe(202)
  await t.settle()
  expect((await t.send("POST", "run", "alice", { ...t.input, manual: { ...manual, prompt: "Do different work" } })).status).toBe(409)
  expect((await t.send("POST", "run", "alice", { ...t.input, manual: { ...manual, subject: { ...manual.subject, number: 13 } } })).status).toBe(409)
  expect(t.launched.size).toBe(1)
  expect((t.calls.find(call => call.tag === "Plan")!.payload.input as { manual: unknown }).manual).toEqual(manual)
  t.options.runState = "completed"
  await t.durable.runGatewayAlarms()
  const response = await t.read()
  expect(response.status).toBe(200)
  expect((await response.json() as { receipt: { jobRunId: string } }).receipt.jobRunId).toBe("actual-manual-job")
})

test("setup persists and acknowledges before Plan answers, and duplicate launches share engine keys", async () => {
  const t = await fixture(), held = gate()
  t.options.beforePlan = held.wait
  try {
    const first = await Promise.race([t.send("POST", "evaluate", "alice", t.input), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 150))])
    expect(first?.status).toBe(202)
    const accepted = await first!.json() as { receipt: { phase: string; runId?: string } }
    expect(accepted.receipt.phase).toBe("queued")
    expect(accepted.receipt.runId).toBeUndefined()
    expect(t.launched.size).toBe(0)
    expect((await t.send("POST", "evaluate", "alice", t.input)).status).toBe(202)
    held.release(); await t.settle()
    expect(t.plans.size).toBe(1)
    expect(t.launched.size).toBe(1)
    const observed = await (await t.read()).json() as { receipt: { phase: string; runId: string } }
    expect(observed.receipt.phase).toBe("running")
    expect(observed.receipt.runId).toBe("run-alice:setup-test")
    await t.settle()
  } finally { held.release(); await t.settle() }
})

test("setup authority is session-derived and no gateway credential reaches the response", async () => {
  const t = await fixture()
  for (const login of ["", "expired", "visitor"]) {
    const result = await t.send("POST", "evaluate", login, { ...t.input, login: "alice" })
    expect(result.status).toBe(login === "visitor" ? 403 : 401)
  }
  expect(t.calls).toHaveLength(0)
  for (const login of ["alice", "bob"]) {
    const result = await t.send("POST", "evaluate", login, { ...t.input, login: "forged", evaluation: { passed: true }, active: true })
    expect(result.status).toBe(202)
    expect(await result.text()).not.toContain("synthetic-")
    await t.settle()
  }
  expect(t.launched.size).toBe(2)
  const planInputs = t.calls.filter(call => call.tag === "Plan").map(call => call.payload.input as Record<string, unknown>)
  expect(planInputs.every(input => !Object.hasOwn(input, "login") && !Object.hasOwn(input, "evaluation") && !Object.hasOwn(input, "active"))).toBe(true)
})

test("the same request id cannot be reused for a different candidate or operation", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect((await t.send("POST", "trial", "alice", t.input)).status).toBe(409)
  expect(t.launched.size).toBe(1)
  const changed = { ...t.input, revision: 2 }
  changed.digest = setupCandidate(changed)
  expect((await t.send("POST", "evaluate", "alice", changed)).status).toBe(409)
})

test("an incorrect digest is rejected before storage or model work", async () => {
  const t = await fixture()
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, digest: "f".repeat(64) })).status).toBe(400)
  expect(t.calls).toHaveLength(0)
  expect((await t.read()).status).toBe(404)
})

test("completion comes from actual host output and is retained without rerunning", async () => {
  const t = await fixture()
  t.options.runState = "completed"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const result = await t.read()
  expect(result.status).toBe(200)
  expect((await result.json() as { receipt: { phase: string } }).receipt.phase).toBe("completed")
  const calls = t.calls.length
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.calls.length).toBe(calls)
})

test("native accepted and approval or signal waits retain a live setup receipt", async () => {
  for (const [status, phase] of [["accepted", "queued"], ["waiting-approval", "waiting"], ["parked", "waiting"]]) {
    const t = await fixture()
    t.options.runState = status!
    await t.send("POST", "evaluate", "alice", t.input); await t.settle()
    const response = await t.read()
    expect(response.status).toBe(202)
    expect((await response.json() as { receipt: { phase: string } }).receipt.phase).toBe(phase!)
    await t.settle()
    expect(t.launched.size).toBe(1)
  }
})

test("observation loss preserves running state and reconnects the original run", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  t.options.readError = true
  await t.read(); await t.settle()
  expect((await t.read()).status).toBe(503); await t.settle()
  t.options.readError = false; t.options.runState = "completed"
  const retry = await t.send("POST", "evaluate", "alice", t.input)
  expect((await retry.json() as { receipt: { phase: string } }).receipt.phase).toBe("running")
  await t.settle()
  expect(t.launched.size).toBe(1)
  expect((await t.read()).status).toBe(200)
})

test("a different flow's plan is never approved and mismatched final receipts never become success", async () => {
  const t = await fixture()
  t.options.wrongFlow = true
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.calls.some(call => call.tag === "Approval.Submit")).toBe(false)
  expect((await t.read()).status).toBe(503); await t.settle()
})

test("a mismatched completed result leaves the original candidate unverified", async () => {
  const t = await fixture()
  t.options.wrongResult = true; t.options.runState = "completed"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect((await t.read()).status).toBe(503); await t.settle()
  expect(t.launched.size).toBe(1)
})

const policyRow = (source: ReturnType<typeof initialSetup>, enabled = true, userId = 1) => ({
  id: "registration-1", workspace_id: "11111111-1111-4111-8111-111111111111", user_id: userId, job: source.job, mode: "enabled",
  revision: source.revision, digest: setupCandidate(source), source_revision: "b".repeat(40), flow_id: `repository-jobs/${source.job}`, enabled,
  schedule: source.job === "chores" ? source.draft.schedule : "",
  configuration: { repo: source.repo, workspace_id: "11111111-1111-4111-8111-111111111111", source_revision: "b".repeat(40), flow_id: `repository-jobs/${source.job}`, mode: "enabled", revision: source.revision, digest: setupCandidate(source), input: source.draft,
    schedule: source.job === "chores" ? source.draft.schedule : "",
    envelope: { private: "not-public" }, execution_digest: "not-public" }
})

test("chore recovery reads the registry's advancing occurrence across restart and omits paused or absent times", async () => {
  const t = await fixture(), source = initialSetup("org/repo", "chores", "alice")
  source.draft.schedule = "30 1 * * *"
  const row = { ...policyRow(source), next_fire_at: "2026-12-31T23:30:00-02:00" as string | null }
  t.options.registrations = [row]
  const read = async () => {
    const result = await (await t.send("GET", "state?repo=org%2Frepo&job=chores")).json() as SetupRecoveryResponse
    if (result.registration.state !== "known") throw Error("Expected a known registration")
    return result.registration.active
  }
  expect((await read())?.schedule).toEqual({ expression: "30 1 * * *", nextFireAt: "2027-01-01T01:30:00.000Z" })
  // The service, not this read, advances after durable schedule admission.
  row.next_fire_at = "2027-01-02T01:30:00Z"
  t.durable.restart()
  expect((await read())?.schedule?.nextFireAt).toBe("2027-01-02T01:30:00.000Z")
  row.enabled = false // Pause retains next_fire_at in SQL; it is no longer executable.
  expect((await read())?.enabled).toBe(false)
  expect((await read())?.schedule).toBeUndefined()
  row.enabled = true; row.next_fire_at = null
  expect((await read())?.enabled).toBe(true)
  expect((await read())?.schedule).toBeUndefined()
  expect(t.calls).toEqual([])
  expect(t.workspaceCalls).toEqual([])
  expect(t.launched.size).toBe(0)
})

test("manual and trial chore registrations never manufacture a scheduled execution", async () => {
  const t = await fixture(), source = initialSetup("org/repo", "chores", "alice")
  const manual = { ...policyRow(structuredClone(source)), next_fire_at: null }
  source.draft.schedule = "0 9 * * *"
  const trial = { ...policyRow(source), mode: "trial", schedule: "", next_fire_at: null,
    configuration: { ...policyRow(source).configuration, mode: "trial", schedule: "" } }
  t.options.registrations = [manual, trial]
  const result = await (await t.send("GET", "state?repo=org%2Frepo&job=chores")).json() as SetupRecoveryResponse
  if (result.registration.state !== "known") throw Error("Expected a known registration")
  expect(result.registration.active?.schedule).toBeUndefined()
  expect(result.registration.trial?.schedule).toBeUndefined()
  expect(t.calls).toEqual([])
})

test.each(["outer", "inner", "invalid time"])("chore recovery refuses %s scheduler evidence without executing work", async mismatch => {
  const t = await fixture(), source = initialSetup("org/repo", "chores", "alice")
  source.draft.schedule = "0 9 * * *"
  const row = { ...policyRow(source), next_fire_at: "2026-09-18T09:00:00Z" }
  if (mismatch === "outer") row.schedule = "0 10 * * *"
  else if (mismatch === "inner") row.configuration.schedule = "0 10 * * *"
  else row.next_fire_at = "tomorrow"
  t.options.registrations = [row]
  const result = await (await t.send("GET", "state?repo=org%2Frepo&job=chores")).json() as SetupRecoveryResponse
  expect(result.registration.state).toBe("unavailable")
  expect(t.calls).toEqual([])
  expect(t.workspaceCalls).toEqual([])
})

test("discovery reads current paused policy and exact owned request without replaying an old apply", async () => {
  const t = await fixture()
  await t.send("POST", "apply", "alice", t.input); await t.settle()
  const writes = t.calls.filter(call => call.tag !== "Projection.Snapshot").length
  const newer = { ...initialSetup("org/repo", "issues", "alice"), revision: 2 }
  t.options.registrations = [policyRow(newer, false)]
  t.options.runState = "completed"
  const raw = await (await t.send("GET", "state?repo=org%2Frepo&job=issues")).text()
  const recovered = JSON.parse(raw) as SetupRecoveryResponse
  expect(recovered.owner).toBe("alice")
  expect(recovered.registration.state).toBe("known")
  if (recovered.registration.state !== "known" || recovered.setup.state !== "found") throw Error("Expected recovery")
  expect(recovered.registration.active?.enabled).toBe(false)
  expect(recovered.registration.active?.revision).toBe(2)
  expect(recovered.registration.active?.owned).toBe(true)
  expect(recovered.setup.result.receipt?.phase).toBe("running")
  expect(raw.includes("not-public")).toBe(false)
  expect(raw.includes("synthetic-")).toBe(false)
  const response = await t.send("GET", `observe?repo=org%2Frepo&job=issues&requestId=${t.input.requestId}`)
  expect(response.status).toBe(200)
  expect((await response.json() as { receipt: { phase: string } }).receipt.phase).toBe("completed")
  expect(t.calls.filter(call => call.tag !== "Projection.Snapshot")).toHaveLength(writes)
  expect(t.launched.size).toBe(1)
  const after = await (await t.send("GET", "state?repo=org%2Frepo&job=issues")).json() as SetupRecoveryResponse
  expect(after.registration.state === "known" && after.registration.active?.enabled).toBe(false)
  expect(t.workspaceCalls.filter(call => call.method === "POST")).toHaveLength(1)
})

test("expired legacy setup without a recorded run fails reconnection without provisioning or Plan", async () => {
  const t = await fixture(), input: SetupHostInput = { ...t.input, operation: "apply" }
  const old: SetupRecord = { version: 0, input, observationError: "Expired", receipt: { requestId: input.requestId, revision: 1, digest: input.digest,
    operation: "apply", phase: "queued", updatedAt: 1, results: [], evidence: [] } }
  t.durable.gatewayRows("alice").set(`repository-setup:request:${input.requestId}`, old)
  const state = await (await t.send("GET", "state?repo=org%2Frepo&job=issues")).json() as SetupRecoveryResponse
  expect(state.setup.state).toBe("found")
  expect(t.calls).toEqual([])
  expect(t.workspaceCalls).toEqual([])
  expect((await t.send("GET", `observe?repo=org%2Frepo&job=issues&requestId=${input.requestId}`)).status).toBe(503)
  await t.settle()
  expect(t.calls).toEqual([])
  expect(t.workspaceCalls).toEqual([])
  expect(t.durable.gatewayRows("alice").has("repository-setup:pending")).toBe(false)
  expect((t.durable.gatewayRows("alice").get(`repository-setup:request:${input.requestId}`) as SetupRecord).receipt.phase).toBe("queued")
})

test("registration failure and invalid legacy state stay independent; foreign activator is never an owned binding", async () => {
  const t = await fixture()
  t.options.registrations = [policyRow(initialSetup("org/repo", "issues", "alice"))]
  let recovered = await (await t.send("GET", "state?repo=org%2Frepo&job=issues", "bob")).json() as SetupRecoveryResponse
  expect(recovered.owner).toBe("bob")
  expect(recovered.registration.state === "known" && recovered.registration.active?.owned).toBe(false)
  expect(recovered.setup.state).toBe("none")
  t.durable.gatewayRows("alice").set(setupPointerKey("org/repo", "issues"), { sequence: 3, requestId: "missing" })
  recovered = await (await t.send("GET", "state?repo=org%2Frepo&job=issues")).json() as SetupRecoveryResponse
  expect(recovered.registration.state).toBe("known")
  expect(recovered.setup.state).toBe("unavailable")
  t.durable.gatewayRows("alice").delete(setupPointerKey("org/repo", "issues"))
  t.options.registrationError = true
  recovered = await (await t.send("GET", "state?repo=org%2Frepo&job=issues")).json() as SetupRecoveryResponse
  expect(recovered.registration.state).toBe("unavailable")
  expect(recovered.setup.state).toBe("none")
  expect(t.calls).toEqual([])
  expect(t.workspaceCalls).toEqual([])
  expect((await t.send("GET", "state?repo=org%2Frepo&job=issues", "")).status).toBe(401)
})

/*
 * A recorded run is read through a relay record that ages out in half a token
 * lifetime and a VM that idle-suspends under it, so an observation whose read
 * fails for either reason renews the record and resumes the box: the run is
 * the person's own, already on it. What the recovered observer still may not
 * do is allocate a workspace or replay Plan, Approval or Run.
 */
test.each(["expired", "missing", "sleeping"])("recovered observation with %s gateway renews its record without starting a workspace or replaying admission", async kind => {
  const t = await fixture()
  await t.send("POST", "apply", "alice", t.input); await t.settle()
  const before = { capabilities: t.capabilityCalls.length, workspace: t.workspaceCalls.length, writes: t.calls.filter(call => call.tag !== "Projection.Snapshot").length }
  const key = `gateway:org/repo\u0000${t.workspaceIds.alice}`
  const rows = t.durable.gatewayRows("alice")
  if (kind === "expired") rows.set(key, { ...rows.get(key) as object, renewAfter: 0 })
  else if (kind === "missing") rows.delete(key)
  else t.options.sleepBefore = "Projection.Snapshot"
  const response = await t.send("GET", `observe?repo=org%2Frepo&job=issues&requestId=${t.input.requestId}`)
  expect(response.status).toBe(202)
  expect((await response.json() as { receipt: { phase: string } }).receipt.phase).toBe("running")
  await t.settle()
  expect(t.capabilityCalls).toHaveLength(before.capabilities + 1)
  expect(t.workspaceCalls).toHaveLength(before.workspace)
  expect(t.calls.filter(call => call.tag !== "Projection.Snapshot")).toHaveLength(before.writes)
  expect(t.launched.size).toBe(1)
})

test.each(["401", "502"])("a relay that refuses the renewed read with %s is a failed read, never a phase", async kind => {
  const t = await fixture()
  await t.send("POST", "apply", "alice", t.input); await t.settle()
  const before = { workspace: t.workspaceCalls.length, writes: t.calls.filter(call => call.tag !== "Projection.Snapshot").length }
  t.options.relayStatus = Number(kind)
  expect((await t.send("GET", `observe?repo=org%2Frepo&job=issues&requestId=${t.input.requestId}`)).status).toBe(503)
  await t.settle()
  expect(t.workspaceCalls).toHaveLength(before.workspace)
  expect(t.calls.filter(call => call.tag !== "Projection.Snapshot")).toHaveLength(before.writes)
  expect(t.launched.size).toBe(1)
  expect((t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as SetupRecord).receipt.phase).toBe("running")
})

test.each(["source_revision", "flow_id", "mode", "digest", "workspace_id"])("registration recovery refuses inconsistent inner %s proof", async field => {
  const t = await fixture(), row = policyRow(initialSetup("org/repo", "issues", "alice"))
  Object.assign(row.configuration, { [field]: field === "mode" ? "trial" : field === "workspace_id" ? t.workspaceIds.bob : "different" })
  t.options.registrations = [row]
  const state = await (await t.send("GET", "state?repo=org%2Frepo&job=issues")).json() as SetupRecoveryResponse
  expect(state.registration.state).toBe("unavailable")
  expect(state.setup.state).toBe("none")
  expect(t.calls).toEqual([])
  expect(t.workspaceCalls).toEqual([])
})

test("a closed-alpha refusal at the Cloud token door reaches setup execution and recovery as the allowlist refusal", async () => {
  const t = await fixture()
  // The fixture's stub stays underneath: an unstubbed host still throws.
  const stubbed = globalThis.fetch
  globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
    const request = target instanceof Request ? target : new Request(String(target), init)
    return new URL(request.url).pathname === "/api/identity/cloud-token"
      ? Response.json({ found: false, cloud: { status: "NOT_ON_WAITLIST" } })
      : stubbed(request)
  }) as typeof fetch
  const refused = "account_not_allowlisted — This account isn't off the closed-alpha waitlist yet."
  expect((await t.send("POST", "evaluate", "alice", t.input)).status).toBe(202)
  await t.settle()
  const stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as SetupRecord
  expect(stored.observationError).toBe(refused)
  expect(stored.result).toBeUndefined()
  expect(t.workspaceCalls).toEqual([])
  const state = await (await t.send("GET", "state?repo=org%2Frepo&job=issues")).json() as SetupRecoveryResponse
  if (state.registration.state !== "unavailable") throw Error("Expected an unavailable registration")
  expect(state.registration.error).toBe(refused)
})

test("paused active and paused trial registrations remain distinct facts with no fabricated receipts", async () => {
  const t = await fixture(), active = policyRow(initialSetup("org/repo", "issues", "alice"), false)
  const trial = { ...active, id: "trial-registration", mode: "trial", configuration: { ...active.configuration, mode: "trial" } }
  t.options.registrations = [active, trial]
  const state = await (await t.send("GET", "state?repo=org%2Frepo&job=issues")).json() as SetupRecoveryResponse
  if (state.registration.state !== "known") throw Error("Expected actual registration state")
  expect(state.registration.active?.enabled).toBe(false)
  expect(state.registration.trial?.enabled).toBe(false)
  expect(state.registration.trial?.registrationId).toBe("trial-registration")
  expect(state.setup.state).toBe("none")
  expect(t.calls).toEqual([])
})

/*
 * A pinned workspace that Smithers Cloud no longer has. Seen in production on
 * 2026-09-17: the fixture's workspace was deleted, and `Inspect repository`
 * answered `503 {"message":"workspace not found"}` with the request wedged at
 * `phase: "queued"` and no `POST /workspaces` ever attempted.
 */
const REPLACEMENT_WORKSPACE = "33333333-3333-4333-8333-333333333333"
const WORKSPACE_GONE = "workspace_gone — The workspace behind this setup is gone. Not your fault; retry creates a new one."

test.each(["inspect", "evaluate", "trial", "apply"])("%s pinned to a deleted workspace allocates a replacement and keeps running", async operation => {
  const t = await fixture()
  t.options.lostWorkspace = t.workspaceIds.alice
  t.options.newWorkspace = REPLACEMENT_WORKSPACE
  expect((await t.send("POST", operation, "alice", { ...t.input, workspaceId: t.workspaceIds.alice })).status).toBe(202)
  await t.settle()
  expect(t.workspaceCalls).toEqual([
    { method: "GET", path: `/api/repos/org/repo/workspaces/${t.workspaceIds.alice}` },
    { method: "POST", path: "/api/repos/org/repo/workspaces", body: { kind: "vm", name: "Repository", required_capability: "repository-jobs/v1" } }
  ])
  const stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as SetupRecord
  expect(stored.workspaceId).toBe(REPLACEMENT_WORKSPACE)
  expect(stored.binding?.workspaceId).toBe(REPLACEMENT_WORKSPACE)
  expect(stored.observationError).toBeUndefined()
  expect(stored.receipt.phase).toBe("running")
  expect(stored.result).toBeUndefined()
  expect((t.calls.find(call => call.tag === "Plan")!.payload.input as { workspaceId: string }).workspaceId).toBe(REPLACEMENT_WORKSPACE)
  expect(t.launched.size).toBe(1)
  const response = await t.read()
  expect(response.status).toBe(202)
  expect((await response.json() as { workspaceId: string }).workspaceId).toBe(REPLACEMENT_WORKSPACE)
  await t.settle()
})

test("a retry carrying the adopted replacement pin is admitted; an unrelated pin is still refused", async () => {
  const t = await fixture()
  t.options.lostWorkspace = t.workspaceIds.alice
  t.options.newWorkspace = REPLACEMENT_WORKSPACE
  expect((await t.send("POST", "inspect", "alice", { ...t.input, workspaceId: t.workspaceIds.alice })).status).toBe(202)
  await t.settle()
  expect((t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as SetupRecord).workspaceId).toBe(REPLACEMENT_WORKSPACE)
  // The browser adopts the replacement on the poll that reports it, so every
  // later retry of the same request carries the replacement, not the dead pin.
  expect((await t.send("POST", "inspect", "alice", { ...t.input, workspaceId: REPLACEMENT_WORKSPACE })).status).toBe(202)
  expect((await t.send("POST", "inspect", "alice", { ...t.input, workspaceId: t.workspaceIds.alice })).status).toBe(202)
  const other = await t.send("POST", "inspect", "alice", { ...t.input, workspaceId: t.workspaceIds.bob })
  expect(other.status).toBe(409)
  // The refusal is typed and says what the next attempt does, so the app can
  // spend the id instead of rendering the store's internal sentence (B-15).
  expect(await other.json()).toMatchObject({ status: "error", code: "setup_request_conflict",
    message: "This setup request was already used for another operation. Not your fault; retry starts a new one." })
  await t.settle()
})

test("a deleted workspace on the bound gateway path settles a typed retryable failure whose repeat allocates", async () => {
  const t = await fixture()
  t.options.lostGateway = t.workspaceIds.alice
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, workspaceId: t.workspaceIds.alice })).status).toBe(202)
  await t.settle()
  const failed = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as SetupRecord
  expect(failed.receipt.phase).toBe("failed")
  expect(failed.receipt.error).toBe(WORKSPACE_GONE)
  expect(failed.result?.receipt?.error).toBe(WORKSPACE_GONE)
  expect(failed.observationError).toBeUndefined()
  expect(failed.binding).toBeUndefined()
  expect(t.calls).toEqual([])
  expect(t.launched.size).toBe(0)
  const settled = await t.read()
  expect(settled.status).toBe(200)
  expect((await settled.json() as { receipt: { error: string } }).receipt.error).toBe(WORKSPACE_GONE)
  // The deletion the gateway route saw first is visible on the workspace route
  // by the time the person asks again, and the repeat finishes the operation.
  t.options.lostWorkspace = t.workspaceIds.alice
  t.options.newWorkspace = REPLACEMENT_WORKSPACE
  t.options.runState = "completed"
  const repeat = { ...t.input, requestId: "setup-repeat", workspaceId: t.workspaceIds.alice }
  expect((await t.send("POST", "evaluate", "alice", repeat)).status).toBe(202)
  await t.settle()
  const done = t.durable.gatewayRows("alice").get(`repository-setup:request:${repeat.requestId}`) as SetupRecord
  expect(done.workspaceId).toBe(REPLACEMENT_WORKSPACE)
  expect(done.receipt.phase).toBe("completed")
  expect(t.launched.size).toBe(1)
})

test("a replacement Cloud refuses because the dead workspace still holds the binding settles typed", async () => {
  const t = await fixture()
  t.options.lostWorkspace = t.workspaceIds.alice
  t.options.boundReplacement = true
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, workspaceId: t.workspaceIds.alice })).status).toBe(202)
  await t.settle()
  const failed = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as SetupRecord
  expect(failed.receipt.phase).toBe("failed")
  expect(failed.receipt.error).toBe(WORKSPACE_GONE)
  expect(failed.result?.receipt?.error).toBe(WORKSPACE_GONE)
  expect(failed.observationError).toBeUndefined()
  expect(t.calls).toEqual([])
  const settled = await t.read()
  expect(settled.status).toBe(200)
  // A settled request leaves the observation queue instead of re-issuing the
  // refused GET and POST on every alarm tick.
  await t.durable.runGatewayAlarms()
  await t.settle()
  expect(t.workspaceCalls).toEqual([
    { method: "GET", path: `/api/repos/org/repo/workspaces/${t.workspaceIds.alice}` },
    { method: "POST", path: "/api/repos/org/repo/workspaces", body: { kind: "vm", name: "Repository", required_capability: "repository-jobs/v1" } }
  ])
})

test("a relay that refuses a bound call with Cloud's typed not-found settles instead of reprovisioning", async () => {
  const t = await fixture()
  const rows = t.durable.gatewayRows("alice")
  expect((await t.send("POST", "apply", "alice", t.input)).status).toBe(202)
  await t.settle()
  expect((rows.get(`repository-setup:request:${t.input.requestId}`) as SetupRecord).receipt.phase).toBe("running")
  const provisions = t.capabilityCalls.length
  t.options.lostRelay = true
  const observed = await t.send("GET", `observe?repo=org%2Frepo&job=issues&requestId=${t.input.requestId}`)
  expect(observed.status).toBe(200)
  expect((await observed.json() as { receipt: { error: string } }).receipt.error).toBe(WORKSPACE_GONE)
  await t.settle()
  const failed = rows.get(`repository-setup:request:${t.input.requestId}`) as SetupRecord
  expect(failed.receipt.phase).toBe("failed")
  expect(failed.receipt.error).toBe(WORKSPACE_GONE)
  expect(failed.observationError).toBeUndefined()
  // The provisioning leg reads the same refusal and settles on it rather than
  // re-POSTing the gateway route until the record's half-life passes.
  const repeat = { ...t.input, requestId: "setup-relay" }
  expect((await t.send("POST", "evaluate", "alice", repeat)).status).toBe(202)
  await t.settle()
  const second = rows.get(`repository-setup:request:${repeat.requestId}`) as SetupRecord
  expect(second.receipt.phase).toBe("failed")
  expect(second.receipt.error).toBe(WORKSPACE_GONE)
  expect(t.capabilityCalls).toHaveLength(provisions)
  expect(t.launched.size).toBe(1)
})

test("reconnecting a run-less setup states whether its workspace is gone or still answering", async () => {
  const t = await fixture()
  const legacy = (requestId: string): SetupRecord => ({ version: 0, observationError: "Expired",
    input: { ...t.input, requestId, operation: "apply", workspaceId: t.workspaceIds.alice },
    receipt: { requestId, revision: 1, digest: t.input.digest, operation: "apply", phase: "queued", updatedAt: 1, results: [], evidence: [] } })
  const rows = t.durable.gatewayRows("alice")
  rows.set("repository-setup:request:setup-gone", legacy("setup-gone"))
  rows.set("repository-setup:request:setup-alive", legacy("setup-alive"))
  t.options.lostWorkspace = t.workspaceIds.alice
  const gone = await t.send("GET", "observe?repo=org%2Frepo&job=issues&requestId=setup-gone")
  expect(gone.status).toBe(200)
  const body = await gone.json() as { receipt: { phase: string; error: string } }
  expect(body.receipt.phase).toBe("failed")
  expect(body.receipt.error).toBe(WORKSPACE_GONE)
  await t.settle()
  expect(t.workspaceCalls).toEqual([{ method: "GET", path: `/api/repos/org/repo/workspaces/${t.workspaceIds.alice}` }])
  expect(t.calls).toEqual([])
  expect(t.launched.size).toBe(0)
  // The dead end belongs to a request with no run record AND a live workspace.
  t.options.lostWorkspace = undefined
  const alive = await t.send("GET", "observe?repo=org%2Frepo&job=issues&requestId=setup-alive")
  expect(alive.status).toBe(503)
  expect((await alive.json() as { message: string }).message).toBe("The previous setup has no recorded run to reconnect. Its execution state is unknown.")
  expect((rows.get("repository-setup:request:setup-alive") as SetupRecord).receipt.phase).toBe("queued")
  await t.settle()
})

/*
 * Canary walk run 3, step B3-10: a reload while a trial ran left the card on
 * "No live workspace holds an answer for this read." with a Reconnect control.
 * The recovered watch reads through the relay, and that relay record
 * had passed its renewal half-life while the run continued.
 */
test("a reload mid-run reads its recorded run through a renewed relay instead of asking the person to reconnect", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const before = { workspace: t.workspaceCalls.length, writes: t.calls.filter(call => call.tag !== "Projection.Snapshot").length }
  const key = `gateway:org/repo\u0000${t.workspaceIds.alice}`
  const rows = t.durable.gatewayRows("alice")
  rows.set(key, { ...rows.get(key) as object, renewAfter: 0 })
  t.options.runState = "completed"
  const response = await t.send("GET", `observe?repo=org%2Frepo&job=issues&requestId=${t.input.requestId}`)
  expect(response.status).toBe(200)
  expect((await response.json() as { receipt: { phase: string } }).receipt.phase).toBe("completed")
  await t.settle()
  // Nothing was admitted: no workspace allocated, no Plan, Approval or Run frame.
  expect(t.workspaceCalls).toHaveLength(before.workspace)
  expect(t.calls.filter(call => call.tag !== "Projection.Snapshot")).toHaveLength(before.writes)
  expect(t.launched.size).toBe(1)
})


test("polls and alarms do not duplicate an advance held at the workspace seam", async () => {
  const t = await fixture(), held = gate(), entered = gate()
  t.options.beforeWorkspace = held.wait
  t.options.onWorkspace = entered.release
  let alarm: Promise<void> | undefined
  try {
    expect((await t.send("POST", "evaluate", "alice", t.input)).status).toBe(202)
    await entered.wait
    const polls = await Promise.all(Array.from({ length: 4 }, () => t.read()))
    expect(polls.every(response => response.status === 202)).toBe(true)
    alarm = t.durable.runGatewayAlarms()
    held.release()
    await alarm
    await t.settle()
    expect(t.workspaceCalls.filter(call => call.method === "POST")).toHaveLength(1)
    expect(t.calls.filter(call => call.tag === "Plan")).toHaveLength(1)
    expect(t.calls.filter(call => call.tag === "Run")).toHaveLength(1)
  } finally { held.release(); await alarm; await t.settle() }
})


test("expired setup leases recover and an old holder cannot release a successor", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input)
  await t.settle()
  const stub = t.durable.GATEWAY_SESSIONS.get(t.durable.GATEWAY_SESSIONS.idFromName("alice"))
  const command = async (action: string, holder: string) => {
    const response = await stub.fetch(new Request("https://internal/repository-setup", { method: "POST", body: JSON.stringify({ action, holder, requestId: t.input.requestId }) }))
    expect(response.status).toBe(200)
    return response.json() as Promise<{ claimed?: boolean }>
  }
  expect(await command("claim", "old-holder")).toEqual({ claimed: true })
  expect(await command("claim", "contender")).toEqual({ claimed: false })
  t.durable.gatewayRows("alice").set(`repository-setup:lease:${t.input.requestId}`, { holder: "old-holder", until: Date.now() - 1 })
  expect(await command("claim", "new-holder")).toEqual({ claimed: true })
  await command("release", "old-holder")
  expect(await command("claim", "third-holder")).toEqual({ claimed: false })
  await command("release", "new-holder")
  expect(await command("claim", "third-holder")).toEqual({ claimed: true })
})
