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
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"

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

test("On an install Fork is POST /api/branches {from, name}: the value is the new scratch branch, a refusal is the server message", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const posts: Array<{ body: unknown; key: string | null }> = []
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://install.test").pathname
    if (path === "/api/branches" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { from: string; name?: string }
      posts.push({ body, key: new Headers(init.headers).get("Idempotency-Key") })
      if (body.from === "T9") return Response.json({ code: "no_verified_head", class: "conflict", message: "T9 has no verified head to fork yet" }, { status: 409 })
      return Response.json({ name: `scratch/ben/${body.name ?? `fork-${body.from.toLowerCase()}`}`, kind: "scratch" }, { status: 201 })
    }
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  try {
    expect(await controller.submitCommand({ name: "branch.fork", payload: { from: "T2", name: "try-retry" }, actor: "user" })).toEqual({ status: "executed", value: "scratch/ben/try-retry" })
    expect(await controller.runCommandForResult("branch.fork", "T2")).toMatchObject({ status: "executed", value: "scratch/ben/fork-t2" })
    expect((await controller.submitCommand({ name: "branch.fork", payload: { from: "T9" }, actor: "user" })).status).toBe("failed")
    expect(posts.map(post => post.body)).toEqual([{ from: "T2", name: "try-retry" }, { from: "T2" }, { from: "T9" }])
    expect(posts.every(post => post.key !== null && post.key.length > 0)).toBe(true)
    // The seeded world is off on an install: nothing forked there.
    expect(controller.design.world().branches.some(each => each.name.startsWith("scratch/ben/"))).toBe(false)
  } finally { await controller.dispose() }
})

test("On an install Open branch reads the branch the install serves and opens its card with its commits, files and checks; a refusal is the install's message", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const head = "c".repeat(40), base = "b".repeat(40)
  const avatar = PlaceholderAvatarUrl
  const reads: string[] = []
  // The bodies GET /api/branches/{b}, its /diff and GET /api/todos/{n} serve on an install (docs/api/openapi/branches.yaml).
  const todo = { n: 1, title: "Add greeting", state: "in_review", place: 1, merge: { on_github: false, reason: "state", state: "waiting" },
    owner: { avatar_url: avatar, login: "rehearsal-owner", name: "Rehearsal owner" }, present: [], prompt_revisions: [], steers: [], steps: [], waits: [],
    evidence: [{ attempt: 1, revision: head, items: [{ kind: "check", name: "node --test", state: "passed" }, { kind: "review", summary: "approve" }] }] }
  const profile = signupProfileFetch(async input => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://install.test").pathname
    reads.push(path)
    switch (path) {
      case "/api/branches/smithers%2Fadd-greeting": return Response.json({ name: "smithers/add-greeting", kind: "item", state: "asleep", head,
        item: { n: 1, title: "Add greeting", state: "in_review", place: 1 }, machine: { id: "lane-1", status: "stopped" } })
      case "/api/branches/smithers%2Fadd-greeting/diff": return Response.json({
        files: [{ path: "greet.mjs", branch: "smithers/add-greeting", against: { kind: "item_base", rev: base }, change: "added",
          hunks: [{ old_start: 0, new_start: 1, lines: [{ op: "+", text: "export const greet = () => 'hi'" }] }] }],
        commits: [{ sha: head, subject: "feat: add greet", author: "Smithers", at: "2026-10-05T09:00:00-07:00" }] })
      case "/api/todos/1": return Response.json(todo)
      case "/api/branches/smithers%2Fgone": return Response.json({ code: "not_found", class: "user", message: "branch not found" }, { status: 404 })
    }
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, live: { subscribe: () => () => {}, getSnapshot: () => undefined },
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  try {
    // The TODO card's Open branch sends the branch its card names.
    expect(await controller.submitCommand({ name: "branch", payload: { name: "smithers/add-greeting" }, actor: "user" }))
      .toEqual({ status: "executed", value: "Opened smithers/add-greeting" })
    expect(reads.filter(path => path.startsWith("/api/branches") || path.startsWith("/api/todos")).sort())
      .toEqual(["/api/branches/smithers%2Fadd-greeting", "/api/branches/smithers%2Fadd-greeting/diff", "/api/todos/1"])
    expect(store.collections.cards.get("branch:smithers/add-greeting")).toMatchObject({ kind: "branch", title: "smithers/add-greeting", payload: { id: "smithers/add-greeting" } })
    const model = controller.installBranches!.get("smithers/add-greeting")!.model!
    expect(model).toMatchObject({ id: "smithers/add-greeting", name: "smithers/add-greeting", machine: { state: "asleep" },
      item: { n: 1, title: "Add greeting", state: "in_review", place: 1 }, ssh_line: "", presence: [], terminals: [] })
    expect(model.changed_files).toEqual([{ path: "greet.mjs", change: "added", authors: [] }])
    expect(model.activity.map(entry => [entry.kind, entry.text, entry.items ?? []])).toEqual([["change", "feat: add greet", ["ccccccc"]], ["step", "node --test passed", []]])

    // A branch the install does not serve opens nothing and says why.
    const refused = await controller.submitCommand({ name: "branch", payload: { name: "smithers/gone" }, actor: "user" })
    expect(refused).toMatchObject({ status: "failed", error: "branch not found" })
    expect(store.collections.cards.get("branch:smithers/gone")).toBeUndefined()
    expect([...store.collections.toasts.values()].filter(toast => toast.status === "failed").map(toast => toast.detail)).toEqual(["branch not found"])
    // The seeded world is off on an install: no seeded branch opened.
    expect([...store.collections.cards.keys()].filter(id => id.startsWith("branch:"))).toEqual(["branch:smithers/add-greeting"])
  } finally { await controller.dispose() }
})
