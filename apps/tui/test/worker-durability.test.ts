import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import { ModelError } from "@smthrs/model/ModelError"
import { describe, expect, it, jest } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import { workerFallbackSeats } from "../src/models.ts"
import * as Session from "../src/session.ts"
import { Workspace } from "../src/workspace.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Drains microtasks without timers, so it also runs under fake timers. */
const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}
const request = { id: "review", title: "Review", prompt: "Review the files.", model: "sol" as const }

const fixture = (
  run: Host.Host["run"],
  restored?: ConstructorParameters<typeof Workspace>[0]["restored"],
  history: () => ReadonlyArray<import("../src/context.ts").Entry> = () => []
) => {
  const records: Session.Record[] = []
  const host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-durable-")),
    judged: false,
    dispose: async () => {},
    run
  } satisfies Host.Host
  return {
    records,
    workspace: new Workspace({
      host,
      workerSeat: "openai:gpt-6.1-sol",
      history,
      persist: (record) => records.push(record),
      restored
    })
  }
}

describe("worker durability", () => {
  it("fails a worker over to the routing graph's backups that run here, and honors the override", () => {
    const available = {
      models: [
        { seat: "openai:gpt-6.1-sol", provider: "ChatGPT", label: "Sol" },
        { seat: "anthropic:claude-opus-5-5", provider: "Anthropic", label: "Opus" },
        { seat: "cerebras:qwen", provider: "Cerebras", label: "Qwen" }
      ],
      defaultSeat: "openai:gpt-6.1-sol",
      workerSeat: "openai:gpt-6.1-sol",
      environment: {}
    }
    expect(workerFallbackSeats("anthropic:claude-opus-5-5", available, {})).toEqual(["sol"])
    expect(workerFallbackSeats("claude-code:fable", available, {})).toEqual(["sol"])
    // Kimi, Sol's backup, does not run here; a seat off the graph has none.
    expect(workerFallbackSeats("openai:gpt-6.1-sol", available, {})).toEqual([])
    expect(workerFallbackSeats("cerebras:qwen", available, {})).toEqual([])
    expect(
      workerFallbackSeats("openai:gpt-6.1-sol", available, { SMITHERS_TUI_WORKER_SEATS: "other:a,anthropic:claude" })
    )
      .toEqual(["other:a", "anthropic:claude"])
    // A routed worker fails over along its route, and the operator's order still wins.
    expect(workerFallbackSeats("opus", available, {}, ["kimi", "sol"])).toEqual(["kimi", "sol"])
    expect(workerFallbackSeats("opus", available, { SMITHERS_TUI_WORKER_SEATS: "sol" }, ["kimi", "sol"]))
      .toEqual(["sol"])
  })

  it("parks on retry-after, shows the wait, then runs again at wake", async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 24, 14, 10) })
    try {
      const inputs: Host.TurnInput[] = []
      const stops: Array<(outcome: Host.Outcome) => void> = []
      const f = fixture((input) => {
        inputs.push(input)
        return { done: new Promise((resolve) => stops.push(resolve)), cancel: () => {} }
      })
      f.workspace.request(request)
      await flush()
      const wakeAt = Date.now() + 600_000
      inputs[0]!.onEvent(
        new AgentEvent.ModelParked({
          eventType: "flows.harness.model-parked.v1",
          seat: "openai:gpt-6.1-sol",
          wakeAt,
          source: "retry-after",
          code: "rate_limited"
        })
      )
      stops[0]!({ _tag: "cancelled" })
      await flush()
      const parked = f.workspace.snapshot().tabs[0]!
      expect(parked).toMatchObject({ status: "parked", wakeAt, parks: 1 })
      expect(f.workspace.panel("review").summary).toBe("waits for ChatGPT reset · 14:20")
      expect(f.workspace.read("review")).toMatchObject({ status: "parked", wakeAt: new Date(wakeAt).toISOString() })
      jest.advanceTimersByTime(599_999)
      await flush()
      expect(inputs).toHaveLength(1)
      jest.advanceTimersByTime(1)
      await flush()
      expect(inputs).toHaveLength(2)
      expect(inputs[1]!.maxParks).toBe(QuotaPolicy.defaultMaxParks - 1)
      expect(f.workspace.snapshot().tabs[0]).toMatchObject({ status: "running", parks: 1 })
      expect(f.workspace.read("review").wakeAt).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  it("fails with the provider's limit once every park is spent", async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 24, 14, 10) })
    try {
      const inputs: Host.TurnInput[] = []
      const f = fixture((input) => {
        inputs.push(input)
        if (input.maxParks === 0) {
          return {
            done: Promise.resolve({
              _tag: "failed" as const,
              message: "limit",
              detail: "stack",
              error: new ModelError({ code: "rate_limited", message: "limit", retryAfterMillis: 60_000 })
            }),
            cancel: () => {}
          }
        }
        return {
          done: new Promise<Host.Outcome>((resolve) =>
            queueMicrotask(() => {
              input.onEvent(
                new AgentEvent.ModelParked({
                  eventType: "flows.harness.model-parked.v1",
                  seat: "openai:gpt-6.1-sol",
                  wakeAt: Date.now() + 60_000,
                  source: "retry-after",
                  code: "rate_limited"
                })
              )
              resolve({ _tag: "cancelled" })
            })
          ),
          cancel: () => {}
        }
      })
      f.workspace.request(request)
      for (let park = 0; park <= QuotaPolicy.defaultMaxParks; park++) {
        await flush()
        jest.advanceTimersByTime(60_000)
      }
      await flush()
      expect(inputs.map((input) => input.maxParks)).toEqual(
        Array.from({ length: QuotaPolicy.defaultMaxParks + 1 }, (_, index) => QuotaPolicy.defaultMaxParks - index)
      )
      const tab = f.workspace.snapshot().tabs[0]!
      expect(tab.status).toBe("failed")
      expect(tab.failure).toMatchObject({
        headline: "ChatGPT usage limit reached",
        fault: "wait",
        line: `Still limited after ${QuotaPolicy.defaultMaxParks} waits.`
      })
      expect(f.workspace.read("review")).toMatchObject({ status: "failed" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("a settled model answer restores the park budget", async () => {
    let input: Host.TurnInput | undefined
    const f = fixture((value) => {
      input = value
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    input!.onEvent(
      new AgentEvent.ModelParked({
        eventType: "flows.harness.model-parked.v1",
        seat: "openai:gpt-6.1-sol",
        wakeAt: Date.now() + 1,
        source: "reset",
        code: "rate_limited"
      })
    )
    input!.onEvent(
      new AgentEvent.ModelUnparked({
        eventType: "flows.harness.model-unparked.v1",
        seat: "openai:gpt-6.1-sol",
        at: Date.now()
      })
    )
    expect(f.workspace.snapshot().tabs[0]?.parks).toBe(1)
    input!.onEvent(
      {
        _tag: "model-settled",
        message: { stopReason: "stop", content: [] },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        durationMillis: 1
      } as never
    )
    expect(f.workspace.snapshot().tabs[0]?.parks).toBe(0)
  })

  it("parks a limited worker, then unparked work stays on the same tab", async () => {
    let input: Host.TurnInput | undefined
    const f = fixture((value) => {
      input = value
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    input!.onEvent(
      new AgentEvent.ModelParked({
        eventType: "flows.harness.model-parked.v1",
        seat: "openai:gpt-6.1-sol",
        wakeAt: Date.UTC(2026, 8, 30, 21),
        source: "reset",
        code: "rate_limited"
      })
    )
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({
      id: "review",
      status: "parked",
      wakeAt: Date.UTC(2026, 8, 30, 21)
    })
    input!.onEvent(
      new AgentEvent.ModelUnparked({
        eventType: "flows.harness.model-unparked.v1",
        seat: "openai:gpt-6.1-sol",
        at: Date.UTC(2026, 8, 30, 21)
      })
    )
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({ id: "review", status: "running" })
    input!.onEvent(
      new AgentEvent.SeatFailedOver({
        eventType: "flows.harness.seat-failed-over.v1",
        from: "openai:gpt-6.1-sol",
        to: "anthropic:claude",
        code: "rate_limited"
      })
    )
    expect(
      f.workspace.transcript("review").items.some((item) =>
        item.kind === "note" && item.text.includes("↪ switched to anthropic:claude")
      )
    ).toBe(true)
    expect(f.workspace.snapshot().tabs[0]?.activeSeat).toBe("anthropic:claude")
    expect(f.workspace.tree("review").rows[0]?.label).toContain("claude")
  })

  it("keeps an interrupted in-memory park and relaunches at wake", async () => {
    const inputs: Host.TurnInput[] = []
    let stop: ((outcome: Host.Outcome) => void) | undefined
    const f = fixture((input) => {
      inputs.push(input)
      return inputs.length === 1
        ? {
          done: new Promise((resolve) => {
            stop = resolve
          }),
          cancel: () => {}
        }
        : { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    inputs[0]!.onEvent(
      new AgentEvent.ModelParked({
        eventType: "flows.harness.model-parked.v1",
        seat: "openai:gpt-6.1-sol",
        wakeAt: Date.now() + 80,
        source: "reset",
        code: "rate_limited"
      })
    )
    stop!({ _tag: "cancelled" })
    await tick()
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("parked")
    expect(Session.load(f.workspace.snapshot().tabs[0]!.file).some((record) => record.type === "outcome")).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 110))
    expect(inputs).toHaveLength(2)
    expect(inputs[1]?.history.some((entry) => entry.kind === "exchange" && entry.user === request.prompt)).toBe(true)
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("running")
  })

  it("frees a pool slot while a worker is parked", async () => {
    const inputs = new Map<string, Host.TurnInput>()
    const f = fixture((input) => {
      inputs.set(input.source!, input)
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    for (let index = 0; index < 7; index++) f.workspace.request({ ...request, id: `worker-${index}` })
    await tick()
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "worker-6")?.status).toBe("queued")
    inputs.get("worker-0")!.onEvent(
      new AgentEvent.ModelParked({
        eventType: "flows.harness.model-parked.v1",
        seat: "openai:gpt-6.1-sol",
        wakeAt: Date.now() + 60_000,
        source: "reset",
        code: "rate_limited"
      })
    )
    await tick()
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "worker-0")?.status).toBe("parked")
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "worker-6")?.status).toBe("running")
    expect(f.workspace.busy).toBe(true)
  })

  it("resumes with the original seat and printed cells after failure", async () => {
    const inputs: Host.TurnInput[] = []
    const f = fixture((input) => {
      inputs.push(input)
      if (inputs.length === 1) {
        return {
          done: Promise.resolve({ _tag: "failed", message: "raw provider response", detail: "stack" }),
          cancel: () => {}
        }
      }
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    const old = f.workspace.snapshot().tabs[0]!
    const append = (at: number, event: unknown) =>
      Session.reopen(old.file).append({
        type: "event",
        at,
        event: event as Extract<Session.Record, { type: "event" }>["event"]
      })
    append(2, { _tag: "model-requested" })
    append(3, { _tag: "model-delta", delta: { type: "text-delta", text: "```js\nprint(1)\n```" } })
    append(4, { _tag: "cell-produced", cell: { text: "print(1)" } })
    append(5, { _tag: "cell-printed", text: "one" })
    f.workspace.retry(request.id)
    await tick()
    expect(inputs[1]?.seat).toBe("openai:gpt-6.1-sol")
    expect(
      inputs[1]?.history.some((entry) => entry.kind === "exchange" && entry.answer.includes("raw provider response"))
    ).toBe(true)
    expect(inputs[1]?.history.some((entry) => entry.kind === "exchange" && entry.answer.includes("print(1)"))).toBe(
      true
    )
    expect(inputs[1]?.history.some((entry) => entry.kind === "exchange" && entry.answer.includes("one"))).toBe(true)
    expect(f.workspace.snapshot().tabs.map((tab) => tab.id)).toEqual(["review"])
    expect(Session.load(f.workspace.snapshot().tabs[0]!.file)[0]).toMatchObject({ type: "session", parent: old.file })
  })

  it("restarts a running tab automatically with its prior worker context", async () => {
    const first = fixture(() => ({ done: new Promise(() => {}), cancel: () => {} }))
    first.workspace.request(request)
    await tick()
    const prior = first.workspace.snapshot().tabs[0]!
    Session.reopen(prior.file).append({ type: "user", at: 1, text: "Additional worker note" })
    first.workspace.dispose()
    const inputs: Host.TurnInput[] = []
    const second = fixture((input) => {
      inputs.push(input)
      return { done: new Promise(() => {}), cancel: () => {} }
    }, Session.restore(first.records).workspace)
    await tick()
    expect(second.workspace.snapshot().tabs[0]).toMatchObject({ id: "review", status: "running" })
    expect(inputs[0]?.history.some((entry) => entry.kind === "exchange" && entry.user.includes("Review the files")))
      .toBe(true)
  })

  it("keeps a parked tab parked until wake, then resumes the recorded task", async () => {
    let firstInput: Host.TurnInput | undefined
    const first = fixture((input) => {
      firstInput = input
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    first.workspace.request(request)
    await tick()
    firstInput!.onEvent(
      new AgentEvent.ModelParked({
        eventType: "flows.harness.model-parked.v1",
        seat: "openai:gpt-6.1-sol",
        wakeAt: Date.now() + 80,
        source: "reset",
        code: "rate_limited"
      })
    )
    first.workspace.dispose()
    let relaunched: Host.TurnInput | undefined
    const restored = fixture((input) => {
      relaunched = input
      return { done: new Promise(() => {}), cancel: () => {} }
    }, Session.restore(first.records).workspace)
    expect(restored.workspace.snapshot().tabs[0]?.status).toBe("parked")
    expect(relaunched).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 110))
    expect(relaunched?.seat).toBe("openai:gpt-6.1-sol")
    expect(relaunched?.history.some((entry) => entry.kind === "exchange" && entry.user === request.prompt)).toBe(true)
    expect(restored.workspace.snapshot().tabs[0]?.status).toBe("running")
  })

  it("waits for a failed provider's reset before resuming", async () => {
    const inputs: Host.TurnInput[] = []
    const f = fixture((input) => {
      inputs.push(input)
      return inputs.length === 1
        ? {
          done: Promise.resolve({
            _tag: "failed",
            message: "raw limit",
            detail: "stack",
            error: new ModelError({ code: "rate_limited", message: "raw limit", resetAtEpochMillis: Date.now() + 80 })
          }),
          cancel: () => {}
        }
        : { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("failed")
    const receipt = Session.load(f.workspace.snapshot().tabs[0]!.file).findLast((record) => record.type === "outcome")
    expect(receipt).toMatchObject({ type: "outcome", outcome: { headline: "ChatGPT usage limit reached" } })
    expect(receipt?.type === "outcome" && "error" in receipt.outcome).toBe(false)
    f.workspace.waitForReset(request.id)
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("parked")
    await new Promise((resolve) => setTimeout(resolve, 110))
    expect(inputs).toHaveLength(2)
    expect(inputs[1]?.seat).toBe("openai:gpt-6.1-sol")
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("running")
  })

  it("restarts a retried worker after its old failed outcome", async () => {
    const launches: Host.TurnInput[] = []
    const first = fixture((input) => {
      launches.push(input)
      return {
        done: launches.length === 1
          ? Promise.resolve({ _tag: "failed", message: "usage limit", detail: "stack" })
          : new Promise(() => {}),
        cancel: () => {}
      }
    })
    first.workspace.request(request)
    await tick()
    first.workspace.retry(request.id)
    await tick()
    expect(launches).toHaveLength(2)
    const restored = fixture((input) => {
      launches.push(input)
      return { done: new Promise(() => {}), cancel: () => {} }
    }, Session.restore(first.records).workspace)
    await tick()
    expect(launches).toHaveLength(3)
    expect(restored.workspace.snapshot().tabs[0]?.status).toBe("running")
  })

  it("restarts a reset relaunch after its old failed outcome", async () => {
    const launches: Host.TurnInput[] = []
    const first = fixture((input) => {
      launches.push(input)
      return {
        done: launches.length === 1
          ? Promise.resolve({
            _tag: "failed",
            message: "usage limit",
            detail: "stack",
            error: new ModelError({ code: "rate_limited", message: "usage limit", resetAtEpochMillis: Date.now() + 10 })
          })
          : new Promise(() => {}),
        cancel: () => {}
      }
    })
    first.workspace.request(request)
    await tick()
    first.workspace.waitForReset(request.id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(launches).toHaveLength(2)
    const restored = fixture((input) => {
      launches.push(input)
      return { done: new Promise(() => {}), cancel: () => {} }
    }, Session.restore(first.records).workspace)
    await tick()
    expect(launches).toHaveLength(3)
    expect(restored.workspace.snapshot().tabs[0]?.status).toBe("running")
  })

  it("restores the typed failure its worker recorded, wait action and all", async () => {
    const first = fixture(() => ({ done: new Promise(() => {}), cancel: () => {} }))
    first.workspace.request(request)
    await tick()
    const tab = first.workspace.snapshot().tabs[0]!
    const failure = {
      headline: "ChatGPT usage limit reached",
      fault: "wait",
      line: "Resets Sep 30 14:00.",
      actions: ["resume", "switch-model", "wait", "details"]
    } as const
    Session.reopen(tab.file).append({
      type: "outcome",
      at: Date.now(),
      prompt: tab.prompt,
      outcome: { _tag: "failed", message: "The usage limit has been reached", headline: failure.headline, failure }
    })
    const restored = fixture(
      () => ({ done: new Promise(() => {}), cancel: () => {} }),
      Session.restore(first.records).workspace
    )
    expect(restored.workspace.snapshot().tabs[0]?.failure).toEqual(failure)
  })

  it("never reads a fault out of a restored outcome's prose", async () => {
    const first = fixture(() => ({ done: new Promise(() => {}), cancel: () => {} }))
    first.workspace.request(request)
    await tick()
    const tab = first.workspace.snapshot().tabs[0]!
    Session.reopen(tab.file).append({
      type: "outcome",
      at: Date.now(),
      prompt: tab.prompt,
      outcome: { _tag: "failed", message: "The usage limit has been reached" }
    })
    const restored = fixture(
      () => ({ done: new Promise(() => {}), cancel: () => {} }),
      Session.restore(first.records).workspace
    )
    expect(restored.workspace.snapshot().tabs[0]?.failure).toMatchObject({
      headline: "Worker stopped unexpectedly",
      fault: "bug"
    })
  })

  it("retries a parked tab immediately and cancels its parked host turn", async () => {
    const inputs: Host.TurnInput[] = []
    let cancelled = 0
    const f = fixture((input) => {
      inputs.push(input)
      return {
        done: new Promise(() => {}),
        cancel: () => {
          cancelled++
        }
      }
    })
    f.workspace.request(request)
    await tick()
    inputs[0]!.onEvent(
      new AgentEvent.ModelParked({
        eventType: "flows.harness.model-parked.v1",
        seat: "openai:gpt-6.1-sol",
        wakeAt: Date.now() + 60_000,
        source: "reset",
        code: "rate_limited"
      })
    )
    f.workspace.retry(request.id)
    await tick()
    expect(cancelled).toBe(1)
    expect(inputs).toHaveLength(2)
    expect(f.workspace.snapshot().tabs[0]?.status).toBe("running")
  })

  it("restores a queued request with the chat history captured when requested", async () => {
    const oldHistory = [{ kind: "exchange" as const, user: "Original question", answer: "Original reply" }]
    const first = fixture(() => ({ done: new Promise(() => {}), cancel: () => {} }), undefined, () => oldHistory)
    for (let index = 0; index < 7; index++) first.workspace.request({ ...request, id: `worker-${index}` })
    const queued = first.workspace.snapshot().tabs[6]!
    expect(queued.status).toBe("queued")
    expect(queued.history).toEqual(oldHistory)
    const launches: Host.TurnInput[] = []
    const controls = new Map<string, (outcome: Host.Outcome) => void>()
    const restored = fixture(
      (input) => {
        launches.push(input)
        return { done: new Promise((resolve) => controls.set(input.source!, resolve)), cancel: () => {} }
      },
      Session.restore(first.records).workspace,
      () => [{ kind: "exchange", user: "Later question", answer: "Later reply" }]
    )
    await tick()
    controls.get("worker-0")!({ _tag: "done", answer: "done" })
    await tick()
    expect(launches.find((input) => input.source === "worker-6")?.history).toEqual(oldHistory)
    expect(restored.workspace.snapshot().tabs.find((tab) => tab.id === "worker-6")?.status).toBe("running")
  })

  it("queues a model-unparked worker until the pool has a free seat", async () => {
    const inputs = new Map<string, Host.TurnInput>()
    const controls = new Map<string, (outcome: Host.Outcome) => void>()
    const f = fixture((input) => {
      inputs.set(input.source!, input)
      return { done: new Promise((resolve) => controls.set(input.source!, resolve)), cancel: () => {} }
    })
    for (let index = 0; index < 7; index++) f.workspace.request({ ...request, id: `worker-${index}` })
    await tick()
    inputs.get("worker-0")!.onEvent(
      new AgentEvent.ModelParked({
        eventType: "flows.harness.model-parked.v1",
        seat: "openai:gpt-6.1-sol",
        wakeAt: Date.now() + 1,
        source: "reset",
        code: "rate_limited"
      })
    )
    await tick()
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "worker-6")?.status).toBe("running")
    const resumed = inputs.get("worker-0")!.onEvent(
      new AgentEvent.ModelUnparked({
        eventType: "flows.harness.model-unparked.v1",
        seat: "openai:gpt-6.1-sol",
        at: Date.now()
      })
    )
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "worker-0")?.status).toBe("queued")
    controls.get("worker-1")!({ _tag: "done", answer: "done" })
    await resumed
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "worker-0")?.status).toBe("running")
    expect(f.workspace.snapshot().tabs.filter((tab) => tab.status === "running")).toHaveLength(6)
  })

  it("marks truncated continuation and keeps printed output plus recent cells", async () => {
    const inputs: Host.TurnInput[] = []
    const f = fixture((input) => {
      inputs.push(input)
      return {
        done: inputs.length === 1
          ? Promise.resolve({ _tag: "failed", message: "old error", detail: "stack" })
          : new Promise<Host.Outcome>(() => {}),
        cancel: () => {}
      }
    })
    f.workspace.request(request)
    await tick()
    const file = f.workspace.snapshot().tabs[0]!.file
    const writer = Session.reopen(file)
    writer.append({
      type: "event",
      at: Date.now(),
      event: { _tag: "cell-produced", cell: { text: "x".repeat(30_000) } } as never
    })
    writer.append({
      type: "event",
      at: Date.now(),
      event: { _tag: "cell-printed", text: "IMPORTANT PRINTED RESULT" } as never
    })
    writer.append({
      type: "event",
      at: Date.now(),
      event: { _tag: "cell-produced", cell: { text: "inspect final file" } } as never
    })
    f.workspace.retry(request.id)
    await tick()
    const answer = inputs[1]!.history.find((entry) => entry.kind === "exchange" && entry.user === request.prompt)
    expect(answer?.kind === "exchange" ? answer.answer : "").toContain("IMPORTANT PRINTED RESULT")
    expect(answer?.kind === "exchange" ? answer.answer : "").toContain("inspect final file")
    expect(answer?.kind === "exchange" ? answer.answer : "").toContain("truncated")
    expect(answer?.kind === "exchange" ? answer.answer.length : 0).toBeLessThanOrEqual(24_000)
  })
})
