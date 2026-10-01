import { scenario } from "./coverage/types"
import { authenticatedTest, readAuthenticatedSession } from "./auth-permissions/profile"
import { awaitBoot, closeComposer, command, expect, openComposer, realApi, reloadApp, test } from "./support/test"

const PUBLIC_REPO = "smithersai/smithers"

type ChangeList = {
  readonly items?: ReadonlyArray<{
    readonly change_id?: unknown
    readonly commit_id?: unknown
    readonly description?: unknown
  }>
}

type ChangeDetail = {
  readonly change_id?: unknown
  readonly commit_id?: unknown
  readonly description?: unknown
  readonly current_seq?: unknown
  readonly revisions?: ReadonlyArray<{
    readonly seq?: unknown
    readonly commit_id?: unknown
  }>
}

type ChangeDiff = {
  readonly change_id?: unknown
  readonly file_diffs?: ReadonlyArray<{
    readonly path?: unknown
    readonly change_type?: unknown
    readonly additions?: unknown
    readonly deletions?: unknown
    readonly patch?: unknown
  }>
}

const representativeHunkText = (patch: string): string | undefined => patch
  .split("\n")
  .find((line) => (/^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---") && line.slice(1).trim().length >= 8))
  ?.slice(1).trim()

const currentPublicChange = async (page: Parameters<typeof realApi>[0], request: Parameters<typeof realApi>[1]) => {
  const response = await realApi(page, request, "GET", `/api/repos/${PUBLIC_REPO}/changes?limit=30`)
  expect(response.status()).toBe(200)
  const body = await response.json() as ChangeList
  const change = body.items?.find((row) =>
    typeof row.change_id === "string" && typeof row.commit_id === "string" && typeof row.description === "string")
  expect(change, "The public Smithers mirror must expose at least one concrete jj change").toBeDefined()
  return change as { readonly change_id: string; readonly commit_id: string; readonly description: string }
}

test("a signed-out production user can verify a public change and diff but change.view waits durably for GitHub sign-in", scenario("changes.production-public-read-auth-boundary", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:change.view", "action:auth.prompt", "host:production", "path:permission", "path:persistence",
    "door:slash", "dimension:public-change-read", "dimension:public-diff-read", "dimension:signed-out-deferred-reload",
    "evidence:live-change-and-diff-api-plus-auth-step"
  ],
  description: "The deployed public mirror independently proves a concrete change and nonempty diff exist, while the protected UI flow persists its real GitHub sign-in step and renders no invented change card."
}), async ({ page, request }, testInfo) => {
  const startedAt = performance.now()
  await page.goto(`/${PUBLIC_REPO}`, { waitUntil: "domcontentloaded" })
  const session = await realApi(page, request, "GET", "/api/user")
  expect(session.status()).toBe(401)

  const change = await currentPublicChange(page, request)
  const detailResponse = await realApi(page, request, "GET", `/api/repos/${PUBLIC_REPO}/changes/${change.change_id}`)
  expect(detailResponse.status()).toBe(200)
  const detail = await detailResponse.json() as { readonly change_id?: unknown; readonly commit_id?: unknown }
  expect(detail).toMatchObject({ change_id: change.change_id, commit_id: change.commit_id })
  const diffResponse = await realApi(page, request, "GET", `/api/repos/${PUBLIC_REPO}/changes/${change.change_id}/diff`)
  expect(diffResponse.status()).toBe(200)
  const diff = await diffResponse.json() as { readonly change_id?: unknown; readonly file_diffs?: ReadonlyArray<unknown> }
  expect(diff.change_id).toBe(change.change_id)
  expect(diff.file_diffs?.length).toBeGreaterThan(0)

  // Every read above is an API read; the view is first needed here.
  await awaitBoot(page, "navigate", startedAt)
  await openComposer(page)
  await command(page, `/change.view ${change.change_id}`)
  await closeComposer(page)
  await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="change"]')).toHaveCount(0)
  await reloadApp(page)
  await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="change"]')).toHaveCount(0)
  await testInfo.attach("public-change-read", {
    body: Buffer.from(JSON.stringify({ change, detail, diffFiles: diff.file_diffs?.length }, null, 2)),
    contentType: "application/json"
  })
})

test("review.request issues no mutation while a production user is signed out", scenario("reviews.production-request-auth-boundary", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:review.request", "action:auth.prompt", "host:production", "path:permission", "path:persistence",
    "door:slash", "dimension:no-review-mutation-before-sign-in", "dimension:signed-out-deferred-reload",
    "evidence:network-methods-and-live-change-readback"
  ],
  description: "A real public change establishes the target; review.request parks behind GitHub sign-in, survives reload, and emits no review-request POST while signed out."
}), async ({ page, request }, testInfo) => {
  const startedAt = performance.now()
  await page.goto(`/${PUBLIC_REPO}`, { waitUntil: "domcontentloaded" })
  const session = await realApi(page, request, "GET", "/api/user")
  expect(session.status()).toBe(401)
  const change = await currentPublicChange(page, request)
  const beforeResponse = await realApi(page, request, "GET", `/api/repos/${PUBLIC_REPO}/changes/${change.change_id}`)
  expect(beforeResponse.status()).toBe(200)
  const before = await beforeResponse.json() as { readonly commit_id?: unknown; readonly reviews?: unknown }
  const uiRequests: Array<{ readonly method: string; readonly path: string }> = []
  page.on("request", (event) => {
    const url = new URL(event.url())
    if (url.origin === new URL(page.url()).origin) uiRequests.push({ method: event.method(), path: url.pathname })
  })

  await awaitBoot(page, "navigate", startedAt)
  await openComposer(page)
  await command(page, `/review.request ${change.change_id} codeplanesmithers`)
  await closeComposer(page)
  await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()
  expect(uiRequests.some((event) => event.method === "POST" && event.path.includes("/review-requests"))).toBe(false)
  await reloadApp(page)
  await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()

  const afterResponse = await realApi(page, request, "GET", `/api/repos/${PUBLIC_REPO}/changes/${change.change_id}`)
  expect(afterResponse.status()).toBe(200)
  const after = await afterResponse.json() as { readonly commit_id?: unknown; readonly reviews?: unknown }
  expect(after).toMatchObject({ commit_id: before.commit_id, reviews: before.reviews })
  expect(uiRequests.some((event) => event.method === "POST" && event.path.includes("/review-requests"))).toBe(false)
  await testInfo.attach("review-request-auth-boundary", {
    body: Buffer.from(JSON.stringify({ change, before, after, uiRequests }, null, 2)),
    contentType: "application/json"
  })
})

authenticatedTest("an authenticated production user reads a live change and traverses its durable facets by keyboard", scenario("changes.production-authenticated-facets", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:change.view", "action:change.facet", "host:production", "path:success", "path:keyboard", "path:persistence",
    "door:slash", "door:button", "dimension:authenticated-public-change", "dimension:keyboard", "dimension:history-facet",
    "dimension:review-facet", "dimension:reload", "evidence:live-change-detail-diff-and-session-api"
  ],
  description: "The sanctioned GitHub identity opens a current public mirror change, matches its real revision and diff data, traverses History and Review through keyboard-operated controls, and retains the selected facet after reload."
}), async ({ page, request }, testInfo) => {
  const expectedSession = { login: "codeplanesmithers", admin: true }
  expect(await readAuthenticatedSession(page)).toEqual(expectedSession)
  const startedAt = performance.now()
  await page.goto(`/${PUBLIC_REPO}`, { waitUntil: "domcontentloaded" })
  expect(await readAuthenticatedSession(page)).toEqual(expectedSession)

  const change = await currentPublicChange(page, request)
  const detailResponse = await realApi(page, request, "GET", `/api/repos/${PUBLIC_REPO}/changes/${change.change_id}`)
  expect(detailResponse.status()).toBe(200)
  const detail = await detailResponse.json() as ChangeDetail
  expect(detail).toMatchObject({
    change_id: change.change_id,
    commit_id: change.commit_id,
    description: change.description
  })
  expect(detail.revisions?.length).toBeGreaterThan(0)
  const currentRevision = detail.revisions?.find((revision) => revision.seq === detail.current_seq)
  expect(currentRevision?.commit_id).toBe(change.commit_id)

  const diffResponse = await realApi(page, request, "GET", `/api/repos/${PUBLIC_REPO}/changes/${change.change_id}/diff`)
  expect(diffResponse.status()).toBe(200)
  const diff = await diffResponse.json() as ChangeDiff
  expect(diff.change_id).toBe(change.change_id)
  const firstFile = diff.file_diffs?.find((file) => typeof file.path === "string")
  expect(firstFile, "The live change must expose a named file in its real diff").toBeDefined()

  await awaitBoot(page, "navigate", startedAt)
  await openComposer(page)
  await command(page, `/change.view ${change.change_id}`)
  await closeComposer(page)
  const card = page.getByTestId(`card-change-${PUBLIC_REPO}-${change.change_id}`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText(change.change_id)
  await expect(card).toContainText(change.description.split("\n")[0])
  const diffTab = card.getByRole("tab", { name: "Diff", exact: true })
  await diffTab.focus()
  await expect(diffTab).toBeFocused()
  await diffTab.press("Enter")
  await expect(diffTab).toHaveAttribute("aria-selected", "true")
  await expect(card).toContainText(String(firstFile?.path))

  const history = card.getByRole("tab", { name: "History", exact: true })
  await history.focus()
  await expect(history).toBeFocused()
  await history.press("Enter")
  const revisions = card.getByRole("list", { name: "Revisions" })
  await expect(revisions).toBeVisible()
  await expect(revisions).toContainText(`rev ${String(detail.current_seq)}`)
  await expect(revisions).toContainText(change.commit_id.slice(0, 7))

  const review = card.getByRole("tab", { name: "Review", exact: true })
  await review.focus()
  await expect(review).toBeFocused()
  await review.press("Enter")
  await expect(review).toHaveAttribute("aria-selected", "true")

  await reloadApp(page)
  const restored = page.getByTestId(`card-change-${PUBLIC_REPO}-${change.change_id}`)
  await expect(restored).toBeVisible()
  await expect(restored.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true")
  expect(await readAuthenticatedSession(page)).toEqual(expectedSession)
  await testInfo.attach("authenticated-change-facets", {
    body: Buffer.from(JSON.stringify({ change, detail, firstFile, session: expectedSession }, null, 2)),
    contentType: "application/json"
  })
})

authenticatedTest("an authenticated production user opens the exact live diff through slash and file-row button doors", scenario("changes.production-authenticated-diff-doors", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:change.view", "action:change.diff", "host:production", "path:success", "path:keyboard", "path:persistence",
    "door:slash", "door:button", "dimension:authenticated-public-diff", "dimension:file-row-action", "dimension:keyboard",
    "dimension:reload", "evidence:live-diff-api-and-rendered-file-stat"
  ],
  description: "A live public diff is independently read from production, then the authenticated UI opens the same file and byte counts through both the slash action and the change card's keyboard-operated file row, preserving the rendered diff over reload."
}), async ({ page, request }, testInfo) => {
  const expectedSession = { login: "codeplanesmithers", admin: true }
  expect(await readAuthenticatedSession(page)).toEqual(expectedSession)
  const startedAt = performance.now()
  await page.goto(`/${PUBLIC_REPO}`, { waitUntil: "domcontentloaded" })
  const change = await currentPublicChange(page, request)
  const diffResponse = await realApi(page, request, "GET", `/api/repos/${PUBLIC_REPO}/changes/${change.change_id}/diff`)
  expect(diffResponse.status()).toBe(200)
  const diff = await diffResponse.json() as ChangeDiff
  const file = diff.file_diffs?.find((candidate) =>
    typeof candidate.path === "string" && typeof candidate.change_type === "string" &&
    typeof candidate.additions === "number" && typeof candidate.deletions === "number" &&
    typeof candidate.patch === "string" && representativeHunkText(candidate.patch) !== undefined)
  expect(file, "The live change must expose a nonempty textual patch with exact diff statistics").toBeDefined()
  const path = String(file?.path)
  const hunkText = representativeHunkText(String(file?.patch))
  expect(hunkText, "The selected live patch must contain representative changed text").toBeDefined()

  await awaitBoot(page, "navigate", startedAt)
  await openComposer(page)
  await command(page, `/change.diff ${change.change_id} parent current ${path}`)
  await closeComposer(page)
  const direct = page.getByTestId(`card-diff-${PUBLIC_REPO}-${change.change_id}`)
  await expect(direct).toBeVisible({ timeout: 30_000 })
  await expect(direct).toContainText(path)
  await expect(direct).toContainText(`${String(file?.change_type)} · +${String(file?.additions)} −${String(file?.deletions)}`)
  await expect(direct).toContainText(String(hunkText))

  await openComposer(page)
  await command(page, `/change.view ${change.change_id}`)
  await closeComposer(page)
  const changeCard = page.getByTestId(`card-change-${PUBLIC_REPO}-${change.change_id}`)
  await expect(changeCard).toBeVisible({ timeout: 30_000 })
  const diffTab = changeCard.getByRole("tab", { name: "Diff", exact: true })
  await diffTab.focus()
  await expect(diffTab).toBeFocused()
  await diffTab.press("Enter")
  await expect(diffTab).toHaveAttribute("aria-selected", "true")
  const fileDoor = changeCard.getByRole("button", { name: `Open the diff of ${path}`, exact: true })
  const clickedDiffResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "GET" &&
      url.pathname === `/api/cloud/api/repos/${PUBLIC_REPO}/changes/${change.change_id}/diff` &&
      url.searchParams.get("path") === path
  }, { timeout: 20_000 })
  await fileDoor.focus()
  await expect(fileDoor).toBeFocused()
  await fileDoor.press("Enter")
  const clickedResponse = await clickedDiffResponse
  expect(clickedResponse.status()).toBe(200)
  const clickedUrl = new URL(clickedResponse.url())
  const readback = await realApi(page, request, "GET", clickedUrl.pathname + clickedUrl.search)
  expect(readback.status()).toBe(200)
  const clickedBody = await readback.json() as ChangeDiff
  const clickedFile = clickedBody.file_diffs?.find((candidate) => candidate.path === path)
  expect(clickedFile).toMatchObject({
    path,
    change_type: file?.change_type,
    additions: file?.additions,
    deletions: file?.deletions
  })
  expect(clickedFile?.patch).toBe(file?.patch)
  const fromButton = page.getByTestId(`card-diff-${PUBLIC_REPO}-${change.change_id}`)
  await expect(fromButton).toBeVisible({ timeout: 30_000 })
  await expect(fromButton).toContainText(path)
  await expect(fromButton).toContainText(`${String(file?.change_type)} · +${String(file?.additions)} −${String(file?.deletions)}`)
  await expect(fromButton).toContainText(String(hunkText))

  await reloadApp(page)
  const restored = page.getByTestId(`card-diff-${PUBLIC_REPO}-${change.change_id}`)
  await expect(restored).toContainText(path)
  await expect(restored).toContainText(`${String(file?.change_type)} · +${String(file?.additions)} −${String(file?.deletions)}`)
  await expect(restored).toContainText(String(hunkText))
  expect(await readAuthenticatedSession(page)).toEqual(expectedSession)
  await testInfo.attach("authenticated-change-diff", {
    body: Buffer.from(JSON.stringify({
      change,
      file: { ...file, patch: undefined },
      diffFiles: diff.file_diffs?.length,
      clicked: { status: clickedResponse.status(), path: new URL(clickedResponse.url()).pathname, queryPath: new URL(clickedResponse.url()).searchParams.get("path") },
      hunkText
    }, null, 2)),
    contentType: "application/json"
  })
})