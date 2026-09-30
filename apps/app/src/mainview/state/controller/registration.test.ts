import { expect, test } from "bun:test"
import ready from "../../cards/fixtures/register-repository-ready.json"
import review from "../../cards/fixtures/register-repository-review.json"
import { createAppStore, type AppStore } from "../AppStore"
import type { Card } from "../AppState"
import { createActorBindings } from "../ActorBindings"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createRegistrationController, registrationId } from "./registration"

type Phase = "starting" | "running" | "done" | "failed"

const fixture = async (options: {
  wrapStore?: (store: AppStore) => AppStore
  importRepository?: (repo: string) => Promise<unknown>
  startRegistration?: (cloudRepo: string, link: string, box: string | null) => Promise<{ value: string } | string>
} = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(options.wrapStore?.(store) ?? store, unavailableAgent, { toastDebounceMs: 1, workflowPollMs: 5, fetchImpl: async () => new Response(null, { status: 500 }) })
  Object.assign(ctx, createFailureController(ctx))
  const imports: Array<string> = []
  const launches: Array<{ cloudRepo: string; link: string; box?: string | null }> = []
  /** The launch never answers unless a test settles it. */
  const pending = Promise.withResolvers<{ value: string } | string>()
  const importCard = (repo: string, phase: Phase, error?: string, workspaceId?: string) =>
    store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: `repo-import-${repo}`, kind: "repo-import", title: `Import · ${repo}`, status: "active", createdAt: Date.now(), ordinal: store.nextOrdinal(),
      payload: { repo, jobId: "job-1", phase, detail: null, error: error ?? null, repository: { owner: repo.split("/")[0]!, name: repo.split("/")[1]! },
        ...(workspaceId === undefined ? {} : { workspaceId }) }
    } }).isPersisted.promise
  const actors = createActorBindings(ctx.onDispose)
  const registration = actors.pair(ctx, context => createRegistrationController(context, {
    guard: () => undefined,
    importRepository: async (repo) => { imports.push(repo); await importCard(repo, "running"); await options.importRepository?.(repo) },
    startRegistration: (cloudRepo, link, box) => {
      launches.push({ cloudRepo, link, ...(box === null ? {} : { box }) })
      return options.startRegistration?.(cloudRepo, link, box) ?? pending.promise
    }
  }))
  const card = (repo: string) => {
    const row = store.collections.cards.get(registrationId(repo))
    return row?.kind === "registration" ? row : undefined
  }
  const runCard = (repo: string, events: ReadonlyArray<unknown>, phase: string): Promise<unknown> =>
    store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: `run-${repo}`, kind: "run-trace", title: "register-repository", status: "active", createdAt: Date.now(), ordinal: store.nextOrdinal(),
      payload: { repo, runId: "run-1", workflow: "register-repository", phase, steps: [], result: null, lastSeq: events.length,
        events: events as never, input: { link: repo } }
    } as Card }).isPersisted.promise
  return { store, ctx, registration, agentRegistration: actors.select(registration), imports, launches, pending, importCard, card, runCard,
    dispose: async () => { pending.resolve("disposed"); await ctx.dispose(); await store.dispose?.() } }
}

test("the command answers at once while the import and launch are unresolved; chat stays usable", async () => {
  const t = await fixture()
  try {
    expect(await t.registration.registerRepository("https://github.com/Acme/Widgets.git")).toEqual({ value: "registration-requested repo=acme/widgets" })
    expect(t.card("acme/widgets")?.payload).toMatchObject({ repo: "acme/widgets", phase: "importing" })
    await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "Still usable" }).isPersisted.promise
    expect(t.store.session().draft).toBe("Still usable")
    expect(t.launches).toHaveLength(0)
    await t.importCard("acme/widgets", "done")
    await waitFor(() => t.launches.length === 1)
    expect(t.launches[0]).toEqual({ cloudRepo: "acme/widgets", link: "acme/widgets" })
    await settle()
    // The launch has not answered: nothing claims the registration started.
    expect(t.card("acme/widgets")?.payload.phase).toBe("launching")
    t.pending.resolve({ value: "run-requested" })
    await waitFor(() => t.card("acme/widgets")?.payload.phase === "launched")
  } finally { await t.dispose() }
})

test("the launch runs on the box the import names, also after a reload; without one it falls back to the default box", async () => {
  const t = await fixture()
  try {
    await t.registration.registerRepository("acme/widgets")
    await t.importCard("acme/widgets", "done", undefined, "0b6f3c1e-5d2a-4f8e-9c47-2a1d6e8b3f90")
    await waitFor(() => t.launches.length === 1)
    expect(t.launches[0]).toEqual({ cloudRepo: "acme/widgets", link: "acme/widgets", box: "0b6f3c1e-5d2a-4f8e-9c47-2a1d6e8b3f90" })
  } finally { await t.dispose() }
  const bare = await fixture()
  try {
    await bare.registration.registerRepository("acme/widgets")
    await bare.importCard("acme/widgets", "done")
    await waitFor(() => bare.launches.length === 1)
    expect(bare.launches[0]).toEqual({ cloudRepo: "acme/widgets", link: "acme/widgets" })
  } finally { await bare.dispose() }
  // After a reload mid-launch, the resumed launch reads the same box from the import card.
  const reloaded = await fixture()
  try {
    await reloaded.importCard("acme/widgets", "done", undefined, "0b6f3c1e-5d2a-4f8e-9c47-2a1d6e8b3f90")
    await reloaded.store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: registrationId("acme/widgets"), kind: "registration", title: "Register a repository", status: "active", createdAt: Date.now(), ordinal: reloaded.store.nextOrdinal(),
      payload: { link: "acme/widgets", repo: "acme/widgets", phase: "launching", startedAt: Date.now(), error: null, cloudRepo: "acme/widgets", replay: 0, accountOwner: "owner" }
    } }).isPersisted.promise
    reloaded.registration.resumeRegistrations()
    await waitFor(() => reloaded.launches.length === 1)
    expect(reloaded.imports).toEqual([])
    expect(reloaded.launches[0]).toEqual({ cloudRepo: "acme/widgets", link: "acme/widgets", box: "0b6f3c1e-5d2a-4f8e-9c47-2a1d6e8b3f90" })
  } finally { await reloaded.dispose() }
})

test("repeated starts reuse one request; a second repository waits for the first", async () => {
  const t = await fixture()
  try {
    await t.registration.registerRepository("acme/widgets")
    expect(await t.registration.registerRepository("github.com/acme/widgets")).toEqual({ value: "registration-open repo=acme/widgets status=Analyzing" })
    await settle()
    expect(t.imports).toEqual(["acme/widgets"])
    expect(await t.registration.registerRepository("acme/other")).toBe("Finish registering acme/widgets first.")
    expect(t.card("acme/other")).toBeUndefined()
    // In review, a wait nobody has answered, still holds the slot.
    await t.runCard("acme/widgets", review, "waiting-approval")
    expect(await t.registration.registerRepository("acme/other")).toBe("Finish registering acme/widgets first.")
  } finally { await t.dispose() }
})

test("a bad link is refused and nothing is saved", async () => {
  const t = await fixture()
  try {
    expect(await t.registration.registerRepository("https://gitlab.com/acme/widgets")).toBe("That is not a GitHub repository link.")
    expect([...t.store.collections.cards.values()].some((card) => card.kind === "registration")).toBe(false)
  } finally { await t.dispose() }
})

test("two quick starts for different repositories admit one", async () => {
  const t = await fixture()
  try {
    const [first, second] = await Promise.all([t.registration.registerRepository("acme/widgets"), t.registration.registerRepository("acme/other")])
    expect([first, second].filter((answer) => typeof answer === "object")).toHaveLength(1)
  } finally { await t.dispose() }
})

test("a failed import stays visible and a retry starts again", async () => {
  const t = await fixture()
  try {
    await t.registration.registerRepository("acme/widgets")
    await waitFor(() => t.imports.length === 1)
    await t.importCard("acme/widgets", "failed", "clone refused")
    await waitFor(() => t.card("acme/widgets")?.payload.phase === "failed")
    expect(t.card("acme/widgets")?.payload.error).toBe("clone refused")
    expect(await t.registration.registerRepository("acme/widgets")).toEqual({ value: "registration-requested repo=acme/widgets" })
    await waitFor(() => t.imports.length === 2)
  } finally { await t.dispose() }
})

test("a registered repository replays its recorded run: no import, no launch", async () => {
  const t = await fixture()
  try {
    await t.registration.registerRepository("acme/widgets")
    await t.importCard("acme/widgets", "done")
    t.pending.resolve({ value: "run-requested" })
    await waitFor(() => t.card("acme/widgets")?.payload.phase === "launched")
    await t.runCard("acme/widgets", ready, "completed")
    const before = { imports: t.imports.length, launches: t.launches.length }
    expect(await t.registration.registerRepository("https://github.com/acme/widgets")).toEqual({ value: "registration-replayed repo=acme/widgets status=Ready" })
    expect(t.card("acme/widgets")?.payload.replay).toBe(1)
    await settle()
    expect({ imports: t.imports.length, launches: t.launches.length }).toEqual(before)
    // Ready frees the slot for the next repository.
    expect(await t.registration.registerRepository("acme/other")).toEqual({ value: "registration-requested repo=acme/other" })
  } finally { await t.dispose() }
})

const switchAccount = async (t: Awaited<ReturnType<typeof fixture>>, login: string) => {
  await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
}

test("a new account can register the same repository while the previous launch is unresolved", async () => {
  const old = Promise.withResolvers<{ value: string } | string>()
  let calls = 0
  const t = await fixture({ startRegistration: async () => ++calls === 1 ? old.promise : { value: "run-requested" } })
  try {
    await t.registration.registerRepository("acme/widgets")
    await t.importCard("acme/widgets", "done")
    await waitFor(() => t.launches.length === 1)
    await switchAccount(t, "bob")
    await t.registration.registerRepository("acme/widgets")
    await settle()
    expect(t.imports).toEqual(["acme/widgets", "acme/widgets"])
    await t.importCard("acme/widgets", "done")
    await waitFor(() => t.card("acme/widgets")?.payload.phase === "launched")
    expect(t.launches).toHaveLength(2)
    old.resolve({ value: "old-run" })
    await settle()
    expect(t.card("acme/widgets")?.payload).toMatchObject({ accountOwner: "bob", phase: "launched", error: null })
  } finally { old.resolve("disposed"); await t.dispose() }
})

for (const stage of ["import", "launch"] as const) test(`a late ${stage} rejection cannot fail the next account's registration`, async () => {
  const old = Promise.withResolvers<never>()
  let calls = 0
  const t = await fixture(stage === "import"
    ? { importRepository: async () => { if (++calls === 1) await old.promise } }
    : { startRegistration: async () => { if (++calls === 1) return old.promise; return { value: "run-requested" } } })
  try {
    await t.registration.registerRepository("acme/widgets")
    if (stage === "launch") await t.importCard("acme/widgets", "done")
    await waitFor(() => calls === 1)
    await switchAccount(t, "bob")
    await t.registration.registerRepository("acme/widgets")
    old.reject(new Error("old account failure"))
    await settle()
    expect(t.card("acme/widgets")?.payload).toMatchObject({ accountOwner: "bob", phase: "importing", error: null })
    expect(t.ctx.failures.recent()).toEqual([])
  } finally { old.reject(new Error("disposed")); await t.dispose() }
})

const receiptGate = () => ({ held: Promise.withResolvers<void>(), entered: Promise.withResolvers<void>() })
const holdRegistration = (store: AppStore, phase: "importing" | "failed", gates: Array<ReturnType<typeof receiptGate>>): AppStore => ({
  ...store,
  dispatch: transition => {
    const transaction = store.dispatch(transition)
    const gate = transition.type === "card.upsert" && transition.card.kind === "registration" && transition.card.payload.phase === phase ? gates.shift() : undefined
    if (gate === undefined) return transaction
    gate.entered.resolve()
    return new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => gate.held.promise) } : Reflect.get(target, key, receiver) })
  }
})

for (const returningOwner of [false, true]) test(`a retired admission cannot launch before the new account's receipt (${returningOwner ? "sign back in" : "different account"})`, async () => {
  const first = receiptGate(), second = receiptGate()
  const t = await fixture({ wrapStore: store => holdRegistration(store, "importing", [first, second]) })
  try {
    const retired = t.registration.registerRepository("acme/widgets")
    await first.entered.promise
    if (returningOwner) {
      await t.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
      await switchAccount(t, "owner")
    } else await switchAccount(t, "bob")
    const current = t.registration.registerRepository("acme/widgets")
    await second.entered.promise
    first.held.resolve()
    await retired
    expect(t.imports).toEqual([])
    second.held.resolve()
    await current
    expect(t.imports).toEqual(["acme/widgets"])
  } finally { first.held.resolve(); second.held.resolve(); await t.dispose() }
})

for (const viaAgent of [false, true]) test(`a ${viaAgent ? "Smithers" : "human"} retry starts while the failure saves without losing its ownership`, async () => {
  const failure = receiptGate()
  let launches = 0
  const t = await fixture({ wrapStore: store => holdRegistration(store, "failed", [failure]),
    startRegistration: async () => ++launches === 1 ? "launch refused" : { value: "run-requested" } })
  try {
    await t.registration.registerRepository("acme/widgets")
    await t.importCard("acme/widgets", "done")
    await failure.entered.promise
    expect(t.card("acme/widgets")?.payload.phase).toBe("failed")
    await (viaAgent ? t.agentRegistration : t.registration).registerRepository("acme/widgets")
    expect(t.imports).toHaveLength(2)
    failure.held.resolve()
    await settle()
    t.registration.resumeRegistrations()
    await settle()
    expect(t.imports).toHaveLength(2)
    await t.importCard("acme/widgets", "done")
    await waitFor(() => t.card("acme/widgets")?.payload.phase === "launched")
    expect(t.launches).toHaveLength(2)
  } finally { failure.held.resolve(); await t.dispose() }
})

test("closing the controller during admission starts no import", async () => {
  const admission = receiptGate()
  const t = await fixture({ wrapStore: store => holdRegistration(store, "importing", [admission]) })
  try {
    const request = t.registration.registerRepository("acme/widgets")
    await admission.entered.promise
    await t.ctx.dispose()
    admission.held.resolve()
    expect(await request).toBeUndefined()
    expect(t.imports).toEqual([])
    expect(t.ctx.failures.recent()).toEqual([])
  } finally { admission.held.resolve(); await t.dispose() }
})

for (const stage of ["import", "launch"] as const) test(`a late ${stage} rejection after disposal cannot write or publish a failure`, async () => {
  const held = Promise.withResolvers<never>()
  const t = await fixture(stage === "import" ? { importRepository: () => held.promise } : { startRegistration: () => held.promise })
  try {
    await t.registration.registerRepository("acme/widgets")
    if (stage === "launch") {
      await t.importCard("acme/widgets", "done")
      await waitFor(() => t.launches.length === 1)
    }
    await t.store.settled?.()
    const before = t.card("acme/widgets")
    await t.ctx.dispose()
    held.reject(new Error("late failure"))
    await settle()
    expect(t.card("acme/widgets")).toEqual(before)
    expect(t.ctx.failures.recent()).toEqual([])
  } finally { held.reject(new Error("disposed")); await t.dispose() }
})

test("human and Smithers resumption share the same pending registration", async () => {
  const t = await fixture()
  try {
    await t.registration.registerRepository("acme/widgets")
    t.agentRegistration.resumeRegistrations()
    t.registration.resumeRegistrations()
    await settle()
    expect(t.imports).toEqual(["acme/widgets"])
    await t.importCard("acme/widgets", "done")
    await waitFor(() => t.launches.length === 1)
    t.agentRegistration.resumeRegistrations()
    await settle()
    expect(t.launches).toHaveLength(1)
  } finally { await t.dispose() }
})

for (const outcome of ["success", "failure"] as const) test(`an identity outage retains the admitted registration's ${outcome}`, async () => {
  const t = await fixture()
  try {
    await t.registration.registerRepository("acme/widgets")
    await t.importCard("acme/widgets", "done")
    await waitFor(() => t.launches.length === 1)
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "unavailable", login: null,
      allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
    t.pending.resolve(outcome === "success" ? { value: "run-requested" } : "launch refused")
    await settle()
    expect(t.card("acme/widgets")?.payload).toMatchObject({ accountOwner: "owner", phase: outcome === "success" ? "launched" : "failed" })
    await switchAccount(t, "owner")
    t.registration.resumeRegistrations()
    await settle()
    expect(t.imports).toHaveLength(1)
    expect(t.launches).toHaveLength(1)
    await t.store.settled?.()
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.dispose() }
})


test("resuming through either actor waits for the initial registration receipt", async () => {
  const admission = receiptGate()
  const t = await fixture({ wrapStore: store => holdRegistration(store, "importing", [admission]) })
  try {
    const request = t.registration.registerRepository("acme/widgets")
    await admission.entered.promise
    t.agentRegistration.resumeRegistrations()
    t.registration.resumeRegistrations()
    await settle()
    expect(t.imports).toEqual([])
    admission.held.resolve()
    await request
    expect(t.imports).toEqual(["acme/widgets"])
  } finally { admission.held.resolve(); await t.dispose() }
})

test("a replay receipt from the previous account cannot navigate over the new registration", async () => {
  const replay = receiptGate()
  const t = await fixture({ wrapStore: store => ({ ...store, dispatch: transition => {
    const transaction = store.dispatch(transition)
    if (transition.type !== "card.upsert" || transition.card.kind !== "registration" || transition.card.payload.replay !== 1) return transaction
    replay.entered.resolve()
    return new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => replay.held.promise) } : Reflect.get(target, key, receiver) })
  } }) })
  try {
    await t.registration.registerRepository("acme/widgets")
    await t.importCard("acme/widgets", "done")
    t.pending.resolve({ value: "run-requested" })
    await waitFor(() => t.card("acme/widgets")?.payload.phase === "launched")
    await t.runCard("acme/widgets", ready, "completed")
    const oldReplay = t.registration.registerRepository("acme/widgets")
    await replay.entered.promise
    await switchAccount(t, "bob")
    await t.registration.registerRepository("acme/widgets")
    replay.held.resolve()
    expect(await oldReplay).toBeUndefined()
    expect(t.card("acme/widgets")?.payload).toMatchObject({ accountOwner: "bob", phase: "importing", replay: 0 })
  } finally { replay.held.resolve(); await t.dispose() }
})
