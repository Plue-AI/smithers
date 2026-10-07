import { expect, test } from "../browserTest"
import { owner, say, sourceReady } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// Browser projection of the mirror door. The composed PostgreSQL test proves
// these bytes originate in the mirror; this fixture proves the real app seam
// renders them with no ready machine and preserves the read-only card.
test("C-J1-03: mirrored files render read-only during a held machine build", async ({ page }) => {
  const repo = "smithers-mvp-canary/node"
  await installCloudFixture(page, { capabilities: ["identity", "install"], repos: [{
    owner: "smithers-mvp-canary", name: "node", full_name: repo, default_bookmark: "main", owner_type: "User"
  }] })
  const model = { ...installFixture(), repository: { owner: "smithers-mvp-canary", name: "node" }, repositories: [repo] }
  model.steps[6] = { id: "machine", state: "running", pct: 20 }
  await page.route("**/api/install", route => route.fulfill({ json: model }))
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t === "sub" && frame.topic === "install") socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: model }))
  }))
  const reads: string[] = []
  const writes: string[] = []
  const lsp: string[] = []
  page.on("websocket", socket => { if (socket.url().includes("/lsp")) lsp.push(socket.url()) })
  page.on("request", request => {
    const path = new URL(request.url()).pathname
    if (path.includes("/sessions")) lsp.push(path)
    if (request.method() === "POST" && /\/api\/(?:install\/setup|branches|workspaces)/.test(path)) writes.push(path)
  })
  await page.route("**/api/branches/main/files/**", route => {
    const path = new URL(route.request().url()).pathname
    reads.push(path)
    return route.fulfill({ json: {
      path: "src/mail/expiry.ts", branch: "main", language: "typescript", digest: "a".repeat(40),
      content: { kind: "text", text: "export function sendExpiryEmail() { return 'expiry'; }\n" },
      mode: "read_only", diagnostics: [], authors: [], editors: []
    } })
  })
  await page.goto("/setup")
  await sourceReady(page)
  await say(page, "/file src/mail/expiry.ts")
  const editor = page.getByRole("textbox", { name: "src/mail/expiry.ts", exact: true }).last()
  await expect(editor).toContainText("export function sendExpiryEmail() { return 'expiry'; }")
  await expect(editor).toHaveAttribute("aria-readonly", "true")
  await editor.focus()
  await page.keyboard.press("Control+Space")
  await page.keyboard.press("F12")
  await expect(page.locator(".cm-tooltip")).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await sourceReady(page)
  await page.reload()
  await expect(editor).toContainText("export function sendExpiryEmail() { return 'expiry'; }")
  await expect(editor).toHaveAttribute("aria-readonly", "true")
  await sourceReady(page)
  expect(reads).toEqual(["/api/branches/main/files/src/mail/expiry.ts"])
  expect(writes).toEqual([])
  expect(lsp).toEqual([])
})

// UI projection of .specs/engineering/checks/C-J1-03.md.
// Real host, GitHub, installation and timing receipts remain in the reference-host check.
// Seed requirements: canary Node/Go repositories, owner, held image build,
// mirrored src/mail/expiry.ts, and the access outcomes named below.
// Written before implementation: mvp.md J1; lands with T-APP-15
test("C-J1-03: Source-ready questions show mirrored files while the image builds", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1; lands with T-APP-15")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  await sourceReady(page)
  await say(page, "where do we send the expiry email?")
  const file = page.getByText("src/mail/expiry.ts", { exact: true }).first()
  await expect(file).toBeVisible()
  await file.press("Enter")
  await expect(page.getByText(/function sendExpiryEmail/)).toBeVisible()
  await page.getByRole("button", { name: "Maximize card", exact: true }).last().press("Enter")
  await page.getByText("sendExpiryEmail", { exact: true }).first().hover()
  await page.getByText("sendExpiryEmail", { exact: true }).first().click({ modifiers: ["ControlOrMeta"] })
  await expect(page.getByRole("alert")).toHaveCount(0)
  await sourceReady(page)
  await expect(page.getByText("Starting", { exact: true })).toHaveCount(0)
})
