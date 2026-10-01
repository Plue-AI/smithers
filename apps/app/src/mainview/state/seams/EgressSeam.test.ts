import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { FailureController } from "../controller/failures"
import { TOAST_SUPERSEDED } from "../controller/failures"
import {
  agentSessionEgressPath,
  createEgressSeam,
  DEGRADED_EGRESS_REFUSAL,
  egressHost,
  egressLine,
  egressPolicyPath,
  loadEgressPage,
  nextEgressCursor,
  parseAllowDomains,
  parseEgressRow,
  staleReloads,
  UNREADABLE_ALLOWLIST,
  workspaceEgressPath
} from "./EgressSeam"
import type { SeamContext } from "./SeamContext"
import { createWorkspaceSeam } from "./WorkspaceSeam"

/*
 * The sandbox egress audit seam (lane L3). One route shape serves a workspace
 * and an agent session (plue `internal/routes/sandbox_egress_audit.go`): a
 * bare array of `services.SandboxEgressAuditEntry` and a Link header whose
 * `rel="next"` carries an opaque base64 keyset cursor. Every double below is
 * that shape; the parser states what the wire said, and a page it cannot read
 * is an error, never an empty audit.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

/** One row exactly as plue writes it. */
const CALL = {
  occurred_at: "2026-09-02T09:15:00Z",
  host: "api.github.com",
  method: "POST",
  path: "/graphql",
  status: 200,
  allowed: true,
  swapped_secret_names: ["GITHUB_TOKEN"]
}

const SESSION_PATH = "api/repos/will/smithers/agent-sessions/as-1/egress"
const WORKSPACE_PATH = "api/repos/will/smithers/workspaces/ws-1/egress"
const UNREADABLE_PAYLOAD = "Smithers Cloud answered an egress audit payload in a shape Smithers can't read."

const malformedPayloads = [
  ["invalid JSON", "{"],
  ["an unexpected object", "{\"unexpected\":true}"],
  ["an items envelope", "{\"items\":[]}"],
  ["null", "null"],
  ["a scalar", "\"not an audit\""]
] as const

type Route = Response | ((url: URL, init?: RequestInit) => Response | Promise<Response>)

/** Each background write the seam hands the shared toast stack, and how it settled. */
interface ToastRun {
  readonly key: string
  readonly title: string
  readonly doneTitle: string
  outcome?: unknown
}

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly degraded?: boolean } = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const urls: Array<string> = []
  const ctx: SeamContext = {
    http: async (input, init) => {
      const stripped = input.startsWith("/") ? input.slice(1) : input
      const url = new URL(stripped, "https://cloud.invalid/")
      const path = url.pathname.slice(1)
      urls.push(`${init?.method ?? "GET"} ${path}${url.search}`)
      const route = routes[path]
      if (route === undefined) return json(404, { message: `no route ${path}` })
      return typeof route === "function" ? route(url, init) : route
    },
    baseUrl: "",
    store,
    dispatch: (transition) => store.dispatch(transition),
    actor: () => "user",
    nextOrdinal: () => 0
  }
  if (options.signedIn !== false) {
    await store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-in",
      username: "will",
      expiresAt: null,
      scopes: options.degraded === true ? "degraded" : null
    })
  }
  await store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [
      { id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null }
    ]
  })
  const toasts: Array<ToastRun> = []
  const settled: Array<Promise<unknown>> = []
  const withToast = (async (key, title, doneTitle, work) => {
    const run: ToastRun = { key, title, doneTitle }
    toasts.push(run)
    const done = work().then((outcome) => (run.outcome = outcome))
    settled.push(done)
    return done
  }) as FailureController["withToast"]
  return { store, ctx, seam: createEgressSeam(ctx, withToast), urls, toasts, idle: () => Promise.all(settled) }
}

const messagesOf = (store: Awaited<ReturnType<typeof harness>>["store"]) =>
  [...store.collections.messages.values()].map((message) => message.text)

describe("the egress audit row parser", () => {
  test("plue's row reads as the call it was, with the secret NAMES and no value", () => {
    expect(parseEgressRow(CALL)).toEqual({
      occurredAt: "2026-09-02T09:15:00Z",
      host: "api.github.com",
      method: "POST",
      path: "/graphql",
      status: 200,
      allowed: true,
      swappedSecretNames: ["GITHUB_TOKEN"]
    })
  })

  test("a blocked call keeps its status and reads as blocked", () => {
    expect(parseEgressRow({ ...CALL, allowed: false, status: 403 })).toEqual(
      expect.objectContaining({ allowed: false, status: 403 })
    )
  })

  test("no swapped secrets is an empty list whether plue writes [], null, or nothing", () => {
    for (const names of [[], null, undefined]) {
      expect(parseEgressRow({ ...CALL, swapped_secret_names: names })?.swappedSecretNames).toEqual([])
    }
  })

  test("a row missing a fact it would have to state drops rather than inventing one", () => {
    expect(parseEgressRow({ ...CALL, occurred_at: "" })).toBeNull()
    expect(parseEgressRow({ ...CALL, host: "" })).toBeNull()
    expect(parseEgressRow({ ...CALL, method: undefined })).toBeNull()
    expect(parseEgressRow({ ...CALL, status: "200" })).toBeNull()
    expect(parseEgressRow({ ...CALL, allowed: undefined })).toBeNull()
    expect(parseEgressRow(null)).toBeNull()
    expect(parseEgressRow([CALL])).toBeNull()
  })

  test("an empty path is a real call to the host's root, not a malformed row", () => {
    expect(parseEgressRow({ ...CALL, path: "" })?.path).toBe("")
  })
})

describe("the audit's cursor", () => {
  const path = "/repos/will/smithers/workspaces/ws-1/egress"

  test("the rel=\"next\" link's cursor is the next page's position", () => {
    expect(
      nextEgressCursor(
        `</api${path}?limit=30>; rel="first", </api${path}?limit=30&cursor=eyJpZCI6MX0>; rel="next"`,
        path
      )
    ).toBe("eyJpZCI6MX0")
  })

  test("a last page (first link only) exhausts the cursor", () => {
    expect(nextEgressCursor(`</api${path}?limit=30>; rel="first"`, path)).toBeNull()
    expect(nextEgressCursor(null, path)).toBeNull()
  })

  test("a next link that leaves the route it paginates is not followed", () => {
    expect(nextEgressCursor(`</api/repos/will/smithers/changes?cursor=x>; rel="next"`, path)).toBeNull()
  })
})

describe("one page of an audit", () => {
  test("the page asks for plue's own limit and reads the rows and the cursor", async () => {
    const { ctx, urls } = await harness({
      [SESSION_PATH]: json(200, [CALL], {
        link: `</${SESSION_PATH}?limit=30&cursor=eyJpZCI6MX0>; rel="next"`
      })
    })
    const page = await loadEgressPage(ctx, agentSessionEgressPath("will/smithers", "as-1"))
    expect(urls).toEqual([`GET ${SESSION_PATH}?limit=30`])
    expect(page).toEqual({ rows: [parseEgressRow(CALL)!], nextCursor: "eyJpZCI6MX0" })
  })

  test("a cursor rides the query", async () => {
    const { ctx, urls } = await harness({ [SESSION_PATH]: json(200, []) })
    await loadEgressPage(ctx, agentSessionEgressPath("will/smithers", "as-1"), "eyJpZCI6MX0")
    expect(urls).toEqual([`GET ${SESSION_PATH}?limit=30&cursor=eyJpZCI6MX0`])
  })

  test("a refusal is the server's own message, verbatim", async () => {
    const { ctx } = await harness({
      [SESSION_PATH]: json(403, { message: "you do not have access to this repository" })
    })
    expect(await loadEgressPage(ctx, agentSessionEgressPath("will/smithers", "as-1"))).toEqual({
      error: "you do not have access to this repository"
    })
  })

  test("rows Smithers cannot read are an error — an empty audit would be the one lie that matters here", async () => {
    const { ctx } = await harness({ [SESSION_PATH]: json(200, [{ host: 12 }]) })
    expect(await loadEgressPage(ctx, agentSessionEgressPath("will/smithers", "as-1"))).toEqual({
      error: "Smithers Cloud answered 1 egress row in a shape Smithers can't read."
    })
  })

  test("the two resources share one path shape", () => {
    expect(workspaceEgressPath("will/smithers", "ws-1")).toBe("/repos/will/smithers/workspaces/ws-1/egress")
    expect(agentSessionEgressPath("will/smithers", "as-1")).toBe("/repos/will/smithers/agent-sessions/as-1/egress")
  })
})

describe("egress.session", () => {
  test.each(malformedPayloads)("%s returns an error without announcing an empty audit", async (_, body) => {
    const { store, seam } = await harness({
      [SESSION_PATH]: new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    })
    expect(await seam.listSessionEgress("as-1")).toBe(UNREADABLE_PAYLOAD)
    expect(messagesOf(store)).toEqual([])
  })

  test("a signed-out session refuses with the sign-in step; a degraded one with the enable wording", async () => {
    const signedOut = await harness({}, { signedIn: false })
    expect(await signedOut.seam.listSessionEgress("as-1")).toBe("Sign in to Smithers Cloud to continue.")
    const degraded = await harness({}, { degraded: true })
    expect(await degraded.seam.listSessionEgress("as-1")).toBe(DEGRADED_EGRESS_REFUSAL)
    expect(DEGRADED_EGRESS_REFUSAL).toContain("sign in again to enable")
  })

  test("the agent session's audit answers as a transcript listing, secret names and all", async () => {
    const { store, seam, urls } = await harness({ [SESSION_PATH]: json(200, [CALL]) })
    const result = await seam.listSessionEgress("as-1")
    expect(urls).toEqual([`GET ${SESSION_PATH}?limit=30`])
    expect(result).toEqual({
      value: "2026-09-02T09:15:00Z · POST api.github.com/graphql · 200 · allowed · secrets GITHUB_TOKEN"
    })
    expect(messagesOf(store)).toEqual([
      "2026-09-02T09:15:00Z · POST api.github.com/graphql · 200 · allowed · secrets GITHUB_TOKEN"
    ])
  })

  test("a page with more behind it names the cursor the next call takes", async () => {
    const { seam } = await harness({
      [SESSION_PATH]: json(200, [CALL], { link: `</${SESSION_PATH}?limit=30&cursor=eyJpZCI6MX0>; rel="next"` })
    })
    const result = await seam.listSessionEgress("as-1", "will/smithers")
    expect(typeof result === "object" && "value" in result ? result.value : "").toContain(
      "Older calls remain — /egress.session as-1 will/smithers eyJpZCI6MX0"
    )
  })

  test("a session that called nothing says so", async () => {
    const { seam } = await harness({ [SESSION_PATH]: json(200, []) })
    expect(await seam.listSessionEgress("as-1")).toEqual({ value: "Agent session as-1 made no recorded calls." })
  })

  test("a line never carries a secret's value — only the binding's name", () => {
    expect(egressLine(parseEgressRow(CALL)!)).toBe(
      "2026-09-02T09:15:00Z · POST api.github.com/graphql · 200 · allowed · secrets GITHUB_TOKEN"
    )
    expect(egressLine(parseEgressRow({ ...CALL, swapped_secret_names: [] })!)).toBe(
      "2026-09-02T09:15:00Z · POST api.github.com/graphql · 200 · allowed"
    )
  })
})

describe("workspace egress payload failures", () => {
  test.each(malformedPayloads)("%s preserves previously loaded rows and the cursor", async (_, body) => {
    let payload = JSON.stringify([CALL])
    const { store, ctx } = await harness({
      [WORKSPACE_PATH]: () =>
        new Response(payload, {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: `</${WORKSPACE_PATH}?limit=30&cursor=older>; rel="next"`
          }
        })
    })
    await store.dispatch({
      type: "workspace.updated",
      actor: "system",
      workspace: {
        id: "ws-1",
        repoId: "will/smithers",
        name: "review",
        targetBookmark: "main",
        status: "running",
        provisioningStage: null,
        suspendedAt: null,
        createdAt: "2026-09-01T00:00:00Z"
      }
    })
    const seam = createWorkspaceSeam(ctx)
    expect(await seam.setFacet("ws-1", "egress")).toBeUndefined()
    const card = store.collections.cards.get("workspace-ws-1")
    expect(card?.kind).toBe("workspace")
    if (card?.kind !== "workspace") throw new Error("Expected a workspace card")
    expect(card.payload.egress).toEqual([parseEgressRow(CALL)!])
    expect(card.payload.egressCursor).toBe("older")

    payload = body
    for (const cursor of [undefined, "older"]) {
      expect(await seam.listEgress("ws-1", cursor)).toBe(UNREADABLE_PAYLOAD)
      const retained = store.collections.cards.get("workspace-ws-1")
      expect(retained?.kind).toBe("workspace")
      if (retained?.kind !== "workspace") throw new Error("Expected a workspace card")
      expect(retained.payload.egress).toEqual(card.payload.egress)
      expect(retained.payload.egressCursor).toBe("older")
      expect(retained.payload.error).toBe(UNREADABLE_PAYLOAD)
    }
  })
})

describe("allowing a blocked host (#2653)", () => {
  const POLICY = "api/repos/will/smithers/egress-policy"
  const settle = async (h: { readonly idle: () => Promise<unknown> }) => {
    for (let tick = 0; tick < 10; tick++) {
      await h.idle()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  /** plue's route: PATCH adds hosts without replacing the list and answers each running sandbox's reload. */
  const policy = (initial: ReadonlyArray<string>, gate?: Promise<void>) => {
    let domains = [...initial]
    const writes: Array<unknown> = []
    const route: Route = async (_url, init) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { add: Array<string> }
        await gate
        writes.push(body)
        domains = [...new Set([...domains, ...body.add])].sort()
        return json(200, { allow_domains: domains, reloads: [{ sandbox_id: "sb-1", reloaded: true }] })
      }
      await gate
      return json(200, { allow_domains: domains })
    }
    return { route, writes, domains: () => domains }
  }

  test("adds a normalized host through the canonical atomic PATCH without reading or replacing the list", async () => {
    const sent: Array<unknown> = []
    const h = await harness({
      [POLICY]: (_url, init) => {
        sent.push({ method: init?.method, body: JSON.parse(String(init?.body ?? "null")) })
        return init?.method === "PATCH"
          ? json(200, { allow_domains: ["concurrent.example.com", "api.example.com"], reloads: [] })
          : json(405, { message: "atomic PATCH required" })
      }
    })
    expect(await h.seam.allowEgressHost(" API.Example.com. ")).toEqual({
      value: "Allowing api.example.com for will/smithers."
    })
    await settle(h)
    expect(sent).toEqual([{ method: "PATCH", body: { add: ["api.example.com"] } }])
    expect(h.toasts[0]?.outcome).toBe(true)
  })

  test("the host, the path and the list read as plue writes them", () => {
    expect(egressPolicyPath("will/smithers")).toBe("/repos/will/smithers/egress-policy")
    expect(egressPolicyPath("a b/c#d")).toBe("/repos/a%20b/c%23d/egress-policy")
    expect(egressHost("  API.Example.COM. ")).toBe("api.example.com")
    expect(egressHost(" . ")).toBe("")
    expect(parseAllowDomains({ allow_domains: ["a.example.com"] })).toEqual(["a.example.com"])
    expect(parseAllowDomains({ allow_domains: [] })).toEqual([])
    for (const body of [null, [], {}, { allow_domains: "a" }, { allow_domains: [1] }]) {
      expect(parseAllowDomains(body)).toBeNull()
    }
  })

  test("acknowledges before the write finishes, and the toast settles only with it", async () => {
    let open = (): void => undefined
    const gate = new Promise<void>((resolve) => void (open = resolve))
    const cloud = policy(["registry.npmjs.org"], gate)
    const h = await harness({ [POLICY]: cloud.route })
    expect(await h.seam.allowEgressHost("API.Example.com.")).toEqual({
      value: "Allowing api.example.com for will/smithers."
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.toasts).toEqual([{
      key: "egress-allow:will:will/smithers:api.example.com",
      title: "Allowing api.example.com…",
      doneTitle: "api.example.com allowed"
    }])
    expect(cloud.writes).toEqual([])
    open()
    await settle(h)
    expect(h.toasts[0]?.outcome).toBe(true)
    expect(cloud.writes).toEqual([{ add: ["api.example.com"] }])
    expect(h.urls).toEqual([`PATCH ${POLICY}`])
  })

  test("a repeated request for the same host while one runs sends one write", async () => {
    let open = (): void => undefined
    const gate = new Promise<void>((resolve) => void (open = resolve))
    const cloud = policy([], gate)
    const h = await harness({ [POLICY]: cloud.route })
    const first = await h.seam.allowEgressHost("api.example.com", "will/smithers")
    expect(await h.seam.allowEgressHost("API.example.com")).toEqual(first)
    open()
    await settle(h)
    expect(h.toasts).toHaveLength(1)
    expect(cloud.writes).toEqual([{ add: ["api.example.com"] }])
  })

  test("two hosts in a row both land as independent atomic additions", async () => {
    const cloud = policy(["a.example.com"])
    const h = await harness({ [POLICY]: cloud.route })
    await h.seam.allowEgressHost("b.example.com")
    await h.seam.allowEgressHost("c.example.com")
    await settle(h)
    expect(cloud.writes).toEqual([
      { add: ["b.example.com"] },
      { add: ["c.example.com"] }
    ])
    expect(cloud.domains()).toEqual(["a.example.com", "b.example.com", "c.example.com"])
  })

  test("a host already allowed is written again unchanged, so the running sandboxes reload it", async () => {
    const cloud = policy(["*.example.com"])
    const h = await harness({ [POLICY]: cloud.route })
    await h.seam.allowEgressHost("*.EXAMPLE.com")
    await settle(h)
    expect(h.toasts[0]?.outcome).toBe(true)
    expect(cloud.writes).toEqual([{ add: ["*.example.com"] }])
  })

  test("a sandbox the write did not reload fails the toast, and asking again writes again", async () => {
    const writes: Array<unknown> = []
    const h = await harness({
      [POLICY]: (_url, init) => {
        if (init?.method !== "PATCH") return json(200, { allow_domains: [] })
        writes.push(JSON.parse(String(init.body)))
        return json(200, {
          allow_domains: ["api.example.com"],
          reloads: [
            { sandbox_id: "sb-1", reloaded: true },
            { sandbox_id: "sb-2", reloaded: false, error: "live reload unsupported; applies on next start" }
          ]
        })
      }
    })
    await h.seam.allowEgressHost("api.example.com")
    await settle(h)
    expect(h.toasts[0]?.outcome).toBe("api.example.com allowed; 1 running box gets it on restart.")
    await h.seam.allowEgressHost("api.example.com")
    await settle(h)
    expect(writes).toHaveLength(2)
    expect(staleReloads({ reloads: [{ reloaded: false }, "x", { reloaded: true }, { reloaded: false }] })).toBe(3)
    expect(staleReloads({ reloads: [] })).toBe(0)
    expect(staleReloads(null)).toBe(0)
  })

  test("sign-out supersedes an unresolved write and never sends queued writes", async () => {
    let open = (): void => undefined
    const gate = new Promise<void>((resolve) => void (open = resolve))
    const cloud = policy([], gate)
    const h = await harness({ [POLICY]: cloud.route })
    await h.seam.allowEgressHost("api.example.com")
    await h.seam.allowEgressHost("b.example.com")
    await h.store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-out",
      username: null,
      expiresAt: null,
      scopes: null
    })
    open()
    await settle(h)
    expect(h.toasts.map((toast) => toast.outcome)).toEqual([TOAST_SUPERSEDED, TOAST_SUPERSEDED])
    expect(cloud.writes).toEqual([{ add: ["api.example.com"] }])
    expect(h.urls).toEqual([`PATCH ${POLICY}`])
  })

  test("a refused write fails the toast with plue's words, and the host can be asked for again", async () => {
    const h = await harness({ [POLICY]: json(403, { message: "repository owner access required" }) })
    await h.seam.allowEgressHost("api.example.com")
    await settle(h)
    expect(h.toasts[0]?.outcome).toEqual(expect.stringContaining("repository owner access required"))
    await h.seam.allowEgressHost("api.example.com")
    await settle(h)
    expect(h.toasts).toHaveLength(2)
  })

  test("a PATCH refusal and an unreadable committed list both fail the toast", async () => {
    const refused = await harness({
      [POLICY]: (_url, init) =>
        init?.method === "PATCH"
          ? json(400, { message: "egress domain \"*\" would allow every host" })
          : json(200, { allow_domains: [] })
    })
    await refused.seam.allowEgressHost("api.example.com")
    await settle(refused)
    expect(refused.toasts[0]?.outcome).toEqual(expect.stringContaining("would allow every host"))
    const unreadable = await harness({ [POLICY]: json(200, { domains: [] }) })
    await unreadable.seam.allowEgressHost("api.example.com")
    await settle(unreadable)
    expect(unreadable.toasts[0]?.outcome).toBe(UNREADABLE_ALLOWLIST)
    expect(unreadable.urls).toEqual([`PATCH ${POLICY}`])
  })

  test("refuses without a request when signed out, degraded, unnamed or aimed at a malformed repository", async () => {
    const signedOut = await harness({}, { signedIn: false })
    expect(await signedOut.seam.allowEgressHost("api.example.com")).toBe("Sign in to Smithers Cloud to continue.")
    const degraded = await harness({}, { degraded: true })
    expect(await degraded.seam.allowEgressHost("api.example.com")).toBe(DEGRADED_EGRESS_REFUSAL)
    const h = await harness({})
    expect(await h.seam.allowEgressHost("  ")).toBe("Name a host to allow.")
    expect(await h.seam.allowEgressHost("api.example.com", "not a repo")).toBe(
      "\"not a repo\" is not an owner/repo name"
    )
    for (const run of [signedOut, degraded, h]) {
      expect(run.urls).toEqual([])
      expect(run.toasts).toEqual([])
    }
  })
})
