import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { nameOf } from "./registry"

/*
 * The code-intel flows (docs/code-intel/PLAN.md §4): `code.hover`,
 * `code.definition` and `code.diagnostics` are one act each with the three
 * doors, none user-only, none confirming (they read). Their door is the
 * language server plue runs inside the workspace VM, reached over the
 * `cloud.terminal` tunnel (state/CloudLspClient.ts), so BOTH hosts list them
 * wherever that tunnel is open and a host without it gets the origin refusal,
 * never a pointer at the native app.
 */

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


/** The Bun server with the Smithers Cloud upstream configured: the tunnel is open. */
const NATIVE: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: localCapabilities({ agent: true, identity: true, cloud: true }),
  authFlow: "both",
  sandbox: null
}

/** The Worker with the workspace terminal relay on. */
const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true }),
  authFlow: "redirect",
  sandbox: null
}

/** The same Worker with the relay off: the one door these flows need is shut. */
const WEB_WITHOUT_TUNNEL: AppBootstrap = {
  ...WEB,
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false })
}

const CODE_FLOWS = ["code.hover", "code.definition", "code.diagnostics"] as const

const controllerFor = async (bootstrap: AppBootstrap) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return createAppController(store, unavailableAgent, { bootstrap })
}

describe("code intelligence stays dark until guest validation lands", () => {
  for (const [label, bootstrap] of [["native", NATIVE], ["web", WEB], ["no tunnel", WEB_WITHOUT_TUNNEL]] as const) {
    test(`${label} exposes no code action merely because a tunnel exists`, async () => {
      const controller = await controllerFor(bootstrap)
      try {
        const callable = new Set(controller.commands.callable().map(nameOf))
        const disclosed = new Set(controller.commands.disclosed().map(item => item.name))
        for (const name of CODE_FLOWS) {
          expect(controller.commands.find(name)).toBeUndefined()
          expect(callable.has(name)).toBe(false)
          expect(disclosed.has(name)).toBe(false)
        }
      } finally {
        await controller.dispose()
      }
    })
  }
})
