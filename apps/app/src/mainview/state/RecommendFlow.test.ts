import { digest } from "@smthrs/core/Digest"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnBatch, AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { describe,expect,test } from "bun:test"
import type { AppServices } from "./AppController"
import { RECOMMENDATION_ID } from "./AppState"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { RECOMMEND_OUTCOME_PATH,RECOMMEND_PATH } from "./Recommend"
import { json, memoryStorage, repositoryHttpFixture, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The recommender as a workflow: a material change → the `recommend` flow →
 * the rule's pills at once, then ONE POST /api/recommend whose validated
 * answer replaces them, and the user's next dispatch reported once as the
 * outcome. No real model is ever asked here: the Worker is a recorder.
 */

const cloudBootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: ["agent", "identity", "cloud"],
  authFlow: "redirect",
  sandbox: null
}

const localBootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: ["agent"],
  authFlow: "none",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const settle = async (ticks = 6) => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

interface Hit {
  readonly path: string
  readonly method: string
  readonly body: Record<string, unknown>
}

/** A Worker double that records every recommend call and answers from a script, newest answer first. */
const recorder = (answers: Array<() => Response> = []) => {
  const hits: Hit[] = []
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input)
    const path = new URL(url, "https://app.test").pathname
    const body = typeof init?.body === "string" && init.body !== "" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    hits.push({ path, method: init?.method ?? "GET", body })
    if (path === RECOMMEND_OUTCOME_PATH) return new Response(null, { status: 204 })
    if (path === RECOMMEND_PATH) return (answers.shift() ?? (() => json(503, { status: "error", message: "no key" })))()
    return json(404, { status: "error" })
  }
  return {
    fetchImpl,
    hits,
    recommends: () => hits.filter((hit) => hit.path === RECOMMEND_PATH),
    outcomes: () => hits.filter((hit) => hit.path === RECOMMEND_OUTCOME_PATH)
  }
}

const answer = (id: string, commands: ReadonlyArray<string>) => () => json(200, { id, commands, model: "gpt-oss-120b" })

/** The Worker's 429 exactly as turnLimitResponse writes it: the window in the body and in Retry-After. */
const refused = (retryAt: number | string | undefined, retryAfter?: string) => () =>
  new Response(
    JSON.stringify({
      status: "error",
      code: "turn_rate_limited",
      message: "Command suggestions have reached their daily limit. Chat keeps working; suggestions come back in about 3 hours. Nothing was charged.",
      ...(retryAt === undefined ? {} : { retryAt: typeof retryAt === "number" ? new Date(retryAt).toISOString() : retryAt })
    }),
    { status: 429, headers: { "content-type": "application/json", ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }) } }
  )

const boot = async (services: AppServices = {}, storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  // Most tests isolate a later material event from the first-entry background read.
  const controller = createAppController(store, silentAgent, {
    bootstrap: cloudBootstrap,
    recommender: { enabled: true, debounceMs: 0 },
    ...services
  })
  return { store, controller }
}

const row = (store: Awaited<ReturnType<typeof boot>>["store"]) =>
  store.collections.recommendations.get(RECOMMENDATION_ID)

const signIn = (store: Awaited<ReturnType<typeof boot>>["store"], login = "will") =>
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login,
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })

/** A material change that carries no identity: what a card tab open, a finished turn or a repo load look like to the recommender. */
const materialChange = (store: Awaited<ReturnType<typeof boot>>["store"], step: string) =>
  store.dispatch({
    type: "tab.opened",
    actor: "user",
    tab: { id: `tab-${step}`, kind: "card", title: "Pinned", cardId: `card-${step}` }
  })

describe("recommend: the flow", () => {
  test("is registered, hidden from the slash menu, and never the model's to call", async () => {
    const { controller } = await boot()
    const entry = controller.commands.find("system.recommend")
    expect(entry).toBeDefined()
    expect(entry?.metadata.hidden).toBe(true)
    expect(entry?.binding.descriptor.modelInvocable).toBe(false)
    expect(controller.slashItems("recomm").map((item) => item.flow.name)).not.toContain("system.recommend")
  })

  test("the pills default ON for the cloud host and OFF elsewhere; an explicit value wins", async () => {
    const cloud = await boot()
    expect(cloud.controller.features.suggestionPills).toBe(true)
    const cloudOff = await boot({ features: { suggestionPills: false } })
    expect(cloudOff.controller.features.suggestionPills).toBe(false)
    const local = await boot({ bootstrap: localBootstrap })
    expect(local.controller.features.suggestionPills).toBe(false)
    const localOn = await boot({ bootstrap: localBootstrap, features: { suggestionPills: true } })
    expect(localOn.controller.features.suggestionPills).toBe(true)
  })

  test("a material transition writes the rule at once and sends ONE request in the contract's shape", async () => {
    const worker = recorder([answer("rec-1", ["wiki", "chat.commands"])])
    const { store, controller } = await boot({ fetchImpl: worker.fetchImpl })
    store.dispatch({ type: "message.submitted", actor: "user", turnId: "t1", text: "what can you do here?" })
    store.dispatch({ type: "message.appended", actor: "system", text: "I can list flows and read files." })
    store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "t1" })
    await settle()

    const requests = worker.recommends()
    expect(requests.length).toBe(1)
    expect(requests[0]?.method).toBe("POST")
    const body = requests[0]?.body ?? {}
    expect(body.repo).toBeNull()
    expect(body.tail).toEqual([
      { role: "user", text: "what can you do here?" },
      { role: "assistant", text: "I can list flows and read files." }
    ])
    const commands = body.commands as Array<{ name: string; summary: string }>
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.length).toBeLessThanOrEqual(300)
    // Every entry is a flow this session can invoke, listed with the slash menu's one-line summary.
    for (const command of commands) {
      const entry = controller.commands.find(command.name)
      expect(entry).toBeDefined()
      expect(entry?.metadata.hidden).not.toBe(true)
      expect(command.summary).toBe(entry?.metadata.summary ?? "")
    }
    expect(commands.map((command) => command.name)).toContain("wiki")
    expect(commands.map((command) => command.name)).not.toContain("system.recommend")

    const current = row(store)
    expect(current?.source).toBe("agent")
    expect(current?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki", "chat.commands"])
    expect(current?.suggestions[0]?.emphasis).toBe("primary")
    // The request is invisible to the conversation.
    expect(store.session().phase).toBe("idle")
  })

  test("the request names the selected repository", async () => {
    const worker = recorder([answer("rec-1", ["wiki"])])
    const { store } = await boot({ fetchImpl: worker.fetchImpl })
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: null, catalog: true }]
    })
    store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" })
    signIn(store)
    await settle()
    expect(worker.recommends().at(-1)?.body.repo).toBe("smithersai/smithers")
  })

  test("the validated answer drops names the registry does not offer; the pills cap at three", async () => {
    const worker = recorder([answer("rec-1", ["deploy.everything", "chat.commands", "card.maximize", "wiki", "connect", "flow.list"])])
    const { store } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    const current = row(store)
    expect(current?.source).toBe("agent")
    expect(current?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["chat.commands", "wiki", "connect"])
  })

  test("a 429, a 503, a network failure, or an empty answer leaves the rule standing and never an empty row", async () => {
    const worker = recorder([
      () => json(429, { status: "error", code: "turn_rate_limited", message: "spent" }),
      () => json(503, { status: "error", message: "CEREBRAS_API_KEY is unset" }),
      () => { throw new Error("network down") },
      answer("rec-empty", [])
    ])
    const { store } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    expect(row(store)?.source).toBe("rule")
    expect(row(store)?.suggestions.length).toBeGreaterThan(0)
    for (const step of [1, 2, 3]) {
      store.dispatch({
        type: "tab.opened",
        actor: "user",
        tab: { id: `tab-${step}`, kind: "card", title: "Pinned", cardId: `card-${step}` }
      })
      await settle()
      expect(row(store)?.source).toBe("rule")
      expect(row(store)?.suggestions.length).toBeGreaterThan(0)
    }
    expect(worker.recommends().length).toBe(4)
  })

  test("a newer state supersedes the request in flight; the old answer is dropped", async () => {
    let releaseFirst: (() => void) | undefined
    const worker = recorder([
      () => json(200, { id: "rec-old", commands: ["chat.commands"], model: "m" }),
      answer("rec-new", ["wiki"])
    ])
    // The first answer waits until the second state has asked.
    const gated = async (input: unknown, init?: RequestInit) => {
      const response = await worker.fetchImpl(input, init)
      const path = new URL(typeof input === "string" ? input : String(input), "https://app.test").pathname
      if (path === RECOMMEND_PATH && worker.recommends().length === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
      }
      return response
    }
    const { store } = await boot({ fetchImpl: gated })
    signIn(store)
    await settle()
    store.dispatch({ type: "identity.session.cleared", actor: "user" })
    await settle()
    expect(worker.recommends().length).toBe(2)
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki"])
    releaseFirst?.()
    await settle()
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki"])
  })

  test("the next user dispatch reports the outcome exactly once, through any door", async () => {
    const worker = recorder([answer("rec-1", ["wiki", "chat.commands"]), answer("rec-2", ["connect"])])
    const { store, controller } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    expect(worker.outcomes().length).toBe(0)

    // The pill (or the slash line, or a button): the registry's one door.
    controller.runCommand("chat.commands")
    await settle()
    expect(worker.outcomes().map((hit) => hit.body)).toEqual([{ id: "rec-1", command: "chat.commands" }])

    // A second dispatch before a fresh recommendation reports nothing more.
    controller.runCommand("wiki")
    await settle()
    expect(worker.outcomes().length).toBe(1)

    // A fresh recommendation opens a fresh outcome.
    store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-x", kind: "card", title: "Pinned", cardId: "card-x" }
    })
    await settle()
    controller.runCommand("connect")
    await settle()
    expect(worker.outcomes().map((hit) => hit.body)).toEqual([
      { id: "rec-1", command: "chat.commands" },
      { id: "rec-2", command: "connect" }
    ])
  })

  test("a hidden act, the recommender's own flow, and the agent's door are never the outcome", async () => {
    const worker = recorder([answer("rec-1", ["wiki"])])
    const { store, controller } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    await controller.commands.run("system.recommend")
    await controller.commands.run("card.maximize", "card-none")
    await controller.commands.runAsAgent("wiki")
    await settle()
    expect(worker.outcomes().length).toBe(0)
    controller.runCommand("wiki")
    await settle()
    expect(worker.outcomes().map((hit) => hit.body)).toEqual([{ id: "rec-1", command: "wiki" }])
  })

  test("without a recommendation the user's dispatch reports nothing", async () => {
    const worker = recorder([() => json(503, { status: "error", message: "CEREBRAS_API_KEY is unset" })])
    const { store, controller } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    controller.runCommand("wiki")
    await settle()
    expect(worker.outcomes().length).toBe(0)
  })

  test("a keystroke never regenerates", async () => {
    const worker = recorder()
    const { controller } = await boot({ fetchImpl: worker.fetchImpl })
    controller.changeDraft("hel")
    controller.changeDraft("hello")
    await settle()
    expect(worker.recommends().length).toBe(0)
  })

  test("pills off: the rule row still lands and no request leaves", async () => {
    const worker = recorder([answer("rec-1", ["wiki"])])
    const { store } = await boot({ fetchImpl: worker.fetchImpl, features: { suggestionPills: false } })
    signIn(store)
    await settle()
    expect(worker.recommends().length).toBe(0)
    expect(row(store)?.source).toBe("rule")
  })

  test("opt-in: a composition root that does not enable the recommender gets the rule only", async () => {
    const worker = recorder([answer("rec-1", ["wiki"])])
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    createAppController(store, silentAgent, {
      bootstrap: cloudBootstrap,
      fetchImpl: worker.fetchImpl,
      recommender: { debounceMs: 0 }
    })
    signIn(store)
    await settle()
    expect(row(store)?.source).toBe("rule")
    expect(worker.recommends().length).toBe(0)
  })

  test("a 429 that names its window closes the recommender until then: material changes and a reload send nothing more, the rule still writes", async () => {
    const retryAt = Date.now() + 60 * 60 * 1000
    const worker = recorder([refused(retryAt, "3600"), answer("rec-never", ["wiki"])])
    const storage = memoryStorage()
    const first = await boot({ fetchImpl: worker.fetchImpl }, storage)
    signIn(first.store)
    await settle()
    expect(worker.recommends().length).toBe(1)
    expect(row(first.store)?.source).toBe("rule")
    expect(row(first.store)?.retry).toEqual({ at: retryAt, owner: "will", origin: "same-origin" })

    // Every material change still regenerates the rule's pills, and sends nothing.
    let writes = 0
    const writer = first.store.collections.recommendations.subscribeChanges(() => { writes += 1 })
    for (const step of [1, 2, 3]) {
      const before = writes
      materialChange(first.store, String(step))
      await settle()
      expect(worker.recommends().length).toBe(1)
      expect(writes).toBeGreaterThan(before)
      expect(row(first.store)?.source).toBe("rule")
      expect(row(first.store)?.suggestions.length).toBeGreaterThan(0)
      expect(row(first.store)?.retry).toEqual({ at: retryAt, owner: "will", origin: "same-origin" })
    }
    writer.unsubscribe()

    // A reload: the window is on the persisted row, so the boot's own material change sends nothing either.
    await first.controller.dispose()
    await first.store.dispose?.()
    const reopened = await boot({ fetchImpl: worker.fetchImpl }, storage)
    expect(row(reopened.store)?.retry).toEqual({ at: retryAt, owner: "will", origin: "same-origin" })
    signIn(reopened.store)
    materialChange(reopened.store, "after-reload")
    await settle()
    expect(worker.recommends().length).toBe(1)
    expect(row(reopened.store)?.source).toBe("rule")
    expect(row(reopened.store)?.suggestions.length).toBeGreaterThan(0)
  }, 20_000)

  test("the window passes: the next material change asks again, and the agent's answer clears it", async () => {
    // The recommender's clock is the test's: the window is measured, never slept through.
    let clock = Date.parse("2026-09-17T00:00:00.000Z")
    const retryAt = clock + 60 * 60 * 1000
    const worker = recorder([refused(retryAt, "3600"), answer("rec-open", ["wiki"])])
    const { store } = await boot({ fetchImpl: worker.fetchImpl, recommender: { enabled: true, debounceMs: 0, now: () => clock } })
    signIn(store)
    await settle()
    expect(worker.recommends().length).toBe(1)
    expect(row(store)?.retry).toEqual({ at: retryAt, owner: "will", origin: "same-origin" })
    clock = retryAt - 1
    materialChange(store, "closed")
    await settle()
    expect(worker.recommends().length).toBe(1)
    expect(row(store)?.source).toBe("rule")
    clock = retryAt
    materialChange(store, "open")
    await settle()
    expect(worker.recommends().length).toBe(2)
    expect(row(store)?.source).toBe("agent")
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki"])
    expect(row(store)?.retry).toBeUndefined()
  })

  test("a 429 with no usable window retains nothing: the next material change asks again, as before", async () => {
    const worker = recorder([
      refused("not-a-date", "later"),
      refused(Date.now() - 1000, "0"),
      refused(undefined),
      answer("rec-1", ["wiki"])
    ])
    const { store } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    expect(worker.recommends().length).toBe(1)
    expect(row(store)?.retry).toBeUndefined()
    for (const step of [2, 3, 4]) {
      materialChange(store, String(step))
      await settle()
      expect(worker.recommends().length).toBe(step)
    }
    expect(row(store)?.source).toBe("agent")
  })

  test("a window past the daily bucket is clamped on the row", async () => {
    const worker = recorder([refused(Date.now() + 30 * 24 * 60 * 60 * 1000)])
    const { store } = await boot({ fetchImpl: worker.fetchImpl })
    const before = Date.now()
    signIn(store)
    await settle()
    const retry = row(store)?.retry
    expect(retry?.owner).toBe("will")
    expect(retry?.at).toBeGreaterThan(before)
    expect(retry?.at).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000)
  })

  test("the window binds the account that asked: a visitor's never closes a login, a login's survives an outage and leaves with the account", async () => {
    const far = Date.now() + 60 * 60 * 1000
    const worker = recorder([refused(far, "3600"), refused(far, "3600"), answer("rec-bob", ["wiki"]), answer("rec-visitor", ["connect"])])
    const { store } = await boot({ fetchImpl: worker.fetchImpl })
    // A visitor (no session yet) spends the address bucket and is refused.
    materialChange(store, "visitor")
    await settle()
    expect(worker.recommends().length).toBe(1)
    expect(row(store)?.retry).toEqual({ at: far, owner: null, origin: "same-origin" })

    // The login that follows spends its own bucket: the visitor's window does not apply.
    signIn(store, "will")
    await settle()
    expect(worker.recommends().length).toBe(2)
    expect(row(store)?.retry).toEqual({ at: far, owner: "will", origin: "same-origin" })

    // The identity seam goes away; the persisted owner still binds the window.
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "unavailable", login: null, allowlisted: false, admin: false, scopesPlain: null })
    materialChange(store, "outage")
    await settle()
    expect(store.collections.identitySessions.get("identity")?.accountOwnerLogin).toBe("will")
    expect(worker.recommends().length).toBe(2)
    expect(row(store)?.retry).toEqual({ at: far, owner: "will", origin: "same-origin" })

    // Another login replaces the account: its private state, the window with it, is gone and bob asks at once.
    signIn(store, "bob")
    await settle()
    expect(worker.recommends().length).toBe(3)
    expect(row(store)?.source).toBe("agent")
    expect(row(store)?.retry).toBeUndefined()

    // Signing out drops bob's state too; the visitor asks again.
    store.dispatch({ type: "identity.session.cleared", actor: "user" })
    await settle()
    expect(worker.recommends().length).toBe(4)
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["connect"])
  }, 20_000)

  test("a delayed 429 for the account that left never closes the next account's recommender", async () => {
    let releaseFirst: (() => void) | undefined
    const worker = recorder([refused(Date.now() + 60 * 60 * 1000, "3600"), answer("rec-bob", ["wiki"]), answer("rec-bob-2", ["connect"])])
    const gated = async (input: unknown, init?: RequestInit) => {
      const response = await worker.fetchImpl(input, init)
      const path = new URL(typeof input === "string" ? input : String(input), "https://app.test").pathname
      if (path === RECOMMEND_PATH && worker.recommends().length === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
      }
      return response
    }
    const { store } = await boot({ fetchImpl: gated })
    signIn(store, "will")
    await settle()
    expect(worker.recommends().length).toBe(1)
    signIn(store, "bob")
    await settle()
    expect(worker.recommends().length).toBe(2)
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki"])
    // Will's refusal arrives now, for bob's row.
    releaseFirst?.()
    await settle()
    expect(row(store)?.retry).toBeUndefined()
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki"])
    materialChange(store, "bob")
    await settle()
    expect(worker.recommends().length).toBe(3)
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["connect"])
  })

})


test("a background repository check regenerates suggestions using hidden observations", async () => {
  const worker = recorder([answer("repo-check", ["issues.list"])])
  const http = repositoryHttpFixture()
  const { store, controller } = await boot({ fetchImpl: (url, init) => String(url).includes("/api/recommend") ? worker.fetchImpl(url, init) : http(String(url), init) })
  await signIn(store).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "owner/repo", org: "owner", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
  controller.selectRepo("owner/repo")
  await controller.commands.run("repo.update", "owner/repo")
  await settle(12)
  const request = worker.recommends().at(-1)?.body
  expect(request).toBeDefined()
  expect(request!.repo).toBe("owner/repo")
  expect(store.session().activeRepoKey).toBe("owner/repo")
  const tail = request!.tail as { role: string; text: string }[]
  expect(tail.some(entry => entry.role === "system" && entry.text.includes('"repo":"owner/repo"'))).toBe(true)
  expect(tail.some(entry => entry.role === "system" && entry.text.includes('"openIssues":2'))).toBe(true)
  expect(row(store)?.suggestions.some(suggestion => suggestion.flow === "issues.list")).toBe(true)
  expect([...store.collections.cards.values()].some(card => card.kind === "repo-update")).toBe(false)
})

test("a recommended read warms its exact arguments without opening a view, then the click reuses it", async () => {
  const worker = recorder()
  let reads = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const { store, controller } = await boot({ recommender: { enabled: false }, fetchImpl: async (input, init) => {
    if (String(input).includes("/api/repos/will/demo/issues")) {
      reads++
      await pending
      return json(200, [])
    }
    return worker.fetchImpl(input, init)
  } })
  signIn(store)
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/demo", org: "will", ownerKind: "user", name: "demo", head: null }] })
  await settle()
  store.dispatch({ type: "recommendations.updated", actor: "system", revision: store.session().revision, source: "agent", suggestions: [
    { id: "issues", label: "Issues", flow: "issues.list", args: "will/demo", emphasis: "primary" }
  ] })
  await settle()
  expect(reads).toBe(1)
  expect([...store.collections.cards.values()].some(card => card.id === "issues-will/demo")).toBe(false)
  const click = controller.commands.run("issues.list", "will/demo")
  await settle()
  expect(store.collections.cards.get("issues-will/demo")?.loading).toBe(true)
  release()
  await click
  expect(reads).toBe(1)
  expect(store.collections.cards.get("issues-will/demo")).toMatchObject({ kind: "issue-list", loading: false })
})


test("verified HTTP completion refreshes recommendations once after the final answer, never for deltas", async () => {
  const worker = recorder([answer("http-answer", ["wiki"])])
  const { store } = await boot({ fetchImpl: worker.fetchImpl })
  const runId = "recommend-http", legId = "recommend-leg", attemptId = "recommend-attempt"
  let cursor: AgentTurnCursor = { version: 1, runId, legId, batch: 0, position: 0, hash: "0".repeat(64) }
  const batch = (frames: AgentTurnFrame[]): AgentTurnBatch => {
    const body = { version: 1 as const, runId, legId, batch: cursor.batch + 1, from: cursor.position + 1, previousHash: cursor.hash, frames }
    return { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) }
  }
  await store.dispatch({ type: "http.turn.started", actor: "user", attemptId, turnId: runId, text: "Read the docs", retry: false,
    journal: { version: 1, legId, token: "a".repeat(64) } }).isPersisted.promise
  await store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId, legId, cursor }).isPersisted.promise
  const delta = batch([{ type: "delta", runId, kind: "text", text: "Read the wiki." }])
  await store.dispatch({ type: "http.turn.batch.received", actor: "system", attemptId, legId, batch: delta }).isPersisted.promise
  await settle()
  expect(worker.recommends()).toHaveLength(0)
  cursor = { version: 1, runId, legId, batch: delta.batch, position: delta.from + delta.frames.length - 1, hash: delta.hash }
  const complete = batch([{ type: "done", runId, reason: "stop" }])
  const completion = { type: "http.turn.batch.received" as const, actor: "system" as const, attemptId, legId, batch: complete }
  await store.dispatch(completion).isPersisted.promise
  await settle()
  expect(worker.recommends()).toHaveLength(1)
  expect(worker.recommends()[0]?.body.tail).toEqual([
    { role: "user", text: "Read the docs" }, { role: "assistant", text: "Read the wiki." }
  ])
  await store.dispatch(completion).isPersisted.promise
  await settle()
  expect(worker.recommends()).toHaveLength(1)
})
