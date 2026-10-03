import { describe, expect, test } from "bun:test"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import { CardSchema } from "@smthrs/rpc/Cards"
import { CARD_RENDERERS } from "../cards/CardRenderers"
import { cardAvailable } from "../state/CardAvailability"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, silentAgent } from "../state/TestFixtures"
import { FLOW_NAMES } from "./FlowName"
import { executeAgentToolCall } from "./agentTools"

const createAppController = scopedControllers()

// Literal oracle: mvp.md §8 and Appendix B Cut rows (2026-10-02), independent of the registry.
const CUT_NAMES = [
  "chat.clear",
  "tab.card",
  "tab.close",
  "tab.select",
  "world",
  "world.delete",
  "world.delete.cancel",
  "world.delete.confirm",
  "world.new-note",
  "world.select",
  "subagents",
  "flows",
  "connect",
  "smithers.who",
  "workspace.rename",
  "workspace.rename.edit",
  "app.first-run.dismiss",
  "notifications.read-update",
  "notifications.tag",
  "search.targets",
  "search.boxes",
  "box.select",
  "files.add",
  "change.request",
  "change.split",
  "change.revert",
  "prs.create",
  "issues",
  "issues.fix",
  "issues.verify",
  "issues.set",
  "issues.comment.react",
  "issues.comment.retry",
  "wiki.ask",
  "runs.takeover",
  "runs.release",
  "runs.handoff",
  "runs.burndown.filter",
  "runs.burndown.select",
  "agent.session.list",
  "agent.session.new",
  "agent.session.say",
  "agent.session.stop",
  "agent.session.view",
  "notifications.list",
  "notifications.read",
  "admin.grant",
  "admin.grant.confirm",
  "admin.grant.cancel",
  "admin.health",
  "repository.register",
  "signup.account",
  "signup.finish",
  "signup.next",
  "signup.repo",
  "signup.set",
  "setup.ask",
  "setup.configure",
  "setup.discard",
  "setup.discard.confirm",
  "setup.guide",
  "setup.retry",
  "setup.run",
  "setup.view",
  "setup.work",
  "issues.setup",
  "review.setup",
  "ci.setup",
  "feature.setup",
  "chores.setup",
  "feature.prototype",
  "system.recommend",
  "issue-sweep"
] as const
const CUT_KINDS = ["repository-setup", "admin-health", "registration", "notifications", "connect", "agent"] as const
const base = { id: "old-card", title: "Saved surface", status: "active", createdAt: 1, ordinal: 1 }

describe("Cut app surfaces", () => {
  test("the union, slash menu and agent catalog exclude every Cut door on both hosts", async () => {
    for (const host of ["local", "cloud"] as const) {
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const controller = createAppController(store, silentAgent, {
        bootstrap: { apiVersion: 1, host, version: "test", buildSha: "test",
          capabilities: [...RuntimeCapabilitySchema.options], authFlow: "both",
          sandbox: host === "local" ? { platform: "darwin", mode: "enforced" } : null }
      })
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
        login: "will", admin: true, scopesPlain: null }).isPersisted.promise
      const listed = JSON.parse(await executeAgentToolCall(controller.commands, {
        name: "commands", arguments: JSON.stringify({ action: "list" })
      })) as { commands: Array<{ name: string }> }
      for (const name of CUT_NAMES) {
        expect(FLOW_NAMES as readonly string[]).not.toContain(name)
        expect(controller.commands.find(name)).toBeUndefined()
        expect(listed.commands.map(command => command.name)).not.toContain(name)
        expect(controller.slashItems(name).map(row => row.flow.name)).not.toContain(name)
      }
      for (const name of ["admin.devtools", "admin.reset", "issue.poc", "issue.repro", "review.request",
        "billing.plans", "cloud.prompt", "repo.overview", "triggers.list", "box.services", "branches.list", "commits.list"]) {
        expect(controller.commands.find(name)).toBeDefined()
      }
      await controller.dispose()
    }
  }, 30_000)

  test("the retained administrator probe reads health without creating a health card", async () => {
    const requests: string[] = []
    const health = { status: "ok", database: { status: "ok" } }
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test",
        capabilities: [...RuntimeCapabilitySchema.options], authFlow: "both",
        sandbox: { platform: "darwin", mode: "enforced" } },
      fetchImpl: async input => {
        requests.push(new URL(String(input), "http://local.test").pathname)
        return Response.json(health)
      }
    })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
      login: "will", admin: true, scopesPlain: null }).isPersisted.promise
    const result = await controller.commands.run("debug.seams", "")
    expect(result).toMatchObject({ status: "executed", value: JSON.stringify(health) })
    expect(requests).toEqual(["/api/admin/system/health"])
    expect([...store.collections.cards.values()].some(card => String(card.kind) === "admin-health")).toBe(false)
    expect([...store.collections.messages.values()].some(message => message.text.includes("Seam health"))).toBe(true)
    await controller.dispose()
  }, 30_000)

  test.each([...CUT_KINDS])("old %s cards decode as inert history", kind => {
    const decoded = CardSchema.parse({ ...base, kind, body: "old markup", payload: { secret: "old feature data" } })
    expect(decoded).toEqual({ ...base, title: "", kind: "retired", status: "acted", loading: false, payload: {} })
    expect(cardAvailable(decoded.kind)).toBe(false)
    expect(Object.keys(CARD_RENDERERS)).not.toContain(kind)
    // T-CUT-01 Scope Matching rows: schema options remain until T-APP-22.
    expect(CardSchema.options.map(option => option.shape.kind.value)).toContain(kind)
    expect(cardAvailable(kind)).toBe(false)
  })

  test.each([...CUT_NAMES])("saved /%s forms decode as inert history", flow => {
    const decoded = CardSchema.parse({ ...base, kind: "flow-form",
      payload: { flow, via: "user", fields: [], draft: {}, given: {} } })
    expect(decoded.kind).toBe("retired")
    expect(decoded.payload).toEqual({})
    expect(decoded.title).toBe("")
    expect(cardAvailable(decoded.kind)).toBe(false)
  })

  test("cloud session listings retire while factory agents and shared confirmation remain renderable", () => {
    const cloud = CardSchema.parse({ ...base, kind: "agents", payload: { cloud: true, agents: [] } })
    expect(cloud.kind).toBe("retired")
    const factory = CardSchema.parse({ ...base, kind: "agents", payload: { native: true, agents: [] } })
    expect(factory.kind).toBe("agents")
    for (const kind of ["agents", "approval", "branches", "commit-list",
      "environment-images", "trigger-list", "world"]) expect(Object.keys(CARD_RENDERERS)).toContain(kind)
    for (const kind of ["grant-confirm", "balance", "billing-plans"] as const) {
      expect(Object.keys(CARD_RENDERERS)).not.toContain(kind)
      expect(cardAvailable(kind)).toBe(false)
      expect(CardSchema.options.map(option => option.shape.kind.value)).toContain(kind)
    }
  })
})
