import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Capability from "@smthrs/capability/Capability"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Compaction from "@smthrs/harness/Compaction"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Agents from "../src/agents.ts"
import * as Approvals from "../src/approvals.ts"
import * as Host from "../src/host.ts"
import * as Log from "../src/log.ts"
import * as Runtime from "../src/runtime.ts"
import * as Session from "../src/session.ts"
import * as Spend from "../src/spend.ts"
import * as Subagents from "../src/subagents.ts"
import * as Timeline from "../src/timeline.ts"
import * as Transcript from "../src/transcript.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A recorded model that answers with `cell` (default `ctx.done("ok")`), then
 * with each of `later` in turn. The last reply repeats for every further frame.
 */
const doneReplay = (directory: string, cell = "ctx.done(\"ok\")", ...later: ReadonlyArray<string>): string => {
  const file = join(directory, "done.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  writeFileSync(
    file,
    [cell, ...later].flatMap((body) => [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-start", id: "cell" }),
      delta({ type: "text-delta", id: "cell", text: `\`\`\`cell\n${body}\n\`\`\`` }),
      delta({ type: "text-end", id: "cell" }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ]).join("\n")
  )
  return file
}

const turn = async (role: "coordinator" | "worker") => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-host-"))
  roots.push(cwd)
  writeFileSync(join(cwd, "a.ts"), "export {}\n")
  const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer })
  const events: Array<AgentEvent.AgentEvent> = []
  try {
    const outcome = await host.run({
      prompt: "answer",
      role,
      seat: `replay:${doneReplay(cwd)}`,
      history: [],
      onEvent: (event) => events.push(event)
    }).done
    return { outcome, events }
  } finally {
    await host.dispose()
  }
}

const basis = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  events.flatMap((event) => (event._tag === "mutation-observed" ? [event.basis] : []))

describe("Host.run workspace observation", () => {
  for (const location of ["nested", "root", "alias"] as const) {
    test(`does not count its in-project session and diagnostic writes as edits (${location})`, async () => {
      const previous = process.env.SMITHERS_TUI_SESSION_DIR
      const cwd = mkdtempSync(join(tmpdir(), "tui-observer-session-"))
      roots.push(cwd)
      if (location === "alias") symlinkSync(cwd, join(cwd, "alias"), "dir")
      process.env.SMITHERS_TUI_SESSION_DIR = location === "root"
        ? cwd
        : join(cwd, location === "alias" ? "alias" : "sessions")
      const seat = `replay:${doneReplay(cwd)}`
      const writer = Session.create(cwd)
      const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer, approvals: "all" })
      const events: Array<AgentEvent.AgentEvent> = []
      try {
        const outcome = await host.run({
          prompt: "answer",
          role: "worker",
          seat,
          history: [],
          onEvent: (event) => {
            events.push(event)
            writer.append({ type: "event", at: Date.now(), event })
            Log.write("observation-test", event._tag)
          }
        }).done
        expect(outcome).toEqual({ _tag: "done", answer: "ok" })
        expect(new Set(events.filter((event) => event._tag === "mutation-observed").map((event) => event.mutated)))
          .toEqual(new Set([false]))
        events.length = 0
        const editingSeat = `replay:${
          doneReplay(
            cwd,
            "await ctx.call(\"write\", { path: \"sessions/project.ts\", content: \"real project edit\" }); ctx.done(\"edited\")"
          )
        }`
        const edited = await host.run({
          prompt: "edit",
          role: "worker",
          seat: editingSeat,
          history: [],
          onEvent: (event) => {
            events.push(event)
            writer.append({ type: "event", at: Date.now(), event })
          }
        }).done
        expect(edited).toEqual({ _tag: "done", answer: "edited" })
        expect(readFileSync(join(cwd, "sessions", "project.ts"), "utf8")).toBe("real project edit")
        expect(existsSync(join(process.cwd(), "sessions", "project.ts"))).toBe(false)
        expect(new Set(events.filter((event) => event._tag === "mutation-observed").map((event) => event.mutated)))
          .toEqual(new Set([true]))
      } finally {
        await host.dispose()
        if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
        else process.env.SMITHERS_TUI_SESSION_DIR = previous
      }
    })
  }

  test("resolves relative flow paths against the host cwd, not the process cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-host-cwd-"))
    roots.push(cwd)
    expect(process.cwd()).not.toBe(cwd)
    const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer, approvals: "all" })
    try {
      const outcome = await host.run({
        prompt: "edit",
        role: "worker",
        seat: `replay:${
          doneReplay(
            cwd,
            [
              "await ctx.call(\"write\", { path: \"relative.txt\", content: \"hosted\" })",
              "await ctx.call(\"edit\", { path: \"relative.txt\", oldString: \"hosted\", newString: \"edited\" })",
              "const read = await ctx.call(\"read\", { path: \"relative.txt\" })",
              "const shell = await ctx.call(\"bash\", { command: \"pwd -P\" })",
              "ctx.done(read.content + \" \" + shell.stdout.trim())"
            ].join("; ")
          )
        }`,
        history: [],
        onEvent: () => {}
      }).done
      expect(outcome).toEqual({ _tag: "done", answer: `edited ${realpathSync(cwd)}` })
      expect(existsSync(join(process.cwd(), "relative.txt"))).toBe(false)
    } finally {
      await host.dispose()
    }
  })

  test("a coordinator turn measures no tree: it has no flow that can move one", async () => {
    const { outcome, events } = await turn("coordinator")

    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    expect(basis(events)).toEqual(["declared"])
  })

  test("a worker turn still measures the tree its flows edit", async () => {
    const { outcome, events } = await turn("worker")

    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    expect(basis(events).length).toBeGreaterThan(0)
    expect(new Set(basis(events))).toEqual(new Set(["observed"]))
  })
})

describe("Host.run Smithers plugin", () => {
  const run = async (role: "coordinator" | "worker", cell: string, runtime: NonNullable<Host.TurnInput["runtime"]>) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-plugin-"))
    roots.push(cwd)
    const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer })
    try {
      return await host.run({
        prompt: "go",
        role,
        runtime,
        seat: `replay:${doneReplay(cwd, cell)}`,
        history: [],
        onEvent: () => {}
      })
        .done
    } finally {
      await host.dispose()
    }
  }

  test("a coordinator cell lists, runs and inspects flows through ctx.call on the host's ports", async () => {
    const requests: Array<unknown> = []
    const outcome = await run(
      "coordinator",
      `const g = await ctx.call("smithers.guide", { topic: "cli" }); const f = await ctx.call("smithers.flows", {}); const r = await ctx.call("smithers.run", { id: "r1", flow: "review" }); const i = await ctx.call("smithers.inspect", { id: "r1" }); ctx.done(JSON.stringify({ cli: g.cli.length, f, r, i }))`,
      {
        publish: () => {},
        flows: {
          list: () => [{ name: "review", description: "Review" }],
          run: (request) => (requests.push(request), { id: request.id, status: "requested" }),
          inspect: (id) => ({ id, status: "running" })
        }
      }
    )
    expect(outcome._tag).toBe("done")
    expect(JSON.parse((outcome as { answer: string }).answer)).toEqual({
      cli: 16,
      f: [{ name: "review", description: "Review" }],
      r: { id: "r1", status: "requested" },
      i: { id: "r1", status: "running" }
    })
    expect(requests).toEqual([{ id: "r1", flow: "review" }])
  })

  test("a worker cell reaches smithers.guide", async () => {
    const outcome = await run(
      "worker",
      `const g = await ctx.call("smithers.guide", {}); ctx.done(Object.keys(g).join(","))`,
      { publish: () => {} }
    )
    expect(outcome).toEqual({ _tag: "done", answer: "packages,cli,authoring" })
  })
})

test("Host.run lets agent.wait settle after the ordinary flow call ceiling", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-wait-"))
  roots.push(cwd)
  const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer, callMs: 20, totalMs: 30 })
  let contacted = 0
  try {
    const result = await host.run({
      prompt: "wait for child",
      role: "worker",
      seat: `replay:${
        doneReplay(
          cwd,
          "const children = await ctx.call(\"agent.wait\", { ids: [\"child\"] }); ctx.done(children[0].answer)"
        )
      }`,
      history: [],
      runtime: {
        publish: () => {},
        delegate: () => ({ id: "child", status: "requested" }),
        read: () => ({}),
        list: () => [],
        wait: async () => {
          contacted++
          await new Promise((resolve) => setTimeout(resolve, 80))
          return [{ id: "child", status: "done", answer: "late answer" }]
        }
      },
      onEvent: () => {}
    }).done
    expect(contacted).toBeGreaterThan(0)
    expect(result).toEqual({ _tag: "done", answer: "late answer" })
  } finally {
    await host.dispose()
  }
})

test("Host.run bounds a worker frame waiting on a non-flow promise", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-stall-"))
  roots.push(cwd)
  const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer, totalMs: 30 })
  try {
    const events: AgentEvent.AgentEvent[] = []
    // The stalled frame is rejected at once; the next frame answers, so the
    // turn ends there instead of replaying the stall until the 40-frame budget.
    const outcome = await host.run({
      prompt: "stall",
      role: "worker",
      seat: `replay:${doneReplay(cwd, "await new Promise(() => {}); ctx.done('never')", "ctx.done('recovered')")}`,
      history: [],
      onEvent: (event) => events.push(event)
    }).done
    expect(events.find((event) => event._tag === "discipline-armed")).toMatchObject({ totalMs: 30 })
    const outcomes = events.flatMap((event) => (event._tag === "cell-settled" ? [event.outcome] : []))
    expect(outcomes[0]).toMatchObject({ _tag: "rejected", code: "stalled" })
    expect(outcomes.slice(1).every((outcome) => outcome._tag !== "rejected")).toBe(true)
    expect(outcome).toEqual({ _tag: "done", answer: "recovered" })
  } finally {
    await host.dispose()
  }
})

test("Host.run clears the streamed reply when the model retries", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-retry-"))
  roots.push(cwd)
  const file = join(cwd, "retry.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-delta", id: "first", text: "seat one partial" }),
      delta({ type: "retry", attempt: 1, code: "rate_limited", delayMillis: 0 }),
      delta({ type: "text-delta", id: "second", text: "fallback\n```cell\nctx.done('ok')\n```" }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ].join("\n")
  )
  const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer })
  const captions: Array<string> = []
  try {
    const outcome = await host.run({
      prompt: "reply",
      role: "coordinator",
      seat: `replay:${file}`,
      history: [],
      onEvent: () => {},
      onCaption: (caption) => captions.push(caption)
    }).done
    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    expect(captions).toContain("fallback")
    expect(captions.join(" ")).not.toContain("seat one")
  } finally {
    await host.dispose()
  }
})

test("Host.run keeps the call ceiling on plugin flows while worker waits are exempt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-plugin-limit-"))
  roots.push(cwd)
  const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer, callMs: 20 })
  let settle!: (value: AgentEvent.AgentEvent) => void
  const observed = new Promise<AgentEvent.AgentEvent>((resolve) => {
    settle = resolve
  })
  try {
    const turn = host.run({
      prompt: "list",
      role: "worker",
      seat: `replay:${doneReplay(cwd, "await ctx.call(\"smithers.flows\", {}); ctx.done(\"listed\")")}`,
      history: [],
      runtime: {
        publish: () => {},
        flows: {
          list: async () => {
            await new Promise((resolve) => setTimeout(resolve, 80))
            return []
          },
          run: () => ({}),
          inspect: () => ({})
        }
      },
      onEvent: (event) => {
        if (event._tag === "cell-call-settled" && event.flowName === "smithers.flows") settle(event)
      }
    })
    const event = await observed
    turn.cancel()
    await turn.done
    expect(event).toMatchObject({ result: { outcome: "failure", message: expect.stringContaining("timed out") } })
  } finally {
    await host.dispose()
  }
})

test("Host.run exposes non-parked usage-limit copy for a failure card", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-limit-"))
  roots.push(cwd)
  const file = join(cwd, "limited.jsonl")
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      JSON.stringify({
        at: 0,
        event: { _tag: "replay-failure", code: "rate_limited", message: "The usage limit has been reached" }
      })
    ].join("\n")
  )
  const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer })
  try {
    const outcome = await host.run({
      prompt: "review",
      role: "coordinator",
      seat: `replay:${file}`,
      history: [],
      onEvent: () => {}
    }).done
    expect(outcome._tag).toBe("failed")
    const copy = FailureCopy.describe(outcome._tag === "failed" ? outcome.error : undefined, "openai:gpt-6-sol")
    expect(copy.headline).toBe("ChatGPT usage limit reached")
    expect(copy.line).not.toContain("usage limit has been reached")
  } finally {
    await host.dispose()
  }
})

/** A recorded model whose every reply delegates and prints, never calling `ctx.done`. */
const pollingReplay = (directory: string): string => {
  const file = join(directory, "polling.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  const cell = [
    "```cell",
    "try { await ctx.call(\"agent.delegate\", { id: \"fix-tab-read\", title: \"Fix tab.read output\", prompt: \"fix it\" }) }",
    "catch (error) { console.log(\"Still no seat\") }",
    "await ctx.call(\"tab.list\", {})",
    "```"
  ].join("\n")
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-start", id: "cell" }),
      delta({ type: "text-delta", id: "cell", text: cell }),
      delta({ type: "text-end", id: "cell" }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ].join("\n")
  )
  return file
}

const pollingTurn = async (delegate: (attempt: number) => unknown) => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-host-"))
  roots.push(cwd)
  const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer })
  const events: Array<AgentEvent.AgentEvent> = []
  let delegations = 0
  try {
    const outcome = await host.run({
      prompt: "fix tab.read",
      role: "coordinator",
      seat: `replay:${pollingReplay(cwd)}`,
      history: [],
      runtime: { publish: () => {}, delegate: () => delegate(++delegations), read: () => ({}), list: () => [] },
      onEvent: (event) => events.push(event)
    }).done
    const answer = outcome._tag === "done" ? outcome.answer : `${outcome._tag}`
    const resolved = events.flatMap((event) => (event._tag === "resolved" ? [event.message.content] : []))
    return { answer, delegations, resolved }
  } finally {
    await host.dispose()
  }
}

/** A recorded model whose every reply delegates and completes in the same cell, before the result exists. */
const claimingReplay = (directory: string): string => {
  const file = join(directory, "claiming.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  const cell = [
    "```cell",
    "await ctx.call(\"agent.delegate\", { id: \"design\", title: \"Estimation design\", prompt: \"design it\" })",
    "ctx.done(\"Delegated the estimation design to codex sol.\")",
    "```"
  ].join("\n")
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-start", id: "cell" }),
      delta({ type: "text-delta", id: "cell", text: cell }),
      delta({ type: "text-end", id: "cell" }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ].join("\n")
  )
  return file
}

describe("Host.run completion over a failed request", () => {
  const claimingTurn = async (delegate: () => unknown) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-host-"))
    roots.push(cwd)
    const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer })
    const events: Array<AgentEvent.AgentEvent> = []
    let delegations = 0
    try {
      const outcome = await host.run({
        prompt: "design estimation",
        role: "coordinator",
        seat: `replay:${claimingReplay(cwd)}`,
        history: [],
        runtime: { publish: () => {}, delegate: () => (delegations++, delegate()), read: () => ({}), list: () => [] },
        onEvent: (event) => events.push(event)
      }).done
      const answer = outcome._tag === "done" ? outcome.answer : `${outcome._tag}`
      const resolved = events.flatMap((event) => (event._tag === "resolved" ? [event.message.content] : []))
      return { answer, delegations, resolved, events }
    } finally {
      await host.dispose()
    }
  }

  test("a claim written before its delegation failed is handed back once, then answered with the failure", async () => {
    const { answer, delegations, resolved, events } = await claimingTurn(() => {
      throw new Error("Three workers are active; wait for a completion")
    })

    // The harness hands the blind claim back once; the replayed seat claims again.
    expect(events.filter((event) => event._tag === "failed-call-demanded")).toHaveLength(1)
    expect(delegations).toBe(2)
    expect(answer).toBe("Not delegated: Estimation design (Three workers are active; wait for a completion)")
    expect(answer).not.toContain("Delegated the estimation design")
    expect(resolved).toEqual([[{ type: "text", text: answer }]])
  })

  test("a delegation that was accepted keeps the coordinator's own answer", async () => {
    const { answer, delegations } = await claimingTurn(() => ({ id: "design", status: "requested" }))

    expect(delegations).toBe(1)
    expect(answer).toBe("Delegated the estimation design to codex sol.")
  })
})

describe("Host.run frame budget", () => {
  test("a coordinator that spends its frames polling a refused delegation says it was not delegated", async () => {
    const { answer, delegations, resolved } = await pollingTurn(() => {
      throw new Error("Three workers are active; wait for a completion")
    })

    expect(delegations).toBe(8)
    expect(answer).toBe(
      "Stopped after 8 frames.\nNot delegated: Fix tab.read output (Three workers are active; wait for a completion)"
    )
    // The transcript renders the resolved event, so it must carry the same words.
    expect(resolved).toEqual([[{ type: "text", text: answer }]])
  })

  test("a delegation refused once and accepted later reads as requested, not as not delegated", async () => {
    const { answer } = await pollingTurn((attempt) => {
      if (attempt === 1) throw new Error("Three workers are active")
      return { id: "fix-tab-read", status: "requested" }
    })

    expect(answer).toBe("Stopped after 8 frames.\nRequested: Fix tab.read output")
  })
})

describe("Host.run shell monitors pass the approval gate", () => {
  const shell = { kind: "shell", command: "tail -5 x.log" }
  const tab = { kind: "tab", id: "build" }
  const created: Array<unknown> = []
  const monitorTurn = async (
    approvals: Approvals.Mode,
    source: object,
    answer?: Approvals.Choice
  ) => {
    created.length = 0
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-monitor-"))
    roots.push(cwd)
    const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer, approvals })
    const request = { id: "log", title: "Log", watch: "an error", source }
    const cell = `let r; try { r = await ctx.call("monitor.create", ${JSON.stringify(request)}) } ` +
      `catch (e) { r = { threw: String(e?.message ?? e) } } ctx.done(JSON.stringify(r))`
    try {
      const turn = host.run({
        prompt: "watch",
        role: "coordinator",
        seat: `replay:${doneReplay(cwd, cell)}`,
        history: [],
        runtime: {
          publish: () => {},
          monitors: {
            create: (input) => (created.push(input), { id: input.id, status: "active" }),
            list: () => [],
            stop: (id) => ({ id, status: "stopped" })
          }
        },
        onEvent: () => {}
      })
      let pending: ReadonlyArray<Approvals.Pending> = []
      if (answer !== undefined) {
        for (let attempt = 0; attempt < 400 && pending.length === 0; attempt++) {
          pending = await host.approvals!.pending()
          if (pending.length === 0) await Bun.sleep(10)
        }
        expect(created).toEqual([])
        await host.approvals!.reply(pending[0]!, answer)
      }
      const outcome = await turn.done
      return { outcome, pending, created: [...created] }
    } finally {
      await host.dispose()
    }
  }

  test("all creates without asking", async () => {
    const { outcome, created } = await monitorTurn("all", shell)
    expect(outcome).toEqual({ _tag: "done", answer: JSON.stringify({ id: "log", status: "active" }) })
    expect(created).toHaveLength(1)
  })

  test("ask waits for y and shows the command; n refuses", async () => {
    const yes = await monitorTurn("ask", shell, "once")
    expect(yes.pending[0]).toMatchObject({ flow: "monitor.create", subject: "tail -5 x.log", action: "proc:spawn" })
    expect(yes.created).toHaveLength(1)
    const no = await monitorTurn("ask", shell, "deny")
    expect(no.created).toEqual([])
    expect(JSON.stringify(no.outcome)).toContain("Denied: monitor.create tail -5 x.log")
  })

  test("deny refuses a shell source and still creates a tab source", async () => {
    const denied = await monitorTurn("deny", shell)
    expect(denied.created).toEqual([])
    expect(JSON.stringify(denied.outcome)).toContain("Denied: monitor.create")
    const watched = await monitorTurn("deny", tab)
    expect(watched.created).toHaveLength(1)
  })

  test("a restored shell monitor asks again under this session's mode", async () => {
    const restoredUnder = async (approvals: Approvals.Mode, answer?: Approvals.Choice) => {
      const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-monitor-"))
      roots.push(cwd)
      const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer, approvals })
      try {
        const gate = Approvals.restored((requests) => host.approvals!.authorize(requests))
        const settled = gate({ source: { kind: "shell", command: "tail -5 x.log" } }).then(
          () => "armed",
          (error) => String(error)
        )
        let pending: ReadonlyArray<Approvals.Pending> = []
        if (answer !== undefined) {
          for (let attempt = 0; attempt < 400 && pending.length === 0; attempt++) {
            pending = await host.approvals!.pending()
            if (pending.length === 0) await Bun.sleep(10)
          }
          await host.approvals!.reply(pending[0]!, answer)
        }
        return {
          result: await settled,
          pending,
          tab: await gate({ source: { kind: "tab", id: "t" } }).then(() => "armed")
        }
      } finally {
        await host.dispose()
      }
    }
    expect(await restoredUnder("all")).toMatchObject({ result: "armed", tab: "armed" })
    const denied = await restoredUnder("deny")
    expect(denied.result).toContain("Denied: monitor.create tail -5 x.log")
    expect(denied.tab).toBe("armed")
    const asked = await restoredUnder("ask", "once")
    expect(asked.pending[0]).toMatchObject({ flow: "monitor.create", subject: "tail -5 x.log" })
    expect(asked.result).toBe("armed")
    expect((await restoredUnder("ask", "deny")).result).toContain("Denied")
  })
})

describe("Host.complete", () => {
  test("sends the seat's bare model id and no token budget, which the ChatGPT route would refuse", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const chunk = (value: object) => `data: ${JSON.stringify(value)}\n\n`
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        bodies.push(await request.json() as Record<string, unknown>)
        const choice = (delta: object, finish: string | null) =>
          chunk({
            id: "c",
            object: "chat.completion.chunk",
            created: 0,
            model: "m",
            choices: [{ index: 0, delta, finish_reason: finish }]
          })
        return new Response(
          `${choice({ role: "assistant", content: "{\"minutes\": 3}" }, null)}${choice({}, "stop")}data: [DONE]\n\n`,
          {
            headers: { "content-type": "text/event-stream" }
          }
        )
      }
    })
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-complete-"))
    roots.push(cwd)
    const host = Host.make({
      cwd,
      environment: { OPENAI_API_KEY: "k", SMITHERS_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${server.port}` }
    })
    try {
      expect(await host.complete!({ system: "s", prompt: "p", seat: "openai:gpt-6-luna" })).toBe("{\"minutes\": 3}")
      // A tab description goes to the worker's own seat, by its bare model id too.
      expect(await host.describe!({ title: "t", prompt: "p", seat: "openai:gpt-6-sol" })).toBe("{\"minutes\": 3}")
    } finally {
      await host.dispose()
      server.stop()
    }
    expect(bodies.map((body) => body.model)).toEqual(["gpt-6-luna", "gpt-6-sol"])
    for (const body of bodies) {
      expect(Object.keys(body).filter((key) => /max/.test(key))).toEqual([])
    }
  })
})

describe("Host.run under a provider quota refusal", () => {
  test("a worker refused for ten minutes emits a park instead of a provider failure", async () => {
    let asked = 0
    const provider = Bun.serve({
      port: 0,
      fetch: () => {
        asked += 1
        return Response.json(
          {
            error: {
              message: "Rate limit reached. Try again in 10m.",
              type: "rate_limit_exceeded",
              code: "rate_limit_exceeded"
            }
          },
          { status: 429, headers: { "retry-after": "600" } }
        )
      }
    })
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-quota-"))
    roots.push(cwd)
    const host = Host.make({
      cwd,
      environment: {
        OPENAI_API_KEY: "sk-test",
        SMITHERS_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${provider.port}`
      },
      approvals: "all"
    })
    try {
      const events: AgentEvent.AgentEvent[] = []
      const turn = host.run({
        prompt: "answer",
        role: "worker",
        seat: "openai:gpt-test",
        history: [],
        onEvent: (event) => events.push(event)
      })
      const outcome = await turn.done
      expect(events.find((event) => event._tag === "model-parked")).toMatchObject({
        code: "rate_limited",
        seat: "openai:gpt-test"
      })
      expect(outcome).toMatchObject({ _tag: "cancelled" })
      expect(asked).toBe(1)
    } finally {
      await host.dispose()
      provider.stop(true)
    }
  }, 90_000)

  test("a worker with no parks left fails with the provider's typed limit", async () => {
    let asked = 0
    const provider = Bun.serve({
      port: 0,
      fetch: () => {
        asked += 1
        return Response.json(
          {
            error: {
              message: "Rate limit reached. Try again in 10m.",
              type: "rate_limit_exceeded",
              code: "rate_limit_exceeded"
            }
          },
          { status: 429, headers: { "retry-after": "600" } }
        )
      }
    })
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-quota-"))
    roots.push(cwd)
    const host = Host.make({
      cwd,
      environment: {
        OPENAI_API_KEY: "sk-test",
        SMITHERS_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${provider.port}`
      },
      approvals: "all"
    })
    try {
      const events: AgentEvent.AgentEvent[] = []
      const turn = host.run({
        prompt: "answer",
        role: "worker",
        seat: "openai:gpt-test",
        fallbackSeats: [],
        maxParks: 0,
        history: [],
        onEvent: (event) => events.push(event)
      })
      const outcome = await turn.done
      expect(events.some((event) => event._tag === "model-parked")).toBe(false)
      expect(outcome._tag).toBe("failed")
      expect(FailureCopy.describe(outcome._tag === "failed" ? outcome.error : undefined, "openai:gpt-test"))
        .toMatchObject({ headline: "ChatGPT usage limit reached", fault: "wait" })
      expect(asked).toBe(1)
    } finally {
      await host.dispose()
      provider.stop(true)
    }
  }, 90_000)
})

describe("turnOptions", () => {
  const source = (name: string, flows: ReadonlyArray<string>) => ({
    name,
    bindings: () => Effect.succeed(flows.map((flow) => ({ descriptor: { name: flow } }))) as never
  })
  const standard = [source("filesystem", ["read", "write", "grep"]), source("shell", ["bash"])]
  const names = async (
    sources: ReadonlyArray<
      { readonly bindings: () => Effect.Effect<ReadonlyArray<{ descriptor: { name: string } }>, unknown> }
    >
  ) =>
    (await Promise.all(sources.map((each) => Effect.runPromise(each.bindings())))).flat().map((binding) =>
      binding.descriptor.name
    )
  const base = { prompt: "go", seat: "test:worker", role: "worker" as const, history: [], onEvent: () => {} }
  const profile: Agents.Profile = {
    name: "review",
    digest: "d",
    system: "You review changes.",
    thinking: "high",
    flows: ["read", "bash"],
    envelope: ["fs:read:**"]
  }

  test("a plain worker keeps every standard flow, the wildcard envelope and the provider's effort", async () => {
    const options = Host.turnOptions(base, "/repo", standard)
    expect(await names(options.flows)).toEqual(["read", "write", "grep", "bash"])
    expect(options.capabilityEnvelope.map(String)).toEqual([
      String(new Capability.CapabilityPattern({ action: "*", resource: "*" }))
    ])
    expect(options.reasoningEffort).toBeUndefined()
    expect(options.system.some((part) => part.includes("You review changes."))).toBe(false)
  })

  test("a worker that can ask gets the ask flow pinned beside its runtime flows", async () => {
    const options = Host.turnOptions(
      {
        ...base,
        runtime: {
          publish: () => {},
          delegate: () => ({}),
          read: () => ({}),
          list: () => [],
          ask: async () => ({ answer: "yes", approved: true }),
          answer: () => ({})
        }
      },
      "/repo",
      standard
    )
    const flows = await names(options.flows)
    expect(flows).toContain("ask")
    expect(flows).toContain("agent.answer")
    expect(options.pinnedSources).toEqual(["tui/runtime", "host/approval"])
  })

  test("an agent profile sets the system prompt, the envelope, the flows and the effort", async () => {
    const options = Host.turnOptions({ ...base, agent: profile }, "/repo", standard)
    expect(options.system.at(-1)).toBe("You review changes.")
    // The worker teaching still applies.
    expect(options.system.some((part) => part.startsWith("Start each cell"))).toBe(true)
    expect(options.capabilityEnvelope.map((pattern) => `${pattern.action}:${pattern.resource}`)).toEqual(["fs:read:**"])
    expect(await names(options.flows)).toEqual(["read", "bash"])
    expect(options.reasoningEffort).toBe("high")
    expect(Host.turnOptions({ ...base, agent: profile, thinking: "low" }, "/repo", standard).reasoningEffort).toBe(
      "low"
    )
  })

  test("a worker opens with memory only when its agent keeps the flow and may read what memory reads", () => {
    const opens = (agent?: Partial<Agents.Profile>, role: "worker" | "coordinator" = "worker") =>
      Host.turnOptions(
        { ...base, role, ...(agent === undefined ? {} : { agent: { ...profile, ...agent } }) },
        "/repo",
        []
      )
        .memory
    expect(opens()).toBe(true)
    expect(opens(undefined, "coordinator")).toBe(false)
    expect(opens({ flows: ["read", "memory"] })).toBe(true)
    expect(opens({ flows: [], envelope: [] })).toBe(true)
    // The review profile's flows drop memory.
    expect(opens({})).toBe(false)
    expect(opens({ flows: ["memory"], envelope: ["proc:spawn:*"] })).toBe(false)
    // The workspace alone is not what the memory flow requires.
    expect(opens({ flows: ["memory"], envelope: ["fs:read:/repo/**"] })).toBe(false)
  })

  test("an agent with no declared flows or capabilities keeps the host defaults", async () => {
    const options = Host.turnOptions({ ...base, agent: { ...profile, flows: [], envelope: [] } }, "/repo", standard)
    expect(await names(options.flows)).toEqual(["read", "write", "grep", "bash"])
    expect(options.capabilityEnvelope).toHaveLength(1)
    expect(options.capabilityEnvelope[0]!.action).toBe("*")
  })
})

describe("workerSources", () => {
  const services = Effect.runSync(
    Effect.context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner>().pipe(Effect.provide(NodeServices.layer))
  )
  const judge = Effect.runSync(
    Effect.context<Evaluator.Evaluator>().pipe(Effect.provide(Evaluator.layerScripted(() => ({}))))
  )
  const names = async (sources: ReadonlyArray<FlowBinding.Source>) =>
    (await Promise.all(sources.map((each) => Effect.runPromise(each.bindings())))).flat().map((binding) =>
      binding.descriptor.name
    )

  test("a judge binds jev after the shell flows; none leaves it absent", async () => {
    const judged = await names(Host.workerSources(services, judge, "/repo", () => {}))
    expect(judged.at(-1)).toBe("jev")
    expect(judged).toContain("bash")
    expect(await names(Host.workerSources(services, undefined, "/repo", () => {}))).not.toContain("jev")
  })

  test("an agent whose flows omit jev is narrowed like any other flow", async () => {
    const input = {
      prompt: "go",
      seat: "test:worker",
      role: "worker" as const,
      history: [],
      onEvent: () => {},
      agent: { name: "review", digest: "d", system: "s", flows: ["read"], envelope: [] }
    }
    const options = Host.turnOptions(input, "/repo", Host.workerSources(services, judge, "/repo", () => {}))
    expect(await names(options.flows)).toEqual(["read"])
  })
})

describe("Host.run jev binding", () => {
  const scripted = Evaluator.layerScripted((request) =>
    Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        question.type === "boolean"
          ? { probability: 0.9 }
          : question.type === "choice"
          ? { choice: Object.keys(question.criteria)[0]! }
          : { score: 0 }
      ])
    )
  )
  /** The outcomes of the `jev` calls a turn settled. */
  const run = async (role: "coordinator" | "worker", judge: typeof scripted | undefined) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-jev-"))
    roots.push(cwd)
    const cell =
      "await ctx.call(\"jev\", { state: {}, questions: { q: { type: \"boolean\", instructions: \"Yes?\" } } }).catch(() => {}); ctx.done(\"ok\")"
    const host = Host.make({ cwd, environment: {}, ...(judge === undefined ? {} : { judge }) })
    const settled: Array<string> = []
    const armed: Array<boolean | undefined> = []
    try {
      await host.run({
        prompt: "judge",
        role,
        seat: `replay:${doneReplay(cwd, cell)}`,
        history: [],
        onEvent: (event) => {
          if (event._tag === "cell-call-settled" && event.flowName === "jev") settled.push(event.result.outcome)
          if (event._tag === "discipline-armed") armed.push(event.judged)
        }
      }).done
      return { judged: host.judged, settled, armed }
    } finally {
      await host.dispose()
    }
  }

  test("the judge seam alone judges the host, binds jev and arms a worker", async () => {
    const { armed, judged, settled } = await run("worker", scripted)
    expect(judged).toBe(true)
    expect(settled[0]).toBe("success")
    expect(armed).toEqual([true])
  })

  test("a missing subscription keeps the worker judged; coordinators remain unarmed", async () => {
    const unjudged = await run("worker", undefined)
    expect(unjudged.judged).toBe(true)
    expect(unjudged.settled).not.toContain("success")
    expect(unjudged.armed).toEqual([true])
    const coordinator = await run("coordinator", scripted)
    expect(coordinator.settled).not.toContain("success")
    // A judged host still never arms its coordinator.
    expect(coordinator.armed).toEqual([undefined])
  })
})

describe("Host.run without a judge (#2163)", () => {
  /** Frames of a coordinator turn and the supervisor readings its judge was asked for. */
  const supervise = async (failure: Evaluator.EvaluatorError) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-no-judge-"))
    roots.push(cwd)
    let asked = 0
    const judge = Evaluator.layerScripted((request) => {
      if (Object.hasOwn(request.questions, "thrashing")) asked++
      return Effect.fail(failure)
    })
    const host = Host.make({ cwd, environment: {}, judge })
    const unjudged: Array<string> = []
    let frames = 0
    try {
      const outcome = await host.run({
        prompt: "count",
        role: "coordinator",
        seat: `replay:${doneReplay(cwd, "console.log(1)", "console.log(2)", "console.log(3)", "ctx.done(\"ok\")")}`,
        history: [],
        onEvent: (event) => {
          if (event._tag === "cell-produced") frames++
          if (event._tag === "supervisor-unjudged") unjudged.push(event.reason)
        }
      }).done
      return { outcome, asked, frames, unjudged }
    } finally {
      await host.dispose()
    }
  }

  test("a missing judge is journaled once, not every frame, and the turn still answers", async () => {
    const { asked, frames, outcome, unjudged } = await supervise(
      new Evaluator.EvaluatorError({ code: "unconfigured", message: "AI_GATEWAY_API_KEY is not set." })
    )
    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    expect(frames).toBe(4)
    // Readings kept asking, so a judge connected mid-turn would be used.
    expect(asked).toBeGreaterThanOrEqual(2)
    expect(unjudged).toEqual(["unconfigured"])
  })

  test("a judge that is set up but failing is journaled for every reading", async () => {
    const { asked, unjudged } = await supervise(
      new Evaluator.EvaluatorError({ code: "refused", status: 503, message: "gateway down" })
    )
    expect(unjudged.filter((reason) => reason === "refused")).toHaveLength(asked)
  })
})

describe("Host.run judge failure copy", () => {
  test.each(
    [
      ["missing gateway key and Luna opt-in", false, "Luna is not opted in."],
      ["missing Codex login after opt-in", true, "Luna needs a ChatGPT login."]
    ] as const
  )("shows %s on the worker failure card", async (_, optIn, expected) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-judge-failure-"))
    roots.push(cwd)
    const codexHome = join(cwd, "codex")
    mkdirSync(codexHome)
    if (!optIn) {
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: { access_token: "fixture-session", refresh_token: "fixture-refresh" }
        })
      )
    }
    const host = Host.make({
      cwd,
      environment: {
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: "provider-key-must-not-judge",
        ...(optIn ? { SMITHERS_OPENAI_AUTH: "chatgpt" } : {})
      }
    })
    try {
      const outcome = await host.run({
        prompt: "answer",
        role: "worker",
        seat: `replay:${doneReplay(cwd)}`,
        history: [],
        onEvent: () => {}
      }).done
      expect(outcome._tag).toBe("failed")
      if (outcome._tag !== "failed") return
      const card = FailureCopy.describe(outcome.error)
      expect(card.fault).toBe("policy")
      expect(card.line).toContain(expected)
      expect(card.line).toContain("AI_GATEWAY_API_KEY")
      expect(card.line).toContain("codex login")
      expect(card.line).not.toContain("did not answer")
      expect(card.line).not.toContain("provider-key-must-not-judge")
    } finally {
      await host.dispose()
    }
  })

  test("shows a subscription usage limit with its reset on the worker failure card", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-judge-limit-"))
    roots.push(cwd)
    const resetAtEpochMillis = Date.UTC(2026, 8, 30, 21)
    const judge = Evaluator.layerFromSeat({
      modelId: "fixture/judge",
      model: Model.make({
        stream: () =>
          Stream.fail(
            new ModelError({
              code: "rate_limited",
              resetAtEpochMillis,
              message: "private account diagnostic"
            })
          )
      })
    })
    const host = Host.make({ cwd, environment: {}, judge })
    try {
      const outcome = await host.run({
        prompt: "answer",
        role: "worker",
        seat: `replay:${doneReplay(cwd)}`,
        history: [],
        onEvent: () => {}
      }).done
      expect(outcome._tag).toBe("failed")
      if (outcome._tag !== "failed") return
      const card = FailureCopy.describe(outcome.error)
      expect(card.line).toContain("usage limit")
      expect(card.line).toContain("2026-09-30T21:00:00.000Z")
      expect(card.line).not.toContain("private account diagnostic")
      expect(card.line).not.toContain("did not answer")
    } finally {
      await host.dispose()
    }
  })
})

describe("Host.run instructions", () => {
  const unrelated = "- Deploy the docs site with wrangler.\n"
  const text = `# Rules\n\n- Answer briefly.\n${unrelated}`
  /** Jev withholds the deploy bullet, keeps every other item, and lets the answer stand. */
  const jev = (asked: Array<string>) =>
    Evaluator.layerScripted((request) => {
      // The worker's opening `memory` call: nothing in this directory is needed.
      if (Object.keys(request.questions).every((id) => /^(needed|descend)_/.test(id))) {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability: 0.05 }]))
      }
      if (!Object.keys(request.questions).some((id) => id.startsWith("unnecessary_"))) {
        return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
      }
      const items = (request.state as { readonly items: ReadonlyArray<{ readonly id: string; readonly text: string }> })
        .items
      asked.push(...items.map((item) => item.id))
      return Object.fromEntries(
        items.map((item, index) => [`unnecessary_${index}`, { probability: item.text === unrelated ? 0.95 : 0.1 }])
      )
    })
  const run = async (role: "coordinator" | "worker") => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-instructions-"))
    roots.push(cwd)
    writeFileSync(join(cwd, "AGENTS.md"), text)
    const asked: Array<string> = []
    const host = Host.make({ cwd, environment: {}, judge: jev(asked) })
    const events: Array<AgentEvent.AgentEvent> = []
    try {
      const outcome = await host.run({
        prompt: "answer",
        role,
        runtime: { publish: () => {}, delegate: () => ({}), wait: () => Promise.resolve([]) },
        seat: `replay:${doneReplay(cwd)}`,
        history: [],
        onEvent: (event) => events.push(event)
      }).done
      const opening = events.find((event) => event._tag === "model-requested" && event.frame === 0)
      const system = opening?._tag === "model-requested"
        ? opening.request.system.map((part) => part.text).join("\n")
        : ""
      return { cwd, outcome, asked, events, system }
    } finally {
      await host.dispose()
    }
  }

  test("a judged worker withholds a bullet its task does not need and never judges pinned flows", async () => {
    const { asked, cwd, events, outcome, system } = await run("worker")
    expect(outcome._tag).toBe("done")
    const chunk = `${join(cwd, "AGENTS.md")}#2`
    expect(asked).toContain(chunk)
    for (const pinned of ["ui.publish", "agent.delegate", "agent.wait", "jev", "read", "bash"]) {
      expect(asked).not.toContain(pinned)
    }
    const settled = events.find((event) => event._tag === "relevance-settled")
    expect(settled?._tag === "relevance-settled" && settled.withheld.map((item) => item.id)).toEqual([chunk])
    expect(system).toContain("- Answer briefly.")
    expect(system).not.toContain("wrangler")
  })

  test("the coordinator is never judged and sees every file whole", async () => {
    const { asked, cwd, events, system } = await run("coordinator")
    expect(asked).toEqual([])
    expect(events.some((event) => event._tag === "relevance-settled")).toBe(false)
    expect(system).toContain(
      `<project_instructions path="${join(cwd, "AGENTS.md")}">\n${text}\n</project_instructions>`
    )
  })
})

describe("Host.run compaction", () => {
  // A worker that prints bulk each frame until its context is compacted, then answers.
  const compacting = async (judge: Layer.Layer<Evaluator.Evaluator>) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-compact-"))
    roots.push(cwd)
    const events: Array<AgentEvent.AgentEvent> = []
    let frame = 0
    const text = (body: string) =>
      Stream.fromIterable(
        [
          { type: "text-start", id: "reply" },
          { type: "text-delta", id: "reply", text: body },
          { type: "text-end", id: "reply" },
          { type: "settle", stopReason: "stop" }
        ] as unknown as ReadonlyArray<ModelEvent.ModelEvent>
      )
    const model = Model.make({
      stream: (request) => {
        if (request.system.some((part) => part.text === Compaction.summaryInstruction)) {
          return text("Summary: the worker printed bulk.")
        }
        frame += 1
        const settled = events.some((event) => event._tag === "compaction-settled")
        return text(
          "```cell\n" +
            (settled ? `ctx.done("ok")` : `console.log(${JSON.stringify(`${frame} ${"bulk ".repeat(3_000)}`)})`) +
            "\n```"
        )
      }
    })
    const seats = SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({
            id,
            modelId: id,
            model,
            route: {
              prepare: () =>
                Effect.succeed({
                  routeId: "compact-test",
                  protocolId: "compact-test",
                  method: "POST" as const,
                  url: "https://compact.invalid/",
                  publicHeaders: {},
                  body: new Uint8Array(),
                  bodyText: ""
                })
            },
            contextWindowTokens: 40_000
          })
        )
    })
    const host = Host.make({ cwd, environment: {}, judge, approvals: "all", seats })
    try {
      const outcome = await host.run({
        prompt: "Print bulk.",
        role: "worker",
        seat: "bulk",
        history: [],
        onEvent: (event) => events.push(event)
      }).done
      return { outcome, events }
    } finally {
      await host.dispose()
    }
  }

  test("a judged worker compacts through CellTurn marks once it crosses its window", async () => {
    const { events, outcome } = await compacting(ScriptedJudge.layerAll)
    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    const settled = events.filter((event): event is AgentEvent.CompactionSettled => event._tag === "compaction-settled")
    expect(settled.length).toBeGreaterThan(0)
    expect(settled[0]!.causes).toContain("budget")
    expect(settled[0]!.marks?.length).toBeGreaterThan(0)
    expect(settled[0]!.unaligned).toBeUndefined()
    expect(
      events.some((event) => event._tag === "decision-settled" && event.classifier === "compaction/marks")
    ).toBe(true)
    expect(events.some((event) => event._tag === "decision-unjudged")).toBe(false)
  })

  test("a failed marks reading journals decision-unjudged and squashes into the summary", async () => {
    const unreachable = Layer.effect(
      Evaluator.Evaluator,
      Effect.gen(function*() {
        const inner = yield* Evaluator.Evaluator
        return {
          evaluate: (request: Evaluator.Request) =>
            Object.hasOwn(request.questions, "remove_0")
              ? Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "No judge" }))
              : inner.evaluate(request)
        }
      })
    ).pipe(Layer.provide(ScriptedJudge.layerAll))
    const { events, outcome } = await compacting(unreachable)
    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    expect(
      events.filter((event) => event._tag === "decision-unjudged" && event.classifier === "compaction/marks").length
    ).toBeGreaterThan(0)
    const settled = events.find((event): event is AgentEvent.CompactionSettled => event._tag === "compaction-settled")
    expect(settled?.marks).toBeUndefined()
    expect(settled?.summary).toBeDefined()
  })
})

describe("Host.run seat routing", () => {
  const make = (judged: boolean, extra: Readonly<Record<string, string>> = {}) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-route-"))
    roots.push(cwd)
    // An empty codex home: the candidates come from this key alone, never the machine's login.
    const environment = { OPENAI_API_KEY: "sk-test", CODEX_HOME: join(cwd, "codex") }
    return {
      cwd,
      host: Host.make({
        cwd,
        environment: { ...environment, ...extra },
        ...(judged ? { judge: ScriptedJudge.layerAll } : {})
      })
    }
  }
  const systemOf = async (host: Host.Host, cwd: string, variant: string) => {
    const systems: Array<string> = []
    try {
      const outcome = await host.run({
        prompt: "answer",
        role: "worker",
        seat: `replay:${doneReplay(cwd)}`,
        variant,
        history: [],
        onEvent: (event) => {
          if (event._tag === "model-requested") systems.push(event.request.system.map((part) => part.text).join("\n"))
        }
      }).done
      return { outcome, systems }
    } finally {
      await host.dispose()
    }
  }

  test("an auto worker journals seat-routed and decision-settled through onEvent and reports the seat", async () => {
    const { host } = make(true, { ANTHROPIC_API_KEY: "sk-ant-test" })
    const events: Array<AgentEvent.AgentEvent> = []
    const seats: Array<{ seat: string; backups: ReadonlyArray<string>; variant: string | null }> = []
    try {
      expect(host.routes).toBe(true)
      const turn: Host.Turn = host.run({
        prompt: "Look around.",
        role: "worker",
        seat: Seat.auto,
        history: [],
        onSeat: (seat) => seats.push(seat),
        onEvent: (event) => {
          events.push(event)
          // Routing is what is under test; the routed provider is never called.
          if (event._tag === "decision-settled") turn.cancel()
        }
      })
      expect(await turn.done).toEqual({ _tag: "cancelled" })
    } finally {
      await host.dispose()
    }
    const routed = events.find((event) => event._tag === "seat-routed")
    expect(routed?._tag === "seat-routed" && [routed.declared, routed.seat, routed.decidedBy, routed.modelId])
      .toEqual([Seat.auto, "opus", "jev", "claude-opus-5-5"])
    // The routing graph's pick for a simple, clear task that is none of the named phases, with its backup.
    expect(routed?._tag === "seat-routed" && routed.backups).toEqual(["sol"])
    expect(routed?._tag === "seat-routed" && routed.candidates).toEqual([
      "luna",
      "sol",
      "opus",
      "fable",
      "sonnet"
    ])
    // The system-prompt variant is picked in the same call.
    expect(routed?._tag === "seat-routed" && routed.variant).toBe("investigate")
    const decision = events.find((event) => event._tag === "decision-settled")
    expect(decision?._tag === "decision-settled" && decision.classifier).toBe("seat/route")
    expect(seats).toEqual([{ seat: "opus", backups: ["sol"], variant: "investigate" }])
  })

  test("a worker routed to a panel runs each member, then the merger on their answers", async () => {
    const { cwd, host } = make(true)
    const replay = (name: string, answer: string) => {
      const directory = join(cwd, name)
      mkdirSync(directory)
      return `replay:${doneReplay(directory, `ctx.done(${JSON.stringify(answer)})`)}`
    }
    const first = replay("first", "first answer")
    const second = replay("second", "second answer")
    const merger = replay("merger", "merged answer")
    const requests: Array<string> = []
    try {
      const outcome = await host.run({
        prompt: "Review the change.",
        role: "worker",
        seat: merger,
        // A resumed panel route; the last member's seat does not resolve here.
        route: {
          backups: [],
          panel: {
            seats: [
              { seat: first, backups: [] },
              { seat: second, backups: [] },
              { seat: "nowhere:model", backups: [] }
            ],
            merger
          }
        },
        history: [],
        onEvent: (event) => {
          // The replay's own recorded request rows carry no request.
          if (event._tag === "model-requested" && event.request !== undefined) {
            requests.push(
              [...event.request.system.map((part) => part.text), JSON.stringify(event.request.messages)].join("\n")
            )
          }
        }
      }).done
      expect(outcome).toEqual({ _tag: "done", answer: "merged answer" })
    } finally {
      await host.dispose()
    }
    // Only the merger's run reaches the tab; it was asked with both answers and the failed seat.
    expect(requests.every((request) => request.includes("Independent answers"))).toBe(true)
    const merge = requests.find((request) => request.includes("Independent answers"))!
    expect(merge).toContain(`${first}: first answer`)
    expect(merge).toContain(`${second}: second answer`)
    expect(merge).toContain("These seats failed and gave no answer: nowhere:model.")
  })

  test("a retried or resumed worker is given its routed variant on its routed seat", async () => {
    const { cwd, host } = make(true)
    const { outcome, systems } = await systemOf(host, cwd, "investigate")
    expect(outcome._tag).toBe("done")
    expect(systems[0]).toContain("Change nothing.")
  })

  test("a carried variant the catalog does not offer fails typed, before any model call", async () => {
    // A pinned worker seat leaves the host with no catalog, so no variant is offered.
    for (const routed of [true, false]) {
      const { cwd, host } = make(routed, routed ? {} : { SMITHERS_TUI_WORKER_SEAT: "sol" })
      const { outcome, systems } = await systemOf(host, cwd, routed ? "retired" : "investigate")
      expect(outcome._tag === "failed" && outcome.error).toBeInstanceOf(Seat.SeatUnrouted)
      expect(systems).toEqual([])
    }
  })

  test("an auto worker on a host that does not route fails typed, never on a default seat", async () => {
    const { host } = make(false, { SMITHERS_TUI_WORKER_SEAT: "sol" })
    const seats: Array<{ seat: string; variant: string | null }> = []
    try {
      expect(host.routes).toBe(false)
      const outcome = await host.run({
        prompt: "Look around.",
        role: "worker",
        seat: Seat.auto,
        history: [],
        onSeat: (seat) => seats.push(seat),
        onEvent: () => {}
      }).done
      expect(outcome._tag === "failed" && outcome.error).toBeInstanceOf(Seat.SeatUnrouted)
    } finally {
      await host.dispose()
    }
    expect(seats).toEqual([])
  })

  test("an auto worker whose judge does not answer fails typed, and its card says no model was chosen", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-route-"))
    roots.push(cwd)
    const host = Host.make({
      cwd,
      environment: { OPENAI_API_KEY: "sk-test", CODEX_HOME: join(cwd, "codex") },
      judge: Evaluator.layerUnavailable()
    })
    try {
      expect(host.routes).toBe(true)
      const outcome = await host.run({
        prompt: "Look around.",
        role: "worker",
        seat: Seat.auto,
        history: [],
        onEvent: () => {}
      }).done
      const error = outcome._tag === "failed" ? outcome.error : undefined
      expect(error).toBeInstanceOf(Seat.SeatUnrouted)
      expect(FailureCopy.describe(error)).toMatchObject({
        headline: "Model could not be chosen",
        fault: "dependency",
        actions: ["switch-model", "resume", "details"]
      })
    } finally {
      await host.dispose()
    }
  })

  test("a judged worker is taught the operator's stance, and a stance that is neither refuses the host", async () => {
    const { cwd, host } = make(true, { SMITHERS_SUPERVISOR_STANCE: "paranoid" })
    const events: Array<AgentEvent.AgentEvent> = []
    try {
      await host.run({
        prompt: "answer",
        role: "worker",
        seat: `replay:${doneReplay(cwd)}`,
        history: [],
        onEvent: (event) => events.push(event)
      }).done
    } finally {
      await host.dispose()
    }
    const armed = events.find((event) => event._tag === "discipline-armed")
    expect(armed?._tag === "discipline-armed" && armed.stance).toBe("paranoid")
    expect(() => make(true, { SMITHERS_SUPERVISOR_STANCE: "calm" })).toThrow("SMITHERS_SUPERVISOR_STANCE")
  })

  test("a routing coordinator is taught the worker seat is auto", async () => {
    const { cwd, host } = make(true)
    const systems: Array<string> = []
    try {
      await host.run({
        prompt: "answer",
        role: "coordinator",
        seat: `replay:${doneReplay(cwd)}`,
        workerSeat: "openai:gpt-6-sol",
        history: [],
        onEvent: (event) => {
          if (event._tag === "model-requested") systems.push(event.request.system.map((part) => part.text).join("\n"))
        }
      }).done
    } finally {
      await host.dispose()
    }
    expect(systems[0]).toContain(Runtime.coordinatorTeaching + Seat.auto)
  })
})

for (const role of ["coordinator", "worker"] as const) {
  test(`Host.run stops a ${role} at its token budget with a budget failure`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-budget-"))
    roots.push(cwd)
    const file = join(cwd, "spend.jsonl")
    const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
    // Every reply costs 600 tokens and never finishes, so only the ceiling stops it.
    writeFileSync(
      file,
      [
        JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
        delta({ type: "text-start", id: "cell" }),
        delta({ type: "text-delta", id: "cell", text: "```cell\nconst spent = 1\n```" }),
        delta({ type: "text-end", id: "cell" }),
        delta({ type: "usage", inputTokens: 500, outputTokens: 100, totalTokens: 600 }),
        JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
      ].join("\n")
    )
    const host = Host.make({ cwd, environment: {}, budget: { tokens: { max: 1000 } } })
    const events: Array<AgentEvent.AgentEvent> = []
    try {
      const outcome = await host.run({
        prompt: "spend",
        role,
        seat: `replay:${file}`,
        history: [],
        onEvent: (event) => events.push(event)
      }).done
      expect(events.filter((event) => event._tag === "cell-settled")).toHaveLength(1)
      expect(outcome._tag).toBe("failed")
      if (outcome._tag !== "failed") throw new Error(`Expected a failed ${role} turn`)
      expect(outcome.message).toBe("Token budget reached")
      expect(outcome.detail).toContain("600 of its 1000 approved tokens")
      const failure = FailureCopy.describe(outcome.error)
      expect(failure).toEqual({
        headline: "Token budget reached",
        fault: "policy",
        line: "600 of 1000 tokens used.",
        actions: ["resume", "details"]
      })
    } finally {
      await host.dispose()
    }
  })
}

test("Host.run gives a worker the cap the person raised, in place of the host's own", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-budget-"))
  roots.push(cwd)
  const file = join(cwd, "spend.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-start", id: "cell" }),
      delta({ type: "text-delta", id: "cell", text: "```cell\nconst spent = 1\n```" }),
      delta({ type: "text-end", id: "cell" }),
      delta({ type: "usage", inputTokens: 500, outputTokens: 100, totalTokens: 600 }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ].join("\n")
  )
  const host = Host.make({ cwd, environment: {}, budget: { tokens: { max: 1000 } } })
  expect(host.runCap).toBe(1000)
  const events: Array<AgentEvent.AgentEvent> = []
  try {
    const outcome = await host.run({
      prompt: "spend",
      role: "worker",
      seat: `replay:${file}`,
      history: [],
      caps: { times: 2 },
      onEvent: (event) => events.push(event)
    }).done
    expect(events.filter((event) => event._tag === "cell-settled").length).toBeGreaterThan(1)
    if (outcome._tag !== "failed") throw new Error("Expected the raised cap to stop the worker")
    expect(outcome.detail).toContain("of its 2000 approved tokens")
  } finally {
    await host.dispose()
  }
})

describe("default caps through the host", () => {
  const today = () => new Date().toISOString().slice(0, 10)

  test("a run under both caps is unaffected and is written to the ledger", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-caps-"))
    roots.push(cwd)
    const ledger = Spend.ledger(join(cwd, "spend"))
    const host = Host.make({
      cwd,
      environment: {},
      budget: { tokens: { max: 1000 }, daily: { max: 5000 } },
      ledger,
      judge: ScriptedJudge.layer
    })
    const alerts: Array<string> = []
    const stop = Log.subscribe((message) => alerts.push(message))
    try {
      const replay = join(cwd, "spend.jsonl")
      const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
      writeFileSync(
        replay,
        [
          JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
          delta({ type: "text-start", id: "cell" }),
          delta({ type: "text-delta", id: "cell", text: "```cell\nctx.done(\"ok\")\n```" }),
          delta({ type: "text-end", id: "cell" }),
          delta({ type: "usage", inputTokens: 200, outputTokens: 100, totalTokens: 300 }),
          JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
        ].join("\n")
      )
      const outcome = await host.run({
        prompt: "hello",
        seat: `replay:${replay}`,
        history: [],
        onEvent: () => {}
      }).done
      expect(outcome).toEqual({ _tag: "done", answer: "ok" })
      expect(alerts).toEqual([])
      expect(await Effect.runPromise(ledger.total(today()))).toBeGreaterThanOrEqual(300)
    } finally {
      stop()
      await host.dispose()
    }
  })

  for (const role of ["coordinator", "worker"] as const) {
    test(`a crossed daily cap stops a ${role} and raises a loud notice naming cap, run and spend`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-daily-"))
      roots.push(cwd)
      const ledger = Spend.ledger(join(cwd, "spend"))
      // Another run already spent the whole day.
      await Effect.runPromise(ledger.record({ day: today(), runId: "earlier", stepKey: "s", spent: 5000 }))
      const host = Host.make({
        cwd,
        environment: {},
        budget: { daily: { max: 5000 } },
        ledger,
        judge: ScriptedJudge.layer
      })
      const alerts: Array<string> = []
      const stop = Log.subscribe((message) => alerts.push(message))
      try {
        const outcome = await host.run({
          prompt: "hello",
          role,
          seat: `replay:${doneReplay(cwd)}`,
          history: [],
          onEvent: () => {}
        }).done
        expect(outcome._tag).toBe("failed")
        if (outcome._tag !== "failed") throw new Error("expected a failure")
        expect(outcome.message).toBe("Daily token cap reached")
        expect(FailureCopy.describe(outcome.error)).toEqual({
          headline: "Daily token cap reached",
          fault: "policy",
          line: "5000 of 5000 tokens used today.",
          actions: ["resume", "details"]
        })
        expect(alerts).toHaveLength(1)
        expect(alerts[0]).toMatch(
          new RegExp(
            `^Daily token cap reached: 5,000 of 5,000 tokens used today, stopped at ${role} tui-[0-9a-f]{8}-1\\.`
          )
        )
        expect(alerts[0]).toContain("--budget-daily-tokens")
      } finally {
        stop()
        await host.dispose()
      }
    })
  }

  test("a per-run cap raises its own notice, and other failures raise none", () => {
    const exceeded = (scope: string) => ({
      _tag: "flows/agent/BudgetExceeded",
      scope,
      onExceeded: "fail",
      used: 1234567,
      max: 1000000,
      next: 1,
      message: "m"
    })
    expect(Host.capNotice({ cause: exceeded("tokens") }, "worker tui-x-2")).toBe(
      "Run token cap reached: 1,234,567 of 1,000,000 tokens used by worker tui-x-2. Something may be looping. Raise --budget-tokens to resume."
    )
    expect(Host.capNotice({ _tag: "flows/agent/Skipped", budget: exceeded("tokens") }, "r")).toContain("Run token cap")
    expect(Host.capNotice(exceeded("latency"), "r")).toBeUndefined()
    expect(Host.capNotice(new Error("boom"), "r")).toBeUndefined()
    expect(Host.capNotice(undefined, "r")).toBeUndefined()
  })
})

describe("Host.run with a box", () => {
  const placedRun = async (cwd: string, cell: string, box?: Host.Box) => {
    const host = Host.make({
      cwd,
      environment: {},
      judge: ScriptedJudge.layer,
      approvals: "all",
      ...(box ? { box } : {})
    })
    const events: Array<AgentEvent.AgentEvent> = []
    try {
      const outcome = await host.run({
        prompt: "place",
        role: "worker",
        seat: `replay:${doneReplay(cwd, cell)}`,
        history: [],
        onEvent: (event) => events.push(event)
      }).done
      return { outcome, events }
    } finally {
      await host.dispose()
    }
  }
  const scratch = (prefix: string) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    roots.push(directory)
    return directory
  }
  const calls = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
    events.flatMap((event) => (event._tag === "cell-call-started" ? [event.call] : []))
  const settled = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
    events.flatMap((event) => (event._tag === "cell-call-settled" ? [event] : []))

  test("runs bash in the box's workdir, writes nothing to cwd, and records the call a local run records", async () => {
    const cwd = scratch("tui-box-cwd-")
    const workdir = scratch("tui-box-workdir-")
    const cell = "const shell = await ctx.call(\"bash\", { command: \"pwd -P && echo placed > placed.txt\" }); " +
      "ctx.done(shell.stdout.trim())"
    const placed = await placedRun(cwd, cell, { name: "test-box", workdir, prefix: () => Promise.resolve([]) })

    expect(placed.outcome).toEqual({ _tag: "done", answer: workdir })
    expect(readFileSync(join(workdir, "placed.txt"), "utf8")).toBe("placed\n")
    expect(existsSync(join(cwd, "placed.txt"))).toBe(false)

    const local = await placedRun(cwd, cell)
    expect(local.outcome).toEqual({ _tag: "done", answer: cwd })
    // The durable call (its identity, input and effects: the key material) is the same wherever it ran.
    expect(calls(placed.events)).toEqual(calls(local.events))
    // The laptop tree never moves, so observing it would hand the claim back for another frame.
    expect(calls(placed.events).length).toBe(1)
    expect(basis(placed.events)).not.toContain("observed")
    const shape = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
      settled(events).map(({ result, ...rest }) => ({
        ...rest,
        result: { ...result, value: { ...(result as { value: object }).value, stdout: "" } }
      }))
    expect(shape(placed.events)).toEqual(shape(local.events))
  })

  test("tells a placed worker the box's workdir and rules, never this tree's, and offers no walking search", async () => {
    const cwd = scratch("tui-box-context-cwd-")
    const workdir = scratch("tui-box-context-workdir-")
    writeFileSync(join(cwd, "AGENTS.md"), "# Local rule\n\n- Only this laptop's tree.\n")
    writeFileSync(join(workdir, "AGENTS.md"), "# Box rule\n\n- Only the box checkout.\n")
    const { events } = await placedRun(cwd, "ctx.done(\"ok\")", {
      name: "test-box",
      workdir,
      prefix: () => Promise.resolve([])
    })
    const opening = events.find((event) => event._tag === "model-requested" && event.frame === 0)
    const request = opening?._tag === "model-requested" ? opening.request : undefined
    const system = request?.system.map((part) => part.text).join("\n") ?? ""
    expect(system).toContain(`You are a coding agent working in ${workdir}.`)
    expect(system).toContain("Your filesystem and shell flows run on test-box, not on this machine.")
    expect(system).not.toContain("Only this laptop's tree.")
    expect(system).toContain("- Only the box checkout.")
    expect(system).toContain("\n- bash (irreversible)")
    expect(system).toContain("\n- read (sealed)")
    expect(system).not.toMatch(/\n- (grep|glob) \(/)
  })

  test("an unreachable box fails the call, the turn goes on, and the next call reaches it", async () => {
    const cwd = scratch("tui-box-fault-cwd-")
    const workdir = scratch("tui-box-fault-workdir-")
    const fault = join(workdir, "fault")
    const prefix = () => {
      if (!existsSync(fault)) return Promise.resolve([])
      rmSync(fault)
      return Promise.reject(new Error("workspace not running"))
    }
    const cell = [
      "await ctx.call(\"bash\", { command: \"touch fault\" })",
      "const lost = await ctx.call(\"bash\", { command: \"echo lost\" })",
      "const back = await ctx.call(\"bash\", { command: \"echo back\" })",
      "ctx.done(back.stdout.trim())"
    ].join("; ")
    const { outcome, events } = await placedRun(cwd, cell, { name: "test-box", workdir, prefix })

    expect(outcome).toMatchObject({ _tag: "done", answer: expect.stringContaining("back") })
    const results = settled(events).slice(0, 3).map((event) => event.result)
    expect(results.map((result) => result.outcome)).toEqual(["success", "failure", "success"])
    expect(results[1]).toMatchObject({ code: "flow_failed" })
  })

  test("a box whose rules read exits non-zero fails the turn rather than running without them", async () => {
    const cwd = scratch("tui-box-rules-exit-cwd-")
    const workdir = scratch("tui-box-rules-exit-workdir-")
    // The session opens (probe, prepare); the rules read's transport then exits 255, as a lost ssh does.
    let calls = 0
    const { outcome } = await placedRun(cwd, "ctx.done(\"never\")", {
      name: "rules-exit-box",
      workdir,
      prefix: () => Promise.resolve(++calls <= 2 ? [] : ["/bin/sh", "-c", "exit 255", "lost"])
    })
    expect(outcome).toMatchObject({ _tag: "failed" })
    expect((outcome as { message: string }).message).toContain("rules-exit-box could not read its rules: exit 255")
  })

  test("a box that cannot read its own rules fails the turn rather than dropping them", async () => {
    const cwd = scratch("tui-box-rules-cwd-")
    const workdir = scratch("tui-box-rules-workdir-")
    // The session opens (probe, prepare); the next command, the rules read, cannot reach the box.
    let calls = 0
    const { outcome } = await placedRun(cwd, "ctx.done(\"never\")", {
      name: "rules-box",
      workdir,
      prefix: () => ++calls <= 2 ? Promise.resolve([]) : Promise.reject(new Error("503 from the workspace API"))
    })
    expect(outcome).toMatchObject({ _tag: "failed" })
    expect((outcome as { message: string }).message).toContain(
      "rules-box could not be reached: 503 from the workspace API"
    )
  })

  test("a box that cannot be reached at all fails the turn with the box's name, not a hang", async () => {
    const cwd = scratch("tui-box-gone-")
    const { outcome } = await placedRun(cwd, "ctx.done(\"never\")", {
      name: "gone-box",
      workdir: "/home/developer/workspace",
      prefix: () => Promise.reject(new Error("403 forbidden"))
    })
    expect(outcome).toMatchObject({ _tag: "failed" })
    expect((outcome as { message: string }).message).toContain("gone-box could not be reached: 403 forbidden")
  })
})

describe("Host.run memory", () => {
  /**
   * Jev keeps `needed.ts` and nothing else. Every other reading passes, except
   * that with `withhold` the run-start relevance reading calls every item
   * unnecessary.
   */
  const judge = (asked: Array<string>, withhold: boolean) =>
    Evaluator.layerScripted((request) => {
      const ids = Object.keys(request.questions)
      if (ids.every((id) => /^(needed|descend)_/.test(id))) {
        const items =
          (request.state as { readonly items: ReadonlyArray<{ readonly id?: string; readonly path?: string }> })
            .items
        asked.push(...items.map((item) => item.id ?? item.path ?? ""))
        return Object.fromEntries(
          ids.map((id) => [id, { probability: items[Number(id.split("_")[1])]?.id === "needed.ts" ? 0.9 : 0.05 }])
        )
      }
      return Object.fromEntries(
        ids.map((id) => [id, {
          probability: id.startsWith("complete") || (withhold && id.startsWith("unnecessary_")) ? 0.99 : 0.01
        }])
      )
    })
  const run = async (role: "coordinator" | "worker", cell: string, withhold = false, agent?: Agents.Profile) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-memory-"))
    roots.push(cwd)
    writeFileSync(join(cwd, "needed.ts"), "export const needed = 1\n")
    writeFileSync(join(cwd, "other.ts"), "export const other = 2\n")
    const asked: Array<string> = []
    const host = Host.make({ cwd, environment: {}, judge: judge(asked, withhold) })
    const events: Array<AgentEvent.AgentEvent> = []
    try {
      const outcome = await host.run({
        prompt: "Change the needed constant",
        role,
        ...(role === "coordinator"
          ? { runtime: { publish: () => {}, delegate: () => ({}), wait: () => Promise.resolve([]) } }
          : {}),
        seat: `replay:${doneReplay(cwd, cell)}`,
        history: [],
        ...(agent === undefined ? {} : { agent }),
        onEvent: (event) => events.push(event)
      }).done
      const requests = events.flatMap((event) => event._tag === "model-requested" ? [event.request] : [])
      return { asked, events, outcome, requests }
    } finally {
      await host.dispose()
    }
  }

  test("a worker opens with the files Jev chose and calls memory from a cell", async () => {
    const { asked, events, outcome, requests } = await run(
      "worker",
      `const m = await ctx.call("memory", { task: "Change the needed constant" })\nctx.done(m.kept.map((item) => item.id).join(","))`
    )
    expect(outcome).toEqual({ _tag: "done", answer: "needed.ts" })
    expect(asked).toContain("needed.ts")
    const system = requests[0]!.system.map((part) => part.text).join("\n")
    expect(system).toContain("<flows_memory_context>")
    expect(system).toContain("export const needed = 1")
    expect(system).not.toContain("export const other = 2")
    const settled = events.find((event) => event._tag === "cell-call-settled" && event.flowName === "memory")
    expect(settled?._tag === "cell-call-settled" && settled.result.outcome).toBe("success")
    expect(events.some((event) => event._tag === "decision-unjudged" && event.classifier.startsWith("memory/")))
      .toBe(false)
    expect(events.some((event) => event._tag === "supervisor-memory-failed" && event.operation === "recall"))
      .toBe(false)
    expect(
      events.reduce((current, event, at) => Transcript.apply(current, event, at), Transcript.empty).items
        .some((item) => item.kind === "note" && item.text === "→ memory unavailable")
    ).toBe(false)
  })

  test("memory stays callable when the run-start reading withholds everything it can", async () => {
    const { events, outcome, requests } = await run(
      "worker",
      `const m = await ctx.call("memory", { task: "Change the needed constant" })\nctx.done(m.kept.map((item) => item.id).join(","))`,
      true
    )
    // The reading withheld the opening memory rows it was asked about...
    expect(requests[0]!.system.map((part) => part.text).join("\n")).not.toContain("export const needed = 1")
    const withheld = events.flatMap((event) => event._tag === "relevance-settled" ? event.withheld : [])
    expect(withheld.length).toBeGreaterThan(0)
    expect(withheld.map((item) => item.id)).not.toContain("memory")
    // ...but never the memory flow, so the later call still selects.
    expect(outcome).toEqual({ _tag: "done", answer: "needed.ts" })
    const settled = events.find((event) => event._tag === "cell-call-settled" && event.flowName === "memory")
    expect(settled?._tag === "cell-call-settled" && settled.result.outcome).toBe("success")
  })

  test("shows one unavailable memory row when the opening judge cannot be reached", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-memory-"))
    roots.push(cwd)
    writeFileSync(join(cwd, "needed.ts"), "export const needed = 1\n")
    const host = Host.make({ cwd, environment: {}, judge: Evaluator.layerUnavailable() })
    const events: Array<AgentEvent.AgentEvent> = []
    try {
      await host.run({
        prompt: "Change needed.ts",
        role: "worker",
        seat: `replay:${doneReplay(cwd)}`,
        history: [],
        onEvent: (event) => events.push(event)
      }).done
      const unavailable = events.filter((event) =>
        event._tag === "decision-unjudged" && event.classifier.startsWith("memory/")
      )
      expect(unavailable).toMatchObject([{ reason: "unreachable", scope: expect.any(String), frame: 0 }])
      expect(events.indexOf(unavailable[0]!)).toBeLessThan(
        events.findIndex((event) => event._tag === "model-requested")
      )
      const transcript = events.reduce(
        (current, event, at) => Transcript.apply(current, event, at),
        Transcript.empty
      )
      expect(
        Timeline.rows(transcript).filter((row) => row.item.kind === "note" && row.item.text === "→ memory unavailable")
      )
        .toHaveLength(1)
      expect(
        Subagents.lines(Timeline.rows(transcript), []).filter((line) =>
          line.kind === "row" && line.row.item.kind === "note" && line.row.item.text === "→ memory unavailable"
        )
      )
        .toHaveLength(1)
      expect(transcript.items.filter((item) => item.kind === "note" && item.text.startsWith("→ memory ")))
        .toHaveLength(1)

      const writer = Session.create(cwd, "worker")
      roots.push(Session.directory(cwd))
      writer.append({ type: "user", at: 0, text: "Change needed.ts" })
      for (const event of unavailable) writer.append({ type: "event", at: 1, event })
      const restored = Session.restore(Session.load(writer.file)).transcript
      expect(
        Timeline.rows(restored).filter((row) => row.item.kind === "note" && row.item.text === "→ memory unavailable")
      )
        .toHaveLength(1)
    } finally {
      await host.dispose()
    }
  })

  test("records a failed memory opening before ending the worker", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-memory-"))
    roots.push(cwd)
    writeFileSync(join(cwd, "needed.ts"), "export const needed = 1\n")
    const host = Host.make({
      cwd,
      environment: {},
      judge: Evaluator.layerScripted(() => ({ complete: { probability: 0.99 } }))
    })
    const events: Array<AgentEvent.AgentEvent> = []
    try {
      const outcome = await host.run({
        prompt: "Change needed.ts",
        role: "worker",
        seat: `replay:${doneReplay(cwd)}`,
        history: [],
        onEvent: (event) => events.push(event)
      }).done
      expect(outcome._tag).toBe("failed")
      const openingFailure = events.filter((event) =>
        event._tag === "supervisor-memory-failed" && event.operation === "recall" && event.frame === 0
      )
      expect(openingFailure).toHaveLength(1)
      const transcript = events.reduce(
        (current, event, at) => Transcript.apply(current, event, at),
        Transcript.empty
      )
      expect(transcript.items.filter((item) => item.kind === "note" && item.text === "→ memory unavailable"))
        .toHaveLength(1)

      const writer = Session.create(cwd, "worker")
      roots.push(Session.directory(cwd))
      writer.append({ type: "user", at: 0, text: "Change needed.ts" })
      for (const event of openingFailure) writer.append({ type: "event", at: 1, event })
      const restored = Session.restore(Session.load(writer.file)).transcript
      expect(
        Timeline.rows(restored).filter((row) => row.item.kind === "note" && row.item.text === "→ memory unavailable")
      ).toHaveLength(1)
    } finally {
      await host.dispose()
    }
  })

  test("tells a wrapped harness the block Jev chose, with what it kept and left out", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-memory-"))
    roots.push(cwd)
    writeFileSync(join(cwd, "needed.ts"), "export const needed = 1\n")
    writeFileSync(join(cwd, "other.ts"), "export const other = 2\n")
    const host = Host.make({ cwd, environment: {}, judge: judge([], false) })
    try {
      const recalled = await host.memory!("Change the needed constant")
      expect(recalled.text).toContain("export const needed = 1")
      expect(recalled.text).not.toContain("export const other = 2")
      expect(recalled.kept).toBe(1)
      expect(recalled.withheld).toBeGreaterThanOrEqual(1)
      expect(recalled.unjudged).toBeUndefined()
    } finally {
      await host.dispose()
    }
  })

  test("tells a wrapped harness when Jev did not judge its block", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-memory-"))
    roots.push(cwd)
    writeFileSync(join(cwd, "needed.ts"), "export const needed = 1\n")
    writeFileSync(join(cwd, "other.ts"), "export const other = 2\n")
    const down = Evaluator.layerScripted(() =>
      Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "down" }))
    )
    const host = Host.make({ cwd, environment: {}, judge: down })
    try {
      const recalled = await host.memory!("Change needed.ts")
      expect(recalled.text).toContain("export const needed = 1")
      expect(recalled.unjudged?.reason).toBe("unreachable")
    } finally {
      await host.dispose()
    }
  })

  test("a worker whose agent drops the memory flow opens with no memory", async () => {
    const { asked, outcome, requests } = await run("worker", `ctx.done("ok")`, false, {
      name: "reader",
      digest: "d",
      system: "You read.",
      flows: ["read"],
      envelope: ["fs:read:**"]
    })
    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    expect(asked).toEqual([])
    expect(requests[0]!.system.map((part) => part.text).join("\n")).not.toContain("<flows_memory_context>")
  })

  test("a coordinator neither opens with memory nor offers it", async () => {
    const { asked, events, outcome, requests } = await run("coordinator", `ctx.done(String("memory" in ctx.flows))`)
    expect(outcome).toEqual({ _tag: "done", answer: "false" })
    expect(asked).toEqual([])
    expect(requests[0]!.system.map((part) => part.text).join("\n")).not.toContain("<flows_memory_context>")
    expect(events.some((event) => event._tag === "decision-unjudged" && event.classifier.startsWith("memory/")))
      .toBe(false)
    expect(events.some((event) => event._tag === "supervisor-memory-failed" && event.operation === "recall"))
      .toBe(false)
    expect(
      events.reduce((current, event, at) => Transcript.apply(current, event, at), Transcript.empty).items
        .some((item) => item.kind === "note" && item.text === "→ memory unavailable")
    ).toBe(false)
  })
})
