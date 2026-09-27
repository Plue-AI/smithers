import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppServices } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { flowRequirements, unmetRequirements } from "./registry"
import type { CommandState } from "./registry"

/*
 * The requirement axis (registry.ts flowRequirements): a user-invoked flow
 * with an unmet requirement parks durably in the session row, the fulfilling
 * flow runs in its place, and the parked flow resumes when
 * the requirement's predicate flips true — one requirement at a time, against
 * live state. Agent invocations never park: they fail honestly with the
 * reason.
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

/** Every seam answers 404 — requirement resolution must not depend on a live backend. */
const deadBackend: AppServices = {
  fetchImpl: async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    return json(404, { status: "error", message: `no stub for ${url}` })
  }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2))
  if (!condition()) throw new Error("condition never held")
}

/** The two hosts the spend requirement tells apart: the Worker authenticates its own key, the local app spends the operator's. */
const CLOUD: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: false }),
  authFlow: "redirect", sandbox: null }
const LOCAL: AppBootstrap = { apiVersion: 1, host: "local", version: "test", buildSha: "test",
  capabilities: localCapabilities({ agent: true, cloud: true, identity: true }), authFlow: "redirect", sandbox: null }

const LAB = { id: "lab", protocol: "openai-chat", baseUrl: "https://api.cerebras.ai", modelId: "gpt-oss-120b", credential: "CEREBRAS_API_KEY" } as const

const freshController = async (services: AppServices = deadBackend) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableAgent, services)
  }
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

const reposLoaded = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
}

const chatState: CommandState = {
  surface: "chat",
  typing: false,
  hasConnectors: false,
  admin: false,
  signedOut: false
}

describe("requirement axis — the pure model", () => {
  /*
   * A spend the HOST pays for needs the host's session; a spend the operator
   * pays for on their own machine needs nobody. One requirement covers both,
   * so the local app keeps testing a model with nobody signed in.
   */
  test("the spend requirement reads the host: only the cloud host's definitive signed-out answer defers", () => {
    const meta = { summary: "", requires: ["signed-in-to-spend"] }
    expect(unmetRequirements(meta, { ...chatState, signedOut: true, hostSpendsOwnKey: true }).map((r) => r.id)).toEqual([
      "signed-in-to-spend"
    ])
    expect(unmetRequirements(meta, { ...chatState, signedOut: true })).toEqual([])
    expect(unmetRequirements(meta, { ...chatState, hostSpendsOwnKey: true })).toEqual([])
  })

  test("unmetRequirements answers in declaration order, only unmet, unknown ids skipped", () => {
    const meta = { summary: "", requires: ["signed-in", "repo-source", "no-such"] }
    expect(unmetRequirements(meta, { ...chatState, signedOut: true }).map((r) => r.id)).toEqual([
      "signed-in",
      "repo-source"
    ])
    // A public catalog repository is a read source of its own: files open, writes still wait on sign-in.
    expect(unmetRequirements(meta, { ...chatState, signedOut: true, publicRepo: true }).map((r) => r.id)).toEqual([
      "signed-in"
    ])
    expect(unmetRequirements(meta, chatState)).toEqual([])
    expect(unmetRequirements({ summary: "" }, { ...chatState, signedOut: true })).toEqual([])
  })

  // A requirement that is a pure wait declares no fulfilling flow: the app is
  // already settling it, so there is nothing for the user or the agent to run.
  test("every requirement's fulfill names a registered flow shape", () => {
    for (const requirement of flowRequirements) {
      if (requirement.fulfill !== undefined) expect(requirement.fulfill).toMatch(/^[a-z0-9_.-]+$/)
      expect(requirement.reason.length).toBeGreaterThan(0)
    }
  })
})

describe("requirement axis — the run path", () => {
  test("a typed catalog target satisfies only the read-source prerequisite, independent of a failed URL", async () => {
    const reads: string[] = []
    const { store, controller } = await freshController({ fetchImpl: async input => {
      reads.push(String(input))
      return json(200, [])
    } })
    try {
      await signedOut(store)
      store.dispatch({ type: "repository.upserted", actor: "system", repository: {
        id: "public/repo", org: "public", name: "repo", ownerKind: "user", head: null, catalog: true
      } })
      store.dispatch({ type: "repository.entry.changed", actor: "system", entry: {
        requestId: "entry", repo: "missing/repo", phase: "pending"
      } })
      store.dispatch({ type: "repository.entry.changed", actor: "system", entry: {
        requestId: "entry", repo: "missing/repo", phase: "failed", error: "missing/repo could not be opened."
      } })
      expect((await controller.commands.runForAgent("files.list", "/ public/repo")).status).toBe("executed")
      expect(reads).toEqual(["/api/repos/public/repo/contents"])
      expect(store.session().pendingCommand ?? null).toBeNull()
      expect((await controller.commands.runForAgent("files.list", "/public/repo/docs")).status).toBe("executed")
      expect(reads).toEqual(["/api/repos/public/repo/contents", "/api/repos/public/repo/contents/docs"])

      reads.length = 0
      store.dispatch({ type: "repository.upserted", actor: "system", repository: {
        id: "private/repo", org: "private", name: "repo", ownerKind: "user", head: null
      } })
      expect((await controller.commands.runForAgent("files.list", "/ private/repo")).status).toBe("failed")
      expect((await controller.commands.runForAgent("flow.list", "public/repo")).status).toBe("failed")
      expect(reads).toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  test("a user-invoked command with an unmet requirement parks durably and renders the sign-in prompt", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    const outcome = await controller.commands.run("flow.list")
    // A sign-in message offers the human OAuth; the unmet flow never redirects.
    expect([...store.collections.messages.values()].some(message => message.action?.flow === "auth.sign-in")).toBe(true)
    expect(outcome.status).toBe("executed")
    await settled()
    const pending = store.session().pendingCommand
    expect(pending?.name).toBe("flow.list")
    expect(pending?.requirement).toBe("signed-in")
    expect(pending?.args).toBeNull()
    expect([...store.collections.toasts.values()]).toEqual([])
  })

  test("an agent-invoked command with an unmet requirement fails honestly and parks nothing", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    const outcome = await controller.commands.runForAgent("flow.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("Sign in with GitHub first")
    const viaTool = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "flow.list" })
    })
    expect(viaTool).toContain("failed: Sign in with GitHub first")
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
  })

  test("the parked command resumes once its requirement is satisfied, announced by a toast", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    await controller.commands.run("flow.list")
    await settled()
    await signedIn(store)
    await reposLoaded(store)
    controller.resumeDeferredCommand()
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
    const titles = [...store.collections.toasts.values()].map((toast) => toast.title)
    expect(store.collections.toasts.get("toast-command.requirement")).toBeUndefined()
    expect(titles).toContain(`Continuing: ${controller.commands.find("flow.list")!.metadata.summary}`)
    expect([...store.collections.toasts.values()].some(toast => /\/flow\.list/.test(toast.title + toast.detail))).toBe(false)
  })

  test("requirements resolve against live state: sign-in parks, the resume runs the command", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    await controller.commands.run("flow.create", "nightly test triage")
    await settled()
    expect(store.session().pendingCommand?.requirement).toBe("signed-in")
    expect(store.session().pendingCommand?.args).toBe("nightly test triage")

    // Signing in satisfies the requirement; the resume re-runs the command
    // (against the dead backend it fails honestly, but the parking spot is
    // spent either way).
    await signedIn(store)
    controller.resumeDeferredCommand()
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
  })

  test("a parked command whose requirement id no longer exists clears without running", async () => {
    const { store, controller } = await freshController()
    store.dispatch({
      type: "command.deferred",
      actor: "user",
      name: "world",
      args: null,
      requirement: "retired-requirement"
    })
    await settled()
    controller.resumeDeferredCommand()
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
    expect(store.session().surface).toBe("chat")
  })

  test("an agent-invoked signed-in requirement renders the sign-in step itself — prose is not a button", async () => {
    const { store, controller } = await freshController()
    await signedOut(store)
    const outcome = await controller.commands.runForAgent("flow.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("already rendered in the chat")
    await settled()
    const prompts = [...store.collections.messages.values()].filter(
      (message) => message.action?.flow === "auth.sign-in"
    )
    expect(prompts).toHaveLength(1)
  })

  test("a fulfill-less requirement parks the command and runs no flow", async () => {
    const { store, controller } = await freshController()
    const outcome = await controller.commands.run("issues.list")
    expect(outcome).toEqual({ status: "executed", value: "Requested" })
    await settled()
    expect(store.session().pendingCommand).toMatchObject({ name: "issues.list", requirement: "first-run-target" })
    expect([...store.collections.cards.values()]).toEqual([])
    expect([...store.collections.messages.values()]).toEqual([])
    await controller.dispose()
  })

  /*
   * Will, on production, signed out: a Test painted `host_refused ·
   * sign_in_required` in red. The expected condition is a step, not a
   * failure, so nothing is POSTed until the account is there.
   */
  test("on the cloud host a signed-out Test asks for sign-in and spends no request", async () => {
    const posts: Array<string> = []
    const { store, controller } = await freshController({
      bootstrap: CLOUD,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if ((init?.method ?? "GET") !== "GET") posts.push(new URL(url, "https://app.test").pathname)
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
    })
    try {
      await store.dispatch({ type: "model.saved", actor: "user", model: LAB }).isPersisted.promise
      await signedOut(store)
      // The fulfilling flow answers in its place, exactly as every other deferral does.
      expect((await controller.commands.run("model.test", "lab")).status).toBe("executed")
      await settled()
      expect(posts).toEqual([])
      expect([...store.collections.messages.values()].some((message) => message.action?.flow === "auth.sign-in")).toBe(true)
      expect(store.session().pendingCommand).toMatchObject({ name: "model.test", args: "lab", requirement: "signed-in-to-spend" })

      await signedIn(store)
      controller.resumeDeferredCommand()
      await waitFor(() => posts.length > 0)
      expect(posts).toEqual([MODEL_TEST_PATH])
    } finally {
      await controller.dispose()
    }
  })

  test("on the local host a signed-out Test still runs: it spends the operator's own key", async () => {
    const posts: Array<string> = []
    const { store, controller } = await freshController({
      bootstrap: LOCAL,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if ((init?.method ?? "GET") !== "GET") posts.push(new URL(url, "https://app.test").pathname)
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
    })
    try {
      await store.dispatch({ type: "model.saved", actor: "user", model: LAB }).isPersisted.promise
      await signedOut(store)
      expect(await controller.commands.run("model.test", "lab")).toEqual({ status: "executed", value: "Requested" })
      await waitFor(() => posts.length > 0)
      expect(posts).toEqual([MODEL_TEST_PATH])
      expect(store.session().pendingCommand ?? null).toBeNull()
    } finally {
      await controller.dispose()
    }
  })

  test("a satisfied requirement never defers: the command just runs", async () => {
    const { store, controller } = await freshController()
    await signedIn(store)
    await reposLoaded(store)
    const outcome = await controller.commands.run("billing.balance")
    // The dead backend fails the seam honestly — but nothing parked.
    expect(outcome.status).not.toBe("unknown-command")
    await settled()
    expect(store.session().pendingCommand ?? null).toBeNull()
  })
})
