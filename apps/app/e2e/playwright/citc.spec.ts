import { fillComposer } from "./composer"
import { expect, test } from "./browserTest"
import { owner, say } from "./spec/j1-fixtures"
import { installCloudFixture } from "./cloudFixture"

test("T-APP-10: /branch opens one Branch card and keeps Chat usable", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T9")
  const card = page.locator('.smithers-card[data-kind="branch"][data-testid]').last()
  await expect(card).toBeVisible()
  await expect(card.getByRole("tab", { name: "Activity", exact: true })).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="workspace"]')).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await card.getByRole("button", { name: "Maximize card", exact: true }).press("Enter")
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await page.reload()
  await expect(page.locator('.smithers-card[data-kind="branch"][data-testid]').last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="workspace"]')).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// T-UI-17: dispatcher -> registry -> View/adapter on the non-install seed fallback.
// Machine ownership and frozen live metadata remain T-APP-12/T-TRM-01 receipts.
test("T-UI-17: mounted terminal accepts owner keys and preserves the shell palette while watching", async ({ page }) => {
  await page.goto("/")
  const command = async (line: string) => {
    await fillComposer(page, line)
    await page.getByTestId("composer-send").press("Enter")
    await expect(page.getByTestId("composer-input")).toHaveValue("")
    const input = page.getByTestId("composer-input")
    if (await input.isVisible()) await input.press("Escape")
    if (await input.isVisible()) await input.press("Escape")
  }
  await command("/terminal T9")
  const own = page.locator(".terminal-view").last()
  await expect(own).toBeVisible()
  await own.locator(".xterm-helper-textarea").focus()
  await page.keyboard.type("pnpm test")
  await page.keyboard.press("Enter")
  await expect(own.locator(".xterm-rows")).toContainText("42 passed")
  await expect(page.getByTestId("palette")).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect(page.getByTestId("palette")).toBeVisible()
  await page.keyboard.press("Escape")
  await command("/terminal.watch term-retry-1")
  const watched = page.locator(".terminal-view").last()
  await expect(watched.getByRole("status")).toHaveText("Watching")
  await expect(watched.locator(".terminal-output > div")).toHaveAttribute("inert", "")
  await watched.locator(".terminal-output").click()
  await page.keyboard.press("Tab")
  await expect(watched.locator(".xterm-helper-textarea")).not.toBeFocused()
  await expect(page.getByTestId("palette")).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect(page.getByTestId("palette")).toBeVisible()
})

// HTTP/socket contract proof; native conflict execution remains a composed-install check.
for (const refusal of ["still_conflicted", "stale_conflict", "rebase_execution_unavailable"] as const) {
  test(`T-APP-10: scratch Resolve/Done keeps the bound conflict after ${refusal}`, async ({ page }) => {
    await installCloudFixture(page, { capabilities: ["identity", "install"] })
    const writes: unknown[] = []
    const reads: string[] = []
    const branch = "scratch/ben/retry"
    await page.route("**/api/branches/scratch%2Fben%2Fretry", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { name: branch, machine: { id: "b-conflict" } } })
      writes.push(route.request().postDataJSON())
      expect(route.request().headers()["idempotency-key"]).toBeTruthy()
      return route.fulfill({ status: refusal === "rebase_execution_unavailable" ? 503 : 409,
        json: { code: refusal, class: refusal === "rebase_execution_unavailable" ? "infra" : "conflict", message: "Rebase unavailable" } })
    })
    await page.route("**/api/branches/scratch%2Fben%2Fretry/files/src/retry.ts*", route => {
      reads.push(route.request().url())
      return route.fulfill({ json: { path: "src/retry.ts", branch, language: "typescript", digest: "sha256:conflict",
        content: { kind: "text", text: "export const retry = 2;\n" }, mode: "read_only", diagnostics: [], authors: [], editors: [] } })
    })
    await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
      if (typeof raw !== "string") return
      const frame = JSON.parse(raw)
      if (frame.t !== "sub") return
      const data = frame.topic === "branch:b-conflict" ? {
        id: "b-conflict", name: branch, head: "1111111111111111111111111111111111111111", machine: { state: "awake" },
        scratch: { forked_from: { kind: "main" } }, presence: [], terminals: [],
        rebase: { state: "conflict", onto: "main", paths: ["src/retry.ts"], conflict_change: "conflict-retained", onto_revision: "2222222222222222222222222222222222222222" },
        ssh_line: "ssh -p 2222 retry@localhost"
      } : []
      socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data }))
    }))
    await page.goto("/")
    await say(page, `/branch ${branch}`)
    const card = page.getByTestId("card-branch:b-conflict")
    await expect(card).toContainText("Rebase conflict onto main")
    await card.getByRole("button", { name: "Resolve", exact: true }).press("Enter")
    await expect(page.getByTestId("card-file-branch-scratch/ben/retry-src/retry.ts")).toContainText("export const retry = 2;")
    expect(reads).toHaveLength(1)
    expect(new URL(reads[0]!).pathname).toBe("/api/branches/scratch%2Fben%2Fretry/files/src/retry.ts")
    expect(new URL(reads[0]!).searchParams.get("at")).toBeNull()
    expect(writes).toEqual([])
    await card.getByRole("button", { name: "Done", exact: true }).press("Enter")
    await expect.poll(() => writes).toEqual([{ conflict_change: "conflict-retained", onto_revision: "2222222222222222222222222222222222222222" }])
    await expect(page.getByText("Rebase this branch now didn't run", { exact: true }).last()).toBeVisible()
    await expect(card.getByRole("button", { name: "Done", exact: true })).toBeVisible()
    await expect(card).toContainText("Rebase conflict onto main")
    await expect(card).toContainText("Scratch")
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await page.reload()
    await expect(page.getByTestId("card-branch:b-conflict")).toContainText("Rebase conflict onto main")
    expect(writes).toHaveLength(1)
    await expect(page.locator('.smithers-card[data-kind="todo"]')).toHaveCount(0)
  })
}
