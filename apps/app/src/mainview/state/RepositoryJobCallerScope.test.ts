import { expect, test } from "bun:test"
import { CardSchema } from "@smthrs/rpc/Cards"
import { initialSetup, setupCandidate, type RepositoryJob, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import type { RepositoryJobObservation } from "./AppState"
import { createAppStore } from "./AppStore"
import { repositoryJobBinding } from "./RepoContext"
import { registeredRepositoryJobs, repositoryCiConfigured, repositoryJobStates } from "./RepositoryJobs"
import { memoryStorage } from "./TestFixtures"

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

async function fixture(select = true) {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const close = async () => {
    if (store.dispose === undefined) throw new Error("The fixture requires an owned store disposal method")
    await store.dispose()
  }
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: owner, admin: false, scopesPlain: null }).isPersisted.promise
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
  return store.dispatch({ type: "card.upsert", actor: "user", card: CardSchema.parse({
    id: `saved-${login}-${target}-${job}`, kind: "repository-setup", title: "Setup", status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
    payload: { ...setup, workspaceId, active: { registrationId: `saved-${job}`, revision: 1, digest: setupCandidate(setup), sourceRevision: "c9785dea", enabled: true, owned: true } }
  }) }).isPersisted.promise
}

test("a retired setup cannot override the selected computer or claim a CI registration", async () => {
  const t = await fixture()
  try {
    await saveSetup(t.store, "ci", other)
    expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: selected })
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

test("conflicting retired setups leave the selected computer and registration authority intact", async () => {
  const t = await fixture()
  try {
    await saveSetup(t.store, "issues", other)
    await saveSetup(t.store, "feature", selected)
    expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: selected })
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

test("retired setups with login casing differences cannot supply routing authority", async () => {
  const t = await fixture()
  try {
    await saveSetup(t.store, "issues", other, "MAINTAINER")
    await saveSetup(t.store, "feature", other)
    expect(repositoryJobBinding(t.store, repo)).toEqual({ workspaceId: selected })
  } finally { await t.close() }
})
