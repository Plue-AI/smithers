import { expect, test } from "bun:test"
import { initialSetup, RepositoryJobSchema, setupCandidate, type RepositoryJob, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, silentAgent, waitFor } from "../TestFixtures"
import { repositoryJobStates } from "../RepositoryJobs"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createRepositorySetupController } from "./repositorySetup"

const repo = "example/repo"
const owner = "maintainer"
const workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
const jobs: readonly RepositoryJob[] = ["issues", "review", "ci", "feature", "chores"]

const selectRepository = async (store: Awaited<ReturnType<typeof createAppStore>>, id = repo) => {
  await store.dispatch({ type: "repository.upserted", actor: "system", repository: {
    id, org: id.split("/")[0]!, name: "repo", ownerKind: "user", head: null, catalog: true
  } }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id }).isPersisted.promise
}

const selectWorkspace = async (store: Awaited<ReturnType<typeof createAppStore>>, id: string) => {
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{
    id, repoId: repo, name: "Selected computer", targetBookmark: null, status: "running",
    provisioningStage: null, suspendedAt: null, createdAt: null
  }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: `${repo}#workspace:${id}` }).isPersisted.promise
}

const registration = (job: RepositoryJob, enabled: boolean, revision: number): Extract<SetupRecoveryResponse["registration"], { state: "known" }> => {
  const setup = initialSetup(repo, job, owner)
  return { state: "known", active: {
    registrationId: `registered-${job}`, workspaceId, revision, digest: setupCandidate(setup),
    sourceRevision: "c9785dea", enabled, owned: true, draft: setup.draft
  } }
}

// This unit controls the HTTP seam; the actual store, dispatcher and controller
// run so that no existing setup card can supply a registration accidentally.
test("a fresh conversation reads all selected repository job registrations without opening setup cards", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: owner, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: repo, org: "example", name: "repo", ownerKind: "user", head: null, catalog: true } }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
  const calls: Array<{ method: string; repo: string | null; job: string | null }> = []
  const replies = Promise.withResolvers<void>()
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input), "https://app.test")
      if (url.pathname !== "/api/repository-setup/state") return Response.json({}, { status: 404 })
      calls.push({ method: init?.method ?? "GET", repo: url.searchParams.get("repo"), job: url.searchParams.get("job") })
      const job = RepositoryJobSchema.parse(url.searchParams.get("job"))
      await replies.promise
      const body: SetupRecoveryResponse = { owner, repo, job,
        registration: job === "issues" ? registration(job, false, 4)
          : job === "feature" ? registration(job, true, 57) : { state: "known" },
        setup: { state: "none" }
      }
      return Response.json(body)
    }
  })
  try {
    await waitFor(() => calls.length === 5)
    controller.changeDraft("Chat stays usable while registrations are read")
    expect(store.session().draft).toBe("Chat stays usable while registrations are read")
    expect([...store.collections.cards.values()].filter(card => card.kind === "repository-setup")).toEqual([])
    expect(calls).toEqual(jobs.map(job => ({ method: "GET", repo, job })))
    expect(repositoryJobStates(store.collections.repositoryJobObservations.values(), store.collections.cards.values(), repo, owner)).toEqual({})
    replies.resolve()
    await waitFor(() => store.collections.repositoryJobObservations.size === 5
      && [...store.collections.repositoryJobObservations.values()].every(row => row.state === "completed"))
    expect(repositoryJobStates(store.collections.repositoryJobObservations.values(), store.collections.cards.values(), repo, owner))
      .toEqual({ issues: "Paused", review: "Off", ci: "Off", feature: "Enabled", chores: "Off" })
    expect([...store.collections.cards.values()].filter(card => card.kind === "repository-setup")).toEqual([])
    const previousBranch = store.session().activeBranchId
    const before = new Set(store.collections.messages.keys())
    await store.dispatch({ type: "message.appended", actor: "user", text: "The conversation to archive" }).isPersisted.promise
    const messageIds = [...store.collections.messages.keys()].filter(id => !before.has(id))
    expect(messageIds).toHaveLength(1)
    await controller.clearConversation({ summarize: false })
    expect(store.session().activeBranchId).not.toBe(previousBranch)
    expect(messageIds.every(id => !store.collections.messages.has(id))).toBe(true)
    await settle()
    expect(repositoryJobStates(store.collections.repositoryJobObservations.values(), store.collections.cards.values(), repo, owner))
      .toEqual({ issues: "Paused", review: "Off", ci: "Off", feature: "Enabled", chores: "Off" })
    expect(calls).toHaveLength(5)
    expect([...store.collections.cards.values()].filter(card => card.kind === "repository-setup")).toEqual([])
  } finally {
    replies.resolve()
    await controller.dispose()
    await store.dispose?.()
  }
})

type Read = { owner: string | null | undefined; repo: string; job: RepositoryJob; method: string }
const known = (read: Read): SetupRecoveryResponse => ({
  owner: read.owner ?? owner, repo: read.repo, job: read.job, registration: { state: "known" }, setup: { state: "none" }
})

async function fixture(answer: (read: Read) => Promise<Response> = async read => Response.json(known(read))) {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: owner, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  for (const id of [repo, "other/repo"]) await store.dispatch({ type: "repository.upserted", actor: "system", repository: {
    id, org: id.split("/")[0]!, name: "repo", ownerKind: "user", head: null, catalog: true
  } }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
  const calls: Read[] = []
  const ctx = createControllerContext(store, silentAgent, { fetchImpl: async (input, init) => {
    const url = new URL(String(input), "https://app.test")
    if (url.pathname !== "/api/repository-setup/state") throw new Error(`Unexpected controlled request ${url.pathname}`)
    const read = { owner: ctx.accountOwner(), repo: url.searchParams.get("repo")!,
      job: RepositoryJobSchema.parse(url.searchParams.get("job")), method: init?.method ?? "GET" }
    calls.push(read)
    return answer(read)
  } })
  const failures = createFailureController(ctx)
  ctx.withToast = failures.withToast
  ctx.resolveToast = failures.resolveToast
  const controller = createRepositorySetupController(ctx)
  const rows = () => [...store.collections.repositoryJobObservations.values()]
  const labels = (target = repo, login: string | null = owner, selectedWorkspaceId: string | null = null) =>
    repositoryJobStates(rows(), store.collections.cards.values(), target, login, selectedWorkspaceId)
  const identity = (login: string | null) => store.dispatch({ type: "identity.session.loaded", actor: "system",
    state: login === null ? "signed-out" : "signed-in", login, allowlisted: login !== null, admin: false, scopesPlain: null }).isPersisted.promise
  return { store, storage, ctx, controller, calls, rows, labels, identity,
    close: async () => { await ctx.dispose(); await store.dispose?.() } }
}

test("subscriptions and refresh acknowledge immediately, share pending reads, and keep unknown state unlabeled", async () => {
  const gate = Promise.withResolvers<void>()
  const t = await fixture(async read => { await gate.promise; return Response.json(known(read)) })
  try {
    expect(t.controller.subscribeRepositoryJobs()).toBeUndefined()
    expect(t.controller.subscribeRepositoryJobs()).toBeUndefined()
    expect(t.controller.refreshRepositoryJobs()).toBeUndefined()
    await waitFor(() => t.calls.length === 5)
    expect(t.labels()).toEqual({})
    expect(t.rows()).toHaveLength(5)
    expect(t.rows().map(row => ({ id: row.id, state: row.state, registration: row.registration }))).toEqual(expect.arrayContaining(jobs.map(job => ({
      id: JSON.stringify([owner, repo, null, job]), state: "requested", registration: undefined
    }))))
    t.controller.refreshRepositoryJobs()
    await settle()
    expect(t.calls).toHaveLength(5)
    gate.resolve()
    await waitFor(() => t.rows().every(row => row.state === "completed"))
    expect(t.labels()).toEqual({ issues: "Off", review: "Off", ci: "Off", feature: "Off", chores: "Off" })
  } finally {
    gate.resolve()
    await t.close()
  }
})

test("the same account with different login casing admits the scoped host answer", async () => {
  const t = await fixture(async read => Response.json({ ...known(read), owner: "MAINTAINER" }))
  try {
    t.controller.subscribeRepositoryJobs()
    await waitFor(() => t.rows().length === 5 && t.rows().every(row => row.state === "completed"))
    expect(t.labels(repo, "MAINTAINER")).toEqual({ issues: "Off", review: "Off", ci: "Off", feature: "Off", chores: "Off" })
    expect(new Set(t.rows().map(row => row.id))).toEqual(new Set(jobs.map(job => JSON.stringify([owner, repo, null, job]))))
  } finally { await t.close() }
})

test("a signed-out conversation performs no registration reads until a real account signs in", async () => {
  const t = await fixture()
  try {
    await t.identity(null)
    t.controller.subscribeRepositoryJobs()
    t.controller.refreshRepositoryJobs()
    await settle()
    expect(t.calls).toEqual([])
    expect(t.rows()).toEqual([])
    expect(t.labels(repo, null)).toEqual({})
    await t.identity(owner)
    // Ending an account clears its inventory and selection; the new account
    // admits its own repository before any repository read may start.
    await selectRepository(t.store)
    await waitFor(() => t.rows().length === 5 && t.rows().every(row => row.state === "completed"))
    expect(t.calls).toHaveLength(5)
    expect(t.labels().issues).toBe("Off")
  } finally { await t.close() }
})

for (const matches of [true, false]) test(`an explicitly selected workspace ${matches ? "admits" : "does not borrow"} the host registration`, async () => {
  const selectedWorkspaceId = matches ? workspaceId : "85115e28-6a24-436e-9511-3606914e2a6b"
  const t = await fixture(async read => Response.json({ ...known(read), registration: registration(read.job, true, 4) }))
  try {
    await selectWorkspace(t.store, selectedWorkspaceId)
    t.controller.subscribeRepositoryJobs()
    await waitFor(() => t.rows().length === 5 && t.rows().every(row => row.state === "completed"))
    expect(t.rows().map(row => ({ id: row.id, selectedWorkspaceId: row.selectedWorkspaceId }))).toEqual(expect.arrayContaining(jobs.map(job => ({
      id: JSON.stringify([owner, repo, selectedWorkspaceId, job]), selectedWorkspaceId
    }))))
    expect(t.labels(repo, owner, selectedWorkspaceId)).toEqual(matches
      ? { issues: "Enabled", review: "Enabled", ci: "Enabled", feature: "Enabled", chores: "Enabled" } : {})
    expect(t.labels(repo, owner)).toEqual({})
  } finally { await t.close() }
})

for (const first of ["observation", "recovery"] as const) test(`${first} starting first shares its pending HTTP read with the other registration reader`, async () => {
  const gate = Promise.withResolvers<void>()
  const t = await fixture(async read => {
    await gate.promise
    return Response.json({ ...known(read), registration: read.job === "issues" ? registration(read.job, false, 4) : { state: "known" } })
  })
  const cardId = "observed-issues-setup"
  try {
    const payload = initialSetup(repo, "issues", owner)
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: {
      id: cardId, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
      payload: { ...payload, inspectedAt: 1, recovery: { id: "recover-observed-issues", baseRevision: payload.revision,
        baseDigest: setupCandidate(payload), state: "requested", registrationState: "unknown" } }
    } }).isPersisted.promise
    if (first === "observation") {
      t.controller.subscribeRepositoryJobs()
      await waitFor(() => t.calls.length === 5)
      t.controller.resumeRepositorySetups()
    } else {
      t.controller.resumeRepositorySetups()
      await waitFor(() => t.calls.length === 1)
      t.controller.subscribeRepositoryJobs()
      await waitFor(() => t.calls.length >= 5)
    }
    await settle()
    expect(t.calls.filter(read => read.job === "issues")).toHaveLength(1)
    gate.resolve()
    await waitFor(() => {
      const card = t.store.collections.cards.get(cardId)
      return card?.kind === "repository-setup" && card.payload.recovery?.state === "completed"
    })
    expect(t.labels().issues).toBe("Paused")
    const card = t.store.collections.cards.get(cardId)
    expect(card?.kind === "repository-setup" ? card.payload.active : undefined).toMatchObject({
      registrationId: "registered-issues", revision: 4, enabled: false, owned: true
    })
    expect(t.calls).toHaveLength(5)
  } finally { gate.resolve(); await t.close() }
})

test("forced refresh retains one read per job and replaces completed state without a card", async () => {
  let enabled = false
  const t = await fixture(async read => Response.json({ ...known(read),
    registration: read.job === "issues" ? registration(read.job, enabled, 4) : { state: "known" }
  }))
  try {
    t.controller.subscribeRepositoryJobs()
    await waitFor(() => t.rows().length === 5 && t.rows().every(row => row.state === "completed"))
    expect(t.labels()).toEqual({ issues: "Paused", review: "Off", ci: "Off", feature: "Off", chores: "Off" })
    t.controller.subscribeRepositoryJobs()
    await settle()
    expect(t.calls).toHaveLength(5)
    enabled = true
    t.controller.refreshRepositoryJobs()
    await waitFor(() => t.calls.length === 10 && t.labels().issues === "Enabled")
    expect(t.calls.filter(read => read.job === "issues")).toHaveLength(2)
    expect([...t.store.collections.cards.values()]).toEqual([])
  } finally { await t.close() }
})

test("active registrations take precedence over trials and known absence alone produces Off", async () => {
  const t = await fixture(async read => {
    const active = registration(read.job, read.job !== "issues", 4).active!
    const trial = { ...active, enabled: read.job !== "ci" }
    const state: SetupRecoveryResponse["registration"] = read.job === "issues" ? { state: "known", active, trial }
      : read.job === "review" || read.job === "ci" ? { state: "known", trial }
      : read.job === "feature" ? { state: "known", active: { ...active, owned: false } } : { state: "known" }
    return Response.json({ ...known(read), registration: state })
  })
  try {
    t.controller.subscribeRepositoryJobs()
    await waitFor(() => t.rows().length === 5 && t.rows().every(row => row.state === "completed"))
    expect(t.labels()).toEqual({ issues: "Paused", review: "Trial", ci: "Paused", feature: "Enabled", chores: "Off" })
  } finally { await t.close() }
})

test("a setup card only annotates draft changes for the host's same enabled registration", async () => {
  const t = await fixture(async read => Response.json({ ...known(read), registration: registration(read.job, true, 4) }))
  try {
    t.controller.subscribeRepositoryJobs()
    await waitFor(() => t.rows().length === 5 && t.rows().every(row => row.state === "completed"))
    const payload = initialSetup(repo, "issues", owner)
    const card = { id: "draft-issues", kind: "repository-setup" as const, title: "Handle issues", status: "active" as const,
      createdAt: 1, ordinal: t.store.nextOrdinal(), payload: { ...payload, revision: 5,
        active: { registrationId: "registered-issues", revision: 4, digest: setupCandidate(payload), sourceRevision: "c9785dea", enabled: true, owned: true }
      } }
    await t.store.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
    expect(t.labels().issues).toBe("Enabled · draft changes")
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: { ...card, payload: { ...card.payload,
      active: { ...card.payload.active, registrationId: "obsolete-issues" }
    } } }).isPersisted.promise
    expect(t.labels().issues).toBe("Enabled")
  } finally { await t.close() }
})

for (const failure of ["network", "http", "invalid-body", "owner", "repo", "job", "unavailable"] as const) {
  test(`a ${failure} registration read cannot produce Off or a borrowed job label and can recover`, async () => {
    let failing = true
    const t = await fixture(async read => {
      if (read.job !== "ci" || !failing) return Response.json(known(read))
      if (failure === "network") throw new Error("Controlled connection failure")
      if (failure === "http") return Response.json({ message: "Controlled host outage" }, { status: 503 })
      if (failure === "invalid-body") return Response.json({ owner, repo, job: "ci" })
      const body: SetupRecoveryResponse = { ...known(read),
        ...(failure === "owner" ? { owner: "another-maintainer" } : {}),
        ...(failure === "repo" ? { repo: "other/repo" } : {}),
        ...(failure === "job" ? { job: "issues" as const } : {}),
        ...(failure === "unavailable" ? { registration: { state: "unavailable" as const, error: "Registry unavailable" } } : {})
      }
      return Response.json(body)
    })
    try {
      t.controller.subscribeRepositoryJobs()
      await waitFor(() => t.rows().length === 5 && t.rows().every(row => row.state !== "requested"))
      expect(t.labels()).toEqual({ issues: "Off", review: "Off", feature: "Off", chores: "Off" })
      expect(t.rows().find(row => row.job === "ci")?.error).toBeTruthy()
      expect([...t.store.collections.cards.values()]).toEqual([])
      failing = false
      t.controller.refreshRepositoryJobs()
      await waitFor(() => t.labels().ci === "Off")
      expect(t.rows().find(row => row.job === "ci")?.error).toBeUndefined()
    } finally { await t.close() }
  })
}

for (const change of ["owner", "sign-out", "repo", "workspace", "dispose"] as const) for (const result of ["success", "rejection"] as const) {
  test(`a late registration ${result} after ${change} cannot change rows or the journal`, async () => {
    const pending: Array<{ read: Read; deferred: ReturnType<typeof Promise.withResolvers<Response>> }> = []
    const t = await fixture(async read => {
      const deferred = Promise.withResolvers<Response>()
      pending.push({ read, deferred })
      return deferred.promise
    })
    try {
      t.controller.subscribeRepositoryJobs()
      await waitFor(() => pending.length === 5)
      const old = pending.slice()
      if (change === "owner") { await t.identity("another-maintainer"); await selectRepository(t.store) }
      if (change === "sign-out") await t.identity(null)
      if (change === "repo") await t.store.dispatch({ type: "repo.selected", actor: "user", id: "other/repo" }).isPersisted.promise
      if (change === "workspace") await selectWorkspace(t.store, workspaceId)
      if (change === "dispose") await t.ctx.dispose()
      if (change === "owner" || change === "repo" || change === "workspace") await waitFor(() => pending.length === 10)
      await t.store.settled?.()
      const snapshot = structuredClone({ rows: t.rows(), transitions: [...t.store.collections.transitions.values()] })
      for (const { read, deferred } of old) {
        if (result === "success") deferred.resolve(Response.json({ ...known(read), registration: registration(read.job, true, 4) }))
        else deferred.reject(new Error("Late controlled connection failure"))
      }
      await Promise.allSettled(old.map(item => item.deferred.promise))
      await settle()
      expect({ rows: t.rows(), transitions: [...t.store.collections.transitions.values()] }).toEqual(snapshot)
      expect(t.labels(change === "repo" ? "other/repo" : repo, change === "owner" ? "another-maintainer" : change === "sign-out" ? null : owner,
        change === "workspace" ? workspaceId : null)).toEqual({})
      if (change === "sign-out" || change === "dispose") expect(t.calls).toHaveLength(5)
    } finally {
      for (const { read, deferred } of pending) deferred.resolve(Response.json(known(read)))
      await t.close()
    }
  })
}

test("reload starts with no observation and a new controller reads changed host registrations", async () => {
  const t = await fixture()
  let reopened: Awaited<ReturnType<typeof createAppStore>> | undefined
  let controller: ReturnType<typeof createAppController> | undefined
  let closed = false
  try {
    t.controller.subscribeRepositoryJobs()
    await waitFor(() => t.rows().length === 5 && t.rows().every(row => row.state === "completed"))
    expect(t.labels().ci).toBe("Off")
    await t.close()
    closed = true
    reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
    expect([...reopened.collections.repositoryJobObservations.values()]).toEqual([])
    expect(repositoryJobStates(reopened.collections.repositoryJobObservations.values(), reopened.collections.cards.values(), repo, owner)).toEqual({})
    const calls: RepositoryJob[] = []
    controller = createAppController(reopened, silentAgent, {
      bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
      fetchImpl: async input => {
        const url = new URL(String(input), "https://app.test")
        if (url.pathname !== "/api/repository-setup/state") return Response.json({}, { status: 404 })
        const job = RepositoryJobSchema.parse(url.searchParams.get("job"))
        calls.push(job)
        return Response.json({ owner, repo, job, registration: job === "ci" ? registration(job, true, 8) : { state: "known" }, setup: { state: "none" } })
      }
    })
    const fresh = reopened
    await waitFor(() => [...fresh.collections.repositoryJobObservations.values()].length === 5
      && [...fresh.collections.repositoryJobObservations.values()].every(row => row.state === "completed"))
    expect(calls).toEqual([...jobs])
    expect(repositoryJobStates(fresh.collections.repositoryJobObservations.values(), fresh.collections.cards.values(), repo, owner))
      .toEqual({ issues: "Off", review: "Off", ci: "Enabled", feature: "Off", chores: "Off" })
    expect([...fresh.collections.cards.values()].filter(card => card.kind === "repository-setup")).toEqual([])
  } finally { await controller?.dispose(); await reopened?.dispose?.(); if (!closed) await t.close() }
})
