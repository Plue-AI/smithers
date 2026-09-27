/*
 * smithers.who, the name proof (Concierge L1).
 *
 * The identity is a constant the app renders, never a sentence a model
 * composes: the human's slash and the agent's tool call must read the same
 * line, on every host, and the line must name only helpers this host has.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"

import type { AgentPort } from "../runtime/AgentPort"
import { SMITHERS_HELPERS } from "../Onboarding"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { executeAgentToolCall } from "./agentTools"
import { modelInvocable } from "./registry"

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


const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: false }),
  authFlow: "redirect",
  sandbox: null
}

const NATIVE: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "local",
  capabilities: localCapabilities({ agent: true, identity: true, cloud: true, nativeShell: true }),
  authFlow: "native-handoff",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const freshController = async (bootstrap: AppBootstrap) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return { store, controller: createAppController(store, unavailableAgent, { bootstrap }) }
}

const smithersMessages = (store: Awaited<ReturnType<typeof freshController>>["store"]): ReadonlyArray<string> =>
  [...store.collections.messages.values()].filter((message) => message.role === "smithers").map((message) => message.text)

describe("smithers.who", () => {
  test("registers on both hosts as a visible, model-invocable flow under the smithers namespace", async () => {
    for (const bootstrap of [WEB, NATIVE]) {
      const { controller } = await freshController(bootstrap)
      const entry = controller.commands.find("smithers.who")
      expect(entry).toBeDefined()
      if (entry === undefined) continue
      expect(entry.metadata.hidden).not.toBe(true)
      expect(modelInvocable(entry)).toBe(true)
      expect(controller.slashTree("smithers.").map((row) => (row.kind === "flow" ? row.flow.name : row.kind === "namespace" ? row.namespace.id : row.text))).toEqual([
        "smithers.who"
      ])
    }
  })

  test("the human's slash renders the identity line as a Smithers message that names the host", async () => {
    const { store, controller } = await freshController(WEB)
    const before = smithersMessages(store).length
    const outcome = await controller.commands.run("smithers.who")
    expect(outcome.status).toBe("executed")
    const texts = smithersMessages(store)
    expect(texts).toHaveLength(before + 1)
    const line = texts[texts.length - 1] ?? ""
    // Nothing is selected and nothing is open: the honest no-repository sentence.
    expect(line.startsWith("I am Smithers, the concierge of the Smithers web app; no repository is open yet.")).toBe(true)
    expect(line).not.toContain("Smith Smithers")
    // No helper flow is registered yet, so none is named: an honest hand-off line instead.
    for (const helper of SMITHERS_HELPERS) {
      expect(controller.commands.find(helper.flow)).toBeUndefined()
      expect(line).not.toContain(helper.line)
    }
    expect(line).toContain("I answer this chat myself")
  })

  test("a selected repository is the one Smithers is concierge for, before any checkout is open", async () => {
    // The signed-out visitor at /smithersai/smithers: the catalog row is loaded and selected (RepoLink.ts).
    const { store, controller } = await freshController(WEB)
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: null, catalog: true }]
    })
    store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" })
    expect(store.session().activeRepoKey).toBe("smithersai/smithers")
    const outcome = await controller.commands.run("smithers.who")
    expect(outcome.status).toBe("executed")
    const line = smithersMessages(store).at(-1) ?? ""
    expect(line.startsWith("I am Smithers, the concierge for smithersai/smithers in the Smithers web app.")).toBe(true)
    expect(line).not.toContain("no repository is open yet")
  })

  test("the native host reads as the native app, with its harnesses from the same facts the opening message reads", async () => {
    const { store, controller } = await freshController(NATIVE)
    store.dispatch({
      type: "harnesses.loaded",
      actor: "system",
      harnesses: [{
        id: "claude",
        displayName: "Claude Code",
        binary: "/usr/local/bin/claude",
        version: "2.0.0",
        status: "signed-in",
        account: { email: "will@example.com" },
        launch: { argv: ["claude"] }
      }]
    })
    await controller.commands.run("smithers.who")
    const line = smithersMessages(store).at(-1) ?? ""
    expect(line).toContain("the concierge of the native Smithers app")
    expect(line).toContain("Local harnesses: Claude Code (signed-in, will@example.com).")
  })

  test("the agent's tool call reads the same line it rendered", async () => {
    const { store, controller } = await freshController(WEB)
    const result = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "smithers.who" })
    })
    const line = smithersMessages(store).at(-1) ?? ""
    expect(line).toContain("I am Smithers")
    expect(result).toContain(line)
  })
})
