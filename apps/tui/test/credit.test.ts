/**
 * A model account with no credit: a quota refusal spends it for the session,
 * the router and backups skip it, the next worker on it runs once on a
 * known-working model and says so, a failed card names the account and
 * offers another model first, and a model the person pinned is never replaced.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Credit from "../src/credit.ts"
import * as Host from "../src/host.ts"
import * as Models from "../src/models.ts"
import * as Session from "../src/session.ts"
import * as Subagents from "../src/subagents.ts"
import * as Tabs from "../src/tabs.ts"
import { Workspace } from "../src/workspace.ts"

const sol = "openai:gpt-6.1-sol"
const qwen = "cerebras:qwen-3.8-27b"
const models: ReadonlyArray<Models.Model> = [
  { seat: sol, label: "GPT-6.1 Sol", provider: "OpenAI" },
  { seat: qwen, label: "Qwen 3.8", provider: "Cerebras" },
  { seat: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5", provider: "Anthropic" },
  { seat: "anthropic:claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "Anthropic" }
]
const quota = () =>
  new ModelError({ code: "quota_exceeded", message: "You have no credits remaining.", httpStatus: 429 })

describe("exhausted", () => {
  test("reads a credit refusal under any cause, and nothing else", () => {
    expect(Credit.exhausted(quota())).toBe(true)
    expect(Credit.exhausted(new ModelError({ code: "out_of_credit", message: "x" }))).toBe(true)
    expect(Credit.exhausted({ _tag: "Wrapped", cause: { _tag: "Outer", cause: quota() } })).toBe(true)
    expect(Credit.exhausted(new ModelError({ code: "rate_limited", message: "slow down" }))).toBe(false)
    expect(Credit.exhausted(new ModelError({ code: "quota_exceeded", message: "wait", retryAfterMillis: 10 }))).toBe(
      false
    )
    expect(
      Credit.exhausted(
        new ModelError({ code: "quota_exceeded", message: "wait", resetAtEpochMillis: Date.now() + 60_000 })
      )
    ).toBe(false)
    expect(Credit.exhausted(new Error("quota"))).toBe(false)
    expect(Credit.exhausted(undefined)).toBe(false)
    const loop: { _tag: string; cause?: unknown } = { _tag: "Loop" }
    loop.cause = loop
    expect(Credit.exhausted(loop)).toBe(false)
  })
})

describe("a session's credit ledger", () => {
  test("spends a whole account: one Claude model's refusal spends every Claude model on that route", () => {
    const credit = Credit.make(models)
    expect(credit.spent("opus")).toBe(false)
    credit.spend("anthropic:claude-opus-5-5")
    for (const seat of ["opus", "sonnet", "anthropic:claude-sonnet-5-5"]) expect(credit.spent(seat)).toBe(true)
    expect(credit.spent(sol)).toBe(false)
    expect(credit.spent(Seat.auto)).toBe(false)
    credit.spend(Seat.auto)
    expect(credit.spent(qwen)).toBe(false)
  })

  test("runs a Claude alias on Claude Code when no Anthropic key is set, and spends that account alone", () => {
    const code = Credit.make([{ seat: "claude-code:opus", label: "Claude Opus 5.5", provider: "Claude Code" }])
    code.spend("opus")
    expect(code.spent("claude-code:sonnet")).toBe(true)
    expect(code.account("opus")).toBe("claude-code")
    expect(Models.routeOf("opus", models)).toBe("anthropic")
    expect(Models.routeOf("claude-code:opus", models)).toBe("claude-code")
    expect(Models.routeOf("sol", [])).toBe("openai")
    expect(Models.routeOf("cerebras", [])).toBe("cerebras")
  })

  test("model scope covers Claude Code aliases without spending siblings or another account", () => {
    const credit = Credit.make([{ seat: "claude-code:opus", label: "Claude Opus 5.5", provider: "Claude Code" }])
    credit.spend("opus", "model")
    expect(credit.spent("claude-code:opus")).toBe(true)
    expect(credit.spent("claude-code:claude-opus-5-5")).toBe(true)
    expect(credit.spent("claude-code:sonnet")).toBe(false)
    expect(credit.spent("anthropic:claude-opus-5-5")).toBe(false)
  })

  test("names the account a seat runs on, as a failure names it", () => {
    const credit = Credit.make(models)
    expect(credit.account(sol)).toBe("openai")
    expect(credit.account("sonnet")).toBe("anthropic")
    expect(credit.account("cerebras")).toBe("cerebras")
    expect(
      ["openai", "anthropic", "claude-code", "moonshot:kimi-k3", "gemini:pro", "unknown:model", "constructor"].map(
        FailureCopy.provider
      )
    ).toEqual(["OpenAI", "Anthropic", "Claude Code", "Kimi", "Gemini", "Model", "Model"])
  })

  test("stands in the latest model that answered, else the chat's, never one without credit", () => {
    const credit = Credit.make(models)
    expect(credit.instead(sol, qwen)).toBeUndefined()
    credit.spend(sol)
    expect(credit.instead(sol, qwen)).toEqual({ from: sol, to: qwen })
    credit.answered("anthropic:claude-sonnet-5-5")
    expect(credit.instead(sol, qwen)).toEqual({ from: sol, to: "anthropic:claude-sonnet-5-5" })
    credit.answered(qwen)
    expect(credit.instead(sol, qwen)).toEqual({ from: sol, to: qwen })
    credit.spend(qwen)
    expect(credit.instead(sol, qwen)).toEqual({ from: sol, to: "anthropic:claude-sonnet-5-5" })
    credit.spend("opus")
    // Nothing known works: no stand-in, and the refusal shows.
    expect(credit.instead(sol, qwen)).toBeUndefined()
  })

  test("routes an auto worker elsewhere only when every routed model's account refused", () => {
    const credit = Credit.make(models, ["opus", "sol"])
    credit.spend("opus")
    expect(credit.instead(Seat.auto, qwen)).toBeUndefined()
    credit.spend(sol)
    // It names the model that refused last.
    expect(credit.instead(Seat.auto, qwen)).toEqual({ from: sol, to: qwen })
    credit.spend("anthropic:claude-sonnet-5-5")
    expect(credit.instead(Seat.auto, qwen)).toEqual({ from: "anthropic:claude-sonnet-5-5", to: qwen })
    // A refusal off the route never names it.
    credit.spend("gemini:pro")
    expect(credit.instead(Seat.auto, qwen)?.from).toBe("anthropic:claude-sonnet-5-5")
    expect(Credit.make(models, []).instead(Seat.auto, qwen)).toBeUndefined()
  })

  test("auto substitution names a routed model rather than an unrelated model-scoped refusal", () => {
    const credit = Credit.make(models, ["opus", "sol"])
    credit.spend("opus", "model")
    credit.spend(sol, "model")
    credit.spend("sonnet", "model")
    expect(credit.instead(Seat.auto, qwen)).toEqual({ from: sol, to: qwen })
  })

  test("says in one line which model had no credit and which runs instead", () => {
    expect(Credit.make(models).notice(sol, qwen)).toBe("↪ GPT-6.1 Sol has no credit · using Qwen 3.8")
    expect(Credit.notice("opus", "claude-code:sonnet")).toBe(
      "↪ Claude Opus 5.5 has no credit · using Claude Sonnet 5.5"
    )
  })

  test("a refusal for lack of credit names its account and offers another model before resuming", () => {
    const credit = Credit.make(models)
    const described = FailureCopy.describe(quota(), credit.account("opus"))
    expect(described).toMatchObject({
      headline: "Anthropic quota exhausted",
      actions: ["switch-model", "resume", "details"]
    })
    expect(Tabs.actions({ status: "failed", failure: described }).map((action) => action.label)).toEqual([
      "Switch model",
      "Resume"
    ])
    // Out of hosted credit, another model is the way on too.
    const hosted = FailureCopy.describe(new ModelError({ code: "out_of_credit", message: "x" }), sol)
    expect(hosted.actions).toEqual(["switch-model", "resume", "details"])
    expect(Tabs.actions({ status: "failed", failure: hosted }).map((action) => action.keys[0])).toEqual(["alt+m", "alt+r"])
    // A passing limit keeps its own order, and the account is named as the picker names it.
    const limited = FailureCopy.describe(new ModelError({ code: "rate_limited", message: "x" }), sol)
    expect(limited).toMatchObject({
      headline: "OpenAI usage limit reached",
      actions: ["resume", "switch-model", "wait", "details"]
    })
  })

  test("lists the coordinator's delegate models with credit, and apart those whose account refused", () => {
    const credit = Credit.make(models)
    const names = ["cerebras", "sol", "opus"]
    expect(Models.delegateContext(names, credit.spent)).toBe(
      "Delegate models (pass as model, not agent): cerebras, sol, opus"
    )
    credit.spend(sol)
    expect(Models.delegateContext(names, credit.spent)).toBe(
      "Delegate models (pass as model, not agent): cerebras, opus\nNo credit this session (pass only with pinned: true): sol"
    )
    credit.spend("cerebras")
    credit.spend("opus")
    expect(Models.delegateContext(names, credit.spent)).toBe(
      "Delegate models (pass as model, not agent): none\nNo credit this session (pass only with pinned: true): cerebras, sol, opus"
    )
  })
})

describe("the routing catalog", () => {
  test("skips a model whose account has no credit from the next route on", async () => {
    const available = Models.detectWithoutClaude({ OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", CODEX_HOME: "/none" })
    const credit = Credit.make(available.models, Models.routedSeats(available))
    const catalog = Models.routing(available, {}, true, credit.spent)!
    const before = await Effect.runPromise(catalog.candidates)
    expect(before).toEqual(expect.arrayContaining(["opus", "sol"]))
    credit.spend("anthropic:claude-opus-5-5")
    const after = await Effect.runPromise(catalog.candidates)
    expect(after).toContain("sol")
    expect(after.some((alias) => credit.spent(alias))).toBe(false)
  })
})

// A real host and workspace over scripted seats: Sol has no credit, Qwen answers.
const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One route per account, as each provider has its own. */
const routeFor = (account: string) => ({
  prepare: () =>
    Effect.succeed({
      routeId: `credit-${account}`,
      protocolId: "credit-test",
      method: "POST" as const,
      url: "https://credit.invalid/",
      publicHeaders: {},
      body: new Uint8Array(),
      bodyText: ""
    })
})

const textOf = (request: ModelRequest.ModelRequest) =>
  request.messages.flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n")

const answer = (text: string) =>
  Stream.fromIterable(
    [
      { type: "text-start", id: "cell" },
      { type: "text-delta", id: "cell", text: "```cell\nctx.done(" + JSON.stringify(text) + ")\n```" },
      { type: "text-end", id: "cell" },
      { type: "settle", stopReason: "stop" }
    ] as unknown as ReadonlyArray<ModelEvent.ModelEvent>
  )

/** A frame that runs a step and does not answer, so the run takes another frame. */
const step = Stream.fromIterable(
  [
    { type: "text-start", id: "cell" },
    { type: "text-delta", id: "cell", text: "```cell\nconsole.log(1)\n```" },
    { type: "text-end", id: "cell" },
    { type: "settle", stopReason: "stop" }
  ] as unknown as ReadonlyArray<ModelEvent.ModelEvent>
)

const until = async (ready: () => boolean, what: string) => {
  const deadline = Date.now() + 20_000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * `failing` are the accounts that refuse for lack of credit; a test may add to
 * it. A seat in `stepping` answers its first call with a step, not the answer,
 * and a seat in `lasts` refuses after answering that many calls.
 */
const fixture = (
  failing = new Set(["openai"]),
  fallbacks = "",
  stepping: ReadonlySet<string> = new Set(),
  lasts: ReadonlyMap<string, number> = new Map(),
  scripted?: (id: string, count: number) => Stream.Stream<ModelEvent.ModelEvent, ModelError>
) => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-credit-"))
  roots.push(cwd)
  const calls: Array<string> = []
  const seats = SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(Seat.make({
        id,
        modelId: id,
        route: routeFor(Models.routeOf(id, [])),
        contextWindowTokens: 200_000,
        model: Model.make({
          stream: (request) => {
            // A tab's description is not its work.
            if (!textOf(request).startsWith("Title: ")) calls.push(id)
            const count = calls.filter((each) => each === id).length
            if (scripted !== undefined) return scripted(id, count)
            if (failing.has(Models.routeOf(id, [])) || count > (lasts.get(id) ?? Infinity)) return Stream.fail(quota())
            return stepping.has(id) && count === 1
              ? step
              : answer(`answered on ${id}`)
          }
        })
      }))
  })
  const host = Host.make({
    cwd,
    environment: {
      OPENAI_API_KEY: "k",
      CEREBRAS_API_KEY: "k",
      ANTHROPIC_API_KEY: "k",
      CODEX_HOME: join(cwd, "codex"),
      SMITHERS_TUI_WORKER_SEATS: fallbacks
    },
    judge: ScriptedJudge.layerAll,
    approvals: "all",
    seats
  })
  const records: Array<Session.Record> = []
  const workspace = new Workspace({
    host,
    workerSeat: sol,
    chatSeat: () => qwen,
    history: () => [],
    persist: (record) => void records.push(record)
  })
  const tab = (id: string) => workspace.snapshot().tabs.find((each) => each.id === id)!
  /** The model changes a worker's transcript notes. */
  const switches = (id: string) =>
    workspace.transcript(id).items.flatMap((item) =>
      item.kind === "note" && item.text.startsWith("↪ ") ? [item.text] : []
    )
  const settled = (id: string) =>
    until(() => tab(id)?.status === "done" || tab(id)?.status === "failed", `${id} to settle`).then(() => tab(id))
  return {
    host,
    workspace,
    records,
    calls,
    tab,
    switches,
    settled,
    dispose: async () => {
      workspace.dispose()
      await host.dispose()
    }
  }
}

describe("a worker whose model has no credit", () => {
  test("model-scoped terminal refusal leaves the healthy sibling selectable", async () => {
    const f = fixture(
      new Set(),
      "sonnet",
      new Set(),
      new Map(),
      (id) =>
        id === "opus"
          ? Stream.fail(
            new ModelError({ code: "quota_exceeded", message: "model spent", httpStatus: 402, quotaScope: "model" })
          )
          : answer(`answered on ${id}`)
    )
    try {
      f.workspace.request({ id: "model", title: "Ask", prompt: "Ask.", model: "opus" })
      expect(await f.settled("model")).toMatchObject({ status: "done", activeSeat: "sonnet" })
      expect(f.host.credit!.spent("opus")).toBe(true)
      expect(f.host.credit!.spent("anthropic:claude-opus-5-5")).toBe(true)
      expect(f.host.credit!.spent("sonnet")).toBe(false)
      f.workspace.request({ id: "sibling", title: "Ask", prompt: "Ask.", model: "sonnet" })
      expect(await f.settled("sibling")).toMatchObject({ status: "done", seat: "sonnet" })
      expect(f.calls).toEqual(["opus", "sonnet", "sonnet"])
    } finally {
      await f.dispose()
    }
  })

  test("temporary refusal recovers the primary's visible identity and last-answer attribution", async () => {
    const f = fixture(new Set(), sol, new Set(), new Map(), (id, count) => {
      if (id === "opus" && count === 1) {
        return Stream.fail(new ModelError({ code: "quota_exceeded", message: "wait", retryAfterMillis: 10 }))
      }
      if (id === sol) return Stream.unwrap(Effect.sleep("40 millis").pipe(Effect.as(step)))
      return answer(`answered on ${id}`)
    })
    try {
      f.workspace.request({ id: "recover", title: "Ask", prompt: "Ask.", model: "opus" })
      const done = await f.settled("recover")
      expect(f.calls).toEqual(["opus", sol, "opus"])
      expect(done).toMatchObject({ status: "done", activeSeat: "opus", answer: "answered on opus" })
      expect(f.switches("recover")).toEqual(["↪ switched to GPT-6.1 Sol"])
      expect(Models.seatName(done, [])).toBe("Claude Opus 5.5")
      expect(Subagents.subagent(done, f.workspace.transcript("recover"), []).model).toBe("Claude Opus 5.5")
      expect(f.host.credit!.spent("opus")).toBe(false)
      expect(f.host.credit!.spent("sonnet")).toBe(false)
      f.host.credit!.spend(qwen)
      expect(f.host.credit!.instead(qwen, sol)).toEqual({ from: qwen, to: "opus" })
      f.workspace.request({ id: "later", title: "Ask", prompt: "Ask.", model: "opus" })
      expect(await f.settled("later")).toMatchObject({ status: "done", seat: "opus" })
      expect(f.calls).toEqual(["opus", sol, "opus", "opus"])
    } finally {
      await f.dispose()
    }
  })

  test("a final model-scoped refusal spends only the refused model", async () => {
    const f = fixture(
      new Set(),
      "",
      new Set(),
      new Map(),
      () =>
        Stream.fail(
          new ModelError({ code: "quota_exceeded", message: "model spent", httpStatus: 402, quotaScope: "model" })
        )
    )
    try {
      const outcome = await f.host.run({
        seat: "opus",
        prompt: "Ask.",
        role: "coordinator",
        history: [],
        onEvent: () => {}
      }).done
      expect(outcome._tag).toBe("failed")
      expect(f.host.credit!.spent("anthropic:claude-opus-5-5")).toBe(true)
      expect(f.host.credit!.spent("sonnet")).toBe(false)
    } finally {
      await f.dispose()
    }
  })

  test("a final timed refusal does not spend either the model or its sibling", async () => {
    const f = fixture(
      new Set(),
      "",
      new Set(),
      new Map(),
      () =>
        Stream.fail(
          new ModelError({ code: "quota_exceeded", message: "wait", resetAtEpochMillis: Date.now() + 60_000 })
        )
    )
    try {
      const outcome = await f.host.run({
        seat: "opus",
        prompt: "Ask.",
        role: "coordinator",
        history: [],
        onEvent: () => {}
      }).done
      expect(outcome._tag).toBe("failed")
      expect(f.host.credit!.spent("opus")).toBe(false)
      expect(f.host.credit!.spent("sonnet")).toBe(false)
    } finally {
      await f.dispose()
    }
  })

  test("a coordinator cell pins the person's named model through agent.delegate, and retry preserves it", async () => {
    const f = fixture(new Set(["anthropic"]), sol)
    const coordinator = Host.make({ cwd: f.host.cwd, environment: {}, judge: ScriptedJudge.layerAll })
    const replay = join(f.host.cwd, "pin.jsonl")
    const input = { id: "named", title: "Review", prompt: "Review on Opus.", model: "opus", pinned: true }
    const cell = `const r = await ctx.call("agent.delegate", ${JSON.stringify(input)}); ctx.done(JSON.stringify(r))`
    writeFileSync(
      replay,
      [
        { _tag: "model-requested" },
        { _tag: "model-delta", delta: { type: "text-start", id: "cell" } },
        { _tag: "model-delta", delta: { type: "text-delta", id: "cell", text: `\`\`\`cell\n${cell}\n\`\`\`` } },
        { _tag: "model-delta", delta: { type: "text-end", id: "cell" } },
        { _tag: "model-settled", message: { stopReason: "stop" } }
      ].map((event) => JSON.stringify({ at: 0, event })).join("\n")
    )
    try {
      const outcome = await coordinator.run({
        prompt: "Run the review on Opus.",
        role: "coordinator",
        seat: `replay:${replay}`,
        history: [],
        onEvent: () => {},
        runtime: {
          publish: () => {},
          delegate: f.workspace.request,
          read: f.workspace.read,
          list: () => f.workspace.snapshot().tabs
        }
      }).done
      expect(outcome._tag).toBe("done")
      expect(JSON.parse((outcome as { answer: string }).answer)).toEqual({ id: "named", status: "requested" })
      const failed = await f.settled("named")
      expect(failed).toMatchObject({ status: "failed", seat: "opus", pinned: true })
      expect(failed.failure?.headline).toBe("Anthropic quota exhausted")
      expect(f.calls).toEqual(["opus"])
      expect(f.switches("named")).toEqual([])
      expect(Session.restore(f.records).workspace.tabs.find((tab) => tab.id === "named")).toMatchObject({
        pinned: true,
        seat: "opus",
        status: "failed"
      })
      f.workspace.retry("named")
      expect(await f.settled("named")).toMatchObject({ status: "failed", seat: "opus", pinned: true })
      expect(f.calls).toEqual(["opus", "opus"])
      expect(f.switches("named")).toEqual([])
      // An unpinned request may skip the exhausted model for the chat model instead.
      f.workspace.request({ id: "chosen", title: "Review", prompt: "Review.", model: "opus" })
      expect(await f.settled("chosen")).toMatchObject({ status: "done", seat: qwen })
      expect(f.calls).toEqual(["opus", "opus", qwen])
    } finally {
      await coordinator.dispose()
      await f.dispose()
    }
  })

  test("fails once naming the account, then later work skips it for a known-working model and says so", async () => {
    const f = fixture()
    try {
      f.workspace.request({ id: "first", title: "Review", prompt: "Review the change.", model: "sol" })
      const failed = await f.settled("first")
      expect(failed).toMatchObject({ status: "failed", seat: sol })
      expect(failed.failure).toMatchObject({
        headline: "OpenAI quota exhausted",
        actions: ["switch-model", "resume", "details"]
      })
      expect(Tabs.actions(failed).map((action) => action.keys[0])).toEqual(["alt+m", "alt+r"])
      expect(f.host.credit!.spent("sol")).toBe(true)
      // The chat card says what failed, and the model is named as the picker names it.
      const card = Subagents.subagent(failed, f.workspace.transcript("first"), [])
      expect(card.title).toBe("Review · OpenAI quota exhausted")
      expect(card.model).toBe("GPT-6.1 Sol")
      expect(f.calls).toEqual([sol])

      // The agent asks for Sol again: the run skips it and never calls it.
      f.workspace.request({ id: "second", title: "Review", prompt: "Review it again.", model: "sol" })
      const done = await f.settled("second")
      expect(done).toMatchObject({ status: "done", seat: qwen, answer: `answered on ${qwen}` })
      expect(f.calls).toEqual([sol, qwen])
      const notice = "↪ GPT-6.1 Sol has no credit · using Qwen 3.8"
      expect(f.switches("second")).toEqual([notice])
      expect(Subagents.subagent(done, f.workspace.transcript("second"), []).entries[0]).toEqual({
        kind: "text",
        text: notice
      })
      // The notice is on the worker's record, so a restored session shows it too.
      expect(
        Session.restore(Session.load(done.file)).transcript.items.some((item) =>
          item.kind === "note" && item.text === notice
        )
      ).toBe(true)
      expect(Models.seatName(done, [])).toBe("Qwen 3.8")
      // The host recorded Qwen's answer: it is now the known-working model.
      expect(f.host.credit!.instead(sol, "anthropic:claude-opus-5-5")).toEqual({ from: sol, to: qwen })

      // Resume on the failed one falls back too.
      f.workspace.retry("first")
      expect(await f.settled("first")).toMatchObject({ status: "done", seat: qwen })
      expect(f.calls).toEqual([sol, qwen, qwen])
    } finally {
      await f.dispose()
    }
  })

  test("never replaces a model the person pinned: one they named, or one picked with m", async () => {
    const f = fixture()
    try {
      f.workspace.request({ id: "first", title: "Review", prompt: "Review.", model: "sol" })
      await f.settled("first")
      f.workspace.request({ id: "mine", title: "Review", prompt: "Review on Sol.", model: "sol", pinned: true })
      const pinned = await f.settled("mine")
      expect(pinned).toMatchObject({ status: "failed", seat: sol, pinned: true })
      expect(f.switches("mine")).toEqual([])
      expect(f.calls).toEqual([sol, sol])
      // Resuming a pinned tab keeps its pin.
      f.workspace.retry("mine")
      expect(await f.settled("mine")).toMatchObject({ status: "failed", seat: sol, pinned: true })
      expect(f.calls).toEqual([sol, sol, sol])

      // `m` picks a model for the failed tab: it runs there, whatever the tab asked for before.
      f.workspace.retry("first", sol)
      expect(await f.settled("first")).toMatchObject({ status: "failed", seat: sol, pinned: true })
      expect(f.tab("first").model).toBeUndefined()
      f.workspace.retry("first", qwen)
      expect(await f.settled("first")).toMatchObject({ status: "done", seat: qwen })
      expect(f.calls).toEqual([sol, sol, sol, sol, qwen])

      // Only the person pins: an agent's request for its own worker is not a pin, whatever it says.
      f.workspace.requestChild(f.tab("first"), {
        id: "c",
        title: "Check",
        prompt: "Check.",
        model: "sol",
        pinned: true
      })
      const child = await f.settled("first/c")
      expect(child).toMatchObject({ status: "done", seat: qwen })
      expect(child.pinned).toBeUndefined()
      // Nor is a person's request that names no model of theirs.
      f.workspace.request({ id: "plain", title: "Review", prompt: "Review.", model: "sol", by: "user" })
      expect(await f.settled("plain")).toMatchObject({ status: "done", seat: qwen })
      expect(f.tab("plain").pinned).toBeUndefined()
      expect(f.calls).toEqual([sol, sol, sol, sol, qwen, qwen, qwen])
    } finally {
      await f.dispose()
    }
  })

  test("falls back once: a stand-in that also has no credit fails the run instead of trying a third", async () => {
    const failing = new Set(["openai"])
    const f = fixture(failing)
    try {
      f.workspace.request({ id: "first", title: "Review", prompt: "Review.", model: "sol" })
      await f.settled("first")
      // Sonnet answered earlier, Qwen since; Qwen has no credit either, though nobody knows yet.
      f.host.credit!.answered("sonnet")
      f.host.credit!.answered(qwen)
      failing.add("cerebras")
      f.workspace.request({ id: "second", title: "Review", prompt: "Again.", model: "sol" })
      const failed = await f.settled("second")
      expect(failed).toMatchObject({ status: "failed", seat: qwen, failure: { headline: "Cerebras quota exhausted" } })
      expect(f.calls).toEqual([sol, qwen])
      // The next run skips both accounts for the one model known to work.
      f.workspace.request({ id: "third", title: "Review", prompt: "Once more.", model: "sol" })
      expect(await f.settled("third")).toMatchObject({ status: "done", seat: "sonnet" })
      expect(f.switches("third")).toEqual(["↪ GPT-6.1 Sol has no credit · using Claude Sonnet 5.5"])
      expect(f.calls).toEqual([sol, qwen, "sonnet"])
    } finally {
      await f.dispose()
    }
  })

  test("a failover for lack of credit says so, names the backup that failed last, and backups without credit are skipped", async () => {
    const f = fixture(new Set(["openai", "anthropic"]), sol)
    try {
      f.workspace.request({ id: "first", title: "Ask", prompt: "Ask.", model: "opus" })
      const failed = await f.settled("first")
      expect(f.calls).toEqual(["opus", sol])
      expect(f.switches("first")).toEqual(["↪ Claude Opus 5.5 has no credit · using GPT-6.1 Sol"])
      expect(failed).toMatchObject({ activeSeat: sol, failure: { headline: "OpenAI quota exhausted" } })
      expect(Models.seatName(failed, [])).toBe("GPT-6.1 Sol")
      for (const seat of ["opus", "sonnet", sol]) expect(f.host.credit!.spent(seat)).toBe(true)
      // Pinned to Opus, it runs there, and its Sol backup, spent too, is never tried.
      f.workspace.request({ id: "mine", title: "Ask", prompt: "On Opus.", model: "opus", pinned: true })
      await f.settled("mine")
      expect(f.calls).toEqual(["opus", sol, "opus"])
    } finally {
      await f.dispose()
    }
  })

  test("a pinned run never fails over, even to a backup that has credit", async () => {
    // Every worker's backup is Sol, which has credit; Anthropic has none.
    const f = fixture(new Set(["anthropic"]), sol)
    try {
      // Unpinned, Opus's refusal fails over to Sol, which answers.
      f.workspace.request({ id: "first", title: "Ask", prompt: "Ask.", model: "opus" })
      expect(await f.settled("first")).toMatchObject({ status: "done", activeSeat: sol })
      expect(f.calls).toEqual(["opus", sol])
      // Pinned to Opus, the run stays there and fails; Sol is never called.
      f.workspace.request({ id: "mine", title: "Ask", prompt: "On Opus.", model: "opus", pinned: true })
      const pinned = await f.settled("mine")
      expect(pinned).toMatchObject({ status: "failed", seat: "opus", pinned: true })
      expect(pinned.failure?.headline).toBe("Anthropic quota exhausted")
      expect(f.switches("mine")).toEqual([])
      expect(f.calls).toEqual(["opus", sol, "opus"])
      // Picked again with `m`, Opus runs alone again.
      f.workspace.retry("mine", "opus")
      expect(await f.settled("mine")).toMatchObject({ status: "failed", seat: "opus", pinned: true })
      expect(f.calls).toEqual(["opus", sol, "opus", "opus"])
    } finally {
      await f.dispose()
    }
  })

  test("the stand-in runs alone: its own backups, with credit, are never tried", async () => {
    const failing = new Set(["openai"])
    const sonnet = "anthropic:claude-sonnet-5-5"
    const kimi = "moonshot:kimi-k3"
    const f = fixture(failing, `${sonnet},${kimi}`)
    try {
      // Sol's refusal fails over to its backup Sonnet, which answers.
      f.workspace.request({ id: "first", title: "Review", prompt: "Review.", model: "sol" })
      expect(await f.settled("first")).toMatchObject({ status: "done", activeSeat: sonnet })
      expect(f.calls).toEqual([sol, sonnet])
      // Sonnet has since run out too, though nobody knows yet; Kimi still has credit.
      failing.add("anthropic")
      f.workspace.request({ id: "second", title: "Review", prompt: "Again.", model: "sol" })
      const failed = await f.settled("second")
      expect(f.switches("second")).toEqual(["↪ GPT-6.1 Sol has no credit · using Claude Sonnet 5.5"])
      expect(failed).toMatchObject({
        status: "failed",
        seat: sonnet,
        failure: { headline: "Anthropic quota exhausted" }
      })
      expect(f.calls).toEqual([sol, sonnet, sonnet])
    } finally {
      await f.dispose()
    }
  })

  test("a run asks a refused model once: later frames go straight to the backup that answered", async () => {
    const kimi = "moonshot:kimi-k3"
    const failing = new Set(["anthropic", "openai"])
    const f = fixture(failing, `${sol},${kimi}`, new Set([kimi]))
    try {
      f.workspace.request({ id: "first", title: "Ask", prompt: "Ask.", model: "opus" })
      const done = await f.settled("first")
      expect(done).toMatchObject({ status: "done", activeSeat: kimi, answer: `answered on ${kimi}` })
      // Two frames: the first goes Opus, Sol, Kimi; the second asks Kimi alone.
      expect(f.calls).toEqual(["opus", sol, kimi, kimi])
      expect(f.switches("first")).toEqual([
        "↪ Claude Opus 5.5 has no credit · using GPT-6.1 Sol",
        "↪ GPT-6.1 Sol has no credit · using Kimi K3"
      ])
      // Kimi answered both frames; the refused Opus and Sol never count as working.
      expect(f.host.credit!.instead("opus", qwen)).toEqual({ from: "opus", to: kimi })
    } finally {
      await f.dispose()
    }
  })

  test("a refusal in a later frame is charged to the backup that made it, not the frame's own model", async () => {
    const kimi = "moonshot:kimi-k3"
    // Kimi takes the first frame, then runs out before the second.
    const f = fixture(new Set(["anthropic", "openai"]), `${sol},${kimi}`, new Set([kimi]), new Map([[kimi, 1]]))
    try {
      f.workspace.request({ id: "first", title: "Ask", prompt: "Ask.", model: "opus" })
      const failed = await f.settled("first")
      expect(f.calls).toEqual(["opus", sol, kimi, kimi])
      expect(failed).toMatchObject({ status: "failed", failure: { headline: "Kimi quota exhausted" } })
      expect(f.host.credit!.spent(kimi)).toBe(true)
    } finally {
      await f.dispose()
    }
  })
})
