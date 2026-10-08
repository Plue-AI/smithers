import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "../browserTest"
import { signedOutVisitor } from "../identity"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-ACC-04.md.
// mvp.md J1.8, §6.2 Team sign-in, §6.15, M-05; T-ACC-01 and T-ACC-02.
test("C-ACC-04: roster admission defaults roles and explains missing GitHub access", async ({ page }) => {
  // App-boundary projection through the real Members seam. The composed
  // PostgreSQL/OAuth suite separately qualifies admission and permissions.
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "own", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  const access = "https://github.com/smithers-mvp-canary/node/settings/access"
  const member = (login: string, role: string, color_index: number) => ({ login, name: login, role, color_index,
    avatar_url: "https://example.com/avatar.png", needs_access: false, suspended: false, actions: [] })
  let members = [member("own", "owner", 0)]
  const writes: unknown[] = []
  await page.route("**/api/members", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { members, access_url: access } })
    const body = route.request().postDataJSON()
    writes.push(body)
    if (body.login === "carol") return route.fulfill({ status: 403, json: {
      class: "user", code: "needs_github_access", message: "needs access on GitHub", fix: access
    } })
    members = [...members, member(body.login, body.login === "ben" ? "maintainer" : "member", members.length)]
    return route.fulfill({ status: 204 })
  })
  await page.goto("/")
  await say(page, "/members")
  const card = page.locator(".members-view").last()
  for (const [login, role] of [["ben", "maintainer"], ["alice", "member"]]) {
    await card.getByLabel("GitHub username", { exact: true }).fill(login!)
    await card.getByRole("button", { name: "Add", exact: true }).press("Enter")
    await expect(card.locator(`[data-login="${login}"]`)).toBeVisible()
    await expect(card.locator(`[data-login="${login}"]`).getByRole("combobox", { name: "Role" })).toHaveValue(role!)
  }
  await card.getByLabel("GitHub username", { exact: true }).fill("carol")
  await card.getByRole("button", { name: "Add", exact: true }).press("Enter")
  await expect(card.getByRole("link", { name: /needs access on GitHub/ })).toHaveAttribute("href", access)
  await expect(card.locator('[data-login="carol"]')).toHaveCount(0)
  expect(writes).toEqual([{ login: "ben" }, { login: "alice" }, { login: "carol" }])
  await page.reload()
  await say(page, "/members")
  await expect(card.locator('[data-login="carol"]')).toHaveCount(0)
  await expect(card.locator('[data-login="ben"]').getByRole("combobox", { name: "Role" })).toHaveValue("maintainer")
  await expect(card.locator('[data-login="alice"]').getByRole("combobox", { name: "Role" })).toHaveValue("member")
})

// The install callback serves a typed JSON refusal, not an app redirect.
// The composed OAuth tests qualify the decision; this loopback HTTP fixture
// proves the browser sign-in door reaches and displays that refusal.
for (const refusal of [
  { code: "not_a_member", class: "permission", message: "Not a member" },
  { code: "needs_github_access", class: "permission", message: "Needs access on GitHub ↗",
    fix: "https://github.com/smithers-mvp-canary/node/settings/access" }
]) test(`C-ACC-04: sign-in displays ${refusal.code} without admitting the visitor`, async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test",
    capabilities: ["identity", "install"], authFlow: "redirect", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    requests.push(path)
    if (path === "/api/auth/github") {
      response.writeHead(302, { location: "/api/auth/github/callback?code=refused&state=fixture" }).end()
      return
    }
    if (path === "/api/auth/github/callback") {
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(refusal))
      return
    }
    response.writeHead(404).end()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() })
    })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await page.route("**/api/auth/github**", route => {
      const url = new URL(route.request().url())
      return route.continue({ url: `${origin}${url.pathname}${url.search}` })
    })
    await page.goto("/")
    await say(page, "/auth.prompt")
    const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/github/callback")
    await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).last().press("Enter")
    const result = await response
    expect(result.status()).toBe(403)
    expect(await result.json()).toEqual(refusal)
    expect(result.headers()["set-cookie"]).toBeUndefined()
    await expect(page.locator("body")).toContainText(refusal.message)
    await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
    expect(requests.slice(0, 2)).toEqual(["/api/auth/github", "/api/auth/github/callback"])
    await page.goto("/")
    await say(page, "/auth.prompt")
    await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true }).last()).toBeVisible()
  } finally {
    if (server.listening) {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    }
  }
})
