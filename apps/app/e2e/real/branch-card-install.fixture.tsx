// Invoked by the PostgreSQL composed-install test with its own isolated server.
import assert from "node:assert/strict"
import { act } from "react"
import { createAppController } from "../../src/mainview/state/AppController"
import { createAppStore } from "../../src/mainview/state/AppStore"
import { memoryStorage, unavailableAgent, applicationIdentityFromFetch } from "../../src/mainview/state/TestFixtures"
import { LiveChannel, type LiveSocket } from "../../src/mainview/runtime/LiveChannel"

const origin = process.env.SMITHERS_BRANCH_CARD_ORIGIN!
const branch = process.env.SMITHERS_BRANCH_CARD_ID!
assert.ok(origin && branch)
const NativeSocket = WebSocket, nativeFetch = fetch
const nativeHttp = { Request, Response, Headers, AbortController, AbortSignal }
const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
GlobalRegistrator.register({ url: origin })
Object.assign(globalThis, nativeHttp)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import("react-dom/client")
const { ControllerTestProvider } = await import("../../src/mainview/ControllerContext")
const { CARD_RENDERERS } = await import("../../src/mainview/cards/CardRenderers")
const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
const requests: Array<{ path: string; method: string; body?: unknown; status: number; refusal?: unknown }> = []
const headers = { Cookie: "smithers_session=sleep-cookie; __csrf=branch-card-fixture", Origin: origin }
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
    requests.push({ path: url.pathname, method: init?.method ?? "GET", status: response.status, refusal: response.status >= 400 ? await response.clone().json().catch(() => undefined) : undefined,
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
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "sleepowner", admin: false, scopesPlain: null }).isPersisted.promise
  const opened = await controller.runCommandForResult("branch", "T1")
  assert.equal(opened.status, "executed", JSON.stringify({ opened, requests }))
  const card = store.collections.cards.get(`branch:${branch}`)!
  assert.equal(card.kind, "branch")
  if (card.kind !== "branch") throw new Error("Expected Branch")
  await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
  await waitFor(() => host.textContent?.includes("Asleep") === true)
  assert.ok(host.textContent?.includes("smithers/sleep-item"))
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
  await act(async () => (host.querySelector('[data-flow="branch.fork"]') as HTMLButtonElement).click())
  await waitFor(() => requests.some(request => request.method === "POST" && request.path === "/api/branches"))
  const fork = requests.find(request => request.method === "POST" && request.path === "/api/branches")!
  assert.deepEqual(fork.body, { from: "T1" })
  assert.equal(fork.status, 409, JSON.stringify(fork))
  assert.ok(requests.some(request => request.path === "/api/todos/1" && request.status === 200))
  assert.ok(requests.some(request => request.path.endsWith("/files/src/retry.ts") && request.status === 200))
  assert.ok(requests.filter(request => request.method === "POST").every(request => request.path === "/api/branches"), "reads never wake the sleeping branch")
  console.log("PASS composed Branch slash, mount, SSH TODO/bookmark, item, file and Fork refusal; no wake")
} finally { await act(async () => root.unmount()); await controller.dispose(); live.dispose() }
