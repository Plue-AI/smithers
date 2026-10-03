import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import type { RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import type { RepositoryJobObservation } from "../state/AppState"
import { ControllerContext } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { RepositoryFlow } from "../state/AppState"
import { memoryStorage } from "../state/TestFixtures"
import { FIRST_RUN_JOBS, firstRunGroups, resolveSteps, SETUP_STEPS, SetupChecklist, SetupChecklistCard, hasRegisteredSetup } from "./SetupChecklist"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

const commands = [
  { name: "chat.open", summary: "Open Chat using the selected input mode (C)" },
  { name: "auth.sign-in", summary: "Sign in with GitHub" },
  { name: "repos.import", summary: "Import a GitHub repository into Smithers Cloud" },
  { name: "issues.setup", summary: "Handle issues" },
  { name: "debug.snapshot", summary: "Snapshot", hidden: true },
]
const jobTitles = ["Handle issues", "Review PRs", "Set up CI", "Build a feature", "Automate a chore"]
const jobCommands = [...commands, ...FIRST_RUN_JOBS.map((name, index) => ({ name, summary: jobTitles[index]! }))]
const empty = { signedIn: false, hasRepo: false, hasSetup: false, talked: false }
const done = { signedIn: true, hasRepo: true, hasSetup: true, talked: true }
/** The talk step's button text: its label, then the aria-hidden ⌘K chip. */
const TALK = "Talk to Smithers ⌘ K"

const observation = (payload: RepositorySetup): RepositoryJobObservation => ({
  id: payload.job, owner: payload.owner ?? "", repo: payload.repo, job: payload.job,
  selectedWorkspaceId: null, state: "completed", registration: { state: "known",
    ...(payload.active === undefined ? {} : { active: { ...payload.active,
      owned: payload.active.owned ?? true, workspaceId: "de29f26b-e593-4ec2-99fc-583d4711f20a",
      draft: payload.active.draft ?? payload.draft } }) }
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
    ["talk", "chat.open", false],
    ["connect-github", "auth.sign-in", false],
    ["add-repository", "repos.import", false],
    ["set-up-job", "issues.setup", false],
  ])
  expect(resolveSteps(commands, done).every(step => step.complete)).toBe(true)
  // Each step reads only its own fact.
  for (const [fact, id] of [["talked", "talk"], ["signedIn", "connect-github"], ["hasRepo", "add-repository"], ["hasSetup", "set-up-job"]] as const)
    expect(resolveSteps(commands, { ...empty, [fact]: true }).filter(step => step.complete).map(step => step.id)).toEqual([id])
  const without = (name: string, id: string) => resolveSteps(commands.filter(command => command.name !== name), empty).find(step => step.id === id)
  expect(without("chat.open", "talk")?.flow).toBeUndefined()
  expect(without("auth.sign-in", "connect-github")?.flow).toBeUndefined()
  expect(without("repos.import", "add-repository")?.flow).toBeUndefined()
})

test("on the cloud web app the GitHub step belongs to the signup: three steps remain", () => {
  expect(resolveSteps(commands, { ...empty, cloud: true }).map(step => [step.id, step.flow, step.complete])).toEqual([
    ["talk", "chat.open", false],
    ["add-repository", "repos.import", false],
    ["set-up-job", "issues.setup", false],
  ])
  expect(resolveSteps(commands, { ...done, cloud: true }).map(step => step.complete)).toEqual([true, true, true])
  // Every other host keeps the step.
  expect(resolveSteps(commands, { ...empty, cloud: false }).map(step => step.id)).toEqual(["talk", "connect-github", "add-repository", "set-up-job"])
})

for (const [host, count, talked] of [
  ["cloud", "1 of 3", "2 of 3"], ["local", "2 of 4", "3 of 4"],
] as const) test(`the live card on a ${host} host counts ${count}, then ${talked} once the person writes`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const host_ = document.createElement("div")
  const root = createRoot(host_)
  const bootstrap = { apiVersion: 1, host, version: "test", buildSha: "test", capabilities: [], authFlow: "redirect", sandbox: null }
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/demo", org: "will", ownerKind: "user", name: "demo", head: null }] }).isPersisted.promise
    flushSync(() => root.render(<ControllerContext value={{ store, bootstrap, dismissFirstRun: () => {}, commands: { all: () => jobCommands }, runCommand: () => {} } as unknown as AppController}><SetupChecklist /></ControllerContext>))
    await new Promise(resolve => setTimeout(resolve, 20))
    const cloud = host === "cloud"
    expect(host_.querySelector(".setup-checklist-count")?.textContent).toBe(count)
    expect(host_.querySelector("progress")?.getAttribute("max")).toBe(cloud ? "3" : "4")
    expect([...host_.querySelectorAll("ol > li")].map(item => item.firstChild?.textContent)).toEqual(cloud ? [TALK, "✓", "Set up a job"] : [TALK, "✓", "✓", "Set up a job"])
    expect(host_.textContent?.includes("Connect GitHub")).toBe(!cloud)
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "first-turn", text: "What can you do?" }).isPersisted.promise
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host_.querySelector(".setup-checklist-count")?.textContent).toBe(talked)
    expect(host_.querySelector("ol > li")?.textContent).toBe("✓Talk to Smithers")
  } finally {
    flushSync(() => root.unmount())
    await store.dispose?.()
  }
})

test("the step count matches the list the pattern promises", () => {
  expect(SETUP_STEPS.map(step => step.id)).toEqual(["talk", "connect-github", "add-repository", "set-up-job"])
})

/* Will, 2026-10-01: the checklist asks the person to open Chat with ⌘K and talk to Smithers. */
test("Talk to Smithers comes first, opens Chat through chat.open, and alone carries the ⌘K chip", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  const calls: Array<[string, string | undefined]> = []
  try {
    for (const cloud of [false, true]) {
      flushSync(() => root.render(<SetupChecklistCard steps={resolveSteps(commands, { ...empty, cloud }, "will/demo")} onRunCommand={(name, args) => { calls.push([name, args]) }} />))
      const first = host.querySelector<HTMLLIElement>("ol > li")!
      expect(first.hasAttribute("data-complete")).toBe(false)
      const talk = first.querySelector<HTMLButtonElement>("button")!
      expect([talk.dataset.flow, talk.dataset.flowArgs, talk.type, talk.disabled]).toEqual(["chat.open", undefined, "button", false])
      const chip = talk.querySelector("kbd")!
      expect([chip.textContent, chip.getAttribute("aria-hidden")]).toEqual(["⌘ K", "true"])
      // The chip is decoration: the button's name is the step's label.
      expect(talk.textContent?.replace(chip.textContent!, "").trim()).toBe("Talk to Smithers")
      expect(host.querySelectorAll("kbd")).toHaveLength(1)
      talk.click()
    }
    expect(calls).toEqual([["chat.open", undefined], ["chat.open", undefined]])
  } finally { flushSync(() => root.unmount()) }
})

test("a user message checks off Talk to Smithers; a Smithers message does not", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const host = document.createElement("div")
  const root = createRoot(host)
  const talk = () => host.querySelector<HTMLLIElement>("ol > li")!
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
    flushSync(() => root.render(<ControllerContext value={{ store, dismissFirstRun: () => {}, commands: { all: () => jobCommands }, runCommand: () => {} } as unknown as AppController}><SetupChecklist /></ControllerContext>))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(talk().hasAttribute("data-complete")).toBe(false)
    expect(talk().querySelector('button[data-flow="chat.open"]')).not.toBeNull()
    expect(host.querySelector(".setup-checklist-count")?.textContent).toBe("1 of 4")
    await store.dispatch({ type: "message.appended", actor: "system", text: "Repository initialization failed." }).isPersisted.promise
    await new Promise(resolve => setTimeout(resolve, 20))
    expect([...store.collections.messages.values()].map(message => message.role)).toEqual(["smithers"])
    expect(talk().hasAttribute("data-complete")).toBe(false)
    expect(host.querySelector(".setup-checklist-count")?.textContent).toBe("1 of 4")
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "first-turn", text: "What can you do?" }).isPersisted.promise
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(talk().dataset.complete).toBe("true")
    expect(talk().textContent).toBe("✓Talk to Smithers")
    expect(talk().querySelector("button, kbd")).toBeNull()
    expect(host.querySelector('[data-flow="chat.open"]')).toBeNull()
    expect(host.querySelector(".setup-checklist-count")?.textContent).toBe("2 of 4")
  } finally {
    flushSync(() => root.unmount())
    await store.dispose?.()
  }
})

test("incomplete steps are flow buttons; completed steps are not interactive", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  const calls: Array<[string, string | undefined]> = []
  try {
    const steps = resolveSteps(commands, { ...empty, signedIn: true }, "requested/repo")
    flushSync(() => root.render(<SetupChecklistCard steps={steps} onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    expect(host.querySelector("header")?.textContent).toContain("1 of 4")
    expect(host.querySelector("progress")?.getAttribute("value")).toBe("1")
    const items = [...host.querySelectorAll<HTMLLIElement>("li")]
    expect(items[1]?.dataset.complete).toBe("true")
    expect(items[1]?.querySelector("button")).toBeNull()
    const buttons = items.flatMap(item => [...item.querySelectorAll<HTMLButtonElement>("button")])
    expect(buttons.map(button => [button.dataset.flow, button.textContent])).toEqual([
      ["chat.open", TALK],
      ["repos.import", "Add a repository"],
      ["issues.setup", "Set up a job"],
    ])
    expect(buttons.every(button => button.type === "button" && !button.disabled && button.tabIndex === 0)).toBe(true)
    buttons[2]!.click()
    buttons[0]!.click()
    expect(calls).toEqual([["issues.setup", "requested/repo"], ["chat.open", undefined]])
  } finally { flushSync(() => root.unmount()) }
})

const tiles = (host: HTMLElement, group = "Repository jobs") => [...host.querySelectorAll<HTMLButtonElement>(`section[aria-label="${group}"] > button`)]
const stepButtons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("li > button")]

test("the last step is the job tiles; registration completes it, pausing and reload keep them, and dismissal collapses the card to them", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  let store = await createAppStore({ kind: "localStorage", storage })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null })
  const calls: unknown[][] = []
  const host = document.createElement("div")
  document.body.append(host)
  let root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, dismissFirstRun: () => store.dispatch({ type: "first-run.dismissed", actor: "user" }), commands: { all: () => jobCommands }, runCommand: (...args: unknown[]) => { calls.push(args) } } as unknown as AppController}><SetupChecklist /></ControllerContext>))
  try {
    render()
    await new Promise(resolve => setTimeout(resolve, 20))
    // Steps 1 to 3 are buttons; the last step is its label over the five tiles, never a single button.
    expect(stepButtons(host).map(button => button.dataset.flow)).toEqual(["chat.open", "auth.sign-in", "repos.import"])
    expect(host.querySelectorAll("li")[3]?.firstChild?.textContent).toBe("Set up a job")
    expect(tiles(host).map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-flow="auth.sign-in"]')!.click())
    expect(calls).toEqual([["auth.sign-in", undefined]])
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector('[data-flow="auth.sign-in"]')).toBeNull()
    expect(host.querySelector("header")?.textContent).toContain("1 of 4")
    store.dispatch({ type: "message.submitted", actor: "user", turnId: "first-turn", text: "What can you do?" })
    store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/demo", org: "will", ownerKind: "user", name: "demo", head: null }] })
    store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "pending" } })
    store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "ready" } })
    store.dispatch({ type: "card.upsert", actor: "system", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload: initialSetup("will/demo", "issues", "will") } })
    await new Promise(resolve => setTimeout(resolve, 20))
    // A draft card is not a registration.
    expect(host.querySelector("header")?.textContent).toContain("3 of 4")
    expect(tiles(host).map(button => button.dataset.done)).toEqual([undefined, undefined, undefined, undefined, undefined])
    const setup = initialSetup("will/demo", "issues", "will")
    const active = (enabled: boolean) => ({ revision: setup.revision, digest: setupCandidate(setup), registrationId: "reg", sourceRevision: "source", enabled })
    store.dispatch({ type: "card.upsert", actor: "system", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload: { ...setup, active: active(true) } } })
    store.dispatch({ type: "repository-job.observed", actor: "system", observation: observation({ ...setup, active: active(true) }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    // Every step complete: only the tiles remain.
    expect(host.querySelector('[data-testid="setup-checklist"]')?.hasAttribute("data-complete")).toBe(true)
    expect(host.querySelector("header")).toBeNull()
    expect(host.querySelector("progress")).toBeNull()
    expect(tiles(host).map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(tiles(host)[0]?.dataset.done).toBe("true")
    store.dispatch({ type: "card.upsert", actor: "system", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload: { ...setup, active: active(false) } } })
    store.dispatch({ type: "repository-job.observed", actor: "system", observation: observation({ ...setup, active: active(false) }) })
    await store.settled?.()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(tiles(host).map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(tiles(host)[0]?.textContent).toBe("Handle issues · Paused")
    flushSync(() => root.unmount())
    await store.dispose?.()
    store = await createAppStore({ kind: "localStorage", storage })
    // Observations are disposable: a fresh host answer, not cached cards, restores labels.
    store.dispatch({ type: "repository-job.observed", actor: "system", observation: observation({ ...setup, active: active(false) }) })
    root = createRoot(host)
    render()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector("header")).toBeNull()
    expect(tiles(host).map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(tiles(host)[0]?.textContent).toBe("Handle issues · Paused")
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", admin: false, scopesPlain: null })
    await new Promise(resolve => setTimeout(resolve, 20))
    // Another account has not written to Smithers or registered a job: only its sign-in is done.
    expect(host.querySelector("header")?.textContent).toContain("1 of 4")
    expect(stepButtons(host)[0]?.dataset.flow).toBe("chat.open")
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-flow="app.first-run.dismiss"]')!.click())
    await store.settled?.()
    await new Promise(resolve => setTimeout(resolve, 20))
    render()
    // Dismissed: no header, no steps; every job is still one press away.
    expect(host.querySelector("header")).toBeNull()
    expect(host.querySelector("ol")).toBeNull()
    expect(tiles(host).map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(calls).toEqual([["auth.sign-in", undefined]])
    // The dismissal survives a reload.
    flushSync(() => root.unmount())
    await store.dispose?.()
    store = await createAppStore({ kind: "localStorage", storage })
    root = createRoot(host)
    render()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector("header")).toBeNull()
    expect(tiles(host).map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    await store.dispose?.()
  }
})

/*
 * Canary walk run 3, step B3-1: on a profile whose first job exists, a fresh
 * conversation offered only "Set up a job" and none of the five jobs — the
 * other four were reachable only through slash doors.
 */
const registeredHome = async (calls: Array<[string, string | undefined]>, options: { readonly repositories?: boolean; readonly dismissed?: boolean; readonly talked?: boolean } = {}) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) },
  } })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
  if (options.repositories !== false) store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/demo", org: "will", ownerKind: "user", name: "demo", head: null }] })
  if (options.talked !== false) store.dispatch({ type: "message.submitted", actor: "user", turnId: "first-turn", text: "What can you do?" })
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
  if (options.dismissed === true) store.dispatch({ type: "first-run.dismissed", actor: "user" })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, dismissFirstRun: () => store.dispatch({ type: "first-run.dismissed", actor: "user" }), commands: { all: () => jobCommands }, runCommand: (name: string, args?: string) => { calls.push([name, args]) } } as unknown as AppController}><SetupChecklist /></ControllerContext>))
  render()
  await new Promise(resolve => setTimeout(resolve, 20))
  return { store, host, render, jobs: () => tiles(host),
    settle: async () => { await store.settled?.(); await new Promise(resolve => setTimeout(resolve, 20)); render() },
    dispose: async () => { flushSync(() => root.unmount()); host.remove(); await store.dispose?.() } }
}

test("with every step complete the five jobs are the only thing shown, each reading its card's state", async () => {
  const calls: Array<[string, string | undefined]> = []
  const home = await registeredHome(calls)
  try {
    expect(home.host.querySelector("header")).toBeNull()
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(home.jobs().map(button => button.textContent)).toEqual(["Handle issues · Enabled", "Review PRs · Paused", "Set up CI", "Build a feature", "Automate a chore"])
    expect(home.jobs().map(button => button.dataset.done)).toEqual(["true", "true", undefined, undefined, undefined])
    home.jobs()[1]!.click()
    await home.settle()
    expect(calls).toEqual([["review.setup", "will/demo"]])
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
  } finally { await home.dispose() }
})

test("the job step checks off and keeps its tiles while the checklist names its remaining steps", async () => {
  const home = await registeredHome([], { repositories: false })
  try {
    expect(home.host.querySelector("header")?.textContent).toContain("3 of 4")
    expect(home.host.querySelector("progress")?.getAttribute("value")).toBe("3")
    expect(home.host.querySelector('[data-flow="repos.import"]')).not.toBeNull()
    const job = home.host.querySelectorAll("li")[3]!
    expect(job.dataset.complete).toBe("true")
    expect(job.firstChild?.textContent).toBe("✓")
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(home.jobs().every(button => job.contains(button))).toBe(true)
  } finally { await home.dispose() }
})

test("the dismissal closes the steps but keeps every job one press away", async () => {
  const home = await registeredHome([], { dismissed: true, repositories: false })
  try {
    expect(home.host.querySelector("header")).toBeNull()
    expect(home.host.querySelector("ol")).toBeNull()
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
  } finally { await home.dispose() }
})

/* The tiles: which flows the job step offers, and how each one behaves. */
const firstRunCommands = [...FIRST_RUN_JOBS.map((name, index) => ({ name, summary: jobTitles[index]! })),
  { name: "wiki", summary: "Wiki" }, { name: "auth.sign-in", summary: "Sign in" },
  { name: "issues.list", summary: "List issues" }, { name: "admin.health", summary: "Diagnostics" },
  { name: "chat.stop", summary: "Stop" }]
const commandState = { surface: "chat" as const, typing: false, signedOut: true, hasConnectors: false, admin: false }
const featured = (id: string, isFeatured = true): RepositoryFlow => ({
  id, description: `Run ${id}`, summary: `${id} summary`, featured: isFeatured, model: null, modelInvocable: true
})
const flowNames = (groups: ReturnType<typeof firstRunGroups>) => groups.flatMap(group => group.flows.map(flow => flow.name))
const openSteps = resolveSteps(firstRunCommands, { signedIn: true, hasRepo: true, hasSetup: false })

test("the tiles are the five repository jobs without diagnostic or empty-context actions", () => {
  expect(flowNames(firstRunGroups(firstRunCommands, commandState))).toEqual([...FIRST_RUN_JOBS])
  expect(flowNames(firstRunGroups(firstRunCommands, { ...commandState, admin: true, signedOut: false }))).toEqual([...FIRST_RUN_JOBS])
})

test("missing or unavailable jobs are not invented; registry requirements still apply", () => {
  const flows = [{ name: "ci.setup", summary: "Set up CI", requires: ["signed-in"] },
    { name: "issues.setup", summary: "Handle issues", hidden: true },
    { name: "feature.setup", summary: "Build a feature", requires: ["repo-source"] }]
  expect(firstRunGroups(flows, commandState)).toEqual([])
  expect(flowNames(firstRunGroups(flows, { ...commandState, signedOut: false, publicRepo: true }))).toEqual(["ci.setup", "feature.setup"])
})

test("without an available job tile the job step falls back to its own flow button", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    const flows = [{ name: "issues.setup", summary: "Handle issues", requires: ["signed-in"] }]
    flushSync(() => root.render(<SetupChecklistCard steps={resolveSteps(flows, empty)} groups={firstRunGroups(flows, commandState)} onRunCommand={() => {}} />))
    expect(tiles(host)).toEqual([])
    expect(stepButtons(host).map(button => [button.dataset.flow, button.textContent])).toEqual([["issues.setup", "Set up a job"]])
  } finally { flushSync(() => root.unmount()) }
})

test("the tiles offer only executable repository-declared featured flows", () => {
  const rows = [featured("lint"), featured("review"), featured("create-flow/clarify"), featured("release-notes", false), featured("flow.list")]
  const catalog = [
    ...firstRunCommands,
    { name: "lint", summary: "Lint this repository", workflow: "lint", requires: ["signed-in"] },
    { name: "review", summary: "Review this repository", workflow: "review", requires: ["signed-in"] },
    { name: "create-flow.clarify", summary: "Clarify a flow", workflow: "create-flow/clarify", requires: ["signed-in"] },
    { name: "release-notes", summary: "Draft notes", workflow: "release-notes" },
    { name: "flow.list", summary: "List the flows on your workspace", requires: ["signed-in"] },
    { name: "hidden", summary: "Hidden", workflow: "hidden", hidden: true }
  ]
  expect(firstRunGroups(catalog, commandState, rows).map(group => group.namespace)).toEqual(["repository"])
  const groups = firstRunGroups(catalog, { ...commandState, signedOut: false }, rows)
  expect(groups.map(group => group.namespace)).toEqual(["repository", "featured"])
  expect(flowNames(groups)).toEqual([...FIRST_RUN_JOBS, "lint", "review", "create-flow.clarify"])
  expect(firstRunGroups(catalog, { ...commandState, signedOut: false }, []).map(group => group.namespace)).toEqual(["repository"])
  expect(flowNames(firstRunGroups(catalog.filter(item => item.name !== "review"), { ...commandState, signedOut: false }, rows))).not.toContain("review")
})

test("featured tiles follow the jobs, keep the selected repository and keyboard semantics, and carry no setup state", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  const calls: Array<[string, string | undefined]> = []
  const catalog = [...firstRunCommands, { name: "review", summary: "Review the change", workflow: "review", requires: ["signed-in"] }]
  try {
    flushSync(() => root.render(<SetupChecklistCard steps={openSteps} groups={firstRunGroups(catalog, { ...commandState, signedOut: false }, [featured("review")])}
      repo="will/demo" jobStates={{ review: "Paused" }} onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    expect([...host.querySelectorAll("section[aria-label]")].map(section => section.getAttribute("aria-label"))).toEqual(["Set up Smithers", "Repository jobs", "Featured flows"])
    const buttons = tiles(host, "Featured flows")
    expect(buttons.map(button => [button.dataset.flow, button.textContent])).toEqual([["review", "Review the change"]])
    expect(buttons[0]?.dataset.done).toBeUndefined()
    expect(buttons.every(button => button.type === "button" && button.tabIndex === 0 && !button.disabled)).toBe(true)
    for (const button of buttons) button.click()
    expect(calls).toEqual([["review", "will/demo"]])
  } finally { flushSync(() => root.unmount()) }
})

test("job tiles use short registry labels, a picture, and native keyboard semantics", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<SetupChecklistCard steps={openSteps} groups={firstRunGroups(firstRunCommands, commandState)} onRunCommand={() => {}} />))
    const buttons = tiles(host)
    expect(buttons.map(button => button.textContent)).toEqual(jobTitles)
    expect(buttons.every(button => button.querySelector("svg.setup-checklist-picture[aria-hidden=\"true\"]") !== null)).toBe(true)
    expect(buttons.every(button => button.type === "button" && !button.disabled && button.tabIndex === 0)).toBe(true)
    expect(host.textContent).not.toContain("issues.setup")
    expect(host.querySelector('[data-flow="admin.health"]')).toBeNull()
  } finally { flushSync(() => root.unmount()) }
})

test("first arrival binds every tile to the explicit repository before catalog inspection finishes", () => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<SetupChecklistCard steps={openSteps} groups={firstRunGroups(firstRunCommands, commandState)} repo="requested/repo"
      onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    for (const button of tiles(host)) button.click()
    expect(calls).toEqual(FIRST_RUN_JOBS.map(name => [name, "requested/repo"]))
  } finally { flushSync(() => root.unmount()) }
})

test("the live card names the steps and adds no sentence about choosing one", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<ControllerContext value={{ store, dismissFirstRun: () => {}, commands: { all: () => firstRunCommands }, runCommand: () => {} } as unknown as AppController}><SetupChecklist /></ControllerContext>))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.textContent).not.toContain("Choose an action to begin")
    expect(host.textContent).not.toContain("Learn how to")
    expect(host.querySelector('[data-testid="setup-checklist"]')?.getAttribute("aria-label")).toBe("Set up Smithers")
    expect(tiles(host).map(button => button.textContent)).toEqual(jobTitles)
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    await store.dispose?.()
  }
})

test("the live card follows the selected repository's featured projection", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const host = document.createElement("div")
  const root = createRoot(host)
  const catalog = [...firstRunCommands, { name: "review", summary: "Review the change", workflow: "review", requires: ["signed-in"] }]
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, commands: { all: () => catalog },
    runCommand: () => {}, dismissFirstRun: () => {} } as unknown as AppController}><SetupChecklist /></ControllerContext>))
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 20)); render() }
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "pending" } }).isPersisted.promise
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "ready" } }).isPersisted.promise
    render()
    expect(host.querySelector('[data-flow="review"]')).toBeNull()
    await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: "will/demo", flows: [featured("review")] }).isPersisted.promise
    await settle()
    expect(host.querySelector('[data-testid="setup-checklist"]')).not.toBeNull()
    expect(host.querySelector('[data-flow="review"]')).not.toBeNull()
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      { id: "will/demo", org: "will", ownerKind: "user", name: "demo", head: null },
      { id: "other/repo", org: "other", ownerKind: "user", name: "repo", head: null }
    ] }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: "other/repo" }).isPersisted.promise
    await settle()
    expect(host.querySelector('[data-flow="review"]')).toBeNull()
    await store.dispatch({ type: "repo.selected", actor: "user", id: "will/demo" }).isPersisted.promise
    await settle()
    expect(host.querySelector('[data-flow="review"]')).not.toBeNull()
    await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: "will/demo", flows: [] }).isPersisted.promise
    await settle()
    expect(host.querySelector('[data-flow="review"]')).toBeNull()
  } finally {
    flushSync(() => root.unmount())
    await store.dispose?.()
  }
})

test("the live catalog keeps unavailable runtime and admin plugin flows out of the tiles", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "Unavailable" }),
    cancelTurn: async () => {}, subscribe: () => () => {},
  }, { bootstrap: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["identity"], authFlow: "redirect", sandbox: null,
  } })
  try {
    const names = () => flowNames(firstRunGroups(controller.commands.all(), commandState))
    expect(names()).toEqual([...FIRST_RUN_JOBS])
    for (const name of ["repo.open", "files.list", "prs.list", "admin.health"]) expect(names()).not.toContain(name)
    expect(names().some(name => name.startsWith("system."))).toBe(false)
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "admin", admin: true, scopesPlain: null })
    expect(flowNames(firstRunGroups(controller.commands.all(), { ...commandState, signedOut: false, admin: true }))).not.toContain("admin.health")
  } finally {
    await controller.dispose()
    await store.dispose?.()
  }
})

/** A repository whose first inspection failed and whose second job is registered but paused. */
const inspectedHome = async (calls: Array<[string, string | undefined]>) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
  store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "pending" } })
  store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "ready" } })
  const card = (job: "issues" | "review", enabled?: boolean) => {
    const payload = initialSetup("will/demo", job, "will")
    return { id: `setup:will:will%2Fdemo:${job}`, kind: "repository-setup" as const, title: job, status: "active" as const, createdAt: 1, ordinal: 1,
      payload: enabled === undefined ? { ...payload, request: { id: "failed-inspection", operation: "inspect" as const, revision: payload.revision,
        digest: setupCandidate(payload), state: "failed" as const, error: "invalid_receipt" } }
        : { ...payload, active: { revision: payload.revision, digest: setupCandidate(payload), registrationId: "reg", sourceRevision: "f4d4814e", enabled } } }
  }
  store.dispatch({ type: "card.upsert", actor: "system", card: card("issues") })
  store.dispatch({ type: "card.upsert", actor: "system", card: card("review", false) })
  for (const job of ["issues", "review"] as const) {
    const payload = card(job, job === "review" ? false : undefined).payload
    store.dispatch({ type: "repository-job.observed", actor: "system", observation: {
      id: job, owner: "will", repo: "will/demo", job, selectedWorkspaceId: null, state: "completed",
      registration: { state: "known", ...(payload.active === undefined ? {} : { active: {
        ...payload.active, owned: true, workspaceId: "de29f26b-e593-4ec2-99fc-583d4711f20a", draft: payload.draft
      } }) }
    } })
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, dismissFirstRun: () => store.dispatch({ type: "first-run.dismissed", actor: "user" }), commands: { all: () => firstRunCommands }, runCommand: (name: string, args?: string) => { calls.push([name, args]) } } as unknown as AppController}><SetupChecklist /></ControllerContext>))
  render()
  await new Promise(resolve => setTimeout(resolve, 20))
  return { store, host, render, jobs: () => tiles(host),
    settle: async () => { await store.settled?.(); await new Promise(resolve => setTimeout(resolve, 20)); render() },
    dispose: async () => { flushSync(() => root.unmount()); host.remove(); await store.dispose?.() } }
}

test("every job stays one tile away after the first job exists, and after the dismissal", async () => {
  const calls: Array<[string, string | undefined]> = []
  const home = await inspectedHome(calls)
  try {
    home.jobs()[0]!.click()
    await home.settle()
    expect(calls).toEqual([["issues.setup", "will/demo"]])
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    home.jobs()[1]!.click()
    await home.settle()
    expect(calls[1]).toEqual(["review.setup", "will/demo"])
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    home.host.querySelector<HTMLButtonElement>('header > [aria-label="Dismiss"]')!.click()
    await home.settle()
    expect(home.host.querySelector("header")).toBeNull()
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    expect(calls.length).toBe(2)
  } finally { await home.dispose() }
})

test("failed inspection reads Off without claiming setup completion; a registered paused job checks off", async () => {
  const home = await inspectedHome([])
  try {
    expect(home.jobs().map(button => button.textContent)).toEqual(["Handle issues · Off", "Review PRs · Paused", "Set up CI", "Build a feature", "Automate a chore"])
    expect(home.jobs().map(button => button.dataset.done)).toEqual([undefined, "true", undefined, undefined, undefined])
  } finally { await home.dispose() }
})
