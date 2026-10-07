/*
 * The Branch and Terminal flows through the production command dispatcher:
 * `/branch`, Rebase now, New terminal, Enter in a terminal, Watch, `/ssh`,
 * Fork and Add to stack act on the seeded design world and open their cards.
 */
import { expect, test, spyOn } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch, unavailableAgent } from "../../state/TestFixtures"
import { todoOf } from "../../state/seams/DesignWorld"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"

const boot = async (live?: import("../../state/useTopic").LiveTopics, bootstrap?: AppBootstrap | boolean) => {
  if (bootstrap === true) bootstrap = { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null }
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const profile = signupProfileFetch(async () => new Response("{}", { status: 404 }))
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, ...(live ? { live } : {}), ...(bootstrap ? { bootstrap } : {}) })
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

test("a bootstrapped demo with a live channel opens branches through button, slash and agent doors", async () => {
  const h = await boot({ subscribe: () => () => {}, getSnapshot: () => undefined }, {
    apiVersion: 1, host: "local", version: "design", buildSha: "0".repeat(40), capabilities: [], authFlow: "none", sandbox: null
  })
  try {
    expect((await submit(h, "branch", { name: "fix-checkout-race" })).status).toBe("executed")
    expect(h.store.collections.cards.get("branch:b-checkout")).toMatchObject({ kind: "branch", title: "fix-checkout-race", payload: { id: "b-checkout" } })
    expect((await h.controller.runCommandForResult("branch", "T9")).status).toBe("executed")
    expect(h.store.collections.cards.get("branch:b-retry")?.kind).toBe("branch")
    expect(await h.controller.commands.runAsAgent("branch", "b-stripe")).toMatchObject({ status: "executed", value: "Opened upgrade-stripe" })
    expect(h.store.collections.cards.get("branch:b-stripe")?.kind).toBe("branch")
  } finally { await h.controller.dispose() }
})

test("an install cannot open a seeded branch even without a live channel", async () => {
  const h = await boot(undefined, { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null })
  try {
    expect(await submit(h, "branch", { name: "fix-checkout-race" })).toMatchObject({ status: "failed", error: "Branch unavailable" })
    expect(h.store.collections.cards.get("branch:b-checkout")).toBeUndefined()
  } finally { await h.controller.dispose() }
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
    expect((await submit(h, "terminal", { operation: "command", id: terminal.id, command: "pnpm test" })).status).toBe("executed")
    expect(h.controller.design.world().terminals.find(each => each.id === terminal.id)!.lines).toEqual([
      { text: "maya@retry-webhooks $ pnpm test", tone: "prompt" }, { text: "✓ 42 passed", tone: "ok" }
    ])
    const before = h.controller.design.world().terminals.find(each => each.id === "term-retry-1")!.lines
    expect((await submit(h, "terminal", { operation: "command", id: "term-retry-1", command: "ls" })).status).toBe("failed")
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
    expect((await submit(h, "branch.fork", { from: "T9" })).status).toBe("executed")
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
    await submit(h, "branch.fork", { from: "T9" })
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

test("install live dispatcher refuses absent Branch and Terminal providers before seed or cloud effects", async () => {
  const h = await boot({ subscribe: () => () => {}, getSnapshot: () => undefined }, true)
  const before = h.controller.design.world()
  try {
    for (const [name, payload, error] of [
      ["terminal", { branch: "b-retry" }, "Terminal unavailable"],
      ["terminal.watch", { id: "term-retry-1" }, "Terminal unavailable"],
      ["terminal", { operation: "command", id: "term-retry-1", command: "bad" }, "Terminal unavailable"],
      ["branch", { name: "retry-webhooks" }, "Branch unavailable"],
      ["branch.rebase", { branch: "b-retry" }, "Branch unavailable"]
    ] as const) {
      expect(await submit(h, name, payload)).toMatchObject({ status: "failed", error })
    }
    expect(h.controller.design.world()).toEqual(before)
  } finally { h.controller.dispose() }
})



test("bootstrap and an unanswered live channel keep seeded Home branch doors available off an install", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const profile = signupProfileFetch(async () => new Response("{}", { status: 404 }))
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: [], authFlow: "redirect", sandbox: null },
    live: { subscribe: () => () => {}, getSnapshot: () => undefined } })
  try {
    expect(await controller.submitCommand({ name: "branch", payload: { name: "T9" }, actor: "user" })).toMatchObject({ status: "executed" })
    expect(store.collections.cards.get("branch:b-retry")).toMatchObject({ kind: "branch", title: "retry-webhooks" })
    expect(await controller.submitCommand({ name: "branch.fork", payload: { from: "T10" }, actor: "user" })).toMatchObject({ status: "executed" })
    const scratch = controller.design.world().branches.find(branch => branch.from === "b-checkout" && branch.item === undefined)!
    expect(scratch).toBeDefined()
    expect(await controller.submitCommand({ name: "branch.add-to-stack", payload: { branch: scratch.id }, actor: "user" })).toMatchObject({ status: "executed" })
    const world = controller.design.world()
    const placed = world.branches.find(branch => branch.id === scratch.id)!
    expect(todoOf(world, placed.item!)?.ref).toBe("T12")
  } finally { await controller.dispose() }
})

test("On an install Fork requests POST /api/branches {from, name} in the background", async () => {
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
    if (path.startsWith("/api/branches/") && init?.method !== "POST") return Response.json({ state: "asleep" })
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  try {
    expect(await controller.submitCommand({ name: "branch.fork", payload: { from: "T2", name: "try-retry" }, actor: "user" })).toEqual({ status: "executed", value: "Requested" })
    expect(await controller.runCommandForResult("branch.fork", "T2")).toMatchObject({ status: "executed", value: "Requested" })
    expect((await controller.submitCommand({ name: "branch.fork", payload: { from: "T9" }, actor: "user" })).status).toBe("executed")
    for (let i = 0; i < 100 && store.session().branchRequests?.some(row => row.state === "requested" || row.state === "provisioning"); i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.session().branchRequests?.find(row => row.input.from === "T9")?.error).toBe("T9 has no verified head to fork yet")
    // A name is never a substitute for the required source; no HTTP mutation.
    expect(await controller.submitCommand({ name: "branch.fork", payload: { name: "T2" }, actor: "user" })).toMatchObject({ status: "form", fields: ["from"] })
    expect(posts.map(post => post.body)).toEqual([{ from: "T2", name: "try-retry" }, { from: "T2" }, { from: "T9" }])
    expect(posts.every(post => post.key !== null && post.key.length > 0)).toBe(true)
    // The seeded world is off on an install: nothing forked there.
    expect(controller.design.world().branches.some(each => each.name.startsWith("scratch/ben/"))).toBe(false)
  } finally { await controller.dispose() }
})

test("non-install bootstrap keeps design terminals while installs require a known repository", async () => {
  for (const install of [false, true]) {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const profile = signupProfileFetch(async () => new Response("{}", { status: 404 }))
    const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
      live: { subscribe: () => () => {}, getSnapshot: () => undefined },
      bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: install ? ["install"] : [], authFlow: "none", sandbox: null } })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
    try {
      const opened = await controller.submitCommand({ name: "terminal", payload: { branch: "b-retry" }, actor: "user" })
      if (install) {
        expect(opened).toMatchObject({ status: "failed", error: "Terminal unavailable" })
        expect(controller.design.world().terminals).toEqual([])
      } else {
        expect(opened.status).toBe("executed")
        const terminal = controller.design.world().terminals.find(each => each.owner === "maya")!
        expect(store.collections.cards.get(`terminal:${terminal.id}`)?.kind).toBe("terminal")
        expect((await controller.submitCommand({ name: "terminal", payload: { operation: "command", id: terminal.id, command: "pnpm test" }, actor: "user" })).status).toBe("executed")
        expect(controller.design.world().terminals.find(each => each.id === terminal.id)!.lines.at(-1)?.text).toBe("✓ 42 passed")
        expect((await controller.submitCommand({ name: "terminal.watch", payload: { id: "term-retry-1" }, actor: "user" })).status).toBe("executed")
      }
    } finally { controller.dispose() }
  }
})

test("install Watch reaches the terminal card only for authenticated registered branch metadata", async () => {
  const { LiveChannel } = await import("../../runtime/LiveChannel")
  const frames: { t: string; id: number; topic?: string }[] = []
  const socket = { readyState: 1, onopen: null, onclose: null, onmessage: null,
    send: (frame: string | Uint8Array) => { if (typeof frame === "string") frames.push(JSON.parse(frame)) }, close: () => {} } as import("../../runtime/LiveChannel").LiveSocket
  const live = new LiveChannel({ socket: () => socket })
  const h = await boot(live, true)
  const release = live.subscribe("branch:b1", () => {})
  try {
    await h.controller.presentBranchCard("branch", "b1", "Retry")
    socket.onopen?.()
    const subscription = frames.find(frame => frame.topic === "branch:b1")!
    socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: subscription.id, cursor: 1, data: {
      terminals: [{ id: "t-ben", title: "Ben's shell", owner: { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 }, agents: [], watchers: [], frozen: false }]
    } }) })
    expect(h.controller.terminalCards?.branch("t-ben")).toBe("b1")
    expect((await submit(h, "terminal.watch", { id: "t-ben" })).status).toBe("executed")
    expect(h.store.collections.cards.get("terminal:t-ben")).toMatchObject({ kind: "terminal", payload: { id: "t-ben" } })
    expect((await submit(h, "terminal.watch", { id: "missing" })).status).toBe("failed")
    await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    expect(h.controller.terminalCards?.available()).toBe(false)
    expect(h.controller.terminalCards?.branch("t-ben")).toBeUndefined()
    expect((await submit(h, "terminal.watch", { id: "t-ben" })).status).toBe("failed")
  } finally { release(); h.controller.dispose(); live.dispose() }
})

test("an agent's Discard asks the person with the exact wait/head and changes nothing", async () => {
  const h = await boot()
  try {
    const before = structuredClone(h.controller.design.world())
    const input = { branch: "smithers/retry-webhooks", id: "foreign-1", revision: "a".repeat(40) }
    expect(await h.controller.commands.runForAgent("branch.discard-foreign", JSON.stringify(input))).toMatchObject({
      status: "executed", value: expect.stringContaining("asked the user to confirm")
    })
    const asks = [...h.store.collections.messages.values()].filter(each => each.action?.flow === "branch.discard-foreign")
    expect(asks).toHaveLength(1)
    expect(JSON.parse(asks[0]!.action!.args!)).toEqual(input)
    expect(h.controller.design.world()).toEqual(before)
    expect([...h.store.collections.cards.values()].filter(each => each.kind === "todo" && each.payload.requests.length > 0)).toEqual([])
  } finally { h.controller.dispose() }
})

test("install SSH reads the authorized live branch without waking it or using the seed", async () => {
  let snapshot: import("../../runtime/LiveChannel").TopicSnapshot | undefined
  const live = { subscribe: () => () => {}, getSnapshot: (topic: string) => topic === "branch:b-real" ? snapshot : undefined }
  const h = await boot(live, true)
  try {
    expect((await submit(h, "ssh", { branch: "b-real" })).status).toBe("failed")
    snapshot = { topic: "branch:b-real", cursor: 1, data: { id: "b-real", ssh_line: "ssh -p 2222 scratch/ben/retry@factory.example", machine: { state: "asleep" } } }
    expect(await submit(h, "ssh", { branch: "b-real" })).toEqual({ status: "executed", value: "ssh -p 2222 scratch/ben/retry@factory.example" })
    snapshot = { ...snapshot, error: "forbidden" }
    expect((await submit(h, "ssh", { branch: "b-real" })).status).toBe("failed")
    expect((await submit(h, "ssh", { branch: "retry-webhooks" })).status).toBe("failed")
  } finally { h.controller.dispose() }
})

test("an unanswered live SSH provider keeps the off-install seed available", async () => {
  const h = await boot({ subscribe: () => () => {}, getSnapshot: () => undefined })
  try {
    expect(await submit(h, "ssh", { branch: "retry-webhooks" })).toEqual({ status: "executed", value: "ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net" })
  } finally { h.controller.dispose() }
})


test("the installed terminal flow acknowledges unresolved launch through button, slash and agent doors", async () => {
 const store = await createAppStore({kind:"localStorage",storage:memoryStorage()})
 const launch=Promise.withResolvers<Response>();let posts=0
 const profile=signupProfileFetch(async(input,init)=>{
  if(String(input).endsWith("/api/terminals")&&init?.method==="POST"){posts++;return launch.promise}
  return new Response("{}",{status:404})
 })
 const controller=createAppController(store,unavailableAgent,{fetchImpl:profile.fetchImpl,bootstrap:{apiVersion:1,host:"local",version:"test",buildSha:"test",capabilities:["install"],authFlow:"none",sandbox:null}})
 await store.dispatch({type:"identity.session.loaded",actor:"system",state:"signed-in",login:"maya",admin:false,scopesPlain:null}).isPersisted.promise
 await store.dispatch({type:"repository.entry.changed",actor:"system",entry:{requestId:"install-repository",repo:"maya/app",phase:"pending"}}).isPersisted.promise
 try {
  expect(await controller.submitCommand({name:"terminal",payload:{branch:"scratch/maya/work"},actor:"user"})).toMatchObject({status:"executed",value:"Requested"})
  expect(await controller.runCommandForResult("terminal","scratch/maya/work")).toMatchObject({status:"executed",value:"Requested"})
  expect(await controller.commands.runAsAgent("terminal","scratch/maya/work")).toMatchObject({status:"executed",value:"Requested"})
  for(let i=0;i<100&&posts===0;i++)await new Promise(resolve=>setTimeout(resolve,10))
  expect(posts).toBe(1);expect(store.session().terminalRequests).toHaveLength(1)
  controller.changeDraft("Chat remains usable")
  await store.settled?.()
  expect(store.session().draft).toBe("Chat remains usable")
  expect(store.session().phase).toBe("idle")
  expect(controller.design.world().terminals).toEqual([])
  expect([...store.collections.cards.values()].some(card=>card.kind==="terminal")).toBe(false)
 } finally {launch.resolve(new Response("{}",{status:503}));await controller.dispose()}
})

test("install Add dispatches its placement and text once through the real HTTP adapter", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const posts: Array<{ path: string; body: unknown; key: string | null }> = []
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://install.test").pathname
    if (path.endsWith("/add-to-stack") && init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") })
      return Response.json({ state: "accepted", n: 12, rev: 1 }, { status: 202 })
    }
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  try {
    for (const placement of [{ after: 2 }, { before: 3 }, {}]) {
      expect(await controller.submitCommand({ name: "branch.add-to-stack", payload: { branch: "scratch/ben/retry", text: "Keep retry", ...placement }, actor: "user" })).toMatchObject({ status: "executed", value: "Requested" })
    }
    expect(posts.map(post => post.body)).toEqual([{ text: "Keep retry", after: 2 }, { text: "Keep retry", before: 3 }, { text: "Keep retry" }])
    expect(posts.every(post => post.path === "/api/branches/scratch%2Fben%2Fretry/add-to-stack" && !!post.key)).toBe(true)
    expect(await controller.submitCommand({ name: "branch.add-to-stack", payload: { branch: "scratch/ben/retry", after: 2, before: 3 }, actor: "user" })).toMatchObject({ status: "failed" })
    expect(posts).toHaveLength(3)
    expect(controller.design.world().repo.stack).not.toContain("T12")
  } finally { await controller.dispose() }
})

test("Archive persists and acknowledges before HTTP; duplicate input and Chat stay usable", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let posts = 0
  let release!: (response: Response) => void
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://install.test").pathname
    if (path === "/api/branches/scratch-id/archive" && init?.method === "POST") {
      posts++
      expect(store.session().branchArchiveRequests?.[0]?.state).toBe("requested")
      expect(new Headers(init.headers).get("Idempotency-Key")).toBeTruthy()
      return new Promise<Response>(resolve => { release = resolve })
    }
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, toastDebounceMs: 0,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  try {
    expect(await controller.submitCommand({ name: "branch.archive", payload: { branch: "scratch-id" }, actor: "user" })).toMatchObject({ status: "executed", value: "Archive requested" })
    expect(await controller.runCommandForResult("branch.archive", "scratch-id")).toMatchObject({ status: "executed", value: "Archive requested" })
    controller.changeDraft("Chat remains usable")
    expect(store.session().draft).toBe("Chat remains usable")
    expect(posts).toBe(1)
    release(Response.json({ state: "closed" }))
    const { waitFor } = await import("../../state/TestFixtures")
    await waitFor(() => store.session().branchArchiveRequests?.[0]?.state === "completed")
    expect(store.session().branchArchiveRequests).toHaveLength(1)
    expect(await controller.submitCommand({ name: "branch.archive", payload: { branch: "scratch-id" }, actor: "agent" })).toMatchObject({ status: "executed", value: 'asked the user to confirm "/branch.archive scratch-id" — it runs only when they confirm, and nothing has happened yet' })
    expect(posts).toBe(1)
  } finally { await controller.dispose() }
})

test("install Watch discovers the machine topic from the real branch-list wire shape", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const topics: string[] = []
  let frozen = false
  const live = {
    subscribe: (topic: string) => { topics.push(topic); return () => {} },
    getSnapshot: (topic: string) => topic === "branch:machine-retry" ? { topic, data: {
      id: "machine-retry", ssh_line: "ssh -p 2222 smithers/retry@factory.example",
      terminals: [{ id: "terminal-retry", title: "Shell", owner: { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 }, agents: [], watchers: [], frozen }]
    } } : undefined
  }
  const profile = signupProfileFetch(async input => {
    const path = new URL(String(input), "https://install.test").pathname
    if (path === "/api/todos/2") return Response.json({ branch: { name: "smithers/retry" } })
    if (path === "/api/branches/smithers%2Fretry") return Response.json({ name: "smithers/retry", machine: { id: "machine-retry" } })
    return path === "/api/branches" ? Response.json([{ name: "smithers/retry", kind: "item", state: "asleep", machine: { id: "machine-retry" } }]) : new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, live,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const stop = controller.terminalCards!.subscribe!(() => {})
  try {
    for (let i = 0; i < 100 && !controller.terminalCards?.branch("terminal-retry"); i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(topics).toContain("branch:machine-retry")
    expect(topics).not.toContain("branch:smithers/retry")
    for (const branch of ["T2", "smithers/retry"]) expect(await controller.submitCommand({ name: "ssh", payload: { branch }, actor: "user" })).toEqual({ status: "executed", value: "ssh -p 2222 smithers/retry@factory.example" })
    expect((await controller.submitCommand({ name: "ssh", payload: { branch: "missing" }, actor: "user" })).status).toBe("failed")
    expect(await controller.submitCommand({ name: "terminal.watch", payload: { id: "terminal-retry" }, actor: "user" })).toMatchObject({ status: "executed" })
    expect(store.collections.cards.get("terminal:terminal-retry")).toMatchObject({ kind: "terminal", payload: { id: "terminal-retry" } })
    const bytes: unknown[] = []
    spyOn(controller.cloudTerminal, "input").mockImplementation((id, data) => { bytes.push([id, data]) })
    const payload = { operation: "command", id: "terminal-retry", command: "pwd" }
    expect(await controller.submitCommand({ name: "terminal", payload, actor: "user" })).toMatchObject({ status: "executed" })
    expect(bytes).toEqual([["terminal-retry", "pwd\r"]])
    expect(await controller.submitCommand({ name: "terminal", payload, actor: "agent" })).toMatchObject({ status: "failed", error: "Terminal input is person-only" })
    frozen = true
    expect(await controller.submitCommand({ name: "terminal", payload, actor: "user" })).toMatchObject({ status: "failed", error: "Terminal is read-only" })
    frozen = false
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", admin: false, scopesPlain: null }).isPersisted.promise
    expect((await controller.submitCommand({ name: "terminal", payload, actor: "user" })).status).toBe("failed")
    expect(bytes).toHaveLength(1)

  } finally { stop(); controller.dispose() }
})


test("SSH clipboard completion waits for the copy and reports its failure", async () => {
  const { branchFlows } = await import("./branch")
  const { FlowGesture } = await import("../CommandGesture")
  const { Effect, Option } = await import("effect")
  const Cell = await import("@smthrs/harness/Cell")
  const h = await boot({ subscribe: () => () => {}, getSnapshot: topic => ({ topic, data: { id: "b-real", ssh_line: "ssh -p 2222 retry@localhost" } }) }, true)
  const { nameOf } = await import("../registry")
  const entry = branchFlows({ ...h.controller, snapshot: () => { throw new Error("SSH does not read command snapshots") } }).find(entry => nameOf(entry) === "ssh")!
  const call = new Cell.Call({ flowName: "ssh", input: { branch: "b-real" }, capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(), identity: new Cell.CallIdentity({ session: "ssh-copy", frame: 0, cell: "copy", ordinal: 0, declaration: "ssh", layers: [] }) })
  let complete!: () => void
  const pending = new Promise<void>(resolve => { complete = resolve })
  const copied: string[] = []
  let settled = false
  try {
    const result = Effect.runPromise(entry.binding.run(call).pipe(Effect.provideService(FlowGesture, {
      name: "ssh", release: () => {}, copyText: async text => { copied.push(text); await pending }
    }))).then(value => { settled = true; return value })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    expect(copied).toEqual(["ssh -p 2222 retry@localhost"])
    complete()
    expect(await result).toMatchObject({ outcome: "success", value: { value: "ssh -p 2222 retry@localhost" } })
    expect(await Effect.runPromise(entry.binding.run(call).pipe(Effect.provideService(FlowGesture, {
      name: "ssh", release: () => {}, copyText: async () => { throw new Error("denied") }
    })))).toMatchObject({ outcome: "failure", message: "Flow ssh failed: Copy failed" })
  } finally { complete(); h.controller.dispose() }
})


test("standalone install SSH owns a read subscription and releases it on success, refusal, identity change and disposal", async () => {
  for (const outcome of ["success", "forbidden", "malformed", "identity", "dispose"] as const) {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let snapshot: import("../../runtime/LiveChannel").TopicSnapshot | undefined
    let notify = () => {}
    let subscribed = 0, released = 0
    const profile = signupProfileFetch(async input => new URL(String(input), "https://install.test").pathname === "/api/branches/scratch%2Fben%2Fretry"
      ? Response.json({ name: "scratch/ben/retry", machine: { id: "b-ssh" } }) : new Response("{}", { status: 404 }))
    const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
      live: { subscribe: (topic, listener) => { if (topic === "branch:b-ssh") { subscribed++; notify = listener; return () => { released++ } } return () => {} }, getSnapshot: topic => topic === "branch:b-ssh" ? snapshot : undefined },
      bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    try {
      let settled = false
      const request = controller.submitCommand({ name: "ssh", payload: { branch: "scratch/ben/retry" }, actor: "user" }).then(value => { settled = true; return value })
      for (let i = 0; i < 100 && subscribed === 0; i++) await new Promise(resolve => setTimeout(resolve, 1))
      expect(subscribed).toBe(1)
      expect(settled).toBe(false)
      expect(store.collections.cards.get("branch:b-ssh")).toBeUndefined()
      if (outcome === "identity") await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
      else if (outcome === "dispose") controller.dispose()
      else {
        snapshot = outcome === "forbidden" ? { topic: "branch:b-ssh", error: "forbidden" }
          : { topic: "branch:b-ssh", data: { id: outcome === "malformed" ? "another-branch" : "b-ssh", ssh_line: "ssh -p 2222 scratch/ben/retry@localhost" } }
        notify()
      }
      expect(await request).toMatchObject(outcome === "success" ? { status: "executed", value: "ssh -p 2222 scratch/ben/retry@localhost" } : { status: "failed" })
      expect(released).toBe(1)
    } finally { controller.dispose() }
  }
})
