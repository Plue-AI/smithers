import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TURN_PATH, TURN_REPLAY_PATH, TURN_RETIRE_PATH, TURN_ERASE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { AgentTurnJournalDeliverySchema, agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnJournalDelivery } from "@smthrs/rpc/AgentTurnJournal"
import { runRequest } from "./Boundary"
import type { NativeNamespace } from "./DurableStorage"
import { memoryStorage } from "./DurableStorage"
import { ExecutionContext, executionContextFrom, layersFromEnv } from "./Environment"
import { Transport, transportFrom } from "./Http"
import { handleRequest } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"
import { TURN_JOURNAL_RETENTION_MS } from "./TurnJournal"
import { LOGIN_ALL_KEY, loginDailyKey, sha256Hex, TurnRateLimiter } from "./turnLimit"

const journal = { version: 1 as const, legId: "leg-1", token: "private_replay_capability_12345678901234567890" }
const turn = { runId: "durable-turn", messages: [{ role: "user", content: "hi" }], instructions: "Be brief.", journal }
const delta = (text: string) => ({ type: "delta" as const, kind: "text" as const, text })
const done = { type: "done" as const, reason: "stop" as const }
/** One admitted signed-in turn spends the hourly, daily and all-logins ceilings once each. */
const admission = (login: string) => [login, loginDailyKey(login), LOGIN_ALL_KEY]
const wire = (...frames: unknown[]): Response => new Response(frames.map(frame => `${JSON.stringify(frame)}\n`).join(""), {
  headers: { "content-type": "application/x-ndjson" }
})
const intercept = (run: (request: Request, next: () => Promise<Response>) => Promise<Response>) => (namespace: NativeNamespace): NativeNamespace => ({
  idFromName: name => namespace.idFromName(name),
  get: id => ({ fetch: request => run(request, () => namespace.get(id).fetch(request)) })
})
const makeHost = (upstream: () => Response = () => wire(delta("answer"), done), namespace?: (inner: NativeNamespace) => NativeNamespace) => {
  const objects = memoryDurableObjects()
  const budgets = new Map<string, TurnRateLimiter>()
  const spent: string[] = []
  const journalOperations: string[] = []
  let modelCalls = 0
  let budgetRefused = false
  let validations = 0
  let revoked = false
  const transport = transportFrom(async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith("https://identity.invalid/")) {
      validations++
      if (revoked || !request.headers.has("cookie")) return new Response("", { status: 401 })
      return Response.json({ login: request.headers.get("cookie") === "session=bob" ? "bob" : "alice", allowlisted: true, admin: false, scopes: [] })
    }
    if (request.url === "https://model.invalid/chat") { modelCalls++; return upstream() }
    throw new Error(`Unexpected test transport: ${new URL(request.url).hostname}`)
  })
  const env = {
    ...objects,
    TURN_CANCELS: intercept(async (request, next) => {
      if (new URL(request.url).pathname === "/journal") journalOperations.push((await request.clone().json() as any).operation)
      return next()
    })(namespace?.(objects.TURN_CANCELS) ?? objects.TURN_CANCELS),
    TURN_LIMITS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({ fetch: (request: Request) => {
        const key = String(id)
        spent.push(key)
        if (budgetRefused) return Promise.resolve(Response.json({ allowed: false, remaining: 0, retryAt: Date.now() + 60_000 }))
        let limiter = budgets.get(key)
        if (limiter === undefined) { limiter = new TurnRateLimiter({ storage: memoryStorage() }); budgets.set(key, limiter) }
        return limiter.fetch(request)
      } })
    },
    IDENTITY_UPSTREAM_URL: "https://identity.invalid",
    SMITHERS_CHAT_URL: "https://model.invalid/chat",
    ASSETS: { fetch: async () => new Response("", { status: 404 }) }
  }
  const layers = Layer.mergeAll(layersFromEnv(env), Layer.succeed(ExecutionContext, executionContextFrom(undefined)))
  const post = (path: string, body: unknown, cookie = "session=alice", origin = "https://app.test") => {
    const request = new Request(`https://app.test${path}`, {
      method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify(body)
    })
    return runRequest(handleRequest(request).pipe(Effect.provideService(Transport, transport), Effect.provide(layers)), request.signal)
  }
  return {
    post, objects, modelCalls: () => modelCalls, validations: () => validations,
    spent: () => [...spent], journalOperations: () => [...journalOperations],
    revoke: () => { revoked = true }, refuseBudget: (refused: boolean) => { budgetRefused = refused }
  }
}
const deliveries = async (response: Response): Promise<AgentTurnJournalDelivery[]> => {
  expect(response.status).toBe(200)
  return (await response.text()).trim().split("\n").filter(Boolean).map(line => AgentTurnJournalDeliverySchema.parse(JSON.parse(line)))
}
const output = (frames: AgentTurnJournalDelivery[]) => frames.flatMap(frame => frame.type === "batch" ? frame.batch.frames : [])

describe("the public durable turn transport", () => {
  test("a refused fresh leg answers its budget refusal and writes no journal object", async () => {
    const host = makeHost()
    host.refuseBudget(true)
    const refused = await host.post(TURN_PATH, turn)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ code: "turn_rate_limited" })
    expect(host.journalOperations()).toEqual(["read"])
    expect(host.objects.storedJournalObjects()).toEqual([])
    expect(host.modelCalls()).toBe(0)
    host.refuseBudget(false)
    await deliveries(await host.post(TURN_PATH, turn))
    host.refuseBudget(true)
    // An accepted leg is only observed: no admission, no second inference.
    expect(await (await host.post(TURN_PATH, turn)).json()).toMatchObject({ status: "existing", terminal: true })
    // The refusal stops at the first ceiling; the admitted leg spends each once.
    expect(host.spent()).toEqual(["alice", ...admission("alice")])
    expect(host.modelCalls()).toBe(1)
  })

  test("signed-out erasure spends its address bucket before any tombstone is written", async () => {
    const retirementProof = await Effect.runPromise(sha256Hex(agentTurnJournalDigestInput("access", journal.token)))
    const erase = { runId: turn.runId, legId: journal.legId, retirementProof }
    const host = makeHost()
    host.refuseBudget(true)
    expect((await host.post(TURN_ERASE_PATH, erase, "")).status).toBe(429)
    expect(host.spent()).toEqual([expect.stringMatching(/^erase:anonymous:[0-9a-f]{64}$/)])
    expect(host.journalOperations()).toEqual([])
    expect(host.objects.storedJournalObjects()).toEqual([])
    host.refuseBudget(false)
    expect((await host.post(TURN_ERASE_PATH, erase, "")).status).toBe(200)
    expect(host.objects.storedJournalObjects()).toHaveLength(1)
  })

  test("every journal object, output or tombstone, is deleted by its retention alarm", async () => {
    const retirementProof = await Effect.runPromise(sha256Hex(agentTurnJournalDigestInput("access", journal.token)))
    const host = makeHost()
    const before = Date.now()
    await deliveries(await host.post(TURN_PATH, turn))
    expect((await host.post(TURN_ERASE_PATH, { runId: "unseen-turn", legId: journal.legId, retirementProof })).status).toBe(200)
    expect(host.objects.storedJournalObjects()).toHaveLength(2)
    const alarms = [...host.objects.turnAlarms().values()]
    expect(alarms).toHaveLength(2)
    for (const time of alarms) expect(time).toBeGreaterThanOrEqual(before + TURN_JOURNAL_RETENTION_MS)
    await host.objects.runTurnAlarms(before + TURN_JOURNAL_RETENTION_MS - 1)
    expect(host.objects.storedJournalObjects()).toHaveLength(2)
    await host.objects.runTurnAlarms(Math.max(...alarms))
    expect(host.objects.storedJournalObjects()).toEqual([])
    expect((await host.post(TURN_REPLAY_PATH, { runId: turn.runId, journal })).status).toBe(404)
  })

  test("delete-only proof cannot read, works after sign-out, and preemptively fences a delayed acceptance", async () => {
    const retirementProof = await Effect.runPromise(sha256Hex(agentTurnJournalDigestInput("access", journal.token)))
    const erase = { runId: turn.runId, legId: journal.legId, retirementProof }
    const host = makeHost()
    await deliveries(await host.post(TURN_PATH, turn))
    expect((await host.post(TURN_REPLAY_PATH, { runId: turn.runId, journal: { ...journal, token: retirementProof } })).status).toBe(403)
    expect((await host.post(TURN_ERASE_PATH, { ...erase, retirementProof: "0".repeat(64) })).status).toBe(403)
    host.revoke()
    const checks = host.validations()
    expect((await host.post(TURN_ERASE_PATH, erase)).status).toBe(200)
    expect(host.validations()).toBe(checks)
    expect((await host.post(TURN_ERASE_PATH, erase)).status).toBe(200)
    expect((await host.post(TURN_ERASE_PATH, erase, "", "https://foreign.invalid")).status).toBe(403)
    const delayed = makeHost()
    expect((await delayed.post(TURN_ERASE_PATH, erase)).status).toBe(200)
    delayed.objects.restart()
    expect((await delayed.post(TURN_PATH, turn)).status).toBe(410)
    expect(delayed.modelCalls()).toBe(0)
    expect((await delayed.post(TURN_REPLAY_PATH, { runId: turn.runId, journal })).status).toBe(410)
  })

  test("a foreign namespace reply is refused before model admission or output publication", async () => {
    const host = makeHost(undefined, intercept(async (_request, next) => {
      const response = await next()
      const value = await response.clone().json() as any
      if (value.status !== "accepted") return response
      return Response.json({ ...value, cursor: { ...value.cursor, legId: "foreign-leg" } })
    }))
    expect((await host.post(TURN_PATH, turn)).status).toBe(503)
    expect(host.modelCalls()).toBe(0)
  })
  test("actual turn POST records >1000 frames; repeat acceptance and paged replay never invoke inference again", async () => {
    const source = [...Array.from({ length: 1005 }, (_, index) => delta(`token-${index}`)), done]
    const host = makeHost(() => wire(...source))
    const response = await host.post(TURN_PATH, turn)
    expect(response.headers.get("x-smithers-turn-journal")).toBe("1")
    const delivered = await deliveries(response)
    const live = output(delivered)
    expect(live).toEqual(source.map(frame => ({ ...frame, runId: turn.runId })))
    expect(delivered[0]?.type).toBe("accepted")
    expect(delivered.at(-1)).toMatchObject({ type: "caught-up", terminal: true })
    const repeated = await host.post(TURN_PATH, turn)
    expect(await repeated.json()).toMatchObject({ status: "existing", terminal: true })
    expect(host.modelCalls()).toBe(1)
    expect(host.spent()).toEqual(admission("alice"))
    host.objects.restart()
    const replayed: unknown[] = []
    let after = null
    let more = true
    while (more) {
      const response = await host.post(TURN_REPLAY_PATH, { runId: turn.runId, journal, after })
      expect(response.status).toBe(200)
      const page = await response.json() as any
      replayed.push(...page.batches.flatMap((batch: any) => batch.frames))
      after = page.next
      more = page.more
    }
    expect(replayed).toEqual(live)
    expect(host.modelCalls()).toBe(1)
    expect(host.validations()).toBeGreaterThanOrEqual(4)
  })

  test("failed acceptance invokes no model; a changed request cannot reuse an accepted leg", async () => {
    const refusing = makeHost(undefined, intercept(async (request, next) => {
      if (new URL(request.url).pathname === "/journal" && (await request.clone().json() as any).operation === "accept") {
        return Response.json({ status: "error", code: "storage_failed" }, { status: 503 })
      }
      return next()
    }))
    expect((await refusing.post(TURN_PATH, turn)).status).toBe(503)
    expect(refusing.modelCalls()).toBe(0)
    // Admission precedes the acceptance write, so a failed write follows one admission.
    expect(refusing.spent()).toEqual(admission("alice"))
    const host = makeHost()
    await deliveries(await host.post(TURN_PATH, turn))
    expect((await host.post(TURN_PATH, { ...turn, instructions: "different request" })).status).toBe(409)
    expect(host.modelCalls()).toBe(1)
  })

  test("output cannot pass the HTTP body before its durable append receipt", async () => {
    const appendStarted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let gated = false
    const host = makeHost(undefined, intercept(async (request, next) => {
      if (!gated && new URL(request.url).pathname === "/journal" && (await request.clone().json() as any).operation === "append") {
        gated = true; appendStarted.resolve(); await release.promise
      }
      return next()
    }))
    const response = await host.post(TURN_PATH, turn)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"accepted"')
    let published = false
    const next = reader.read().then(frame => { published = true; return frame })
    await appendStarted.promise
    expect(published).toBe(false)
    const page = await (await host.post(TURN_REPLAY_PATH, { runId: turn.runId, journal })).json() as any
    expect(page.batches).toEqual([])
    expect(page.head.position).toBe(0)
    release.resolve()
    expect(new TextDecoder().decode((await next).value)).toContain('"type":"batch"')
    while (!(await reader.read()).done) { /* drain final catch-up */ }
  })

  test("a lost append receipt is retried by exact identity and publishes no duplicate output", async () => {
    let lost = false
    const host = makeHost(undefined, intercept(async (request, next) => {
      const append = new URL(request.url).pathname === "/journal" && (await request.clone().json() as any).operation === "append"
      const response = await next()
      if (append && !lost) { lost = true; throw new Error("Simulated lost receipt") }
      return response
    }))
    const streamed = output(await deliveries(await host.post(TURN_PATH, turn)))
    expect(streamed).toEqual([{ ...delta("answer"), runId: turn.runId }, { ...done, runId: turn.runId }])
    expect(host.modelCalls()).toBe(1)
    const page = await (await host.post(TURN_REPLAY_PATH, { runId: turn.runId, journal })).json() as any
    expect(page.head.position).toBe(2)
  })

  test("disconnect records a terminal observation and reconnect replays it without restarting inference", async () => {
    let cancelled = false
    const host = makeHost(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 64; index++) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(delta(`partial-${index}`))}\n`))
      },
      cancel() { cancelled = true }
    })))
    const response = await host.post(TURN_PATH, turn)
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    await reader.cancel("browser disconnected")
    const page = await (await host.post(TURN_REPLAY_PATH, { runId: turn.runId, journal })).json() as any
    expect(page.terminal).toBe(true)
    expect(page.batches.flatMap((batch: any) => batch.frames).at(-1)).toMatchObject({ type: "done", error: expect.stringContaining("ended before") })
    expect(cancelled).toBe(true)
    expect(host.modelCalls()).toBe(1)
  })

  test("every replay page checks current owner, capability and origin; retirement prevents reuse", async () => {
    const host = makeHost()
    await deliveries(await host.post(TURN_PATH, turn))
    const access = { runId: turn.runId, journal }
    expect((await host.post(TURN_REPLAY_PATH, access, "session=bob")).status).toBe(403)
    expect((await host.post(TURN_REPLAY_PATH, { ...access, journal: { ...journal, token: "wrong_capability_12345678901234567890123456" } })).status).toBe(403)
    expect((await host.post(TURN_REPLAY_PATH, access, "session=alice", "https://foreign.invalid")).status).toBe(403)
    expect((await host.post(TURN_RETIRE_PATH, access)).status).toBe(200)
    expect((await host.post(TURN_REPLAY_PATH, access)).status).toBe(410)
    expect((await host.post(TURN_PATH, turn)).status).toBe(410)
    expect(host.modelCalls()).toBe(1)
    const revoked = makeHost()
    await deliveries(await revoked.post(TURN_PATH, turn))
    revoked.revoke()
    const denied = await revoked.post(TURN_REPLAY_PATH, access)
    expect(denied.status).toBe(403)
    expect(await denied.text()).not.toContain("answer")
  })

  test("truncated, malformed and oversized output end with a recorded failure rather than a false complete answer", async () => {
    for (const upstream of [() => wire(delta("partial")), () => new Response("not a frame\n"), () => wire(delta("x".repeat(100_000)), done)]) {
      const host = makeHost(upstream)
      const frames = output(await deliveries(await host.post(TURN_PATH, turn)))
      expect(frames.at(-1)).toMatchObject({ type: "done", error: expect.any(String) })
      const replay = await (await host.post(TURN_REPLAY_PATH, { runId: turn.runId, journal })).json() as any
      expect(replay.terminal).toBe(true)
      expect(replay.batches.flatMap((batch: any) => batch.frames)).toEqual(frames)
    }
  })
})
