/*
 * The Home card's flows through the production command dispatcher: `/stack`,
 * Move up/down, Merge, a background run's Retry and Dismiss, and main's sync
 * Retry act on the seeded design world. Expected values are the seed's literals.
 */
import { expect, test } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch, unavailableAgent } from "../../state/TestFixtures"
import { shellViewsOf } from "../../state/seams/DesignWorld/shell"
import { modelInvocable, nameOf } from "../registry"

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const profile = signupProfileFetch(async () => new Response("{}", { status: 404 }))
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  return { store, controller }
}
type Harness = Awaited<ReturnType<typeof boot>>
const slash = (h: Harness, name: string, args?: string) => h.controller.runCommandForResult(name, args)
const button = (h: Harness, name: string, payload: Record<string, unknown>) => h.controller.submitCommand({ name, payload, actor: "user" })
const stack = (h: Harness) => h.controller.design.world().repo.stack

test("the Home doors register; Merge is a person's alone", async () => {
  const h = await boot()
  try {
    const entries = h.controller.commands.entries().filter(entry => ["stack", "stack.move", "merge", "background.retry", "background.dismiss", "github"].includes(nameOf(entry)))
    expect(entries.map(nameOf).sort()).toEqual(["background.dismiss", "background.retry", "github", "merge", "stack", "stack.move"])
    expect(Object.fromEntries(entries.map(entry => [nameOf(entry), modelInvocable(entry)]))).toEqual({
      "stack": true, "stack.move": true, "merge": false, "background.retry": true, "background.dismiss": true, "github": true
    })
  } finally { h.controller.dispose() }
})

test("Move up and Move down reorder the stack by ref, through the slash line and the row's button", async () => {
  const h = await boot()
  try {
    expect(stack(h)).toEqual(["t-stripe", "t-retry", "t-checkout", "t-log"])
    expect(await slash(h, "stack.move", "T11 up")).toEqual({ status: "executed", value: "Moved T11 up" })
    expect(stack(h)).toEqual(["t-stripe", "t-retry", "t-log", "t-checkout"])
    expect((await button(h, "stack.move", { n: 11, direction: "down" })).status).toBe("executed")
    expect(stack(h)).toEqual(["t-stripe", "t-retry", "t-checkout", "t-log"])
    expect(await slash(h, "stack.move", "T8 up")).toMatchObject({ status: "failed" })
    expect(await slash(h, "stack.move", "T99 up")).toMatchObject({ status: "failed", error: expect.stringContaining("No TODO T99") })
    expect(stack(h)).toEqual(["t-stripe", "t-retry", "t-checkout", "t-log"])
  } finally { h.controller.dispose() }
})

test("a bare Merge opens Review & merge; the reviewed head merges; one not in review is refused", async () => {
  const h = await boot()
  try {
    expect(await slash(h, "merge", "T10")).toMatchObject({ status: "failed", error: expect.stringContaining("Not in review yet") })
    expect(await slash(h, "merge", "T9")).toMatchObject({ status: "failed", error: expect.stringContaining("Needs you") })
    expect((await slash(h, "merge", "T8")).status).toBe("executed")
    expect(h.store.collections.cards.get("design:confirm:merge:t-stripe")).toMatchObject({ kind: "confirm", payload: { id: "merge:t-stripe" } })
    expect(h.controller.design.world().todos.find(each => each.id === "t-stripe")?.state).toBe("in-review")
    expect(await button(h, "merge", { n: 8, reviewed_head_sha: "stale" })).toMatchObject({ status: "failed", error: expect.stringContaining("changed since you reviewed") })
    // The Review & merge card binds the revision it shows (the seed's evidence rev).
    expect(await button(h, "merge", { n: 8, reviewed_head_sha: "3f9a2c1" })).toEqual({ status: "executed", value: "Merged #88" })
    const world = h.controller.design.world()
    expect(world.todos.find(each => each.id === "t-stripe")?.state).toBe("merged")
    expect(world.repo.mainHead).toEqual({ text: "#88 merged" })
    expect(await slash(h, "merge", "T8")).toMatchObject({ status: "failed", error: expect.stringContaining("already merged") })
  } finally { h.controller.dispose() }
})

test("a failed background run's Retry runs it again and Dismiss removes it for everyone", async () => {
  const h = await boot()
  try {
    const run = () => h.controller.design.world().runs.find(each => each.id === "r-release")
    expect(run()).toMatchObject({ state: "failed", detail: "GitHub API rate limited" })
    expect(await slash(h, "background.retry", "r-release")).toEqual({ status: "executed", value: "Retrying" })
    expect(run()?.state).toBe("running")
    expect((await button(h, "background.dismiss", { id: "r-release" })).status).toBe("executed")
    expect(run()).toBeUndefined()
    expect(await slash(h, "background.retry", "r-release")).toMatchObject({ status: "failed", error: expect.stringContaining("No such run") })
    expect(await slash(h, "background.dismiss", "nope")).toMatchObject({ status: "failed", error: expect.stringContaining("No such run") })
  } finally { h.controller.dispose() }
})

test("main's sync Retry syncs now and clears a refused or limited health", async () => {
  const h = await boot()
  try {
    h.controller.design.patch("repo", "repo", current => ({ ...current, syncedAgo: 400, mainHealth: { state: "limited", cause: "GitHub rate limit", retryAt: "2026-10-03T12:30:00.000Z" } }))
    expect(await slash(h, "github")).toEqual({ status: "executed", value: "Synced" })
    expect(h.controller.design.world().repo.syncedAgo).toBe(3)
    expect(h.controller.design.world().repo.mainHealth).toBeUndefined()
  } finally { h.controller.dispose() }
})

test("/stack returns the member to main, where the Home card stands first", async () => {
  const h = await boot()
  try {
    expect((await slash(h, "branch", "retry-webhooks")).status).toBe("executed")
    const at = () => shellViewsOf(h.controller.design).get("maya")?.at
    expect(at()).toBe("b-retry")
    expect(await slash(h, "stack")).toEqual({ status: "executed", value: "Opened the stack" })
    expect(at()).toBe("main")
  } finally { h.controller.dispose() }
})
