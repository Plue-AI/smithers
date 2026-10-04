import { selectFirstRunRepository } from "./FirstRunRepository"
import { expect,test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { json, memoryStorage, silentAgent } from "./TestFixtures"
import { resolveTargetRepo } from "./RepoContext"

/* Every controller this file builds is disposed even when an assertion fails. */
const createAppController = scopedControllers()

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

test("a bare repository command during first-run selection parks instead of asking for a repo", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async () => json(404, {})
  })
  const forms = () => [...store.collections.cards.values()].filter(card => card.kind === "flow-form")
  try {
    expect(await controller.commands.run("issues.list")).toEqual({ status: "executed", value: "Requested" })
    expect(forms()).toEqual([])
    expect(store.session().pendingCommand).toMatchObject({ name: "issues.list", requirement: "first-run-target" })

    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    selectFirstRunRepository(store, controller.settleFirstRunTarget)
    await until(() => store.session().pendingCommand?.requirement === "repo-source")
    expect(forms()).toEqual([])
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue-list")).toHaveLength(0)
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "sign-in")).toHaveLength(1)
  } finally { await controller.dispose() }
})

test("signed-out entry leaves repository selection empty", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: (() => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } } })() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
  selectFirstRunRepository(store)
  expect(store.session().activeRepoKey ?? null).toBeNull()
  expect(resolveTargetRepo(store, undefined)).toEqual({ error: expect.stringContaining("No repository is loaded") })
  await store.dispose?.()
})

test("signed-in entry keeps the existing selection", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: (() => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } } })() })
  const before = store.session().activeRepoKey
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  selectFirstRunRepository(store)
  expect(store.session().activeRepoKey).toBe(before)
  await store.dispose?.()
})

test("a legacy v3 guide session loads with unknown lesson fields stripped", async () => {
  const { SessionSchema, initialSession } = await import("./AppState")
  const legacy = { ...initialSession("dark"), guide: { version: 3, step: 7, completed: ["tutorial.started"], conversationOpen: false }, guideVisible: true }
  const session = SessionSchema.parse(legacy)
  expect(session.theme).toBe("dark")
  expect("guide" in session).toBe(false)
  expect("guideVisible" in session).toBe(false)
  expect(session.firstRunDismissed).toBeUndefined()
})

test("the persisted legacy session loads without replaying lessons", async () => {
  const { memoryStorage, writeLegacyCollection } = await import("./TestFixtures")
  const { initialSession } = await import("./AppState")
  const storage = memoryStorage()
  const legacy = { ...initialSession("dark"), guide: { version: 3, step: 7, finished: false } }
  writeLegacyCollection(storage, "app-sessions", [legacy])
  const store = await createAppStore({ kind: "localStorage", storage })
  expect(store.session().theme).toBe("dark")
  expect("guide" in store.session()).toBe(false)
  expect(store.collections.cards.size).toBe(0)
  await store.dispose?.()
})

/*
 * The park slot is one persisted, latest-wins field. Settling the first-run
 * target may only resume the park that waits on THAT choice; a sign-in or
 * repo-read park left by an earlier visit keeps waiting for its own seam.
 */
for (const [branch, identity] of [["non-blocking boot", undefined], ["settled identity", "signed-out"]] as const) {
  for (const requirement of ["signed-in", "repo-read"] as const) {
    test(`a stale ${requirement} park survives the first-run settle on the ${branch} branch`, async () => {
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const controller = createAppController(store, silentAgent, { fetchImpl: async () => json(404, {}) })
      try {
        if (identity !== undefined) {
          await store.dispatch({ type: "identity.session.loaded", actor: "system", state: identity, login: null, admin: false, scopesPlain: null }).isPersisted.promise
        }
        await store.dispatch({ type: "command.deferred", actor: "user", name: "issues.view", args: "3 acme/private", requirement }).isPersisted.promise
        selectFirstRunRepository(store, controller.settleFirstRunTarget)
        await new Promise(resolve => setTimeout(resolve, 30))
        expect(store.session().pendingCommand).toMatchObject({ name: "issues.view", args: "3 acme/private", requirement })
        expect([...store.collections.toasts.values()]).toEqual([])
        expect([...store.collections.cards.values()]).toEqual([])
      } finally { await controller.dispose() }
    })
  }
}

test("a first-run-target park resumes exactly once when the selection settles", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { fetchImpl: async () => json(404, {}) })
  try {
    expect(await controller.commands.run("issues.list")).toEqual({ status: "executed", value: "Requested" })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    selectFirstRunRepository(store, controller.settleFirstRunTarget)
    selectFirstRunRepository(store, controller.settleFirstRunTarget)
    await until(() => store.session().pendingCommand?.requirement === "repo-source")
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue-list")).toHaveLength(0)
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "sign-in")).toHaveLength(1)
  } finally { await controller.dispose() }
})

test("a first-run-target park whose choice settles with no target renders the repo form once", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { fetchImpl: async () => json(404, {}) })
  try {
    expect(await controller.commands.run("issues.list")).toEqual({ status: "executed", value: "Requested" })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
    selectFirstRunRepository(store, controller.settleFirstRunTarget)
    await until(() => store.collections.cards.get("form-issues.list") !== undefined)
    expect([...store.collections.cards.values()].filter(card => card.kind === "flow-form")).toHaveLength(1)
    expect(store.session().activeRepoKey ?? null).toBeNull()
    expect(store.session().pendingCommand ?? null).toBeNull()
  } finally { await controller.dispose() }
})

/*
 * The real first-run order: the identity row persists inside dispatchSignedOut,
 * and the first-run target settles after it. A command typed in that gap
 * must still wait for the target, not be told to name one.
 */
test("a command issued after signed-out but before the selection settles parks and resumes once", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { fetchImpl: async () => json(404, {}) })
  const forms = () => [...store.collections.cards.values()].filter(card => card.kind === "flow-form")
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    expect(store.session().activeRepoKey ?? null).toBeNull()
    expect(await controller.commands.run("issues.list")).toEqual({ status: "executed", value: "Requested" })
    expect(forms()).toEqual([])
    expect(store.session().pendingCommand).toMatchObject({ name: "issues.list", requirement: "first-run-target" })

    selectFirstRunRepository(store, controller.settleFirstRunTarget)
    await until(() => store.session().pendingCommand?.requirement === "repo-source")
    expect(forms()).toEqual([])
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue-list")).toHaveLength(0)
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "sign-in")).toHaveLength(1)
  } finally { await controller.dispose() }
})

test("a signed-in entry with no persisted target keeps today's behaviour: it asks for a repository at once", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { fetchImpl: async () => json(404, {}) })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
    await controller.commands.run("issues.list")
    await until(() => store.collections.cards.get("form-issues.list") !== undefined)
    expect(store.session().pendingCommand ?? null).toBeNull()
  } finally { await controller.dispose() }
})

/*
 * Canary W1 item 3d, receipts `W1-i-signed-out.json` (`cardIds`) and
 * `W1-50-signed-out-issues-list.png`: an anonymous visitor on
 * /codeplanesmithers/canary-sandbox ran `/issues.list` and got the sign-in
 * prompt AND a `List a repository's issues` form card — Filter, Repo, Cancel,
 * Submit — asking them to name a repository they cannot read. The run-3
 * FAILED card was already gone; the form was what was left. Every other
 * other list door — `files.list` — already declares `repo-source`, which is
 * the app's one rule for an anonymous context: a signed-out visitor with no
 * open repository, no public catalog repository  parks
 * on it and gets the sign-in step in the form's place, while a public catalog
 * repository still reads without an account.
 */
test("a signed-out visitor's issues door offers sign-in and nothing to fill in", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { fetchImpl: async () => json(404, {}) })
  const forms = () => [...store.collections.cards.values()].filter(card => card.kind === "flow-form")
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "system", id: "codeplanesmithers/canary-sandbox" }).isPersisted.promise
    controller.settleFirstRunTarget()
    await controller.commands.run("issues.list")
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(forms()).toEqual([])
    expect([...store.collections.messages.values()].some(message => message.action?.flow === "sign-in")).toBe(true)
    expect(store.session().pendingCommand).toMatchObject({ name: "issues.list", requirement: "repo-source" })
  } finally { await controller.dispose() }
})
