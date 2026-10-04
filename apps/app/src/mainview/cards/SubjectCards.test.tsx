/*
 * The subject cards' bodies (MOCK SEAM, subjects lane): each `design:` card
 * renders through the production entry (renderCardBody) from the seeded
 * world, every press carries its flow name, and a press submits that flow
 * with its literal input: Make TODO is `todo.new`, Please fix is `todo.steer`.
 */
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { act } from "react"
import type { Card } from "@smthrs/rpc/Cards"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { BEN, MAYA, createDesignWorld, type DesignTimers, type DesignWorld } from "../state/seams/DesignWorld"
import { ensureReview, fileCard, fileListCard, issueCard, issueListCard, prCard, reviewCard, wikiCard } from "../state/seams/DesignWorld/subjects"
import { pillStatus, renderCardBody } from "./CardRenderers"
import { createRoot } from "./views/testDom"

const still: DesignTimers = { set: () => 0, clear: () => {} }
const make = (): DesignWorld => createDesignWorld({ timers: still, viewer: MAYA })
const controller = (design: DesignWorld) => {
  const submitted: Array<Record<string, unknown>> = []
  const stub = { design, commands: { submit: (submission: Record<string, unknown>) => { submitted.push(submission); return Promise.resolve({ status: "executed" }) } } }
  return { submitted, controller: stub as unknown as AppController }
}
const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {},
  onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }
const asCard = (row: ReturnType<typeof issueCard>): Card => ({ ...row, status: "active", createdAt: 1, ordinal: 1 } as Card)
const html = (design: DesignWorld, row: ReturnType<typeof issueCard>) =>
  renderToStaticMarkup(<ControllerTestProvider controller={controller(design).controller}>{renderCardBody(asCard(row), actions)}</ControllerTestProvider>)
const flows = (markup: string) => [...markup.matchAll(/data-flow="([^"]+)"/g)].map(match => match[1])

describe("subject card bodies through the renderer door", () => {
  test("an open issue is its thread, Make TODO, Comment and the GitHub link; no status pill", () => {
    const design = make()
    const row = issueCard("acme/api", 231, "Password reset emails arrive twice")
    const markup = html(design, row)
    expect(markup).toContain("deploy every reset request sends two emails. Some people click the first link")
    expect(markup).toContain("Both the legacy mailer and the v2 template handle password.reset.")
    expect(markup).toContain(">Make TODO<")
    expect(flows(markup)).toEqual(["todo.new", "issue.comment"])
    expect(markup).toContain('href="https://github.com/acme/api/issues/231"')
    expect(pillStatus(asCard(row))).toBe("")
  })

  test("an issue a TODO already fixes says Committed as T9 and opens it", () => {
    const markup = html(make(), issueCard("acme/api", 212, "Failed webhooks are never retried"))
    expect(markup).toContain("Committed as")
    expect(markup).toContain(">T9 ↗<")
    expect(flows(markup)).toEqual(["todo", "issue.comment"])
  })

  test("the issue list is one row per open issue, each opening /issue, and New issue", () => {
    const markup = html(make(), issueListCard("acme/api"))
    expect(flows(markup)).toEqual(["issue", "issue", "issue", "issue.new"])
    expect(markup).toContain("#231</span> Password reset emails arrive twice")
    expect(markup).toContain("Alice · 2 h ago · 2")
  })

  test("a branch's files list opens /file with the branch", () => {
    const markup = html(make(), fileListCard("acme/api", "b-retry"))
    expect(markup).toContain("src/webhooks/retry.ts")
    expect(flows(markup)).toEqual(["branch", "file"])
  })

  test("a wiki page shows its revision, authors, the Decision callout and code spans", () => {
    const markup = html(make(), wikiCard("webhook-retries", "Webhook retries"))
    expect(markup).toContain(">r1<")
    expect(markup).toContain("Decision")
    expect(markup).toContain('href="https://github.com/acme/api/pull/87"')
    expect(markup).toContain("<code>backoff(attempt)</code>")
    expect(markup).toContain('data-callout="last"')
  })

  test("a review lists its findings with where, Please fix per finding, Send to the coding agent and Diff", () => {
    const design = make()
    const review = ensureReview(design)
    const markup = html(design, reviewCard("acme/api", review.id))
    expect(markup).toContain(">3 findings<")
    expect(markup).toContain(">retry.ts:14<")
    expect(markup).toContain("redeliver() still sleeps a fixed 30 s.")
    expect(flows(markup)).toEqual(["branch", "file", "todo.steer", "file", "todo.steer", "file", "todo.steer", "todo.steer", "diff"])
    expect(markup).toContain(">Send to the coding agent<")
  })

  test("a dismissed finding loses its Please fix; a clean review offers Diff only", () => {
    const design = make()
    const review = ensureReview(design)
    design.actOnFinding(review.id, 2, "not-useful", MAYA)
    expect(flows(html(design, reviewCard("acme/api", review.id))).filter(flow => flow === "todo.steer")).toHaveLength(3)
    const clean = ensureReview(design, "b-stripe")
    expect(flows(html(design, reviewCard("acme/api", clean.id)))).toEqual(["branch", "diff"])
  })

  test("a PR shows its state, head and base, body, its TODO and the GitHub link", () => {
    const markup = html(make(), prCard("acme/api", 88, "Upgrade the Stripe SDK to v17"))
    expect(markup).toContain(">Open<")
    expect(markup).toContain("smithers/upgrade-stripe → main")
    expect(flows(markup)).toEqual(["todo"])
    expect(markup).toContain('href="https://github.com/acme/api/pull/88"')
  })

  test("a subject the world does not hold renders nothing", () => {
    expect(html(make(), issueCard("acme/api", 999, "Gone"))).toBe("")
    expect(html(make(), wikiCard("nope", "Nope"))).toBe("")
  })
})

describe("subject card presses", () => {
  const mount = async (design: DesignWorld, row: ReturnType<typeof issueCard>) => {
    const stub = controller(design)
    const host = document.body.appendChild(document.createElement("div"))
    const root = createRoot(host)
    await act(async () => root.render(<ControllerTestProvider controller={stub.controller}>{renderCardBody(asCard(row), actions)}</ControllerTestProvider>))
    const press = async (flow: string, nth = 0) => {
      const button = host.querySelectorAll<HTMLElement>(`[data-flow="${flow}"]`)[nth]
      if (button === undefined) throw new Error(`no ${flow} press`)
      await act(async () => button.click())
    }
    return { ...stub, press, close: async () => { await act(async () => root.unmount()); host.remove() } }
  }

  test("Make TODO submits todo.new with the issue's title and body from the issue card", async () => {
    const row = issueCard("acme/api", 231, "Password reset emails arrive twice")
    const h = await mount(make(), row)
    try {
      await h.press("todo.new")
      expect(h.submitted).toEqual([{ name: "todo.new", actor: "user", originCardId: row.id,
        payload: { title: "Password reset emails arrive twice", text: "Since Friday's deploy every reset request sends two emails. Some people click the first link, which has already expired." } }])
    } finally { await h.close() }
  })

  test("Please fix submits todo.steer to the branch's TODO with the finding; Send joins every pending one", async () => {
    const design = make()
    const review = ensureReview(design)
    design.actOnFinding(review.id, 1, "not-useful", BEN)
    const row = reviewCard("acme/api", review.id)
    const h = await mount(design, row)
    try {
      await h.press("todo.steer", 0)
      await h.press("todo.steer", 2)
      await h.press("file", 0)
      expect(h.submitted).toEqual([
        { name: "todo.steer", actor: "user", originCardId: row.id, payload: { n: 9, text: "Please fix src/webhooks/retry.ts:14: redeliver() still sleeps a fixed 30 s." } },
        { name: "todo.steer", actor: "user", originCardId: row.id, payload: { n: 9, text: "Please fix src/webhooks/retry.ts:14: redeliver() still sleeps a fixed 30 s.\nPlease fix src/webhooks/retry.ts:10: Mark the event failed after the last attempt." } },
        { name: "file", actor: "user", originCardId: row.id, payload: { path: "src/webhooks/retry.ts", branch: "b-retry", line: 14 } }
      ])
    } finally { await h.close() }
  })

  test("a File card's hover and definition keys answer from the seed and never reach the registry", async () => {
    const row = fileCard("acme/api", "b-retry", "src/webhooks/retry.ts", 4)
    const h = await mount(make(), row)
    try {
      const surface = document.body.querySelector<HTMLElement>(".code-surface")!
      expect(surface.dataset.flow).toBe("code.hover")
      expect(surface.dataset.flowActivate).toBe("code.definition")
      expect(surface.tabIndex).toBe(0)
      await act(async () => { surface.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true })) })
      expect(document.body.querySelector(".code-hover")?.textContent).toContain("export")
      expect(h.submitted).toEqual([])
    } finally { await h.close() }
  })
})
