import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"
import { createProposalSeam } from "./ProposalSeam"
import type { SeamContext } from "./SeamContext"

const model = { id: "lint/review", title: "Run lint", evidence: ["3 of the last 5"], refs: [], state: "open" }
const json = (body: unknown, status = 202) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const boot = async (http: SeamContext["http"], storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const ctx: SeamContext = { http, store, dispatch: store.dispatch, baseUrl: "https://install.test/", actor: () => "user", nextOrdinal: store.nextOrdinal }
  return { store, storage, seam: createProposalSeam(ctx), ctx,
    card: () => { const row = store.collections.cards.get("proposal:lint/review"); return row?.kind === "proposal" ? row : undefined } }
}
test("a persisted proposal press returns before HTTP, deduplicates, and only a confirmed server receipt marks accepted", async () => {
  let resolve!: (response: Response) => void
  const response = new Promise<Response>(done => { resolve = done })
  const calls: unknown[] = []
  const h = await boot(async (url, init) => { calls.push({ url, method: init?.method, body: init?.body }); return response })
  expect(await h.seam.resolveProposal(model.id, "accept")).toEqual({ value: "Requested" })
  expect(await h.seam.resolveProposal(model.id, "accept")).toEqual({ value: "Requested" })
  expect(calls).toEqual([{ url: "https://install.test/api/proposals/lint%2Freview/accept", method: "POST", body: "{}" }])
  expect(h.card()).toMatchObject({ payload: { request: { action: "accept", owner: "ben", state: "pending" } } })
  expect(h.card()?.payload).not.toHaveProperty("model")
  resolve(json({ ...model, state: "accepted", todo: { n: 12, title: "Run lint" } }))
  await waitFor(() => h.card()?.kind === "proposal" && h.card()?.payload.request === undefined)
  expect(h.card()).toMatchObject({ payload: { model: { state: "accepted", todo: { n: 12 } } } })
})
test("reload replays the same note and a failed request remains retryable", async () => {
  const h = await boot(async () => new Promise<Response>(() => {}))
  await h.seam.resolveProposal(model.id, "dismiss")
  const requests: string[] = []
  const reopened = await boot(async url => { requests.push(url); return json({ error: { code: "permission", message: "Not available" } }, 403) }, h.storage)
  reopened.seam.resumeProposals()
  await waitFor(() => reopened.card()?.status === "error")
  expect(requests).toEqual(["https://install.test/api/proposals/lint%2Freview/dismiss"])
  expect(reopened.card()).toMatchObject({ payload: { request: { state: "failed" } } })
  const retry = createProposalSeam({ ...reopened.ctx, http: async () => json({ ...model, state: "dismissed" }) })
  expect(await retry.resolveProposal(model.id, "dismiss")).toEqual({ value: "Requested" })
  await waitFor(() => reopened.card()?.kind === "proposal" && reopened.card()?.payload.request === undefined)
  expect(reopened.card()).toMatchObject({ payload: { model: { state: "dismissed" } } })
})
test("mismatched receipts and stale identity never fabricate completion", async () => {
  const h = await boot(async () => json({ ...model, id: "other", state: "dismissed" }))
  await h.seam.resolveProposal(model.id, "dismiss")
  await waitFor(() => h.card()?.status === "error")
  expect(h.card()?.payload).not.toHaveProperty("model")
  let resolve!: (response: Response) => void
  const stale = await boot(async () => new Promise<Response>(done => { resolve = done }))
  await stale.seam.resolveProposal(model.id, "accept")
  await stale.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  resolve(json({ ...model, state: "accepted", todo: { n: 12, title: "Run lint" } }))
  await new Promise(done => setTimeout(done, 5))
  expect(stale.card()?.payload).not.toHaveProperty("model")
})

test("signed-out callers and another person's pending request do not dispatch", async () => {
  let calls = 0
  const h = await boot(async () => { calls++; return new Promise<Response>(() => {}) })
  await h.seam.resolveProposal(model.id, "accept")
  const prior = h.card()!
  await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  await h.store.dispatch({ type: "card.upsert", actor: "system", card: prior }).isPersisted.promise
  expect(await h.seam.resolveProposal(model.id, "accept")).toBe("Not your request.")
  await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
  expect(await h.seam.resolveProposal(model.id, "dismiss")).toBe("Sign in to resolve proposals.")
  expect(calls).toBe(1)
})

test("concurrent accept and dismiss keep the first durable request and send once", async () => {
  const urls: string[] = []
  const h = await boot(async url => { urls.push(url); return new Promise<Response>(() => {}) })
  expect(await Promise.all([h.seam.resolveProposal(model.id, "accept"), h.seam.resolveProposal(model.id, "dismiss")]))
    .toEqual([{ value: "Requested" }, { value: "Requested" }])
  expect(urls).toEqual(["https://install.test/api/proposals/lint%2Freview/accept"])
  expect(h.card()).toMatchObject({ payload: { request: { action: "accept", state: "pending" } } })
})
