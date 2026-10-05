/*
 * The Branch and Terminal flows through the production command dispatcher:
 * `/branch`, Rebase now, New terminal, Enter in a terminal, Watch, `/ssh`,
 * Fork and Add to stack act on the seeded design world and open their cards.
 */
import { expect, test } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch, unavailableAgent } from "../../state/TestFixtures"
import { todoOf } from "../../state/seams/DesignWorld"

const boot = async (live?: import("../../state/useTopic").LiveTopics) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const profile = signupProfileFetch(async () => new Response("{}", { status: 404 }))
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, ...(live ? { live } : {}) })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  return { store, controller }
}
const submit = (h: Awaited<ReturnType<typeof boot>>, name: string, payload: Record<string, unknown>) =>
  h.controller.submitCommand({ name, payload, actor: "user" })

test("/branch opens the branch card by name and by its item's ref", async () => {
  const h = await boot()
  try {
    expect((await h.controller.runCommandForResult("branch", "retry-webhooks")).status).toBe("executed")
    expect(h.store.collections.cards.get("branch:b-retry")).toMatchObject({ kind: "branch", title: "retry-webhooks", payload: { id: "b-retry" } })
    await h.controller.runCommandForResult("branch", "T10")
    expect(h.store.collections.cards.get("branch:b-checkout")).toMatchObject({ kind: "branch", payload: { id: "b-checkout" } })
  } finally { h.controller.dispose() }
})

test("Rebase now clears the pending rebase and records who asked", async () => {
  const h = await boot()
  try {
    h.controller.design.setBranch("b-checkout", { rebasePending: "main" })
    expect((await submit(h, "branch.rebase", { branch: "b-checkout" })).status).toBe("executed")
    const branch = h.controller.design.world().branches.find(each => each.id === "b-checkout")!
    expect(branch.rebasePending).toBeUndefined()
    expect(branch.activity.at(-1)).toMatchObject({ kind: "step", text: "Rebased onto main", asked: "maya" })
    expect((await submit(h, "branch.rebase", { branch: "nope" })).status).toBe("failed")
  } finally { h.controller.dispose() }
})

test("New terminal opens the member's own terminal; Enter runs there and nowhere else", async () => {
  const h = await boot()
  try {
    expect((await submit(h, "terminal", { branch: "b-retry" })).status).toBe("executed")
    const terminal = h.controller.design.world().terminals.find(each => each.owner === "maya")!
    expect(terminal).toMatchObject({ branch: "b-retry", lines: [], watchers: [] })
    expect(h.store.collections.cards.get(`terminal:${terminal.id}`)).toMatchObject({ kind: "terminal", title: terminal.title, payload: { id: terminal.id } })
    expect((await submit(h, "terminal.send", { id: terminal.id, command: "pnpm test" })).status).toBe("executed")
    expect(h.controller.design.world().terminals.find(each => each.id === terminal.id)!.lines).toEqual([
      { text: "maya@retry-webhooks $ pnpm test", tone: "prompt" }, { text: "✓ 42 passed", tone: "ok" }
    ])
    const before = h.controller.design.world().terminals.find(each => each.id === "term-retry-1")!.lines
    expect((await submit(h, "terminal.send", { id: "term-retry-1", command: "ls" })).status).toBe("failed")
    expect(h.controller.design.world().terminals.find(each => each.id === "term-retry-1")!.lines).toEqual(before)
  } finally { h.controller.dispose() }
})

test("Watch adds the viewer to someone's terminal and opens its card", async () => {
  const h = await boot()
  try {
    expect((await submit(h, "terminal.watch", { id: "term-retry-1" })).status).toBe("executed")
    expect(h.controller.design.world().terminals.find(each => each.id === "term-retry-1")!.watchers).toContain("maya")
    expect(h.store.collections.cards.get("terminal:term-retry-1")).toMatchObject({ kind: "terminal", title: "terminal 1" })
    expect((await submit(h, "terminal.watch", { id: "term-missing" })).status).toBe("failed")
  } finally { h.controller.dispose() }
})

test("/ssh hands back the branch's SSH line", async () => {
  const h = await boot()
  try {
    expect(await h.controller.runCommandForResult("ssh", "retry-webhooks")).toEqual({ status: "executed", value: "ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net" })
    expect((await h.controller.runCommandForResult("ssh", "nope")).status).toBe("failed")
  } finally { h.controller.dispose() }
})

test("Fork opens a scratch branch; Add to stack places it after the item it came from", async () => {
  const h = await boot()
  try {
    expect((await submit(h, "branch.fork", { name: "retry-webhooks" })).status).toBe("executed")
    const fork = h.controller.design.world().branches.find(each => each.name === "maya/retry-webhooks")!
    expect(fork.from).toBe("b-retry")
    expect(fork.item).toBeUndefined()
    expect(h.store.collections.cards.get(`branch:${fork.id}`)).toMatchObject({ kind: "branch", title: "maya/retry-webhooks" })
    expect((await submit(h, "branch.add-to-stack", { branch: fork.id })).status).toBe("executed")
    const world = h.controller.design.world()
    const placed = world.branches.find(each => each.id === fork.id)!
    expect(placed.item).toBeDefined()
    expect(todoOf(world, placed.item!)).toMatchObject({ title: "retry-webhooks", owner: "maya", branch: fork.id })
    expect(world.repo.stack.indexOf(placed.item!)).toBe(world.repo.stack.indexOf("t-retry") + 1)
    expect((await submit(h, "branch.add-to-stack", { branch: "b-retry" })).status).toBe("failed")
  } finally { h.controller.dispose() }
})

test("A✓: the agent's Add to stack asks for the person's press and commits nothing; the press commits it", async () => {
  const h = await boot()
  try {
    await submit(h, "branch.fork", { name: "retry-webhooks" })
    const fork = h.controller.design.world().branches.find(each => each.name === "maya/retry-webhooks")!
    const item = () => h.controller.design.world().branches.find(each => each.id === fork.id)?.item
    expect(await h.controller.commands.runForAgent("branch.add-to-stack", fork.id)).toMatchObject({ status: "executed", value: expect.stringContaining("asked the user to confirm") })
    expect((await h.controller.commands.submit({ name: "branch.add-to-stack", payload: { branch: fork.id }, actor: "agent" })).status).toBe("executed")
    expect(item()).toBeUndefined()
    const asks = [...h.store.collections.messages.values()].filter(each => each.action?.flow === "branch.add-to-stack")
    expect(asks.map(each => each.action?.args)).toEqual([fork.id, fork.id])
    expect((await h.controller.runCommandForResult("branch.add-to-stack", asks[0]!.action!.args)).status).toBe("executed")
    expect(item()).toBeDefined()
  } finally { h.controller.dispose() }
})

test("live dispatcher refuses absent Branch and Terminal providers before seed or cloud effects", async () => {
  const h = await boot({ subscribe: () => () => {}, getSnapshot: () => undefined })
  const before = h.controller.design.world()
  try {
    for (const [name, payload, error] of [
      ["terminal", { branch: "b-retry" }, "Terminal unavailable"],
      ["terminal.watch", { id: "term-retry-1" }, "Terminal unavailable"],
      ["terminal.send", { id: "term-retry-1", command: "bad" }, "Terminal unavailable"],
      ["branch", { name: "retry-webhooks" }, "Branch unavailable"],
      ["branch.rebase", { branch: "b-retry" }, "Branch unavailable"],
      ["branch.fork", { name: "b-retry" }, "Branch unavailable"]
    ] as const) {
      expect(await submit(h, name, payload)).toMatchObject({ status: "failed", error })
    }
    expect(h.controller.design.world()).toEqual(before)
  } finally { h.controller.dispose() }
})
