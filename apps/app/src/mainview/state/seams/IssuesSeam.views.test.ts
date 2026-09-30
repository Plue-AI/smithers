import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { flowArgs } from "../../flows/FlowArgs"
import { payloadFor } from "../../flows/SlashPayload"
import { IssueListCardBody } from "../../cards/IssueCards"

/*
 * Saved issue views (#2269): the repository's factory declares them, the
 * issue list offers them as keyboard-reachable toggles, and selecting one
 * lists through GET .../issues?view=<id> with the selection kept in the card.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type Answer = Response | ((url: URL) => Response)

const backend = (routes: Record<string, Answer>, calls: string[]): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "https://app.test")
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${url.pathname}${url.search}`)
    const answer = routes[`${method} ${url.pathname}`]
    if (answer === undefined) return json(404, { status: "error", message: `no stub for ${url.pathname}` })
    return typeof answer === "function" ? answer(url) : answer.clone()
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const controllerFor = async (routes: Record<string, Answer>) => {
  const calls: string[] = []
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, backend(routes, calls))
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }] })
  await settled()
  return { store, controller, calls }
}

const wireIssue = (number: number) => ({
  id: number * 100, number, title: `Issue ${number}`, body: "", state: "open", labels: [{ id: 1, name: "bug", color: "d73a4a", description: "" }],
  assignees: [], author: { id: 3, login: "ana" }, milestone_id: null, comment_count: 0,
  created_at: "2026-08-10T09:00:00Z", updated_at: "2026-08-11T09:00:00Z", closed_at: null
})

const VIEWS = [{ id: "bugs", title: "Open bugs", state: "open", labels: ["bug"] }, { id: "triage", title: "Triage" }]

const listCard = (store: Awaited<ReturnType<typeof controllerFor>>["store"]): Extract<Card, { kind: "issue-list" }> => {
  const card = store.collections.cards.get("issues-will/flows")
  if (card?.kind !== "issue-list") throw new Error(`no issue list: ${card?.kind}`)
  return card
}

describe("saved issue views in the issue list", () => {
  test("the plain list offers the declared views and keeps GitHub rows", async () => {
    const { store, controller, calls } = await controllerFor({
      "GET /api/repos/will/flows/issues": json(200, [wireIssue(7)]),
      "GET /api/repos/will/flows/issue-views": json(200, [...VIEWS, { id: "", title: "junk" }, "junk"])
    })
    expect((await controller.commands.run("issues.list")).status).toBe("executed")
    await settled()
    const card = listCard(store)
    expect(card.payload.views).toEqual([{ id: "bugs", title: "Open bugs" }, { id: "triage", title: "Triage" }])
    expect(card.payload.view).toBeUndefined()
    expect(calls).toContain("GET /api/repos/will/flows/issues?state=open")
    expect(calls).toContain("GET /api/repos/will/flows/issue-views")
    expect(calls.some((call) => call.startsWith("GET /api/user/github-repos/will/flows/issues"))).toBe(true)
  })

  test("selecting a view lists through it, drops the state and GitHub rows, and keeps the selection in the card", async () => {
    const { store, controller, calls } = await controllerFor({
      "GET /api/repos/will/flows/issues": (url) => json(200, url.searchParams.get("view") === "bugs" ? [wireIssue(9)] : [wireIssue(7), wireIssue(9)]),
      "GET /api/repos/will/flows/issue-views": json(200, VIEWS)
    })
    expect((await controller.commands.run("issues.list", "all --view bugs will/flows")).status).toBe("executed")
    await settled()
    const card = listCard(store)
    expect(card.payload.view).toBe("bugs")
    expect(card.payload.issues.map((issue) => issue.number)).toEqual([9])
    expect(calls).toContain("GET /api/repos/will/flows/issues?view=bugs")
    expect(calls.some((call) => call.includes("state="))).toBe(false)
    expect(calls.some((call) => call.startsWith("GET /api/user/github-repos/"))).toBe(false)

    // Leaving the view is the plain list again.
    expect((await controller.commands.run("issues.list", "open will/flows")).status).toBe("executed")
    await settled()
    expect(listCard(store).payload.view).toBeUndefined()
    expect(listCard(store).payload.issues.map((issue) => issue.number)).toEqual([7, 9])
  })

  test("an undeclared view fails visibly instead of falling back to GitHub", async () => {
    const { store, controller, calls } = await controllerFor({
      "GET /api/repos/will/flows/issues": (url) => url.searchParams.has("view")
        ? json(404, { status: "error", code: "not_found", message: 'issue view "gone" not found' })
        : json(200, []),
      "GET /api/repos/will/flows/issue-views": json(200, VIEWS)
    })
    const outcome = await controller.commands.run("issues.list", "--view gone will/flows")
    await settled()
    expect(outcome.status).toBe("failed")
    expect(JSON.stringify(outcome)).toContain('issue view \\"gone\\" not found')
    expect(calls.some((call) => call.startsWith("GET /api/user/github-repos/"))).toBe(false)
    expect(store.collections.cards.get("issues-will/flows")?.status).toBe("error")
  })

  test("without a repository the form keeps the view and kind it was asked for", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent, backend({}, []))
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
    await settled()
    await controller.commands.run("issues.list", "all --kind issue --view bugs")
    await settled()
    const form = [...store.collections.cards.values()].find((row) => JSON.stringify(row).includes("issues.list"))
    expect(JSON.stringify(form)).toContain("bugs")
  })

  test("a failed or unreadable views read offers no views and keeps the list", async () => {
    for (const answer of [json(500, { message: "down" }), json(200, { not: "a list" })]) {
      const { store, controller } = await controllerFor({
        "GET /api/repos/will/flows/issues": json(200, [wireIssue(7)]),
        "GET /api/repos/will/flows/issue-views": answer
      })
      expect((await controller.commands.run("issues.list")).status).toBe("executed")
      await settled()
      expect(listCard(store).payload.views).toBeUndefined()
      expect(listCard(store).payload.issues).toHaveLength(1)
    }
  })

  test("the slash door parses and refuses --view, and the button door writes it", () => {
    expect(payloadFor("issues.list", "--view bugs acme/web")).toMatchObject({ payload: { filter: "open", view: "bugs", repo: "acme/web" } })
    expect(payloadFor("issues.list", "closed --kind issue --view=bugs")).toMatchObject({ payload: { filter: "closed", kind: "issue", view: "bugs" } })
    expect(JSON.stringify(payloadFor("issues.list", "--view Bugs"))).toContain("saved view id")
    const args = flowArgs("issues.list", { filter: "all", repo: "acme/web", view: "bugs" })
    expect(args).toBe("all --view bugs acme/web")
    expect(payloadFor("issues.list", args)).toMatchObject({ payload: { filter: "all", view: "bugs", repo: "acme/web" } })
    expect(flowArgs("issues.list", { repo: "acme/web", view: "" })).toBe("open acme/web")
  })
})

describe("the issue list card's view toggles", () => {
  const card = (payload: Partial<Extract<Card, { kind: "issue-list" }>["payload"]>): Extract<Card, { kind: "issue-list" }> => ({
    id: "issues-acme/web", kind: "issue-list", title: "Issues · acme/web", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "acme/web", filter: "open", issues: [], ...payload }
  })

  test("renders one pressed-state button per declared view, carrying its flow line", () => {
    const html = renderToStaticMarkup(createElement(IssueListCardBody, {
      card: card({ filter: "all", view: "bugs", views: [{ id: "bugs", title: "Open bugs" }, { id: "triage", title: "Triage" }] }),
      onRunCommand: () => {}
    }))
    expect(html).toContain('aria-label="Views"')
    expect(html.match(/<button[^>]*data-flow="issues.list"[^>]*>Open bugs<\/button>/)?.[0]).toContain('aria-pressed="true"')
    expect(html.match(/<button[^>]*data-flow="issues.list"[^>]*>Triage<\/button>/)?.[0]).toContain('aria-pressed="false"')
  })

  test("pressing a view runs issues.list with it, and pressing the selected one leaves it", () => {
    const runs: Array<[string, string | undefined]> = []
    const element = IssueListCardBody({
      card: card({ filter: "all", view: "bugs", views: [{ id: "bugs", title: "Open bugs" }, { id: "triage", title: "Triage" }] }),
      onRunCommand: (name, args) => void runs.push([name, args])
    })
    const buttons: Array<{ props: { children: unknown; onClick?: () => void } }> = []
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return
      if (Array.isArray(node)) return node.forEach(walk)
      const props = (node as { props?: { children?: unknown; onClick?: () => void } }).props
      if (props === undefined) return
      if ((node as { type?: unknown }).type === "button" && (props.children === "Open bugs" || props.children === "Triage")) buttons.push(node as never)
      walk(props.children)
    }
    walk(element)
    expect(buttons.map((button) => button.props.children)).toEqual(["Open bugs", "Triage"])
    for (const button of buttons) button.props.onClick?.()
    expect(runs).toEqual([["issues.list", "open acme/web"], ["issues.list", "all --view triage acme/web"]])
  })

  test("a kind restriction rides the view toggles, and a selected view rides the kind chips", () => {
    const runs: Array<string | undefined> = []
    const html = renderToStaticMarkup(createElement(IssueListCardBody, {
      card: card({ filter: "all", kind: "issue", view: "bugs", views: [{ id: "bugs", title: "Open bugs" }, { id: "triage", title: "Triage" }] }),
      onRunCommand: (_name, args) => void runs.push(args)
    }))
    expect(html).toContain('data-flow-args="all --kind issue --view triage acme/web"')
    expect(html).toContain('data-flow-args="open --kind issue acme/web"')
    expect(html).toContain('data-flow-args="all --kind conversation --view bugs acme/web"')
  })

  test("no declared views render no toggles", () => {
    const html = renderToStaticMarkup(createElement(IssueListCardBody, { card: card({}), onRunCommand: () => {} }))
    expect(html).not.toContain('aria-label="Views"')
  })
})
