import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { createBranchMutations } from "./BranchMutationsSeam"
import type { SeamFetch } from "./SeamContext"

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 150 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}
const boot = async (http: SeamFetch, storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const done: string[] = [], errors: string[] = []
  const seam = createBranchMutations({ store, dispatch: store.dispatch, http, baseUrl: "https://install.test", actor: () => "user", nextOrdinal: () => store.nextOrdinal(),
    withToast: async (key, _title, _done, work, _quiet, current) => {
      const result = await work()
      if (current?.() !== false) { done.push(key); if (typeof result === "string") errors.push(result) }
      return result
    } })
  return { store, seam, done, errors, storage }
}

test("requests return before launch; duplicates share a key; provisioning keeps work running", async () => {
  let release!: (response: Response) => void
  let machine = "provisioning"
  const keys: string[] = []
  const h = await boot(async (_path, init) => {
    if (init?.method === "POST") { keys.push(new Headers(init.headers).get("Idempotency-Key")!); return new Promise(resolve => { release = resolve }) }
    return Response.json({ state: machine })
  })
  try {
    expect(await h.seam.request("fork", { from: "T2" })).toEqual({ value: "Requested" })
    expect(await h.seam.request("fork", { from: "T2" })).toEqual({ value: "Requested" })
    expect(keys).toHaveLength(1)
    expect(h.store.session().branchRequests).toHaveLength(1)
    expect(h.done).toHaveLength(0)
    release(Response.json({ name: "scratch/ben/retry" }, { status: 201 }))
    await until(() => h.store.session().branchRequests?.[0]?.state === "provisioning")
    expect(h.done).toHaveLength(0)
    machine = "asleep"
    await until(() => h.store.session().branchRequests?.[0]?.state === "completed")
    await until(() => h.done.length === 1)
  } finally { h.seam.dispose() }
})

test("Add failure stays durable; retry uses the same key and real completion", async () => {
  let good = false
  const keys: string[] = []
  const h = await boot(async (_path, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key")!)
    return good ? Response.json({ state: "accepted", n: 4 }, { status: 202 }) : Response.json({ message: "Capture unavailable" }, { status: 503 })
  })
  try {
    expect(await h.seam.request("add", { branch: "branch-id", text: "Keep edit", before: 3 })).toEqual({ value: "Requested" })
    await until(() => h.errors.length === 1)
    expect(h.store.session().branchRequests?.[0]).toMatchObject({ state: "failed", error: "Capture unavailable" })
    good = true
    await h.seam.request("add", { branch: "branch-id", text: "Keep edit", before: 3 })
    await until(() => h.store.session().branchRequests?.[0]?.state === "completed")
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1])
    expect(h.store.session().branchRequests?.[0]?.n).toBe(4)
  } finally { h.seam.dispose() }
})

test("reload resumes the saved request with its original key and fences the old response", async () => {
  let release!: (response: Response) => void
  const first = await boot(async () => new Promise(resolve => { release = resolve }))
  await first.seam.request("add", { branch: "scratch/ben/retry", text: "Keep edit" })
  const key = first.store.session().branchRequests![0]!.id
  first.seam.dispose()
  const keys: string[] = []
  const second = await boot(async (_path, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); return Response.json({ n: 6, state: "accepted" }, { status: 202 }) }, first.storage)
  try {
    second.seam.resume()
    await until(() => second.store.session().branchRequests?.[0]?.state === "completed")
    expect(keys).toEqual([key])
    release(Response.json({ state: "accepted", n: 99 }, { status: 202 }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(second.store.session().branchRequests?.[0]?.n).toBe(6)
    expect(first.done).toHaveLength(0)
  } finally { second.seam.dispose() }
})
