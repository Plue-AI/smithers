/**
 * A worker routed to a panel: its members run inside the panel, never as the
 * tab. A member's quota park is waited out there, only the merger's run
 * reaches the tab, every run gets the routed variant, and the whole panel
 * spends under the worker's one cap.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Agents from "../src/agents.ts"
import * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import { seats as poolSize, Workspace } from "../src/workspace.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const route = {
  prepare: () =>
    Effect.succeed({
      routeId: "panel-test",
      protocolId: "panel-test",
      method: "POST" as const,
      url: "https://panel.invalid/",
      publicHeaders: {},
      body: new Uint8Array(),
      bodyText: ""
    })
}

/** The text of one request: its system parts, then its messages. */
const textOf = (request: ModelRequest.ModelRequest) =>
  [
    ...request.system.map((part) => part.text),
    ...request.messages.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
    )
  ].join("\n")

/** One reply: a cell of `body`, spending `tokens`. */
const reply = (body: string, tokens: number) =>
  Stream.fromIterable(
    [
      { type: "text-start", id: "cell" },
      { type: "text-delta", id: "cell", text: "```cell\n" + body + "\n```" },
      { type: "text-end", id: "cell" },
      ...(tokens === 0 ? [] : [{ type: "usage", inputTokens: tokens, outputTokens: 0, totalTokens: tokens }]),
      { type: "settle", stopReason: "stop" }
    ] as unknown as ReadonlyArray<ModelEvent.ModelEvent>
  )

const done = (answer: string) => `ctx.done(${JSON.stringify(answer)})`

interface Script {
  /** The member's answer; the merger's when the request carries the members' answers. */
  readonly answer: string
  readonly merged?: string
  /** A quota refusal on the first member call, retried after 300 ms. */
  readonly refuse?: boolean
  /** A quota refusal on the first merger call. */
  readonly refuseMerge?: boolean
  readonly tokens?: number
  /** The cell the first member call answers with, before `answer`. */
  readonly first?: string
  /** What member calls, and merger calls, wait for before answering. */
  readonly gate?: Promise<void>
  readonly mergeGate?: Promise<void>
  /** Member calls never answer, and run `ended` once they have stopped, 100 ms after they are told to. */
  readonly hang?: { readonly ended: () => void }
}

/**
 * A resolver whose seats answer by script and record every request's text.
 * A seat with no script never answers: it holds a worker slot.
 */
const seats = (scripts: Readonly<Record<string, Script>>, requests: Array<{ seat: string; text: string }>) => {
  const calls = new Map<string, number>()
  return SeatResolver.layer({
    resolve: (id) => {
      const script = scripts[id]
      const model = Model.make({
        stream: (request) => {
          if (script === undefined) return Stream.never
          const text = textOf(request)
          const merging = text.includes("Independent answers")
          const key = `${id}:${merging}`
          const call = (calls.get(key) ?? 0) + 1
          calls.set(key, call)
          requests.push({ seat: id, text })
          if (!merging && script.hang !== undefined) {
            // It takes a while to stop.
            return Stream.never.pipe(
              Stream.ensuring(Effect.sleep(100).pipe(Effect.andThen(Effect.sync(script.hang.ended))))
            )
          }
          if (call === 1 && (merging ? script.refuseMerge : script.refuse) === true) {
            return Stream.fail(
              new ModelError({ code: "rate_limited", message: "slow down", httpStatus: 429, retryAfterMillis: 300 })
            )
          }
          const gate = merging ? script.mergeGate : script.gate
          const answer = reply(
            merging
              ? done(script.merged!)
              : call === 1 && script.first !== undefined
              ? script.first
              : done(script.answer),
            script.tokens ?? 0
          )
          return gate === undefined ? answer : Stream.unwrap(Effect.promise(() => gate).pipe(Effect.as(answer)))
        }
      })
      return Effect.succeed(Seat.make({ id, modelId: id, model, route, contextWindowTokens: 200_000 }))
    }
  })
}

/** Both Claude and OpenAI run here, so an important review routes to Opus, Fable and Astra, merged by Fable. */
const environment = (cwd: string) => ({
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENAI_API_KEY: "sk-test",
  CODEX_HOME: join(cwd, "codex"),
  // No fallbacks: a refused member waits out its own park.
  SMITHERS_TUI_WORKER_SEATS: ""
})

const review = "Review the architecture change."
const panel = {
  seats: [
    { seat: "opus", backups: [] },
    { seat: "fable", backups: [] },
    { seat: "astra", backups: [] }
  ],
  merger: "fable"
}
const scripts: Readonly<Record<string, Script>> = {
  opus: { answer: "opus view", refuse: true },
  fable: { answer: "fable view", merged: "merged view", refuse: true },
  astra: { answer: "astra view" }
}
const variant = "Change nothing."

const agents: Agents.Port = {
  listed: () => [],
  load: () => Promise.reject(new Error("no agents"))
}

/** Resolves once `ready` holds, polling; fails after 20 s. */
const until = async (ready: () => boolean, what: string) => {
  const deadline = Date.now() + 20_000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A real host and workspace over scripted seats. */
const workspaceOver = (scripts: Readonly<Record<string, Script>>) => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-panel-"))
  roots.push(cwd)
  const requests: Array<{ seat: string; text: string }> = []
  const host = Host.make({
    cwd,
    environment: environment(cwd),
    judge: ScriptedJudge.layerAll,
    approvals: "all",
    seats: seats(scripts, requests)
  })
  const workspace = new Workspace({
    host,
    workerSeat: "worker:test",
    history: () => [],
    persist: () => undefined,
    agents
  })
  const tab = () => workspace.snapshot().tabs.find((each) => each.id === "panel")
  const settled = async () => {
    await until(() => tab()?.status === "done" || tab()?.status === "failed", "the panel tab to settle")
    return tab()!
  }
  return {
    workspace,
    requests,
    tab,
    settled,
    /** Requests the members and merger made, not the tab's description. */
    runs: () => requests.filter(({ text }) => !text.includes("Summarize this background agent task")),
    dispose: async () => {
      workspace.dispose()
      await host.dispose()
    }
  }
}

const merges = (runs: ReadonlyArray<{ seat: string; text: string }>) =>
  runs.filter(({ text }) => text.includes("Independent answers"))

describe("a worker routed to a panel", () => {
  test("with the pool full, members that park, delegate or publish still answer, and the merger runs", async () => {
    const f = workspaceOver({
      ...scripts,
      // Opus first tries to start a child worker and to publish a panel.
      opus: {
        answer: "opus view",
        first: [
          `try { await ctx.call("agent.delegate", { id: "child", title: "Child", prompt: "Help." }) } catch (error) { console.log(String(error)) }`,
          `try { await ctx.call("ui.publish", { id: "p", title: "P", rows: [] }) } catch (error) { console.log(String(error)) }`
        ].join("\n")
      },
      astra: { answer: "astra view", refuse: true }
    })
    try {
      // Every other slot is held by a worker that never answers.
      for (let index = 0; index < poolSize - 1; index++) {
        f.workspace.request({ id: `hold-${index}`, title: "Hold", prompt: "Hold.", model: "sol" })
      }
      f.workspace.request({ id: "panel", title: "Review", prompt: review })
      const tab = await f.settled()

      expect(tab).toMatchObject({
        status: "done",
        answer: "merged view",
        seat: "fable",
        panel: {
          seats: [
            { seat: "opus", backups: ["sol"] },
            { seat: "fable", backups: [] },
            { seat: "astra", backups: [] }
          ],
          merger: "fable"
        }
      })
      // Fable and Astra were each refused once and asked again after their park.
      for (const seat of ["fable", "astra"]) {
        expect(f.runs().filter((request) => request.seat === seat).length).toBeGreaterThanOrEqual(2)
      }
      // Opus was refused both calls, started no worker and published nothing.
      expect(
        f.runs().some(({ seat, text }) => seat === "opus" && text.includes("A panel member only answers its task"))
      )
        .toBe(true)
      expect(f.workspace.snapshot().tabs).toHaveLength(poolSize)
      expect(f.workspace.snapshot().panels).toEqual([])
      const merge = merges(f.runs())[0]!.text
      for (const view of ["opus view", "fable view", "astra view"]) expect(merge).toContain(view)
      // Every run, members and merger, had the routed variant.
      expect(f.runs().every(({ text }) => text.includes(variant))).toBe(true)

      // The worker's own session file, which a resume continues from.
      const events = Session.load(tab.file).flatMap((record) =>
        record.type === "event" ? [record.event as AgentEvent.AgentEvent] : []
      )
      // The members' parks never reached the tab, and only the merger's run is in its transcript.
      expect(events.some((event) => event._tag === "model-parked" || event._tag === "model-unparked")).toBe(false)
      expect(events.filter((event) => event._tag === "resolved")).toHaveLength(1)
      const persisted = JSON.stringify(events)
      for (const view of ["opus view", "astra view"]) expect(persisted).not.toContain(`ctx.done(\\"${view}\\")`)
    } finally {
      await f.dispose()
    }
  }, 30_000)

  test("refuses steering and take-over until the merger starts", async () => {
    let members = () => {}
    let merger = () => {}
    const gate = new Promise<void>((resolve) => (members = resolve))
    const mergeGate = new Promise<void>((resolve) => (merger = resolve))
    const f = workspaceOver({
      opus: { answer: "opus view", gate },
      fable: { answer: "fable view", merged: "merged view", gate, mergeGate },
      astra: { answer: "astra view", gate }
    })
    try {
      f.workspace.request({ id: "panel", title: "Review", prompt: review })
      await until(() => new Set(f.runs().map(({ seat }) => seat)).size === 3, "every member to be asked")
      expect(f.workspace.steer("panel", "hurry")).toBe(false)
      expect(f.workspace.hijack("panel", "you")).toBe(false)
      expect(f.workspace.unsteerable("panel")).toBe("Its panel members are answering; steer it once the merger starts")
      members()
      await until(() => merges(f.runs()).length > 0, "the merger to be asked")
      expect(f.workspace.unsteerable("panel")).toBeUndefined()
      expect(f.workspace.steer("panel", "hurry")).toBe(true)
      merger()
      expect(await f.settled()).toMatchObject({ status: "done", answer: "merged view" })
    } finally {
      members()
      merger()
      await f.dispose()
    }
  }, 30_000)

  test("a merger park relaunches the tab without asking the members again", async () => {
    const f = workspaceOver({
      ...scripts,
      opus: { answer: "opus view" },
      fable: { answer: "fable view", merged: "merged view", refuseMerge: true }
    })
    try {
      f.workspace.request({ id: "panel", title: "Review", prompt: review })
      const tab = await f.settled()
      expect(tab).toMatchObject({ status: "done", answer: "merged view" })
      expect(tab.answered?.map(([seat]) => seat).sort()).toEqual(["astra", "fable", "opus"])
      const runs = f.runs()
      const first = runs.findIndex(({ text }) => text.includes("Independent answers"))
      // The merger was refused, parked and asked again; no member was asked after it first was.
      expect(merges(runs).length).toBeGreaterThanOrEqual(2)
      expect(runs.slice(first).every(({ text }) => text.includes("Independent answers"))).toBe(true)
    } finally {
      await f.dispose()
    }
  }, 30_000)

  test("waits for every member to stop before it reports a cancel", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-panel-"))
    roots.push(cwd)
    const requests: Array<{ seat: string; text: string }> = []
    let ended = 0
    const hang = { ended: () => void ended++ }
    const host = Host.make({
      cwd,
      environment: environment(cwd),
      judge: ScriptedJudge.layerAll,
      approvals: "all",
      seats: seats({
        opus: { answer: "", hang },
        fable: { answer: "", merged: "", hang },
        astra: { answer: "", hang }
      }, requests)
    })
    try {
      const turn = host.run({
        prompt: review,
        role: "worker",
        history: [],
        onEvent: () => undefined,
        seat: "fable",
        route: { backups: [], panel }
      })
      await until(() => requests.length === 3, "every member to be asked")
      turn.cancel()
      expect(await turn.done).toEqual({ _tag: "cancelled" })
      expect(ended).toBe(3)
    } finally {
      await host.dispose()
    }
  }, 30_000)

  test("a resumed panel gives its runs the same system text as the fresh one", async () => {
    const systems = async (resumed: boolean) => {
      const cwd = mkdtempSync(join(tmpdir(), "tui-panel-"))
      roots.push(cwd)
      const requests: Array<{ seat: string; text: string }> = []
      const host = Host.make({
        cwd,
        environment: environment(cwd),
        judge: ScriptedJudge.layerAll,
        approvals: "all",
        seats: seats({
          ...scripts,
          opus: { answer: "opus view" },
          fable: { answer: "fable view", merged: "merged" }
        }, requests)
      })
      try {
        const outcome = await host.run({
          prompt: review,
          role: "worker",
          history: [],
          onEvent: () => undefined,
          ...(resumed
            ? { seat: "fable", variant: "investigate", route: { backups: [], panel } }
            : { seat: Seat.auto })
        }).done
        expect(outcome).toEqual({ _tag: "done", answer: "merged" })
      } finally {
        await host.dispose()
      }
      const first = (seat: string, merging: boolean) =>
        requests.find((request) => request.seat === seat && request.text.includes("Independent answers") === merging)!
          .text.split("\n").filter((line) => line === variant)
      return ["opus", "fable", "astra"].map((seat) => first(seat, false)).concat([first("fable", true)])
    }
    const fresh = await systems(false)
    expect(fresh.every((lines) => lines.length === 1)).toBe(true)
    expect(await systems(true)).toEqual(fresh)
  }, 30_000)

  test("gives every run a share of the worker's cap, so all are admitted and the panel stays within it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-panel-"))
    roots.push(cwd)
    const requests: Array<{ seat: string; text: string }> = []
    // The members answer together, so each is admitted while the others still run.
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 100))
    const host = Host.make({
      cwd,
      environment: environment(cwd),
      judge: ScriptedJudge.layerAll,
      approvals: "all",
      budget: { tokens: { max: 1200 } },
      seats: seats({
        opus: { answer: "opus view", tokens: 100, gate },
        fable: { answer: "fable view", merged: "merged", tokens: 100, gate },
        astra: { answer: "astra view", tokens: 100, gate }
      }, requests)
    })
    try {
      const outcome = await host.run({
        prompt: review,
        role: "worker",
        history: [],
        onEvent: () => undefined,
        seat: "fable",
        route: { backups: [], panel }
      }).done
      expect(outcome).toEqual({ _tag: "done", answer: "merged" })
    } finally {
      await host.dispose()
    }
    const merge = merges(requests)[0]!.text
    for (const view of ["opus view", "fable view", "astra view"]) expect(merge).toContain(view)
    expect(merge).not.toContain("failed and gave no answer")
    // Every call spent 100 tokens: the whole panel stayed within the worker's 1200.
    expect(requests.length * 100).toBeLessThanOrEqual(1200)
  }, 30_000)
})
