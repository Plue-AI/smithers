/*
 * The workspace gateway seam, against a relay double: every projection and
 * operation lane runs added rides the one relay envelope, and the payload each
 * sends is the gateway's own procedure shape — a drift between this file and
 * the allowlisted procedures fails here, not in a browser.
 */
import { describe, expect, test } from "bun:test"
import { createGatewaySeam, INVALID_PLAN_CODE, INVALID_PROJECTION_CODE } from "./gateway"
import { GATEWAY_REFUSED, gatewayRefusalSentence } from "./GatewayFailureCopy"

interface RecordedCall {
  readonly repo: string
  readonly procedure: string
  readonly payload: unknown
  readonly workspaceId?: string
}

/** A relay double: records the envelope, answers one scripted payload (or refusal) per procedure. */
const relay = (answers: Readonly<Record<string, unknown>> = {}) => {
  const calls: Array<RecordedCall> = []
  const seam = createGatewaySeam({
    baseUrl: "https://app.test",
    bindingFor: () => ({ workspaceId: "box-1" }),
    fetch: async (url, init) => {
      expect(url).toBe("https://app.test/api/workflow/rpc")
      const body = JSON.parse(String(init?.body ?? "{}")) as RecordedCall
      calls.push(body)
      const answer = answers[body.procedure] ?? { ok: true, payload: {} }
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    },
    errorMessageOf: async (_response, fallback) => fallback
  })
  return { calls, seam }
}

const rowsAnswer = (rows: ReadonlyArray<unknown>) => ({
  ok: true,
  payload: { cursor: { projection: "test", runId: null, value: 0 }, rows }
})

/** The per-invocation nonce every control mutation mints: one `crypto.randomUUID()`, never the clock. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

const keysOf = (calls: ReadonlyArray<RecordedCall>): ReadonlyArray<string> =>
  calls.map((call) => String((call.payload as { idempotencyKey: unknown }).idempotencyKey))

test("HTTP workspace_starting keeps its typed code and Retry-After for a durable launch retry", async () => {
  const seam = createGatewaySeam({ baseUrl: "", bindingFor: () => ({ workspaceId: "box-1" }), fetch: async () => new Response(JSON.stringify({ code: "workspace_starting", message: "Waking up" }),
    { status: 503, headers: { "Retry-After": "10" } }), errorMessageOf: async () => "Waking up" })
  expect(await seam.launch("o/r", "review", {})).toEqual({ status: "error", code: "workspace_starting", message: "Waking up", retryAfterSeconds: 10 })
})

test("a recovered launch sends the persisted key to Plan and the same plan identity to approval and Run", async () => {
  const { seam, calls } = relay({ Plan: { ok: true, payload: { planId: "p", digest: "d", envelope: {} } }, Run: { ok: true, payload: { runId: "r" } } })
  const request = { idempotencyKey: "saved-request", stillCurrent: () => true }
  await seam.launch("o/r", "review", { args: "inspect" }, { workspaceId: "box-1" }, request)
  await seam.launch("o/r", "review", { args: "inspect" }, { workspaceId: "box-1" }, request)
  expect(keysOf(calls)).toEqual(["plan:saved-request", "approve:p", "run:p", "plan:saved-request", "approve:p", "run:p"])
})

test("a superseded Plan response cannot authorize approval or Run", async () => {
  let current = true
  const calls: string[] = []
  const seam = createGatewaySeam({ baseUrl: "", bindingFor: () => ({ workspaceId: "box-1" }), fetch: async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)).procedure)
    current = false
    return Response.json({ ok: true, payload: { planId: "p", digest: "d", envelope: {} } })
  }, errorMessageOf: async () => "Unavailable" })
  expect(await seam.launch("o/r", "review", {}, { workspaceId: "box-1" }, { idempotencyKey: "old", stillCurrent: () => current })).toMatchObject({ status: "error", code: "request_superseded" })
  expect(calls).toEqual(["Plan"])
})

describe("the run lifecycle operations", () => {
  test("cancel carries the human's reason, defaulting to the standing one", async () => {
    const { calls, seam } = relay()
    expect((await seam.cancel("o/r", "run-1")).status).toBe("ok")
    expect((await seam.cancel("o/r", "run-1", "it hung")).status).toBe("ok")
    expect((await seam.cancel("o/r", "run-1", "  ")).status).toBe("ok")
    expect(calls.map((call) => call.payload)).toEqual([
      { runId: "run-1", idempotencyKey: "cancel:run-1", reason: "the human stopped it" },
      { runId: "run-1", idempotencyKey: "cancel:run-1", reason: "it hung" },
      { runId: "run-1", idempotencyKey: "cancel:run-1", reason: "the human stopped it" }
    ])
    expect(calls.every((call) => call.procedure === "Cancel" && call.repo === "o/r")).toBe(true)
  })

  test("resume sends the control mutation with an idempotency key and optional reason", async () => {
    const { calls, seam } = relay()
    expect((await seam.resume("o/r", "run-1", "nothing was driving it")).status).toBe("ok")
    const payload = calls[0]?.payload as Record<string, unknown>
    expect(calls[0]?.procedure).toBe("Resume")
    expect(payload.runId).toBe("run-1")
    expect(payload.reason).toBe("nothing was driving it")
    expect(String(payload.idempotencyKey)).toMatch(new RegExp(`^resume:run-1:${UUID}$`))
  })

  test("signal sends the named signal with its JSON payload", async () => {
    const { calls, seam } = relay()
    expect((await seam.signal("o/r", "run-1", "deploy-done", { ok: true })).status).toBe("ok")
    const payload = calls[0]?.payload as Record<string, unknown>
    expect(calls[0]?.procedure).toBe("Signal")
    expect(payload.runId).toBe("run-1")
    expect(payload.signal).toEqual({ name: "deploy-done", payload: { ok: true } })
    expect(String(payload.idempotencyKey)).toMatch(new RegExp(`^signal:run-1:deploy-done:${UUID}$`))
  })

  test("a signal without a payload sends the empty object", async () => {
    const { calls, seam } = relay()
    await seam.signal("o/r", "run-1", "deploy-done", undefined)
    expect((calls[0]?.payload as { signal: unknown }).signal).toEqual({ name: "deploy-done", payload: {} })
  })

  test("every mutation mints its own key, so two acts in one millisecond stay two", async () => {
    const realNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      const { calls, seam } = relay()
      await seam.resume("o/r", "run-1")
      await seam.resume("o/r", "run-1")
      await seam.signal("o/r", "run-1", "next", {})
      await seam.signal("o/r", "run-1", "next", {})
      await seam.steer("o/r", "run-1", { kind: "Seat", seat: "one" })
      await seam.steer("o/r", "run-1", { kind: "Thinking", thinking: "high" })
      const keys = keysOf(calls)
      expect(keys).toHaveLength(6)
      expect(new Set(keys).size).toBe(6)
      // The steer envelope carries its own identity, and it is per invocation too.
      const messageIds = calls.slice(4).map((call) =>
        String((call.payload as { message: { messageId: unknown } }).message.messageId)
      )
      expect(new Set(messageIds).size).toBe(2)
    } finally {
      Date.now = realNow
    }
  })

  test("a refusal crosses as a sentence; the control plane's words ride as detail", async () => {
    const { seam } = relay({ Signal: { ok: false, error: { message: "NoMatchingWait: no wait named deploy-done" } } })
    const result = await seam.signal("o/r", "run-1", "deploy-done", {})
    expect(result).toEqual({ status: "error", message: GATEWAY_REFUSED, detail: "NoMatchingWait: no wait named deploy-done" })
  })

  test("every control code and tag reads as its registry sentence", async () => {
    const coded = relay({ Signal: { ok: false, error: { message: "no wait named deploy-done", detail: { code: "no_matching_wait" } } } })
    expect(await coded.seam.signal("o/r", "run-1", "deploy-done", {})).toEqual({
      status: "error", message: "Nothing in that run is waiting for this.", code: "no_matching_wait", detail: "no wait named deploy-done"
    })
    const tagged = relay({ Signal: { ok: false, error: { message: "flow x", detail: [{ _tag: "Fail", error: { _tag: "/control/FlowNotFound" } }] } } })
    const answer = await tagged.seam.signal("o/r", "run-1", "deploy-done", {})
    expect(answer.status === "error" && answer.message).toBe("That flow isn't in this workspace.")
    for (const [code, tag] of [["persistence_failed", "/control/PersistenceError"], ["notification_full", "/notifications/NotificationError"]] as const) {
      expect(gatewayRefusalSentence(code)).toBe(gatewayRefusalSentence(tag))
      expect(gatewayRefusalSentence(code)).not.toBe(GATEWAY_REFUSED)
    }
    expect(gatewayRefusalSentence("some_future_code")).toBe(GATEWAY_REFUSED)
    expect(gatewayRefusalSentence(undefined)).toBe(GATEWAY_REFUSED)
  })
})

describe("steer", () => {
  const envelopeOf = (payload: unknown): Record<string, unknown> =>
    (payload as { message: Record<string, unknown> }).message

  test("an operator message carries the steer envelope and the body", async () => {
    const { calls, seam } = relay()
    expect((await seam.steer("o/r", "run-1", { kind: "Message", body: "use the smaller diff" })).status).toBe("ok")
    expect(calls[0]?.procedure).toBe("Steer")
    const payload = calls[0]?.payload as Record<string, unknown>
    expect(payload.runId).toBe("run-1")
    expect(String(payload.idempotencyKey)).toMatch(new RegExp(`^steer:run-1:${UUID}$`))
    const message = envelopeOf(calls[0]?.payload)
    expect(message.kind).toBe("Message")
    expect(message.body).toBe("use the smaller diff")
    expect(message.runId).toBe("run-1")
    expect(String(message.messageId)).toMatch(new RegExp(`^steer-run-1-${UUID}$`))
    // The placeholder principal the server overwrites with the authenticated one.
    expect(message.principal).toMatchObject({ kind: "user" })
    expect(typeof message.createdAt).toBe("number")
  })

  test("the seat, thinking, and tools variants carry their own fields", async () => {
    const { calls, seam } = relay()
    await seam.steer("o/r", "run-1", { kind: "Seat", seat: "anthropic:claude-opus-4-1" })
    await seam.steer("o/r", "run-1", { kind: "Thinking", thinking: "high" })
    await seam.steer("o/r", "run-1", { kind: "Tools", toolNames: ["bash", "edit"] })
    expect(envelopeOf(calls[0]?.payload)).toMatchObject({ kind: "Seat", seat: "anthropic:claude-opus-4-1" })
    expect(envelopeOf(calls[1]?.payload)).toMatchObject({ kind: "Thinking", thinking: "high" })
    expect(envelopeOf(calls[2]?.payload)).toMatchObject({ kind: "Tools", toolNames: ["bash", "edit"] })
  })
})

describe("the run projections", () => {
  /** A complete run summary, as the workspace-runs projection answers it. */
  const summaryRow = {
    runId: "run-1",
    flowId: "review-pr",
    status: "running" as const,
    createdAt: 1000,
    updatedAt: 2000,
    turns: 3,
    calls: 5,
    callsFailed: 0,
    editsAttempted: 1,
    editsSucceeded: 1,
    inputTokens: 100,
    outputTokens: 50,
    verdict: "running",
    diagnosis: "The run is moving."
  }
  /** A complete approval, as the approvals projection answers it. */
  const approvalRow = {
    runId: "run-1",
    requestId: "req-1",
    title: "Run the deploy script?",
    request: { question: "Run the deploy script?" },
    payload: {
      target: {
        _tag: "Node" as const,
        runId: "run-1",
        requestId: "req-1",
        digest: "sha256:test",
        envelope: { capabilities: [], flows: [], budget: { milliseconds: undefined, tokens: undefined } }
      },
      scope: "run" as const,
      idempotencyKey: "approve:req-1"
    },
    requestedAt: 1500,
    status: "pending" as const
  }

  test("workspaceRuns selects workspace-runs and answers the summary rows", async () => {
    const rows = [summaryRow]
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer(rows) })
    const result = await seam.workspaceRuns("o/r")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "workspace-runs" } })
    expect(result).toEqual({ status: "ok", value: rows })
  })

  test("approvalsInbox selects approvals WITHOUT a run id", async () => {
    const rows = [approvalRow]
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer(rows) })
    const result = await seam.approvalsInbox("o/r")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "approvals" } })
    expect(result).toEqual({ status: "ok", value: rows })
  })

  test("a run's approvals still select with its run id", async () => {
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer([]) })
    await seam.approvals("o/r", "run-1")
    expect(calls[0]?.payload).toEqual({ selector: { _tag: "approvals", runId: "run-1" } })
  })

  test("transcript and runEvents select their projections for the run", async () => {
    const line = { runId: "run-1", sequence: 1, turn: 1, at: 1000, kind: "turn.opened", text: "opened" }
    const lines = relay({ "Projection.Snapshot": rowsAnswer([line]) })
    const transcript = await lines.seam.transcript("o/r", "run-1")
    expect(lines.calls[0]?.payload).toEqual({ selector: { _tag: "transcript", runId: "run-1" } })
    expect(transcript).toEqual({ status: "ok", value: [line] })
    const event = { kind: "control.run.accepted", payload: {}, sequence: 1, occurredAt: 1000 }
    const journal = relay({ "Projection.Snapshot": rowsAnswer([event]) })
    const events = await journal.seam.runEvents("o/r", "run-1")
    expect(journal.calls[0]?.payload).toEqual({ selector: { _tag: "run-events", runId: "run-1" } })
    expect(events).toEqual({ status: "ok", value: [event] })
  })

  test("a valid empty rows array is the empty listing", async () => {
    const { seam } = relay({ "Projection.Snapshot": rowsAnswer([]) })
    expect(await seam.workspaceRuns("o/r")).toEqual({ status: "ok", value: [] })
  })

  test("a snapshot the served schema rejects is a refusal, never an empty workspace", async () => {
    // A missing envelope, a null row, and a row whose fields the gateway never
    // serves: each is a malformed answer, and reading it as [] would tell the
    // human this workspace has no runs.
    for (
      const payload of [
        { cursor: {} },
        { cursor: {}, rows: "all of them" },
        rowsAnswer([null]).payload,
        rowsAnswer([{ runId: 42, status: "invented" }]).payload
      ]
    ) {
      const { seam } = relay({ "Projection.Snapshot": { ok: true, payload } })
      expect(await seam.workspaceRuns("o/r")).toEqual({
        status: "error",
        message: "The workspace answered with a projection I couldn't read.",
        code: INVALID_PROJECTION_CODE
      })
    }
  })

  test("a run whose summary row is malformed refuses instead of reading as no such run", async () => {
    const { seam } = relay({ "Projection.Snapshot": rowsAnswer([{ ...summaryRow, status: "invented" }]) })
    const result = await seam.run("o/r", "run-1")
    expect(result.status).toBe("error")
    expect(result).toMatchObject({ code: INVALID_PROJECTION_CODE })
  })

  test("an approvals inbox row the schema rejects refuses instead of reading as no gates", async () => {
    const { seam } = relay({ "Projection.Snapshot": rowsAnswer([{ ...approvalRow, payload: { scope: "run" } }]) })
    expect((await seam.approvalsInbox("o/r")).status).toBe("error")
  })
})

describe("owning workspace binding", () => {
  test("pins Plan, approval and Run to the original selection and records it for the run", async () => {
    const first = "83e75ae5-0920-4000-8000-000000000001"
    let selected = first
    const calls: Array<{ procedure: string; workspaceId?: string }> = []
    const seam = createGatewaySeam({
      baseUrl: "https://app.test",
      bindingFor: () => ({ workspaceId: selected }),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        calls.push(body)
        selected = "83e75ae5-0920-4000-8000-000000000002"
        return new Response(JSON.stringify({ ok: true, payload: body.procedure === "Plan"
          ? { planId: "plan", digest: "digest", envelope: {} }
          : body.procedure === "Run" ? { runId: "run" } : {} }))
      },
      errorMessageOf: async (_response, fallback) => fallback
    })
    // The plan's identity comes back with the run: a run card snapshots the
    // plan it was approved on so its graph draws before any event arrives.
    expect(await seam.launch("o/r", "coding", { plan: {} }))
      .toEqual({ status: "ok", value: { runId: "run", planId: "plan", digest: "digest", workspaceId: first } })
    expect(calls.map((call) => call.workspaceId)).toEqual([first, first, first])
    expect(calls.map((call) => call.procedure)).toEqual(["Plan", "Approval.Submit", "Run"])
  })

  test("routes run projections and approvals by their run identity and refuses an invalid binding before transport", async () => {
    const ids: Array<string | undefined> = []
    let requests = 0
    const seam = createGatewaySeam({
      baseUrl: "https://app.test",
      bindingFor: (_repo, runId) => { ids.push(runId); return { error: "The run belongs to another repository." } },
      fetch: async () => { requests += 1; return new Response() },
      errorMessageOf: async (_response, fallback) => fallback
    })
    expect((await seam.runEvents("o/r", "run-1")).status).toBe("error")
    expect((await seam.cancel("o/r", "run-1")).status).toBe("error")
    expect(ids).toEqual(["run-1", "run-1"])
    expect(requests).toBe(0)
  })

  test("a call with no box refuses before transport, and every sent body names its box", async () => {
    const bodies: Array<Record<string, unknown>> = []
    let box: string | undefined
    const seam = createGatewaySeam({
      baseUrl: "https://app.test",
      bindingFor: () => box === undefined ? { error: "Open a box of o/r first: /box.open o/r" } : { workspaceId: box },
      fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, payload: { items: [] } }) },
      errorMessageOf: async (_response, fallback) => fallback
    })
    expect(await seam.listFlows("o/r")).toEqual({ status: "error", message: "Open a box of o/r first: /box.open o/r" })
    expect(await seam.launch("o/r", "review", {})).toEqual({ status: "error", message: "Open a box of o/r first: /box.open o/r" })
    expect(await seam.plan("o/r", "review", {})).toEqual({ status: "error", message: "Open a box of o/r first: /box.open o/r" })
    expect(bodies).toEqual([])
    box = "box-9"
    expect((await seam.listFlows("o/r")).status).toBe("ok")
    expect(bodies).toEqual([{ repo: "o/r", procedure: "List", payload: { _tag: "flows" }, workspaceId: "box-9" }])
  })
})

test("runEvents forwards the exact cursor and preserves the issued revision", async () => {
  const selector = { _tag: "run-events" as const, runId: "run-1" }
  const after = { selector, projection: "run-events" as const, runId: "run-1", value: 42, offset: 1 }
  const next = { ...after, value: 43, offset: 0 }
  const event = { kind: "control.run.accepted", payload: {}, sequence: 43, occurredAt: 1000 }
  const { calls, seam } = relay({ "Projection.Snapshot": { ok: true, payload: { rows: [event], cursor: next } } })
  expect(await seam.runEvents("o/r", "run-1", undefined, after)).toEqual({ status: "ok", value: [event], cursor: next })
  expect(calls[0]?.payload).toEqual({ selector, after })
  await seam.runEvents("o/r", "run-1")
  expect(calls[1]?.payload).toEqual({ selector })
})


test("an approval snapshot waits for resume with the original workspace binding", async () => {
  const requests: Array<Record<string, unknown>> = []
  const seam = createGatewaySeam({
    baseUrl: "https://app.test",
    bindingFor: () => ({ workspaceId: "box-1" }),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json(requests.length === 1
        ? { status: "provisioning", message: "resuming" }
        : rowsAnswer([]))
    },
    errorMessageOf: async (_response, fallback) => fallback
  })
  expect(await seam.approvalsInbox("o/r", { workspaceId: "workspace-a" })).toMatchObject({ status: "ok", value: [] })
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[1]?.workspaceId).toBe("workspace-a")
})

test("the flows list reads every page of a catalog past the first 100 flows (#3146)", async () => {
  const bodies: Array<Record<string, unknown>> = []
  const first = Array.from({ length: 100 }, (_, index) => ({ flowId: `flow-${index}`, description: "" }))
  const seam = createGatewaySeam({
    baseUrl: "https://app.test",
    bindingFor: () => ({ workspaceId: "box-1" }),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      const cursor = (body.payload as { cursor?: string }).cursor
      return Response.json(cursor === undefined
        ? { ok: true, payload: { _tag: "flows", items: first, nextCursor: "page-2" } }
        : { ok: true, payload: { _tag: "flows", items: [{ flowId: "flow-100", description: "last" }] } })
    },
    errorMessageOf: async (_response, fallback) => fallback
  })
  const listed = await seam.listFlows("o/r")
  expect(listed.status).toBe("ok")
  const flows = listed.status === "ok" ? listed.value : []
  expect(flows).toHaveLength(101)
  expect(flows[100]).toEqual({ flowId: "flow-100", description: "last" })
  expect(bodies.map((body) => body.payload)).toEqual([{ _tag: "flows" }, { _tag: "flows", cursor: "page-2" }])
  expect(bodies.every((body) => body.workspaceId === "box-1")).toBe(true)
})

test("a refused second flows page is the listing's refusal, never a truncated catalog", async () => {
  let calls = 0
  const seam = createGatewaySeam({
    baseUrl: "https://app.test",
    bindingFor: () => ({ workspaceId: "box-1" }),
    fetch: async () => {
      calls++
      return Response.json(calls === 1
        ? { ok: true, payload: { items: [{ flowId: "a" }], nextCursor: "page-2" } }
        : { ok: false, error: { detail: { code: "flow_not_found" }, message: "gone" } })
    },
    errorMessageOf: async (_response, fallback) => fallback
  })
  const listed = await seam.listFlows("o/r")
  expect(listed.status).toBe("error")
  expect(calls).toBe(2)
})

test("the flows list waits while a box's coding host starts (#2198)", async () => {
  let calls = 0
  const seam = createGatewaySeam({
    baseUrl: "https://app.test",
    bindingFor: () => ({ workspaceId: "box-1" }),
    fetch: async () => {
      calls++
      return Response.json(calls === 1 ? { status: "provisioning" } : { ok: true, payload: { items: [] } })
    },
    errorMessageOf: async (_response, fallback) => fallback
  })
  expect(await seam.listFlows("o/r")).toMatchObject({ status: "ok", value: [] })
  expect(calls).toBe(2)
}, 10_000)

test("a consequential gateway call does not retry a provisioning response", async () => {
  let calls = 0
  const seam = createGatewaySeam({
    baseUrl: "https://app.test",
    bindingFor: () => ({ workspaceId: "box-1" }),
    fetch: async () => { calls++; return Response.json({ status: "provisioning", message: "resuming" }) },
    errorMessageOf: async (_response, fallback) => fallback
  })
  expect(await seam.call("o/r", "Run", {})).toEqual({
    status: "error", message: "The workspace is still starting. Try again in a moment.", detail: "resuming"
  })
  expect(calls).toBe(1)
})

test("a resuming snapshot stops when its session changes", async () => {
  let owned = true
  let calls = 0
  const seam = createGatewaySeam({
    baseUrl: "https://app.test",
    bindingFor: () => ({ workspaceId: "box-1" }),
    observationGuard: () => () => owned,
    fetch: async () => {
      calls++
      owned = false
      return Response.json({ status: "provisioning", message: "resuming" })
    },
    errorMessageOf: async (_response, fallback) => fallback
  })
  expect(await seam.approvalsInbox("o/r")).toMatchObject({ status: "error" })
  expect(calls).toBe(1)
})

/*
 * The plan door: what a flow WOULD run, before anything runs. The card is the
 * control plane's own signed value, so the seam decodes it against
 * @smthrs/control's schema rather than reading fields off a bare record, and
 * the signed envelope never comes back out of here into a card payload
 * (payloads are written to disk).
 */
const planNode = (id: string, dependsOn: ReadonlyArray<string> = []) => ({
  id,
  kind: "step",
  key: `key1_${"0".repeat(64)}`,
  material: { version: "flows/key-material/v2", kind: "sealed", body: { action: "shell" }, inputs: [], layers: [], capabilities: [] },
  effects: { reads: [], writes: [], boundaryMode: "hard" },
  dependsOn,
  conflicts: [],
  strategy: "serialize",
  runtime: "delay-rebase",
  priority: 0,
  generation: 0,
  status: "run"
})

const planCard = (nodes: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) => ({
  ok: true,
  payload: {
    planId: "plan-1",
    flowId: "review",
    digest: "d".repeat(64),
    inputSummary: "{}",
    envelope: { capabilities: [], flows: [], budget: {} },
    deployClass: false,
    nodes,
    approval: {
      target: { _tag: "Plan", planId: "plan-1", digest: "d".repeat(64), envelope: { capabilities: [], flows: [], budget: {} } },
      scope: "run",
      idempotencyKey: "approve:plan-1"
    },
    ...extra
  }
})

describe("planning a flow", () => {
  test("decodes the card's keyed nodes and sends the gateway's own Plan payload", async () => {
    const { calls, seam } = relay({ Plan: planCard([planNode("a"), planNode("b", ["a"])]) })
    const planned = await seam.plan("o/r", "review", { pr: 1 })
    expect(planned.status).toBe("ok")
    if (planned.status !== "ok") return
    expect(planned.value.planId).toBe("plan-1")
    expect(planned.value.digest).toBe("d".repeat(64))
    expect(planned.value.flowId).toBe("review")
    expect(planned.value.nodes.map((node) => [node.id, [...node.dependsOn]])).toEqual([["a", []], ["b", ["a"]]])
    expect(calls).toEqual([{ repo: "o/r", procedure: "Plan", payload: { flowId: "review", input: { pr: 1 } }, workspaceId: "box-1" }])
  })

  test("carries the labelled edges when the workspace reports them", async () => {
    const { seam } = relay({
      Plan: planCard([planNode("a"), planNode("b", ["a"])], { graph: { edges: [{ from: "a", to: "b", reason: "continuation" }] } })
    })
    const planned = await seam.plan("o/r", "review", {})
    expect(planned.status === "ok" && planned.value.graph?.edges).toEqual([{ from: "a", to: "b", reason: "continuation" }])
  })

  test("a workspace that graphs nothing plans an empty graph, not a refusal", async () => {
    const { seam } = relay({ Plan: planCard([]) })
    const planned = await seam.plan("o/r", "review", {})
    expect(planned.status).toBe("ok")
    expect(planned.status === "ok" && planned.value.nodes).toEqual([])
    expect(planned.status === "ok" && planned.value.graph).toBeUndefined()
  })

  test("a card the control schema rejects is a coded refusal, never an empty plan", async () => {
    const { seam } = relay({ Plan: { ok: true, payload: { planId: "plan-1" } } })
    const planned = await seam.plan("o/r", "review", {})
    expect(planned.status).toBe("error")
    expect(planned.status === "error" && planned.code).toBe(INVALID_PLAN_CODE)
  })

  test("the signed envelope never leaves the seam", async () => {
    const { seam } = relay({ Plan: planCard([planNode("a")]) })
    const planned = await seam.plan("o/r", "review", {})
    expect(planned.status === "ok" && Object.keys(planned.value).includes("envelope")).toBe(false)
    expect(JSON.stringify(planned)).not.toContain("approval")
  })

  test("launch reuses the plan and hands its nodes back with the run", async () => {
    const { calls, seam } = relay({
      Plan: planCard([planNode("a"), planNode("b", ["a"])]),
      Run: { ok: true, payload: { runId: "run-9" } }
    })
    const launched = await seam.launch("o/r", "review", {})
    expect(launched.status === "ok" && launched.value.runId).toBe("run-9")
    expect(launched.status === "ok" && launched.value.nodes?.map((node) => node.id)).toEqual(["a", "b"])
    expect(calls.map((call) => call.procedure)).toEqual(["Plan", "Approval.Submit", "Run"])
  })
})

describe("a flow's measured durations", () => {
  const durationRow = (actionTag: string, extra: Record<string, unknown> = {}) => ({
    flowId: "review",
    actionTag,
    samples: 4,
    p50Ms: 1_200,
    p90Ms: 3_000,
    ...extra
  })

  test("asks for the flow's own projection and decodes the rows it serves", async () => {
    const { calls, seam } = relay({ "Projection.Snapshot": rowsAnswer([durationRow("acme/Build"), durationRow("acme/Test")]) })
    const durations = await seam.flowDurations("o/r", "review")
    expect(durations.status).toBe("ok")
    expect(durations.status === "ok" && durations.value.map((row) => row.actionTag)).toEqual(["acme/Build", "acme/Test"])
    expect(calls).toEqual([{
      repo: "o/r",
      procedure: "Projection.Snapshot",
      payload: { selector: { _tag: "flow-durations", flowId: "review" } },
      workspaceId: "box-1"
    }])
  })

  test("a flow nothing has measured has no rows, which is not a refusal", async () => {
    const { seam } = relay({ "Projection.Snapshot": rowsAnswer([]) })
    const durations = await seam.flowDurations("o/r", "review")
    expect(durations.status === "ok" && durations.value).toEqual([])
  })

  test("a row the served schema rejects is a coded refusal, never a prediction", async () => {
    const { seam } = relay({ "Projection.Snapshot": rowsAnswer([{ flowId: "review", actionTag: "acme/Build" }]) })
    const durations = await seam.flowDurations("o/r", "review")
    expect(durations.status === "error" && durations.code).toBe(INVALID_PROJECTION_CODE)
  })

  test("a box whose selector union has no such projection refuses, and no row is invented", async () => {
    const { seam } = relay({
      "Projection.Snapshot": { ok: false, error: { message: "Unknown selector", detail: [{ _tag: "Fail", error: { _tag: "ParseError" } }] } }
    })
    const durations = await seam.flowDurations("o/r", "review")
    expect(durations.status).toBe("error")
    expect(durations.status === "error" && durations.message).toBe(GATEWAY_REFUSED)
    expect(durations.status === "error" && durations.detail).toBe("Unknown selector")
  })
})

test("a USD budget park keeps its raised dollar ceiling from the inbox read to the submitted approval", async () => {
  const target = {
    _tag: "Node" as const, runId: "run-1", requestId: "budget/run-1/usd", digest: "d",
    envelope: { capabilities: [], flows: [], budget: { usd: 2.2, onExceeded: "park" as const } }
  }
  const row = {
    runId: "run-1", requestId: target.requestId, title: "Raise the USD budget from $1.00 to $2.20?", request: { question: "Raise the USD budget from $1.00 to $2.20?" },
    requestedAt: 1, status: "pending" as const, payload: { target, scope: "once" as const, idempotencyKey: "approve:budget" }
  }
  const { seam, calls } = relay({
    "Projection.Snapshot": rowsAnswer([row]),
    "Approval.Submit": { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "approve:budget", runId: "run-1" } } }
  })
  const inbox = await seam.approvalsInbox("o/r")
  expect(inbox).toEqual({ status: "ok", value: [row] })
  if (inbox.status !== "ok") throw new Error("expected the inbox")
  expect(await seam.submitApproval("o/r", inbox.value[0]!.payload, "approve")).toMatchObject({ status: "ok" })
  expect(calls[1]).toMatchObject({
    procedure: "Approval.Submit",
    payload: { target: { envelope: { budget: { usd: 2.2, onExceeded: "park" } } }, decision: "approve" }
  })
})

test("registration inbox pages retain the registrant's workspace and canonical approval", async () => {
  const row = {
    runId: "run-1", requestId: "register-repository/review#1", title: "Register someone/repo?", request: { name: "register-repository/review" },
    requestedAt: 1, status: "pending",
    payload: { target: { _tag: "Node", runId: "run-1", requestId: "register-repository/review#1", digest: "wait-token", envelope: { capabilities: [], flows: [], budget: {} } }, scope: "once", idempotencyKey: "answer-1" }
  }
  const { seam, calls } = relay({
    "Registration.Reviews": { ok: true, payload: { inboxes: [{ repo: "someone/repo", workspaceId: "registrant-box", rows: [row] }], next: "" } },
    "Approval.Submit": { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "answer-1", runId: "run-1" } } }
  })
  expect(await seam.registrationInboxes("will/repo", { workspaceId: "admin-box" })).toMatchObject({ status: "ok", value: [{ repo: "someone/repo", workspaceId: "registrant-box", rows: [row] }] })
  await seam.submitApproval("someone/repo", row.payload as never, "approve", { workspaceId: "registrant-box" }, "Decline")
  expect(calls[1]).toMatchObject({ procedure: "Approval.Submit", workspaceId: "registrant-box", payload: { ...row.payload, decision: "approve", answer: "Decline" } })
})
