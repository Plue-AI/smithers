/*
 * The three-door law (apps/app/AGENTS.md; .specs/engineering/spec.md §6.1):
 * every act is ONE flow with three doors — slash, button, agent. `userOnly`
 * is an enumerated exception for acts that are physically the human's
 * gesture or that the human alone may answer, and every such flow names its
 * reason in the registry. Consequential acts are agent-invocable WITH
 * `confirm`; they are never user-only because they are consequential.
 *
 * Will, 2026-09-03, after the agent said "I can't launch a Claude code
 * session": "anything we can do in the ui the agent should be able to do too".
 * This file is that rule as a gate: the allowlist below is every user-only
 * flow with its reason, and nothing else may be user-only.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { STORAGE_RECOVERY_USER_ONLY_REASON, STORAGE_RESET_USER_ONLY_REASON } from "../state/StorageRecoveryContract"
import { modelInvocable, nameOf } from "./registry"
import { HISTORY_LAND_USER_ONLY_REASON, HISTORY_RETRY_USER_ONLY_REASON } from "./entries/history"
import { PALETTE_ACTIONS_REASON, PALETTE_OPEN_REASON } from "./entries/palette"
import { WIKI_ATTACH_USER_ONLY_REASON, WIKI_HEADING_USER_ONLY_REASON } from "@smthrs/ui/app-operations/wiki"

/**
 * Every user-only flow, with the reason the registry states. A flow user-only
 * for a reason not written here fails the gate; a flow written here that is
 * no longer user-only fails it too.
 */
const USER_ONLY_ALLOWLIST: Readonly<Record<string, string>> = {
  "storage.recovery.export": STORAGE_RECOVERY_USER_ONLY_REASON,
  "storage.recovery.reset": STORAGE_RESET_USER_ONLY_REASON,
  "chat.queue": "the prompt queue is the human's composer",
  "chat.queue.edit": "the prompt queue is the human's composer",
  "chat.queue.remove": "the prompt queue is the human's composer",
  "chat.queue.restore": "the prompt queue is the human's composer",
  "chat.queue.resume": "the prompt queue is the human's composer",
  "chat.send": "the composer is the human's; the model is already the turn, and sending would nest one",
  "chat.stop": "stopping the model's own turn is the human's Escape key",
  "chat.copy-message": "the clipboard write is the human's browser gesture",
  "wiki.pane": "a surface switch; the model reads the wiki with wiki and wiki.cloud, which answer as embedded cards",
  "flow.repo.choose": "the answer to the which-repository card is the human's choice; a model must not provision on its guess",
  "card.maximize": "maximizing a card is the human's explicit act (THE EMBED LAW)",
  "card.minimize": "minimizing a card is the human's explicit act",
  "frame.back": "frame navigation is the human's browser gesture",
  "frame.forward": "frame navigation is the human's browser gesture",
  "wiki.delete.confirm": "a confirm-dialog answer is the human's",
  "confirm.cancel": "a confirmation answer belongs to the person",
  "wiki.delete.cancel": "a confirm-dialog answer is the human's",
  "wiki.heading": WIKI_HEADING_USER_ONLY_REASON,
  "history.retry": HISTORY_RETRY_USER_ONLY_REASON,
  "history.land": HISTORY_LAND_USER_ONLY_REASON,
  "wiki.attach": WIKI_ATTACH_USER_ONLY_REASON,
  // The hidden world.* aliases (entries/world.ts) carry their wiki.* twins' reason.
  "auth.sign-in": "sign-in is the human's browser gesture; the agent renders the step with auth.prompt",
  "auth.sign-out": "dropping the human's session is theirs alone",
  "cloud.sign-in": "the Smithers Cloud browser login is the human's gesture on their account; the agent renders the step with cloud.prompt",
  "cloud.sign-out": "dropping the human's Smithers Cloud credential is theirs alone",
  "toast.dismiss": "dismissing a toast is the human's gesture",
  "repo.select": "which pinned repository is active is the human's selection",
  "chat.open": "opening Chat and starting the selected microphone mode is the human's gesture",
  "chat.dictate": "microphone capture is the human's explicit gesture",
  "palette.open": PALETTE_OPEN_REASON,
  "palette.actions": PALETTE_ACTIONS_REASON,
  "admin.reset": "destroys the whole store with no undo; the confirm dialog is the only door",
  "admin.reset.ask": "opens the human's confirm dialog for the reset",
  "admin.reset.cancel": "a confirm-dialog answer is the human's",
  "billing.upgrade": "external checkout with real money; the human clicks",
  "billing.portal": "the external billing portal; the human clicks",
  "admin.devtools": "the admin panel's presentation toggle",
  "debug.backend": "admin diagnostics; the agent must never reason about its engine",
  "approval.approve": "approvals belong to the human",
  "triggers.approve": "approvals belong to the human",
  "approval.deny": "approvals belong to the human",
  "runs.continue": "approvals belong to the human"
}

/** The policy table's agent rows (.specs/engineering/spec.md §6.1): the args exercised and whether the act confirms. */
const AGENT_ROWS: ReadonlyArray<{ readonly name: string; readonly args?: string; readonly confirm: boolean }> = [
  { name: "todo", args: "T12", confirm: false },
  { name: "todo.new", args: "A TODO", confirm: false },
  { name: "todo.answer", args: "T12 Yes", confirm: false },
  { name: "todo.steer", args: "T12 Keep the tests", confirm: false },
  { name: "todo.amend", args: "T12 Amend the prompt", confirm: true },
  { name: "todo.stop", args: "T12", confirm: false },
  { name: "todo.resume", args: "T12", confirm: false },
  { name: "todo.retry", args: "T12", confirm: false },
  { name: "todo.drop", args: "T12", confirm: true },
  { name: "runs.trace.filter", args: "run-1 failed", confirm: false },
  { name: "runs.trace.select", args: "run-1 frame-1", confirm: false },
  { name: "runs.trace.view", args: "run-1 turns", confirm: false },
  { name: "runs.trace.live", args: "run-1", confirm: false },
  { name: "runs.coding.select", args: "run-1 storage", confirm: false },
  /* The issue-sweep board's reader state is free; starting the sweep launches agents, so it confirms. */
  { name: "repo.tree", args: "shared:will/smithers", confirm: false },
  { name: "change.pins", args: "c1 parent current", confirm: false },
  { name: "change.checks", args: "c1 1", confirm: false },
  { name: "box.facet", args: "ws-1 files", confirm: false },
  { name: "change.facet", args: "c1 diff", confirm: false },
  { name: "flow.run.retry", args: "card-1", confirm: true },
  { name: "runs.rerun", args: "sourceCard=card-1 run-1", confirm: true },
  { name: "cloud.prompt", confirm: false },
  /* Agents as data (custom-agents.md): listing and the form render cards; defining what spends money confirms. */
  { name: "agent.list", confirm: false },
  /*
   * The cloud agent sessions (UI-COVERAGE-GAPS.md "agents · Cloud agent
   * sessions"): the reads are free; launching a sandbox agent, steering it
   * with a follow-up (dispatches its next run) and stopping it all confirm.
   */
  /* Code intelligence (docs/code-intel/PLAN.md §4): reads over the workspace LSP tunnel; none confirms. */
  { name: "code.hover", args: "src/index.ts:3:7", confirm: false },
  { name: "code.definition", args: "src/index.ts:3:17", confirm: false },
  { name: "code.diagnostics", args: "src/index.ts", confirm: false }
]

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

/** Every host capability at once, so the gate covers every registerable flow. */
const EVERYTHING: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: [...RuntimeCapabilitySchema.options],
  authFlow: "both",
  sandbox: { platform: "darwin", mode: "enforced" }
}

/** The web host with every door it can grow: the flows scoped to `hosts: ["cloud"]` register only here. */
const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true }),
  authFlow: "redirect",
  sandbox: null
}

const settle = async (ticks = 6): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * The whole app under EVERYTHING as an admin (so the admin plugin registers),
 * signed in to GitHub (so the requirement axis never intercepts), with two
 * repositories, a card tab and a card.
 */
const boot = async (bootstrap: AppBootstrap = EVERYTHING) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let picks = 0
  
  const controller = createAppController(store, unavailableAgent, {
    features: {},
    bootstrap,
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      if (path === "/api/repos/will/smithers/contents") return json(200, [])
      return json(404, { status: "error", message: `no stub for ${path}` })
    }
  })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    admin: true,
    scopesPlain: null
  })
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
    { id: "will/smithers", org: "will", name: "smithers", ownerKind: "user", head: null, catalog: true },
    { id: "will/force", org: "will", name: "force", ownerKind: "user", head: null }
  ] })
  store.dispatch({ type: "repo.selected", actor: "user", id: "will/smithers" })
  store.dispatch({
    type: "tab.opened",
    actor: "user",
    tab: { id: "t1", kind: "card", title: "Pinned", cardId: "card-t1" }
  })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: { id: "card-1", kind: "status", title: "Status", status: "active", createdAt: 1, ordinal: 0, payload: { progress: 0.5 } }
  })
  await settle()
  return { store, controller, picks: () => picks }
}

/** The production agent door (turns.ts continueToolLeg): one tool call, run as actor smithers. */
const execute = (controller: Awaited<ReturnType<typeof boot>>["controller"], name: string, args?: string) =>
  controller.commands.executeForAgent({
    name: "commands",
    arguments: JSON.stringify({ action: "execute", name, ...(args === undefined ? {} : { args }) })
  })

const messages = (store: AppStore) =>
  [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal)

const confirmationFor = (store: AppStore, flow: string) =>
  messages(store).find((message) => message.action?.flow === flow)

const cloudSession = (store: AppStore, state: "signed-in" | "signed-out", username: string | null): void => {
  store.dispatch({ type: "cloud.session.loaded", actor: "system", state, username, expiresAt: null, scopes: null })
}

describe("the three-door law", () => {
  test("every user-only flow is in the allowlist with its reason, and the allowlist holds nothing else", async () => {
    // Both hosts, so a flow scoped to one of them (app.download is the web's) is gated too.
    const native = await boot()
    const web = await boot(WEB)
    const userOnly = [...native.controller.commands.entries(), ...web.controller.commands.entries()]
      .filter((entry) => !modelInvocable(entry))
    const found = Object.fromEntries(
      userOnly.map((entry) => [nameOf(entry), entry.metadata.userOnlyReason]).sort(([left], [right]) => String(left).localeCompare(String(right)))
    )
    const expected = Object.fromEntries(Object.entries(USER_ONLY_ALLOWLIST).sort(([left], [right]) => left.localeCompare(right)))
    expect(found).toEqual(expected)
    // The admin plugin registered, so the admin rows above were really checked.
    expect(userOnly.some((entry) => nameOf(entry) === "admin.reset")).toBe(true)
  })

  test("every agent row of the policy table is invocable through the tool; a confirm row yields the confirm card, never a refusal", async () => {
    const { store, controller } = await boot()
    for (const row of AGENT_ROWS) {
      const result = await execute(controller, row.name, row.args)
      expect(`${row.name}: ${result}`).not.toContain("is user-only")
      expect(`${row.name}: ${result}`).not.toStartWith(`${row.name}: unknown-command`)
      if (!row.confirm) continue
      expect(`${row.name}: ${result}`).toContain("asked the user to confirm")
      const confirmation = confirmationFor(store, row.name)
      expect(`${row.name} confirmation`).toBe(`${row.name} ${confirmation === undefined ? "missing" : "confirmation"}`)
      expect(confirmation?.action?.args).toBe(row.args)
    }
  })

  test("cloud.prompt renders the Smithers Cloud sign-in step; signed in it says so", async () => {
    const { store, controller } = await boot()
    cloudSession(store, "signed-out", null)
    await settle(2)
    expect(await execute(controller, "cloud.prompt")).toBe("executed /cloud.prompt")
    const step = confirmationFor(store, "cloud.sign-in")
    expect(step?.action).toEqual({ flow: "cloud.sign-in", label: "Sign in to Smithers Cloud" })
    expect(step?.role).toBe("smithers")
    cloudSession(store, "signed-in", "will")
    await settle(2)
    expect(await execute(controller, "cloud.prompt")).toBe("executed /cloud.prompt")
    expect(messages(store).at(-1)?.text).toBe("Smithers Cloud is already signed in as will.")
  })

  test("a cloud refusal offers the current host sign-in button and names cloud.prompt to the agent", async () => {
    const { store, controller } = await boot()
    cloudSession(store, "signed-out", null)
    await settle(2)
    const agent = await execute(controller, "box.terminal")
    expect(agent).toStartWith("failed: Sign in to Smithers Cloud to continue")
    expect(agent).toContain("cloud.prompt")
    expect(agent).not.toContain("/cloud.sign-in")
    const human = await controller.commands.run("box.terminal")
    expect(human).toEqual({ status: "failed", error: "Sign in to Smithers Cloud to continue." })
  })

  for (const host of [EVERYTHING, WEB]) {
    test(`missing Cloud session renders only a registered sign-in door on ${host.host}`, async () => {
      const { store, controller } = await boot(host)
      cloudSession(store, "signed-out", null)
      const flow = host.host === "cloud" ? "auth.sign-in" : "cloud.sign-in"
      try {
        for (const name of ["box.terminal", "change.view"] as const) {
          const outcome = await controller.commands.run(name, name === "change.view" ? "change-1" : undefined)
          expect(outcome).toEqual({ status: "failed", error: "Sign in to Smithers Cloud to continue." })
          const step = messages(store).at(-1)
          expect(step?.action?.flow).toBe(flow)
          expect(controller.commands.find(step!.action!.flow)).toBeDefined()
          expect(step?.text).not.toContain("/cloud.sign-in")
        }
        expect(await execute(controller, "box.terminal")).toContain("cloud.prompt")
        expect(messages(store).at(-1)?.action?.flow).toBe(flow)
      } finally { controller.dispose() }
    })
  }

  test("a user-only refusal quotes the registry's reason and the agent's door", async () => {
    const { controller } = await boot()
    const cloud = await execute(controller, "cloud.sign-in")
    expect(cloud).toContain(USER_ONLY_ALLOWLIST["cloud.sign-in"])
    expect(cloud).toContain("invoke cloud.prompt, which renders that button in the chat")
    // The typed agent door answers the same text.
    const typed = await controller.commands.runForAgent("auth.sign-in")
    expect(typed).toEqual({ status: "failed", error: `failed: /auth.sign-in is user-only — ${USER_ONLY_ALLOWLIST["auth.sign-in"]} — invoke auth.prompt, which renders that button in the chat` })
  })

  test("flow authoring and card acts remain callable through the agent", async () => {
    const { controller } = await boot()
    const callable = new Set(controller.commands.callable().map(nameOf))
    for (const name of ["flow.create", "agent.list", "form.set", "form.submit", "card.dismiss"]) {
      expect(callable.has(name)).toBe(true)
    }
    // And listed: the slash menu and the prompt's catalog show them.
    const disclosed = new Set(controller.commands.disclosed().map((descriptor) => descriptor.name))
    for (const name of ["flow.create", "cloud.prompt", "agent.list"]) {
      expect(disclosed.has(name)).toBe(true)
    }
    expect(disclosed.has("flow.run.retry")).toBe(false)
    // The form card's acts (THE FORM LAW) are hidden from the catalog and callable, like every id-scoped card act.
    for (const name of ["form.set", "form.submit", "card.dismiss"]) expect(disclosed.has(name)).toBe(false)
  })
})



test("versioned flow doors stay dark without projection, TODO and private confirmation providers", async () => {
  const { flowVersionFlows } = await import("./entries/flow")
  const entries = flowVersionFlows()
  expect(entries.map(nameOf)).toEqual(["flow", "flow.edit", "flow.source"])
  expect(entries.every(modelInvocable)).toBe(true)
  const edit = entries[1]!
  expect(edit.metadata.confirm).toBe("change this flow")
  expect(edit.metadata.grammar?.("todo")).toEqual({ payload: { name: "todo" } })
  expect(edit.metadata.grammar?.("todo Add review")).toEqual({ payload: { name: "todo", request: "Add review" } })
  expect(edit.metadata.form?.args?.({ name: "todo", request: "Add review" })).toBe("todo Add review")
  const { store, controller } = await boot()
  for (const name of ["flow", "flow.source", "flow.edit"]) {
    expect(controller.commands.find(name)).toBeUndefined()
    expect((await controller.commands.run(name, "todo Add review")).status).toBe("unknown-command")
    expect(await execute(controller, name, "todo Add review")).toStartWith("unknown-command:")
  }
  expect(confirmationFor(store, "flow.edit")).toBeUndefined()
  expect([...store.collections.cards.values()].some(card => card.kind === "todo" || card.kind === "run-trace")).toBe(false)
})
