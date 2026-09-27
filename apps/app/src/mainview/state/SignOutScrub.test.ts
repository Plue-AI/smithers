import { describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { json, memoryStorage, settled, unavailableAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * §2.4: the transcript, its cards and the balance are persisted, so signing
 * out and reloading still rendered the previous account's repository names,
 * balance and open cards — on a shared machine, to whoever sits down next.
 * Signing out empties them.
 */

const backend = (routes: Record<string, () => Response | Promise<Response>>): AppServices => ({
  fetchImpl: async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const path = new URL(url, "https://app.test").pathname
    const answer = routes[path]
    return answer === undefined ? json(404, { message: `no stub for ${path}` }) : answer()
  }
})

const signedIn = (store: AppStore, login = "codeplanesmithers"): void => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login,
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
}

/** The previous account's data, as the persisted store holds it. */
const seedAccountState = (store: AppStore): void => {
  store.dispatch({
    type: "message.appended",
    actor: "system",
    text: "You have 6 open issues across codeplanesmithers/canary-sandbox."
  })
  store.dispatch({
    type: "billing.refreshed",
    actor: "system",
    state: "ok",
    totalUsd: "505",
    allowedToStartWork: true,
    lifetimeChargedUsd: "0",
    chargeCount: 0
  })
  store.dispatch({
    type: "card.upsert",
    actor: "user",
    card: {
      id: "balance",
      kind: "balance",
      title: "Balance",
      status: "active",
      createdAt: Date.now(),
      ordinal: 1,
      payload: {
        state: "ok",
        totalUsd: "505",
        allowedToStartWork: true,
        lifetimeChargedUsd: "0",
        chargeCount: 0,
        introUsd: null
      }
    }
  })
  store.dispatch({ type: "toast.shown", actor: "system", key: "alice-private", title: "Alice private work" })
  store.dispatch({
    type: "toolcall.recorded",
    actor: "smithers",
    turnId: "alice-turn",
    name: "issues.list",
    arguments: JSON.stringify({ repo: "alice/private" }),
    result: JSON.stringify({ title: "private issue" })
  })
}

const leftovers = (store: AppStore) => ({
  messages: store.collections.messages.size,
  cards: store.collections.cards.size,
  billing: store.collections.billingAccounts.get("billing")?.totalUsd ?? null,
  billingState: store.collections.billingAccounts.get("billing")?.state ?? null,
  toolCalls: store.collections.toolCalls.size,
})

describe("signing out leaves nothing of the account behind", () => {
  test("an explicit sign-out empties the transcript, the cards and the balance", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableAgent,
      backend({ "/api/auth/logout": () => json(200, { ok: true }) })
    )
    signedIn(store)
    seedAccountState(store)
    expect(leftovers(store).messages).toBeGreaterThan(0)

    await controller.commands.run("auth.sign-out")
    await settled()
    expect(leftovers(store)).toEqual({
      messages: 0,
      cards: 0,
      billing: null,
      billingState: "unknown",
      toolCalls: 0,
    })
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  test("a session that expires between loads is scrubbed the same way", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableAgent,
      backend({ "/api/auth/session": () => json(200, { status: "signed-out" }) })
    )
    signedIn(store)
    seedAccountState(store)

    await controller.loadSession()
    await settled()
    expect(leftovers(store)).toEqual({
      messages: 0,
      cards: 0,
      billing: null,
      billingState: "unknown",
      toolCalls: 0,
    })
  })

  test("a direct Alice-to-Bob session replacement scrubs Alice before publishing Bob", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    signedIn(store, "alice")
    seedAccountState(store)

    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "bob",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    await settled()

    expect(store.collections.identitySessions.get("identity")?.login).toBe("bob")
    expect(leftovers(store)).toEqual({
      messages: 0,
      cards: 0,
      billing: null,
      billingState: "unknown",
      toolCalls: 0,
    })
    expect([...store.collections.transitions.values()].every((row) => !row.payload.includes("alice"))).toBe(true)
  })

  test("an unavailable identity seam scrubs nothing — silence is not a sign-out", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableAgent,
      backend({ "/api/auth/session": () => json(500, { message: "down" }) })
    )
    signedIn(store)
    seedAccountState(store)

    await controller.loadSession()
    await settled()
    expect(leftovers(store).messages).toBeGreaterThan(0)
    expect(store.collections.identitySessions.get("identity")?.state).toBe("unavailable")
  })

  test("a forbidden 403 from the session probe is an outage, never a sign-out", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableAgent,
      backend({ "/api/auth/session": () => json(403, { message: "forbidden" }) })
    )
    signedIn(store)
    seedAccountState(store)

    await controller.loadSession()
    await settled()
    expect(leftovers(store).messages).toBeGreaterThan(0)
    expect(store.collections.identitySessions.get("identity")?.state).toBe("unavailable")
  })

  test("a refused sign-out with a freshly confirmed session says so and preserves the account", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableAgent,
      backend({
        "/api/auth/logout": () => json(403, { message: "forbidden" }),
        "/api/auth/session": () => json(200, { state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false })
      })
    )
    signedIn(store)
    seedAccountState(store)

    const outcome = await controller.commands.run("auth.sign-out")
    expect(outcome.status).toBe("failed")
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-in")
    expect(leftovers(store).messages).toBeGreaterThan(0)
  })
})

const loadIdentity = (store: AppStore, state: "signed-in" | "signed-out" | "unavailable", login: string | null = null) =>
  store.dispatch({
    type: "identity.session.loaded", actor: "system", state, login,
    allowlisted: state === "signed-in", admin: false, scopesPlain: null
  }).isPersisted.promise

describe("retained account ownership", () => {
  for (const next of ["signed-out", "signed-in"] as const) {
    for (const reload of [false, true]) {
      test(`Alice -> outage -> ${next}${reload ? " across reload" : ""} scrubs before publishing`, async () => {
        const storage = memoryStorage()
        let store = await createAppStore({ kind: "localStorage", storage })
        await loadIdentity(store, "signed-in", "alice")
        seedAccountState(store)
        await loadIdentity(store, "unavailable")
        expect(leftovers(store).messages).toBeGreaterThan(0)
        if (reload) {
          await store.dispose?.()
          store = await createAppStore({ kind: "localStorage", storage })
        }
        await loadIdentity(store, next, next === "signed-in" ? "bob" : null)
        expect(leftovers(store)).toEqual({
          messages: 0, cards: 0, billing: null, billingState: "unknown", toolCalls: 0
        })
        expect([...store.collections.transitions.values()].every((row) => !row.payload.includes("alice"))).toBe(true)
        await store.dispose?.()
        const reopened = await createAppStore({ kind: "localStorage", storage })
        expect(leftovers(reopened).messages).toBe(0)
        expect(reopened.collections.identitySessions.get("identity")?.state).toBe(next)
        await reopened.dispose?.()
      })
    }
  }
})

/** Every additional account projection omitted by the original scrub. */
const seedPrivateRoster = async (store: AppStore): Promise<void> => {
  await store.dispatch({ type: "model.saved", actor: "user", model: { id: "private", protocol: "openai-chat", modelId: "private", credential: "ALICE_PRIVATE_KEY", baseUrl: "https://alice.example" } }).isPersisted.promise
  await store.dispatch({ type: "seat.assigned", actor: "user", seat: "explainer", recordId: "private" }).isPersisted.promise
  seedAccountState(store)
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "ALICE_PRIVATE_DRAFT" }).isPersisted.promise
  await store.dispatch({
    type: "command.deferred", actor: "user", name: "issues.create", args: "ALICE_PRIVATE_ACTION", requirement: "signed-in"
  }).isPersisted.promise
  await store.dispatch({
    type: "repositories.loaded", actor: "system",
    repositories: [{ id: "alice/private", org: "alice", name: "private", ownerKind: "user", head: null }]
  }).isPersisted.promise
  await store.dispatch({
    type: "workingcopies.workspaces.loaded", actor: "system",
    copies: [{ id: "workspace:legacy", repoId: "alice/private", kind: "workspace", label: "Private legacy copy", workspaceId: "legacy" }]
  }).isPersisted.promise
  await store.dispatch({
    type: "workspaces.loaded", actor: "system",
    workspaces: [{ id: "private", repoId: "alice/private", name: "Private workspace", targetBookmark: null,
      status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }]
  }).isPersisted.promise
  await store.dispatch({
    type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "alice", expiresAt: null, scopes: null
  }).isPersisted.promise
  await store.dispatch({
    type: "change.loaded", actor: "system", change: {
      id: "alice/private#c", repoId: "alice/private", changeId: "c", commitId: null, description: "ALICE_PRIVATE_CHANGE",
      authorName: "Alice", timestamp: null, hasConflict: false, parentChangeIds: [], currentSeq: null, revisionCount: null
    }
  }).isPersisted.promise
  await store.dispatch({ type: "github.app-status.loaded", actor: "system", status: {
    repo: "alice/private", installed: true, configured: true, installationId: 1, installUrl: null, rateLimit: null,
  } }).isPersisted.promise
  await store.dispatch({ type: "recommendations.updated", actor: "smithers",
    suggestions: [{ id: "private", label: "Alice private", flow: "issues.create", args: "ALICE_PRIVATE", emphasis: "primary" }],
    source: "agent", revision: store.session().revision
  }).isPersisted.promise
  await store.dispatch({ type: "tab.opened", actor: "user", tab: {
    id: "private-card-tab", kind: "card", title: "Alice private card", cardId: "balance"
  } }).isPersisted.promise
  await store.dispatch({ type: "palette.toggled", actor: "user", open: false, lastQuery: "ALICE_PRIVATE_QUERY" }).isPersisted.promise
  await store.dispatch({ type: "palette.item.opened", actor: "user", ref: "alice/private", kind: "repository", at: 1 }).isPersisted.promise
  await store.dispatch({ type: "tab.selected", actor: "user", id: "private-card-tab" }).isPersisted.promise
  await store.dispatch({ type: "repo-tree.failed", actor: "system", copyId: "workspace:private", path: "", error: "ALICE_PRIVATE_PATH"
  }).isPersisted.promise
  await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: "alice/private",
    flows: [{ id: "private", description: "ALICE_PRIVATE_FLOW", summary: null, featured: true, model: null, modelInvocable: true }]
  }).isPersisted.promise
}

const privateRosterSizes = (store: AppStore) => ({
  models: store.collections.models.size,
  seats: store.collections.seats.size,
  recommendations: store.collections.recommendations.size,
  repositories: store.collections.repositories.size,
  workingCopies: store.collections.workingCopies.size,
  cloudWorkspaces: store.collections.cloudWorkspaces.size,
  changes: store.collections.changes.size,
  githubAppStatuses: store.collections.githubAppStatuses.size,
  repoTree: store.collections.repoTree.size,
  repositoryFlows: store.collections.repositoryFlows.size
})

for (const next of ["logout", "replacement"] as const) {
  test(`${next} clears the full private roster and deferred intent, durably`, async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    await loadIdentity(store, "signed-in", "alice")
    await seedPrivateRoster(store)
    const world = [...store.collections.worldDocuments.values()]
    expect(Object.values(privateRosterSizes(store)).every((size) => size > 0)).toBe(true)
    if (next === "logout") {
      await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    } else await loadIdentity(store, "signed-in", "bob")
    const assertScrubbed = (current: AppStore) => {
      expect(current.session().draft).toBe("")
      expect(current.session().pendingCommand).toBeNull()
      expect(current.session().paletteLastQuery).toBe("")
      expect(current.session().paletteRecents).toEqual([])
      expect(current.session().activeTabId).toBe("main")
      expect([...current.collections.tabs.keys()]).toEqual(["main"])
      expect(current.collections.toasts.size).toBe(0)
      for (const [name, size] of Object.entries(privateRosterSizes(current))) expect({ name, size }).toEqual({ name, size: 0 })
      expect(current.collections.cloudSessions.get("cloud")?.username).toBeNull()
      expect([...current.collections.worldDocuments.values()]).toEqual(world)
    }
    assertScrubbed(store)
    await store.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    assertScrubbed(reopened)
    await loadIdentity(reopened, "signed-in", "bob")
    const controller = createAppController(reopened, unavailableAgent, backend({}))
    controller.resumeDeferredCommand()
    // Let the controller's automatic onboarding flow finish before closing its
    // store owner; a disposed store correctly refuses late trace writes.
    await settled()
    expect([...reopened.collections.toasts.values()].some((toast) => toast.key === "command.resume.issues.create")).toBe(false)
    await controller.dispose()
    await reopened.dispose?.()
  })
}
