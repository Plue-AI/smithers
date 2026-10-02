import { expect, test } from "bun:test"
import { flowArgs } from "./FlowArgs"
import { payloadFor } from "./SlashPayload"
import { runSourceCommand } from "@smthrs/ui/run-command"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, unavailableAgent } from "../state/TestFixtures"

const target = "owner/unloaded", ambient = "owner/ambient"
const cases = [
  ["box.open", { repo: target, kind: "container" }, { repo: target, kind: "container" }],
  ["box.open", { bookmark: "feature/work", repo: target, kind: "vm" }, { bookmark: "feature/work", repo: target, kind: "vm" }],
  // WorkspaceCard's two restore buttons: a snapshot restore and a fresh recovery.
  ["box.open", { repo: target, snapshot: "snap-1", recoveryOf: "ws-1", kind: "vm" }, { repo: target, snapshot: "snap-1", recoveryOf: "ws-1", kind: "vm" }],
  ["box.open", { repo: target, recoveryOf: "ws-1" }, { repo: target, recoveryOf: "ws-1" }],
  ["prs.review", { number: 42, verdict: "approve", repo: target }, { number: 42, verdict: "approve", text: "", repo: target }],
  ["box.open", { repo: target }, { repo: target }],
  ["box.open", { bookmark: "feature/work", repo: target }, { bookmark: "feature/work", repo: target }],
  ["issues.list", { filter: "open", repo: target }, { filter: "open", repo: target }],
  ["triggers.run", { slug: "nightly", repo: target }, { slug: "nightly", repo: target }],
  ["runs.open", { runId: "jobs/run-1", repo: target, sourceCard: "source-list" }, { runId: "jobs/run-1", repo: target, sourceCard: "source-list" }],
  ["runs.list", { status: "running", flow: "jobs/nightly", repo: target }, { status: "running", flow: "jobs/nightly", repo: target }]
] as const

test.each(cases)("%s retains its typed repository with missing or stale inventory", (name, input, expected) => {
  for (const known of [new Set<string>(), new Set([ambient])]) {
    expect(payloadFor(name, flowArgs(name, input), undefined, known)).toEqual({ payload: expected })
  }
})

test("box.open's recovery flags parse from the line its form assembles, in any position", () => {
  expect(payloadFor("box.open", `feature/work ${target} --kind vm --snapshot snap-1 --recoveryOf ws-1`, undefined, new Set()))
    .toEqual({ payload: { bookmark: "feature/work", repo: target, kind: "vm", snapshot: "snap-1", recoveryOf: "ws-1" } })
  expect(payloadFor("box.open", `--recoveryOf ws-1 main ${target}`, undefined, new Set())).toEqual({ payload: { bookmark: "main", repo: target, recoveryOf: "ws-1" } })
  expect(payloadFor("box.open", `${target} --snapshot`, undefined, new Set())).toEqual({ error: "box.open's --snapshot needs an id" })
  expect(payloadFor("box.open", `${target} --kind`, undefined, new Set())).toEqual({ error: "box.open's kind must be container or vm" })
})

test("a mirror ref and its explicit repository need no inventory", () => {
  expect(payloadFor("github.mirror.retry-ref", `refs/heads/main ${target}`, undefined, new Set())).toEqual({ payload: { ref: "refs/heads/main", repo: target } })
})

test("structured targets retain slash-bearing ids and the originating run card", () => {
  const known = new Set(["feature/work", ambient])
  expect(payloadFor("box.open", flowArgs("box.open", { bookmark: "feature/work", repo: target }), undefined, known))
    .toEqual({ payload: { bookmark: "feature/work", repo: target } })
  expect(payloadFor("github.mirror.retry-ref", flowArgs("github.mirror.retry-ref", { ref: "feature/work", repo: target }), undefined, known))
    .toEqual({ payload: { ref: "feature/work", repo: target } })
  const input = { status: "running", flow: "jobs/nightly", repo: target, sourceCard: "original-card" }
  runSourceCommand("ambient-card", (name, args) => {
    expect(payloadFor(name, args, undefined, known)).toEqual({ payload: input })
  })("runs.list", flowArgs("runs.list", input))
})

test("typed argument objects reject misspelled fields instead of silently choosing an ambient target", () => {
  for (const name of ["prs.review", "box.open", "runs.list", "github.mirror.retry-ref"]) {
    expect(payloadFor(name, JSON.stringify({ reop: target }), undefined, new Set())).toHaveProperty("error")
  }
})

test("human review text and lone slash-bearing identifiers retain their existing meaning", () => {
  const known = new Set([ambient])
  expect(payloadFor("prs.review", "42 comment inspect docs/readme", undefined, known))
    .toEqual({ payload: { number: 42, verdict: "comment", text: "inspect docs/readme" } })
  expect(payloadFor("box.open", "feature/work", undefined, known)).toEqual({ payload: { bookmark: "feature/work" } })
  expect(payloadFor("github.mirror.retry-ref", "feature/work", undefined, known)).toEqual({ payload: { ref: "feature/work" } })
  expect(payloadFor("runs.open", "jobs/run-1", undefined, known)).toEqual({ payload: { runId: "jobs/run-1" } })
})

const createAppController = scopedControllers()
test.each([
  ["prs.review", "button"], ["prs.review", "form"], ["prs.review", "agent"],
  ["box.open", "button"], ["box.open", "agent"]
] as const)("%s through %s never routes a typed target through the active repository", async (name, door) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  const controller = createAppController(store, unavailableAgent, { fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url, "https://fixture.invalid").pathname, method = init?.method ?? "GET"
    requests.push({ method, path, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) })
    if (path === `/api/repos/${target}/landings/42`) return Response.json({ number: 42, title: "Review target", body: "", state: "open",
      author: { id: 1, login: "owner" }, change_ids: ["tip"], target_bookmark: "main", conflict_status: "clean", stack_size: 1,
      created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z" })
    if (path === `/api/repos/${target}/changes/tip`) return Response.json({ commit_id: "reviewed-tip" })
    if (path === `/api/repos/${target}/landings/42/reviews`) return Response.json(method === "POST" ? { id: 1 } : [], { status: method === "POST" ? 201 : 200 })
    return Response.json({ message: "Fixture refuses this request" }, { status: 503 })
  } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", admin: false, scopesPlain: null })
  await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "owner", expiresAt: null, scopes: null })
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: ambient, org: "owner", ownerKind: "user", name: "ambient", head: null }] })
  await store.dispatch({ type: "repo.selected", actor: "user", id: ambient })
  const args = name === "prs.review" ? flowArgs(name, { number: 42, verdict: "approve", repo: target }) : name === "box.open" ? flowArgs(name, { repo: target, kind: "container" }) : flowArgs("box.open", { repo: target })
  if (door === "form") {
    await controller.commands.run(name, "")
    for (const [field, value] of [["number", "42"], ["verdict", "approve"], ["repo", target]]) {
      await controller.commands.run("form.set", `form-${name} ${field} ${value}`)
    }
    await controller.commands.run("form.submit", `form-${name}`)
  } else if (door === "agent") {
    // box.open carries no confirmation (the desktop doors that minted sessions did; the MVP cut removed them).
    await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name, args }) })
  } else await controller.commands.run(name, args)
  expect(requests.filter(request => request.path.includes(`/repos/${ambient}/`) && /\/(landings|workspaces)(\/|$)/.test(request.path))).toEqual([])
  expect(requests.filter(request => request.method === "POST")).toEqual(name === "prs.review"
    ? [{ method: "POST", path: `/api/repos/${target}/landings/42/reviews`, body: { type: "approve", body: "", commit_id: "reviewed-tip" } }]
    : [{ method: "POST", path: `/api/repos/${target}/workspaces`, body: { kind: "container" } }])
})
