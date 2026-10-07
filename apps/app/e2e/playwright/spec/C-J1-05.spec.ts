import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import type { Page } from "../browserTest"

const say = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.getByRole("button", { name: "Chat", exact: true }).press("Enter")
  await input.fill(text)
  await input.press("Enter")
}

// The mounted install card uses the production dispatcher, MembersSeam and View.
// Provider doubles here do not replace the real-host GitHub/LAN qualification.
test("C-J1-05: keyboard membership, committed rows, live refresh, confirmation and reconnect", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: {
    address: { listen: "mac", bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] },
    steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"].map(id => ({ id, state: "done" })),
    this_mac: { memory_gb: 32, disk_free_gb: 200, capacity: 4 }, github: { signed_in: true, app_installed: true },
    models: [], chatgpt: false, capacity: 4
  } }))
  const row = (login: string, role: string) => ({ login, name: login, role, avatar_url: `https://github.com/${login}.png`, color_index: 0, needs_access: false, suspended: false, actions: [] })
  let rows = [row("canary-owner", "owner")]
  let outage = false, deletes = 0, adds = 0
  let commitRole!: () => void
  const roleCommit = new Promise<void>(resolve => { commitRole = resolve })
  const access = "https://github.com/canary/repository/settings/access"
  await page.route("**/api/members{,/**}", async route => {
    const request = route.request(), method = request.method()
    if (outage) return route.fulfill({ status: 503, json: { class: "infra", code: "unavailable", message: "Members unavailable" } })
    if (method === "GET") return route.fulfill({ json: { members: rows, access_url: access } })
    expect(request.headers()["idempotency-key"]).toBeTruthy()
    if (method === "POST") {
      adds++
      const { login } = request.postDataJSON()
      if (login === "canary-unknown") return route.fulfill({ status: 404, json: { class: "user", code: "unknown_github_user", message: "Unknown GitHub user" } })
      if (login === "canary-no-access") return route.fulfill({ status: 403, json: { class: "user", code: "needs_github_access", message: "Needs access on GitHub", fix: access } })
      rows = [...rows, row(login, login === "canary-maintainer" ? "maintainer" : "member")]
    } else {
      const login = new URL(request.url()).pathname.split("/").at(-1)
      if (method === "PATCH") {
        await roleCommit
        rows = rows.map(member => member.login === login ? { ...member, role: request.postDataJSON().role } : member)
      }
      if (method === "DELETE") { deletes++; rows = rows.filter(member => member.login !== login) }
    }
    await route.fulfill({ status: 204 })
  })
  let notify: (() => void) | undefined
  let disconnect: (() => void) | undefined
  let cursor = 1
  await page.routeWebSocket("**/api/live", socket => {
    disconnect = () => socket.close()
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame.t === "sub" && frame.topic === "members") {
        notify = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: cursor++, data: { members: rows, access_url: access } }))
        notify()
      }
    })
  })
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 20_000 })
  await say(page, "/members")
  const card = page.getByRole("region", { name: "Members", exact: true }).last()
  await expect(card).toBeVisible()
  const username = card.getByLabel("GitHub username", { exact: true })
  for (const login of ["", "bad/name", "-invalid", "a".repeat(40)]) {
    await username.fill(login)
    await card.getByRole("button", { name: "Add", exact: true }).press("Enter")
    await expect(card.locator("li")).toHaveCount(1)
    expect(adds).toBe(0)
  }
  await username.fill("canary-unknown")
  await card.getByRole("button", { name: "Add", exact: true }).press("Enter")
  await expect(card).toContainText("Unknown GitHub user")
  await expect(card.locator('[data-login="canary-unknown"]')).toHaveCount(0)
  expect(adds).toBe(1)
  for (const login of ["canary-maintainer", "canary-member"]) {
    await card.getByLabel("GitHub username", { exact: true }).fill(login)
    await page.keyboard.press("Tab")
    await page.keyboard.press("Enter")
    await expect(card.locator(`li[data-login="${login}"]`)).toBeVisible()
  }
  await expect(card.locator('[data-login="canary-owner"] button')).toHaveCount(0)
  await expect(card.locator('[data-login="canary-maintainer"] select')).toHaveValue("maintainer")
  const member = card.locator('[data-login="canary-member"]')
  await expect(member.getByRole("combobox")).toHaveValue("member")
  await card.getByLabel("GitHub username").fill("canary-no-access")
  await card.getByRole("button", { name: "Add", exact: true }).press("Enter")
  await expect(card.getByRole("link", { name: /needs access on GitHub/ })).toHaveAttribute("href", access)
  await expect(card.locator('[data-login="canary-no-access"]')).toHaveCount(0)
  await member.getByRole("combobox").selectOption("maintainer")
  await member.getByRole("button", { name: "Role", exact: true }).press("Enter")
  // A submitted draft must yield to the committed role while the write is pending.
  await expect(member.getByRole("combobox")).toHaveValue("member")
  commitRole()
  await expect.poll(() => rows.find(row => row.login === "canary-member")?.role).toBe("maintainer")
  // Another viewer changes the authoritative roster; an open card rereads on the notice.
  rows = rows.map(row => row.login === "canary-member" ? { ...row, role: "member" } : row)
  notify!()
  await expect(member.getByRole("combobox")).toHaveValue("member")
  await member.getByRole("button", { name: "Remove", exact: true }).press("Enter")
  const confirmation = member.getByRole("alertdialog", { name: "Remove @canary-member?", exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(confirmation).toHaveCount(0)
  expect(deletes).toBe(0)
  await expect(member).toBeVisible()
  outage = true
  disconnect!()
  await say(page, "/members")
  await expect(page.getByRole("alert").filter({ hasText: "Members unavailable" }).last()).toContainText("Not your fault")
  await expect(member).toBeVisible()
  outage = false
  await page.getByRole("alert").filter({ hasText: "Members unavailable" }).last().getByRole("button", { name: "Retry" }).press("Enter")
  await expect(page.getByRole("alert").filter({ hasText: "Members unavailable" })).toHaveCount(0)
  await member.getByRole("button", { name: "Remove", exact: true }).press("Enter")
  await expect(confirmation).toBeVisible()
  expect(deletes).toBe(0)
  await confirmation.getByRole("button", { name: "OK", exact: true }).press("Enter")
  await expect(member).toHaveCount(0)
  expect(deletes).toBe(1)
  await page.reload()
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 20_000 })
  await say(page, "/members")
  await expect(card.locator('[data-login="canary-maintainer"]')).toBeVisible()
  await expect(card.locator('[data-login="canary-member"]')).toHaveCount(0)
})
