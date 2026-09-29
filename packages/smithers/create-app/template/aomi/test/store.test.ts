import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type AppCard, type SessionState, UNKNOWN_FAILURE_SENTENCE } from "../src/api.ts"
import { actions, applyFrame, store } from "../src/shell/store.ts"

interface PendingRequest {
  readonly url: string
  readonly signal: AbortSignal | null | undefined
  readonly resolve: (response: Response) => void
  readonly reject: (cause: Error) => void
}

let requests: Array<PendingRequest>

const session = (id: string, cards: ReadonlyArray<AppCard> = [], busy = false): SessionState => ({
  id,
  messages: [{ id: `message:${id}`, role: "user", text: id, at: 1 }],
  cards,
  busy
})

const runCard = (phase: "running" | "completed" = "running"): AppCard => ({
  kind: "flow-run", id: "execution", flowId: "build", executionId: "execution", phase, steps: []
})

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}
const respond = async (request: PendingRequest, body: unknown): Promise<void> => {
  request.resolve(Response.json(body))
  await flush()
}
const requestAt = (index: number): PendingRequest => {
  const request = requests[index]
  if (request === undefined) throw new Error(`Missing request ${index}`)
  return request
}

beforeEach(() => {
  vi.useFakeTimers()
  actions.newSession()
  requests = []
  // Deliberately ignore cancellation: a response already being decoded can
  // still finish after abort, so cancellation alone cannot protect the store.
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({ url, signal: init?.signal, resolve, reject })
  })))
})

afterEach(() => {
  actions.newSession()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("session loads", () => {
  it("rehydrates interleaved entries and keeps an updated card in place", async () => {
    const body = {
      ...session("selected", [runCard()]),
      messages: [
        { id: "m1", role: "user", text: "build", at: 1 },
        { id: "m2", role: "assistant", text: "started", at: 1 }
      ],
      entries: [
        { kind: "message", messageId: "m1" },
        { kind: "card", cardId: "execution" },
        { kind: "message", messageId: "m2" }
      ]
    }
    actions.selectSession("selected")
    await respond(requestAt(0), body)
    expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual(["m1", "card:execution", "m2"])
    const previous = store.getSnapshot().entries
    const reload = actions.loadSession("selected")
    await respond(requestAt(1), { ...body, cards: [runCard("completed")] })
    await reload
    expect(store.getSnapshot().entries).toBe(previous)
    expect(store.getSnapshot().cards.execution).toMatchObject({ phase: "completed" })
  })

  it("still loads legacy responses without entries", async () => {
    actions.selectSession("legacy")
    await respond(requestAt(0), session("legacy", [runCard()]))
    expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual(["message:legacy", "card:execution"])
  })

  it.each(["newer-first", "older-first"])("keeps the latest selection when responses arrive %s", async (order) => {
    actions.selectSession("older")
    actions.selectSession("newer")
    if (order === "newer-first") {
      await respond(requestAt(1), session("newer"))
      const selected = store.getSnapshot()
      await respond(requestAt(0), session("older"))
      expect(store.getSnapshot()).toBe(selected)
    } else {
      await respond(requestAt(0), session("older"))
      expect(store.getSnapshot().sessionId).toBe("newer")
      expect(store.getSnapshot().entries).toEqual([])
      await respond(requestAt(1), session("newer"))
    }
    expect(store.getSnapshot().sessionId).toBe("newer")
    expect(store.getSnapshot().entries[0]).toMatchObject({ text: "newer" })
    expect(requestAt(0).signal?.aborted).toBe(true)
  })

  it("ignores a stale failure", async () => {
    actions.selectSession("older")
    actions.selectSession("newer")
    await respond(requestAt(1), session("newer"))
    const selected = store.getSnapshot()
    requestAt(0).reject(new Error("old request failed"))
    await flush()
    expect(store.getSnapshot()).toBe(selected)
  })

  it("keeps a fresh session when a previous load completes", async () => {
    actions.selectSession("older")
    actions.newSession()
    const fresh = store.getSnapshot()
    await respond(requestAt(0), session("older"))
    expect(store.getSnapshot()).toBe(fresh)
    expect(requestAt(0).signal?.aborted).toBe(true)
  })

  it("supersedes an earlier load of the same session", async () => {
    actions.selectSession("same")
    const latest = actions.loadSession("same")
    await respond(requestAt(1), { ...session("same"), messages: [] })
    await latest
    const selected = store.getSnapshot()
    await respond(requestAt(0), session("same"))
    expect(store.getSnapshot()).toBe(selected)
  })

  it("does not let a pending load replace a newly submitted turn", async () => {
    actions.selectSession("selected")
    const turn = actions.submit("new message")
    const submitting = store.getSnapshot()
    await respond(requestAt(0), session("selected"))
    expect(store.getSnapshot()).toBe(submitting)
    expect(requestAt(0).signal?.aborted).toBe(true)
    requestAt(1).resolve(new Response('{"type":"done","output":null}\n'))
    await turn
    expect(store.getSnapshot().status).toBe("idle")
  })

  it("reports a current failure and clears it after a successful retry", async () => {
    actions.selectSession("selected")
    requestAt(0).reject(new Error("offline"))
    await flush()
    expect(store.getSnapshot()).toMatchObject({ status: "error", error: UNKNOWN_FAILURE_SENTENCE })
    const retry = actions.loadSession("selected")
    await respond(requestAt(1), session("selected"))
    await retry
    expect(store.getSnapshot()).toMatchObject({ status: "idle", error: undefined })
  })

  it("shows the Worker's refusal and hides a proxy's raw body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const refused = actions.submit("hello")
    requestAt(0).resolve(Response.json({ error: "A turn is already streaming for this session." }, { status: 409 }))
    await refused
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      error: "A turn is already streaming for this session."
    })
    const proxied = actions.submit("again")
    requestAt(1).resolve(new Response("<html>upstream stack at db.internal:5432</html>", { status: 502 }))
    await proxied
    expect(store.getSnapshot()).toMatchObject({ status: "error", error: UNKNOWN_FAILURE_SENTENCE })
    expect(JSON.stringify(store.getSnapshot())).not.toContain("db.internal")
  })

  it("preserves card keys and the whole snapshot for unchanged loads", async () => {
    actions.selectSession("selected")
    await respond(requestAt(0), session("selected", [runCard()]))
    const previous = store.getSnapshot()
    const notified = vi.fn()
    const unsubscribe = store.subscribe(notified)
    try {
      const reload = actions.loadSession("selected")
      await respond(requestAt(1), session("selected", [runCard()]))
      await reload
      expect(store.getSnapshot().entries.map((entry) => entry.id)).toEqual(previous.entries.map((entry) => entry.id))
      expect(store.getSnapshot()).toBe(previous)
      expect(notified).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it("updates card content and busy state without changing transcript keys", async () => {
    actions.selectSession("selected")
    await respond(requestAt(0), session("selected", [runCard()], true))
    const previous = store.getSnapshot()
    const reload = actions.loadSession("selected")
    await respond(requestAt(1), session("selected", [runCard("completed")]))
    await reload
    expect(store.getSnapshot().entries).toBe(previous.entries)
    expect(store.getSnapshot().cards.execution).toMatchObject({ phase: "completed" })
    expect(store.getSnapshot().status).toBe("idle")
  })

  it("applies message edits and card removals", async () => {
    actions.selectSession("selected")
    await respond(requestAt(0), session("selected", [runCard()]))
    const reload = actions.loadSession("selected")
    const edited = { ...session("selected"), messages: [{ id: "message:selected", role: "user", text: "edited", at: 1 }] }
    await respond(requestAt(1), edited)
    await reload
    expect(store.getSnapshot().cards).toEqual({})
    expect(store.getSnapshot().entries).toEqual([{ kind: "message", id: "message:selected", role: "user", text: "edited" }])
  })
})

describe("session changes during a turn", () => {
  it.each(["frames", "failure"])("ignores old stream %s without settling the new turn", async (ending) => {
    const oldTurn = actions.submit("old")
    actions.selectSession("selected")
    await respond(requestAt(1), session("selected"))
    const newTurn = actions.submit("new")
    const selected = store.getSnapshot()
    if (ending === "frames") {
      requestAt(0).resolve(new Response('{"type":"delta","text":"stale"}\n{"type":"done","output":null}\n'))
    } else {
      requestAt(0).reject(new Error("old stream failed"))
    }
    await oldTurn
    expect(store.getSnapshot()).toBe(selected)
    expect(requestAt(0).signal?.aborted).toBe(true)
    requestAt(2).resolve(new Response('{"type":"done","output":null}\n'))
    await newTurn
    expect(store.getSnapshot().status).toBe("idle")
  })

  it("uses server card keys for streamed cards too", () => {
    for (const type of ["card", "card.update"] as const) {
      expect(applyFrame(store.getSnapshot(), { type, card: runCard() }).entries).toEqual([
        { kind: "card", id: "card:execution", cardId: "execution" }
      ])
    }
  })
})

describe("flow-run card stream", () => {
  it("applies a streamed update before the run settles without polling", async () => {
    const running = actions.runFlow("build", {})
    expect(requestAt(0).url).toBe("/api/flows/run")
    const encoder = new TextEncoder()
    let sink!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { sink = controller }
    })
    requestAt(0).resolve(new Response(stream, { headers: { "content-type": "application/x-ndjson" } }))
    sink.enqueue(encoder.encode(JSON.stringify({ type: "card.update", card: runCard() }) + "\n"))
    await flush()
    expect(store.getSnapshot().cards.execution).toMatchObject({ phase: "running" })
    expect(store.getSnapshot().entries).toContainEqual({ kind: "card", id: "card:execution", cardId: "execution" })
    expect(requests).toHaveLength(1)
    sink.enqueue(encoder.encode(JSON.stringify({ type: "card.update", card: runCard("completed") }) + "\n"))
    sink.close()
    await running
    expect(store.getSnapshot().cards.execution).toMatchObject({ phase: "completed" })
    expect(requests).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["success", "failure"])("ignores a late run start %s after reselecting the same session", async (ending) => {
    const id = store.getSnapshot().sessionId
    const running = actions.runFlow("build", {})
    actions.newSession()
    actions.selectSession(id)
    await respond(requestAt(1), session(id))
    const selected = store.getSnapshot()
    if (ending === "success") requestAt(0).resolve(new Response(
      JSON.stringify({ type: "card.update", card: runCard() }) + "\n"
    ))
    else requestAt(0).reject(new Error("old run failed"))
    await running
    expect(store.getSnapshot()).toBe(selected)
    expect(vi.getTimerCount()).toBe(0)
  })
})
