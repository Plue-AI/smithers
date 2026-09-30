import type { APIRequestContext, Locator, Page, Response } from "@playwright/test"
import { scenario } from "./coverage/types"
import { authenticatedTest, readAuthenticatedSession } from "./auth-permissions/profile"
import { awaitBoot, expect, productUrl, realApi, reloadApp } from "./support/test"
import { finishFirstVisit } from "./support/first-visit"
import { runSlash } from "./issues/local"
import { newChangeId, pushChangeRevision, withOwnedRepository, type OwnedRepository } from "./portable/owned-repository"

authenticatedTest.setTimeout(240_000)

type Revision = { readonly seq?: number; readonly commit_id?: string }
type ChangeDetail = { readonly current_seq?: number; readonly revisions?: ReadonlyArray<Revision> }
type Comment = { readonly id?: number; readonly state?: string; readonly done_at?: string | null; readonly resolved_at?: string | null }
type ReviewRequest = { readonly id?: number; readonly state?: string; readonly reviewer?: { readonly login?: string } | null }
type ChangeDiff = { readonly file_diffs?: ReadonlyArray<{ readonly path?: string }> }

/** An owned repository whose `fixture` bookmark carries one change with the given revisions, and an open landing request for it. */
type OwnedChange = {
  readonly repo: OwnedRepository
  readonly changeId: string
  readonly commits: ReadonlyArray<string>
  readonly landing: number
  readonly login: string
}

const changeDetail = async (page: Page, request: APIRequestContext, repo: OwnedRepository, changeId: string): Promise<ChangeDetail> => {
  const response = await realApi(page, request, "GET", `${repo.path}/changes/${changeId}`)
  expect(response.status()).toBe(200)
  return await response.json() as ChangeDetail
}

/** Push each revision in order, opening the landing request after the first; every revision is read back before the next. */
const withOwnedChange = async (
  page: Page, request: APIRequestContext, revisions: ReadonlyArray<Readonly<Record<string, string>>>,
  use: (change: OwnedChange) => Promise<void>
): Promise<void> => {
  const login = (await readAuthenticatedSession(page))!.login
  await withOwnedRepository(page, request, async (repo) => {
    const changeId = newChangeId()
    const commits: string[] = []
    let landing = 0
    for (const [index, files] of revisions.entries()) {
      const commit = await pushChangeRevision(page, request, repo, changeId, files)
      commits.push(commit)
      await expect.poll(async () => {
        const detail = await changeDetail(page, request, repo, changeId)
        return detail.revisions?.find((revision) => revision.seq === detail.current_seq)?.commit_id
      }, { timeout: 30_000 }).toBe(commit)
      if (index === 0) {
        const created = await realApi(page, request, "POST", `${repo.path}/landings`, {
          title: `Review ${changeId}`, body: "", source_bookmark: "fixture", target_bookmark: "main", change_ids: [changeId]
        })
        expect(created.status(), await created.text()).toBe(201)
        landing = (await created.json() as { readonly number: number }).number
      }
    }
    expect((await changeDetail(page, request, repo, changeId)).revisions?.map((revision) => revision.commit_id)).toEqual(commits)
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)
    await use({ repo, changeId, commits, landing, login })
  })
}

const changeCard = (page: Page, change: OwnedChange): Locator =>
  page.getByTestId(`card-change-${change.repo.fullName}-${change.changeId}`)

const openChange = async (page: Page, change: OwnedChange): Promise<Locator> => {
  await runSlash(page, `/change.view ${change.changeId}`)
  const card = changeCard(page, change)
  await expect(card).toBeVisible({ timeout: 30_000 })
  return card
}

const pressKey = async (control: Locator): Promise<void> => {
  await control.focus()
  await expect(control).toBeFocused()
  await control.press("Enter")
}

const openFacet = async (card: Locator, name: string): Promise<void> => {
  const tab = card.getByRole("tab", { name, exact: true })
  await pressKey(tab)
  await expect(tab).toHaveAttribute("aria-selected", "true")
}

const posted = (page: Page, method: string, path: string): Promise<Response> =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname.endsWith(path), { timeout: 20_000 })

const commentState = async (page: Page, request: APIRequestContext, change: OwnedChange, id: number): Promise<Comment | undefined> => {
  const response = await realApi(page, request, "GET", `${change.repo.path}/landings/${change.landing}/comments`)
  expect(response.status()).toBe(200)
  return (await response.json() as ReadonlyArray<Comment>).find((comment) => comment.id === id)
}

const reviewRequests = async (page: Page, request: APIRequestContext, change: OwnedChange): Promise<ReadonlyArray<ReviewRequest>> => {
  const response = await realApi(page, request, "GET", `${change.repo.path}/landings/${change.landing}`)
  expect(response.status()).toBe(200)
  return (await response.json() as { readonly review_requests?: ReadonlyArray<ReviewRequest> }).review_requests ?? []
}

const diffPaths = async (page: Page, request: APIRequestContext, repo: OwnedRepository, changeId: string, query = ""): Promise<ReadonlyArray<string>> => {
  const response = await realApi(page, request, "GET", `${repo.path}/changes/${changeId}/diff${query}`)
  expect(response.status()).toBe(200)
  return ((await response.json() as ChangeDiff).file_diffs ?? []).map((file) => String(file.path)).sort()
}

const fileRows = (card: Locator): Locator => card.getByRole("button", { name: /^Open the diff of / })

authenticatedTest("review.done, review.ack and review.reopen move a real review comment and survive reload", scenario("reviews.owned-comment-lifecycle", {
  capabilities: ["identity"],
  coverage: [
    "action:review.done", "action:review.ack", "action:review.reopen", "action:change.view", "action:change.facet",
    "host:local", "path:success", "path:persistence", "path:keyboard", "door:button", "door:slash",
    "dimension:keyboard", "dimension:reload", "surface:change-card", "evidence:landing-comment-api-readback"
  ],
  description: "A review comment on an owned landing moves open → done (card button) → resolved (slash) → open (card button); each step is read back from the landing's comments and the reopened state survives reload."
}), async ({ page, request }) => {
  await withOwnedChange(page, request, [{ "review.txt": "first line\n" }], async (change) => {
    const created = await realApi(page, request, "POST", `${change.repo.path}/landings/${change.landing}/comments`, {
      path: "review.txt", line: 1, side: "right", body: "Name this line.", commit_id: change.commits[0]
    })
    expect(created.status(), await created.text()).toBe(201)
    const id = (await created.json() as { readonly id: number }).id
    expect(await commentState(page, request, change, id)).toMatchObject({ state: "open", done_at: null, resolved_at: null })

    const card = await openChange(page, change)
    await openFacet(card, "Review")
    const comments = card.getByRole("list", { name: "Review comments" })
    await expect(comments).toContainText("Name this line.")
    await expect(comments.getByLabel("comment open")).toBeVisible()

    const done = posted(page, "POST", `/landings/${change.landing}/threads/${id}/done`)
    await pressKey(card.getByRole("button", { name: `Mark comment ${id} done`, exact: true }))
    expect((await done).status()).toBe(200)
    const doneState = await commentState(page, request, change, id)
    expect(doneState).toMatchObject({ state: "done", resolved_at: null })
    expect(doneState?.done_at).toEqual(expect.any(String))
    await expect(comments.getByLabel("comment done")).toBeVisible()

    const acked = posted(page, "POST", `/landings/${change.landing}/threads/${id}/ack`)
    await runSlash(page, `/review.ack ${change.changeId} ${id}`)
    expect((await acked).status()).toBe(200)
    const resolved = await commentState(page, request, change, id)
    expect(resolved?.state).toBe("resolved")
    expect(resolved?.resolved_at).toEqual(expect.any(String))
    await expect(comments.getByLabel("comment resolved")).toBeVisible()
    await expect(card.getByRole("button", { name: `Acknowledge comment ${id}`, exact: true })).toHaveCount(0)

    const reopened = posted(page, "POST", `/landings/${change.landing}/threads/${id}/reopen`)
    await pressKey(card.getByRole("button", { name: `Reopen comment ${id}`, exact: true }))
    expect((await reopened).status()).toBe(200)
    expect(await commentState(page, request, change, id)).toMatchObject({ state: "open", done_at: null, resolved_at: null })
    await expect(comments.getByLabel("comment open")).toBeVisible()

    await reloadApp(page)
    const restored = changeCard(page, change)
    await expect(restored.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(restored.getByRole("list", { name: "Review comments" }).getByLabel("comment open")).toBeVisible()
    await expect(restored.getByRole("button", { name: `Mark comment ${id} done`, exact: true })).toBeVisible()
  })
})

authenticatedTest("review.request asks a real reviewer and review.unrequest dismisses the request from the card", scenario("reviews.owned-request-unrequest", {
  capabilities: ["identity"],
  coverage: [
    "action:review.request", "action:review.unrequest", "action:change.view", "host:local", "path:success", "path:persistence",
    "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:reload", "surface:change-card",
    "evidence:landing-review-request-api-readback"
  ],
  description: "The owner asks themself to review an owned landing through the slash action, then dismisses that request with the card's keyboard-operated Unrequest; the landing's review_requests read back each state and the dismissal survives reload."
}), async ({ page, request }) => {
  await withOwnedChange(page, request, [{ "request.txt": "ask\n" }], async (change) => {
    expect(await reviewRequests(page, request, change)).toEqual([])
    const card = await openChange(page, change)
    await openFacet(card, "Review")

    const asked = posted(page, "POST", `/landings/${change.landing}/review-requests`)
    await runSlash(page, `/review.request ${change.changeId} ${change.login}`)
    const response = await asked
    expect(response.request().postDataJSON()).toEqual({ reviewer: change.login })
    expect(response.status()).toBe(201)
    const requests = await reviewRequests(page, request, change)
    expect(requests).toEqual([expect.objectContaining({ state: "requested", reviewer: expect.objectContaining({ login: change.login }) })])
    const id = requests[0]!.id!
    const listed = card.getByRole("list", { name: "Review requests" })
    await expect(listed).toContainText(change.login)
    await expect(listed).toContainText("requested")

    const dismissed = posted(page, "DELETE", `/landings/${change.landing}/review-requests/${id}`)
    await pressKey(card.getByRole("button", { name: `Dismiss review request ${id}`, exact: true }))
    expect((await dismissed).status()).toBe(204)
    const after = await reviewRequests(page, request, change)
    expect(after.filter((row) => row.state === "requested")).toEqual([])
    await expect(card.getByRole("button", { name: `Dismiss review request ${id}`, exact: true })).toHaveCount(0)

    await reloadApp(page)
    const restored = changeCard(page, change)
    await expect(restored).toBeVisible()
    await expect(restored.getByRole("button", { name: `Dismiss review request ${id}`, exact: true })).toHaveCount(0)
    expect((await reviewRequests(page, request, change)).filter((row) => row.state === "requested")).toEqual([])
  })
})

authenticatedTest("review.since-mine, change.pins and change.checks read a change's recorded revisions", scenario("changes.owned-revision-pins-and-checks", {
  capabilities: ["identity"],
  coverage: [
    "action:review.since-mine", "action:change.pins", "action:change.checks", "action:change.view", "action:change.facet",
    "host:local", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
    "dimension:keyboard", "dimension:reload", "dimension:interdiff", "surface:change-card",
    "evidence:change-diff-and-commit-status-api-readback"
  ],
  description: "An owned change gets two real revisions, the owner's review at rev 1, and a distinct commit status on each revision; the card's since-my-review diff, its revision pickers and its checks picker each match the platform's interdiff and statuses, and the pinned checks revision survives reload."
}), async ({ page, request }) => {
  await withOwnedChange(page, request, [{ "first.txt": "one\n" }, { "first.txt": "one\n", "second.txt": "two\n" }], async (change) => {
    const [rev1, rev2] = change.commits as [string, string]
    const review = await realApi(page, request, "POST", `${change.repo.path}/landings/${change.landing}/reviews`, { type: "comment", body: "Seen.", commit_id: rev1 })
    expect(review.status(), await review.text()).toBe(201)
    for (const [commit, context] of [[rev1, "rev-one-check"], [rev2, "rev-two-check"]] as const) {
      const status = await realApi(page, request, "POST", `${change.repo.path}/statuses/${commit}`, { status: "success", context, description: context })
      expect(status.status(), await status.text()).toBe(201)
    }
    expect(await diffPaths(page, request, change.repo, change.changeId)).toEqual(["first.txt", "second.txt"])
    expect(await diffPaths(page, request, change.repo, change.changeId, "?from=1&to=2")).toEqual(["second.txt"])

    await runSlash(page, `/review.since-mine ${change.changeId}`)
    const card = changeCard(page, change)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByRole("tab", { name: "Diff", exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(card).toContainText("since your review at rev 1 → current")
    await expect(card.getByLabel("Diff from")).toHaveValue("1")
    await expect(fileRows(card)).toHaveText(["second.txt"])

    // The card's "show all" button pins parent → current: the whole change.
    await pressKey(card.getByRole("button", { name: "Show the whole diff, parent to current", exact: true }))
    await expect(card.getByLabel("Diff from")).toHaveValue("parent")
    await expect(card.getByLabel("Diff to")).toHaveValue("current")
    await expect(fileRows(card)).toHaveText(["first.txt", "second.txt"])

    // The revision pickers: parent → rev 1 is the first revision alone.
    const pinned = posted(page, "GET", `/changes/${change.changeId}/diff`)
    await card.getByLabel("Diff to").selectOption("1")
    expect((await pinned).status()).toBe(200)
    await expect(card.getByLabel("Diff to")).toHaveValue("1")
    expect(await diffPaths(page, request, change.repo, change.changeId, "?from=parent&to=1")).toEqual(["first.txt"])
    await expect(fileRows(card)).toHaveText(["first.txt"])

    await openFacet(card, "Checks")
    const picker = card.getByLabel("Checks at revision")
    await expect(picker).toHaveValue("2")
    await expect(card).toContainText("rev-two-check")
    await expect(card).not.toContainText("rev-one-check")
    const read = posted(page, "GET", `/commits/${rev1}/statuses`)
    await picker.selectOption("1")
    expect((await read).status()).toBe(200)
    await expect(picker).toHaveValue("1")
    await expect(card).toContainText("rev-one-check")
    await expect(card).not.toContainText("rev-two-check")
    const statuses = await realApi(page, request, "GET", `${change.repo.path}/commits/${rev1}/statuses?limit=100`)
    expect(statuses.status()).toBe(200)
    expect(JSON.stringify(await statuses.json())).toContain("rev-one-check")

    await reloadApp(page)
    const restored = changeCard(page, change)
    await expect(restored.getByLabel("Checks at revision")).toHaveValue("1")
    await expect(restored).toContainText("rev-one-check")
  })
})

authenticatedTest("change.split moves a named file out of a real change into a new change", scenario("changes.owned-split", {
  capabilities: ["identity"],
  coverage: [
    "action:change.split", "host:local", "path:success", "path:persistence", "door:slash", "dimension:reload",
    "surface:change-card", "evidence:split-change-diff-api-readback"
  ],
  description: "Splitting one path of a two-file owned change renders both returned changes; the platform's diffs show the path moved into the new change and the original keeping the rest, and both cards survive reload."
}), async ({ page, request }) => {
  await withOwnedChange(page, request, [{ "keep.txt": "keep\n", "move.txt": "move\n" }], async (change) => {
    expect(await diffPaths(page, request, change.repo, change.changeId)).toEqual(["keep.txt", "move.txt"])
    const split = posted(page, "POST", `/changes/${change.changeId}/split`)
    await runSlash(page, `/change.split ${change.changeId} move.txt`)
    const response = await split
    expect(response.request().postDataJSON()).toEqual({ paths: ["move.txt"] })
    expect(response.status()).toBe(200)
    const body = await response.json() as { readonly original?: { readonly change_id?: string }; readonly split?: { readonly change_id?: string } }
    expect(body.original?.change_id).toBe(change.changeId)
    const created = body.split?.change_id
    expect(created).toEqual(expect.any(String))
    expect(created).not.toBe(change.changeId)
    expect(await diffPaths(page, request, change.repo, change.changeId)).toEqual(["keep.txt"])
    expect(await diffPaths(page, request, change.repo, created!)).toEqual(["move.txt"])

    const original = changeCard(page, change)
    const moved = page.getByTestId(`card-change-${change.repo.fullName}-${created}`)
    await expect(fileRows(original)).toHaveText(["keep.txt"])
    await expect(fileRows(moved)).toHaveText(["move.txt"])

    await reloadApp(page)
    await expect(fileRows(changeCard(page, change))).toHaveText(["keep.txt"])
    await expect(fileRows(page.getByTestId(`card-change-${change.repo.fullName}-${created}`))).toHaveText(["move.txt"])
  })
})

authenticatedTest("change.revert backs a landed change out into a new change with its own landing request", scenario("changes.owned-revert", {
  capabilities: ["identity"],
  coverage: [
    "action:change.revert", "action:change.view", "host:local", "path:success", "path:persistence", "path:keyboard",
    "door:button", "dimension:keyboard", "dimension:reload", "surface:change-card", "evidence:revert-change-landing-api-readback"
  ],
  description: "Landing an owned change, then pressing Revert on its card with the keyboard, creates a reverting change whose diff touches the landed file and whose landing request targets main; the reverting change's card survives reload."
}), async ({ page, request }) => {
  await withOwnedChange(page, request, [{ "revert.txt": "revert me\n" }], async (change) => {
    const landed = await realApi(page, request, "PUT", `${change.repo.path}/landings/${change.landing}/land`, { commit_id: change.commits[0] })
    expect(landed.status(), await landed.text()).toBe(202)
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", `${change.repo.path}/landings/${change.landing}`)
      expect(response.status()).toBe(200)
      return (await response.json() as { readonly state?: string }).state
    }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe("merged")

    const card = await openChange(page, change)
    const revert = card.getByRole("button", { name: "Revert the landed change" })
    const reverted = posted(page, "POST", `/changes/${change.changeId}/revert`)
    await pressKey(revert)
    const response = await reverted
    expect(response.status()).toBe(201)
    const body = await response.json() as { readonly change_id?: string; readonly landing_request_number?: number }
    const reverting = body.change_id
    expect(reverting).toEqual(expect.any(String))
    expect(reverting).not.toBe(change.changeId)
    expect(body.landing_request_number).toEqual(expect.any(Number))

    expect(await diffPaths(page, request, change.repo, reverting!)).toEqual(["revert.txt"])
    const landing = await realApi(page, request, "GET", `${change.repo.path}/landings/${body.landing_request_number}`)
    expect(landing.status()).toBe(200)
    expect(await landing.json()).toMatchObject({ change_ids: [reverting], target_bookmark: "main", state: "open" })

    const revertCard = page.getByTestId(`card-change-${change.repo.fullName}-${reverting}`)
    await expect(fileRows(revertCard)).toHaveText(["revert.txt"])
    await reloadApp(page)
    await expect(fileRows(page.getByTestId(`card-change-${change.repo.fullName}-${reverting}`))).toHaveText(["revert.txt"])
  })
})
