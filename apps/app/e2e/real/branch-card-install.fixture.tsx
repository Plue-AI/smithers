// Invoked by the PostgreSQL composed-install test with its own isolated server.
import assert from "node:assert/strict"
import type { LiveSocket } from "../../src/mainview/runtime/LiveChannel"

const origin = process.env.SMITHERS_BRANCH_CARD_ORIGIN!
const branch = process.env.SMITHERS_BRANCH_CARD_ID!
const movedChoice = process.env.SMITHERS_BRANCH_MOVED_CHOICE
const scratchFork = process.env.SMITHERS_BRANCH_CARD_FORK === "1"
const newTerminal = process.env.SMITHERS_BRANCH_CARD_TERMINAL === "1"
const addToStack = process.env.SMITHERS_BRANCH_CARD_ADD === "1"
assert.ok(origin && branch)
const NativeSocket = WebSocket, nativeFetch = fetch
const nativeHttp = { Request, Response, Headers, AbortController, AbortSignal }
const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
GlobalRegistrator.register({ url: origin })
Object.assign(globalThis, nativeHttp)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { act } = await import("react")
const { createAppController } = await import("../../src/mainview/state/AppController")
const { createAppStore } = await import("../../src/mainview/state/AppStore")
const { memoryStorage, unavailableAgent, applicationIdentityFromFetch } = await import("../../src/mainview/state/TestFixtures")
const { LiveChannel } = await import("../../src/mainview/runtime/LiveChannel")
const { createRoot } = await import("react-dom/client")
const { ControllerTestProvider } = await import("../../src/mainview/ControllerContext")
const { CARD_RENDERERS } = await import("../../src/mainview/cards/CardRenderers")
const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
const requests: Array<{ path: string; method: string; body?: unknown; status: number; key?: string; refusal?: unknown }> = []
const headers = { Cookie: `${process.env.SMITHERS_BRANCH_CARD_COOKIE ?? "smithers_session=sleep-cookie"}; __csrf=branch-card-fixture`, Origin: origin }
let wireState = "not-created"
const live = new LiveChannel({ socket: () => {
  let socket: WebSocket
  try { socket = new NativeSocket(`${origin.replace(/^http/, "ws")}/api/live`, { headers, protocols: ["smithers.live.v1"] } as never) }
  catch (error) { wireState = `constructor failed ${String(error)} ${String(NativeSocket).slice(0, 100)}`; throw error }
  wireState = "created"
  socket.addEventListener("open", () => { wireState = "open" })
  socket.addEventListener("close", event => { wireState = `closed ${event.code} ${event.reason}` })
  socket.addEventListener("error", () => { wireState = "error" })
  return socket as unknown as LiveSocket
} })
const fetchImpl: Parameters<typeof applicationIdentityFromFetch>[0] = async (input, init) => {
    const requestHeaders = new Headers(init?.headers)
    requestHeaders.set("Cookie", headers.Cookie)
    requestHeaders.set("X-CSRF-Token", "branch-card-fixture")
    requestHeaders.set("Origin", origin)
    const url = new URL(input instanceof Request ? input.url : String(input), origin)
    const response = await nativeFetch(url, { ...init, headers: requestHeaders })
    requests.push({ path: url.pathname, method: init?.method ?? "GET", status: response.status, key: requestHeaders.get("Idempotency-Key") ?? undefined, refusal: response.status >= 400 ? await response.clone().json().catch(() => undefined) : undefined,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    return response
  }
const controller = createAppController(store, unavailableAgent, { live, baseUrl: origin, fetchImpl, applicationIdentity: applicationIdentityFromFetch(fetchImpl, origin),
  bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
const submissions: unknown[] = []
const submit = controller.commands.submit
Object.assign(controller.commands, { submit: async (input: Parameters<typeof submit>[0]) => { const result = await submit(input); submissions.push({ input, result }); return result } })
const host = document.createElement("div"), root = createRoot(host)
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 500 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(predicate(), `Timed out: ${host.textContent}; ${JSON.stringify({ submissions, wireState, topic: live.getSnapshot(`branch:${branch}`), activity: live.getSnapshot(`branch:${branch}:activity`), files: live.getSnapshot(`branch:${branch}:files`), requests })}`)
}
const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
try {
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: process.env.SMITHERS_BRANCH_CARD_LOGIN ?? "sleepowner", admin: false, scopesPlain: null }).isPersisted.promise
  const opened = await controller.runCommandForResult("branch", process.env.SMITHERS_BRANCH_CARD_SUBJECT ?? "T1")
  assert.equal(opened.status, "executed", JSON.stringify({ opened, requests }))
  const card = store.collections.cards.get(`branch:${branch}`)!
  assert.equal(card.kind, "branch")
  if (card.kind !== "branch") throw new Error("Expected Branch")
  await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
  if (scratchFork) {
    await waitFor(() => host.querySelector('[data-flow="branch.fork"]') !== null)
    await act(async () => (host.querySelector('[data-flow="branch.fork"]') as HTMLButtonElement).click())
    await waitFor(() => requests.some(request => request.method === "POST" && request.path === "/api/branches"))
    const fork = requests.find(request => request.method === "POST" && request.path === "/api/branches")!
    assert.deepEqual(fork.body, { from: "scratch/ben/try" })
    assert.equal(fork.status, 201, JSON.stringify(fork))
    assert.equal(requests.filter(request => request.method === "POST").length, 1)
    console.log("PASS mounted scratch Fork through production dispatcher and PostgreSQL")
  } else if (newTerminal) {
    await waitFor(() => host.querySelector('[data-flow="terminal"]') !== null)
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "terminal-card-fixture", repo: "ben/demo", phase: "pending" } }).isPersisted.promise
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "terminal-card-fixture", repo: "ben/demo", phase: "ready" } }).isPersisted.promise
    await act(async () => (host.querySelector('[data-flow="terminal"]') as HTMLButtonElement).click())
    await waitFor(() => requests.some(request => request.method === "POST" && request.path === "/api/terminals"))
    const terminal = requests.find(request => request.method === "POST" && request.path === "/api/terminals")!
    assert.deepEqual(terminal.body, { branch: "scratch/ben/try" })
    assert.equal(terminal.status, 503, JSON.stringify(terminal))
    await waitFor(() => store.session().terminalRequests?.some(request => request.state === "failed") === true)
    assert.equal(requests.filter(request => request.method === "POST").length, 1)
    assert.equal(store.session().terminalRequests?.[0]?.branch, "scratch/ben/try")
    assert.equal(controller.design.enabled, false)
    console.log("PASS mounted New terminal through production dispatcher; unavailable guest refuses without admission")
  } else if (addToStack) {
    await waitFor(() => host.querySelector('[data-flow="branch.add-to-stack"]') !== null)
    const snapshot = live.getSnapshot(`branch:${branch}`)?.data as { scratch: { forked_from: unknown } }
    assert.deepEqual(snapshot.scratch.forked_from, JSON.parse(process.env.SMITHERS_BRANCH_CARD_FORK_ORIGIN!))
    await act(async () => (host.querySelector('[data-flow="branch.add-to-stack"]') as HTMLButtonElement).click())
    const path = `/api/branches/${encodeURIComponent(process.env.SMITHERS_BRANCH_CARD_SUBJECT!)}/add-to-stack`
    await waitFor(() => requests.some(request => request.method === "POST" && request.path === path))
    const added = requests.find(request => request.method === "POST" && request.path === path)!
    assert.deepEqual(added.body, { text: process.env.SMITHERS_BRANCH_CARD_SUBJECT })
    assert.equal(added.status, 202, JSON.stringify(added))
    assert.match(added.key!, /^[0-9a-f-]{36}$/)
    await waitFor(() => store.session().branchRequests?.some(request => request.operation === "add" && request.state === "completed" && request.n === Number(process.env.SMITHERS_BRANCH_CARD_ADD_N)) === true)
    assert.equal(requests.filter(request => request.method === "POST").length, 1)
    console.log("PASS mounted Branch Add to stack through production dispatcher and PostgreSQL")
  } else if (movedChoice) {
    const flow = `todo.${movedChoice}`
    await waitFor(() => host.querySelector(`[data-flow="${flow}"]`) !== null)
    await act(async () => (host.querySelector(`[data-flow="${flow}"]`) as HTMLButtonElement).click())
    await waitFor(() => requests.some(request => request.method === "POST" && request.path === "/api/todos/1"))
    const choice = requests.find(request => request.method === "POST" && request.path === "/api/todos/1")!
    assert.deepEqual(choice.body, { op: movedChoice, id: process.env.SMITHERS_BRANCH_MOVED_WAIT })
    assert.equal(choice.status, 202, JSON.stringify(choice))
    assert.match(choice.key!, /^[0-9a-f-]{36}$/)
    assert.equal(requests.filter(request => request.method === "POST").length, 1)
    const todo = await (await fetchImpl(`${origin}/api/todos/1`)).json() as { waits: Array<{ id: string; answered_by?: string }> }
    assert.equal(todo.waits.length, 2)
    assert.equal(todo.waits.find(wait => wait.id === "other-question")?.answered_by, undefined)
    console.log(`MOVED_CARD_KEY=${choice.key}`)
    console.log(`PASS mounted Branch ${movedChoice} through production dispatcher and PostgreSQL; unrelated question retained`)
  } else {
  await waitFor(() => host.textContent?.includes("Asleep") === true)
  assert.ok(host.textContent?.includes("smithers/sleep-item"))
  const beforeBurstDiff = requests.length
  assert.deepEqual(await controller.submitCommand({ name: "diff", payload: { branch: "smithers/sleep-item", entry: "captured-burst-1" }, actor: "user" }),
    { status: "failed", error: "Burst diff unavailable" })
  assert.ok(requests.slice(beforeBurstDiff).every(request => !request.path.endsWith("/diff")), "an unavailable burst comparison never shows a TODO base diff")
  // The slash door resolves both a TODO and the canonical bookmark through
  // authorized HTTP reads, then shares the mounted card's existing live topic.
  const sshReads = requests.length
  for (const subject of ["T1", "smithers/sleep-item"]) {
    const copied = await controller.runCommandForResult("ssh", subject)
    assert.deepEqual(copied, { status: "executed", value: "ssh -p 2222 smithers/sleep-item@127.0.0.1" })
  }
  assert.ok(requests.slice(sshReads).every(request => request.method === "GET"), "SSH resolution never admits or wakes")
  assert.ok(requests.slice(sshReads).some(request => request.path === "/api/todos/1" && request.status === 200))
  assert.ok(requests.slice(sshReads).some(request => request.path === "/api/branches/smithers%2Fsleep-item" && request.status === 200))
  const missingSsh = await controller.runCommandForResult("ssh", "T999")
  assert.equal(missingSsh.status, "failed", "unknown TODO never copies a seed SSH line")
  await act(async () => (host.querySelector('[data-flow="branch.fork"]') as HTMLButtonElement).click())
  await waitFor(() => requests.some(request => request.method === "POST" && request.path === "/api/branches"))
  const fork = requests.find(request => request.method === "POST" && request.path === "/api/branches")!
  assert.deepEqual(fork.body, { from: "T1" })
  // This TODO has no verified candidate. Check before Answer changes its state.
  assert.equal(fork.status, 409, JSON.stringify(fork))
  assert.deepEqual(fork.refusal, { class: "conflict", code: "no_verified_head", message: "T1 has no verified head to fork yet" })
  await waitFor(() => host.querySelector('form[data-flow="todo.answer"]') !== null)
  const steer = host.querySelector('form[data-flow="todo.steer"]') as HTMLFormElement
  const steerField = steer.querySelector("input")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(steerField, "Keep retry backoff bounded")
    steerField.dispatchEvent(new Event("input", { bubbles: true }))
    steerField.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await act(async () => steer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await waitFor(() => requests.some(request => request.method === "POST" && request.path === "/api/todos/1"))
  const steered = requests.find(request => request.method === "POST" && request.path === "/api/todos/1")!
  assert.deepEqual(steered.body, { steer: "Keep retry backoff bounded" })
  assert.equal(steered.status, 202, JSON.stringify(steered))
  const waiting = await (await fetchImpl(`${origin}/api/todos/1`)).json() as { state: string; waits: Array<{ id: string; answer?: string }> }
  assert.equal(waiting.state, "needs_you", "Steer leaves the question open")
  assert.equal(waiting.waits.find(wait => wait.id === "branch-question-1")?.answer, undefined)
  const answer = host.querySelector('form[data-flow="todo.answer"]') as HTMLFormElement
  const field = answer.querySelector("input")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Include them")
    field.dispatchEvent(new Event("input", { bubbles: true }))
    field.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await act(async () => answer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await waitFor(() => requests.some(request => request.path === "/api/todos/1/answer"))
  const answered = requests.find(request => request.path === "/api/todos/1/answer")!
  assert.deepEqual(answered.body, { answer: "Include them", wait: "branch-question-1" })
  assert.equal(answered.status, 202, JSON.stringify(answered))
  assert.ok(host.querySelector('[data-flow="todo"]'), "real item binding")
  assert.ok(host.querySelector('[data-flow="todo.steer"]'), "real steer binding")
  assert.equal(host.querySelector('[data-flow="box.resume"]'), null, "uncomposed wake stays dark")
  await act(async () => (host.querySelector('[data-flow="todo"]') as HTMLButtonElement).click())
  await waitFor(() => [...store.collections.cards.values()].some(each => each.kind === "todo"))
  assert.equal((await controller.submitCommand({ name: "file", payload: { path: "src/retry.ts", branch: "smithers/sleep-item" }, actor: "user" })).status, "executed")
  await waitFor(() => [...store.collections.cards.values()].some(each => each.kind === "file"))
  const file = [...store.collections.cards.values()].find(each => each.kind === "file")!
  assert.equal(file.kind, "file")
  if (file.kind === "file") assert.equal(file.payload.content, "export const retry = 3;\n")
  assert.ok(requests.some(request => request.path === "/api/todos/1" && request.status === 200))
  assert.ok(requests.some(request => request.path.endsWith("/files/src/retry.ts") && request.status === 200))
  assert.ok(requests.filter(request => request.method === "POST").every(request => request.path === "/api/branches" || request.path === "/api/todos/1/answer" || request.path === "/api/todos/1"), "reads never wake the sleeping branch")
  console.log("PASS composed Branch slash, mount, bound Answer/Steer, SSH TODO/bookmark, item, file and Fork refusal; no wake")
  }
} finally { await act(async () => root.unmount()); await controller.dispose(); live.dispose() }
