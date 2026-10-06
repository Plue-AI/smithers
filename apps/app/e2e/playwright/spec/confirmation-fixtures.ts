import { expect, type Page } from "../browserTest"
import { owner } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures as confirms } from "../../../../../packages/rpc/test/fixtures/Confirm"
import type { MemberConfirmation } from "@smthrs/rpc/ConfirmCard"

export const id = "10000000-0000-4000-8000-000000000001"
export const privateRow = (merge = false): MemberConfirmation => ({ id, state: "pending", command: merge ? "merge" : "todo.new", revision: "generation-2:h2", expires_at: "2099-01-01T00:00:00Z",
  payload: { input: merge ? {} : { title: "Card model contracts", prompt: "Publish card projections" }, card: merge ? confirms.review_merge.model : { ...confirms.one_click.model, action: { tag: "todo.new", verb: "Commit" } } } })

// Contract fixtures exercise the real live transport, card, typed flows and TODO
// observer. TestConfirmationsBrowserPostgres separately proves real API effects.
export const fixture = async (page: Page, data: (topic: string) => unknown) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: data("members") }))
  const topics = new Map<string, { id: number; cursor: number; send: (value: string) => void }>()
  const publish = (name: string) => {
    const topic = topics.get(name)
    if (topic) topic.send(JSON.stringify({ t: "snap", id: topic.id, cursor: ++topic.cursor, data: data(name) }))
  }
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    if (data(frame.topic) === undefined) { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    topics.set(frame.topic, { id: frame.id, cursor: 0, send: value => socket.send(value) })
    publish(frame.topic)
  }))
  return publish
}
export const roster = (role: "owner" | "member") => ({ members: [{ login: "canary-owner", name: "Owner", avatar_url: "https://github.com/canary-owner.png", color_index: 0, role, needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/acme/api/settings/access" })
export const open = async (page: Page) => {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const confirm = page.locator('[data-kind="confirm"]')
  const takeover = page.getByRole("button", { name: "Use Smithers here", exact: true })
  await expect(confirm.or(takeover)).toBeVisible({ timeout: 60_000 })
  if (await takeover.isVisible()) await takeover.press("Enter")
  await expect(confirm).toBeVisible({ timeout: 60_000 })
  return confirm
}

