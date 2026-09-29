import { describe, expect, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import type { AgentTurnFrame, StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import { createWebAgent } from "./WebAgent"

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

  test("returns an honest error when the boundary responds with an HTTP failure", async () => {
    const agent = createWebAgent({
      fetchImpl: async () => new Response("upstream exploded", { status: 502 })
    })
    const result = await agent.startTurn(request)
    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.message).toContain("HTTP 502")
      expect(result.message).toContain("upstream exploded")
    }
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

  test("surfaces the boundary's JSON error message rather than a raw JSON body", async () => {
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
      message: "Smithers web agent failed (HTTP 409): That turn is already running."
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
    expect(message).toContain("rate-limiting")
    expect(message).toContain("429")
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
    expect(message).toContain("500")
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
    expect(prose.status === "error" ? prose.message : "").toContain("Too many requests")
  })

  test("only a coded sign-in 401 becomes a sign-in refusal", async () => {
    for (const [status, code, expected] of [[401, "sign_in_required", true], [401, "unauthorized", true], [401, "upstream_unavailable", false], [429, "sign_in_required", false], [403, "unauthorized", false], [429, "unauthorized", false]] as const) {
      const agent = createWebAgent({ fetchImpl: async () => new Response(JSON.stringify({ code, message: "Sign in to run a Smithers turn." }), { status }) })
      const result = await agent.startTurn(request)
      expect(result.status === "error" ? result.refusal : undefined).toEqual(expected ? { code: "sign_in_required", message: "Sign in to run a Smithers turn.", retryAt: null } : undefined)
    }
  })

  test("a coded 402 becomes the out-of-credit refusal that renders the Upgrade card", async () => {
    for (const [code, expected] of [["out_of_credit", true], ["payment_required", false]] as const) {
      const agent = createWebAgent({ fetchImpl: async () => new Response(JSON.stringify({ status: "error", code, message: "Out of credit." }), { status: 402 }) })
      const result = await agent.startTurn(request)
      expect(result.status === "error" ? result.refusal : undefined).toEqual(expected ? { code: "out_of_credit", message: "Out of credit.", retryAt: null } : undefined)
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
