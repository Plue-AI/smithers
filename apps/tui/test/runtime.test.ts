import * as CellPlugin from "@smthrs/agent/CellPlugin"
import * as SmithersPlugin from "@smthrs/agent/SmithersPlugin"
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Agents from "../src/agents.ts"
import * as Changes from "../src/changes.ts"
import type * as Extension from "../src/extension.ts"
import { FlowRuns, interrupted, type Run } from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import * as Models from "../src/models.ts"
import * as Panels from "../src/panels.ts"
import * as Runtime from "../src/runtime.ts"
import * as Session from "../src/session.ts"
import * as Summary from "../src/summary.ts"
import * as Transcript from "../src/transcript.ts"
import { Workspace } from "../src/workspace.ts"

const panel: Panels.Panel = {
  id: "checks",
  title: "Checks",
  summary: "Two checks passed.",
  rows: [{
    id: "test",
    label: "Checked addition",
    status: "done",
    details: [{ kind: "code", code: "assert(add(2, 3) === 5)", language: "javascript" }],
    action: { label: "Run again", prompt: "Run the addition check again" }
  }]
}
const fixture = () =>
  Session.restore(
    readFileSync(join(import.meta.dir, "fixtures/fix-add.jsonl"), "utf8").trim().split("\n").map((line) => ({
      type: "event" as const,
      ...JSON.parse(line)
    }))
  ).transcript

it("summarizes real cells, their code, failures and the answer without dumping source in labels", () => {
  const transcript = fixture()
  const summary = Summary.panel(transcript)
  expect(summary.summary).toMatch(/Fixed/)
  const cells = transcript.items.filter((item) => item.kind === "cell")
  expect(summary.rows.filter((row) => row.details.some((block) => block.kind === "code"))).toHaveLength(cells.length)
  expect(summary.rows.some((row) => /exit 1/.test(row.label))).toBe(true)
  expect(summary.rows.some((row) => /Updated math.js/.test(row.label))).toBe(true)
  expect(summary.rows.some((row) => row.label.includes("ctx.call"))).toBe(false)
  expect(Summary.panel(Transcript.failure(transcript, "Provider unavailable", 99)).summary).toBe(
    "Stopped: Provider unavailable"
  )
  expect(Summary.panel(Transcript.user(transcript, "Now fix subtraction")).summary).toBe(
    "Requested: Now fix subtraction"
  )
})

it("never summarizes a failed delegation as requested, whatever the answer claims", () => {
  const identity = { session: "s", frame: 0, cell: "c", ordinal: 0, declaration: "d", layers: [] }
  const events = [
    { _tag: "cell-produced", cell: { language: "javascript", text: "await ctx.call(\"agent.delegate\", {})" } },
    {
      _tag: "cell-call-started",
      call: {
        flowName: "agent.delegate",
        input: { id: "design", title: "Estimation design", prompt: "design it" },
        identity
      }
    },
    {
      _tag: "cell-call-settled",
      flowName: "agent.delegate",
      identity,
      result: { outcome: "failure", value: null, message: "Flow agent.delegate failed: Three workers are active" }
    },
    { _tag: "cell-settled", cell: "c", outcome: { _tag: "settled", transition: { _tag: "complete", output: "x" } } },
    { _tag: "resolved", message: { role: "assistant", content: [{ type: "text", text: "Delegated the design." }] } }
  ] as unknown as ReadonlyArray<Parameters<typeof Transcript.apply>[1]>
  const transcript = events.reduce(
    (state, event, index) => Transcript.apply(state, event, index),
    Transcript.user(Transcript.empty, "design estimation")
  )
  const summary = Summary.panel(transcript)

  expect(summary.summary).toBe("Not delegated: Estimation design (Three workers are active)")
  const cell = summary.rows.find((row) => row.details.some((block) => block.kind === "code"))!
  expect(cell.status).toBe("failed")
  expect(cell.label).toBe("Not delegated: Estimation design (Three workers are active)")
  expect(JSON.stringify(summary)).not.toContain("Requested background work")
})

it("supports hjkl and arrows, per-row expansion and independent diff toggles", () => {
  const rows = [...panel.rows, { ...panel.rows[0]!, id: "second" }]
  let state = Panels.initial()
  state = Panels.navigate(state, "l", rows)
  expect(state.expanded.has("test")).toBe(true)
  state = Panels.navigate(state, "down", rows)
  state = Panels.navigate(state, "return", rows)
  expect([...state.expanded]).toEqual(["test", "second"])
  state = Panels.navigate(state, "k", rows)
  state = Panels.navigate(state, "left", rows)
  expect([...state.expanded]).toEqual(["second"])
  expect(Panels.navigate(state, "d", rows).diff).toBe(true)
  expect(Panels.navigate(state, "v", rows).split).toBe(true)
  expect(Panels.navigate(state, "up", rows).selected).toBe(0)
  expect(Panels.navigate(state, "down", []).selected).toBe(0)
})

it("validates runtime panels and rejects duplicate rows, oversized input and executable blocks", () => {
  expect(Panels.decode(panel)).toEqual(panel)
  expect(() => Panels.decode({ ...panel, rows: [panel.rows[0], panel.rows[0]] })).toThrow("unique")
  expect(() => Panels.decode({ ...panel, summary: "x".repeat(241) })).toThrow()
  expect(() =>
    Panels.decode({
      ...panel,
      rows: [{ id: "evil", label: "evil", details: [{ kind: "eval", source: "process.exit()" }] }]
    })
  ).toThrow()
})

it("registers real catalog flows and validates before publishing without invoking actions", async () => {
  const published: Extension.Contribution[] = []
  const bindings = await Effect.runPromise(Runtime.source({ publish: (value) => published.push(value) }).bindings())
  expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["ui.publish"])
  const call = { input: panel } as unknown as Parameters<(typeof bindings)[number]["run"]>[0]
  expect((await Effect.runPromise(bindings[0]!.run(call))).outcome).toBe("success")
  expect(published).toEqual([{ kind: "panel", placement: "tab", panel }])
  const invalid = await Effect.runPromise(bindings[0]!.run({ ...call, input: { ...panel, summary: false } }))
  expect(invalid.outcome).toBe("failure")
  expect(published).toHaveLength(1)
})

it("publishes a card, a status item and a key through one flow, and refuses a bad key with its reason", async () => {
  const published: Extension.Contribution[] = []
  const [publish] = await Effect.runPromise(
    Runtime.source({
      publish: (value) => {
        if (value.kind === "key" && value.key.key === "ctrl+c") throw new Error("ctrl+c is the built-in Clear key")
        published.push(value)
      }
    }).bindings()
  )
  const call = (input: unknown) =>
    Effect.runPromise(publish!.run({ input } as Parameters<NonNullable<typeof publish>["run"]>[0]))
  const status = {
    kind: "status",
    status: { id: "ci", text: "CI ✓", tone: "success", action: { kind: "open", surface: "ui:checks" } }
  }
  const key = {
    kind: "key",
    key: { id: "rerun", key: "alt+c", label: "Rerun checks", action: { kind: "flow", flow: "checks" } }
  }
  expect(await call({ kind: "panel", placement: "card", panel })).toMatchObject({
    outcome: "success",
    value: { id: "checks", status: "published" }
  })
  expect(await call(status)).toMatchObject({ outcome: "success", value: { id: "ci", status: "published" } })
  expect(await call(key)).toMatchObject({ outcome: "success", value: { id: "rerun", status: "published" } })
  // `kind: "panel"` without a placement is a tab, like a bare panel.
  expect((await call({ kind: "panel", panel })).outcome).toBe("success")
  expect(published).toEqual([
    { kind: "panel", placement: "card", panel },
    status,
    key,
    { kind: "panel", placement: "tab", panel }
  ] as Array<Extension.Contribution>)
  const bare = await call({ kind: "key", key: { ...key.key, key: "r" } })
  expect(bare).toMatchObject({ outcome: "failure" })
  // `ui.publish` decodes `Extension.Key` itself, so the key's own rule is the first reason given.
  expect((bare as { message: string }).message).toStartWith(
    "Flow ui.publish rejected its input: Global key r needs ctrl or alt"
  )
  const taken = await call({ kind: "key", key: { ...key.key, key: "ctrl+c" } })
  expect(JSON.stringify(taken)).toContain("ctrl+c is the built-in Clear key")
  expect((await call({ kind: "status", status: { id: "long", text: "x".repeat(25) } })).outcome).toBe("failure")
  expect(published).toHaveLength(4)
})

it("decodes every runtime binding through its declared input, not the placeholder payload", async () => {
  // `bind` gives `Flow.make` an empty payload and hands FlowBinding the real schema as `flow.input`;
  // this walks every binding so a schema the placeholder would have hidden cannot pass.
  const calls: Array<[string, unknown]> = []
  const note = (name: string) => (value?: unknown) => {
    calls.push([name, value])
    return { ok: true }
  }
  const ports: Runtime.Ports = {
    publish: note("publish"),
    delegate: note("delegate"),
    read: note("read"),
    list: note("list"),
    retry: note("retry"),
    eta: note("eta"),
    monitors: {
      create: note("monitor.create"),
      list: note("monitor.list"),
      stop: note("monitor.stop")
    } as unknown as NonNullable<Runtime.Ports["monitors"]>
  }
  const valid: Record<string, readonly [unknown, string, unknown]> = {
    "ui.publish": [{ kind: "status", status: { id: "ci", text: "CI ✓" } }, "publish", {
      kind: "status",
      status: { id: "ci", text: "CI ✓" }
    }],
    "monitor.create": [
      { id: "ci", title: "CI", watch: "a failure", source: { kind: "tab", id: "fix" } },
      "monitor.create",
      { id: "ci", title: "CI", watch: "a failure", source: { kind: "tab", id: "fix" } }
    ],
    "monitor.list": [{}, "monitor.list", undefined],
    "monitor.stop": [{ id: "ci" }, "monitor.stop", "ci"],
    "tab.eta": [{}, "eta", undefined],
    "agent.delegate": [
      { id: "fix", title: "Fix", prompt: "Fix it.", agent: "review" },
      "delegate",
      { id: "fix", title: "Fix", prompt: "Fix it.", agent: "review" }
    ],
    "tab.read": [{ id: "fix" }, "read", "fix"],
    "tab.retry": [{ id: "fix" }, "retry", "fix"],
    "tab.list": [{}, "list", undefined]
  }
  const bindings = await Effect.runPromise(Runtime.source(ports).bindings())
  expect(bindings.map((binding) => binding.descriptor.name).sort()).toEqual(Object.keys(valid).sort())
  for (const binding of bindings) {
    const name = binding.descriptor.name
    const [input, port, received] = valid[name]!
    const run = (value: unknown) =>
      Effect.runPromise(binding.run({ input: value } as Parameters<typeof binding.run>[0]))
    calls.length = 0
    expect({ name, outcome: (await run(input)).outcome }).toEqual({ name, outcome: "success" })
    expect(calls).toEqual([[port, received]])
    // An empty struct takes anything; every binding with fields must refuse a non-object.
    if (Object.keys(input as object).length === 0) continue
    calls.length = 0
    expect({ name, result: await run(42) }).toMatchObject({
      name,
      result: { outcome: "failure", code: "invalid_input" }
    })
    expect(calls).toEqual([])
  }
})

it("registers the Smithers plugin on every turn; list, run and inspect only with a flows port", async () => {
  const names = async (ports?: Runtime.Ports) => {
    const kernel = await Effect.runPromise(CellPlugin.make(Runtime.plugins(ports)))
    const bindings = await Effect.runPromise(CellPlugin.flows(kernel.plugins, []))
    return bindings.map((binding) => binding.descriptor.name)
  }
  expect(await names()).toEqual(["smithers.guide"])
  expect(await names({ publish: () => {} })).toEqual(["smithers.guide"])
  const requests: Array<unknown> = []
  const ports: Runtime.Ports = {
    publish: () => {},
    flows: {
      list: () => [{ name: "review", description: "Review a change" }],
      run: (request) => {
        requests.push(request)
        return { id: request.id, status: "requested" }
      },
      inspect: (id) => ({ id, status: "running" })
    }
  }
  expect(await names(ports)).toEqual(["smithers.guide", "smithers.flows", "smithers.run", "smithers.inspect"])
  const kernel = await Effect.runPromise(CellPlugin.make(Runtime.plugins(ports)))
  const bindings = await Effect.runPromise(CellPlugin.flows(kernel.plugins, []))
  const run = bindings.find((binding) => binding.descriptor.name === "smithers.run")!
  const call = (input: unknown) => run.run({ input } as Parameters<typeof run.run>[0])
  expect(await Effect.runPromise(call({ id: "r1", flow: "review", input: { title: "x" } }))).toMatchObject({
    outcome: "success",
    value: { id: "r1", status: "requested" }
  })
  expect(requests).toEqual([{ id: "r1", flow: "review", input: { title: "x" } }])
  expect((await Effect.runPromise(call({ id: "r2" }))).outcome).toBe("failure")
  // The runtime source no longer carries its own copy of the flow bindings.
  const own = await Effect.runPromise(Runtime.source(ports).bindings())
  expect(own.map((binding) => binding.descriptor.name)).toEqual(["ui.publish"])
  expect(Runtime.coordinatorTeaching).toContain("smithers.run")
  expect(Runtime.coordinatorTeaching).not.toContain("flow.run")
})

it("teaches only smthrs verbs the real CLI lists", () => {
  const cli = join(import.meta.dir, "..", "..", "..", "packages", "smithers", "bin", "smithers.mjs")
  const manifest = Bun.spawnSync(["node", cli, "--llms"], { stdout: "pipe", stderr: "pipe" }).stdout.toString()
  expect(manifest).toContain("smthrs flow start")
  for (const fact of SmithersPlugin.knowledge.cli) {
    const verb = fact.name.replace(/ <.*$/, "")
    expect(manifest).toContain(`\`${verb}`)
  }
}, 60_000)

it("accepts seat names in the delegate flow", async () => {
  const requests: Array<unknown> = []
  const bindings = await Effect.runPromise(
    Runtime.source({
      publish: () => {},
      delegate: (value) => {
        requests.push(value)
        return { status: "requested" }
      },
      read: () => ({}),
      list: () => []
    }).bindings()
  )
  const delegate = bindings.find((binding) => binding.descriptor.name === "agent.delegate")!
  // The coordinator's own pick is not a person's choice; an unnamed model is routed by Jev.
  expect(delegate.descriptor.description).toEndWith(" Pass model only when the person names one.")
  const input = { id: "test", title: "Test", prompt: "Test work" }
  const call = (value: unknown) => delegate.run({ input: value } as Parameters<typeof delegate.run>[0])
  for (const model of [...Object.keys(Models.delegateModels), "opus", "claude-code:opus", "sonnet"]) {
    expect((await Effect.runPromise(call({ ...input, model }))).outcome).toBe("success")
  }
  expect((await Effect.runPromise(call(input))).outcome).toBe("success")
  expect((await Effect.runPromise(call({ ...input, model: "" }))).outcome).toBe("failure")
  expect(requests).toHaveLength(Object.keys(Models.delegateModels).length + 4)
})

it("teaches the coordinator honest receipts and the panel block contract", () => {
  for (
    const rule of [
      "final answer is normally ONE short sentence",
      "Do not narrate flow names, ids, JSON",
      "console.log does not end it",
      "Never wait, retry, or re-check tab.list",
      "If a request fails, end the turn saying it was not made and why",
      "You have no filesystem or shell flows in this role",
      "monitor.create",
      "A requested or queued receipt means only requested or queued",
      "This applies to panel details as well as replies",
      "A running task is never completed",
      "placement:\"main\" and bind:{tree:rootId}",
      "otherwise omit agent. Default worker seat, never an agent or model value: "
    ]
  ) expect(Runtime.coordinatorTeaching).toContain(rule)
  for (const rule of ["kind:\"code\"", "kind:\"table\"", "Never invent actions the user did not request"]) {
    expect(Panels.teaching).toContain(rule)
  }
})

it("lets the agent retry a tab and reports why a retry is refused", async () => {
  const bindings = await Effect.runPromise(
    Runtime.source({
      publish: () => {},
      delegate: () => ({ status: "requested" }),
      read: () => ({}),
      list: () => [],
      retry: (id) => {
        if (id !== "failed-one") throw new Error(`Only a failed or stopped tab can be retried; ${id} is running`)
        return { id, status: "requested" }
      }
    }).bindings()
  )
  const retry = bindings.find((binding) => binding.descriptor.name === "tab.retry")!
  const call = (id: string) =>
    Effect.runPromise(retry.run({ input: { id } } as unknown as Parameters<typeof retry.run>[0]))
  expect(await call("failed-one")).toMatchObject({
    outcome: "success",
    value: { id: "failed-one", status: "requested" }
  })
  expect(await call("busy")).toMatchObject({ outcome: "failure" })
  expect(JSON.stringify(await call("busy"))).toContain("busy is running")
})

it("lists tabs and flows when the cell omits the input", async () => {
  const bindings = [
    ...await Effect.runPromise(
      Runtime.source({
        publish: () => {},
        delegate: () => ({ status: "requested" }),
        read: () => ({}),
        list: () => [{ id: "w1", status: "running" }]
      }).bindings()
    ),
    ...SmithersPlugin.flows({
      list: () => [{ name: "review", description: "Review a change" }],
      run: () => ({}),
      inspect: () => ({})
    })
  ]
  // `ctx.call("tab.list")` reaches the binding as JSON null.
  const run = (name: string) => {
    const binding = bindings.find((candidate) => candidate.descriptor.name === name)!
    return Effect.runPromise(binding.run({ input: null } as Parameters<typeof binding.run>[0]))
  }
  expect(await run("tab.list")).toMatchObject({ outcome: "success", value: [{ id: "w1", status: "running" }] })
  expect(await run("smithers.flows")).toMatchObject({ outcome: "success", value: [{ name: "review" }] })
  expect((await run("tab.read")).outcome).toBe("failure")
})
it("delegates to a custom agent and returns its typed refusals as one line", async () => {
  const requests: Array<unknown> = []
  const bindings = await Effect.runPromise(
    Runtime.source({
      publish: () => {},
      delegate: (value) => {
        requests.push(value)
        if (value.agent === "echo") {
          throw new Agents.AgentError("not_an_agent", "echo is a module flow; run it with smithers.run or /flow")
        }
        return { id: value.id, status: "requested" }
      },
      read: () => ({}),
      list: () => []
    }).bindings()
  )
  const delegate = bindings.find((binding) => binding.descriptor.name === "agent.delegate")!
  const call = (value: unknown) =>
    Effect.runPromise(delegate.run({ input: value } as Parameters<typeof delegate.run>[0]))
  const input = { id: "rev", title: "Review", prompt: "Look at src" }
  expect(await call({ ...input, agent: "review" })).toMatchObject({
    outcome: "success",
    value: { id: "rev", status: "requested" }
  })
  expect(requests[0]).toEqual({ ...input, agent: "review" })
  const refused = await call({ ...input, agent: "echo" })
  expect(refused.outcome).toBe("failure")
  expect(JSON.stringify(refused)).toContain("not_an_agent: echo is a module flow")
})

it("refuses an unknown, module or person-only agent through a real workspace", async () => {
  const f = setup()
  const listed = [
    {
      name: "review",
      description: "Review",
      modelInvocable: true,
      kind: "markdown" as const,
      flows: [],
      capabilities: [],
      path: "a"
    },
    {
      name: "echo",
      description: "Echo",
      modelInvocable: true,
      kind: "module" as const,
      flows: [],
      capabilities: [],
      path: "b"
    },
    {
      name: "manual",
      description: "Manual",
      modelInvocable: false,
      kind: "markdown" as const,
      flows: [],
      capabilities: [],
      path: "c"
    }
  ]
  const workspace = new Workspace({
    host: f.host,
    workerSeat: "worker:test",
    history: () => [],
    persist: () => {},
    agents: { listed: () => listed, load: () => new Promise(() => {}) }
  })
  const bindings = await Effect.runPromise(
    Runtime.source({
      publish: () => {},
      delegate: workspace.request,
      read: workspace.read,
      list: () => workspace.snapshot().tabs
    }).bindings()
  )
  const delegate = bindings.find((binding) => binding.descriptor.name === "agent.delegate")!
  const call = (agent: string) =>
    Effect.runPromise(
      delegate.run(
        { input: { id: agent, title: agent, prompt: "Go", agent } } as unknown as Parameters<typeof delegate.run>[0]
      )
    )
  for (const [agent, code] of [["missing", "unknown_agent"], ["echo", "not_an_agent"], ["manual", "not_invocable"]]) {
    const result = await call(agent!)
    expect(result.outcome).toBe("failure")
    expect(JSON.stringify(result)).toContain(`${code}:`)
  }
  expect((await call("review")).outcome).toBe("success")
  expect(workspace.snapshot().tabs.map((tab) => tab.agent?.name)).toEqual(["review"])
  workspace.dispose()
})

it("produces contextual hunks, preserves unchanged lines, and captures patch rename paths", () => {
  const patch = Changes.patch("math.js", "// addition\nreturn a - b\n// end\n", "// addition\nreturn a + b\n// end\n")!
  expect(patch.patch).toContain(" // addition")
  expect(patch.patch).toContain("-return a - b")
  expect(patch.patch).toContain("+return a + b")
  expect(Changes.patch("same", "same", "same")).toBeUndefined()
  expect(
    Changes.paths("apply_patch", {
      input:
        "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+b\n*** Delete File: c.ts\n*** End Patch"
    })
  ).toEqual(["a.ts", "b.ts", "c.ts"])
  // A patch apply_patch refuses writes nothing, so it names no file.
  expect(Changes.touched("apply_patch", { input: "*** Begin Patch\n*** Update File: a.ts\n*** End Patch" }))
    .toBeUndefined()
})

it("captures actual overwrite contents at a flow boundary and preserves the result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-diff-"))
  writeFileSync(join(cwd, "a.ts"), "before\n")
  const receipts: Changes.Receipt[] = []
  const source = {
    name: "test",
    bindings: () =>
      Effect.succeed([{
        descriptor: { name: "write" },
        run: () =>
          Effect.sync(() => {
            writeFileSync(join(cwd, "a.ts"), "after\n")
            return { outcome: "success", value: 1 }
          })
      }])
  } as unknown as Parameters<typeof Changes.capture>[0]
  const [binding] = await Effect.runPromise(
    Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
  )
  const result = await Effect.runPromise(
    binding!.run(
      {
        flowName: "write",
        input: { path: "a.ts", content: "after\n" },
        identity: { session: "test", frame: 1, ordinal: 0 }
      } as any
    )
  )
  expect(result.value).toBe(1)
  expect(receipts[0]?.patches[0]?.patch).toContain("-before")
  expect(receipts[0]?.patches[0]?.patch).toContain("+after")
})

const setup = (run?: Host.Host["run"], contribute?: (owner: string, contribution: Extension.Contribution) => void) => {
  let resolve!: (outcome: Host.Outcome) => void
  let input!: Host.TurnInput
  let launched = 0
  let cancelled = 0
  const records: Session.Record[] = []
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-worker-")),
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: run ?? ((value) => {
      launched++
      input = value
      return {
        done: new Promise((done) => {
          resolve = done
        }),
        cancel: () => {
          cancelled++
          resolve({ _tag: "cancelled" })
        }
      }
    })
  }
  const workspace = new Workspace({
    host,
    workerSeat: "worker:test",
    history: () => [],
    persist: (record) => records.push(record),
    ...(contribute === undefined ? {} : { contribute })
  })
  return {
    workspace,
    records,
    host,
    complete: (outcome: Host.Outcome) => resolve(outcome),
    launched: () => launched,
    cancelled: () => cancelled,
    input: () => input
  }
}
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
const request = { id: "fix", title: "Fix addition", prompt: "Fix addition and run the checks." }

describe("background work", () => {
  it("places a worker's card in its own lane and owns its status items and keys by tab", async () => {
    const contributed: Array<{ owner: string; contribution: Extension.Contribution }> = []
    const f = setup(undefined, (owner, contribution) => {
      if (contribution.kind === "key" && contribution.key.key === "ctrl+c") {
        throw new Error("ctrl+c is the built-in Clear key")
      }
      contributed.push({ owner, contribution })
    })
    f.workspace.request(request)
    await tick()
    const publish = f.input().runtime!.publish
    publish({ kind: "panel", placement: "card", panel })
    publish({ kind: "panel", placement: "card", panel: { ...panel, summary: "One check left." } })
    publish({ kind: "status", status: { id: "ci", text: "CI ◌" } })
    expect(() =>
      publish({ kind: "key", key: { id: "k", key: "ctrl+c", label: "Clear", action: { kind: "prompt", prompt: "x" } } })
    ).toThrow("built-in")
    const cards = f.workspace.transcript("fix").items.filter((item) => item.kind === "card")
    expect(cards).toMatchObject([{ panel: { id: "fix/checks", summary: "One check left." } }])
    expect(f.workspace.snapshot().cards).toEqual(["fix/checks"])
    expect(contributed).toEqual([{
      owner: "runtime:fix",
      contribution: { kind: "status", status: { id: "fix/ci", text: "CI ◌" } }
    }])
    // The chat file places the card; the worker's own file draws it, so a reload keeps it in the worker's lane.
    expect(Session.restore(f.records).workspace.cards).toEqual(["fix/checks"])
    expect(Session.restore(f.records).transcript.items.some((item) => item.kind === "card")).toBe(false)
    const tab = f.workspace.snapshot().tabs[0]!
    expect(Session.restore(Session.load(tab.file)).transcript.items.filter((item) => item.kind === "card"))
      .toHaveLength(1)
    f.complete({ _tag: "done", answer: "Done" })
    await tick()
  })
  it("caches one description per tab from the worker's own seat and falls back to the title on failure", async () => {
    const f = setup()
    let finish!: (text: string) => void
    const calls: Array<{ title: string; prompt: string; seat: string }> = []
    ;(f.host as { describe?: Host.Host["describe"] }).describe = (input) => {
      calls.push(input)
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    f.workspace.request(request)
    expect(f.workspace.snapshot().tabs[0]?.description).toBeUndefined()
    f.workspace.request(request)
    expect(calls).toEqual([{ title: request.title, prompt: request.prompt, seat: "worker:test" }])
    finish("  Fix   addition\n and verify " + "x".repeat(90))
    await tick()
    const description = f.workspace.snapshot().tabs[0]?.description
    expect(description).toStartWith("Fix addition and verify")
    expect(description?.includes("\n")).toBe(false)
    expect(description?.length).toBe(80)
    expect(Session.restore(f.records).workspace.tabs[0]?.description).toBe(description)
    expect(calls).toHaveLength(1)
    f.complete({ _tag: "done", answer: "Done" })
    await tick()

    const failed = setup()
    ;(failed.host as { describe?: Host.Host["describe"] }).describe = async () => {
      throw new Error("Luna unavailable")
    }
    failed.workspace.request(request)
    await tick()
    expect(failed.workspace.snapshot().tabs[0]?.description).toBe(request.title)
    failed.complete({ _tag: "done", answer: "Done" })
    await tick()
  })
  it("asks the named delegate model, never a fixed one, for the description", async () => {
    const f = setup()
    const seats: Array<string> = []
    ;(f.host as { describe?: Host.Host["describe"] }).describe = async (input) => (seats.push(input.seat), "d")
    f.workspace.request({ ...request, model: "cerebras" })
    await tick()
    expect(seats).toEqual([Models.delegateModels.cerebras])
    f.complete({ _tag: "done", answer: "Done" })
    await tick()
  })

  it("retries a failed tab on the model it was requested with", async () => {
    const f = setup()
    f.workspace.request({ ...request, model: "astra" })
    await tick()
    f.complete({ _tag: "failed", message: "boom", detail: "boom" })
    await tick()
    expect(f.workspace.retry(request.id)).toEqual({ id: request.id, status: "requested" })
    await tick()
    expect(f.workspace.snapshot().tabs[0]?.seat).toBe(Models.delegateModels.astra)
    expect(f.input().seat).toBe(Models.delegateModels.astra)
    f.complete({ _tag: "done", answer: "Done" })
    await tick()
  })

  it("refuses to retry an unknown or unsettled tab with a reason", async () => {
    const f = setup()
    expect(() => f.workspace.retry("nope")).toThrow("Unknown tab")
    f.workspace.request(request)
    expect(() => f.workspace.retry(request.id)).toThrow("Only a failed or stopped tab can be retried")
    await tick()
    f.complete({ _tag: "done", answer: "Done" })
    await tick()
  })

  it("tells the coordinator every unsettled tab and only the newest settled answers, bounded", async () => {
    const f = setup(() => ({ done: Promise.resolve({ _tag: "done", answer: "a".repeat(5000) }), cancel: () => {} }))
    for (let index = 0; index < 8; index++) {
      f.workspace.request({ id: `t${index}`, title: `Task ${index}`, prompt: `Task ${index}` })
      await tick()
      await tick()
    }
    const listed = JSON.parse(f.workspace.context()) as Array<
      { id: string; title: string; status: string; answer?: string }
    >
    expect(listed).toHaveLength(8)
    const answered = listed.filter((tab) => tab.answer !== undefined)
    expect(answered).toHaveLength(5)
    expect(answered.every((tab) => tab.answer!.length <= 1500)).toBe(true)
    expect(listed.find((tab) => tab.id === "t0")).toEqual({ id: "t0", title: "Task 0", status: "done" })
  })

  it("uses the named delegate model for the worker and preserves the default seat", async () => {
    const named = setup()
    named.workspace.request({ ...request, model: "astra" })
    expect(named.workspace.snapshot().tabs[0]?.seat).toBe(Models.delegateModels.astra)
    await tick()
    expect(named.input().seat).toBe("openai:gpt-6-astra")
    named.complete({ _tag: "done", answer: "Done" })
    await tick()

    const defaultWorker = setup()
    defaultWorker.workspace.request(request)
    await tick()
    expect(defaultWorker.input().seat).toBe("worker:test")
    defaultWorker.complete({ _tag: "done", answer: "Done" })
    await tick()
  })
  it("persists and acknowledges before launch, keeps running through unresolved execution, and deduplicates", async () => {
    const f = setup()
    expect(f.workspace.request(request)).toEqual({ id: "fix", status: "requested" })
    expect(f.records[0]).toMatchObject({ type: "tab", tab: { status: "requested" } })
    expect(f.launched()).toBe(0)
    f.workspace.request(request)
    expect(f.records).toHaveLength(1)
    await tick()
    expect(f.launched()).toBe(1)
    expect(f.workspace.read("fix").status).toBe("running")
    // Chat can publish, inspect, and request other work while the worker never resolves.
    f.workspace.publish(panel)
    expect(f.workspace.snapshot().panels).toEqual([panel])
    expect(f.workspace.busy).toBe(true)
    expect(f.input().role).toBe("worker")
    expect(f.input().runtime?.delegate).toBeFunction()
    expect(f.input().runtime?.wait).toBeFunction()
    f.complete({ _tag: "done", answer: "Fixed addition; the check passes." })
    await tick()
    expect(f.workspace.read("fix")).toMatchObject({ status: "done", answer: "Fixed addition; the check passes." })
    expect(f.workspace.busy).toBe(false)
    expect(Session.restore(f.records).workspace.panels).toEqual([panel])
    expect(Session.restore(f.records).workspace.tabs[0]?.status).toBe("done")
  })
  it("shows launch failures and supports an explicit retry", async () => {
    let fail = true
    const f = setup(() => {
      if (fail) throw new Error("Launch refused")
      return { done: Promise.resolve({ _tag: "done", answer: "Done" }), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    expect(f.workspace.read("fix")).toMatchObject({ status: "failed", message: "Error: Launch refused" })
    fail = false
    f.workspace.retry("fix")
    expect(f.workspace.read("fix").status).toBe("requested")
    await tick()
    expect(f.workspace.read("fix").status).toBe("done")
  })
  it("cancels before launch and refuses id collisions", async () => {
    const f = setup()
    f.workspace.request(request)
    expect(() => f.workspace.request({ ...request, prompt: "Different work" })).toThrow("another request")
    expect(() => f.workspace.request({ ...request, model: "sol" })).toThrow("another request")
    f.workspace.cancel("fix")
    await tick()
    expect(f.launched()).toBe(0)
    expect(f.workspace.read("fix").status).toBe("cancelled")
  })
  describe("seat queue", () => {
    // Six seats; each launch gets its own settle handle so tests complete a specific worker.
    const seats = (refuse: (prompt: string) => boolean = () => false) => {
      const settle = new Map<string, (outcome: Host.Outcome) => void>()
      const started: string[] = []
      const f = setup((input) => {
        if (refuse(input.prompt)) throw new Error("Launch refused")
        started.push(input.source!)
        return {
          done: new Promise<Host.Outcome>((done) => {
            settle.set(input.source!, done)
          }),
          cancel: () => settle.get(input.source!)?.({ _tag: "cancelled" })
        }
      })
      const job = (id: string) => ({ id, title: `Job ${id}`, prompt: `Do ${id}.` })
      return { ...f, settle, started, job }
    }
    it("acknowledges a seventh delegation as queued at once and starts it when a seat frees", async () => {
      const f = seats()
      for (const id of ["a", "b", "c", "d", "e", "f"]) f.workspace.request(f.job(id))
      await tick()
      expect(f.started).toEqual(["a", "b", "c", "d", "e", "f"])
      expect(f.workspace.request(f.job("g"))).toEqual({ id: "g", status: "queued" })
      expect(f.records.findLast((record) => record.type === "tab")).toMatchObject({
        tab: { id: "g", status: "queued" }
      })
      expect(f.workspace.read("g").status).toBe("queued")
      expect(f.workspace.panel("g").summary).toBe("Queued.")
      expect(f.workspace.busy).toBe(true)
      await tick()
      expect(f.started).toEqual(["a", "b", "c", "d", "e", "f"])
      f.settle.get("b")!({ _tag: "done", answer: "B done" })
      await tick()
      expect(f.started).toEqual(["a", "b", "c", "d", "e", "f", "g"])
      expect(f.workspace.read("g").status).toBe("running")
      expect(f.workspace.read("b").status).toBe("done")
      f.workspace.dispose()
    })
    it("starts queued work in request order and dedupes a repeated queued id", async () => {
      const f = seats()
      for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) f.workspace.request(f.job(id))
      const before = f.records.length
      expect(f.workspace.request(f.job("g"))).toEqual({ id: "g", status: "queued" })
      expect(f.records).toHaveLength(before)
      expect(f.workspace.snapshot().tabs.map((tab) => tab.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"])
      await tick()
      f.settle.get("a")!({ _tag: "done", answer: "A" })
      await tick()
      expect(f.started).toEqual(["a", "b", "c", "d", "e", "f", "g"])
      expect(f.workspace.read("h").status).toBe("queued")
      f.settle.get("c")!({ _tag: "failed", message: "C broke", detail: "C broke" })
      await tick()
      expect(f.started).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"])
      f.workspace.dispose()
    })
    it("settles a queued delegation failed when its start fails and moves on to the next", async () => {
      const f = seats((prompt) => prompt === "Do g.")
      for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) f.workspace.request(f.job(id))
      await tick()
      f.settle.get("a")!({ _tag: "done", answer: "A" })
      await tick()
      await tick()
      expect(f.workspace.read("g")).toMatchObject({ status: "failed", message: "Error: Launch refused" })
      expect(f.started).toEqual(["a", "b", "c", "d", "e", "f", "h"])
      expect(f.workspace.read("h").status).toBe("running")
      f.workspace.dispose()
    })
    it("cancels queued work without starting it and retries into the queue when seats are full", async () => {
      const f = seats()
      for (const id of ["a", "b", "c", "d", "e", "f", "g"]) f.workspace.request(f.job(id))
      await tick()
      f.workspace.cancel("g")
      expect(f.workspace.read("g").status).toBe("cancelled")
      f.settle.get("a")!({ _tag: "done", answer: "A" })
      await tick()
      expect(f.started).toEqual(["a", "b", "c", "d", "e", "f"])
      f.workspace.request(f.job("x"))
      await tick()
      expect(f.workspace.read("x").status).toBe("running")
      f.workspace.retry("g")
      expect(f.workspace.read("g").status).toBe("queued")
      f.workspace.dispose()
      expect(f.workspace.read("g").status).toBe("cancelled")
    })
  })
  it("restores custom UI and relaunches a lost local worker", async () => {
    const f = setup()
    f.workspace.request(request)
    f.workspace.publish(panel)
    const saved = Session.restore(f.records).workspace
    f.workspace.dispose()
    const restored = new Workspace({
      host: f.host,
      workerSeat: "worker:test",
      history: () => [],
      persist: () => {},
      restored: saved
    })
    expect(restored.snapshot().panels).toEqual([panel])
    await tick()
    expect(restored.read("fix")).toMatchObject({ status: "running" })
    expect(f.launched()).toBe(1)
    restored.dispose()
  })
})

it("never offers a GPT-5.6 model as a picker, delegate, default or worker seat", async () => {
  const everyProvider = {
    OPENAI_API_KEY: "test",
    OPENROUTER_API_KEY: "test",
    MOONSHOT_API_KEY: "test",
    GEMINI_API_KEY: "test",
    CEREBRAS_API_KEY: "test",
    ANTHROPIC_API_KEY: "test"
  }
  const available = await Models.detect(everyProvider)
  const openAiFirst = await Models.detect({ OPENAI_API_KEY: "test" })
  const seats = [
    ...available.models.map((model) => model.seat),
    ...Models.offered.map((model) => model.seat),
    ...Object.values(Models.delegateModels),
    available.defaultSeat,
    available.workerSeat,
    openAiFirst.defaultSeat,
    openAiFirst.workerSeat
  ]
  const labels = [...available.models, ...Models.offered].map((model) => model.label)
  expect(available.models.length).toBeGreaterThan(0)
  expect(seats.filter((seat) => seat === undefined || /5\.6/.test(seat))).toEqual([])
  expect(labels.filter((label) => /5\.6/.test(label))).toEqual([])
  expect(Models.delegable(available.models).some((seat) => /5\.6/.test(seat))).toBe(false)

  const bindings = await Effect.runPromise(
    Runtime.source({
      publish: () => {},
      delegate: () => ({ status: "requested" }),
      read: () => ({}),
      list: () => []
    }).bindings()
  )
  const delegate = bindings.find((binding) => binding.descriptor.name === "agent.delegate")!
  for (const model of ["", " ".repeat(161)]) {
    const call = { input: { id: "t", title: "T", prompt: "P", model } } as unknown as Parameters<typeof delegate.run>[0]
    const result = await Effect.runPromise(delegate.run(call))
    expect(result.outcome).toBe("failure")
  }
})

it("prefers Cerebras for chat and keeps a distinct worker seat and explicit overrides", async () => {
  const seats = await Models.detect({
    CEREBRAS_API_KEY: "test",
    ANTHROPIC_API_KEY: "test",
    SMITHERS_TUI_WORKER_SEAT: "anthropic:worker"
  })
  expect(seats.defaultSeat).toBe("cerebras:qwen-3.8-27b")
  expect(seats.workerSeat).toBe("anthropic:worker")
  expect((await Models.detect({ CEREBRAS_API_KEY: "test", SMITHERS_TUI_SEAT: "explicit:chat" })).defaultSeat).toBe(
    "explicit:chat"
  )
})

it("captures shell changes against a jj snapshot without attributing pre-existing edits", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-jj-diff-"))
  const init = Bun.spawn(["jj", "git", "init", cwd], { stdout: "ignore", stderr: "ignore" })
  expect(await init.exited).toBe(0)
  writeFileSync(join(cwd, "a.ts"), "pre-existing content\n")
  writeFileSync(join(cwd, "unrelated.ts"), "leave this alone\n")
  const receipts: Changes.Receipt[] = []
  const source = {
    name: "test",
    bindings: () =>
      Effect.succeed([{
        descriptor: { name: "bash" },
        run: () =>
          Effect.sync(() => {
            writeFileSync(join(cwd, "a.ts"), "new content\n")
            return { outcome: "success" }
          })
      }])
  } as unknown as Parameters<typeof Changes.capture>[0]
  const [binding] = await Effect.runPromise(
    Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
  )
  await Effect.runPromise(
    binding!.run(
      {
        flowName: "bash",
        input: { command: "update a.ts" },
        identity: { session: "test", frame: 1, ordinal: 0 }
      } as any
    )
  )
  expect(receipts[0]?.patches).toHaveLength(1)
  expect(receipts[0]?.patches[0]?.path).toBe("a.ts")
  expect(receipts[0]?.patches[0]?.patch).toContain("-pre-existing content")
  expect(receipts[0]?.patches[0]?.patch).toContain("+new content")
})

it("keeps worker files out of the conversation picker and latest-session lookup", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-session-kind-"))
  const chat = Session.create(cwd)
  chat.append({ type: "user", at: 1, text: "Conversation" })
  const worker = Session.create(cwd, "worker")
  worker.append({ type: "user", at: 2, text: "Background task" })
  expect(Session.latest(cwd)).toBe(chat.file)
  expect(Session.list(cwd).map((row) => row.file)).toEqual([chat.file])
  expect(Session.restore(Session.load(worker.file)).prompts).toEqual(["Background task"])
})

it("recovers a worker completion written before the parent recorded it", () => {
  const f = setup()
  const writer = Session.create(f.host.cwd, "worker")
  writer.append({
    type: "outcome",
    at: 99,
    prompt: request.prompt,
    outcome: { _tag: "done", answer: "The check passes." }
  })
  const records: Session.Record[] = []
  const workspace = new Workspace({
    host: f.host,
    workerSeat: "worker:test",
    history: () => [],
    persist: (record) => records.push(record),
    restored: {
      panels: [],
      tabs: [{ ...request, file: writer.file, seat: "worker:test", startedAt: 1, status: "running", depth: 0 }]
    }
  })
  expect(workspace.read("fix")).toMatchObject({ status: "done", answer: "The check passes." })
  expect(records[0]).toMatchObject({ type: "tab", tab: { status: "done", endedAt: 99 } })
})

it("uses full call identities and replays persisted captions and actual diffs", () => {
  const transcript = fixture()
  const cell = transcript.items.find((item) => item.kind === "cell" && item.calls.some((call) => call.flow === "edit"))!
  if (cell.kind !== "cell") throw new Error("Missing edit cell")
  const call = cell.calls.find((call) => call.flow === "edit")!
  const receipt = { call: call.identity!, patches: [{ path: "math.js", patch: "real recorded diff" }] }
  const patched = Transcript.patched(transcript, receipt)
  expect(
    patched.items.filter((item) => item.kind === "cell").flatMap((item) => item.calls).filter((item) =>
      item.patches !== undefined
    )
  ).toHaveLength(1)
  const records: Session.Record[] = readFileSync(join(import.meta.dir, "fixtures/fix-add.jsonl"), "utf8").trim().split(
    "\n"
  ).map((line) => ({ type: "event", ...JSON.parse(line) }))
  records.push({ type: "patch", receipt }, { type: "caption", prose: "Verified addition." })
  const restored = Session.restore(records).transcript
  expect(
    Summary.panel(restored).rows.flatMap((row) => row.details).some((block) =>
      block.kind === "diff" && block.patch === "real recorded diff"
    )
  ).toBe(true)
  expect(restored.items.findLast((item) => item.kind === "cell")?.prose).toBe("Verified addition.")
})

describe("tab flows through the real flow binding", () => {
  const bindings = async (
    f: ReturnType<typeof setup>,
    runs?: { read: (id: string) => unknown; snapshot: () => ReadonlyArray<unknown> }
  ) =>
    Effect.runPromise(
      Runtime.source({
        publish: () => {},
        delegate: f.workspace.request,
        read: (id) => (runs !== undefined && id.startsWith("run") ? runs.read(id) : f.workspace.read(id)),
        list: () => [...f.workspace.snapshot().tabs, ...(runs?.snapshot() ?? [])]
      }).bindings()
    )
  // Synchronous, so a requested tab is read before its launch microtask runs.
  const call = (all: ReadonlyArray<Awaited<ReturnType<typeof bindings>>[number]>, name: string, input: unknown) => {
    const binding = all.find((row) => row.descriptor.name === name)!
    return Effect.runSync(binding.run({ input } as Parameters<typeof binding.run>[0]))
  }

  it("returns plain JSON for requested, running, done and failed tabs", async () => {
    const f = setup()
    const all = await bindings(f)
    const observed: Array<unknown> = []
    const read = (status: string) => {
      const result = call(all, "tab.read", { id: "fix" })
      expect(result).toMatchObject({ outcome: "success", value: { id: "fix", status } })
      observed.push(result.value)
      const listed = call(all, "tab.list", {})
      expect(listed).toMatchObject({ outcome: "success", value: [{ id: "fix", status }] })
    }
    call(all, "agent.delegate", request)
    read("requested")
    await tick()
    read("running")
    f.complete({ _tag: "done", answer: "Fixed." })
    await tick()
    read("done")
    const failing = setup()
    const failed = await bindings(failing)
    call(failed, "agent.delegate", request)
    await tick()
    failing.complete({ _tag: "failed", message: "Provider unavailable", detail: "" })
    await tick()
    const result = call(failed, "tab.read", { id: "fix" })
    expect(result).toMatchObject({ outcome: "success", value: { status: "failed", message: "Provider unavailable" } })
    observed.push(result.value)
    for (const value of observed) expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })

  it("returns plain JSON for a failed flow run with no answer", async () => {
    const f = setup()
    const run: Run = {
      id: "run-1",
      flow: "deploy",
      by: "agent",
      input: {},
      requested: "{}",
      status: "requested",
      startedAt: 1
    }
    const runs = new FlowRuns({ persist: () => {}, restored: [run] })
    const all = await bindings(f, runs)
    const read = call(all, "tab.read", { id: "run-1" })
    expect(read).toMatchObject({ outcome: "success", value: { id: "run-1", status: "failed", message: interrupted } })
    expect(JSON.parse(JSON.stringify(read.value))).toEqual(read.value)
    expect(call(all, "tab.list", {})).toMatchObject({ outcome: "success", value: [{ id: "run-1", status: "failed" }] })
  })
})

describe("custom view limit", () => {
  it("replaces the least recently published view instead of refusing the next one", () => {
    const { workspace, records } = setup()
    for (let n = 0; n < Workspace.maxPanels; n++) workspace.publish({ ...panel, id: `v${n}` })
    workspace.publish({ ...panel, id: "v0", summary: "Republished." })
    workspace.publish({ ...panel, id: "new" })
    const ids = workspace.snapshot().panels.map((each) => each.id)
    expect(ids).toHaveLength(Workspace.maxPanels)
    expect(ids).not.toContain("v1")
    expect(ids).toContain("v0")
    expect(ids.at(-1)).toBe("new")
    const restored = Session.restore(records).workspace.panels.map((each) => each.id)
    expect(restored).toEqual(ids)
  })
})
