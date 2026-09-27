import { expect, test } from "bun:test"
import ready from "../../cards/fixtures/register-repository-ready.json"
import review from "../../cards/fixtures/register-repository-review.json"
import { createAppStore } from "../AppStore"
import type { Card } from "../AppState"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createRegistrationController, registrationId } from "./registration"

type Phase = "starting" | "running" | "done" | "failed"

const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, { toastDebounceMs: 1, workflowPollMs: 5, fetchImpl: async () => new Response(null, { status: 500 }) })
  Object.assign(ctx, createFailureController(ctx))
  const imports: Array<string> = []
  const launches: Array<{ cloudRepo: string; link: string }> = []
  /** The launch never answers unless a test settles it. */
  const pending = Promise.withResolvers<{ value: string } | string>()
  const importCard = (repo: string, phase: Phase, error?: string) =>
    store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: `repo-import-${repo}`, kind: "repo-import", title: `Import · ${repo}`, status: "active", createdAt: Date.now(), ordinal: store.nextOrdinal(),
      payload: { repo, jobId: "job-1", phase, detail: null, error: error ?? null, repository: { owner: repo.split("/")[0]!, name: repo.split("/")[1]! } }
    } }).isPersisted.promise
  const registration = createRegistrationController(ctx, {
    guard: () => undefined,
    importRepository: async (repo) => { imports.push(repo); await importCard(repo, "running") },
    startRegistration: (cloudRepo, link) => { launches.push({ cloudRepo, link }); return pending.promise }
  })
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
  return { store, ctx, registration, imports, launches, pending, importCard, card, runCard,
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
