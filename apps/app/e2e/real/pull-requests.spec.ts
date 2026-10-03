import { reloadApp } from "./support"
import { bootProductionRepository } from "./repositories-github/production"
import { scenario } from "./coverage/types"
import { fixtureCommentBody } from "./support/values"
import { authenticatedTest as test, readAuthenticatedSession } from "./auth-permissions/profile"
import { command, expect, openComposer, realApi } from "./support/test"
import {
  attachPullRequestEvidence,
  createPullRequestFixture,
  enableProductionVerbose,
  expectFlowOutcome,
  importOwnedPullRequestRepo,
  landingDetail,
  landingList,
  queueLandingThroughAPI,
  readBookmarks,
  readChange,
  readChecks,
  readLanding,
  readReviews,
  trackLandingQueue,
  waitForLandingState,
  withOwnedPullRequestRepo
} from "./pull-requests/remote"

test.setTimeout(600_000)
test.use({ actionTimeout: 30_000 })

test(
  "a private branch becomes a real pull request whose list, commits, empty checks, files, and reload all agree",
  scenario("pull-requests.production-create-detail-tabs", {
    capabilities: ["identity", "cloud"],
    description: "Create a private two-commit branch, import it through the real service, seed its pull request through the real API and open it through the UI, and compare its detail tabs with independent platform reads, including the honest empty-check state.",
    coverage: [
      "action:prs.list", "action:prs.view", "action:prs.tab",
      "host:production", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
      "dimension:private-repository", "dimension:commits", "dimension:checks-empty", "dimension:diff",
      "dimension:keyboard", "dimension:list-status-count", "dimension:reload", "evidence:ui-platform-github-readback"
    ]
  }),
  async ({ page, request, context }, testInfo) => {
    const session = await readAuthenticatedSession(page)
    expect(session, "The authenticated production fixture must establish a session.").toBeDefined()
    await withOwnedPullRequestRepo(page, request, context, session!.login, testInfo, "detail", async (owned) => {
      await importOwnedPullRequestRepo(page, request, owned)
      const checks = await readChecks(page, request, owned)
      expect(checks).toEqual([])
      const created = await createPullRequestFixture(page, request, owned, `Real detail ${owned.marker}`)

      const platform = await readLanding(page, request, owned, created.number)
      expect(platform).toMatchObject({
        number: created.number,
        title: `Real detail ${owned.marker}`,
        state: "open",
        target_bookmark: "main"
      })
      expect(platform.change_ids).toContain(owned.tipChangeId)
      const changes = await Promise.all(platform.change_ids.map((changeId) => readChange(page, request, owned, changeId)))
      expect(changes.map((change) => change.commit_id)).toEqual([owned.firstCommit, owned.featureCommit])
      expect(changes.map((change) => change.description.split("\n")[0])).toEqual([
        `Add first fixture ${owned.marker}`,
        `Add second fixture ${owned.marker}`
      ])

      await command(page, `/prs.list ${owned.fullName}`)
      await expectFlowOutcome(page, "prs.list", owned.fullName, "executed")
      const list = landingList(page, owned.fullName)
      await expect(list.getByText("1 Open", { exact: true })).toBeVisible()
      const row = list.locator(`[data-landing="${created.number}"]`)
      await expect(row).toContainText(`Real detail ${owned.marker}`)
      await row.getByRole("button", { name: new RegExp(`Open pull request #${created.number}:`) }).focus()
      await expect(row.getByRole("button")).toBeFocused()
      await row.getByRole("button").press("Enter")

      const detail = landingDetail(page, created.number)
      await expect(detail).toContainText(`Real detail ${owned.marker}`)
      await expect(detail).toContainText("No checks reported")

      const checksTab = detail.getByRole("tab", { name: /Checks/ })
      await checksTab.click()
      await expect(checksTab).toHaveAttribute("aria-selected", "true")
      await expect(detail).toContainText("No checks reported")

      const commitsTab = detail.getByRole("tab", { name: /Commits/ })
      await commitsTab.focus()
      await commitsTab.press("Enter")
      await expect(commitsTab).toHaveAttribute("aria-selected", "true")
      await expect(detail).toContainText(`Add first fixture ${owned.marker}`)
      await expect(detail).toContainText(`Add second fixture ${owned.marker}`)

      await detail.getByRole("tab", { name: /Files changed/ }).click()
      await expect(detail).toContainText(`src/first-${owned.marker}.txt`)
      await expect(detail).toContainText(`docs/second-${owned.marker}.md`)
      await expect(detail.locator(".ghc-file")).toHaveCount(2)

      await reloadApp(page)
      await bootProductionRepository(page)
      await command(page, `/prs.view ${created.number} ${owned.fullName}`)
      await expectFlowOutcome(page, "prs.view", `${created.number} ${owned.fullName}`, "executed")
      await expect(landingDetail(page, created.number)).toContainText(`Real detail ${owned.marker}`)

      await attachPullRequestEvidence(testInfo, "create-detail-tabs", {
        repository: owned.fullName,
        branch: owned.branch,
        number: created.number,
        changeIds: platform.change_ids,
        commits: changes.map((change) => ({ changeId: change.change_id, commitId: change.commit_id, description: change.description })),
        checks,
        githubTip: owned.featureCommit
      })
    })
  }
)

test(
  "review comments round-trip while the author cannot approve their own pull request",
  scenario("pull-requests.production-review-permission", {
    capabilities: ["identity", "cloud"],
    description: "Post a real review comment from the PR detail flow, then activate Approve and require the platform's self-review denial with unchanged review state.",
    coverage: [
      "action:prs.view", "action:prs.review", "host:production", "path:success",
      "path:permission", "door:slash", "door:button", "dimension:review-comment", "dimension:request-changes", "dimension:self-approval",
      "evidence:ui-platform-review-readback"
    ]
  }),
  async ({ page, request, context }, testInfo) => {
    const session = await readAuthenticatedSession(page)
    expect(session).toBeDefined()
    await withOwnedPullRequestRepo(page, request, context, session!.login, testInfo, "review", async (owned) => {
      await importOwnedPullRequestRepo(page, request, owned)
      const created = await createPullRequestFixture(page, request, owned, `Real review ${owned.marker}`)
      const comment = fixtureCommentBody(`review-note-${owned.marker}`)

      await command(page, `/prs.review ${created.number} comment ${comment} ${owned.fullName}`)
      await expectFlowOutcome(page, "prs.review", `${created.number} comment ${comment} ${owned.fullName}`, "executed")
      const comments = await readReviews(page, request, owned, created.number)
      expect(comments).toEqual(expect.arrayContaining([expect.objectContaining({ type: "comment", body: comment })]))
      await expect(landingDetail(page, created.number)).toContainText(comment)

      const requested = `changes-requested-${owned.marker}`
      await command(page, `/prs.review ${created.number} request-changes ${requested} ${owned.fullName}`)
      await expectFlowOutcome(page, "prs.review", `${created.number} request-changes ${requested} ${owned.fullName}`, "executed")
      const reviewed = await readReviews(page, request, owned, created.number)
      expect(reviewed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "request_changes", body: requested })]))
      await expect(landingDetail(page, created.number)).toContainText(requested)

      const beforeApproval = reviewed.length
      const approvalResponse = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname.endsWith(`/landings/${created.number}/reviews`))
      await landingDetail(page, created.number).getByRole("button", { name: "Approve", exact: true }).click()
      const rejected = await approvalResponse
      expect(rejected.status()).toBe(422)
      await expectFlowOutcome(page, "prs.review", `${created.number} approve ${owned.fullName}`, "failed")
      await expect(page.getByText(/author cannot approve their own landing request/i).last()).toBeVisible()
      const afterApproval = await readReviews(page, request, owned, created.number)
      expect(afterApproval).toHaveLength(beforeApproval)
      expect(afterApproval.some((review) => review.type === "approve")).toBe(false)

      await attachPullRequestEvidence(testInfo, "review-permission", {
        repository: owned.fullName,
        number: created.number,
        comment,
        requested,
        rejectedStatus: rejected.status(),
        reviews: afterApproval.map((review) => ({ type: review.type, body: review.body }))
      })
    })
  }
)

test(
  "landing queues the exact tip and eventually advances main to the merged revision",
  scenario("pull-requests.production-land-git-proof", {
    capabilities: ["identity", "cloud"],
    description: "Land a disposable private pull request from its UI button, require the queued intermediate truth, then prove the worker merged that exact tip into main.",
    coverage: [
      "action:prs.view", "action:prs.land", "host:production", "path:success",
      "door:slash", "door:button", "dimension:queue", "dimension:merge", "dimension:bookmark-advance",
      "evidence:ui-platform-git-state-proof"
    ]
  }),
  async ({ page, request, context }, testInfo) => {
    const session = await readAuthenticatedSession(page)
    expect(session).toBeDefined()
    await withOwnedPullRequestRepo(page, request, context, session!.login, testInfo, "land", async (owned) => {
      await importOwnedPullRequestRepo(page, request, owned)
      const created = await createPullRequestFixture(page, request, owned, `Real land ${owned.marker}`)
      const before = await readBookmarks(page, request, owned)
      const mainBefore = before.find((bookmark) => bookmark.name === "main")
      const tipBefore = await readChange(page, request, owned)
      expect(tipBefore.commit_id).toBe(owned.featureCommit)
      expect(mainBefore?.target_change_id).not.toBe(owned.tipChangeId)

      const landResponse = page.waitForResponse((response) =>
        response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith(`/landings/${created.number}/land`))
      trackLandingQueue(owned, created.number)
      await landingDetail(page, created.number).getByRole("button", { name: /Land \(queue merge\)/ }).click()
      const queueResponse = await landResponse
      const queueBody = await queueResponse.json()
      if (queueResponse.status() === 422 && (await readLanding(page, request, owned, created.number)).state === "open") {
        // An explicit validation refusal accepted no job; cleanup must not
        // wait three minutes for an open PR to become a terminal worker job.
        owned.queuedLandings.splice(owned.queuedLandings.indexOf(created.number), 1)
      }
      expect(queueResponse.status(), JSON.stringify(queueBody)).toBe(202)
      await expectFlowOutcome(page, "prs.land", `${created.number} ${owned.fullName}`, "executed")
      await expect(landingDetail(page, created.number)).toContainText(/queued/i)

      const merged = await waitForLandingState(page, request, owned, created.number, "merged")
      const landedTip = await readChange(page, request, owned)
      const after = await readBookmarks(page, request, owned)
      const mainAfter = after.find((bookmark) => bookmark.name === "main")
      expect(mainAfter?.target_change_id).toBe(owned.tipChangeId)
      expect(landedTip.landed?.landing_request_number).toBe(created.number)
      expect(mainAfter?.target_commit_id).toBe(landedTip.commit_id)
      expect(mainAfter?.target_commit_id).not.toBe(mainBefore?.target_commit_id)

      await attachPullRequestEvidence(testInfo, "land-git-proof", {
        repository: owned.fullName,
        number: created.number,
        landingState: merged.state,
        mainBefore,
        mainAfter,
        expectedTipChange: owned.tipChangeId,
        importedTipCommit: owned.featureCommit,
        landedTipCommit: landedTip.commit_id,
        provenance: landedTip.landed
      })
    })
  }
)

test(
  "a stale land button cannot queue the same pull request twice",
  scenario("pull-requests.production-stale-land-action", {
    capabilities: ["identity", "cloud"],
    description: "Hold a rendered Land action, queue the PR through the real API, then activate the stale button and require a conflict without a second state change.",
    coverage: [
      "action:prs.view", "action:prs.land", "host:production", "path:error",
      "door:button", "dimension:stale-action", "dimension:idempotency", "evidence:platform-state-before-after-stale-click"
    ]
  }),
  async ({ page, request, context }, testInfo) => {
    const session = await readAuthenticatedSession(page)
    expect(session).toBeDefined()
    await withOwnedPullRequestRepo(page, request, context, session!.login, testInfo, "stale", async (owned) => {
      await importOwnedPullRequestRepo(page, request, owned)
      const created = await createPullRequestFixture(page, request, owned, `Real stale ${owned.marker}`)
      const staleButton = landingDetail(page, created.number).getByRole("button", { name: /Land \(queue merge\)/ })
      await expect(staleButton).toBeVisible()

      const queued = await queueLandingThroughAPI(page, request, owned, created.number)
      expect(["queued", "landing", "merged"]).toContain(queued.state)
      const staleResponse = page.waitForResponse((response) =>
        response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith(`/landings/${created.number}/land`))
      await staleButton.click()
      const rejected = await staleResponse
      expect(rejected.status()).toBe(409)
      await expectFlowOutcome(page, "prs.land", `${created.number} ${owned.fullName}`, "failed")
      const after = await readLanding(page, request, owned, created.number)
      expect(["queued", "landing", "merged"]).toContain(after.state)

      await attachPullRequestEvidence(testInfo, "stale-land", {
        repository: owned.fullName,
        number: created.number,
        queuedState: queued.state,
        staleStatus: rejected.status(),
        finalState: after.state
      })
    })
  }
)



test(
  "a missing pull-request number preserves the platform 404 as a failed UI action",
  scenario("pull-requests.production-missing-reference", {
    capabilities: ["identity", "cloud"],
    description: "Open a deliberately nonexistent PR number on the read-only production canary and require the real 404 to remain a visible failed action.",
    coverage: [
      "action:prs.view", "host:production", "path:error", "door:slash", "dimension:missing-reference",
      "dimension:no-mutation", "evidence:http-status-and-visible-failure"
    ]
  }),
  async ({ page, request }, testInfo) => {
    expect(await readAuthenticatedSession(page)).toBeDefined()
    const number = 2_147_483_647
    const repo = "codeplanesmithers/canary-sandbox"
    const repository = await realApi(page, request, "GET", "/api/repos/codeplanesmithers/canary-sandbox")
    expect(repository.status(), "The repository must exist so the later 404 identifies the PR reference.").toBe(200)
    const mutations: string[] = []
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() !== "GET" && path.includes("/landings")) mutations.push(`${request.method()} ${path}`)
    })
    await openComposer(page)
    await enableProductionVerbose(page)
    const reading = page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname.endsWith(`/landings/${number}`))
    await command(page, `/prs.view ${number} ${repo}`)
    const response = await reading
    expect(response.status()).toBe(404)
    await expectFlowOutcome(page, "prs.view", `${number} ${repo}`, "failed")
    await expect(page.getByTestId("transcript")).toContainText(/not found|couldn't be read/i)
    await expect(landingDetail(page, number)).toHaveCount(0)
    expect(mutations).toEqual([])
    await attachPullRequestEvidence(testInfo, "missing-reference", {
      repo,
      repositoryStatus: repository.status(),
      number,
      status: response.status(),
      mutations
    })
  }
)

