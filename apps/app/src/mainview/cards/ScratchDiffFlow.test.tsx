import { expect, test } from "bun:test"
import type { DiffCard } from "@smthrs/rpc/DiffCard"
import { act } from "react"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, signupProfileFetch, unavailableAgent } from "../state/TestFixtures"
import { renderCardBody } from "./CardRenderers"
import { createRoot } from "./views/testDom"

const branch = "scratch/ben/try-retry"
const id = `diff-branch-${branch}`
const model: DiffCard = { path: "src/retry.ts", branch, against: { kind: "fork", rev: "2222222222222222222222222222222222222222" }, change: "added",
  hunks: [{ old_start: 0, new_start: 1, lines: [{ op: "+", text: "export const backoff = 2" }] }] }
const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {},
  onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(5)
  expect(predicate()).toBe(true)
}

for (const branch of ["scratch/ben/try-retry", "b12"]) test(`${branch} Diff persists before an unresolved read, deduplicates, settles its toast and mounts the real model`, async () => {
  const id = `diff-branch-${branch}`
  const expected: DiffCard = { ...model, branch, against: { kind: branch === "b12" ? "item_base" : "fork", rev: "2222222222222222222222222222222222222222" } }
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let answer!: (response: Response) => void
  let reads = 0
  const profile = signupProfileFetch(async input => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://install.test").pathname
    if (path === `/api/branches/${encodeURIComponent(branch)}/diff`) { reads++; return new Promise<Response>(resolve => { answer = resolve }) }
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, toastDebounceMs: 5,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const card = () => { const value = store.collections.cards.get(id); return value?.kind === "diff" ? value : undefined }
  try {
    expect((await controller.runCommandForResult("diff", branch)).status).toBe("executed")
    expect(card()?.payload).toMatchObject({ branchDiffPending: true, branchDiffSource: branch })
    await wait(() => reads === 1)
    expect((await controller.submitCommand({ name: "diff", payload: { branch }, actor: "user" })).status).toBe("executed")
    expect(reads).toBe(1)
    await wait(() => [...store.collections.toasts.values()].some(toast => toast.sourceCard === id && toast.status === "running"))
    // Unrelated Chat commands remain usable while repo-host has not answered.
    expect((await controller.runCommandForResult("branch.fork", "T2")).status).toBe("executed")
    answer(Response.json({ files: [expected] }))
    await wait(() => card()?.payload.branchDiffPending === false)
    expect(card()?.payload).toMatchObject({ branchFiles: [expected] })
    await wait(() => ![...store.collections.toasts.values()].some(toast => toast.sourceCard === id && toast.status === "running"))
    await import("./DiffSurface")
    const host = document.body.appendChild(document.createElement("div")), root = createRoot(host)
    try {
      await act(async () => root.render(<ControllerTestProvider controller={controller}>{renderCardBody(card()!, actions)}</ControllerTestProvider>))
      expect(host.textContent).toContain("src/retry.ts")
      expect(host.querySelector("diffs-container")).not.toBeNull()
      expect(host.querySelector(`[data-against="${expected.against.kind}"]`)?.textContent).toBe("2222222222222222222222222222222222222222")
      expect(host.textContent).not.toContain("sleep(30)")
    } finally { await act(async () => root.unmount()); host.remove() }
  } finally { await controller.dispose() }
}, 20_000)

test("a scratch Diff refusal stays visible and retry uses a new request", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let reads = 0
  const profile = signupProfileFetch(async input => {
    if (String(input).includes("/diff")) { reads++; return reads === 1 ? Response.json({ message: "Repository unavailable" }, { status: 503 }) : Response.json({ files: [reads === 2 ? model : { ...model, branch: "scratch/alice/other" }] }) }
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  try {
    await controller.runCommandForResult("diff", branch)
    await wait(() => store.collections.cards.get(id)?.status === "error")
    expect(store.collections.cards.get(id)?.payload).toMatchObject({ error: "Repository unavailable", branchDiffPending: false })
    const first = store.collections.cards.get(id)?.payload
    await controller.runCommandForResult("diff", branch)
    await wait(() => reads === 2 && store.collections.cards.get(id)?.status === "active" && store.collections.cards.get(id)?.payload !== first)
    await wait(() => store.collections.cards.get(id)?.kind === "diff" && "branchFiles" in store.collections.cards.get(id)!.payload)
    expect(store.collections.cards.get(id)?.payload).toMatchObject({ branchFiles: [model], branchDiffPending: false })
    expect(store.collections.cards.get(id)?.payload).not.toHaveProperty("error")
    await controller.runCommandForResult("diff", branch)
    await wait(() => reads === 3 && store.collections.cards.get(id)?.status === "error")
    expect(store.collections.cards.get(id)?.payload).toMatchObject({ error: "Diff unavailable", branchFiles: [model] })
  } finally { await controller.dispose() }
}, 20_000)


test("item Diff reloads file hints and catches a change during an unresolved read", async () => {
  const branch = "b12", id = `diff-branch-${branch}`
  const before: DiffCard = { ...model, branch, against: { kind: "item_base", rev: "candidate-11" } }
  const after: DiffCard = { ...before, hunks: [{ old_start: 0, new_start: 1, lines: [{ op: "+", text: "export const backoff = 3" }] }] }
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const listeners = new Map<string, () => void>()
  let cursor = 0, reads = 0, answer!: (response: Response) => void
  const topic = "branch:b12:files"
  const profile = signupProfileFetch(async input => {
    if (String(input).includes("/branches/b12/diff")) {
      reads++
      if (reads === 2) return new Promise<Response>(resolve => { answer = resolve })
      return Response.json({ files: [reads === 1 ? before : after] })
    }
    return new Response("{}", { status: 404 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl,
    live: { subscribe: (name, listener) => { listeners.set(name, listener); return () => { listeners.delete(name) } },
      getSnapshot: name => ({ topic: name, cursor, data: [] }) },
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  const card = () => { const value = store.collections.cards.get(id); return value?.kind === "diff" ? value : undefined }
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    expect((await controller.runCommandForResult("diff", branch)).status).toBe("executed")
    await wait(() => card()?.payload.branchDiffPending === false)
    const createdAt = card()!.createdAt, ordinal = card()!.ordinal
    cursor++; listeners.get(topic)!()
    await wait(() => reads === 2)
    expect(card()?.payload.branchFiles).toEqual([before])
    cursor++; listeners.get(topic)!()
    expect(reads).toBe(2)
    answer(Response.json({ files: [before] }))
    await wait(() => reads === 3 && card()?.payload.branchDiffPending === false)
    expect(card()?.payload.branchFiles).toEqual([after])
    expect(card()?.createdAt).toBe(createdAt)
    expect(card()?.ordinal).toBe(ordinal)
    listeners.get(topic)!()
    expect(reads).toBe(3)
  } finally { await controller.dispose() }
  expect(listeners.has(topic)).toBe(false)
}, 20_000)
