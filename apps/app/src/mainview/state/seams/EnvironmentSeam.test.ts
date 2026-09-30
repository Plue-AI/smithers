import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createActorBindings } from "../ActorBindings"
import { createEnvironmentSeam, parseEnvironment } from "./EnvironmentSeam"

/*
 * The agent-environment seam (EnvironmentSeam.ts) through the real command
 * path: /env.view reads GET /api/repos/{owner}/{repo}/agent-environment and
 * surfaces the "env" card (vars and the setup script; secrets belong to the
 * secrets card, SecretsSeam.test.ts); /env.set
 * validates one NAME=value pair, merges it into the current answer, PUTs the
 * WHOLE document back, and re-reads. Failures are honest strings, never
 * throws.
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

interface EnvRequest {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

type EnvFailure = "get-500" | "get-throw" | "put-500" | "put-throw"

/*
 * The platform double: one agent-environment document in the reference wire
 * shape (snake_case, secrets as {name, updated_at} metadata). A PUT replaces
 * the stored document, so the seam's re-read answers the merged truth. Every
 * agent-environment request is captured, body included.
 */
const envBackend = (failure?: EnvFailure) => {
  const requests: EnvRequest[] = []
  let setupScript = "bun install"
  let env: Array<{ name: string; value: string }> = [{ name: "CI", value: "1" }]
  const secrets = [{ name: "NPM_TOKEN", updated_at: "2026-08-01T00:00:00.000Z" }]
  const answer = () => ({
    setup_script: setupScript,
    env,
    secrets,
    updated_at: "2026-08-01T00:00:00.000Z"
  })
  const services: AppServices = {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined
      if (!url.includes("/agent-environment")) {
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
      requests.push({ method, url, body })
      if (method === "GET") {
        if (failure === "get-throw") throw new Error("socket hang up")
        if (failure === "get-500") return json(500, { message: "the platform fell over" })
        return json(200, answer())
      }
      if (method === "PUT") {
        if (failure === "put-throw") throw new Error("socket hang up")
        if (failure === "put-500") return json(500, { message: "the platform refused the write" })
        const document = body as {
          setup_script: string
          env: Array<{ name: string; value: string }>
        }
        setupScript = document.setup_script
        env = document.env
        return json(200, answer())
      }
      return json(405, { message: `no stub for ${method} ${url}` })
    }
  }
  return { services, requests }
}

const freshController = async (failure?: EnvFailure) => {
  const backend = envBackend(failure)
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    requests: backend.requests,
    controller: createAppController(store, unavailableAgent, backend.services)
  }
}

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
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

const envCard = (store: AppStore, repo = "will/flows") => {
  const card = store.collections.cards.get(`env-${repo}`)
  if (card === undefined || card.kind !== "env") return undefined
  return card
}

describe("environment seam — env.view", () => {
  test("surfaces the env card from the platform answer: vars and setup script, no secret", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.view")
    expect(outcome.status).toBe("executed")
    await settled()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe("GET")
    expect(requests[0]?.url).toBe("/api/repos/will/flows/agent-environment")

    const card = envCard(store)
    expect(card).toBeDefined()
    expect(card?.title).toBe("Agent environment · will/flows")
    expect(card?.status).toBe("active")
    expect(card?.payload.repo).toBe("will/flows")
    expect(card?.payload.vars).toEqual([{ name: "CI", value: "…" }])
    expect(card?.payload.setupScript).toBe("bun install")
    // Secrets are the secrets card's: not even their names ride on the env card.
    expect(JSON.stringify(card)).not.toContain("NPM_TOKEN")
    expect(JSON.stringify(card)).not.toContain("updated_at")
  })

  test("an explicit owner/repo argument targets that repository", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.view", "acme/site")
    expect(outcome.status).toBe("executed")
    expect(requests[0]?.url).toBe("/api/repos/acme/site/agent-environment")
    expect(envCard(store, "acme/site")).toBeDefined()
  })

  test("an inventory-less signed-in session answers the repo-resolution error as-is", async () => {
    const { store, controller, requests } = await freshController()
    await signedIn(store)
    const outcome = await controller.commands.run("env.view")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo"
      )
    }
    expect(requests).toHaveLength(0)
  })
})

describe("environment seam — env.set", () => {
  test("concurrent edits preserve both variables", async () => {
    const { store, controller } = await freshController()
    await ready(store)
    const [first, second] = await Promise.all([
      controller.commands.run("env.set", "FIRST=1"),
      controller.commands.run("env.set", "SECOND=2")
    ])
    expect(first.status).toBe("executed")
    expect(second.status).toBe("executed")
    expect(envCard(store)?.payload.vars).toEqual([
      { name: "CI", value: "…" },
      { name: "FIRST", value: "…" },
      { name: "SECOND", value: "…" }
    ])
  })

  test("merges the pair into the WHOLE document PUT, then re-reads into the card", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.set", "NODE_ENV=production")
    expect(outcome.status).toBe("executed")
    await settled()

    // Read → write → re-read, all against the one environment endpoint.
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"])
    expect(requests[1]?.url).toBe("/api/repos/will/flows/agent-environment")
    // The reference body shape (agentEnvironment.ts putAgentEnvironment):
    // setup_script + env, sorted by name, and NO secrets key — secrets are
    // write-only through their own endpoint, never round-tripped here.
    expect(requests[1]?.body).toEqual({
      setup_script: "bun install",
      env: [
        { name: "CI", value: "1" },
        { name: "NODE_ENV", value: "production" }
      ]
    })

    const card = envCard(store)
    expect(card?.payload.vars).toEqual([
      { name: "CI", value: "…" },
      { name: "NODE_ENV", value: "pro…" }
    ])
    expect(card?.payload.setupScript).toBe("bun install")
  })

  test("an existing name is replaced, not duplicated", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.set", "CI=0")
    expect(outcome.status).toBe("executed")
    expect(requests[1]?.body).toEqual({
      setup_script: "bun install",
      env: [{ name: "CI", value: "0" }]
    })
    expect(envCard(store)?.payload.vars).toEqual([{ name: "CI", value: "…" }])
  })

  test("a value carrying = signs splits on the FIRST = only", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)
    const outcome = await controller.commands.run("env.set", "TOKEN=abc=def==")
    expect(outcome.status).toBe("executed")
    const document = requests[1]?.body as { env: Array<{ name: string; value: string }> }
    expect(document.env).toContainEqual({ name: "TOKEN", value: "abc=def==" })
  })

  test("an empty pair renders env.set's form (THE FORM LAW); malformed pairs answer the seam's own", async () => {
    const { store, controller, requests } = await freshController()
    await ready(store)

    const empty = await controller.commands.run("env.set")
    expect(empty).toEqual({ status: "form", flow: "env.set", cardId: "form-env.set", fields: ["assignment"] })
    expect(store.collections.cards.get("form-env.set")?.kind).toBe("flow-form")

    const noEquals = await controller.commands.run("env.set", "NOEQUALS")
    expect(noEquals.status).toBe("failed")
    if (noEquals.status === "failed") {
      expect(noEquals.error).toBe(
        "\"NOEQUALS\" isn't a NAME=value pair — write it like NODE_ENV=production"
      )
    }

    const badName = await controller.commands.run("env.set", "1BAD=x")
    expect(badName.status).toBe("failed")
    if (badName.status === "failed") {
      expect(badName.error).toContain("\"1BAD\" isn't a valid variable name")
    }

    // None of the invalid shapes touched the platform.
    expect(requests).toHaveLength(0)
  })
})

describe("environment seam — honest failures", () => {
  test("a 500 on the read answers what failed and whose fault it was, never a throw", async () => {
    const { store, controller } = await freshController("get-500")
    await ready(store)
    const outcome = await controller.commands.run("env.view")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The agent environment for will/flows couldn't be read (HTTP 500). That's a bug in Smithers, not something you did.")
      expect(outcome.error).not.toContain("the platform fell over")
    }
    expect(envCard(store)).toBeUndefined()
  })

  test("a network throw on the read answers an honest string", async () => {
    const { store, controller } = await freshController("get-throw")
    await ready(store)
    const outcome = await controller.commands.run("env.view")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "The agent environment for will/flows couldn't be read — the platform didn't answer."
      )
    }
  })

  test("a 500 on the write answers what failed and whose fault it was and surfaces no card", async () => {
    const { store, controller, requests } = await freshController("put-500")
    await ready(store)
    const outcome = await controller.commands.run("env.set", "NODE_ENV=production")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("NODE_ENV couldn't be saved to will/flows (HTTP 500). That's a bug in Smithers, not something you did.")
      expect(outcome.error).not.toContain("the platform refused the write")
    }
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"])
    expect(envCard(store)).toBeUndefined()
  })

  test("a network throw on the write answers an honest string naming the pair", async () => {
    const { store, controller } = await freshController("put-throw")
    await ready(store)
    const outcome = await controller.commands.run("env.set", "NODE_ENV=production")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "NODE_ENV couldn't be saved to will/flows — the platform didn't answer."
      )
    }
    expect(envCard(store)).toBeUndefined()
  })
})

/*
 * The parser the secrets seam shares: plue's AgentEnvironmentResponse carries
 * each secret as {name, hosts, match_headers, updated_at} and never a value.
 */
describe("parseEnvironment: secret metadata", () => {
  const document = {
    setup_script: "",
    env: [],
    secrets: [
      { name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], match_headers: ["authorization"], updated_at: "2026-08-01T00:00:00Z" },
      { name: "SETUP_ONLY", hosts: [], match_headers: [], updated_at: "2026-08-02T00:00:00Z" }
    ]
  }

  test("reads hosts, match headers and the updated time per secret", () => {
    expect(parseEnvironment(document)?.secrets).toEqual([
      { name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], matchHeaders: ["authorization"], updatedAt: "2026-08-01T00:00:00Z", reconnect: false },
      { name: "SETUP_ONLY", hosts: [], matchHeaders: [], updatedAt: "2026-08-02T00:00:00Z", reconnect: false }
    ])
  })

  test("a secret row without binding or time fields is a setup-only secret with no updated time", () => {
    const config = parseEnvironment({ ...document, secrets: [{ name: "LEGACY" }] })
    expect(config?.secrets).toEqual([{ name: "LEGACY", hosts: [], matchHeaders: [], updatedAt: null, reconnect: false }])
  })

  test("a value field on the wire is never carried into the config", () => {
    const config = parseEnvironment({ ...document, secrets: [{ name: "LEAKY", value: "hunter2" }] })
    expect(JSON.stringify(config)).not.toContain("hunter2")
  })

  test("off-shape rows null the whole answer: a non-list hosts field, a non-string host, a nameless secret", () => {
    expect(parseEnvironment({ ...document, secrets: [{ name: "X", hosts: "registry.npmjs.org" }] })).toBeNull()
    expect(parseEnvironment({ ...document, secrets: [{ name: "X", hosts: [1] }] })).toBeNull()
    expect(parseEnvironment({ ...document, secrets: [{ hosts: [] }] })).toBeNull()
    expect(parseEnvironment({ setup_script: "", env: [] })).toBeNull()
  })
})


test("user and agent environment writes share the repository queue", async () => {
  const backend = envBackend()
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await ready(store)
  const actors = createActorBindings(() => {})
  let ordinal = 0
  const seam = actors.pair({
    store, baseUrl: "", actor: () => "user" as const,
    dispatch: store.dispatch,
    nextOrdinal: () => ++ordinal,
    http: (input: string, init?: RequestInit) => backend.services.fetchImpl!(input, init)
  }, createEnvironmentSeam)
  try {
    await Promise.all([
      seam.setEnvironmentVar("USER=1", "will/flows"),
      actors.select(seam.setEnvironmentVar)("AGENT=2", "will/flows")
    ])
    const writes = backend.requests.filter(request => request.method === "PUT")
    expect(writes).toHaveLength(2)
    expect(writes[1]?.body).toMatchObject({ env: [
      { name: "AGENT", value: "2" }, { name: "CI", value: "1" }, { name: "USER", value: "1" }
    ] })
  } finally { await store.dispose?.() }
})

test("parseEnvironment: reconnect_required marks a refused subscription token", () => {
  const document = { setup_script: "", env: [], secrets: [] }
  expect(parseEnvironment(document)?.reconnect).toBe(false)
  expect(parseEnvironment({ ...document, reconnect_required: true })?.reconnect).toBe(true)
})

test("a refused subscription token is removed on purpose, never by an unrelated write", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await ready(store)
  const puts: unknown[] = []
  let reconnect = true
  const answer = () => ({ setup_script: "export CLAUDE_CODE_OAUTH_TOKEN=[redacted]\nnpm ci", env: [{ name: "CI", value: "1" }], secrets: [],
    ...(reconnect ? { reconnect_required: true } : {}) })
  const actors = createActorBindings(() => {})
  let ordinal = 0
  const seam = actors.pair({
    store, baseUrl: "", actor: () => "user" as const,
    dispatch: store.dispatch,
    nextOrdinal: () => ++ordinal,
    http: async (_input: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)))
        reconnect = false
      }
      return new Response(JSON.stringify(answer()), { status: 200, headers: { "content-type": "application/json" } })
    }
  }, createEnvironmentSeam)
  try {
    expect(await seam.setEnvironmentVar("USER=1", "will/flows")).toBe("Remove the subscription token from will/flows first.")
    expect(puts).toHaveLength(0)
    await seam.removeSubscriptionToken("will/flows")
    expect(puts).toEqual([{ setup_script: "export CLAUDE_CODE_OAUTH_TOKEN=[redacted]\nnpm ci", env: [{ name: "CI", value: "1" }] }])
    await seam.removeSubscriptionToken("will/flows")
    expect(puts).toHaveLength(1)
  } finally { await store.dispose?.() }
})

test("Remove token deletes a flagged secret and leaves an unflagged environment as it is", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await ready(store)
  const writes: string[] = []
  let flagged = true
  const answer = () => ({ setup_script: "npm ci", env: [], secrets: [
    { name: "OK", hosts: [], match_headers: [] },
    ...(flagged ? [{ name: "CLAUDE", hosts: [], match_headers: [], reconnect_required: true }] : [])
  ], ...(flagged ? { reconnect_required: true } : {}) })
  const actors = createActorBindings(() => {})
  let ordinal = 0
  const seam = actors.pair({
    store, baseUrl: "", actor: () => "user" as const,
    dispatch: store.dispatch,
    nextOrdinal: () => ++ordinal,
    http: async (input: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        writes.push(`DELETE ${input}`)
        flagged = false
        return new Response(null, { status: 204 })
      }
      if (init?.method === "PUT") writes.push("PUT")
      return new Response(JSON.stringify(answer()), { status: 200, headers: { "content-type": "application/json" } })
    }
  }, createEnvironmentSeam)
  try {
    expect(parseEnvironment(answer())?.secrets.map((secret) => secret.reconnect)).toEqual([false, true])
    await seam.removeSubscriptionToken("will/flows")
    expect(writes).toEqual(["DELETE /api/repos/will/flows/agent-environment/secrets/CLAUDE"])
  } finally { await store.dispose?.() }
})
