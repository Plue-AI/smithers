import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-07.md; not a qualification receipt.
// Written before implementation: mvp.md §6.15, M-25; lands with T-MCH-12
test("C-MCH-07: New sessions receive all-branches secrets while cards keep values private", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.15, M-25; lands with T-MCH-12")
  await owner(page)
  await page.goto("/")
  // Seed old terminal before this write; new sessions get the updated env.
  // API credential matrix, SSH and coding-host redaction require integration evidence.
  await say(page, "/secrets")
  await page.getByRole("textbox", { name: "Name", exact: true }).last().fill("CANARY_TOKEN")
  await page.getByLabel("Value", { exact: true }).last().fill("cycle18-private-canary")
  await page.getByRole("button", { name: "Add", exact: true }).last().press("Enter")
  await expect(page.getByText("CANARY_TOKEN", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("cycle18-private-canary", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("CANARY_TOKEN", { exact: true }).last()).toBeVisible()
  await expect(page.getByLabel("Value", { exact: true }).last()).toHaveValue("")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const input = page.getByRole("textbox", { name: "Terminal input", exact: true }).last()
  await input.fill("test \"$CANARY_TOKEN\" = cycle18-private-canary && test -z \"$DEPLOY_KEY\" && echo scopes-ok")
  await input.press("Enter")
  await expect(page.getByRole("region", { name: "Terminal output", exact: true }).last()).toContainText("scopes-ok")
})

// Card phase only: the install seam, dispatcher and View with transport doubles.
// Machine delivery remains the reference-host phase above.
test("C-MCH-07 card: write-only Add, Replace, scope, live member rows and Delete", async ({ page }) => {
  const { installCloudFixture } = await import("../cloudFixture")
  await installCloudFixture(page, { capabilities: ["identity", "install", "cloud"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: {
    address: { listen: "mac", bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] },
    steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"].map(id => ({ id, state: "done" })),
    this_mac: { memory_gb: 32, disk_free_gb: 200, capacity: 4 }, github: { signed_in: true, app_installed: true }, models: [], chatgpt: false, capacity: 4
  } }))
  let role = "owner"
  const roster = () => ({ members: [{ login: "canary-owner", name: "Owner", role, avatar_url: "https://example.test/avatar.png", color_index: 0, needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/acme/app/settings/access" })
  await page.route("**/api/members", route => route.fulfill({ json: roster() }))
  let rows: { name: string; scope: string; hosts: string[]; actions: never[] }[] = []
  const notices = new Map<string, () => void>()
  let cursor = 1
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t !== "sub") return
    const notify = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: cursor++, data: frame.topic === "members" ? roster() : { secrets: rows } }))
    if (frame.topic === "members" || frame.topic === "secrets") { notices.set(frame.topic, notify); notify() }
    else socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }))
  }))
  const writes: { method: string; body: unknown }[] = []
  let release: (() => void) | undefined
  let hold = true, failNext = false
  await page.route("**/api/secrets{,/**}", async route => {
    const request = route.request(), method = request.method()
    expect(method).not.toBe("GET") // Reads come only from the live topic.
    expect(request.headers()["idempotency-key"]).toBeTruthy()
    const body = method === "DELETE" ? {} : request.postDataJSON()
    writes.push({ method, body })
    if (hold) await new Promise<void>(resolve => { release = resolve })
    if (failNext) { failNext = false; await route.fulfill({ status: 503, json: { class: "infra", code: "unavailable", message: "Secret save failed" } }); return }
    if (method === "PUT") rows = [...rows.filter(row => row.name !== body.name), { name: body.name, scope: body.main_only ? "main_only" : "all_branches", hosts: [], actions: [] }]
    if (method === "PATCH") rows = rows.map(row => ({ ...row, scope: body.main_only ? "main_only" : "all_branches" }))
    if (method === "DELETE") rows = []
    await route.fulfill({ status: method === "DELETE" ? 204 : 200, ...(method === "DELETE" ? {} : { json: {} }) })
    notices.get("secrets")?.()
  })
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 120_000 })
  await say(page, "/secrets")
  const card = page.getByRole("region", { name: "Secrets", exact: true }).last()
  await expect(card).toBeVisible()
  await card.getByLabel("NAME", { exact: true }).fill("CANARY_TOKEN")
  await card.getByLabel("Value", { exact: true }).last().fill("private-canary")
  await expect(card.getByLabel("Value", { exact: true }).last()).toHaveAttribute("value", "")
  expect(await card.innerHTML()).not.toContain("private-canary")
  await card.getByRole("button", { name: "Add", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  await card.getByRole("button", { name: "Add", exact: true }).press("Enter")
  expect(writes.length).toBe(1)
  await expect(card.getByLabel("Value", { exact: true }).last()).toHaveValue("")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  const { fillComposer } = await import("../composer")
  await fillComposer(page, "Chat stays usable")
  await expect(page.getByText("Saving CANARY_TOKEN…", { exact: true }).last()).toBeVisible()
  hold = false; release!()
  await expect(card.locator("li")).toContainText("CANARY_TOKEN")
  const row = card.locator("li")
  await row.getByText("Replace", { exact: true }).first().press("Enter")
  failNext = true
  await row.getByLabel("Value", { exact: true }).fill("failed-private-canary")
  await row.getByRole("button", { name: "Replace", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(2)
  await expect(row.getByLabel("Value", { exact: true })).toHaveValue("")
  await expect(page.getByText("CANARY_TOKEN couldn't be saved (HTTP 503).", { exact: false }).last()).toBeVisible()
  await row.getByLabel("Value", { exact: true }).fill("replacement-canary")
  await row.getByRole("button", { name: "Replace", exact: true }).press("Enter")
  await expect.poll(() => writes.length).toBe(3)
  await expect(row.getByLabel("Value", { exact: true })).toHaveValue("")
  await row.getByRole("button", { name: "main only", exact: true }).press("Enter")
  await expect(row.locator(".secret-scope")).toHaveText("main only")
  page.once("dialog", dialog => { void dialog.dismiss() })
  await row.getByRole("button", { name: "all branches", exact: true }).press("Enter")
  expect(writes.length).toBe(4)
  role = "member"; notices.get("members")!()
  await expect(card.getByRole("button")).toHaveCount(0)
  expect(await card.innerHTML()).not.toContain("private-canary")
  expect(await card.innerHTML()).not.toContain("replacement-canary")
  role = "owner"; notices.get("members")!()
  await page.reload()
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 120_000 })
  await expect(card).toContainText("CANARY_TOKEN")
  await expect(card.getByLabel("Value", { exact: true }).last()).toHaveValue("")
  page.once("dialog", dialog => { void dialog.accept() })
  await row.getByRole("button", { name: "Delete", exact: true }).press("Enter")
  await expect(row).toHaveCount(0)
  expect(writes.length).toBe(5)
})
