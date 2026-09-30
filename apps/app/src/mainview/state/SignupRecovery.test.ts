import { expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import { createAppStore, type AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { silentAgent } from "./TestFixtures"
import { readEntityRecoveries, writeEntityRecovery } from "./EntityRecovery"
import { flowArgs } from "../flows/FlowArgs"

const controllerFor = scopedControllers()
const storageFor = (values: Map<string, string>): StorageApi => ({
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value) },
  removeItem: key => { values.delete(key) }
})

for (const accepted of [false, true]) test(`signup edits survive a crash ${accepted ? "after" : "before"} command acceptance without submitting`, async () => {
  const values = new Map<string, string>(), recovery = new Map<string, string>()
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  const host = Object.assign(new EventTarget(), { localStorage: storageFor(recovery), location: new URL("https://example.invalid"), matchMedia: () => ({ matches: false }) })
  Object.defineProperty(globalThis, "window", { configurable: true, value: host })
  const held = Promise.withResolvers<void>()
  let store: AppStore | undefined, restored: AppStore | undefined
  const pending: Array<Promise<unknown>> = []
  try {
    store = await createAppStore({ kind: "localStorage", storage: storageFor(values) })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "old-owner", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
    const active = store
    const controller = controllerFor({ ...active, dispatch: transition => {
      const receipt = active.dispatch(transition)
      return transition.type !== "command.intent.accepted" ? receipt : new Proxy(receipt, { get: (target, property, receiver) => property === "isPersisted"
        ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise) } : Reflect.get(target, property, receiver) })
    } }, silentAgent, {})
    await active.settled?.()
    for (const [field, value] of [["name", "Private O"], ["account", "intentional-slug"], ["name", "Private Old Name"], ["more", "" ]]) {
      pending.push(controller.commands.run("signup.set", flowArgs("signup.set", { field: field!, value: value! })))
    }
    if (accepted) await active.settled?.()
    const frozen = new Map(values), frozenRecovery = new Map(recovery)
    // No command handler has run, and no acceptance receipt is needed to
    // recover the latest human input. Read the actual crash bytes.
    expect(active.session().signup?.draft).toEqual({ account: "old-owner" })
    expect(readEntityRecoveries(storageFor(frozenRecovery))).toMatchObject([{ value: { kind: "signup", signup: {
      draft: { name: "Private Old Name", account: "intentional-slug", more: "" }
    } } }])
    held.resolve()
    await Promise.all(pending)
    await controller.dispose()
    host.localStorage = storageFor(frozenRecovery)
    restored = await createAppStore({ kind: "localStorage", storage: storageFor(frozen) })
    expect(restored.session().signup).toMatchObject({ stage: "account", question: 0, answers: {}, account: "old-owner",
      draft: { name: "Private Old Name", account: "intentional-slug", more: "" } })
    expect(restored.session().signup?.name).toBeUndefined()
    expect(readEntityRecoveries(host.localStorage)).toEqual([])
    expect((await restored.verifyState()).valid).toBe(true)
  } finally {
    held.resolve(); await Promise.all(pending)
    await restored?.dispose?.(); await store?.dispose?.()
    if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
  }
})

const withRecovery = async (body: (store: AppStore, recovery: StorageApi, reopen: () => Promise<AppStore>) => Promise<void>) => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  const storage = storageFor(new Map()), recovery = storageFor(new Map()), stores: AppStore[] = []
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
  const open = async () => { const store = await createAppStore({ kind: "localStorage", storage }); stores.push(store); return store }
  try {
    const store = await open()
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "old-owner", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
    await body(store, recovery, async () => { await store.dispose?.(); return open() })
  } finally {
    for (const store of stores) await store.dispose?.()
    if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
  }
}

test("older signup edits and acknowledgements cannot replace the newest fields or explicit empty input", async () => {
  await withRecovery(async (store, recovery, reopen) => {
    const first = store.stagePendingSignupInput("name", "Private O", "first")!
    store.stagePendingSignupInput("account", "intentional-slug", "second")
    store.stagePendingSignupInput("name", "Private Old Name", "third")
    store.stagePendingSignupInput("more", "", "fourth")
    await store.dispatch({ type: "command.intent.accepted", actor: "user", id: "first", name: "signup.set", source: "command" }).isPersisted.promise
    await store.dispatch({ type: "signup.changed", actor: "user", patch: { draft: { name: "Private O", account: "old-owner" } } }).isPersisted.promise
    await store.dispatch({ type: "command.intent.settled", actor: "user", id: "first", outcome: "executed" }).isPersisted.promise
    first.clear()
    expect(readEntityRecoveries(recovery)).toMatchObject([{ preparedCommandId: "fourth", value: { signup: { draft: { name: "Private Old Name", account: "intentional-slug", more: "" } } } }])
    const restored = await reopen()
    expect(restored.session().signup?.draft).toEqual({ name: "Private Old Name", account: "intentional-slug", more: "" })
    expect((await restored.verifyState()).valid).toBe(true)
  })
})

for (const boundary of ["submitted", "account", "signed-out", "settled", "foreign-command", "foreign-stream", "foreign-prefix", "branch"] as const) test(`${boundary} prevents stale signup recovery`, async () => {
  await withRecovery(async (store, recovery, reopen) => {
    store.stagePendingSignupInput("name", "PRIVATE-PENDING-NAME", "edit")
    const pending = readEntityRecoveries(recovery)[0]!
    if (boundary === "submitted") await store.dispatch({ type: "signup.changed", actor: "user", patch: { stage: "poll", name: "Submitted Name", account: "submitted-slug" } }).isPersisted.promise
    if (boundary === "account") await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "new-owner", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
    if (boundary === "signed-out") await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    if (boundary === "settled" || boundary === "foreign-command") {
      await store.dispatch({ type: "command.intent.accepted", actor: "user", id: "edit", name: boundary === "settled" ? "signup.set" : "form.set", source: "command" }).isPersisted.promise
      if (boundary === "settled") await store.dispatch({ type: "command.intent.settled", actor: "user", id: "edit", outcome: "failed" }).isPersisted.promise
    }
    if (boundary === "branch") await store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "new-branch", notes: [] }).isPersisted.promise
    // Also reject an old slot copied back after an account retirement or
    // a completed submission erased it.
    writeEntityRecovery(recovery, { ...pending, authority: { ...pending.authority!,
      ...(boundary === "foreign-stream" ? { streamId: "foreign" } : {}),
      ...(boundary === "foreign-prefix" ? { baseEventHash: "0".repeat(64) } : {}) } })
    const restored = await reopen()
    expect(restored.session().signup?.draft.name).toBeUndefined()
    if (boundary === "submitted") expect(restored.session().signup).toMatchObject({ stage: "poll", name: "Submitted Name", account: "submitted-slug" })
    expect(readEntityRecoveries(recovery)).toEqual([])
    expect((await restored.verifyState()).valid).toBe(true)
  })
})

for (const refusal of ["write", "disposed", "account"] as const) test(`${refusal} clears signup preparation and never runs the old handler`, async () => {
  await withRecovery(async (store, recovery, reopen) => {
    const held = Promise.withResolvers<void>()
    const controller = controllerFor({ ...store, dispatch: transition => {
      const receipt = store.dispatch(transition)
      return transition.type !== "command.intent.accepted" ? receipt : new Proxy(receipt, { get: (target, property, receiver) => property === "isPersisted"
        ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise) } : Reflect.get(target, property, receiver) })
    } }, silentAgent, {})
    const pending = controller.commands.run("signup.set", flowArgs("signup.set", { field: "name", value: "PRIVATE-PENDING-NAME" }))
    try {
      expect(readEntityRecoveries(recovery)).toHaveLength(1)
      if (refusal === "disposed") await controller.dispose()
      if (refusal === "account") await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "new-owner", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
      if (refusal === "write") held.reject(new Error("fixture refused command receipt")); else held.resolve()
      expect((await pending).status).toBe("failed")
      expect(readEntityRecoveries(recovery)).toEqual([])
      const restored = await reopen()
      expect(restored.session().signup?.draft.name).toBeUndefined()
      expect((await restored.verifyState()).valid).toBe(true)
    } finally { held.resolve(); await pending; await controller.dispose() }
  })
})

for (const boundary of ["reload", "reload-account", "reload-write"] as const) test(`${boundary} during signup admission preserves only still-owned input for the next page`, async () => {
  await withRecovery(async (store, recovery, reopen) => {
    const held = Promise.withResolvers<void>(), pageLifetime = new AbortController()
    const controller = controllerFor({ ...store, dispatch: transition => {
      const receipt = store.dispatch(transition)
      return transition.type !== "command.intent.accepted" ? receipt : new Proxy(receipt, { get: (target, property, receiver) => property === "isPersisted"
        ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise) } : Reflect.get(target, property, receiver) })
    } }, silentAgent, { pageLifetime: pageLifetime.signal })
    const pending = controller.commands.run("signup.set", flowArgs("signup.set", { field: "name", value: "Retried Name" }))
    try {
      expect(readEntityRecoveries(recovery)).toHaveLength(1)
      pageLifetime.abort() // The browser's beforeunload fence, before pagehide.
      if (boundary === "reload-account") await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "new-owner", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
      if (boundary === "reload-write") held.reject(new Error("refused write during navigation")); else held.resolve()
      expect((await pending).status).toBe("failed")
      expect(store.session().signup?.draft.name).toBeUndefined()
      if (boundary === "reload") expect(readEntityRecoveries(recovery)).toMatchObject([{ value: { kind: "signup", signup: { draft: { name: "Retried Name" } } } }])
      else expect(readEntityRecoveries(recovery)).toEqual([])
      const restored = await reopen()
      expect(restored.session().signup?.draft.name).toBe(boundary === "reload" ? "Retried Name" : undefined)
      expect(restored.session().signup?.stage).toBe("account")
      expect((await restored.verifyState()).valid).toBe(true)
    } finally { held.resolve(); await pending; await controller.dispose() }
  })
})
