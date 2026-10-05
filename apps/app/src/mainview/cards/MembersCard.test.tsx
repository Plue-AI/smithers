import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MembersCard } from "./MembersCard"
import type { MembersViewProps } from "@smthrs/rpc/MembersCard"
import { createMembersSeam } from "../state/seams/MembersSeam"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { CARD_RENDERERS } from "./CardRenderers"

const row = (login: string, role: "owner" | "maintainer" | "member", needs_access = false, suspended = false) => ({
  login, name: login, avatar_url: "https://github.com/avatar.png", color_index: 0, role, needs_access, suspended, actions: []
})
const model = { members: [row("will", "owner"), row("ben", "maintainer"), row("sam", "member", true), row("lee", "member", false, true)],
  access_url: "https://github.com/smithersai/smithers/settings/access" }
const mount = (role: "owner" | "maintainer" | "member") => {
  let props!: MembersViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<MembersCard roster={{ get: () => ({ model }), subscribe: () => () => {} }} role={role}
    dispatch={(tag, input) => { calls.push([tag, input]) }} View={value => { props = value; return null }}
    view={{ maximized: false }} onView={() => {}} />)
  return { props, calls }
}
test("literal roster and immutable-owner controls for each viewer role", () => {
  for (const role of ["owner", "maintainer", "member"] as const) {
    const { props, calls } = mount(role)
    expect(props.model.members.map(m => [m.login, m.role, m.needs_access, m.suspended])).toEqual([
      ["will", "owner", false, false], ["ben", "maintainer", false, false], ["sam", "member", true, false], ["lee", "member", false, true]
    ])
    expect(props.model.members.map(m => m.actions.map(a => a.tag))).toEqual(role === "member" ? [[], [], [], []] : [[], ["members.role", "members.remove"], ["members.role", "members.remove"], ["members.role", "members.remove"]])
    props.onAction("members.remove", { login: "will" })
    expect(calls).toEqual([])
    if (role !== "member") {
      props.onAction("members.role", { login: "ben", role: "member" })
      expect(calls).toEqual([["members.role", { login: "ben", role: "member" }]])
    }
  }
})
test("empty, malformed and oversized logins never dispatch; valid Add binds the shared command", () => {
  const { props, calls } = mount("owner")
  for (const login of ["", "-sam", "sam-", "a--b", "sam/name", " sam", "a".repeat(40)]) props.onAction("members.add", { login })
  expect(calls).toEqual([])
  props.onAction("members.add", { login: "new-user" })
  expect(calls).toEqual([["members.add", { login: "new-user", role: "member" }]])
})
test("missing authority/provider gate refuses before reads, subscriptions or writes", async () => {
  let effects = 0
  for (const missing of ["ready", "http", "live"]) {
    const seam = createMembersSeam({ ready: missing !== "ready", http: missing === "http" ? undefined : async () => { effects++; return Response.json(model) },
      live: missing === "live" ? undefined : { subscribe: () => { effects++; return () => {} }, getSnapshot: () => undefined } })
    seam.start()
    expect(await seam.read()).toEqual({ class: "infra", code: "unavailable", message: "Members unavailable" })
    expect(await seam.mutate("members.add", { login: "alice", role: "member" })).toEqual({ class: "infra", code: "unavailable", message: "Members unavailable" })
    expect(seam.snapshots.get().model).toBeUndefined()
    seam.dispose()
  }
  expect(effects).toBe(0)
})
test("typed GitHub, infra, access and not-found envelopes survive without inserting rows", async () => {
  for (const [status, error] of [
    [403, { class: "user", code: "needs_github_access", message: "needs access on GitHub", fix: "https://github.com/smithersai/smithers/settings/access" }],
    [404, { class: "user", code: "unknown_github_user", message: "GitHub user not found" }],
    [502, { class: "github", code: "github", message: "GitHub unavailable" }],
    [503, { class: "infra", code: "unavailable", message: "Lookup unavailable" }]
  ] as const) {
    const seam = createMembersSeam({ ready: true, http: async (_url, init) => Response.json(init?.method ? error : model, { status: init?.method ? status : 200 }),
      live: { subscribe: () => () => {}, getSnapshot: () => undefined } })
    await seam.read()
    expect(await seam.mutate("members.add", { login: "alice", role: "member" })).toEqual(error)
    expect(seam.snapshots.get()).toEqual({ model, error })
    seam.dispose()
  }
})
test("latest read wins; reconnect read retains roster while pending and disposal ignores late responses", async () => {
  const pending: ((value: Response) => void)[] = []
  let notice!: () => void
  let stopped = 0
  const seam = createMembersSeam({ ready: true, http: () => new Promise(resolve => pending.push(resolve)),
    live: { subscribe: (_topic, cb) => { notice = cb; return () => { stopped++ } }, getSnapshot: () => undefined } })
  seam.start()
  const newer = seam.read()
  pending[1]!(Response.json(model)); await newer
  pending[0]!(Response.json({ ...model, members: [] })); await Promise.resolve(); await Promise.resolve()
  expect(seam.snapshots.get()).toEqual({ model })
  notice()
  expect(seam.snapshots.get()).toEqual({ model })
  seam.dispose()
  pending[2]!(Response.json({ ...model, members: [] })); await Promise.resolve(); await Promise.resolve()
  expect(seam.snapshots.get()).toEqual({ model })
  expect(stopped).toBe(1)
})
test("mutations use literal routes, bodies and idempotency keys and reread committed server roles", async () => {
  const requests: { path: string; method: string; body?: string | null; key: string | null }[] = []
  const committed = { ...model, members: [...model.members, row("alice", "maintainer")] }
  const seam = createMembersSeam({ ready: true, http: async (path, init) => {
    if (init?.method) { requests.push({ path: String(path), method: init.method, body: init.body as string | undefined,
      key: new Headers(init.headers).get("Idempotency-Key") }); return new Response(null, { status: 204 }) }
    return Response.json(committed)
  }, live: { subscribe: () => () => {}, getSnapshot: () => undefined } })
  await seam.mutate("members.add", { login: "alice", role: "member" })
  await seam.mutate("members.role", { login: "alice", role: "member" })
  await seam.mutate("members.remove", { login: "alice" })
  expect(requests.map(({ key, ...request }) => request)).toEqual([
    { path: "/api/members", method: "POST", body: '{"login":"alice"}' },
    { path: "/api/members/alice", method: "PATCH", body: '{"role":"member"}' },
    { path: "/api/members/alice", method: "DELETE", body: undefined }
  ])
  expect(requests.every(request => !!request.key)).toBe(true)
  expect(new Set(requests.map(request => request.key)).size).toBe(3)
  expect(seam.snapshots.get()).toEqual({ model: committed })
  seam.dispose()
})
test("invalid success and transport failures keep last roster; authorization refusal clears it", async () => {
  let result: () => Promise<Response> = async () => Response.json(model)
  const seam = createMembersSeam({ ready: true, http: () => result(), live: { subscribe: () => () => {}, getSnapshot: () => undefined } })
  await seam.read()
  result = async () => Response.json({ invalid: true })
  await seam.read()
  expect(seam.snapshots.get()).toEqual({ model, error: { class: "infra", code: "unavailable", message: "Members unavailable" } })
  result = async () => { throw new Error("private diagnostic") }
  await seam.read()
  expect(seam.snapshots.get().model).toEqual(model)
  result = async () => Response.json({ class: "permission", code: "unauthenticated", message: "Sign in" }, { status: 401 })
  await seam.read()
  expect(seam.snapshots.get()).toEqual({ error: { class: "permission", code: "unauthenticated", message: "Sign in" } })
  seam.dispose()
})
test("seam refuses invalid login and role-to-owner before effects", async () => {
  let effects = 0
  const seam = createMembersSeam({ ready: true, http: async () => { effects++; return Response.json(model) },
    live: { subscribe: () => () => {}, getSnapshot: () => undefined } })
  expect(await seam.mutate("members.add", { login: "../alice", role: "member" })).toEqual({ class: "user", code: "invalid_login", message: "Enter a GitHub username" })
  expect(await seam.mutate("members.role", { login: "alice", role: "owner" })).toEqual({ class: "permission", code: "owner_immutable", message: "Owner cannot be changed" })
  expect(effects).toBe(0)
  seam.dispose()
})
test("disposed mutation cannot publish or reread", async () => {
  let finish!: (response: Response) => void
  let effects = 0
  const seam = createMembersSeam({ ready: true, http: () => { effects++; return new Promise(resolve => { finish = resolve }) },
    live: { subscribe: () => () => {}, getSnapshot: () => undefined } })
  const mutation = seam.mutate("members.remove", { login: "alice" })
  seam.dispose()
  finish(Response.json({ class: "user", code: "unknown_github_user", message: "GitHub user not found" }, { status: 404 }))
  await mutation
  expect(seam.snapshots.get()).toEqual({})
  expect(effects).toBe(1)
})
test("a missing roster renders no controls or invented rows", () => {
  const html = renderToStaticMarkup(<MembersCard roster={{ get: () => ({}), subscribe: () => () => {} }} role="owner"
    dispatch={() => { throw new Error("unexpected dispatch") }} view={{ maximized: false }} onView={() => {}} />)
  expect(html).toBe("")
})

const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
test("the registry renders the controller's roster: nothing before it reads, its rows after", () => {
  let snapshot: { model?: typeof model } = {}
  const submitted: unknown[] = []
  const controller = { membersRoster: { get: () => snapshot, subscribe: () => () => {} }, membersRole: () => "member",
    commands: { submit: (command: unknown) => { submitted.push(command) } } } as unknown as AppController
  const card = { id: "members", kind: "members", title: "Members", status: "active", createdAt: 1, ordinal: 1, payload: {} } as const
  const render = () => renderToStaticMarkup(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.members.render(card, actions)}</ControllerTestProvider>)
  expect(render()).toBe("")
  snapshot = { model }
  const markup = render()
  for (const login of ["will", "ben", "sam", "lee"]) expect(markup).toContain(login)
  expect(submitted).toEqual([])
})
