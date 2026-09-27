import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { silentAgent } from "./TestFixtures"
import { PERSISTENCE_BACKEND_STORAGE_KEY } from "../chain/SchemaVersion"
import { readPrivacyRetirement, type PrivacyStorage } from "../chain/PrivacyRetirement"

const createAppController = scopedControllers()
const fixture = async (fails = false) => {
  const bytes = new Map<string, string>()
  const storage: PrivacyStorage = {
    get length() { return bytes.size }, key: index => [...bytes.keys()][index] ?? null,
    getItem: key => bytes.get(key) ?? null, setItem: (key, value) => { bytes.set(key, value) },
    removeItem: key => { bytes.delete(key) }
  }
  storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "localStorage")
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const store = await createAppStore({ backend: { kind: "localStorage", storage }, mode: "localStorage", degraded: false,
    privacy: { record: storage, eraseInactiveDatabase: async () => {
      entered.resolve(); await release.promise
      if (fails) throw new Error("PRIVATE CLEANUP ERROR")
    } } })
  const identity = (login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
    login, provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await identity("old-owner")
  const controller = createAppController(store, silentAgent, { fetchImpl: async () => Response.json({ scopes: [] }) })
  await store.settled?.()
  const changing = identity("new-owner")
  void changing.catch(() => {})
  await entered.promise
  return { storage, store, controller, changing, release, identity, dispose: async () => {
    release.resolve(); await changing.catch(() => {}); await Promise.resolve(controller.dispose()).catch(() => {})
  } }
}

test("real pending privacy cleanup refuses commands and Chat edits visibly, then permits an explicit retry", async () => {
  const t = await fixture()
  try {
    expect(readPrivacyRetirement(t.storage)?.phase).toBe("pending")
    const outcome = await t.controller.commands.run("account.show")
    expect(outcome).toMatchObject({ status: "failed", error: "Account cleanup is running. Try again in a moment." })
    expect(() => t.controller.changeDraft("not accepted")).not.toThrow()
    expect(() => t.controller.openPalette()).not.toThrow()
    expect(() => t.controller.dismissHint("chat")).not.toThrow()
    expect(t.store.session().draft).toBe("")
    expect(t.store.collections.cards.get("account")).toBeUndefined()
    expect([...t.controller.privacyNotices.values()]).toHaveLength(1)
    expect([...t.controller.privacyNotices.values()][0]).toMatchObject({ status: "failed", title: "Not saved", actor: "user" })
    expect(await t.controller.commands.run("toast.dismiss", "toast-privacy-write")).toMatchObject({ status: "executed" })
    expect(t.controller.privacyNotices.size).toBe(0)
    t.release.resolve(); await t.changing
    expect(t.store.collections.cards.get("account")).toBeUndefined()
    expect((await t.controller.commands.run("account.show")).status).toBe("executed")
    t.controller.changeDraft("accepted draft")
    await t.store.settled?.()
    expect(t.store.session().draft).toBe("accepted draft")
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.dispose() }
})

test("refused actions never replay when the owner changes again or the app reloads", async () => {
  const t = await fixture()
  try {
    t.controller.runCommand("account.show")
    t.controller.changeDraft("private rejected draft")
    t.release.resolve(); await t.changing
    await t.identity("third-owner")
    expect(t.store.collections.cards.get("account")).toBeUndefined()
    expect(t.store.session().draft).toBe("")
    await t.dispose()
    const restored = await createAppStore({ backend: { kind: "localStorage", storage: t.storage }, mode: "localStorage", degraded: false,
      privacy: { record: t.storage, eraseInactiveDatabase: async () => {} } })
    try {
      expect(restored.collections.identitySessions.get("identity")?.login).toBe("third-owner")
      expect(restored.collections.cards.get("account")).toBeUndefined()
      expect(restored.session().draft).toBe("")
      expect(restored.collections.commandIntents.size).toBe(0)
      expect((await restored.verifyState()).valid).toBe(true)
    } finally { await restored.dispose?.() }
  } finally { await t.dispose() }
})

for (const door of ["button", "submission", "agent", "native", "agent form", "chat", "input mode"] as const) {
  test(`${door} returns an honest refusal before gestures, network work, or durable admission`, async () => {
    const t = await fixture()
    try {
      const before = t.store.collections.commandIntents.size
      if (door === "button") expect(t.controller.runCommand("account.show")).toBe(true)
      else {
        const outcome = door === "submission" ? await t.controller.submitCommand({ name: "account.show", actor: "user", payload: {} })
          : door === "agent" ? await t.controller.commands.runForAgent("account.show")
          : door === "native" ? await t.controller.commands.runAsAgent("account.show")
          : door === "agent form" ? await t.controller.commands.submit({ name: "account.show", actor: "agent", payload: {} })
          : await t.controller.commands.run(door === "chat" ? "chat.open" : "input.mode", door === "chat" ? undefined : "keyboard")
        expect(outcome).toMatchObject({ status: "failed", persistenceFailed: true, writeRefused: true })
      }
      expect(t.store.collections.commandIntents.size).toBe(before)
      expect(t.store.session().paletteOpen).not.toBe(true)
      expect(t.controller.privacyNotices.get("toast-privacy-write")?.detail).toBe("Account cleanup is running. Try again in a moment.")
      t.release.resolve(); await t.changing
      await t.store.settled?.()
      expect(t.store.collections.cards.get("account")).toBeUndefined()
      expect(t.store.collections.commandIntents.size).toBe(before)
    } finally { await t.dispose() }
  })
}

test("a failed real cleanup stops the controller before saved reads close and reload retries it", async () => {
  const t = await fixture(true)
  try {
    t.release.resolve()
    await expect(t.changing).rejects.toThrow("PRIVATE CLEANUP ERROR")
    expect(t.store.privacyWriteState()).toBe("failed")
    expect(() => t.controller.runCommand("account.show")).not.toThrow()
    expect(() => t.controller.changeDraft("private rejected input")).not.toThrow()
    expect(await t.controller.commands.runForAgent("account.show")).toMatchObject({ status: "failed", error: "Account cleanup failed. Reload to retry." })
    expect(t.controller.runCommand("account.show")).toBe(false)
    expect(await t.controller.submitCommand({ name: "toast.dismiss", actor: "user", payload: { toastId: "toast-privacy-write" } })).toMatchObject({ status: "failed" })
    await t.dispose()
    const restored = await createAppStore({ backend: { kind: "localStorage", storage: t.storage }, mode: "localStorage", degraded: false,
      privacy: { record: t.storage, eraseInactiveDatabase: async () => {} } })
    try {
      expect(restored.privacyWriteState()).toBe("ready")
      expect(restored.collections.cards.get("account")).toBeUndefined()
      expect(restored.session().draft).toBe("")
      expect((await restored.verifyState()).valid).toBe(true)
    } finally { await restored.dispose?.() }
  } finally { await t.dispose() }
})
