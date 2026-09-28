/**
 * The Worker's API, exercised through {@link handle} with stub bindings.
 *
 * `worker/index.ts` imports `cloudflare:workers` for the Durable Object class,
 * which only workerd resolves. `worker/router.ts` deliberately does not, so the
 * whole API can be driven on plain Node: every route is a call to `handle` with
 * a fake `Env` whose `SESSIONS` namespace hands back an in-memory double of
 * `AppSession`.
 *
 * What this covers is the routing contract: which object a route reaches, what
 * it refuses, and whether the body decodes with the schema in `src/api.ts`.
 * `AppSession`'s own storage, what a turn writes, what a recreated object reads
 * back, and how overlapping turns and cancels settle, is `appSession.test.ts`,
 * which constructs the real class over SQLite. The double's `state` and
 * `listFlows` here return whatever a test planted, so an assertion on them
 * proves only that the router reached the right object.
 */
import { authorized, MAX_BODY_BYTES } from "@smthrs/create-app/http"
import type { FlowRunCard } from "@smthrs/create-app/ui"
import * as Schema from "effect/Schema"
import { beforeEach, describe, expect, test } from "vitest"
import {
  type AppCard,
  CancelResponse,
  FlowList,
  FlowRunResponse,
  type FlowSummary,
  Routes,
  SessionList,
  SessionState,
  type SessionSummary
} from "../src/api.ts"
import type { Env } from "../worker/env.ts"
import { type Phase, runFlowRun } from "../worker/flowRunImpl.ts"
import { isSessionId } from "../worker/guard.ts"
import { INDEX_SESSION } from "../worker/registry.ts"
import { handle } from "../worker/router.ts"
import { nodeHost, scriptedSeat } from "./support/recordedHost.ts"

// ---------------------------------------------------------------------------
// The doubles
// ---------------------------------------------------------------------------

/**
 * An in-memory `AppSession`.
 *
 * Only the methods the router calls are implemented, and each one records what
 * it was called with, so a test asserts on the call rather than on state the
 * router never reads back.
 */
class FakeSession {
  readonly turns: Array<unknown> = []
  readonly runs: Array<unknown> = []
  readonly cancels: Array<string> = []
  readonly rows: Array<SessionSummary> = []
  cards: Array<AppCard> = []
  saved: Array<FlowSummary> = []
  cancelled = true

  constructor(readonly name: string) {}

  turn(request: unknown): Response {
    this.turns.push(request)
    return new Response(`{"type":"done","output":null}\n`, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8" }
    })
  }

  cancel(sessionId: string): { cancelled: boolean } {
    this.cancels.push(sessionId)
    return { cancelled: this.cancelled }
  }

  state(id: string): typeof SessionState.Type {
    return { id, messages: [], cards: this.cards, busy: false }
  }

  listFlows(): ReadonlyArray<FlowSummary> {
    return this.saved
  }

  runFlow(request: { readonly flowId: string }): { executionId: string } {
    this.runs.push(request)
    return { executionId: `exec-${this.runs.length}` }
  }

  sessions(): ReadonlyArray<SessionSummary> {
    return this.rows
  }
}

interface Harness {
  readonly env: Env
  /** The double for one session id, created on first reference. */
  readonly session: (id: string) => FakeSession
  /** Every request that fell through to the assets binding. */
  readonly assetRequests: Array<string>
}

const harness = (): Harness => {
  const sessions = new Map<string, FakeSession>()
  const assetRequests: Array<string> = []
  const session = (id: string): FakeSession => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const created = new FakeSession(id)
    sessions.set(id, created)
    return created
  }
  const env = {
    APP_NAME: "aomi",
    APP_API_OPEN: "1",
    // The id is the name: a Durable Object id is opaque to the router, which
    // only ever passes it straight back to `get`.
    SESSIONS: {
      idFromName: (name: string) => name,
      get: (id: string) => session(id)
    },
    ASSETS: {
      fetch: (request: Request) => {
        assetRequests.push(new URL(request.url).pathname)
        return Promise.resolve(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }))
      }
    }
  } as unknown as Env
  return { env, session, assetRequests }
}

const get = (path: string): Request => new Request(`https://aomi.smithers.sh${path}`)

const post = (path: string, body: unknown): Request =>
  new Request(`https://aomi.smithers.sh${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

let app: Harness

beforeEach(() => {
  app = harness()
})

// ---------------------------------------------------------------------------
// Health and fallthrough
// ---------------------------------------------------------------------------

describe("GET /api/health", () => {
  test("reports the app name and build without disclosing authentication configuration", async () => {
    const response = await handle(get(Routes.health), app.env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, build: "dev", app: "aomi" })
  })
})

describe("fallthrough", () => {
  test("an unrouted /api path is this Worker's own 404, not the SPA's", async () => {
    const response = await handle(get("/api/nope"), app.env)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "No route for /api/nope." })
    expect(app.assetRequests).toEqual([])
  })

  test("every other path is served by the assets binding", async () => {
    const response = await handle(get("/build/deep/link"), app.env)
    expect(response.status).toBe(200)
    expect(app.assetRequests).toEqual(["/build/deep/link"])
  })
})

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

describe("POST /api/agent/turn", () => {
  test("forwards to the object named by sessionId and streams its body back", async () => {
    const turn = { sessionId: "s1", flowId: "chat", message: "balance of vitalik.eth" }
    const response = await handle(post(Routes.turn, turn), app.env)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/x-ndjson")
    expect(await response.text()).toBe(`{"type":"done","output":null}\n`)
    expect(app.session("s1").turns).toEqual([turn])
    expect(app.session("s2").turns).toEqual([])
  })

  test("refuses a pipeline flow and names the route that does take it", async () => {
    const response = await handle(post(Routes.turn, { sessionId: "s1", flowId: "build", message: "hi" }), app.env)
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toContain(Routes.flowRun)
    expect(app.session("s1").turns).toEqual([])
  })

  test("refuses an unrouted flow without waking the session", async () => {
    const response = await handle(post(Routes.turn, { sessionId: "s1", flowId: "saved/arb", message: "hi" }), app.env)
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toContain("saved/arb")
    expect(app.session("s1").turns).toEqual([])
  })

  test("refuses a body that is not a TurnRequest", async () => {
    const response = await handle(post(Routes.turn, { sessionId: "s1", flowId: "chat" }), app.env)
    expect(response.status).toBe(400)
    expect(app.session("s1").turns).toEqual([])
  })

  test("refuses a body that is not JSON", async () => {
    const request = new Request(`https://aomi.smithers.sh${Routes.turn}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json"
    })
    expect((await handle(request, app.env)).status).toBe(400)
  })

  test("refuses a GET", async () => {
    expect((await handle(get(Routes.turn), app.env)).status).toBe(405)
  })
})

describe("POST /api/agent/turn/cancel", () => {
  test("aborts the named session and answers with what it did", async () => {
    const response = await handle(post(Routes.turnCancel, { sessionId: "s1" }), app.env)
    expect(response.status).toBe(200)
    expect(Schema.decodeUnknownSync(CancelResponse)(await response.json())).toEqual({ cancelled: true })
    expect(app.session("s1").cancels).toEqual(["s1"])
  })

  test("reports a session that had nothing to abort", async () => {
    app.session("s1").cancelled = false
    const response = await handle(post(Routes.turnCancel, { sessionId: "s1" }), app.env)
    expect(Schema.decodeUnknownSync(CancelResponse)(await response.json())).toEqual({ cancelled: false })
  })

  test("refuses a body with no sessionId", async () => {
    expect((await handle(post(Routes.turnCancel, {}), app.env)).status).toBe(400)
  })

  test("refuses a GET", async () => {
    expect((await handle(get(Routes.turnCancel), app.env)).status).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("GET /api/session", () => {
  test("with no id, reads the registry object and answers a SessionList", async () => {
    app.session(INDEX_SESSION).rows.push({ id: "s1", title: "arb bot", status: "ready", stage: "build", at: 7 })
    const response = await handle(get(Routes.session), app.env)
    expect(response.status).toBe(200)
    expect(Schema.decodeUnknownSync(SessionList)(await response.json())).toEqual({
      sessions: [{ id: "s1", title: "arb bot", status: "ready", stage: "build", at: 7 }]
    })
  })

  test("a Worker with no runs answers an empty column, not a 404", async () => {
    const response = await handle(get(Routes.session), app.env)
    expect(response.status).toBe(200)
    expect(Schema.decodeUnknownSync(SessionList)(await response.json())).toEqual({ sessions: [] })
  })

  test("an empty id is the list form, not a session named the empty string", async () => {
    const response = await handle(get(`${Routes.session}?id=`), app.env)
    expect(Schema.decodeUnknownSync(SessionList)(await response.json())).toEqual({ sessions: [] })
  })

  test("with an id, answers that session's SessionState", async () => {
    app.session("s1").cards = [{ kind: "html", id: "c1", html: "<p>hi</p>" }]
    const response = await handle(get(`${Routes.session}?id=s1`), app.env)
    expect(response.status).toBe(200)
    expect(Schema.decodeUnknownSync(SessionState)(await response.json())).toEqual({
      id: "s1",
      messages: [],
      cards: [{ kind: "html", id: "c1", html: "<p>hi</p>" }],
      busy: false
    })
  })

  test("refuses a POST", async () => {
    expect((await handle(post(Routes.session, {}), app.env)).status).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

describe("GET /api/flows", () => {
  test("with no session, lists the routed flows only", async () => {
    const response = await handle(get(Routes.flows), app.env)
    expect(response.status).toBe(200)
    const { flows } = Schema.decodeUnknownSync(FlowList)(await response.json())
    expect(flows.every((flow) => flow.source === "file")).toBe(true)
    expect(flows.map((flow) => flow.id).sort()).toEqual(["build", "chat"])
  })

  test("reports which routed flows are chat flows", async () => {
    const { flows } = Schema.decodeUnknownSync(FlowList)(
      await (await handle(get(Routes.flows), app.env)).json()
    )
    expect(flows.find((flow) => flow.id === "chat")?.chat).toBe(true)
    expect(flows.find((flow) => flow.id === "build")?.chat).toBe(false)
  })

  test("with a session, appends that session's saved flows", async () => {
    app.session("s1").saved = [{ id: "arb", description: "arb scan", source: "saved", chat: false }]
    const { flows } = Schema.decodeUnknownSync(FlowList)(
      await (await handle(get(`${Routes.flows}?sessionId=s1`), app.env)).json()
    )
    expect(flows.filter((flow) => flow.source === "saved")).toEqual([
      { id: "arb", description: "arb scan", source: "saved", chat: false }
    ])
    // The routed flows come first, so a saved flow never hides a file one.
    expect(flows[flows.length - 1]?.id).toBe("arb")
  })

  test("refuses a POST", async () => {
    expect((await handle(post(Routes.flows, {}), app.env)).status).toBe(405)
  })
})

describe("POST /api/flows/run", () => {
  test("starts a routed pipeline flow and answers with its execution id", async () => {
    const run = { sessionId: "s1", flowId: "build", payload: { app: "arb", prompt: "build it" } }
    const response = await handle(post(Routes.flowRun, run), app.env)
    expect(response.status).toBe(200)
    expect(Schema.decodeUnknownSync(FlowRunResponse)(await response.json())).toEqual({ executionId: "exec-1" })
    expect(app.session("s1").runs).toEqual([run])
  })

  test("refuses a chat flow and names the route that does take it", async () => {
    const response = await handle(post(Routes.flowRun, { sessionId: "s1", flowId: "chat", payload: {} }), app.env)
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toContain(Routes.turn)
    expect(app.session("s1").runs).toEqual([])
  })

  test("refuses an unrouted flow without waking the session", async () => {
    const response = await handle(post(Routes.flowRun, { sessionId: "s1", flowId: "saved/arb", payload: {} }), app.env)
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toContain("saved/arb")
    expect(app.session("s1").runs).toEqual([])
  })

  test("refuses a body that is not a FlowRunRequest", async () => {
    expect((await handle(post(Routes.flowRun, { flowId: "build" }), app.env)).status).toBe(400)
  })

  test("refuses a GET", async () => {
    expect((await handle(get(Routes.flowRun), app.env)).status).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

/**
 * A flow run on the real host. The seat answers with one scripted cell that
 * returns a plan, so what is proven is the card: one id, the steps the flow
 * reported, and the phase the run ended on.
 */
describe("runFlowRun", () => {
  const plan = nodeHost(scriptedSeat(`await ctx.done({
    name: "arb",
    summary: "An arbitrage scanner.",
    files: [],
    steps: [{ name: "plan", status: "done" }, { name: "smoke", status: "pending" }]
  })`))

  const runCards = async (
    flowId: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<{ readonly phase: Phase; readonly cards: ReadonlyArray<FlowRunCard> }> => {
    const cards: Array<FlowRunCard> = []
    const phase = await runFlowRun({
      env: { APP_NAME: "aomi" } as Env,
      session: { writeFlow: () => ({ files: [] }), listFlows: () => [] },
      request: { sessionId: "s1", flowId, payload: { app: "arb", prompt: "build it" } },
      executionId: "exec-1",
      seams: plan,
      signal,
      emit: (frame) => {
        if (frame.type === "card.update" && frame.card.kind === "flow-run") cards.push(frame.card)
      }
    })
    return { phase, cards }
  }

  test("settles its one card completed with the steps the flow reported", async () => {
    const { phase, cards } = await runCards("build")
    expect(phase).toBe("completed")
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: "exec-1",
      executionId: "exec-1",
      phase: "completed",
      steps: [{ name: "plan", status: "done" }, { name: "smoke", status: "done" }],
      result: { name: "arb" }
    })
    expect(cards[0]?.error).toBeUndefined()
  })

  test("an aborted run settles cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const { phase, cards } = await runCards("build", controller.signal)
    expect(phase).toBe("cancelled")
    expect(cards.map((card) => card.phase)).toEqual(["cancelled"])
  })

  test("an unrouted flow and a chat flow settle failed and say why", async () => {
    const unrouted = await runCards("saved-arb")
    expect(unrouted.phase).toBe("failed")
    expect(unrouted.cards[0]?.error).toContain("saved-arb")
    const chat = await runCards("chat")
    expect(chat.phase).toBe("failed")
    expect(chat.cards[0]?.error).toContain("chat flow")
  })
})

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

/**
 * What a deployed instance is bounded by.
 *
 * The API shipped with no authentication, no request-size bound, and a Durable
 * Object addressed by whatever string the caller sent, while `CreateApp` ships
 * `deploy` as a first-class target with a custom domain. These cases pin the
 * three bounds that closed that: the shared token, the body cap, and the
 * session-id rule that stops a caller addressing the registry object.
 */
describe("guard", () => {
  describe("authorized", () => {
    const bearer = (value: string): Request =>
      new Request("https://aomi.smithers.sh/api/health", { headers: { authorization: value } })

    test("an unset token refuses even an arbitrary bearer header", () => {
      expect(authorized(get("/api/health"), undefined)).toBe(false)
      expect(authorized(bearer("Bearer anything"), undefined)).toBe(false)
    })

    test("a configured token admits its exact bearer header and nothing else", () => {
      expect(authorized(bearer("Bearer s3cret"), "s3cret")).toBe(true)
      expect(authorized(get("/api/health"), "s3cret")).toBe(false)
      expect(authorized(bearer("Bearer s3cre"), "s3cret")).toBe(false)
      expect(authorized(bearer("Bearer s3crett"), "s3cret")).toBe(false)
      expect(authorized(bearer("Bearer wrong!"), "s3cret")).toBe(false)
      expect(authorized(bearer("s3cret"), "s3cret")).toBe(false)
    })
  })

  describe("isSessionId", () => {
    test("accepts the ids the shell mints", () => {
      expect(isSessionId("ses_2f1c9a04-77e2-4d8d-8f8b-2d1b1e2a0c11")).toBe(true)
      expect(isSessionId("s1")).toBe(true)
    })

    test("refuses the registry object's own name, so it cannot be used as a session", () => {
      expect(isSessionId(INDEX_SESSION)).toBe(false)
    })

    test("refuses an empty, oversized, or structured id", () => {
      expect(isSessionId("")).toBe(false)
      expect(isSessionId("a".repeat(129))).toBe(false)
      expect(isSessionId("a".repeat(128))).toBe(true)
      expect(isSessionId("../etc")).toBe(false)
      expect(isSessionId("a/b")).toBe(false)
      expect(isSessionId("has space")).toBe(false)
      expect(isSessionId("-leading")).toBe(false)
    })
  })

  describe("with APP_API_TOKEN set", () => {
    const authed = (): Env => ({ ...app.env, APP_API_TOKEN: "s3cret" }) as Env
    const withToken = (request: Request): Request => {
      const next = new Request(request)
      next.headers.set("authorization", "Bearer s3cret")
      return next
    }

    test("health stays reachable without a token, so a deploy can be probed", async () => {
      const response = await handle(get(Routes.health), authed())
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, build: "dev", app: "aomi" })
    })

    test("health omits authentication configuration when no token is configured", async () => {
      expect(await (await handle(get(Routes.health), app.env)).json()).toEqual({
        ok: true,
        build: "dev",
        app: "aomi"
      })
    })

    const guarded: ReadonlyArray<readonly [string, () => Request]> = [
      [Routes.turn, () => post(Routes.turn, { sessionId: "s1", flowId: "chat", message: "hi" })],
      [Routes.turnCancel, () => post(Routes.turnCancel, { sessionId: "s1" })],
      [Routes.session, () => get(`${Routes.session}?id=s1`)],
      [Routes.flows, () => get(Routes.flows)],
      [Routes.flowRun, () => post(Routes.flowRun, { sessionId: "s1", flowId: "build", payload: {} })]
    ]

    test.each(guarded)("%s fails closed without a token or local opt-in", async (_route, build) => {
      const { APP_API_OPEN: _open, ...env } = app.env
      expect((await handle(build(), env)).status).toBe(401)
      expect((await handle(build(), { ...env, APP_API_TOKEN: "" })).status).toBe(401)
      expect(app.session("s1").turns).toEqual([])
      expect(app.session("s1").runs).toEqual([])
      expect(app.session("s1").cancels).toEqual([])
    })

    test.each(guarded)("%s answers normally with explicit local opt-in", async (_route, build) => {
      expect((await handle(build(), app.env)).status).toBe(200)
    })

    test.each(guarded)("%s answers 401 with no credential", async (_route, build) => {
      const response = await handle(build(), authed())
      expect(response.status).toBe(401)
    })

    test.each(guarded)("%s answers 401 with the wrong credential", async (_route, build) => {
      const request = new Request(build())
      request.headers.set("authorization", "Bearer wrong")
      expect((await handle(request, authed())).status).toBe(401)
    })

    test.each(guarded)("%s answers normally with the credential", async (_route, build) => {
      const response = await handle(withToken(build()), authed())
      expect(response.status).toBe(200)
    })

    test("a refusal never wakes a Durable Object", async () => {
      await handle(post(Routes.turn, { sessionId: "s1", flowId: "chat", message: "hi" }), authed())
      expect(app.session("s1").turns).toEqual([])
    })

    // 401 rather than 404: the credential is checked before the path is
    // matched, so an uncredentialed caller cannot map which /api routes exist.
    test("an unrouted /api path answers 401, not the 404 that would name it", async () => {
      expect((await handle(get("/api/nope"), authed())).status).toBe(401)
      expect((await handle(get("/api/nope"), app.env)).status).toBe(404)
    })

    test("an asset request needs no credential", async () => {
      const response = await handle(get("/build/deep/link"), authed())
      expect(response.status).toBe(200)
      expect(app.assetRequests).toEqual(["/build/deep/link"])
    })
  })

  describe("body size", () => {
    const oversized = "x".repeat(MAX_BODY_BYTES + 1)

    test("refuses a declared body over the cap without waking a session", async () => {
      const response = await handle(post(Routes.turn, { sessionId: "s1", flowId: "chat", message: oversized }), app.env)
      expect(response.status).toBe(413)
      expect(app.session("s1").turns).toEqual([])
    })

    test("refuses an undeclared streamed body over the cap", async () => {
      // A chunked body carries no content-length, so the cap has to be counted
      // while reading rather than read off a header.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(8 * 1024)))
        }
      })
      const request = new Request(`https://aomi.smithers.sh${Routes.turn}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // Undici requires this for a streamed request body; it declares no length.
        duplex: "half"
      } as RequestInit)
      expect((await handle(request, app.env)).status).toBe(413)
    })

    test("accepts a body under the cap", async () => {
      const message = "x".repeat(1024)
      const response = await handle(post(Routes.turn, { sessionId: "s1", flowId: "chat", message }), app.env)
      expect(response.status).toBe(200)
    })
  })

  describe("session ids", () => {
    test.each([
      ["turn", () => post(Routes.turn, { sessionId: INDEX_SESSION, flowId: "chat", message: "hi" })],
      ["cancel", () => post(Routes.turnCancel, { sessionId: INDEX_SESSION })],
      ["flow run", () => post(Routes.flowRun, { sessionId: INDEX_SESSION, flowId: "build", payload: {} })],
      ["session read", () => get(`${Routes.session}?id=${INDEX_SESSION}`)],
      ["flow list", () => get(`${Routes.flows}?sessionId=${INDEX_SESSION}`)]
    ] as ReadonlyArray<readonly [string, () => Request]>)(
      "the %s route refuses the registry object's name",
      async (_label, build) => {
        const response = await handle(build(), app.env)
        expect(response.status).toBe(400)
        expect((await response.json() as { error: string }).error).toContain("session id")
      }
    )

    test("refuses a structured id before it names a Durable Object", async () => {
      const response = await handle(post(Routes.turn, { sessionId: "../s1", flowId: "chat", message: "hi" }), app.env)
      expect(response.status).toBe(400)
      expect(app.session("../s1").turns).toEqual([])
    })
  })
})

describe("browser request admission", () => {
  const mutations = [
    [Routes.turn, { sessionId: "s1", flowId: "chat", message: "hi" }],
    [Routes.turnCancel, { sessionId: "s1" }],
    [Routes.flowRun, { sessionId: "s1", flowId: "build", payload: {} }]
  ] as const

  test.each(mutations)("%s refuses a simple text/plain POST", async (path, body) => {
    const request = post(path, body)
    request.headers.set("content-type", "text/plain")
    expect((await handle(request, app.env)).status).toBe(415)
    expect(app.session("s1").turns).toEqual([])
    expect(app.session("s1").runs).toEqual([])
    expect(app.session("s1").cancels).toEqual([])
  })

  test.each([
    { origin: "https://evil.example" },
    { origin: "https://other.smithers.sh" },
    { origin: "http://aomi.smithers.sh" },
    { origin: "https://aomi.smithers.sh:8443" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "none" },
    { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
    { origin: "https://aomi.smithers.sh", "sec-fetch-site": "cross-site" }
  ])("refuses foreign browser context %j before any session is reached", async (headers) => {
    for (const [path, body] of mutations) {
      const request = post(path, body)
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
      expect((await handle(request, app.env)).status).toBe(403)
      request.headers.set("authorization", "Bearer secret")
      expect((await handle(request, { ...app.env, APP_API_TOKEN: "secret" })).status).toBe(403)
    }
    expect(app.session("s1").turns).toEqual([])
    expect(app.session("s1").runs).toEqual([])
    expect(app.session("s1").cancels).toEqual([])
  })

  test.each(mutations)("%s accepts same-origin JSON", async (path, body) => {
    const request = post(path, body)
    request.headers.set("origin", "https://aomi.smithers.sh")
    request.headers.set("sec-fetch-site", "same-origin")
    expect((await handle(request, app.env)).status).toBe(200)
  })
})
