import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"

/*
 * #3212: the platform refuses a secret bound to a wildcard or an address
 * range with a typed validation_failed on the hosts field. secrets.bind
 * states that refusal as the platform's own sentence, never as a success.
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

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("secrets seam — exact secret hosts", () => {
  test("states the platform's typed refusal of a wildcard or CIDR host", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = []
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (!url.includes("/secrets/")) return Response.json({ message: `no stub for ${url}` }, { status: 404 })
        const body = JSON.parse(String(init?.body)) as { hosts: string[] }
        requests.push({ url, body })
        const broad = body.hosts.find(host => host.startsWith("*.") || host.includes("/"))
        if (broad === undefined) return Response.json({ name: "DEPLOY_KEY", hosts: body.hosts }, { status: 200 })
        return Response.json({
          code: "validation_failed",
          fault: "user",
          message: `secret binding host "${broad}" must be an exact host name; wildcards and address ranges are refused`,
          errors: [{ resource: "Secret", field: "hosts", code: "invalid" }]
        }, { status: 422 })
      }
    }
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent, services)
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
    })
    await settled()
    const bind = (hosts: string) =>
      controller.commands.run("secrets.bind", JSON.stringify({ name: "DEPLOY_KEY", hosts, headers: "authorization" }))

    for (const host of ["*.ngrok-free.app", "127.0.0.0/8"]) {
      const result = await bind(`api.example.com, ${host}`)
      expect(result).not.toMatchObject({ status: "executed" })
      const said = JSON.stringify(result)
      expect(said).toContain(`must be an exact host name`)
      expect(said).toContain(host)
    }
    expect(requests.map(request => request.body)).toEqual([
      { hosts: ["api.example.com", "*.ngrok-free.app"], match_headers: ["authorization"] },
      { hosts: ["api.example.com", "127.0.0.0/8"], match_headers: ["authorization"] }
    ])
    expect(await bind("api.example.com")).toMatchObject({ status: "executed", value: "DEPLOY_KEY: api.example.com" })
  })
})
