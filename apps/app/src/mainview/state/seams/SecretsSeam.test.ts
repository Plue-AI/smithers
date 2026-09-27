import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The secrets seam (SecretsSeam.ts) through the real command path:
 * /secrets.list reads GET /api/repos/{owner}/{repo}/agent-environment and
 * surfaces the "secrets" card with each secret's metadata (name, hosts,
 * match headers, updated time) and a model-readable result, never secret
 * values. Failures are honest strings, never throws; signed out, the agent
 * door names the sign-in step.
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


const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

type Failure = "empty" | "get-500" | "get-403" | "get-throw" | "malformed"

/** The platform double: plue's AgentEnvironmentResponse plus an unexpected secret value to verify metadata-only parsing. */
const backend = (failure?: Failure) => {
  const requests: Array<{ readonly method: string; readonly url: string }> = []
  const services: AppServices = {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"
      if (!url.includes("/agent-environment")) {
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
      requests.push({ method, url })
      if (failure === "get-throw") throw new Error("socket hang up")
      if (failure === "get-500") return json(500, { message: "the platform fell over" })
      if (failure === "get-403") return json(403, { message: "forbidden: repository write access required" })
      if (failure === "malformed") return json(200, { setup_script: "", env: [], secrets: [{ hosts: [] }] })
      return json(200, {
        setup_script: "bun install",
        env: [{ name: "CI", value: "1" }],
        secrets: failure === "empty" ? [] : [
          {
            name: "NPM_TOKEN",
            value: "DO_NOT_EXPOSE_SECRET_BYTES",
            hosts: ["registry.npmjs.org"],
            match_headers: ["authorization"],
            updated_at: "2026-08-01T00:00:00.000Z"
          },
          { name: "SETUP_ONLY", hosts: [], match_headers: [], updated_at: "2026-08-02T00:00:00.000Z" }
        ],
        updated_at: "2026-08-02T00:00:00.000Z"
      })
    }
  }
  return { services, requests }
}

const freshController = async (failure?: Failure) => {
  const stub = backend(failure)
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    requests: stub.requests,
    controller: createAppController(store, unavailableAgent, stub.services)
  }
}

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const signedOut = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
}

const ready = async (store: AppStore): Promise<void> => {
  await signedIn(store)
  await reposChosen(store)
}

const secretsCard = (store: AppStore, repo = "will/flows") => {
  const card = store.collections.cards.get(`secrets-${repo}`)
  if (card === undefined || card.kind !== "secrets") return undefined
  return card
}

describe("secrets seam — secrets.list", () => {
  test("surfaces the secrets card from the agent-environment answer: name, hosts, header, updated time, no secret value", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("executed")
    const value = outcome.status === "executed" ? outcome.value : undefined
    for (const text of ["will/flows", "NPM_TOKEN", "registry.npmjs.org", "authorization", "2026-08-01T00:00:00.000Z", "SETUP_ONLY"]) {
      expect(value).toContain(text)
    }
    expect(value).not.toContain("DO_NOT_EXPOSE_SECRET_BYTES")
    expect(value).not.toContain("bun install")
    await settled()

    expect(requests).toEqual([{ method: "GET", url: "/api/repos/will/flows/agent-environment" }])
    const card = secretsCard(store)
    expect(card).toBeDefined()
    expect(card?.title).toBe("Secrets · will/flows")
    expect(card?.status).toBe("active")
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.scope).toBe("repository")
    expect(card?.payload.secrets).toEqual([
      { name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], matchHeaders: ["authorization"], updatedAt: "2026-08-01T00:00:00.000Z" },
      { name: "SETUP_ONLY", hosts: [], matchHeaders: [], updatedAt: "2026-08-02T00:00:00.000Z" }
    ])
    // The environment's vars and setup script are the env card's, not this one's.
    expect(JSON.stringify(card)).not.toContain("DO_NOT_EXPOSE_SECRET_BYTES")
    expect(JSON.stringify(card)).not.toContain("bun install")
    expect(JSON.stringify(card)).not.toContain("\"CI\"")
  })

  test("the agent receives an explicit empty secrets list", async () => {
    const { store, controller } = await freshController("empty")
    await ready(store)
    const outcome = await controller.commands.runForAgent("secrets.list")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe("No secrets in will/flows.")
  })

  test("an explicit owner/repo argument targets that repository", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("secrets.list", "acme/site")
    expect(outcome.status).toBe("executed")
    expect(requests[0]?.url).toBe("/api/repos/acme/site/agent-environment")
    expect(secretsCard(store, "acme/site")).toBeDefined()
  })

  test("listing twice re-surfaces the one card at a later ordinal, never a second card", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    await controller.commands.run("secrets.list")
    const first = secretsCard(store)?.ordinal
    await controller.commands.run("secrets.list")
    const cards = [...store.collections.cards.values()].filter((card) => card.kind === "secrets")
    expect(cards).toHaveLength(1)
    expect(cards[0]?.ordinal).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY)
  })

  test("the agent's door reads the same list", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.runForAgent("secrets.list")
    expect(outcome.status).toBe("executed")
    const value = outcome.status === "executed" ? outcome.value : undefined
    for (const text of ["will/flows", "NPM_TOKEN", "registry.npmjs.org", "authorization", "2026-08-01T00:00:00.000Z", "SETUP_ONLY"]) {
      expect(value).toContain(text)
    }
    expect(value).not.toContain("DO_NOT_EXPOSE_SECRET_BYTES")
    expect(value).not.toContain("bun install")
    expect(requests).toHaveLength(1)
    expect(secretsCard(store)?.payload.secrets.map((secret) => secret.name)).toEqual(["NPM_TOKEN", "SETUP_ONLY"])
  })

  test("an inventory-less signed-in session answers the repo-resolution error as-is", async () => {
    const { store, controller, requests } = await freshController()
    await signedIn(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo"
      )
    }
    expect(requests).toHaveLength(0)
  })

  test("signed out, the agent's invocation names the sign-in step and reads nothing", async () => {
    const { store, controller, requests } = await freshController()
    await signedOut(store)
    const outcome = await controller.commands.runForAgent("secrets.list", "will/flows")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("Sign in with GitHub first")
    expect(requests).toHaveLength(0)
    expect(secretsCard(store)).toBeUndefined()
  })
})

describe("secrets seam — honest failures", () => {
  test("a 403 answers the platform's message and surfaces no card", async () => {
    const { store, controller } = await freshController("get-403")
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("forbidden: repository write access required")
    expect(secretsCard(store)).toBeUndefined()
  })

  test("a 500 answers the platform's message, never a throw", async () => {
    const { store, controller } = await freshController("get-500")
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the platform fell over")
    expect(secretsCard(store)).toBeUndefined()
  })

  test("a network throw answers an honest string", async () => {
    const { store, controller } = await freshController("get-throw")
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The agent environment for will/flows couldn't be read — the platform didn't answer.")
    }
  })

  test("a malformed answer names the shape problem and surfaces no card", async () => {
    const { store, controller } = await freshController("malformed")
    await ready(store)
    const outcome = await controller.commands.run("secrets.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The agent-environment answer for will/flows wasn't in the expected shape.")
    }
    expect(secretsCard(store)).toBeUndefined()
  })
})

describe("secrets seam — secrets.scope", () => {
  test("marks a repository secret main-only and names the stored scope", async () => {
    const requests: Array<{ readonly method: string; readonly url: string; readonly body: unknown }> = []
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (!url.includes("/secrets/")) return json(404, { message: `no stub for ${url}` })
        const body = JSON.parse(String(init?.body)) as { main_only: boolean }
        requests.push({ method: init?.method ?? "GET", url, body })
        if (url.endsWith("/MISSING")) return json(404, { message: "secret not found" })
        return json(200, { name: "DEPLOY", main_only: body.main_only })
      }
    }
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent, services)
    await ready(store)
    const marked = await controller.commands.run("secrets.scope", "DEPLOY main-only")
    expect(marked).toMatchObject({ status: "executed", value: "DEPLOY: main only" })
    expect(requests[0]).toMatchObject({ method: "PATCH", body: { main_only: true } })
    expect(requests[0]!.url).toEndWith("/api/repos/will/flows/secrets/DEPLOY")
    expect(await controller.commands.run("secrets.scope", "DEPLOY all")).toMatchObject({ status: "executed", value: "DEPLOY: every run" })
    expect(requests[1]).toMatchObject({ body: { main_only: false } })
    const missing = await controller.commands.run("secrets.scope", "MISSING main-only")
    expect(JSON.stringify(missing)).toContain("secret not found")
    // The agent may only ask to give a secret to every run; a human confirms.
    const before = requests.length
    expect(await controller.commands.runForAgent("secrets.scope", "DEPLOY all")).toMatchObject({ status: "executed" })
    expect(requests.length).toBe(before)
    const confirmation = [...store.collections.messages.values()].find(message => message.action?.flow === "secrets.scope")
    expect(confirmation?.action?.args).toStartWith("DEPLOY all")
  })
})
