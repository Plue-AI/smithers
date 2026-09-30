import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import type { RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import type { RepositoryJobObservation } from "../state/AppState"
import { ControllerContext } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"
import { FIRST_RUN_JOBS } from "./FirstRunActions"
import { resolveSteps, SETUP_STEPS, SetupChecklist, SetupChecklistCard, hasRegisteredSetup } from "./SetupChecklist"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

const commands = [
  { name: "auth.sign-in", summary: "Sign in with GitHub" },
  { name: "repos.import", summary: "Import a GitHub repository into Smithers Cloud" },
  { name: "issues.setup", summary: "Handle issues" },
  { name: "debug.snapshot", summary: "Snapshot", hidden: true },
]
const jobTitles = ["Handle issues", "Review PRs", "Set up CI", "Build a feature", "Automate a chore"]
const jobCommands = [...commands, ...FIRST_RUN_JOBS.map((name, index) => ({ name, summary: jobTitles[index]! }))]
const empty = { signedIn: false, hasRepo: false, hasSetup: false }
const done = { signedIn: true, hasRepo: true, hasSetup: true }

const observation = (payload: RepositorySetup): RepositoryJobObservation => ({
  id: payload.job, owner: payload.owner ?? "", repo: payload.repo, job: payload.job,
  selectedWorkspaceId: null, state: "completed", registration: { state: "known",
    ...(payload.active === undefined ? {} : { active: { ...payload.active,
      owned: payload.active.owned ?? true, workspaceId: "de29f26b-e593-4ec2-99fc-583d4711f20a",
      draft: payload.active.draft ?? payload.draft } }) }
})

test("local owner setup names sign-in before and after authentication", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const host = document.createElement("div")
  const root = createRoot(host)
  const calls: string[] = []
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, localAuth: {}, commands: { all: () => commands }, runCommand: (name: string) => { calls.push(name) } } as unknown as AppController}><SetupChecklist /></ControllerContext>))
  try {
    render()
    await new Promise(resolve => setTimeout(resolve, 20))
    const button = host.querySelector<HTMLButtonElement>('[data-flow="auth.sign-in"]')!
    expect(button.textContent).toBe("Sign in")
    button.click()
    expect(calls).toEqual(["auth.sign-in"])
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", admin: false, scopesPlain: null }).isPersisted.promise
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector("li")?.textContent).toBe("✓Sign in")
    expect(host.querySelector("li")?.getAttribute("data-complete")).toBe("true")
    expect(host.textContent).not.toContain("Connect GitHub")
  } finally { flushSync(() => root.unmount()); await store.dispose?.() }
})

test("only a current account's selected repository registration completes setup", () => {
  const setup = initialSetup("will/demo", "issues", "will")

  const active = { revision: setup.revision, digest: setupCandidate(setup), registrationId: "reg", sourceRevision: "source", enabled: true }
  expect(hasRegisteredSetup([observation(setup)], "will/demo", "will")).toBe(false)
  expect(hasRegisteredSetup([observation({ ...setup, request: { id: "failed", operation: "apply", revision: setup.revision, digest: active.digest, state: "failed" } })], "will/demo", "will")).toBe(false)
  expect(hasRegisteredSetup([observation({ ...setup, active })], "will/demo", "will")).toBe(true)
  expect(hasRegisteredSetup([observation({ ...setup, active })], "other/repo", "will")).toBe(false)
  expect(hasRegisteredSetup([observation({ ...setup, active })], "will/demo", "other")).toBe(false)
  expect(hasRegisteredSetup([observation({ ...setup, active })], "will/demo", null)).toBe(false)
  expect(hasRegisteredSetup([observation({ ...setup, active: { ...active, enabled: false } })], "will/demo", "will")).toBe(true)
  expect(hasRegisteredSetup([observation({ ...setup, active: { ...active, digest: "wrong" } })], "will/demo", "will")).toBe(false)
  expect(hasRegisteredSetup([observation({ ...setup, active: { ...active, revision: setup.revision + 1 } })], "will/demo", "will")).toBe(false)
  expect(hasRegisteredSetup([observation({ ...setup, active: { ...active, owned: false } })], "will/demo", "will")).toBe(false)
  expect(hasRegisteredSetup([observation({ ...setup, active, revision: setup.revision + 1, draft: { ...setup.draft, label: "Changed draft" } })], "will/demo", "will")).toBe(false)
  expect(hasRegisteredSetup([observation({ ...setup, active: { ...active, draft: setup.draft }, revision: setup.revision + 1, draft: { ...setup.draft, label: "Changed draft" } })], "will/demo", "will")).toBe(true)
})

test("each step names the first flow this host registered, and completion follows state", () => {
  const steps = resolveSteps(commands, empty)
  expect(steps.map(step => [step.id, step.flow, step.complete])).toEqual([
    ["connect-github", "auth.sign-in", false],
    ["add-repository", "repos.import", false],
    ["set-up-job", "issues.setup", false],
  ])
  expect(resolveSteps(commands, done).every(step => step.complete)).toBe(true)
  expect(resolveSteps(commands.filter(command => command.name !== "repos.import"), empty)[1]?.flow).toBeUndefined()
  expect(resolveSteps(commands.filter(command => command.name !== "auth.sign-in"), empty)[0]?.flow).toBeUndefined()
})

test("the step count matches the list the pattern promises", () => {
  expect(SETUP_STEPS.map(step => step.id)).toEqual(["connect-github", "add-repository", "set-up-job"])
})

test("incomplete steps are flow buttons; completed steps are not interactive", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  const calls: Array<[string, string | undefined]> = []
  try {
    const steps = resolveSteps(commands, { ...empty, signedIn: true }, "requested/repo")
    flushSync(() => root.render(<SetupChecklistCard steps={steps} onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    expect(host.querySelector("header")?.textContent).toContain("1 of 3")
    expect(host.querySelector("progress")?.getAttribute("value")).toBe("1")
    const items = [...host.querySelectorAll<HTMLLIElement>("li")]
    expect(items[0]?.dataset.complete).toBe("true")
    expect(items[0]?.querySelector("button")).toBeNull()
    const buttons = items.flatMap(item => [...item.querySelectorAll<HTMLButtonElement>("button")])
    expect(buttons.map(button => [button.dataset.flow, button.textContent])).toEqual([
      ["repos.import", "Add a repository"],
      ["issues.setup", "Set up a job"],
    ])
    expect(buttons.every(button => button.type === "button" && !button.disabled && button.tabIndex === 0)).toBe(true)
    buttons[1]!.click()
    expect(calls).toEqual([["issues.setup", "requested/repo"]])
  } finally { flushSync(() => root.unmount()) }
})

test("setup needs a registration and keeps the five jobs reachable after pausing and reload", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  let store = await createAppStore({ kind: "localStorage", storage })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null })
  const calls: unknown[][] = []
  const host = document.createElement("div")
  document.body.append(host)
  let root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, commands: { all: () => jobCommands }, runCommand: (...args: unknown[]) => { calls.push(args) } } as unknown as AppController}><SetupChecklist /></ControllerContext>))
  try {
    render()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelectorAll("li button").length).toBe(3)
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-flow="auth.sign-in"]')!.click())
    expect(calls).toEqual([["auth.sign-in", undefined]])
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector('[data-flow="auth.sign-in"]')).toBeNull()
    expect(host.querySelector("header")?.textContent).toContain("1 of 3")
    store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/demo", org: "will", ownerKind: "user", name: "demo", head: null }] })
    store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "pending" } })
    store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "ready" } })
    store.dispatch({ type: "card.upsert", actor: "system", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload: initialSetup("will/demo", "issues", "will") } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector("header")?.textContent).toContain("2 of 3")
    const setup = initialSetup("will/demo", "issues", "will")
    store.dispatch({ type: "card.upsert", actor: "system", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload: { ...setup, active: { revision: setup.revision, digest: setupCandidate(setup), registrationId: "reg", sourceRevision: "source", enabled: true } } } })
    store.dispatch({ type: "repository-job.observed", actor: "system", observation: observation({ ...setup, active: { revision: setup.revision, digest: setupCandidate(setup), registrationId: "reg", sourceRevision: "source", enabled: true } }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector('[data-testid="setup-checklist"]')).toBeNull()
    store.dispatch({ type: "first-run.dismissed", actor: "user" })
    store.dispatch({ type: "card.upsert", actor: "system", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload: { ...setup, active: { revision: setup.revision, digest: setupCandidate(setup), registrationId: "reg", sourceRevision: "source", enabled: false } } } })
    store.dispatch({ type: "repository-job.observed", actor: "system", observation: observation({ ...setup, active: { revision: setup.revision, digest: setupCandidate(setup), registrationId: "reg", sourceRevision: "source", enabled: false } }) })
    await store.settled?.()
    await new Promise(resolve => setTimeout(resolve, 20))
    const jobs = () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Repository jobs"] > button')]
    expect(host.querySelector('[data-testid="setup-checklist"]')).toBeNull()
    expect(jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(jobs()[0]?.textContent).toBe("Handle issues · Paused")
    flushSync(() => root.unmount())
    await store.dispose?.()
    store = await createAppStore({ kind: "localStorage", storage })
    // Observations are disposable: a fresh host answer, not cached cards, restores labels.
    store.dispatch({ type: "repository-job.observed", actor: "system", observation: observation({ ...setup, active: { revision: setup.revision, digest: setupCandidate(setup), registrationId: "reg", sourceRevision: "source", enabled: false } }) })
    root = createRoot(host)
    render()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector('[data-testid="setup-checklist"]')).toBeNull()
    expect(jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(jobs()[0]?.textContent).toBe("Handle issues · Paused")
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", admin: false, scopesPlain: null })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector("header")?.textContent).toContain("1 of 3")
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    await store.dispose?.()
  }
})

/*
 * Canary walk run 3, step B3-1: on a profile whose recommended-actions card is
 * dismissed (`firstRunDismissed`) and whose first job exists, a fresh
 * conversation offered only "Set up a job" and none of the five jobs — the
 * other four were reachable only through slash doors.
 */
const dismissedHome = async (calls: Array<[string, string | undefined]>, options: { readonly repositories?: boolean; readonly dismissed?: boolean } = {}) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) },
  } })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
  if (options.repositories !== false) store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/demo", org: "will", ownerKind: "user", name: "demo", head: null }] })
  store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "pending" } })
  store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "ready" } })
  const card = (job: "issues" | "review", enabled?: boolean) => {
    const payload = initialSetup("will/demo", job, "will")
    return { id: `setup:will:will%2Fdemo:${job}`, kind: "repository-setup" as const, title: job, status: "active" as const, createdAt: 1, ordinal: 1,
      payload: { ...payload, active: { revision: payload.revision, digest: setupCandidate(payload), registrationId: "reg", sourceRevision: "f4d4814e", enabled: enabled ?? true } } }
  }
  store.dispatch({ type: "card.upsert", actor: "system", card: card("issues") })
  store.dispatch({ type: "card.upsert", actor: "system", card: card("review", false) })
  for (const item of [card("issues"), card("review", false)]) store.dispatch({ type: "repository-job.observed", actor: "system", observation: observation(item.payload) })
  if (options.dismissed !== false) store.dispatch({ type: "first-run.dismissed", actor: "user" })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, commands: { all: () => jobCommands }, runCommand: (name: string, args?: string) => { calls.push([name, args]) } } as unknown as AppController}><SetupChecklist /></ControllerContext>))
  render()
  await new Promise(resolve => setTimeout(resolve, 20))
  return { store, host, render, jobs: () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Repository jobs"] > button')],
    settle: async () => { await store.settled?.(); await new Promise(resolve => setTimeout(resolve, 20)); render() },
    dispose: async () => { flushSync(() => root.unmount()); host.remove(); await store.dispose?.() } }
}

test("the five jobs are buttons on the home surface once the first job exists, with the recommended actions dismissed", async () => {
  const calls: Array<[string, string | undefined]> = []
  const home = await dismissedHome(calls)
  try {
    expect(home.host.querySelector('[data-testid="setup-checklist"]')).toBeNull()
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(home.jobs().map(button => button.textContent)).toEqual(["Handle issues · Enabled", "Review PRs · Paused", "Set up CI", "Build a feature", "Automate a chore"])
    home.jobs()[1]!.click()
    await home.settle()
    expect(calls).toEqual([["review.setup", "will/demo"]])
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
  } finally { await home.dispose() }
})

test("the third step is the job row once a job exists, and the checklist still names its remaining steps", async () => {
  const home = await dismissedHome([], { repositories: false })
  try {
    expect(home.host.querySelector("header")?.textContent).toContain("2 of 3")
    expect(home.host.querySelector('[data-flow="repos.import"]')).not.toBeNull()
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
  } finally { await home.dispose() }
})

test("the recommended actions still own the row until they are dismissed", async () => {
  const home = await dismissedHome([], { dismissed: false })
  try {
    expect(home.jobs()).toEqual([])
    expect(home.host.querySelector('[data-testid="setup-checklist"]')).toBeNull()
  } finally { await home.dispose() }
})
