import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createIntegrationsSeam } from "./IntegrationsSeam"

/*
 * The connect card's integration rows read the routes the backend registers
 * (compose/router.go): GET …/issues/sync/channels and GET /api/integrations/linear.
 * A missing route is `unavailable`, never "not connected".
 */
const setup = async (answer: (url: string) => Response | Promise<Response>) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  const seen: string[] = []
  let ordinal = 0
  const seam = createIntegrationsSeam({ store, dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => ++ordinal, baseUrl: "https://app.test",
    http: async (url) => { seen.push(url); return answer(url) } })
  const rows = () => { const card = store.collections.cards.get("connect-embedded"); return card?.kind === "connect" ? card.payload.integrations?.rows : undefined }
  return { store, seam, seen, rows }
}

const CHANNELS = "https://app.test/api/repos/Owner/Repo/issues/sync/channels"
const LINEAR = "https://app.test/api/integrations/linear"

test("connected rows come from the registered routes: the owner's Slack admissions and the Linear integration bound to the repository", async () => {
  const { seam, seen, rows, store } = await setup(url => url === CHANNELS
    ? Response.json([{ provider: "telegram", connection_id: "bot", scope_id: "1", conversation_id: "-100", thread_id: "", external_user_id: "" },
      { provider: "slack", connection_id: "workspace", scope_id: "T001", conversation_id: "C001", thread_id: "", external_user_id: "" },
      { provider: "slack", connection_id: "workspace", scope_id: "T001", conversation_id: "C002", thread_id: "", external_user_id: "" }])
    : Response.json([{ id: 1, repo_owner: "someone", repo_name: "else", linear_team_key: "OPS", is_active: true, last_sync_at: null },
      { id: 2, repo_owner: "owner", repo_name: "repo", linear_team_key: "ENG", is_active: true, last_sync_at: "2026-09-26T09:40:00Z" }]))
  try {
    expect(await seam.listIntegrations("Owner/Repo")).toEqual({ value: "slack: connected · C001, C002\nlinear: connected · ENG" })
    expect(seen.sort()).toEqual([LINEAR, CHANNELS].sort())
    expect(rows()).toEqual([
      { id: "slack", state: "connected", detail: "C001, C002" },
      { id: "linear", state: "connected", detail: "ENG", lastSyncAt: "2026-09-26T09:40:00Z" }
    ])
  } finally { await store.dispose?.() }
})

test("no admissions and no Linear row for this repository read not-connected", async () => {
  const { seam, rows, store } = await setup(url => url === CHANNELS
    ? Response.json([{ provider: "telegram", connection_id: "bot", scope_id: "1", conversation_id: "-100", thread_id: "", external_user_id: "" }])
    : Response.json([{ id: 1, repo_owner: "someone", repo_name: "else", linear_team_key: "OPS", is_active: true }]))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["not-connected", "not-connected"])
  } finally { await store.dispose?.() }
})

test("a route this server does not register is unavailable, not a disconnected account; a 502 refusal says what failed and whose fault it was", async () => {
  const { seam, rows, store } = await setup(url => url === CHANNELS
    ? Response.json({ status: "error", code: "route_not_found", message: "Not found." }, { status: 404 })
    : Response.json({ status: "error", message: "token revoked" }, { status: 502 }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()).toEqual([
      { id: "slack", state: "unavailable" },
      { id: "linear", state: "error", error: "Reading the Linear integrations failed (502). Something Smithers depends on failed. Not your doing." }
    ])
    expect(rows()?.[1]?.error).not.toContain("token revoked")
  } finally { await store.dispose?.() }
})

test("malformed successful integration lists report a read error instead of claiming no connection", async () => {
  const { seam, rows, store } = await setup(url => url === CHANNELS
    ? Response.json({ channels: { provider: "slack", conversation_id: "C001" } })
    : Response.json({ integrations: null }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["error", "error"])
  } finally { await store.dispose?.() }
})

test("supported empty list wrappers remain disconnected", async () => {
  const { seam, rows, store } = await setup(url => url === CHANNELS
    ? Response.json({ channels: [] })
    : Response.json({ integrations: [] }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["not-connected", "not-connected"])
  } finally { await store.dispose?.() }
})

test("malformed rows inside valid list wrappers are filtered", async () => {
  const { seam, rows, store } = await setup(url => url === CHANNELS
    ? Response.json({ channels: [null, { provider: "slack", conversation_id: "" }] })
    : Response.json({ integrations: [null, { repo_owner: "someone", repo_name: "else" }] }))
  try {
    await seam.listIntegrations("Owner/Repo")
    expect(rows()?.map(row => row.state)).toEqual(["not-connected", "not-connected"])
  } finally { await store.dispose?.() }
})
