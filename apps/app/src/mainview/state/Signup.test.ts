import { describe, expect, test } from "bun:test"
import { createAppStore, type AppStore } from "./AppStore"
import { accountSlug, initialSignup, SIGNUP_QUESTIONS, signupActive, signupAfterIdentity, signupOpening, signupOwnerKey, validAccountName, type Signup } from "./Signup"
import { memoryStorage } from "./TestFixtures"

const closeStore = async (store: AppStore) => {
  if (typeof store.dispose !== "function") throw new Error("The fixture store has no disposal authority")
  await store.dispose()
}

describe("Signup", () => {
  test("an account name is a smithers.sh path segment", () => {
    expect(accountSlug("Ada Park!")).toBe("adapark")
    expect(validAccountName("adapark")).toBe(true)
    expect(validAccountName("a")).toBe(false)
    expect(validAccountName("-ada")).toBe(false)
    expect(validAccountName("a".repeat(40))).toBe(false)
  })

  test("the onboarding owns the transcript for a signed-out visitor and for any unfinished stage, never for a legacy signed-in session", () => {
    expect(signupActive(undefined, "signed-out")).toBe(true)
    expect(signupActive(undefined, "signed-in")).toBe(false)
    expect(signupActive(undefined, "unknown")).toBe(false)
    expect(signupActive({ ...initialSignup(), stage: "poll" }, "signed-in")).toBe(true)
    expect(signupActive({ ...initialSignup(), stage: "done" }, "signed-in")).toBe(false)
  })

  test("before identity answers, a browser with no retained owner opens on the title alone, and a retained owner sees no signup", () => {
    expect(signupOpening(undefined, "unknown", null)).toBe("title")
    expect(signupOpening(undefined, undefined, undefined)).toBe("title")
    expect(signupOpening(undefined, "unknown", "will")).toBe(false)
    expect(signupOpening(undefined, "signed-out", null)).toBe("full")
    expect(signupOpening(undefined, "signed-in", null)).toBe(false)
    expect(signupOpening({ ...initialSignup(), stage: "poll" }, "unknown", "will")).toBe("full")
  })

  test("a GitHub sign-in carries the doors to the account step with the login prefilled, and leaves a later stage alone", () => {
    const moved = signupAfterIdentity(initialSignup(), "signed-in", "Ada-Park", null)
    expect(moved?.stage).toBe("account")
    expect(moved?.account).toBe("ada-park")
    expect(moved?.draft.account).toBe("ada-park")
    const poll = { ...initialSignup(), stage: "poll" as const, question: 3 }
    expect(signupAfterIdentity(poll, "signed-in", "ada", null)).toBe(poll)
    // No row yet: a browser that never held an owner starts at the account step; one that did is a returning person.
    expect(signupAfterIdentity(undefined, "signed-in", "ada", null)?.stage).toBe("account")
    expect(signupAfterIdentity(undefined, "signed-in", "ada", "ada")).toBeUndefined()
  })

  test("the poll asks the seven questions Will listed, in order, none required", () => {
    expect(SIGNUP_QUESTIONS.map(q => q.id)).toEqual(["size", "role", "heard", "know", "models", "repo", "more"])
    expect(SIGNUP_QUESTIONS.filter(q => q.required).map(q => q.id)).toEqual([])
  })

  test("an untouched legacy account prefill follows the current identity", () => {
    const old = { ...initialSignup(), stage: "account" as const, door: "github" as const,
      account: "old-owner", draft: { account: "old-owner" } }
    expect(signupAfterIdentity(old, "signed-in", "new-owner", "new-owner"))
      .toEqual({ ...old, account: "new-owner", draft: { account: "new-owner" } })
    expect(signupAfterIdentity(old, "signed-in", "old-owner", "old-owner")).toBe(old)
    // A manually edited or submitted legacy row cannot be assigned by its slug.
    for (const row of [
      { ...old, draft: { account: "chosen-slug" } },
      { ...old, draft: { ...old.draft, name: "Entered name" } },
      { ...old, stage: "poll" as const, name: "Entered name" }
    ]) expect(signupAfterIdentity(row, "signed-in", "new-owner", "new-owner")).toBe(row)
  })

  test("signup.changed merges onto the row and a sign-in advances an unfinished signup through the projection", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    try {
      expect(store.session().signup).toBeUndefined()
      await store.dispatch({ type: "signup.changed", actor: "user", patch: { draft: {} } }).isPersisted.promise
      expect(store.session().signup).toEqual(initialSignup())
      await store.dispatch({ type: "signup.changed", actor: "user", patch: { draft: { name: "Ada Park" } } }).isPersisted.promise
      expect(store.session().signup?.stage).toBe("sign-in")
      expect(store.session().signup?.draft).toEqual({ name: "Ada Park" })
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "adapark", admin: false, scopesPlain: null }).isPersisted.promise
      expect(store.session().signup?.stage).toBe("account")
      expect(store.session().signup?.account).toBe("adapark")
    } finally { await closeStore(store) }
  })
})


test.each([
  ["", false], ["a", false], ["ab", true], ["a".repeat(39), true], ["a".repeat(40), false],
  ["a-b", true], ["a--b", true], ["01", true], ["-ab", false], ["ab-", false], ["AB", false], ["a_b", false], ["a b", false], ["雪a", false]
])("account-name admission for %s is %s", (name, valid) => {
  expect(validAccountName(name)).toBe(valid)
})

test("slug normalization bounds only the URL draft and fresh signup maps never share edits", () => {
  expect(accountSlug("  Ada_雪.Park! --  ")).toBe("adapark--")
  expect(accountSlug("A".repeat(40))).toBe("a".repeat(39))
  const first = initialSignup(), second = initialSignup()
  first.answers.models = ["Codex"]
  first.draft.name = "Ada"
  expect(second).toEqual({ stage: "sign-in", question: 0, answers: {}, draft: {} })
  expect(initialSignup()).toEqual(second)
  expect(first.answers).not.toBe(second.answers)
  expect(first.draft).not.toBe(second.draft)
})

test("all unfinished stages own the transcript regardless of identity availability; done owns none", () => {
  for (const stage of ["sign-in", "account", "poll", "ready", "done"] as const) {
    const row: Signup = { ...initialSignup(), stage }
    for (const identity of [undefined, "unknown", "unavailable", "signed-out", "signed-in"] as const) {
      expect(signupActive(row, identity)).toBe(stage !== "done")
      expect(signupOpening(row, identity, "returning-owner")).toBe(stage === "done" ? false : "full")
    }
  }
  expect(signupActive(undefined, "unavailable")).toBe(false)
  expect(signupOpening(undefined, "unavailable", null)).toBe(false)
})

const legacy: Signup = { stage: "account", question: 0, door: "github", account: "old-owner", answers: {}, draft: { account: "old-owner" } }
const legacyEdits: Array<{ name: string; patch: Partial<Signup> }> = [
  { name: "submitted name", patch: { name: "Ada" } },
  { name: "selected repository", patch: { repo: "org/repo" } },
  { name: "answered question", patch: { answers: { more: "keep this" } } },
  { name: "advanced question", patch: { question: 1 } },
  { name: "edited account draft", patch: { draft: { account: "my-choice" } } },
  { name: "other edited draft", patch: { draft: { account: "old-owner", more: "typed answer" } } }
]
test.each(legacyEdits)("identity does not replace legacy $name", ({ patch }) => {
  const row: Signup = { ...legacy, ...patch }
  expect(signupAfterIdentity(row, "signed-in", "new-owner", "new-owner")).toBe(row)
})

test("empty untouched auxiliary drafts can follow a prefill, while explicit sign-in drafts survive", () => {
  const row: Signup = { ...legacy, draft: { name: "", more: "" } }
  expect(signupAfterIdentity(row, "signed-in", "new-owner", null)).toEqual({
    stage: "account", question: 0, door: "github", account: "new-owner", answers: {}, draft: { name: "", more: "", account: "new-owner" }
  })
  expect(row.draft).toEqual({ name: "", more: "" })
  const entered: Signup = { ...initialSignup(), account: "chosen", draft: { account: "", name: "Ada" } }
  expect(signupAfterIdentity(entered, "signed-in", "login", null)).toEqual({
    stage: "account", question: 0, door: "github", account: "chosen", answers: {}, draft: { account: "", name: "Ada" }
  })
  expect(signupAfterIdentity(entered, "signed-out", "login", null)).toBe(entered)
  expect(signupAfterIdentity(entered, "signed-in", null, null)).toBe(entered)
})

test("a sign-in row with an explicit GitHub door advances like a legacy row with no door", () => {
  for (const signup of [initialSignup(), { ...initialSignup(), door: "github" as const }]) {
    const before = structuredClone(signup)
    expect(signupAfterIdentity(signup, "signed-in", "Ada-Park", null)).toEqual({
      stage: "account", door: "github", question: 0, account: "ada-park", answers: {}, draft: { account: "ada-park" }
    })
    expect(signup).toEqual(before)
  }
})

describe("signupOwnerKey", () => {
  test("no owner before and after the first signed-out answer: the title keeps its nodes", () => {
    expect(signupOwnerKey(undefined)).toBe(signupOwnerKey({ state: "unknown" }))
    expect(signupOwnerKey({ state: "unknown" })).toBe(signupOwnerKey({ state: "signed-out", login: null }))
    expect(signupOwnerKey({ state: "unavailable" })).toBe("none")
  })
  test("the same signed-in owner keeps the editor; a different owner or a sign-out replaces it", () => {
    const ada = signupOwnerKey({ state: "signed-in", login: "ada" })
    expect(signupOwnerKey({ state: "signed-in", login: "ada" })).toBe(ada)
    expect(signupOwnerKey({ state: "signed-in", login: "bob" })).not.toBe(ada)
    expect(signupOwnerKey({ state: "signed-out", login: null })).not.toBe(ada)
  })
  test("the account owner outranks the login, and the provider separates same-named owners", () => {
    expect(signupOwnerKey({ state: "signed-in", provider: "github", login: "ada", accountOwnerLogin: "acme" })).toBe("owner:github:acme")
    expect(signupOwnerKey({ state: "signed-in", provider: "github", login: "ada", accountOwnerLogin: null })).toBe("owner:github:ada")
    expect(signupOwnerKey({ state: "signed-in", provider: "local", login: "ada" })).not.toBe(signupOwnerKey({ state: "signed-in", provider: "github", login: "ada" }))
  })
})
