import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
  // Appendix B.835 cuts the old native-states `issues` door; the name now ships as Appendix A's `/issues` list (B.834 Keep), so it is not a Cut name.
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
const CUT_KINDS = ["repository-setup", "admin-health", "registration", "notifications", "connect", "agent", "grant-confirm"] as const
const base = { id: "old-card", title: "Saved surface", status: "active", createdAt: 1, ordinal: 1 }

describe("Cut app surfaces", () => {
  test("the shared cut manifest records every pinned retired door", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../../../packages/rpc/src/catalog/cuts.json", import.meta.url), "utf8")) as {
      rows: Array<{ flowNames: string[] }>
    }
    expect(manifest.rows.flatMap(row => row.flowNames).sort()).toEqual([...CUT_NAMES].sort())
  })

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
        const path = new URL(String(input), "http://local.test").pathname
        if (path === "/api/install") return new Response(null, { status: 404 })
        requests.push(path)
        return Response.json(health)
      }
    })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
      login: "will", admin: true, scopesPlain: null }).isPersisted.promise
    const result = await controller.commands.run("debug.seams", "")
    expect(result).toMatchObject({ status: "executed", value: JSON.stringify(health) })
    // Signing in refreshes install status independently of the explicit probe.
    expect(requests.filter(path => path !== "/api/install")).toEqual(["/api/admin/system/health"])
    expect([...store.collections.cards.values()].some(card => String(card.kind) === "admin-health")).toBe(false)
    expect([...store.collections.messages.values()].some(message => message.text.includes("Seam health"))).toBe(true)
    await controller.dispose()
  }, 30_000)

  test.each([...CUT_KINDS])("old %s cards decode as inert history", kind => {
    const decoded = CardSchema.parse({ ...base, kind, body: "old markup", payload: { secret: "old feature data" } })
    expect(decoded).toEqual({ ...base, kind: "retired", status: "acted", loading: false, payload: { was: kind } })
    expect(cardAvailable(decoded.kind)).toBe(false)
    expect(Object.keys(CARD_RENDERERS)).not.toContain(kind)
    // Removed kinds have no current schema; availability reads the decoded tombstone.
    expect(CardSchema.options.map(option => option.shape.kind.value)).not.toContain(kind)
    expect(cardAvailable(kind)).toBe(true)
  })

  test("deferred stack and factory home cards decode live but stay unavailable", () => {
    const rows = [
      { kind: "stack" as const, payload: { repo: "smithersai/smithers", failure: null } },
      { kind: "factory.home" as const, payload: { repo: "smithersai/smithers", home: { kind: "error" as const, message: "Unavailable" }, flows: [] } }
    ]
    for (const row of rows) {
      const decoded = CardSchema.parse({ ...base, ...row })
      expect(decoded.kind).toBe(row.kind)
      expect(decoded.payload).toEqual(row.payload)
      expect(cardAvailable(decoded.kind)).toBe(false)
    }
  })

  test.each([...CUT_NAMES])("saved /%s forms decode as inert history", flow => {
    const decoded = CardSchema.parse({ ...base, kind: "flow-form",
      payload: { flow, via: "user", fields: [], draft: {}, given: {} } })
    expect(decoded.kind).toBe("retired")
    expect(decoded.payload).toEqual({ was: "flow-form" })
    expect(decoded.title).toBe(base.title)
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
      expect(cardAvailable(kind)).toBe(true)
      expect(CardSchema.options.some(option => option.shape.kind.value === kind)).toBe(kind !== "grant-confirm")
    }
  })
})
