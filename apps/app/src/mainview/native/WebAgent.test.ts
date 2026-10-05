import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import type { AgentTurnFrame, StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import { createWebAgent } from "./WebAgent"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLead } from "@smthrs/rpc/RefusalCopy"

const request: StartAgentTurnRequest = {
  runId: "run-1",
  messages: [{ role: "user", content: "Hello who are you" }],
  instructions: "Be brief."
}

const ndjsonResponse = (lines: ReadonlyArray<unknown>, init?: ResponseInit): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        controller.close()
      }
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" }, ...init }
  )

const collect = (): { frames: AgentTurnFrame[]; push: (frame: AgentTurnFrame) => void } => {
  const frames: AgentTurnFrame[] = []
  return { frames, push: (frame) => frames.push(frame) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createWebAgent", () => {
  test("posts the turn to the same-origin boundary and streams frames to subscribers", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const agent = createWebAgent({
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return ndjsonResponse([
          { runId: "run-1", type: "delta", kind: "reasoning", text: "thinking" },
          { runId: "run-1", type: "delta", kind: "text", text: "Hi, I'm Smithers." },
          { runId: "run-1", type: "done" }
        ])
      }
    })
    const { frames, push } = collect()
    agent.subscribe(push)

    const result = await agent.startTurn(request)
    expect(result).toEqual({ status: "started" })
    await flush()

    expect(calls[0]?.url).toBe("/api/agent/turn")
    expect(calls[0]?.body).toEqual(request)
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "reasoning", text: "thinking" },
      { runId: "run-1", type: "delta", kind: "text", text: "Hi, I'm Smithers." },
      { runId: "run-1", type: "done" }
    ])
  })

  test.each([true, false])("a terminal frame ends delivery with coalesced chunks: %s", async coalesced => {
    const frames: AgentTurnFrame[] = []
    const lines: AgentTurnFrame[] = [
      { runId: "run-1", type: "delta", kind: "text", text: "before" },
      { runId: "run-1", type: "done" },
      { runId: "run-1", type: "delta", kind: "text", text: "after" },
      { runId: "run-1", type: "done" }
    ]
    let cancelled!: () => void
    const cancellation = new Promise<void>(resolve => { cancelled = resolve })
    const agent = createWebAgent({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        const chunks = coalesced ? [lines.map(line => JSON.stringify(line)).join("\n") + "\n"] : lines.map(line => JSON.stringify(line) + "\n")
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      },
      cancel() { cancelled() }
    })) })
    agent.subscribe(frame => { frames.push(frame) })
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await cancellation
    expect(frames).toEqual(lines.slice(0, 2))
  })

  test("drops frames for other runs and malformed lines without failing the turn", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        ndjsonResponse([
          "not-json",
          { runId: "other-run", type: "delta", kind: "text", text: "stray" },
          { runId: "run-1", type: "delta", kind: "text", text: "kept" },
          { runId: "run-1", type: "done" }
        ])
    })
    const { frames, push } = collect()
    agent.subscribe(push)

    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await flush()
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "text", text: "kept" },
      { runId: "run-1", type: "done" }
    ])
  })

  test("a stream that ends without a done frame is an honest failure, not a silent stall", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => ndjsonResponse([{ runId: "run-1", type: "delta", kind: "text", text: "partial" }])
    })
    const { frames, push } = collect()
    agent.subscribe(push)

    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await flush()
    expect(frames[frames.length - 1]).toEqual({
      runId: "run-1",
      type: "done",
      error: "The response stream ended before Smithers finished the turn."
    })
  })

  test("a stream that errors mid-turn ends with a product sentence, never the thrown text", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error("ECONNRESET secret-socket-detail")) }
      }))
    })
    const { frames, push } = collect()
    agent.subscribe(push)

    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await flush()
    expect(frames[frames.length - 1]).toEqual({ runId: "run-1", type: "done", error: "The Smithers web agent stream failed." })
    expect(JSON.stringify(frames)).not.toContain("secret-socket-detail")
  })

  test("an HTTP failure is classified by its status; the upstream's text never reaches the chat", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => new Response("upstream exploded", { status: 502 })
    })
    const result = await agent.startTurn(request)
    expect(result).toEqual({ status: "error", message: "Smithers Cloud is unreachable right now. Try again in a moment." })
  })

  test("a Worker code reads as its written lead, not the Worker's words", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => Response.json({ status: "error", code: "request_body_too_large", message: "body 9000000 > 8388608" }, { status: 413 })
    })
    const result = await agent.startTurn(request)
    const message = result.status === "error" ? result.message : ""
    expect(message).toBe(`The Smithers web agent didn't run that turn. ${refusalLead(refusalOf({ body: { code: "request_body_too_large" }, status: 413, message: "" }))}`)
    expect(message).not.toContain("8388608")
  })

  test("returns an error when the boundary is unreachable", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => {
        throw new Error("connection refused secret-socket-detail")
      }
    })
    const result = await agent.startTurn(request)
    /* The thrown text never becomes the transcript's sentence. */
    expect(result).toEqual({
      status: "error",
      message: "Could not reach the Smithers web agent."
    })
  })

  test("cancelTurn aborts the local stream and notifies the server boundary", async () => {
    const calls: string[] = []
    const agent = createWebAgent({
      fetchImpl: async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith("/cancel")) return new Response("{}", { status: 200 })
        return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
          status: 200
        })
      }
    })
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await agent.cancelTurn("run-1")
    expect(calls).toContain("/api/agent/turn/cancel")
  })

  test("cancelTurn aborts a turn that is still waiting on the boundary to respond", async () => {
    let aborted = false
    const agent = createWebAgent({
      fetchImpl: (input, init) => {
        if (String(input).endsWith("/cancel")) return Promise.resolve(new Response("{}"))
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        })
      }
    })
    const started = agent.startTurn(request)
    await Promise.resolve()
    await agent.cancelTurn("run-1")
    expect(aborted).toBe(true)
    // The user stopped the turn, so this is not reported back as a failed turn.
    expect((await started).status).toBe("started")
  })

  test("an uncoded refusal the person can act on keeps its sentence, never the raw JSON body", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: "error", message: "That turn is already running." }), {
          status: 409,
          headers: { "content-type": "application/json" }
        })
    })
    const result = await agent.startTurn(request)
    expect(result).toEqual({
      status: "error",
      message: "That turn is already running."
    })
  })

  /*
   * §24.3 — the app's honesty must not depend on every upstream writing
   * user-facing prose. A model provider answers a nested wire error and a
   * Worker crash answers an HTML page; both used to be pasted into the chat.
   */
  test("a provider rate-limit body is classified, never pasted into the chat", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "Number of request tokens has exceeded your per-minute rate limit"
            }
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
    })
    const result = await agent.startTurn(request)
    const message = result.status === "error" ? result.message : ""
    expect(message).toBe("The model provider is rate-limiting this account. Try again in a minute.")
    expect(message).not.toContain("rate_limit_error")
    expect(message).not.toContain("{")
  })

  test("a Cloudflare HTML error page never reaches the transcript", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        new Response("<!DOCTYPE html><html><body>Error 1101 Worker threw exception</body></html>", {
          status: 500,
          headers: { "content-type": "text/html" }
        })
    })
    const result = await agent.startTurn(request)
    const message = result.status === "error" ? result.message : ""
    expect(message).toBe("Smithers Cloud hit an error on that turn.")
    expect(message).not.toContain("<")
    expect(message).not.toContain("1101")
  })

  /*
   * The turn ceiling's refusal is written to be read by a person: it names a
   * loop and says nothing was charged, because someone who trips it hit a bug
   * and must never be sent to billing. That is only true if the sentence
   * actually reaches the transcript, which is what this pins.
   */
  test("surfaces the turn ceiling's refusal verbatim, so the user reads the real reason", async () => {
    const agent = createWebAgent({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "error",
            code: "turn_rate_limited",
            message:
              "That is more than 1000 model calls in an hour, which no conversation reaches by hand — something is looping. Chat resumes on its own in about 12 minutes. Nothing was charged and your balance is untouched."
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "720" } }
        )
    })
    const result = await agent.startTurn(request)
    expect(result.status).toBe("error")
    expect(result.status === "error" ? result.message : "").toContain("something is looping")
    expect(result.status === "error" ? result.message : "").toContain("balance is untouched")
    expect(result.status === "error" ? result.message : "").not.toContain("upgrade")
  })

  /*
   * The anonymous turn ceiling (apps/server turnLimit.ts) is the one refusal
   * the app renders as its own card, so the agent states it by CODE beside
   * the sentence: a 429 that carries `code: "turn_rate_limited"` is a turn
   * refusal with the server's sentence and reset time, and a 429 from a
   * provider (no code) or a plain sentence stays a classified failure.
   */
  const refused = async (body: string, headers: Record<string, string> = { "content-type": "application/json" }) => {
    const agent = createWebAgent({ fetchImpl: async () => new Response(body, { status: 429, headers }) })
    return agent.startTurn(request)
  }

  test("states the ceiling's per-address refusal by code, with its sentence and reset time", async () => {
    const message =
      "That is 20 turns today without signing in, which is as far as exploring goes. Sign in with GitHub to keep going, or come back in about 6 hours. Nothing was charged."
    const result = await refused(
      JSON.stringify({ status: "error", code: "turn_rate_limited", message, retryAt: "2026-09-08T00:00:00.000Z" })
    )
    expect(result.status).toBe("error")
    if (result.status !== "error") return
    expect(result.refusal).toEqual({ code: "turn_rate_limited", message, retryAt: "2026-09-08T00:00:00.000Z" })
    expect(result.message).toContain("as far as exploring goes")
  })

  test("states the deployment-wide refusal the same way, with a null reset when the body names none", async () => {
    const message =
      "Exploring without signing in has reached its daily limit for everyone, not just you. Sign in with GitHub to keep going, or come back in about 3 hours. Nothing was charged."
    const result = await refused(JSON.stringify({ status: "error", code: "turn_rate_limited", message }))
    expect(result.status === "error" ? result.refusal : undefined).toEqual({
      code: "turn_rate_limited",
      message,
      retryAt: null
    })
  })

  test("a 429 without the ceiling's code carries no refusal", async () => {
    const provider = await refused(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }))
    expect(provider.status === "error" ? provider.refusal : "started").toBeUndefined()
    const prose = await refused("Too many requests", { "content-type": "text/plain" })
    expect(prose.status === "error" ? prose.refusal : "started").toBeUndefined()
    /* A plain-text 429 is classified; its body is plumbing. */
    expect(prose.status === "error" ? prose.message : "").toBe("The model provider is rate-limiting this account. Try again in a minute.")
  })

  test("only a coded sign-in 401 becomes a sign-in refusal", async () => {
    for (const [status, code, expected] of [[401, "sign_in_required", true], [401, "unauthorized", true], [401, "unauthenticated", true], [401, "upstream_unavailable", false], [429, "sign_in_required", false], [403, "unauthorized", false], [429, "unauthorized", false]] as const) {
      const agent = createWebAgent({ fetchImpl: async () => new Response(JSON.stringify({ code, message: "Sign in to run a Smithers turn." }), { status }) })
      const result = await agent.startTurn(request)
      expect(result.status === "error" ? result.refusal : undefined).toEqual(expected ? { code: "sign_in_required", message: "Sign in to run a Smithers turn.", retryAt: null } : undefined)
    }
  })

  test("a coded 402 carries the typed out-of-credit sentence", async () => {
    for (const [code, expected] of [["out_of_credit", true], ["payment_required", false]] as const) {
      const agent = createWebAgent({ fetchImpl: async () => new Response(JSON.stringify({ status: "error", code, message: "Out of credit." }), { status: 402 }) })
      const result = await agent.startTurn(request)
      expect(result.status === "error" ? result.refusal : undefined).toEqual(expected ? { code: "out_of_credit", message: "Out of credit.", retryAt: null } : undefined)
      if (expected) expect(result.status === "error" ? result.message : "").toContain("Out of credit.")
    }
  })

  test("rejects a duplicate runId while a turn is active", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 })
    })
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    const duplicate = await agent.startTurn(request)
    expect(duplicate.status).toBe("error")
  })

  test("passes card frames from the boundary through to subscribers", async () => {
    const statusCard: Card = {
      id: "card-status",
      kind: "status",
      title: "Working",
      status: "active",
      createdAt: 1,
      ordinal: 1,
      payload: { progress: 0.5 }
    }
    const agent = createWebAgent({
      fetchImpl: async () =>
        ndjsonResponse([
          { runId: "run-1", type: "card", card: statusCard },
          { runId: "run-1", type: "card", card: { id: "card-bad", kind: "nonsense" } },
          { runId: "run-1", type: "done" }
        ])
    })
    const { frames, push } = collect()
    agent.subscribe(push)

    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await flush()
    expect(frames).toEqual([
      { runId: "run-1", type: "card", card: statusCard },
      { runId: "run-1", type: "done" }
    ])
  })

  /*
   * A tool loop continues the SAME runId: state/controller/turns.ts awaits the
   * tool and calls launchLeg, which can land inside the `done` frame's own
   * listener. The leg must be admitted, and Stop must still reach its stream.
   */
  test("a continuation leg re-POSTing the runId from the done frame is admitted and keeps its cancel handle", async () => {
    let turns = 0
    let continuationSignal: AbortSignal | null | undefined
    const agent = createWebAgent({
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/cancel")) return new Response("{}", { status: 200 })
        turns += 1
        if (turns === 1) return ndjsonResponse([{ runId: "run-1", type: "done" }])
        continuationSignal = init?.signal
        return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 })
      }
    })
    let continuation: Promise<StartAgentTurnResult> | undefined
    agent.subscribe((frame) => {
      if (frame.type !== "done" || continuation !== undefined) return
      continuation = agent.startTurn(request)
    })

    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await flush()
    expect(await continuation).toEqual({ status: "started" })

    await agent.cancelTurn("run-1")
    expect(continuationSignal?.aborted).toBe(true)
  })

  test("a replacement turn keeps the runId while the previous leg's stream teardown is still settling", async () => {
    let releaseTeardown = (): void => {}
    const teardown = new Promise<void>((resolve) => {
      releaseTeardown = () => resolve()
    })
    const signals: Array<AbortSignal> = []
    let turns = 0
    const agent = createWebAgent({
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/cancel")) return new Response("{}", { status: 200 })
        if (init?.signal != null) signals.push(init.signal)
        turns += 1
        const first = turns === 1
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (!first) return
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ runId: "run-1", type: "done" })}\n`))
            },
            // The first leg's reader.cancel() stays pending until the test releases it.
            cancel: () => (first ? teardown : undefined)
          }),
          { status: 200 }
        )
      }
    })

    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await flush()
    expect(await agent.startTurn(request)).toEqual({ status: "started" })

    releaseTeardown()
    await flush()
    // The old leg's teardown settled, but the replacement still owns run-1.
    expect((await agent.startTurn(request)).status).toBe("error")
    await agent.cancelTurn("run-1")
    expect(signals[1]?.aborted).toBe(true)
  })
})

const agents = new Set<ReturnType<typeof createWebAgent>>()
const makeAgent: typeof createWebAgent = options => { const agent = createWebAgent(options); agents.add(agent); return agent }
const releases = new Set<() => void>()
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve))
const idleStream = (signal?: AbortSignal | null): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) {
    const finish = () => { try { controller.error(new DOMException("Aborted", "AbortError")) } catch {} }
    releases.add(finish)
    if (signal?.aborted) finish()
    else signal?.addEventListener("abort", finish, { once: true })
  }
})
afterEach(async () => {
  for (const agent of agents) agent.journal?.disconnect(request.runId)
  for (const release of releases) release()
  releases.clear()
  await checkpoint()
  agents.clear()
})
const collectTerminal = () => {
  const frames: AgentTurnFrame[] = []
  let finish!: () => void
  const terminal = new Promise<void>(resolve => { finish = resolve })
  return { frames, terminal, push: (frame: AgentTurnFrame) => { frames.push(frame); if (frame.type === "done") finish() } }
}

test("omitted options delegate all default routes to the scoped global fetch", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!
  const calls: Array<{ url: string; method: string | undefined; headers: [string, string][]; body: unknown }> = []
  const delegated = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async function(this: unknown, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    expect(this).toBe(globalThis)
    calls.push({ url: String(input), method: init?.method, headers: [...new Headers(init?.headers)], body: JSON.parse(String(init?.body)) })
    if (String(input) === "/api/agent/turn") return ndjsonResponse([{ runId: "run-1", type: "done" }])
    if (String(input) === "/api/agent/turn/replay") return Response.json({ status: "error", code: "not-found" }, { status: 404 })
    if (String(input) === "/api/agent/turn/retire") return Response.json({ status: "retired" })
    return Response.json({})
  }, { preconnect: () => { throw new Error("Unexpected preconnect.") } }))
  let agent: ReturnType<typeof createWebAgent> | undefined
  let remove: (() => void) | undefined
  const access = { runId: "run-1", journal: { version: 1 as const, legId: "leg-1", token: "a".repeat(64) } }
  try {
    agent = makeAgent()
    const { frames, push, terminal } = collectTerminal()
    remove = agent.subscribe(push)
    expect(agent.available).toBe(true)
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await terminal
    await agent.cancelTurn(request.runId)
    expect(await agent.journal!.read(access)).toEqual({ status: "error", code: "not-found" })
    await expect(agent.journal!.retire(access)).resolves.toBeUndefined()
    expect(calls).toEqual([
      { url: "/api/agent/turn", method: "POST", headers: [["content-type", "application/json"]], body: request },
      { url: "/api/agent/turn/cancel", method: "POST", headers: [["content-type", "application/json"]], body: { runId: "run-1" } },
      { url: "/api/agent/turn/replay", method: "POST", headers: [["content-type", "application/json"]], body: access },
      { url: "/api/agent/turn/retire", method: "POST", headers: [["content-type", "application/json"]], body: access }
    ])
    expect(frames).toEqual([{ runId: "run-1", type: "done" }])
    expect(delegated).toHaveBeenCalledTimes(4)
  } finally {
    try {
      remove?.()
      agent?.journal?.disconnect(request.runId)
      await checkpoint()
    } finally {
      delegated.mockRestore()
      Object.defineProperty(globalThis, "fetch", descriptor)
      expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(descriptor)
    }
  }
})

test.each(["Error", "non-Error"] as const)("legacy reader %s cancellation rejection preserves the terminal and successor handle", async kind => {
  const entered = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>()
  let posts = 0, successorSignal: AbortSignal | null | undefined
  const agent = makeAgent({ fetchImpl: async (url, init) => {
    if (String(url).endsWith("/cancel")) return Response.json({})
    if (++posts > 1) { successorSignal = init?.signal; return new Response(idleStream(init?.signal)) }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"runId":"run-1","type":"done"}\n')) },
      cancel() { entered.resolve(); return cleanup.promise }
    }))
  } })
  const { frames, push, terminal } = collectTerminal()
  const remove = agent.subscribe(push)
  try {
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await terminal
    await entered.promise
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    cleanup.reject(kind === "Error" ? new Error("owned cancel rejected") : "owned cancel rejected")
    await checkpoint()
    expect(frames).toEqual([{ runId: "run-1", type: "done" }])
    expect(await agent.startTurn(request)).toEqual({ status: "error", message: "That Smithers turn is already running." })
    expect(posts).toBe(2)
    expect(successorSignal?.aborted).toBe(false)
    await agent.cancelTurn(request.runId)
    expect(successorSignal?.aborted).toBe(true)
  } finally {
    cleanup.resolve()
    await cleanup.promise.catch(() => {})
    remove()
    agent.journal!.disconnect(request.runId)
    await checkpoint()
  }
})

test.each(["Error", "non-Error"] as const)("legacy reader %s cancellation rejection preserves the terminal and successor handle", async kind => {
  const entered = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>()
  let posts = 0, successorSignal: AbortSignal | null | undefined
  const agent = makeAgent({ fetchImpl: async (url, init) => {
    if (String(url).endsWith("/cancel")) return Response.json({})
    if (++posts > 1) { successorSignal = init?.signal; return new Response(idleStream(init?.signal)) }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"runId":"run-1","type":"done"}\n')) },
      cancel() { entered.resolve(); return cleanup.promise }
    }))
  } })
  const { frames, push, terminal } = collectTerminal()
  const remove = agent.subscribe(push)
  try {
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    await terminal
    await entered.promise
    expect(await agent.startTurn(request)).toEqual({ status: "started" })
    cleanup.reject(kind === "Error" ? new Error("owned cancel rejected") : "owned cancel rejected")
    await checkpoint()
    expect(frames).toEqual([{ runId: "run-1", type: "done" }])
    expect(await agent.startTurn(request)).toEqual({ status: "error", message: "That Smithers turn is already running." })
    expect(posts).toBe(2)
    expect(successorSignal?.aborted).toBe(false)
    await agent.cancelTurn(request.runId)
    expect(successorSignal?.aborted).toBe(true)
  } finally {
    cleanup.resolve()
    await cleanup.promise.catch(() => {})
    remove()
    agent.journal!.disconnect(request.runId)
    await checkpoint()
  }
})

test.each(["whole", "byte-split"] as const)("UTF8 %s frames preserve Unicode, CRLF and the final frame without LF", async mode => {
  const bytes = new TextEncoder().encode('\r\n' + JSON.stringify({ runId: "run-1", type: "delta", kind: "text", text: "Hi 😀 é 世界" }) + '\r\n' + JSON.stringify({ runId: "run-1", type: "done" }))
  const agent = makeAgent({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (mode === "whole") controller.enqueue(bytes)
    else for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })) })
  const { frames, push, terminal } = collectTerminal()
  agent.subscribe(push)
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await terminal
  expect(frames).toEqual([{ runId: "run-1", type: "delta", kind: "text", text: "Hi 😀 é 世界" }, { runId: "run-1", type: "done" }])
})

test("unsubscribe is idempotent and preserves registration order for remaining subscribers", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let firstSeen!: () => void
  const first = new Promise<void>(resolve => { firstSeen = resolve })
  const observations: string[] = []
  const agent = makeAgent({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start(value) {
    controller = value
    releases.add(() => { try { controller.close() } catch {} })
  } })) })
  const removeA = agent.subscribe(frame => { observations.push(`A:${frame.type}`); firstSeen() })
  agent.subscribe(frame => { observations.push(`B:${frame.type}`) })
  const { terminal, push } = collectTerminal()
  agent.subscribe(push)
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ runId: "run-1", type: "delta", kind: "text", text: "one" }) + "\n"))
  await first
  removeA()
  removeA()
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ runId: "run-1", type: "done" }) + "\n"))
  await terminal
  expect(observations).toEqual(["A:delta", "B:delta", "B:done"])
})

const failedTerminalCases = [
  { cause: "done", terminal: { runId: "run-1", type: "done" } },
  { cause: "EOF", terminal: { runId: "run-1", type: "done", error: "The response stream ended before Smithers finished the turn." } },
  { cause: "Error", terminal: { runId: "run-1", type: "done", error: "The Smithers web agent stream failed." } },
  { cause: "non-Error", terminal: { runId: "run-1", type: "done", error: "The Smithers web agent stream failed." } }
] as const

test.each([...failedTerminalCases])("$cause terminal permits immediate retry and old teardown preserves the successor cancel handle", async ({ cause, terminal: expectedTerminal }) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let entered!: () => void
  const firstDelta = new Promise<void>(resolve => { entered = resolve })
  let notified!: () => void
  const terminal = new Promise<void>(resolve => { notified = resolve })
  let continuation: Promise<StartAgentTurnResult> | undefined
  let successorSignal: AbortSignal | null | undefined
  const seen: string[] = [], frames: AgentTurnFrame[] = []
  let turns = 0
  const agent = makeAgent({ fetchImpl: async (url, init) => {
    seen.push(String(url))
    if (String(url).endsWith("/cancel")) return Response.json({})
    if (++turns > 1) { successorSignal = init?.signal; return new Response(idleStream(init?.signal)) }
    return new Response(new ReadableStream<Uint8Array>({ start(value) {
      controller = value
      releases.add(() => { try { controller.close() } catch {} })
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ runId: "run-1", type: "delta", kind: "text", text: "read began" }) + "\n"))
    } }))
  } })
  agent.subscribe(frame => {
    frames.push(frame)
    if (frame.type === "delta") entered()
    if (frame.type === "done" && continuation === undefined) { continuation = agent.startTurn(request); notified() }
  })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await firstDelta
  if (cause === "done") controller.enqueue(new TextEncoder().encode(JSON.stringify({ runId: "run-1", type: "done" }) + "\n"))
  else if (cause === "EOF") controller.close()
  else controller.error(cause === "Error" ? new Error("owned reader failed") : "transport failed without Error")
  await terminal
  expect(await continuation).toEqual({ status: "started" })
  await checkpoint()
  expect(frames).toEqual([{ runId: "run-1", type: "delta", kind: "text", text: "read began" }, expectedTerminal])
  expect(await agent.startTurn(request)).toEqual({ status: "error", message: "That Smithers turn is already running." })
  expect(turns).toBe(2)
  expect(successorSignal?.aborted).toBe(false)
  await agent.cancelTurn(request.runId)
  expect(successorSignal?.aborted).toBe(true)
  expect(seen).toEqual(["/api/agent/turn", "/api/agent/turn", "/api/agent/turn/cancel"])
})

test("journal disconnect aborts only the owned local turn, never POSTs cancel, and permits a fresh admission", async () => {
  const calls: string[] = [], signals: AbortSignal[] = [], frames: AgentTurnFrame[] = []
  const agent = makeAgent({ fetchImpl: async (url, init) => {
    calls.push(String(url))
    if (init?.signal == null) throw new Error("Expected owned turn signal")
    signals.push(init.signal)
    return new Response(idleStream(init.signal))
  } })
  agent.subscribe(frame => { frames.push(frame) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  agent.journal!.disconnect("another-run")
  expect(signals[0]?.aborted).toBe(false)
  agent.journal!.disconnect(request.runId)
  agent.journal!.disconnect(request.runId)
  expect(signals[0]?.aborted).toBe(true)
  await checkpoint()
  expect(frames).toEqual([])
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  expect(signals[1]?.aborted).toBe(false)
  expect(calls).toEqual(["/api/agent/turn", "/api/agent/turn"])
})

test.each(["Error", "non-Error"] as const)("failed %s cancel transport still aborts locally and preserves a fresh custom-route admission", async cause => {
  const calls: Array<{ url: string; method: string | undefined; headers: Array<[string, string]>; body: unknown }> = []
  const signals: AbortSignal[] = [], frames: AgentTurnFrame[] = []
  const agent = makeAgent({ baseUrl: "https://boundary.test", turnPath: "/custom/turn", cancelPath: "/custom/cancel", fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: [...new Headers(init?.headers).entries()], body: JSON.parse(String(init?.body)) })
    if (String(url) === "https://boundary.test/custom/cancel") throw cause === "Error" ? new Error("cancel transport failed") : "cancel transport failed without Error"
    if (init?.signal == null) throw new Error("Expected local turn signal")
    signals.push(init.signal)
    return new Response(idleStream(init.signal))
  } })
  agent.subscribe(frame => { frames.push(frame) })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await agent.cancelTurn(request.runId)
  expect(signals[0]?.aborted).toBe(true)
  await checkpoint()
  expect(frames).toEqual([])
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  expect(signals[1]?.aborted).toBe(false)
  expect(await agent.startTurn(request)).toEqual({ status: "error", message: "That Smithers turn is already running." })
  expect(calls).toEqual([
    { url: "https://boundary.test/custom/turn", method: "POST", headers: [["content-type", "application/json"]], body: request },
    { url: "https://boundary.test/custom/cancel", method: "POST", headers: [["content-type", "application/json"]], body: { runId: "run-1" } },
    { url: "https://boundary.test/custom/turn", method: "POST", headers: [["content-type", "application/json"]], body: request }
  ])
})

test.each([
  { cause: "Error", message: "Could not reach the Smithers web agent." },
  { cause: "non-Error", message: "Could not reach the Smithers web agent." }
] as const)("a failed $cause connect releases the run for immediate successful retry", async ({ cause, message }) => {
  let posts = 0
  const agent = makeAgent({ fetchImpl: async () => {
    if (++posts === 1) throw cause === "Error" ? new Error("connection refused") : "opaque transport rejection"
    return ndjsonResponse([{ runId: "run-1", type: "done" }])
  } })
  const { frames, push, terminal } = collectTerminal()
  agent.subscribe(push)
  expect(await agent.startTurn(request)).toEqual({ status: "error", message })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await terminal
  expect(frames).toEqual([{ runId: "run-1", type: "done" }])
  expect(posts).toBe(2)
})

test("an aborted pending connect settling late cannot remove the replacement turn handle", async () => {
  let entered!: () => void
  const admission = new Promise<void>(resolve => { entered = resolve })
  let releaseOld!: () => void
  const oldSettlement = new Promise<void>(resolve => { releaseOld = resolve })
  releases.add(releaseOld)
  let oldSignal: AbortSignal | null | undefined
  let newSignal: AbortSignal | null | undefined
  let turns = 0
  const urls: string[] = []
  const agent = makeAgent({ fetchImpl: async (url, init) => {
    urls.push(String(url))
    if (String(url).endsWith("/cancel")) return Response.json({})
    if (++turns === 1) {
      oldSignal = init?.signal
      entered()
      await oldSettlement
      throw new DOMException("The old connect was aborted", "AbortError")
    }
    newSignal = init?.signal
    return new Response(idleStream(init?.signal))
  } })
  const first = agent.startTurn(request)
  await admission
  agent.journal!.disconnect(request.runId)
  expect(oldSignal?.aborted).toBe(true)
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  releaseOld()
  expect(await first).toEqual({ status: "started" })
  await checkpoint()
  expect(await agent.startTurn(request)).toEqual({ status: "error", message: "That Smithers turn is already running." })
  expect(newSignal?.aborted).toBe(false)
  await agent.cancelTurn(request.runId)
  expect(newSignal?.aborted).toBe(true)
  expect(urls).toEqual(["/api/agent/turn", "/api/agent/turn", "/api/agent/turn/cancel"])
})

const classifiedStatuses = [
  { status: 401, message: "That turn wasn't authorized — sign in again and retry." },
  { status: 403, message: "That turn wasn't authorized — sign in again and retry." },
  { status: 402, message: "That turn wasn't run because the account has no balance left." },
  { status: 408, message: "That turn timed out before the model answered." },
  { status: 504, message: "That turn timed out before the model answered." },
  { status: 502, message: "Smithers Cloud is unreachable right now. Try again in a moment." },
  { status: 503, message: "Smithers Cloud is unreachable right now. Try again in a moment." },
  { status: 500, message: "Smithers Cloud hit an error on that turn." },
  { status: 429, message: "The model provider is rate-limiting this account. Try again in a minute." },
  { status: 418, message: "The Smithers web agent didn't run that turn. Smithers can't do that as asked." }
] as const

for (const shape of ["wire-json", "html"] as const) test.each([...classifiedStatuses])(`HTTP $status ${shape} receives its literal classification without leaking transport details`, async ({ status, message }) => {
  const body = shape === "wire-json" ? JSON.stringify({ type: "error", error: { message: "private transport details" } }) : "<html><body>private transport details</body></html>"
  const agent = makeAgent({ fetchImpl: async () => new Response(body, { status, headers: { "content-type": shape === "wire-json" ? "application/json" : "text/html" } }) })
  expect(await agent.startTurn(request)).toEqual({ status: "error", message })
})

test("a successful empty response refuses honestly and releases the same run for retry", async () => {
  let calls = 0
  const agent = makeAgent({ fetchImpl: async () => ++calls === 1 ? new Response(null) : ndjsonResponse([{ runId: "run-1", type: "done" }]) })
  const { frames, push, terminal } = collectTerminal()
  agent.subscribe(push)
  expect(await agent.startTurn(request)).toEqual({ status: "error", message: "The Smithers web agent returned no response stream." })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await terminal
  expect(frames).toEqual([{ runId: "run-1", type: "done" }])
  expect(calls).toBe(2)
})

test("a failed error-body read uses the safe status fallback and permits retry", async () => {
  let calls = 0
  const agent = makeAgent({ fetchImpl: async () => ++calls === 1
    ? new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private body IO failure")) } }), { status: 502 })
    : ndjsonResponse([{ runId: "run-1", type: "done" }]) })
  const { frames, push, terminal } = collectTerminal()
  agent.subscribe(push)
  expect(await agent.startTurn(request)).toEqual({ status: "error", message: "Smithers Cloud is unreachable right now. Try again in a moment." })
  expect(await agent.startTurn(request)).toEqual({ status: "started" })
  await terminal
  expect(frames).toEqual([{ runId: "run-1", type: "done" }])
  expect(calls).toBe(2)
})
