import { fillComposer } from "./composer"
import { expect, test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture.ts"

/*
 * Lane citc T1 (docs/workbench-lanes/citc.md "Exit", ADR 0002): against a
 * fake cloud upstream the app opens a box, the card streams
 * starting→running (the seam's settle watch), the box facets show what
 * the upstream answered, and a degraded sign-in refuses a box act with
 * the exact "sign in again to enable" wording.
 *
 * The server is a double: the shared cloud fixture (cloudFixture.ts) answers
 * the bootstrap, the cloud session and the Smithers Cloud inventory; this
 * spec adds the workspace routes behind /api/cloud/*.
 */

const REPO = "smithersai/smithers"

const WS = (status: string, provisioningStage: string | null = null) => ({
  id: "ws-1",
  repo_full_name: REPO,
  name: "review",
  target_bookmark: "main",
  status,
  provisioning_stage: provisioningStage,
  suspended_at: null,
  created_at: "2026-09-01T00:00:00Z"
})

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("T1: /box.open renders the card, streams starting→running, and exposes its supported facets", async ({ page }) => {
  await installCloudFixture(page)
  let polls = 0
  await page.route(new RegExp(`/api/repos/${REPO}/workspaces(\\?.*)?$`), (route) => {
    if (route.request().method() === "POST") return route.fulfill(json(WS("pending", "allocating"), 201))
    return route.fulfill(json([WS("running")]))
  })
  await page.route(`**/api/repos/${REPO}/workspaces/ws-1`, (route) => {
    polls += 1
    return route.fulfill(json(polls < 2 ? WS("starting", "boot") : WS("running")))
  })
  await page.route(`**/api/repos/${REPO}/workspace/sessions`, (route) =>
    route.fulfill(json([])))
  const fileReads: string[] = []
  await page.route((url) => url.pathname === `/api/repos/${REPO}/workspaces/ws-1/files`, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path")
    return route.fulfill(json(path === "my docs"
      ? [{ name: "read me.txt", path: "my docs/read me.txt", type: "file", size: 18 }]
      : [{ name: "my docs", path: "my docs", type: "dir", size: 0 }]))
  })
  await page.route((url) => url.pathname === `/api/repos/${REPO}/workspaces/ws-1/files/content`, (route) => {
    fileReads.push(new URL(route.request().url()).searchParams.get("path") ?? "")
    return route.fulfill(json({ content: "Workspace contents", encoding: "utf-8" }))
  })
  await page.goto("/")

  await fillComposer(page, "/box.open main smithersai/smithers")
  await page.getByTestId("composer-send").click()

  // The card: header names the repo, the bookmark, and the BOOKMARK's head — labeled, never a workspace head.
  const card = page.getByTestId("card-workspace-ws-1")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("smithersai/smithers · main")
  await expect(card).toContainText("bookmark main head @ kxyzqrpv")
  await expect(card).not.toContainText("uptime")
  // The settle watch streams the status: pending → starting → running (the seam polls while unsettled). The card
  // renders the collection's freshest row, so the first paint is whichever landed last — the create's pending or
  // the watch's first poll (starting) — never a status the row has already left.
  await expect(card).toContainText(/Pending|Starting/)
  await expect(card).toContainText("Running", { timeout: 20_000 })

  // This host offers the current workspace facets and lifecycle controls.
  await expect(card.getByRole("tab")).toHaveText(["Terminal", "Files", "Services", "Egress"])
  await expect(card.getByRole("button", { name: "Suspend", exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Delete", exact: true })).toBeVisible()

  const filesTab = card.getByRole("tab", { name: "Files", exact: true })
  await filesTab.focus()
  await page.keyboard.press("Enter")
  const directory = card.getByRole("button", { name: "my docs", exact: true })
  await expect(directory).toHaveAttribute("data-flow", "box.files")
  await expect(directory).toHaveAttribute("data-flow-args", '"my docs" ws-1')
  await directory.focus()
  await page.keyboard.press("Enter")
  const file = card.getByRole("button", { name: "read me.txt", exact: true })
  await expect(file).toHaveAttribute("data-flow", "box.file")
  await expect(file).toHaveAttribute("data-flow-args", '"my docs/read me.txt" ws-1')
  await file.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("card-workspace-file-ws-1-my docs/read me.txt")).toContainText("Workspace contents")
  expect(fileReads).toEqual(["my docs/read me.txt"])
})

test("T1: a degraded sign-in refuses a box act with the exact enable wording", async ({ page }) => {
  await installCloudFixture(page, { degraded: true })
  await page.goto("/")

  await fillComposer(page, "/box.list")
  const listRequests: string[] = []
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/user/workspaces") listRequests.push(request.method())
  })
  await page.getByTestId("composer-send").click()

  const toast = page.locator(".toast-stack .toast-detail")
  await expect(toast).toContainText("sign in again to enable", { timeout: 15_000 })
  await expect(toast).toContainText("This Smithers Cloud sign-in can't use boxes")
  expect(listRequests).toEqual([])
})
