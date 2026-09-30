import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { initialSetup, setupCandidate, type RepositoryJob, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import { repositorySetupCardFamily } from "../cards/RepositorySetupCard"
import type { CardActions, CardOf } from "../cards/CardFamily"
import type { RepositoryJobObservation } from "./AppState"
import { createAppStore } from "./AppStore"
import { repositoryJobBinding } from "./RepoContext"
import { registeredRepositoryJobs, repositoryCiConfigured, repositoryJobStates } from "./RepositoryJobs"
import { createIssuesSeam } from "./seams/IssuesSeam"
import { memoryStorage } from "./TestFixtures"

let actEnvironment: PropertyDescriptor | undefined
beforeAll(() => {
  actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  GlobalRegistrator.register()
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })
})
afterAll(async () => {
  try { await GlobalRegistrator.unregister() }
  finally {
    if (actEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment)
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  }
})

const repo = "example/repo", owner = "maintainer"
const selected = "de29f26b-e593-4ec2-99fc-583d4711f20a"
const other = "85115e28-6a24-436e-9511-3606914e2a6b"

const policy = (job: RepositoryJob, workspaceId = selected, enabled = true) => {
  const setup = initialSetup(repo, job, owner)
  return { registrationId: `registered-${job}`, workspaceId, revision: 1, digest: setupCandidate(setup),
    sourceRevision: "c9785dea", enabled, owned: true, draft: setup.draft }
}

const observation = (job: RepositoryJob, registration: SetupRecoveryResponse["registration"], selectedWorkspaceId: string | null = selected): RepositoryJobObservation => ({
  id: JSON.stringify([owner, repo, selectedWorkspaceId, job]), owner, repo, job, selectedWorkspaceId, state: "completed", registration
})

const ciCases: ReadonlyArray<{ name: string; row: () => RepositoryJobObservation; offer: boolean }> = [
  { name: "pending read", row: () => ({ ...observation("ci", { state: "known" }), state: "requested", registration: undefined }), offer: false },
  { name: "failed read", row: () => ({ ...observation("ci", { state: "known" }), state: "failed", registration: undefined, error: "Controlled outage" }), offer: false },
  { name: "unavailable registration", row: () => observation("ci", { state: "unavailable", error: "Registry unavailable" }), offer: false },
  { name: "verified absence", row: () => observation("ci", { state: "known" }), offer: true },
  { name: "paused CI", row: () => observation("ci", { state: "known", active: policy("ci", selected, false) }), offer: true },
  { name: "enabled CI", row: () => observation("ci", { state: "known", active: policy("ci") }), offer: false },
  { name: "another selection's absence", row: () => observation("ci", { state: "known" }, null), offer: false },
  { name: "another computer's registration", row: () => observation("ci", { state: "known", active: policy("ci", other) }), offer: false },
  { name: "another account's absence", row: () => ({ ...observation("ci", { state: "known" }), owner: "another-maintainer",
    id: JSON.stringify(["another-maintainer", repo, selected, "ci"]) }), offer: false }
]

async function fixture(select = true) {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const close = async () => {
    if (store.dispose === undefined) throw new Error("The fixture requires an owned store disposal method")
    await store.dispose()
  }
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: owner, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: repo, org: "example", name: "repo", ownerKind: "user", head: null, catalog: true } }).isPersisted.promise
    await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [
      { id: selected, repoId: repo, name: "Selected computer", targetBookmark: null, status: "suspended", provisioningStage: null, suspendedAt: null, createdAt: null },
      { id: other, repoId: repo, name: "Other computer", targetBookmark: null, status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }
    ] }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: select ? `${repo}#workspace:${selected}` : repo }).isPersisted.promise
    const publish = (row: RepositoryJobObservation) => store.dispatch({ type: "repository-job.observed", actor: "system", observation: row }).isPersisted.promise
    return { store, publish, close }
  } catch (error) {
    await close()
    throw error
  }
}

const cardActions = (store: Awaited<ReturnType<typeof createAppStore>>, calls: Array<[string, string | undefined]>): CardActions => ({
  projectionStore: store, signedOut: false,
  onDecideApproval: () => {}, onGrantConfirm: () => {}, onGrantCancel: () => {}, onQueueApprove: () => {},
  onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {},
  onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {},
  onRunCommand: (name, args) => { calls.push([name, args]) }
})

for (const job of ["issues", "feature"] as const) for (const scenario of ciCases) test(`the ${job} setup-card family ${scenario.offer ? "offers" : "does not invent"} CI for ${scenario.name} on the selected computer`, async () => {
  const t = await fixture()
  const calls: Array<[string, string | undefined]> = []
  let host: HTMLDivElement | undefined
  let root: ReturnType<typeof createRoot> | undefined
  try {
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await t.publish(scenario.row())
    const card: CardOf<"repository-setup"> = { id: `${job}-setup`, kind: "repository-setup", title: "Setup", status: "active",
      createdAt: 1, ordinal: 1, payload: initialSetup(repo, job, owner) }
    await act(async () => { root!.render(repositorySetupCardFamily["repository-setup"].render(card, cardActions(t.store, calls))) })
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === "Set up CI")
    expect(buttons).toHaveLength(scenario.offer ? 1 : 0)
    if (scenario.offer) await act(async () => { buttons[0]!.click() })
    expect(calls).toEqual(scenario.offer ? [["ci.setup", repo]] : [])
  } finally {
    try { if (root) await act(async () => { root!.unmount() }) }
    finally { host?.remove(); await t.close() }
  }
})

for (const job of ["issues", "feature"] as const) test(`the ${job} card's recorded different computer cannot borrow the current selection's CI absence`, async () => {
  const t = await fixture()
  const calls: Array<[string, string | undefined]> = []
  let host: HTMLDivElement | undefined
  let root: ReturnType<typeof createRoot> | undefined
  try {
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await t.publish(observation("ci", { state: "known" }))
    const card: CardOf<"repository-setup"> = { id: `${job}-setup`, kind: "repository-setup", title: "Setup", status: "active", createdAt: 1, ordinal: 1,
      payload: { ...initialSetup(repo, job, owner), workspaceId: other } }
    await act(async () => { root!.render(repositorySetupCardFamily["repository-setup"].render(card, cardActions(t.store, calls))) })
    expect([...host.querySelectorAll("button")].filter(button => button.textContent === "Set up CI")).toEqual([])
    expect(calls).toEqual([])
  } finally {
    try { if (root) await act(async () => { root!.unmount() }) }
    finally { host?.remove(); await t.close() }
  }
})

test("the mounted family reacts to verified CI observations without remounting the setup card", async () => {
  const t = await fixture()
  const calls: Array<[string, string | undefined]> = []
  let host: HTMLDivElement | undefined
  let root: ReturnType<typeof createRoot> | undefined
  try {
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await t.publish(ciCases[0]!.row())
    const card: CardOf<"repository-setup"> = { id: "feature-setup", kind: "repository-setup", title: "Setup", status: "active", createdAt: 1, ordinal: 1,
      payload: initialSetup(repo, "feature", owner) }
    await act(async () => { root!.render(repositorySetupCardFamily["repository-setup"].render(card, cardActions(t.store, calls))) })
    const buttons = () => [...host!.querySelectorAll("button")].filter(button => button.textContent === "Set up CI")
    expect(buttons()).toEqual([])
    await act(async () => { await t.publish(observation("ci", { state: "known" })) })
    expect(buttons()).toHaveLength(1)
    await act(async () => { await t.publish(observation("ci", { state: "known", active: policy("ci") })) })
    expect(buttons()).toHaveLength(0)
    expect(calls).toEqual([])
  } finally {
    try { if (root) await act(async () => { root!.unmount() }) }
    finally { host?.remove(); await t.close() }
  }
})

for (const scenario of ciCases) test(`issue creation ${scenario.offer ? "offers one" : "does not invent a"} CI nudge for ${scenario.name} on the selected computer`, async () => {
  const t = await fixture()
  const calls: Array<{ path: string; method: string }> = []
  const issue = { number: 8, title: "Improve logging", body: "", state: "open", labels: [], assignees: [], author: { login: owner }, comment_count: 0 }
  const seam = createIssuesSeam({ store: t.store, dispatch: t.store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: t.store.nextOrdinal,
    http: async (input, init) => {
      const url = new URL(input, "https://app.test"), method = init?.method ?? "GET"
      calls.push({ path: url.pathname, method })
      if (url.pathname === `/api/repos/${repo}/issues` && method === "POST") return Response.json(issue, { status: 201 })
      if (url.pathname === `/api/repos/${repo}/issues/8` && method === "GET") return Response.json(issue)
      if (url.pathname === `/api/repos/${repo}/issues/8/comments` && method === "GET") return Response.json([])
      throw new Error(`Unexpected controlled HTTP request ${method} ${url.pathname}`)
    }
  })
  try {
    await t.publish(scenario.row())
    await seam.createIssue("Improve logging", repo)
    await seam.createIssue("Improve tests", repo)
    await t.store.settled?.()
    const nudges = [...t.store.collections.toasts.values()].filter(toast => toast.action?.flow === "ci.setup")
    expect(nudges).toHaveLength(scenario.offer ? 1 : 0)
    if (scenario.offer) expect(nudges[0]).toMatchObject({ key: `setup-ci:${owner}:${repo}`, status: "ok", action: { label: "Set up CI", args: repo } })
    expect(calls.filter(call => call.method === "POST")).toEqual([
      { path: `/api/repos/${repo}/issues`, method: "POST" }, { path: `/api/repos/${repo}/issues`, method: "POST" }
    ])
  } finally { await t.close() }
})

test("a valid explicit computer is honored before a job has a registration", async () => {
  const t = await fixture()
  try { expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: selected }) }
  finally { await t.close() }
})

test("an observed registration on another computer refuses the explicit selection", async () => {
  const t = await fixture()
  try {
    await t.publish(observation("issues", { state: "known", active: policy("issues", other) }))
    const binding = repositoryJobBinding(t.store, repo)
    expect(binding).toHaveProperty("error")
    expect("workspaceId" in binding).toBe(false)
  } finally { await t.close() }
})

test("registered jobs naming two computers refuse an automatic binding even with one running default", async () => {
  const t = await fixture(false)
  try {
    await t.publish(observation("issues", { state: "known", active: policy("issues", selected) }, null))
    await t.publish(observation("feature", { state: "known", active: policy("feature", other) }, null))
    const binding = repositoryJobBinding(t.store, repo)
    expect(binding).toHaveProperty("error")
    expect("workspaceId" in binding).toBe(false)
  } finally { await t.close() }
})

test("a matching observed registration binds to the explicit computer", async () => {
  const t = await fixture()
  try {
    await t.publish(observation("issues", { state: "known", active: policy("issues") }))
    expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: selected })
  } finally { await t.close() }
})

test("an observed owned registration determines the unselected job computer ahead of the running default", async () => {
  const t = await fixture(false)
  try {
    await t.publish(observation("issues", { state: "known", active: policy("issues") }, null))
    expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: selected })
  } finally { await t.close() }
})

test("an unselected repository with no registered job uses its one running computer", async () => {
  const t = await fixture(false)
  try { expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: other }) }
  finally { await t.close() }
})

const saveSetup = (store: Awaited<ReturnType<typeof createAppStore>>, job: RepositoryJob, workspaceId: string, login = owner, target = repo) => {
  const setup = initialSetup(target, job, login)
  return store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: `saved-${login}-${target}-${job}`, kind: "repository-setup", title: "Setup", status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
    payload: { ...setup, workspaceId, active: { registrationId: `saved-${job}`, revision: 1, digest: setupCandidate(setup), sourceRevision: "c9785dea", enabled: true, owned: true } }
  } }).isPersisted.promise
}

test("a saved setup's computer remains routing provenance without labeling or completing CI", async () => {
  const t = await fixture()
  try {
    await saveSetup(t.store, "ci", other)
    expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: other })
    expect(repositoryCiConfigured(t.store.collections.repositoryJobObservations.values(), repo, owner, selected)).toBeUndefined()
    expect(repositoryJobStates(t.store.collections.repositoryJobObservations.values(), t.store.collections.cards.values(), repo, owner, selected)).toEqual({})
    expect(registeredRepositoryJobs(t.store.collections.repositoryJobObservations.values(), repo, owner, selected).size).toBe(0)
  } finally { await t.close() }
})

test("a verified owned registration overrides older and conflicting saved setup computers", async () => {
  const t = await fixture()
  try {
    await saveSetup(t.store, "issues", other)
    await saveSetup(t.store, "feature", selected)
    await t.publish(observation("issues", { state: "known", active: policy("issues") }))
    expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: selected })
  } finally { await t.close() }
})

test("conflicting saved setup computers refuse a routing fallback without claiming a registration", async () => {
  const t = await fixture()
  try {
    await saveSetup(t.store, "issues", other)
    await saveSetup(t.store, "feature", selected)
    expect(repositoryJobBinding(t.store, repo)).toEqual({ error: "The repository's saved setups name different boxes." })
    expect(registeredRepositoryJobs(t.store.collections.repositoryJobObservations.values(), repo, owner, selected).size).toBe(0)
  } finally { await t.close() }
})

for (const foreign of ["owner", "repo"] as const) test(`a saved setup for a foreign ${foreign} cannot supply this repository's routing provenance`, async () => {
  const t = await fixture()
  try {
    await saveSetup(t.store, "issues", other, foreign === "owner" ? "another-maintainer" : owner, foreign === "repo" ? "another/repo" : repo)
    expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: selected })
  } finally { await t.close() }
})

test("same-account saved setups with login casing differences and one computer share a routing fallback", async () => {
  const t = await fixture()
  try {
    await saveSetup(t.store, "issues", other, "MAINTAINER")
    await saveSetup(t.store, "feature", other)
    expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: other })
  } finally { await t.close() }
})
