/*
 * The Branch card's bindings (T-APP-10): which presses a branch offers, the
 * literal command input each press dispatches, and the card's mount through
 * the production renderer map. Expected values are literals, never read back
 * from the model or the catalog.
 */
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "@smthrs/rpc/Cards"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { cardActions } from "../flows/cardActions"
import { branchOf, createDesignWorld, MAYA, todoOf, type DesignTimers, type DesignWorld } from "../state/seams/DesignWorld"
import { designBranchModel } from "../state/seams/DesignWorld/branch"
import { branchActionDefinitions, changeActionDefinitions } from "./BranchCard"
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

test("a hosted Branch never renders the seeded model without its live topics", () => {
  const controller = { design: make(), bootstrap: { host: "local" } } as unknown as AppController
  const card = { id: "branch:b-retry", kind: "branch", title: "Branch", status: "active", createdAt: 1, ordinal: 1, payload: { id: "b-retry" } } as const
  const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
  expect(renderToStaticMarkup(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>)).toBe("")
})
