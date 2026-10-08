import { expect, type Page } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import type { MonitorCard } from "@smthrs/rpc/MonitorCard"
import { TodoCardSchema, type TodoCard } from "@smthrs/rpc/TodoCard"

// Script only server state. The app uses its production flow, REST provider,
// live subscription; this is no backend crash receipt.
export async function recoveryFixture(page: Page, model: TodoCard, run?: MonitorCard) {
  model.owner = { login: "canary-owner", name: "Will", avatar_url: "https://example.com/owner.png" }
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: {
    members: [{ login: "canary-owner", name: "Will", avatar_url: "https://example.com/owner.png", color_index: 0,
      role: "owner", needs_access: false, suspended: false, actions: [] }],
    access_url: "https://github.com/smithers-mvp-canary/node/settings/access"
  } }))
  let publish: (() => void) | undefined
  let cursor = 0
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t === "sub" && run && frame.topic === `run:${run.id}`) {
      socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: run }))
    }
    if (frame.t === "sub" && frame.topic === "todo:1") {
      publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: TodoCardSchema.parse(model) }))
      publish()
    }
  }))
  if (run) {
    await page.route("**/api/runs", route => route.fulfill({ json: [run] }))
    await page.route(`**/api/runs/${run.id}/trace*`, route => route.fulfill({ json: run }))
  }
  const writes: { body: unknown; key: string | undefined }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [TodoCardSchema.parse(model)] }))
  await page.route(/\/api\/todos\/1(?:\/answer)?$/, async route => {
    if (route.request().method() === "POST") {
      writes.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] })
      await route.fulfill({ status: 202, json: { state: "accepted", n: 1 } })
    } else await route.fulfill({ json: TodoCardSchema.parse(model) })
  })
  const card = () => page.getByRole("article", { name: "TODO T1", exact: true }).last()
  return {
    writes, card,
    async open() {
      await page.goto("/")
      await say(page, "/todo T1")
      await expect(card()).toBeVisible()
      await page.getByRole("button", { name: "Chat", exact: true }).click()
    },
    async publish() {
      await expect.poll(() => Boolean(publish)).toBe(true)
      publish!()
    },
    async reload() {
      publish = undefined
      await page.reload()
      const takeover = page.getByRole("button", { name: "Use Smithers here", exact: true })
      await expect(page.getByRole("button", { name: "Chat", exact: true }).or(takeover)).toBeVisible({ timeout: 15_000 })
      if (await takeover.isVisible()) await takeover.press("Enter")
      await say(page, "/todo T1")
      await expect(card()).toBeVisible()
    }
  }
}
