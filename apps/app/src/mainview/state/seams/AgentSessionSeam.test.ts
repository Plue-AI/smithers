import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { CardSchema } from "@smthrs/rpc/Cards"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createAgentSessionSeam, DEGRADED_AGENT_SESSION_REFUSAL } from "./AgentSessionSeam"
import { SIGN_OUT_REFUSAL } from "./CloudSignIn"
import type { SeamContext } from "./SeamContext"
import { AGENT_SESSION_WIRE, sseFrame } from "./fixtures/AgentSessionWire"

/*
 * The agent sessions seam (UI-COVERAGE-GAPS.md "agents · Cloud agent
 * sessions"): the gates, the create → first-message dispatch, the list
 * listing, the view's read + live stream, the follow-up and the stop. Every
 * route is a double in plue's own wire shape (fixtures/AgentSessionWire.ts,
 * off internal/services/agent.go); the SSE stream is a controllable double of
 * GET …/agent/sessions/{id}/stream's `agent.session` frames.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const SESSION_ID = "0c3d0c6e-2f6a-4b6e-9c2a-1c0a2b0e5f6a"
const REPO = "will/smithers"

/** A stream double with a live push channel: the SSE body plue's broker serves. */
const liveStream = () => {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (opened) => { controller = opened } })
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (frame: string) => controller.enqueue(encoder.encode(frame)),
    close: () => controller.close()
  }
}

/** A closed stream of the given frames. */
const sseResponse = (frames: ReadonlyArray<string>): Response => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    }
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

type Route = Response | ((url: URL) => Response | Promise<Response>)

const harness = async (
  routes: Record<string, Route>,
  options: { readonly storage?: StorageApi; readonly repairIntervalMs?: number; readonly signedIn?: boolean; readonly degraded?: boolean; readonly stream?: "live" | "closed" | Response | (() => Response); readonly receipt?: (transition: Parameters<AppStore["dispatch"]>[0], receipt: ReturnType<AppStore["dispatch"]>) => ReturnType<AppStore["dispatch"]> } = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: options.storage ?? memoryStorage() })
  /** `METHOD path` per request, the query string dropped; the same with it. */
  const requests: Array<string> = []
  const urls: Array<string> = []
  const bodies: Array<{ readonly key: string; readonly body: unknown }> = []
  /** The stream door's calls: the path and the signal the seam attached. */
  const streamCalls: Array<{ readonly path: string; readonly accept: string | null; readonly cursor: string | null; readonly signal: AbortSignal | undefined }> = []
  const live = liveStream()
  const ctx: SeamContext = {
    http: async (input, init) => {
      const method = init?.method ?? "GET"
      const stripped = input.startsWith("/") ? input.slice(1) : input
      const url = new URL(stripped, "https://cloud.invalid/")
      const path = url.pathname.slice(1)
      const key = `${method} ${path}`
      requests.push(key)
      urls.push(`${key}${url.search}`)
      if (typeof init?.body === "string") bodies.push({ key, body: JSON.parse(init.body) })
      const route = routes[key] ?? routes[path]
      if (route === undefined) return json(404, { message: `no route ${key}` })
      return typeof route === "function" ? route(url) : route.clone()
    },
    stream: async (input, init) => {
      const stripped = input.startsWith("/") ? input.slice(1) : input
      const url = new URL(stripped, "https://cloud.invalid/")
      const path = url.pathname.slice(1)
      streamCalls.push({ path, cursor: new Headers(init?.headers).get("Last-Event-ID"), accept: init?.headers === undefined ? null : new Headers(init.headers).get("accept"), signal: init?.signal ?? undefined })
      if (typeof options.stream === "function") return options.stream()
      if (options.stream instanceof Response) return options.stream
      return options.stream === "closed" ? sseResponse([]) : live.response
    },
    baseUrl: "",
    store,
    dispatch: (transition) => {
      const receipt = store.dispatch(transition)
      return options.receipt?.(transition, receipt) ?? receipt
    },
    actor: () => "user",
    nextOrdinal: () => 0
  }
  if (options.signedIn !== false) {
    await store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-in",
      username: "will",
      expiresAt: null,
      scopes: options.degraded === true ? "degraded" : null
    })
  }
  await store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [
      { id: REPO, org: "will", ownerKind: "user", name: "smithers", head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" } }
    ]
  })
  const seam = createAgentSessionSeam(ctx, { repairIntervalMs: options.repairIntervalMs })
  cleanups.push(async () => { seam.dispose(); await store.dispose?.() })
  return { ctx, store, seam, requests, urls, bodies, streamCalls, live }
}

const cardOf = (store: AppStore, sessionId = SESSION_ID) => store.collections.cards.get(`agent-session-${sessionId}`)

/** The cloud-variant payload of the session's card, narrowed; undefined when the card is absent or not one. */
const payloadOf = (store: AppStore, sessionId = SESSION_ID) => {
  const card = cardOf(store, sessionId)
  return card?.kind === "agent" && "cloud" in card.payload ? card.payload : undefined
}

/** Poll until the floating stream read lands, never a fixed sleep. */
const until = async (holds: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (!holds() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
  expect(holds()).toBe(true)
}

describe("agent session seam gates", () => {
  test("a signed-out session refuses every act with the sign-in step", async () => {
    const { seam } = await harness({}, { signedIn: false })
    expect(await seam.newSession(REPO, "codex", "fix the retry loop")).toBe("Sign in to Smithers Cloud to continue.")
    expect(await seam.listSessions(REPO)).toBe("Sign in to Smithers Cloud to continue.")
    expect(await seam.viewSession(SESSION_ID, REPO)).toBe("Sign in to Smithers Cloud to continue.")
    expect(await seam.sayToSession(SESSION_ID, "hello")).toBe("Sign in to Smithers Cloud to continue.")
    expect(await seam.stopSession(SESSION_ID, REPO)).toBe("Sign in to Smithers Cloud to continue.")
  })

  test("a degraded sign-in refuses every act with the enable wording", async () => {
    const { seam } = await harness({}, { degraded: true })
    for (const refusal of [
      await seam.newSession(REPO, "codex", "fix the retry loop"),
      await seam.listSessions(REPO),
      await seam.viewSession(SESSION_ID, REPO),
      await seam.sayToSession(SESSION_ID, "hello"),
      await seam.stopSession(SESSION_ID, REPO)
    ]) {
      expect(refusal).toBe(DEGRADED_AGENT_SESSION_REFUSAL)
      expect(refusal).toContain("sign in again to enable")
    }
  })
})

describe("agent.session.new", () => {
  test("creates the session, posts the task as the dispatching user message, renders the card and streams it", async () => {
    const session = AGENT_SESSION_WIRE.session()
    const message = AGENT_SESSION_WIRE.message()
    const { store, seam, requests, bodies, streamCalls } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, session),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(201, message)
    })
    const result = await seam.newSession(REPO, "codex", "Fix the retry loop")
    expect(requests.filter(request => request.startsWith("POST "))).toEqual([
      `POST api/repos/${REPO}/agent/sessions`,
      `POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`
    ])
    expect(bodies).toEqual([
      { key: `POST api/repos/${REPO}/agent/sessions`, body: { title: "Fix the retry loop" } },
      {
        key: `POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`,
        body: { role: "user", text: "Fix the retry loop", agent_provider: "codex" }
      }
    ])
    const payload = payloadOf(store)
    expect(payload).toMatchObject({
      cloud: true,
      sessionId: SESSION_ID,
      repo: REPO,
      provider: "codex",
      state: "active",
      task: "Fix the retry loop",
      workspaceId: null
    })
    expect(payload?.transcript).toEqual([
      { id: 41, role: "user", sequence: 1, createdAt: "2026-09-14T09:00:01Z", parts: [{ type: "text", text: "Fix the retry loop" }] }
    ])
    /* The persisted card must parse the wire model: the payload is the union's cloud member. */
    expect(CardSchema.safeParse(cardOf(store)).success).toBe(true)
    /* The transcript streams: the SSE door opened on the session's stream with the SSE accept. */
    expect(streamCalls).toEqual([
      { path: `api/repos/${REPO}/agent/sessions/${SESSION_ID}/stream`, accept: "text/event-stream", cursor: "41", signal: expect.any(AbortSignal) }
    ])
    expect(typeof result).toBe("object")
    expect(result).toMatchObject({ value: expect.stringContaining(SESSION_ID) })
  })

  test("a 403 answers the feature-gate refusal in the server's own words", async () => {
    const { seam } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(403, { message: "feature not available" })
    })
    expect(await seam.newSession(REPO, "codex", "Fix the retry loop"))
      .toBe("Agent sessions are not enabled here — the backend answered 403: feature not available")
  })

  test("a 404 is the server's own answer (the repository is not imported)", async () => {
    const { seam } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(404, { message: "repository not found" })
    })
    expect(await seam.newSession(REPO, "codex", "Fix the retry loop")).toBe("repository not found")
  })

  test("a refused first message still renders the session card, with the refusal on it", async () => {
    const { store, seam } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, AGENT_SESSION_WIRE.session()),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(400, { message: "agent_provider must be 'smithers' or 'codex'" })
    })
    const result = await seam.newSession(REPO, "claude", "Fix the retry loop")
    expect(typeof result).toBe("string")
    expect(result).toContain("agent_provider must be 'smithers' or 'codex'")
    expect(payloadOf(store)?.error).toBe("agent_provider must be 'smithers' or 'codex'")
    expect(payloadOf(store)?.state).toBe("active")
  })
})

describe("agent.session.list", () => {
  test("lists the repository's sessions in a durable embedded card", async () => {
    const { store, seam, urls } = await harness({
      [`GET api/repos/${REPO}/agent/sessions`]: json(200, [
        AGENT_SESSION_WIRE.session({ message_count: 3 }),
        AGENT_SESSION_WIRE.session({ id: "9a8b7c6d-0000-4e6e-9c2a-1c0a2b0e5f6a", title: "", status: "completed", message_count: 1 }),
        { broken: true }
      ])
    })
    const result = await seam.listSessions(REPO)
    expect(urls[0]).toBe(`GET api/repos/${REPO}/agent/sessions?limit=100`)
    expect(typeof result).toBe("object")
    const listing = (result as { value: string }).value
    expect(listing).toContain(`Fix the retry loop · ${SESSION_ID} · active · 3 messages`)
    expect(listing).toContain("(untitled) · 9a8b7c6d-0000-4e6e-9c2a-1c0a2b0e5f6a · completed · 1 message")
    expect(listing).not.toContain("broken")
    expect(listing).not.toContain("/agent.session.")
    expect(store.collections.cards.get(`agent-sessions-${REPO}`)).toMatchObject({
      kind: "agents", payload: { cloud: true, repo: REPO, sessions: [
        { id: SESSION_ID, title: "Fix the retry loop", status: "active", messageCount: 3 },
        { id: "9a8b7c6d-0000-4e6e-9c2a-1c0a2b0e5f6a", title: "", status: "completed", messageCount: 1 }
      ] }
    })
    expect([...store.collections.messages.values()].some(message => message.text.includes("/agent.session."))).toBe(false)
  })

  test("an empty list renders an empty card without slash instructions", async () => {
    const { seam, store } = await harness({ [`GET api/repos/${REPO}/agent/sessions`]: json(200, []) })
    const result = await seam.listSessions(REPO)
    expect(result).toEqual({ value: `No agent sessions on ${REPO}.` })
    expect(store.collections.cards.get(`agent-sessions-${REPO}`)).toMatchObject({
      kind: "agents", payload: { cloud: true, repo: REPO, sessions: [] }
    })
  })

  test("a successful Stop removes its row and a held older listing cannot restore it", async () => {
    let release!: (response: Response) => void
    let held = false
    const { store, seam } = await harness({
      [`GET api/repos/${REPO}/agent/sessions`]: () => held
        ? new Promise<Response>(resolve => { release = resolve })
        : json(200, [AGENT_SESSION_WIRE.session()]),
      [`DELETE api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: new Response(null, { status: 204 })
    })
    await seam.listSessions(REPO)
    held = true
    const pending = seam.listSessions(REPO)
    await until(() => release !== undefined)
    await seam.stopSession(SESSION_ID, REPO)
    release(json(200, [AGENT_SESSION_WIRE.session()]))
    await pending
    const card = store.collections.cards.get(`agent-sessions-${REPO}`)
    expect(card).toMatchObject({ payload: { sessions: [] } })
    expect(CardSchema.safeParse(card).success).toBe(true)
  })

  test("a failed Stop leaves the listed session available for retry", async () => {
    const { store, seam } = await harness({
      [`GET api/repos/${REPO}/agent/sessions`]: json(200, [AGENT_SESSION_WIRE.session()]),
      [`DELETE api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(503, { message: "retry later" })
    })
    await seam.listSessions(REPO)
    const refused = await seam.stopSession(SESSION_ID, REPO)
    expect(refused).toBe(`The request to Smithers Cloud failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed.`)
    expect(refused).not.toContain("retry later")
    expect(store.collections.cards.get(`agent-sessions-${REPO}`)).toMatchObject({ payload: { sessions: [{ id: SESSION_ID, status: "active" }] } })
  })

  test("opening a session and receiving a terminal stream updates its listed state", async () => {
    const { store, seam, live } = await harness({
      [`GET api/repos/${REPO}/agent/sessions`]: json(200, [AGENT_SESSION_WIRE.session()]),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, [])
    })
    await seam.listSessions(REPO)
    await seam.viewSession(SESSION_ID, REPO)
    live.push(sseFrame(AGENT_SESSION_WIRE.statusEvent("completed")))
    await until(() => payloadOf(store)?.state === "completed")
    expect(store.collections.cards.get(`agent-sessions-${REPO}`)).toMatchObject({ payload: { sessions: [{ id: SESSION_ID, status: "completed" }] } })
  })

  test("the first listing merges a newer terminal observation without losing its card", async () => {
    const response = deferred<Response>()
    const { store, seam, requests, live } = await harness({
      [`GET api/repos/${REPO}/agent/sessions`]: () => response.promise,
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, [])
    })
    const pending = seam.listSessions(REPO)
    await until(() => requests.length === 1)
    await seam.viewSession(SESSION_ID, REPO)
    live.push(sseFrame(AGENT_SESSION_WIRE.statusEvent("completed")))
    await until(() => payloadOf(store)?.state === "completed")
    response.resolve(json(200, [AGENT_SESSION_WIRE.session({ status: "active" })]))
    await pending
    expect(store.collections.cards.get(`agent-sessions-${REPO}`)).toMatchObject({ payload: { sessions: [{ id: SESSION_ID, status: "completed" }] } })
  })

  test("a listed inventory is scrubbed on sign-out and an older response cannot restore it", async () => {
    const response = deferred<Response>()
    let hold = false
    const { store, seam, requests } = await harness({
      [`GET api/repos/${REPO}/agent/sessions`]: () => hold ? response.promise : json(200, [AGENT_SESSION_WIRE.session()])
    })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
    await seam.listSessions(REPO)
    hold = true
    const pending = seam.listSessions(REPO)
    await until(() => requests.length === 2)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    expect(store.collections.cards.get(`agent-sessions-${REPO}`)).toBeUndefined()
    response.resolve(json(200, [AGENT_SESSION_WIRE.session()]))
    expect(await pending).toBe(SIGN_OUT_REFUSAL)
    expect(store.collections.cards.get(`agent-sessions-${REPO}`)).toBeUndefined()
  })

  test("a 403 answers the feature-gate refusal", async () => {
    const { seam } = await harness({ [`GET api/repos/${REPO}/agent/sessions`]: json(403, { message: "feature not available" }) })
    expect(await seam.listSessions(REPO)).toBe("Agent sessions are not enabled here — the backend answered 403: feature not available")
  })
})

describe("agent.session.view", () => {
  const session = AGENT_SESSION_WIRE.session({ message_count: 2, workspace_id: "ws-agent-1" })
  const messages = [
    AGENT_SESSION_WIRE.message(),
    AGENT_SESSION_WIRE.message({
      id: 42,
      role: "assistant",
      sequence: 2,
      parts: [
        { part_index: 1, type: "text", content: { value: "The loop never decrements." } },
        { part_index: 0, type: "tool_call", content: { name: "Read", arguments: { path: "src/index.ts" } } }
      ],
      created_at: "2026-09-14T09:00:20Z"
    })
  ]

  test("re-reads the session and its messages into the card and streams it while active", async () => {
    const { store, seam, urls, streamCalls } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, session),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, messages)
    })
    const result = await seam.viewSession(SESSION_ID, REPO)
    expect(urls).toContain(`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages?limit=100`)
    const payload = payloadOf(store)
    expect(payload?.workspaceId).toBe("ws-agent-1")
    expect(payload?.provider).toBeNull()
    expect(payload?.transcript.map((row) => row.id)).toEqual([41, 42])
    /* Parts read in part_index order; a tool part's object content is its compact JSON, like plue's own renderer. */
    expect(payload?.transcript[1]?.parts).toEqual([
      { type: "tool_call", text: `{"name":"Read","arguments":{"path":"src/index.ts"}}` },
      { type: "text", text: "The loop never decrements." }
    ])
    expect(streamCalls.map((call) => call.path)).toEqual([`api/repos/${REPO}/agent/sessions/${SESSION_ID}/stream`])
    expect(result).toMatchObject({ value: expect.stringContaining("streams the transcript live") })
  })

  test("a terminal session's card holds the transcript and opens no stream", async () => {
    const { seam, streamCalls } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, { ...session, status: "completed" }),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, messages)
    })
    await seam.viewSession(SESSION_ID, REPO)
    expect(streamCalls).toEqual([])
  })

  test("a viewed session keeps the provider its card already knew; the wire never states one", async () => {
    const { store, seam } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, AGENT_SESSION_WIRE.session()),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(201, AGENT_SESSION_WIRE.message()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, session),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, messages)
    }, { stream: "closed" })
    await seam.newSession(REPO, "codex", "Fix the retry loop")
    await seam.viewSession(SESSION_ID, REPO)
    expect(payloadOf(store)?.provider).toBe("codex")
  })

  test("a 404 names the session and the repository in the server's words", async () => {
    const { seam } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(404, { message: "agent session not found" })
    })
    expect(await seam.viewSession(SESSION_ID, REPO)).toBe(`Agent session ${SESSION_ID} on ${REPO}: agent session not found.`)
  })

  test("the repo resolves off the session's own card when no argument names one", async () => {
    const { seam, urls } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, AGENT_SESSION_WIRE.session()),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(201, AGENT_SESSION_WIRE.message()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, session),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, messages)
    }, { stream: "closed" })
    await seam.newSession(REPO, "codex", "Fix the retry loop")
    /* No argument names the repository: the bare act re-finds it on the session's card. */
    await seam.viewSession(SESSION_ID)
    expect(urls.at(-1)).toBe(`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages?limit=100`)
  })
})

describe("agent.session.say", () => {
  const seedViaNew = async (routes: Record<string, Route>, options?: { stream?: "live" | "closed" }) => {
    const rig = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, AGENT_SESSION_WIRE.session()),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(201, AGENT_SESSION_WIRE.message()),
      ...routes
    }, options)
    await rig.seam.newSession(REPO, "codex", "Fix the retry loop")
    return rig
  }

  test("posts the follow-up on the session's provider, appends its row, and streams the answer", async () => {
    const followUp = AGENT_SESSION_WIRE.message({ id: 43, sequence: 2, parts: [{ part_index: 0, type: "text", content: { value: "And the off-by-one too" } }] })
    const { store, seam, bodies } = await seedViaNew({
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: (() => {
        let calls = 0
        return () => { calls += 1; return calls === 1 ? json(201, AGENT_SESSION_WIRE.message()) : json(201, followUp) }
      })()
    })
    const result = await seam.sayToSession(SESSION_ID, "And the off-by-one too")
    expect(bodies.at(-1)?.body).toEqual({ role: "user", text: "And the off-by-one too", agent_provider: "codex" })
    expect(payloadOf(store)?.transcript.map((row) => row.id)).toEqual([41, 43])
    expect(result).toMatchObject({ value: expect.stringContaining("(codex)") })
  })

  test("a 409 while a run is active is the server's own refusal, on the card too", async () => {
    const { store, seam } = await seedViaNew({
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: (() => {
        let calls = 0
        return () => {
          calls += 1
          return calls === 1 ? json(201, AGENT_SESSION_WIRE.message()) : json(409, { message: "agent session already has an active run" })
        }
      })()
    })
    const result = await seam.sayToSession(SESSION_ID, "one more")
    expect(result).toBe("agent session already has an active run")
    expect(payloadOf(store)?.error).toBe("agent session already has an active run")
    /* A refused message appends no row. */
    expect(payloadOf(store)?.transcript.map((row) => row.id)).toEqual([41])
  })

  test("a blank message refuses without a request", async () => {
    const { seam, requests } = await harness({})
    expect(await seam.sayToSession(SESSION_ID, "   ")).toBe("Write a message before sending it.")
    expect(requests).toEqual([])
  })

  test("without a card or an active repository, the refusal names the view door", async () => {
    const { store, seam } = await harness({})
    await store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: REPO, org: "will", ownerKind: "user", name: "smithers", head: { bookmark: "main", changeId: "q", commitId: "c" } },
        { id: "will/force", org: "will", ownerKind: "user", name: "force", head: { bookmark: "main", changeId: "q", commitId: "c" } }
      ]
    })
    const result = await seam.sayToSession(SESSION_ID, "hello")
    expect(result).toBe(`Smithers doesn't know which repository agent session ${SESSION_ID} is on — view it first with /agent.session.view ${SESSION_ID} <owner/repo>.`)
  })
})

describe("agent.session.stop", () => {
  test("DELETEs the session, marks the card cancelled, and drops the stream", async () => {
    const { store, seam, requests, streamCalls } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, AGENT_SESSION_WIRE.session()),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(201, AGENT_SESSION_WIRE.message()),
      [`DELETE api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: new Response(null, { status: 204 })
    })
    await seam.newSession(REPO, "codex", "Fix the retry loop")
    expect(streamCalls).toHaveLength(1)
    const result = await seam.stopSession(SESSION_ID)
    expect(requests.at(-1)).toBe(`DELETE api/repos/${REPO}/agent/sessions/${SESSION_ID}`)
    expect(payloadOf(store)?.state).toBe("cancelled")
    expect(streamCalls[0]?.signal?.aborted).toBe(true)
    expect(result).toEqual({ value: `Agent session ${SESSION_ID} stopped.` })
  })

  test("stopping a settled session deletes its record and keeps the word it earned", async () => {
    const { store, seam } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session({ status: "completed", message_count: 1 })),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, [AGENT_SESSION_WIRE.message()]),
      [`DELETE api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: new Response(null, { status: 204 })
    })
    await seam.viewSession(SESSION_ID, REPO)
    const result = await seam.stopSession(SESSION_ID, REPO)
    expect(payloadOf(store)?.state).toBe("completed")
    expect(result).toEqual({ value: `Agent session ${SESSION_ID} was already completed — its record is deleted.` })
  })

  test("a 404 is the server's own answer, and the card keeps its state", async () => {
    const { store, seam } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, AGENT_SESSION_WIRE.session()),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(201, AGENT_SESSION_WIRE.message()),
      [`DELETE api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(404, { message: "agent session not found" })
    }, { stream: "closed" })
    await seam.newSession(REPO, "codex", "Fix the retry loop")
    expect(await seam.stopSession(SESSION_ID)).toBe("agent session not found")
    expect(payloadOf(store)?.state).toBe("active")
    expect(payloadOf(store)?.error).toBe("agent session not found")
  })
})

describe("the transcript stream", () => {
  const seed = async () => {
    const rig = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, AGENT_SESSION_WIRE.session()),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(201, AGENT_SESSION_WIRE.message()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, [AGENT_SESSION_WIRE.message()])
    })
    await rig.seam.newSession(REPO, "codex", "Fix the retry loop")
    return rig
  }

  test("a message event appends its row, a replayed one dedupes, and a terminal status ends the stream", async () => {
    const { store, live, streamCalls } = await seed()
    const assistant = AGENT_SESSION_WIRE.message({
      id: 42,
      role: "assistant",
      sequence: 2,
      parts: [{ part_index: 0, type: "text", content: { value: "Fixed." } }]
    })
    /* A keep-alive comment and the message, then the REPLAY of the same id (Last-Event-ID reconnect), then the terminal status. */
    live.push(`:ka\n\n${sseFrame(AGENT_SESSION_WIRE.messageEvent(assistant), { id: 42 })}`)
    await until(() => payloadOf(store)?.transcript.length === 2)
    expect(payloadOf(store)?.transcript[1]).toEqual({
      id: 42, role: "assistant", sequence: 2, createdAt: "2026-09-14T09:00:01Z", parts: [{ type: "text", text: "Fixed." }]
    })
    live.push(sseFrame(AGENT_SESSION_WIRE.messageEvent(assistant), { id: 42 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(payloadOf(store)?.transcript.map((row) => row.id)).toEqual([41, 42])
    live.push(sseFrame(AGENT_SESSION_WIRE.statusEvent("completed")))
    await until(() => payloadOf(store)?.state === "completed")
    await until(() => streamCalls[0]?.signal?.aborted === true)
  })

  test("frames parse across chunk boundaries; another session's event and a malformed payload drop", async () => {
    const { store, live } = await seed()
    const frame = sseFrame(AGENT_SESSION_WIRE.messageEvent(AGENT_SESSION_WIRE.message({ id: 44, role: "assistant", sequence: 3, parts: [{ part_index: 0, type: "text", content: { value: "Across the split." } }] })), { id: 44 })
    const cut = Math.floor(frame.length / 2)
    live.push(frame.slice(0, cut))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(payloadOf(store)?.transcript.map((row) => row.id)).toEqual([41])
    live.push(frame.slice(cut))
    live.push(sseFrame(AGENT_SESSION_WIRE.messageEvent(AGENT_SESSION_WIRE.message({ id: 45 }), "another-session")))
    live.push("event: agent.session\ndata: {not json\n\n")
    await until(() => payloadOf(store)?.transcript.length === 2)
    expect(payloadOf(store)?.transcript.map((row) => row.id)).toEqual([41, 44])
  })

  test("a stream that answers no SSE opens nothing and the card keeps its read", async () => {
    const { store, seam, streamCalls } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, AGENT_SESSION_WIRE.session()),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(201, AGENT_SESSION_WIRE.message())
    }, { stream: json(502, { message: "upstream" }) })
    await seam.newSession(REPO, "codex", "Fix the retry loop")
    expect(streamCalls).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(payloadOf(store)?.transcript.map((row) => row.id)).toEqual([41])
    expect(payloadOf(store)?.state).toBe("active")
  })
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe("agent session observation ownership", () => {
  test("an accepted session is durable before the run-dispatching POST and stream attachment", async () => {
    const held = deferred<void>()
    let receipts = 0
    const { seam, store, requests, streamCalls } = await harness({
      [`POST api/repos/${REPO}/agent/sessions`]: json(201, AGENT_SESSION_WIRE.session()),
      [`POST api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(201, AGENT_SESSION_WIRE.message())
    }, { receipt: (transition, receipt) => {
      if (transition.type !== "card.upsert" || receipts++ > 0) return receipt
      return Object.assign(Object.create(receipt) as typeof receipt, { isPersisted: { ...receipt.isPersisted, promise: receipt.isPersisted.promise.then(() => held.promise).then(() => receipt) } })
    } })
    const pending = seam.newSession(REPO, "codex", "Fix the retry loop")
    await until(() => receipts === 1)
    expect(requests).toHaveLength(1)
    expect(streamCalls).toHaveLength(0)
    held.resolve()
    await pending
    expect(requests.filter(request => request.startsWith("POST "))).toHaveLength(2)
    expect(streamCalls[0]?.cursor).toBe("41")
    seam.dispose()
    await store.dispose?.()
  })

  test("disposal or sign-out during creation suppresses the second POST and old-account card", async () => {
    for (const retire of ["dispose", "sign-out"] as const) {
      const response = deferred<Response>()
      const { seam, store, requests, streamCalls } = await harness({
        [`POST api/repos/${REPO}/agent/sessions`]: () => response.promise
      })
      const pending = seam.newSession(REPO, "codex", "private task")
      await until(() => requests.length === 1)
      if (retire === "dispose") seam.dispose()
      else await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null }).isPersisted.promise
      response.resolve(json(201, AGENT_SESSION_WIRE.session()))
      expect(await pending).toBe(SIGN_OUT_REFUSAL)
      expect(requests).toHaveLength(1)
      expect(cardOf(store)).toBeUndefined()
      expect(streamCalls).toHaveLength(0)
      seam.dispose()
      await store.dispose?.()
    }
  })

  test("stream observations wait for the previous receipt and request delivery after the initial observed message ID", async () => {
    const held = deferred<void>()
    let holding = false
    const { seam, store, live, streamCalls } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: () => json(200, AGENT_SESSION_WIRE.session()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: () => json(200, [AGENT_SESSION_WIRE.message()])
    }, { receipt: (transition, receipt) => {
      if (transition.type !== "card.upsert" || transition.actor !== "system" || holding) return receipt
      holding = true
      return Object.assign(Object.create(receipt) as typeof receipt, { isPersisted: { ...receipt.isPersisted, promise: receipt.isPersisted.promise.then(() => held.promise).then(() => receipt) } })
    } })
    await seam.viewSession(SESSION_ID, REPO)
    expect(streamCalls[0]?.cursor).toBe("41")
    live.push(sseFrame(AGENT_SESSION_WIRE.messageEvent(AGENT_SESSION_WIRE.message({ id: 42, sequence: 2 })), { id: 42 })
      + sseFrame(AGENT_SESSION_WIRE.messageEvent(AGENT_SESSION_WIRE.message({ id: 43, sequence: 3 })), { id: 43 }))
    await until(() => holding)
    expect(payloadOf(store)?.transcript.map(row => row.id)).toEqual([41, 42])
    held.resolve()
    await until(() => payloadOf(store)?.transcript.length === 3)
    expect(payloadOf(store)?.transcript.map(row => row.id)).toEqual([41, 42, 43])
    seam.dispose()
    await store.dispose?.()
  })

  test("a stream is retired on authentication change and cannot publish trailing rows", async () => {
    const { seam, store, live, streamCalls } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, [])
    })
    await seam.viewSession(SESSION_ID, REPO)
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null }).isPersisted.promise
    await until(() => streamCalls[0]?.signal?.aborted === true)
    // A canceled transport may still have delivered a queued frame; the generation fence is independent of abort.
    expect(() => live.push(sseFrame(AGENT_SESSION_WIRE.messageEvent(AGENT_SESSION_WIRE.message()), { id: 41 }))).toThrow()
    expect(payloadOf(store)?.transcript ?? []).toEqual([])
    seam.dispose()
    await store.dispose?.()
  })

  test("a mismatched message session or SSE identity cannot enter the transcript", async () => {
    const { seam, store } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, [])
    }, { stream: sseResponse([
      sseFrame(AGENT_SESSION_WIRE.messageEvent(AGENT_SESSION_WIRE.message({ session_id: "another-session" })), { id: 41 }),
      sseFrame(AGENT_SESSION_WIRE.messageEvent(AGENT_SESSION_WIRE.message()), { id: 42 }),
      sseFrame(AGENT_SESSION_WIRE.statusEvent("completed"))
    ]) })
    await seam.viewSession(SESSION_ID, REPO)
    await until(() => payloadOf(store)?.state === "completed")
    expect(payloadOf(store)?.transcript).toEqual([])
    seam.dispose()
    await store.dispose?.()
  })
})

describe("agent session snapshot and stream repair", () => {
  test("an empty read followed by cursor-zero live-only connection recovers a message committed before connection readiness", async () => {
    let connected = false
    const stream = liveStream()
    const { seam, store, streamCalls, requests } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: () => json(200, AGENT_SESSION_WIRE.session({ message_count: connected ? 1 : 0 })),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: () => json(200, connected ? [AGENT_SESSION_WIRE.message()] : [])
    }, { stream: () => { connected = true; return stream.response } })
    await seam.viewSession(SESSION_ID, REPO)
    expect(streamCalls[0]?.cursor).toBe("0")
    // No SSE message is sent: Plue starts cursor0 at its captured head.
    await until(() => payloadOf(store)?.transcript.length === 1)
    expect(payloadOf(store)?.transcript[0]?.id).toBe(41)
    expect(requests.filter(request => request.startsWith("POST "))).toEqual([])
  })

  test("periodic snapshot repair captures a dropped terminal wakeup and its final committed message", async () => {
    let completed = false
    const { seam, store, streamCalls, requests } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: () => json(200, AGENT_SESSION_WIRE.session({ status: completed ? "completed" : "active", message_count: completed ? 2 : 1 })),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: () => json(200, [AGENT_SESSION_WIRE.message(), ...(completed ? [AGENT_SESSION_WIRE.message({ id: 42, sequence: 2, role: "assistant" })] : [])])
    }, { repairIntervalMs: 10 })
    await seam.viewSession(SESSION_ID, REPO)
    await until(() => requests.filter(request => request.endsWith(`/sessions/${SESSION_ID}`)).length >= 2)
    completed = true
    await until(() => payloadOf(store)?.state === "completed" && streamCalls[0]?.signal?.aborted === true)
    expect(payloadOf(store)?.transcript.map(row => row.id)).toEqual([41, 42])
    expect(requests.filter(request => request.startsWith("POST "))).toEqual([])
  })

  test("a completed large session reads the newest200 rows through the real100-row route cap", async () => {
    const rows = Array.from({ length: 435 }, (_, index) => AGENT_SESSION_WIRE.message({ id: index + 1, sequence: index + 1 }))
    const { seam, store, urls, streamCalls } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session({ status: "completed", message_count: rows.length })),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: url => {
        const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 30))
        const offset = Math.floor(Number(url.searchParams.get("cursor") ?? 0) / limit) * limit
        return json(200, rows.slice(offset, offset + limit))
      }
    })
    await seam.viewSession(SESSION_ID, REPO)
    expect(payloadOf(store)?.transcript.map(row => row.id)).toEqual(Array.from({ length: 200 }, (_, index) => index + 236))
    expect(urls.filter(url => url.includes("/messages?"))).toEqual([200, 300, 400].map(offset => `GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages?limit=100&cursor=${offset}`))
    expect(streamCalls).toEqual([])
  })

  test("reconnect waits for the last observation receipt and resumes its committed message ID without a POST", async () => {
    let connections = 0
    let heldReceipt = false
    const held = deferred<void>()
    const next = liveStream()
    const { seam, store, streamCalls, requests } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: () => json(200, AGENT_SESSION_WIRE.session({ message_count: 1 })),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: () => json(200, [AGENT_SESSION_WIRE.message()])
    }, {
      repairIntervalMs: 10,
      stream: () => ++connections === 1 ? sseResponse([sseFrame(AGENT_SESSION_WIRE.messageEvent(AGENT_SESSION_WIRE.message({ id: 42, sequence: 2 })), { id: 42 })]) : next.response,
      receipt: (transition, receipt) => {
        if (heldReceipt || transition.type !== "card.upsert" || transition.actor !== "system") return receipt
        heldReceipt = true
        return Object.assign(Object.create(receipt) as typeof receipt, { isPersisted: { ...receipt.isPersisted, promise: receipt.isPersisted.promise.then(() => held.promise).then(() => receipt) } })
      }
    })
    await seam.viewSession(SESSION_ID, REPO)
    await until(() => heldReceipt)
    expect(streamCalls).toHaveLength(1)
    expect(payloadOf(store)?.transcript.map(row => row.id)).toEqual([41, 42])
    held.resolve()
    await until(() => streamCalls.length === 2)
    expect(streamCalls.map(call => call.cursor)).toEqual(["41", "42"])
    expect(requests.filter(request => request.startsWith("POST "))).toEqual([])
  })

  test("a repair response from the retired account cannot restore its card", async () => {
    const delayed = deferred<Response>()
    let reads = 0
    const { seam, store, requests, streamCalls } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: () => ++reads === 1 ? json(200, AGENT_SESSION_WIRE.session()) : delayed.promise,
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: () => json(200, [])
    })
    await seam.viewSession(SESSION_ID, REPO)
    await until(() => reads === 2)
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    const before = requests.length
    delayed.resolve(json(200, AGENT_SESSION_WIRE.session({ title: "private old account", message_count: 1 })))
    await until(() => streamCalls[0]?.signal?.aborted === true)
    // Wait for the delayed promise continuation without opening another read.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(requests).toHaveLength(before)
    expect(cardOf(store)).toBeUndefined()
  })
})

test("failed stream persistence stops delivery and reopening retains the last committed cursor", async () => {
  const data = memoryStorage()
  let reject = false
  const storage: StorageApi = { ...data, setItem: (key, value) => {
    if (reject) throw new Error("fixture write unavailable")
    data.setItem(key, value)
  } }
  const { seam, store, live, streamCalls, requests } = await harness({
    [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: () => json(200, AGENT_SESSION_WIRE.session({ message_count: 1 })),
    [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: () => json(200, [AGENT_SESSION_WIRE.message()])
  }, { storage })
  await seam.viewSession(SESSION_ID, REPO)
  reject = true
  live.push(sseFrame(AGENT_SESSION_WIRE.messageEvent(AGENT_SESSION_WIRE.message({ id: 42, sequence: 2 })), { id: 42 }))
  await until(() => streamCalls[0]?.signal?.aborted === true)
  expect(payloadOf(store)?.transcript.map(row => row.id)).toEqual([41])
  seam.dispose()
  await store.dispose?.()
  reject = false
  const reopened = await createAppStore({ kind: "localStorage", storage })
  try {
    expect(payloadOf(reopened)?.transcript.map(row => row.id)).toEqual([41])
    expect(streamCalls).toHaveLength(1)
    expect(requests.filter(request => request.startsWith("POST "))).toEqual([])
  } finally { await reopened.dispose?.() }
})


test("a disposed session seam refuses every act", async () => {
  const { seam, requests } = await harness({})
  seam.dispose()
  expect(await seam.newSession(REPO, "codex", "task")).toBe(SIGN_OUT_REFUSAL)
  expect(await seam.listSessions(REPO)).toBe(SIGN_OUT_REFUSAL)
  expect(await seam.viewSession(SESSION_ID, REPO)).toBe(SIGN_OUT_REFUSAL)
  expect(await seam.sayToSession(SESSION_ID, "follow-up")).toBe(SIGN_OUT_REFUSAL)
  expect(await seam.stopSession(SESSION_ID, REPO)).toBe(SIGN_OUT_REFUSAL)
  expect(requests).toEqual([])
})


for (const status of [401, 403, 404]) {
  test(`a refused session stream (${status}) records the failure and detaches`, async () => {
    const { seam, store, streamCalls, requests } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, [])
    }, { repairIntervalMs: 10, stream: () => json(status, { message: "Session stream unavailable" }) })
    await seam.viewSession(SESSION_ID, REPO)
    await until(() => streamCalls[0]?.signal?.aborted === true)
    expect(payloadOf(store)?.error).toContain("Session stream unavailable")
    const reads = requests.length
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(streamCalls).toHaveLength(1)
    expect(requests).toHaveLength(reads)
  })
}

test("a 200 answer that is not an event stream reads as an unreachable Cloud, not as its own words", async () => {
  const { seam, store } = await harness({
    [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session()),
    [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, [])
  }, { repairIntervalMs: 10, stream: () => json(200, { message: "not a stream" }) })
  await seam.viewSession(SESSION_ID, REPO)
  await until(() => payloadOf(store)?.error !== undefined)
  expect(payloadOf(store)?.error).toStartWith("Could not reach Smithers Cloud.")
  expect(payloadOf(store)?.error).not.toContain("not a stream")
})

test("stream server failures remain visible and back off until recovery", async () => {
  const waits: number[] = []
  const realTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    waits.push(Number(args[1]))
    return realTimeout(...args)
  }) as typeof setTimeout)
  let attempts = 0
  const recovered = liveStream()
  try {
    const { seam, store, streamCalls } = await harness({
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}`]: json(200, AGENT_SESSION_WIRE.session()),
      [`GET api/repos/${REPO}/agent/sessions/${SESSION_ID}/messages`]: json(200, [])
    }, { repairIntervalMs: 31, stream: () => ++attempts <= 3 ? json(503, { message: "Session stream unavailable" }) : recovered.response })
    await seam.viewSession(SESSION_ID, REPO)
    await until(() => attempts === 3 && waits.includes(124))
    expect(payloadOf(store)?.error).toBe("Smithers Cloud could not open the session stream (HTTP 503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed.")
    expect(payloadOf(store)?.error).not.toContain("Session stream unavailable")
    expect(streamCalls[0]?.signal?.aborted).toBe(false)
    expect(waits).toContain(62)
    await until(() => attempts === 4 && payloadOf(store)?.error === undefined)
    expect(streamCalls[3]?.signal?.aborted).toBe(false)
  } finally { timer.mockRestore() }
})
