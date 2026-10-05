/*
 * The shell's `branch` flow (T-APP-16 mount): the crumbs, the tree rows, a
 * slash and the agent reach the same door into the seeded design world.
 */
import { describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { designBranchTree, shellViewsOf } from "../../state/seams/DesignWorld/shell"
import { designHomeModel } from "../../state/seams/DesignWorld/home"
import { homeLine } from "../../ShellRail"
import { BEN, MAYA } from "../../state/seams/DesignWorld"

const memoryStorage = (): StorageApi => {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}
const agent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(done => setTimeout(done, 0)) }
const harness = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, agent, {
    fetchImpl: async () => Response.json({ code: "unknown", class: "infra", message: "Not available" }, { status: 404 })
  })
  return { store, controller }
}
const at = (controller: Awaited<ReturnType<typeof harness>>["controller"]) => shellViewsOf(controller.design).get(controller.design.viewer())?.at

describe("the shell's branch flow", () => {
  test("a branch by name, id or TODO ref moves the viewer there, records presence and opens its Branch card", async () => {
    const h = await harness()
    try {
      expect(at(h.controller)).toBeUndefined()
      const result = await h.controller.commands.run("branch", "retry-webhooks"); await tick()
      expect(result.status).toBe("executed")
      expect(at(h.controller)).toBe("b-retry")
      expect(h.controller.design.viewer()).toBe(MAYA)
      expect(h.controller.design.world().branches.find(each => each.id === "b-retry")?.presence.some(each => each.who === MAYA)).toBe(true)
      const card = h.store.collections.cards.get("branch:b-retry")
      expect(card).toMatchObject({ kind: "branch", title: "retry-webhooks", payload: { id: "b-retry" } })

      expect((await h.controller.commands.submit({ name: "branch", payload: { name: "T10" }, actor: "user" })).status).toBe("executed"); await tick()
      expect(at(h.controller)).toBe("b-checkout")
      expect(h.store.collections.cards.get("branch:b-checkout")).toMatchObject({ kind: "branch", title: "fix-checkout-race" })

      expect(await h.controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "branch", args: "b-stripe" }) })).toBe("Opened upgrade-stripe"); await tick()
      expect(at(h.controller)).toBe("b-stripe")
    } finally { await h.controller.dispose() }
  })

  test("?as=ben moves Ben and records Ben's presence, not Maya's", async () => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "location")
    Object.defineProperty(globalThis, "location", { value: { search: "?as=ben" }, configurable: true })
    let h: Awaited<ReturnType<typeof harness>>
    try { h = await harness() } finally {
      if (prior === undefined) Reflect.deleteProperty(globalThis, "location")
      else Object.defineProperty(globalThis, "location", prior)
    }
    try {
      expect(h.controller.design.viewer()).toBe(BEN)
      expect((await h.controller.commands.run("branch", "retry-webhooks")).status).toBe("executed"); await tick()
      expect(shellViewsOf(h.controller.design).get(BEN)?.at).toBe("b-retry")
      expect(shellViewsOf(h.controller.design).get(MAYA)).toBeUndefined()
      const presence = h.controller.design.world().branches.find(each => each.id === "b-retry")?.presence.map(each => each.who)
      expect(presence).toContain(BEN)
      expect(presence).not.toContain(MAYA)
    } finally { await h.controller.dispose() }
  })

  test("main is home: no card opens; an unknown branch is refused and moves nobody", async () => {
    const h = await harness()
    try {
      await h.controller.commands.run("branch", "retry-webhooks"); await tick()
      expect((await h.controller.commands.run("branch", "main")).status).toBe("executed"); await tick()
      expect(at(h.controller)).toBe("main")
      expect([...h.store.collections.cards.values()].filter(card => card.kind === "branch").map(card => card.id)).toEqual(["branch:b-retry"])

      const refused = await h.controller.commands.run("branch", "nope")
      expect(refused.status).toBe("failed")
      expect(JSON.stringify(refused)).toContain("No branch nope")
      expect(at(h.controller)).toBe("main")
      expect((await h.controller.commands.run("branch")).status).toBe("executed")
      expect(at(h.controller)).toBe("main")
    } finally { await h.controller.dispose() }
  })

  test("the tree reads main first, item branches in stack order with their TODO and state, and hides closed branches unless the viewer is there", async () => {
    const h = await harness()
    try {
      const world = h.controller.design.world()
      const [main] = designBranchTree(world, "main")
      expect(main).toMatchObject({ id: "main", name: "main", kind: "main", action: { tag: "branch", args: { name: "main" } } })
      expect(main!.children.map(node => [node.id, node.kind, node.todo, node.state])).toEqual([
        ["b-stripe", "item", 8, "in_review"], ["b-retry", "item", 9, "needs_you"], ["b-checkout", "item", 10, "working"], ["b-log", "item", 11, "queued"]
      ])
      expect(main!.children.every(node => node.action?.tag === "branch" && node.action.args?.name === node.id)).toBe(true)
      h.controller.design.patch("branches", "b-log", { machine: "closed" })
      expect(designBranchTree(h.controller.design.world(), "main")[0]!.children.map(node => node.id)).toEqual(["b-stripe", "b-retry", "b-checkout"])
      expect(designBranchTree(h.controller.design.world(), "b-log")[0]!.children.map(node => node.id)).toEqual(["b-stripe", "b-retry", "b-checkout", "b-log"])
      expect(homeLine({ kind: "seed", model: designHomeModel(world, MAYA, Date.now()) }))
        .toMatchObject({ title: world.repo.repo, summary: "1 need you · 1 working", tone: "attention" })
    } finally { await h.controller.dispose() }
  })
})
