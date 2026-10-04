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
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"

const boot = async (options: { readonly bootstrap?: AppBootstrap; readonly fetch?: (url: string, init?: RequestInit) => Response | undefined } = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: string[] = []
  const profile = signupProfileFetch(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    requests.push(`${init?.method ?? "GET"} ${new URL(url, "http://local.test").pathname}`)
    return options.fetch?.(url, init) ?? new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}) })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  return { store, controller, requests }
}
type Harness = Awaited<ReturnType<typeof boot>>
const slash = (h: Harness, name: string, args?: string) => h.controller.runCommandForResult(name, args)
const button = (h: Harness, name: string, payload: Record<string, unknown>) => h.controller.submitCommand({ name, payload, actor: "user" })
const stack = (h: Harness) => h.controller.design.world().repo.stack

test("the Home doors register, and every one has an agent door (a merge only ever opens the person's card)", async () => {
  const h = await boot()
  try {
    const entries = h.controller.commands.entries().filter(entry => ["stack", "stack.move", "merge", "background.retry", "background.dismiss", "github", "github.retry"].includes(nameOf(entry)))
    expect(entries.map(nameOf).sort()).toEqual(["background.dismiss", "background.retry", "github", "github.retry", "merge", "stack", "stack.move"])
    expect(Object.fromEntries(entries.map(entry => [nameOf(entry), modelInvocable(entry)]))).toEqual({
      "stack": true, "stack.move": true, "merge": true, "background.retry": true, "background.dismiss": true, "github": true, "github.retry": true
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

test("the agent's Merge opens the person's Review & merge and never merges; a head-bound one asks the person first", async () => {
  const h = await boot()
  try {
    const state = () => h.controller.design.world().todos.find(each => each.id === "t-stripe")?.state
    expect(await h.controller.commands.runForAgent("merge", "T8")).toEqual({ status: "executed", value: expect.any(String) })
    expect(h.store.collections.cards.get("design:confirm:merge:t-stripe")).toMatchObject({ kind: "confirm", title: "Merge T8 into main?", payload: { id: "merge:t-stripe" } })
    expect(state()).toBe("in-review")
    // The agent naming the reviewed head still merges nothing: the person is asked, and their press is a bare /merge T8.
    const asked = await h.controller.commands.runForAgent("merge", '{"n":8,"reviewed_head_sha":"3f9a2c1"}')
    expect(asked).toMatchObject({ status: "executed", value: expect.stringContaining('asked the user to confirm "/merge T8"') })
    expect(state()).toBe("in-review")
    const confirmation = [...h.store.collections.messages.values()].find(message => message.action?.flow === "merge")
    expect(confirmation?.action).toMatchObject({ flow: "merge", args: "T8", label: "Confirm: Review & merge" })
    // Refusals keep the seed's words through the agent door too.
    expect(await h.controller.commands.runForAgent("merge", "T9")).toMatchObject({ status: "failed", error: expect.stringContaining("Needs you") })
    expect(await h.controller.commands.runForAgent("merge", "T99")).toMatchObject({ status: "failed", error: expect.stringContaining("No TODO T99") })
    // Only the person's press bound to the reviewed head merges.
    expect(await button(h, "merge", { n: 8, reviewed_head_sha: "3f9a2c1" })).toEqual({ status: "executed", value: "Merged #88" })
    expect(state()).toBe("merged")
  } finally { h.controller.dispose() }
})

test("a member's bare Merge is refused before any card opens", async () => {
  const h = await boot()
  try {
    h.controller.design.patch("members", "maya", current => ({ ...current, role: "member" }))
    expect(await slash(h, "merge", "T8")).toMatchObject({ status: "failed", error: expect.stringContaining("A maintainer merges") })
    expect(h.store.collections.cards.get("design:confirm:merge:t-stripe")).toBeUndefined()
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
    const before = h.controller.design.world().repo
    expect(await slash(h, "github")).toEqual({ status: "executed", value: "Opened the stack" })
    expect(h.controller.design.world().repo).toEqual(before)
    expect(await button(h, "github.retry", {})).toEqual({ status: "executed", value: "Synced" })
    expect(h.controller.design.world().repo.syncedAgo).toBe(3)
    expect(h.controller.design.world().repo.mainHealth).toBeUndefined()
  } finally { h.controller.dispose() }
})

test("on a host that serves GitHub sync, Retry calls that door (github.reconcile) and leaves the seed alone", async () => {
  const bootstrap: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["identity", "cloud"], authFlow: "redirect", sandbox: null }
  const h = await boot({ bootstrap, fetch: (url, init) => url.endsWith("/github/reconcile") && init?.method === "POST"
    ? Response.json({ id: 91, state: "queued", behind_refs: 0, failed_refs: 0, refs: [] }, { status: 202 }) : undefined })
  try {
    await h.store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "maya", expiresAt: null, scopes: null }).isPersisted.promise
    await h.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "acme/api", org: "acme", name: "api", ownerKind: "org", head: null }] }).isPersisted.promise
    await h.store.dispatch({ type: "repo.selected", actor: "user", id: "acme/api" }).isPersisted.promise
    h.controller.design.patch("repo", "repo", current => ({ ...current, syncedAgo: 400, mainHealth: { state: "limited", cause: "GitHub rate limit" } }))
    await h.controller.runCommandForResult("github.retry")
    expect(h.requests).toContain("POST /api/repos/acme/api/github/reconcile")
    expect(h.controller.design.world().repo).toMatchObject({ syncedAgo: 400, mainHealth: { state: "limited", cause: "GitHub rate limit" } })
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
