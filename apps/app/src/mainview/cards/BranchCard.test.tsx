/*
 * The Branch card's bindings (T-APP-10): which presses a branch offers, the
 * literal command input each press dispatches, and the card's mount through
 * the production renderer map. Expected values are literals, never read back
 * from the model or the catalog.
 */
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { act } from "react"
import { createRoot } from "./views/testDom"
import type { Card } from "@smthrs/rpc/Cards"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { cardActions } from "../flows/cardActions"
import { branchOf, createDesignWorld, MAYA, todoOf, type DesignTimers, type DesignWorld } from "../state/seams/DesignWorld"
import { designBranchModel } from "../state/seams/DesignWorld/branch"
import { branchActionDefinitions, changeActionDefinitions, liveBranchActionDefinitions } from "./BranchCard"
import { CARD_RENDERERS } from "./CardRenderers"

/** Timers that never fire: the seeded script stays where the seed left it. */
const still: DesignTimers = { set: () => 0, clear: () => {} }
const make = (): DesignWorld => createDesignWorld({ timers: still, viewer: MAYA })

const definitionsOf = (design: DesignWorld, id: string) => {
  const world = design.world()
  const branch = branchOf(world, id)!
  return { definitions: branchActionDefinitions(world, branch, designBranchModel(world, branch)), model: designBranchModel(world, branch) }
}
const buttons = (definitions: ReturnType<typeof definitionsOf>["definitions"]) =>
  definitions.filter(each => each.gesture === undefined).map(each => each.label)
const recorder = () => {
  const calls: Array<[CatalogTag, unknown]> = []
  return { calls, dispatch: (tag: CatalogTag, input: unknown) => { calls.push([tag, input]) } }
}

describe("branch presses", () => {
  test("an item branch with an open question offers Answer first, then Steer, New terminal and Fork", () => {
    const { definitions } = definitionsOf(make(), "b-retry")
    expect(buttons(definitions)).toEqual(["Answer", "Steer", "New terminal", "Fork"])
    expect(definitions.find(each => each.label === "Answer")?.primary).toBe(true)
    expect(definitions.filter(each => each.gesture !== undefined).map(each => [each.gesture, each.tag])).toEqual([
      ["item", "todo"], ["file", "file"], ["terminal", "terminal.watch"]
    ])
  })

  test("a pending rebase adds Rebase now, bound to branch.rebase with the branch", () => {
    const design = make()
    design.setBranch("b-checkout", { rebasePending: "main" })
    const { definitions } = definitionsOf(design, "b-checkout")
    expect(buttons(definitions)).toEqual(["Rebase now", "Steer", "New terminal", "Fork"])
    const { calls, dispatch } = recorder()
    cardActions(dispatch, definitions).onAction("branch.rebase")
    expect(calls).toEqual([["branch.rebase", { branch: "b-checkout" }]])
  })

  test("a closed branch offers Fork only; its reads stay bound", () => {
    const design = make()
    design.setBranch("b-stripe", { machine: "closed" })
    const { definitions } = definitionsOf(design, "b-stripe")
    expect(buttons(definitions)).toEqual(["Fork"])
    expect(definitions.filter(each => each.gesture !== undefined)).toHaveLength(3)
  })

  test("a scratch branch offers Add to stack first and has no item to open", () => {
    const design = make()
    const forked = design.fork("b-retry", MAYA)
    if (!forked.ok || forked.id === undefined) throw new Error("fork refused")
    const { definitions, model } = definitionsOf(design, forked.id)
    expect(model.scratch).toEqual({ forked_from: { kind: "item", n: 9, title: "Retry failed webhooks with backoff" } })
    expect(buttons(definitions)).toEqual(["Add to stack", "New terminal", "Fork"])
    expect(definitions.find(each => each.label === "Add to stack")?.primary).toBe(true)
    expect(definitions.some(each => each.gesture === "item")).toBe(false)
    const { calls, dispatch } = recorder()
    const bindings = cardActions(dispatch, definitions)
    bindings.onAction("branch.add-to-stack")
    bindings.onAction("terminal")
    bindings.onAction("branch.fork")
    expect(calls).toEqual([
      ["branch.add-to-stack", { text: "maya/retry-webhooks" }],
      ["terminal", { branch: forked.id }],
      ["branch.fork", { from: "main" }]
    ])
  })

  test("the gestures and the forms dispatch typed input", () => {
    const { definitions } = definitionsOf(make(), "b-retry")
    const { calls, dispatch } = recorder()
    const bindings = cardActions(dispatch, definitions)
    bindings.onAction("todo", { n: "9" })
    bindings.onAction("file", { path: "src/webhooks/retry.ts", line: "3" })
    bindings.onAction("terminal.watch", { id: "term-retry-1" })
    bindings.onAction("todo.answer", { n: "9", answer: "Exponential backoff" })
    bindings.onAction("todo.steer", { n: "9", text: "Cap at five attempts" })
    expect(calls).toEqual([
      ["todo", { n: 9 }],
      ["file", { path: "src/webhooks/retry.ts" }],
      ["terminal.watch", { id: "term-retry-1" }],
      ["todo.answer", { n: 9, answer: "Exponential backoff" }],
      ["todo.steer", { n: 9, text: "Cap at five attempts" }]
    ])
  })

  test("an unowned change burst reads as outside Smithers and carries Diff with its burst id", () => {
    const design = make()
    design.activity("b-retry", { who: "outside", kind: "change", text: "", files: 12 })
    const { model } = definitionsOf(design, "b-retry")
    const burst = model.activity.find(each => each.kind === "change")!
    expect(burst.text).toBe("Changed outside Smithers")
    expect(burst.files).toBe(12)
    expect(burst.actor.kind).toBe("outside")
    expect(changeActionDefinitions(model)).toEqual([{ tag: "diff", label: "Diff", args: { burst: burst.id }, command_input: undefined }])
  })

  test("the SSH line uses the first address's host, else localhost", () => {
    const design = make()
    expect(definitionsOf(design, "b-retry").model.ssh_line).toBe("ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net")
    design.setRepo({ setup: { ...design.world().repo.setup, addresses: [] } })
    expect(definitionsOf(design, "b-retry").model.ssh_line).toBe("ssh -p 2222 retry-webhooks@localhost")
  })

  test("the model carries the item, its place, the machine, people before agents, and the terminals", () => {
    const design = make()
    const { model } = definitionsOf(design, "b-retry")
    expect(model.item).toEqual({ n: 9, title: "Retry failed webhooks with backoff", state: "needs_you", step: "Verify", place: 2 })
    expect(model.machine).toEqual({ state: "awake" })
    const kinds = model.presence.map(each => each.actor.kind)
    expect(kinds.length).toBeGreaterThan(1)
    expect(kinds.lastIndexOf("person")).toBeLessThan(kinds.indexOf("agent"))
    expect(model.terminals.map(each => each.id)).toEqual(["term-retry-1"])
    expect(todoOf(design.world(), "t-retry")?.ref).toBe("T9")
  })
})

describe("branch card mount", () => {
  const controller = (design: DesignWorld) => {
    const submitted: Array<Record<string, unknown>> = []
    const stub = { design, commands: { submit: (submission: Record<string, unknown>) => { submitted.push(submission); return Promise.resolve({ status: "executed" }) } } }
    return { submitted, controller: stub as unknown as AppController }
  }
  const card = (id: string): Card => ({ id: `branch:${id}`, kind: "branch", title: id, status: "active", createdAt: 1, ordinal: 1, payload: { id } })
  const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {},
    onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }

  test("renders the branch through the production renderer map with its presses bound by flow name", () => {
    const design = make()
    const html = renderToStaticMarkup(<ControllerTestProvider controller={controller(design).controller}>
      {CARD_RENDERERS.branch.render(card("b-retry") as Extract<Card, { kind: "branch" }>, actions)}
    </ControllerTestProvider>)
    expect(html).toContain('data-kind="branch"')
    expect(html).toContain("retry-webhooks")
    expect(html).toContain("ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net")
    for (const flow of ["todo.answer", "todo.steer", "terminal", "branch.fork"]) expect(html).toContain(`data-flow="${flow}"`)
    expect(html).not.toContain('data-flow="branch.rebase"')
  })

  test("a branch the world does not hold renders nothing", () => {
    const html = renderToStaticMarkup(<ControllerTestProvider controller={controller(make()).controller}>
      {CARD_RENDERERS.branch.render(card("b-missing") as Extract<Card, { kind: "branch" }>, actions)}
    </ControllerTestProvider>)
    expect(html).toBe("")
  })
})

test("an install Branch never renders the seeded model without its live topics", () => {
  const controller = { design: createDesignWorld({ enabled: false }), bootstrap: { host: "local" } } as unknown as AppController
  const card = { id: "branch:b-retry", kind: "branch", title: "Branch", status: "active", createdAt: 1, ordinal: 1, payload: { id: "b-retry" } } as const
  const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
  expect(renderToStaticMarkup(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>)).toBe("")
})


test("a branch opened from seeded Home keeps its seed until the real provider answers", async () => {
  const card: CardOfBranch = { id: "branch:b-retry", kind: "branch", title: "Branch", status: "active", createdAt: 1, ordinal: 1, payload: { id: "b-retry" } }
  const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
  for (const error of [undefined, "unknown_topic", "unsupported", "forbidden"] as const) {
    const design = make(), snapshot = error === undefined ? undefined : { error }
    const host = document.createElement("div"), root = createRoot(host)
    const value = { design, commands: { submit: async () => ({ status: "executed" }) }, bootstrap: { host: "local" },
      live: { subscribe: () => () => {}, getSnapshot: () => snapshot } } as unknown as AppController
    try {
      await act(async () => root.render(<ControllerTestProvider controller={value}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
      const html = host.innerHTML
      if (error === "forbidden") expect(html).toBe("")
      else {
        expect(html).toContain("retry-webhooks")
        expect(html).toContain('data-flow="branch.fork"')
      }
    } finally { await act(async () => root.unmount()); design.dispose() }
  }
})
type CardOfBranch = Extract<Card, { kind: "branch" }>


test("live presses refuse each missing provider and dispatch only the bound TODO and branch source", () => {
  const model = definitionsOf(make(), "b-retry").model
  const providers = new Set<CatalogTag>(["todo.answer", "todo.steer", "branch.fork"])
  const definitions = liveBranchActionDefinitions(model, providers)
  expect(buttons(definitions)).toEqual(["Answer", "Steer", "Fork"])
  for (const missing of providers) {
    const available = new Set(providers); available.delete(missing)
    const { calls, dispatch } = recorder()
    cardActions(dispatch, liveBranchActionDefinitions(model, available)).onAction(missing)
    expect(calls).toEqual([])
  }
  const { calls, dispatch } = recorder()
  const bindings = cardActions(dispatch, definitions)
  bindings.onAction("todo.answer", { answer: "Use the helper" })
  bindings.onAction("todo.steer", { text: "Keep the tests" })
  bindings.onAction("branch.fork")
  expect(calls).toEqual([["todo.answer", { n: 9, answer: "Use the helper" }], ["todo.steer", { n: 9, text: "Keep the tests" }], ["branch.fork", { from: "T9" }]])
  expect(buttons(liveBranchActionDefinitions({ ...model, machine: { state: "closed" } }, providers))).toEqual(["Fork"])
  expect(liveBranchActionDefinitions({ ...model, item: undefined, name: "scratch/ben/try" }, providers)).toEqual([])
})

test("live file gestures preserve branch and coordinates and refuse a missing file provider", () => {
  const model = definitionsOf(make(), "b-retry").model
  const { calls, dispatch } = recorder()
  cardActions(dispatch, liveBranchActionDefinitions(model, new Set())).onAction("file", { path: "retry.ts", line: "12" })
  expect(calls).toEqual([])
  const bindings = cardActions(dispatch, liveBranchActionDefinitions(model, new Set(["file"])))
  bindings.onAction("file", { path: "retry.ts", line: "12" })
  bindings.onAction("file", { path: "deliver.ts" })
  expect(calls).toEqual([["file", { path: "retry.ts", branch: model.name, line: 12 }], ["file", { path: "deliver.ts", branch: model.name }]])
})

test("opening a Branch announces its authorized scope while child topics are unresolved, and unmount releases it", async () => {
  const leases: unknown[] = [], released: unknown[] = []
  const live = { subscribe: () => () => {}, getSnapshot: () => undefined,
    trackPresence: (where: unknown) => { leases.push(where); return { move: () => {}, release: () => released.push(where) } } }
  const design = createDesignWorld({ enabled: false })
  const controller = { design, live, bootstrap: { host: "local" } } as unknown as AppController
  const card = { id: "branch:actual-branch", kind: "branch", title: "Branch", status: "active", createdAt: 1, ordinal: 1, payload: { id: "actual-branch" } } as const
  const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
  const root = createRoot(document.createElement("div"))
  try {
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
    expect(leases).toEqual([{ branch: "actual-branch" }])
    expect(released).toEqual([])
    await act(async () => root.unmount())
    expect(released).toEqual([{ branch: "actual-branch" }])
  } finally { design.dispose() }
})


test("branch action copy passes the catalog text lint", async () => {
  const { lintText } = await import("./productWords")
  const design = make()
  design.setBranch("b-checkout", { rebasePending: "main" })
  const forked = design.fork("b-retry", MAYA)
  if (!forked.ok || !forked.id) throw new Error("fork refused")
  for (const id of ["b-retry", "b-checkout", "b-stripe", forked.id]) {
    const { definitions, model } = definitionsOf(design, id)
    const all = [...definitions, ...liveBranchActionDefinitions(model, new Set(["branch.fork", "todo.answer", "todo.steer", "file"])), ...changeActionDefinitions(model)]
    // Item titles are user content; every emitted action label is product copy.
    const productActions = all.filter(action => !("gesture" in action) || action.gesture !== "item")
    for (const action of productActions) expect(lintText(action.label)).toEqual([])
    for (const action of productActions.flatMap(definition => cardActions(() => {}, [definition]).actions)) {
      expect(lintText(action.label)).toEqual([])
      if (action.disabled) expect(lintText(action.disabled.reason)).toEqual([])
    }
  }
})

test("registered live terminal links dispatch Watch and disappear with unavailable viewer identity", async () => {
  const { LiveChannel } = await import("../runtime/LiveChannel")
  const { createTerminalSource } = await import("../state/seams/TerminalSeam")
  const frames: { t: string; id: number; topic?: string }[] = []
  const socket = { readyState: 1, onopen: null, onclose: null, onmessage: null,
    send: (frame: string | Uint8Array) => { if (typeof frame === "string") frames.push(JSON.parse(frame)) }, close: () => {} } as import("../runtime/LiveChannel").LiveSocket
  const live = new LiveChannel({ socket: () => socket })
  let viewer: string | undefined = "alice"
  const provider = createTerminalSource({ repo: () => "o/r", viewer: () => viewer, knownBranches: () => ["b1"], live,
    // HTTP/transport doubles only: this VM has no PostgreSQL or microVM runtime.
    http: async () => Response.json([{ name: "b1" }]) })
  const submitted: unknown[] = []
  const controller = { design: createDesignWorld({ enabled: false }), live, terminalCards: provider.source,
    commands: { submit: async (input: unknown) => { submitted.push(input); return { status: "executed" } } } } as unknown as AppController
  const card = { id: "branch:b1", kind: "branch", title: "Branch", status: "active", createdAt: 1, ordinal: 1, payload: { id: "b1" } } as const
  const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
  const owner = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 }
  const metadata = { id: "b1", name: "retry-webhooks", machine: { state: "awake" }, ssh_line: "",
    presence: [{ actor: owner, where: { kind: "terminal", id: "t-ben" } }],
    terminals: [{ id: "t-ben", title: "Ben's shell", owner, agents: [], watchers: [], frozen: false }] }
  const host = document.createElement("div"), root = createRoot(host)
  const render = () => act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
  try {
    await render(); socket.onopen?.()
    for (const [topic, data] of [["branch:b1", metadata], ["branch:b1:activity", [{ id: "outside-burst", at: "2026-10-06T12:00:00Z", kind: "burst",
      actor: { id: "outside", kind: "outside", via: "tool" }, files: [{ path: "src/retry.ts", change: "modified" }] }]],
      ["branch:b1:files", { changed: [{ path: "src/retry.ts", change: "modified", last_writer: { id: "outside", kind: "outside", via: "tool" } }], open: [] }]] as const) {
      const frame = frames.find(frame => frame.topic === topic)!
      await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data }) }))
    }
    expect(host.textContent).toContain("changed outside Smithers")
    const subscriptions = frames.filter(frame => frame.topic === "branch:b1:activity").length
    const activityFrame = frames.find(frame => frame.topic === "branch:b1:activity")!
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "delta", id: activityFrame.id, cursor: 2, data: [{ id: "second-burst", at: "2026-10-06T12:01:00Z", kind: "burst", actor: { id: "outside", kind: "outside", via: "tool" }, files: [] }] }) }))
    expect(live.getSnapshot("branch:b1:activity")?.data).toHaveLength(2)
    expect(frames.filter(frame => frame.topic === "branch:b1:activity")).toHaveLength(subscriptions)
    expect(provider.source.branch("t-ben")).toBe("b1")
    const link = host.querySelector<HTMLButtonElement>('[data-flow="terminal.watch"]')!
    expect(link.textContent).toBe("Ben's shell")
    await act(async () => link.click())
    expect(submitted).toEqual([{ name: "terminal.watch", payload: { branch: "b1", id: "t-ben" }, actor: "user", originCardId: "branch:b1" }])
    viewer = undefined; await render()
    expect(host.querySelector('[data-flow="terminal.watch"]')).toBeNull()
  } finally { await act(async () => root.unmount()); provider.dispose(); live.dispose(); controller.design.dispose() }
})

test("live item gestures open only the supplied TODO and require its provider", () => {
  const model = definitionsOf(make(), "b-retry").model
  const { calls, dispatch } = recorder()
  cardActions(dispatch, liveBranchActionDefinitions(model, new Set())).onAction("todo", { n: "200" })
  expect(calls).toEqual([])
  const bindings = cardActions(dispatch, liveBranchActionDefinitions(model, new Set(["todo"])))
  expect(bindings.gestures.item?.tag).toBe("todo")
  bindings.onAction("todo", { n: "200" })
  expect(calls).toEqual([["todo", { n: 9 }]])
  expect(liveBranchActionDefinitions({ ...model, item: undefined }, new Set(["todo"]))).toEqual([])
  expect(liveBranchActionDefinitions({ ...model, machine: { state: "closed" } }, new Set(["todo"]))[0]?.gesture).toBe("item")
})
