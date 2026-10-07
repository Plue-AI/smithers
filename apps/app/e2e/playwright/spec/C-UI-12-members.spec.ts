import { expect, test } from "../browserTest"
import { fillComposer } from "../composer"
import { installCloudFixture } from "../cloudFixture"
import { say } from "./j1-fixtures"

test("C-UI-12: Members reads and edits the install roster through its card", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "will", is_admin: false } }))
  const member = (login: string, role: string, color_index: number) => ({ login, name: login, role, color_index,
    avatar_url: "https://github.com/avatar.png", needs_access: false, suspended: false, actions: [] })
  let members = [member("will", "owner", 0), member("ben", "maintainer", 1)]
  const writes: unknown[] = []
  let finishRead!: () => void
  const held = new Promise<void>(resolve => { finishRead = resolve })
  let reads = 0
  await page.route(/\/api\/members(?:\/[^/?]+)?$/, async route => {
    const request = route.request()
    const login = new URL(request.url()).pathname.split("/").at(-1)
    if (request.method() === "GET") {
      reads++
      await held
      await route.fulfill({ json: { members, access_url: "https://github.com/acme/app/settings/access" } })
      return
    }
    const body = request.postDataJSON()
    writes.push([request.method(), new URL(request.url()).pathname, body])
    if (request.method() === "POST") members = [...members, member(body.login, "maintainer", 2)]
    if (request.method() === "PATCH") members = members.map(row => row.login === login ? { ...row, role: body.role } : row)
    if (request.method() === "DELETE") members = members.filter(row => row.login !== login)
    await route.fulfill({ status: 204 })
  })
  await page.goto("/")
  await say(page, "/members")
  await expect.poll(() => reads).toBeGreaterThan(0)
  const card = page.locator('.members-view')
  await expect(card).toHaveCount(0)
  await fillComposer(page, "Still usable")
  await expect(page.getByTestId("composer-input")).toHaveValue("Still usable")
  await fillComposer(page, "")
  finishRead()
  await expect(card).toBeVisible()
  await expect(card.locator('[data-login="will"] button')).toHaveCount(0)
  await expect(card.locator('[data-login="ben"]')).toContainText("@ben")
  await expect(card.locator('[data-login="maya"]')).toHaveCount(0)
  await card.getByRole("textbox", { name: "GitHub username" }).fill("alice")
  await card.getByRole("button", { name: "Add", exact: true }).press("Enter")
  const alice = card.locator('[data-login="alice"]')
  await expect(alice).toBeVisible()
  await expect(alice.getByRole("combobox", { name: "Role" })).toHaveValue("maintainer")
  await alice.getByRole("combobox", { name: "Role" }).selectOption("member")
  await alice.getByRole("button", { name: "Role", exact: true }).press("Space")
  await expect.poll(() => writes.length).toBe(2)
  await alice.getByRole("button", { name: "Remove", exact: true }).press("Enter")
  const confirmation = alice.getByRole("alertdialog", { name: "Remove @alice?", exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(confirmation).toHaveCount(0)
  await expect(alice).toBeVisible()
  expect(writes).toHaveLength(2)
  await alice.getByRole("button", { name: "Remove", exact: true }).press("Enter")
  await confirmation.getByRole("button", { name: "OK", exact: true }).press("Enter")
  await expect(alice).toHaveCount(0)
  expect(writes).toEqual([
    ["POST", "/api/members", { login: "alice" }],
    ["PATCH", "/api/members/alice", { role: "member" }],
    ["DELETE", "/api/members/alice", null],
  ])
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect(card).toBeVisible()
      const shell = page.locator(".smithers-card").filter({ has: card })
      await shell.getByRole("button", { name: "Maximize card", exact: true }).press("Enter")
      await expect(card).toBeVisible()
      await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
      await expect(card).toBeVisible()
      expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    }
  }
})
