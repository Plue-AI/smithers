import { expect, test } from "bun:test"
import { createAppStore, type AppStore } from "./AppStore"
import { type SignupStage } from "./Signup"
import { type PrivacyStorage, readPrivacyRetirement } from "../chain/PrivacyRetirement"
import { PERSISTENCE_BACKEND_STORAGE_KEY } from "../chain/SchemaVersion"

const open = async (storage: PrivacyStorage) => createAppStore({ backend: { kind: "localStorage", storage }, mode: "localStorage", degraded: false,
  privacy: { record: storage, eraseInactiveDatabase: async () => {} } })
const identity = (store: AppStore, login: string, provider: "github" | "local" = "github", displayName?: string) =>
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, provider,
    ...(displayName === undefined ? {} : { displayName }), admin: false, scopesPlain: null }).isPersisted.promise
const fixture = async (stage: SignupStage | "automatic", provider: "github" | "local" = "github") => {
  const bytes = new Map<string, string>()
  const storage: PrivacyStorage = {
    get length() { return bytes.size }, key: index => [...bytes.keys()][index] ?? null,
    getItem: key => bytes.get(key) ?? null, setItem: (key, value) => { bytes.set(key, value) }, removeItem: key => { bytes.delete(key) }
  }
  storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "localStorage")
  const store = await open(storage)
  // The prior person's GitHub name is account content too: it leaves with the account.
  await identity(store, "old-owner", provider, "PRIVATE-SIGNUP-GITHUB-NAME")
  if (stage === "automatic") expect(store.session().signup?.draft.name).toBe("PRIVATE-SIGNUP-GITHUB-NAME")
  if (stage !== "automatic") await store.dispatch({ type: "signup.changed", actor: "user", patch: {
    stage, name: "PRIVATE-SIGNUP-NAME", account: "private-signup-slug", question: 4,
    answers: { more: "PRIVATE-SIGNUP-ANSWER", repo: "private-signup/repo" }, repo: "private-signup/repo",
    draft: { account: "edited-slug", name: "PRIVATE-SIGNUP-DRAFT", more: "PRIVATE-SIGNUP-FREEFORM" }
  } }).isPersisted.promise
  return { store, storage, bytes }
}

/*
 * A completed signup survives every boundary as a content-free receipt: the
 * name, slug, answers and drafts leave with the account, but `done` stays, so
 * signing out and back in shows the first-run, never the poll again
 * (apps/app/AGENTS.md: after Start Automating "every visit shows the first-run").
 */
const DONE = { stage: "done", question: 0, answers: {}, draft: {} } as const

for (const stage of ["automatic", "account", "poll", "ready", "done"] as const) {
  for (const boundary of ["replacement", "sign-out", "provider replacement"] as const) {
    test(`${stage} signup belongs to its identity across ${boundary} and durable reload`, async () => {
      const f = await fixture(stage, boundary === "provider replacement" ? "local" : "github")
      let restored: AppStore | undefined
      try {
        if (boundary === "sign-out") {
          await f.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
          expect(f.store.session().signup).toEqual(stage === "done" ? DONE : { stage: "sign-in", question: 0, answers: {}, draft: {} })
        }
        const login = boundary === "replacement" ? "new-owner" : "old-owner"
        await identity(f.store, login)
        const expected = stage === "done" ? DONE : { stage: "account", door: "github", account: login, question: 0, answers: {}, draft: { account: login } } as const
        expect(f.store.session().signup).toEqual(expected)
        expect(readPrivacyRetirement(f.storage)?.phase).toBe("complete")
        expect(JSON.stringify([...f.bytes])).not.toContain("PRIVATE-SIGNUP")
        expect(JSON.stringify([...f.bytes])).not.toContain("private-signup")
        expect(JSON.stringify([...f.bytes])).not.toContain("edited-slug")
        await f.store.dispose?.()
        restored = await open(f.storage)
        expect(restored.session().signup).toEqual(expected)
        expect((await restored.verifyState()).valid).toBe(true)
      } finally { await restored?.dispose?.(); await f.store.dispose?.() }
    })
  }
}

test("an account replacement prefills the new person's GitHub name and never carries the previous one's", async () => {
  const f = await fixture("automatic")
  let restored: AppStore | undefined
  try {
    await identity(f.store, "new-owner", "github", "New Owner")
    const expected = { stage: "account", door: "github", account: "new-owner", question: 0, answers: {}, draft: { account: "new-owner", name: "New Owner" } } as const
    expect(f.store.session().signup).toEqual(expected)
    expect(JSON.stringify([...f.bytes])).not.toContain("PRIVATE-SIGNUP")
    await f.store.dispose?.()
    restored = await open(f.storage)
    expect(restored.session().signup).toEqual(expected)
    expect((await restored.verifyState()).valid).toBe(true)
  } finally { await restored?.dispose?.(); await f.store.dispose?.() }
})

test("same-owner refresh and a transient outage preserve intentional signup edits and answers", async () => {
  const f = await fixture("poll")
  try {
    const signup = f.store.session().signup
    await identity(f.store, "old-owner")
    expect(f.store.session().signup).toEqual(signup)
    await f.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "unavailable", login: null,
      admin: false, scopesPlain: null }).isPersisted.promise
    await identity(f.store, "old-owner")
    expect(f.store.session().signup).toEqual(signup)
    expect((await f.store.verifyState()).valid).toBe(true)
  } finally { await f.store.dispose?.() }
})
