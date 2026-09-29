import { scenario } from "./coverage/types"
import { fixtureCommentBody } from "./support/values"
import type { Request, Response } from "@playwright/test"
import { command, expect, openApp, realApi, reloadApp, test } from "./support/test"
import { authenticatedTest } from "./auth-permissions/profile"
import {
  createIssueThroughUi,
  issueCard,
  readComments,
  readIssue,
  withOwnedImportedRepository
} from "./issues/cloud"
import { attachJson, bootPracticeIssues, openPracticeIssue, practiceIssueCommentCount, PRACTICE_REPO, runSlash } from "./issues/local"
import { expectReproductionEvidence, expectVerifiedGreetingChange, runLiveOperation } from "./issues/live"
import { attachProductionJson, repositoryApiPath, drainOwnedCloudWorkspaces } from "./repositories-github/production"

test.setTimeout(600_000)
test.use({ actionTimeout: 20_000 })
const tutorialTest = (process.env.SMITHERS_REAL_E2E_MODE === undefined ? test : authenticatedTest).extend({ trace: "off", video: "off" })

test(
  "the real practice issue exposes its flow catalog through slash and card doors and restores it after reload",
  scenario("issues.practice-flow-catalog-doors-persistence", {
    capabilities: [],
    description: "Open the shipped practice issue through the real browser host, inspect its installed workflow catalog through the slash command and rendered button, and verify the catalog remains readable after reload.",
    coverage: [
      "action:issues.view", "action:issue.flows", "host:local", "host:production", "path:success", "path:persistence", "path:keyboard",
      "door:slash", "door:button", "dimension:practice-repository", "dimension:flow-catalog", "dimension:reload", "dimension:keyboard",
      "evidence:rendered-workflow-list-and-durable-card"
    ]
  }),
  async ({ page }) => {
    const issue = await openPracticeIssue(page)
    await runSlash(page, `/issue.flows 3 ${PRACTICE_REPO}`)
    const catalog = page.getByTestId("card-practice-issue-flows-3")
    await expect(catalog).toBeVisible()
    await expect(catalog).toHaveAttribute("data-kind", "workflow-list")
    const before = await catalog.textContent()
    expect(before).toMatch(/repro|research|implement/i)

    await issue.getByRole("button", { name: "Issue flows", exact: true }).focus()
    await issue.getByRole("button", { name: "Issue flows", exact: true }).press("Enter")
    await expect(catalog).toBeVisible()
    await reloadApp(page)
    await expect(page.getByTestId("card-practice-issue-flows-3")).toContainText(/repro|research|implement/i)
  }
)

test(
  "practice issue comments and state changes survive a reload and remain keyboard operable",
  scenario("issues.practice-comment-close-reopen-persistence", {
    capabilities: [],
    description: "Exercise the shipped practice issue through its real UI and durable browser database, including keyboard comment submit, close, reload readback, and reopen.",
    coverage: [
      "action:issues.list", "action:issues.view", "action:issues.comment", "action:issues.close", "action:issues.reopen",
      "host:local", "host:production", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
      "dimension:practice-repository", "dimension:reload", "dimension:comment-readback", "dimension:keyboard",
      "evidence:sqlite-ui-readback"
    ]
  }),
  async ({ page }, testInfo) => {
    const marker = fixtureCommentBody(`practice-comment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
    let card = await openPracticeIssue(page)
    const initiallyClosed = card.getByRole("button", { name: "Reopen issue", exact: true })
    if (await initiallyClosed.isVisible().catch(() => false)) {
      await initiallyClosed.click()
      await expect(card.getByRole("button", { name: "Close issue", exact: true })).toBeVisible()
    }
    const initialCommentCount = await practiceIssueCommentCount(card)
    const comment = card.getByRole("textbox", { name: "Add a comment" })
    await comment.fill(marker)
    await comment.press("ControlOrMeta+Enter")
    await expect(card).toContainText(marker)
    await expect.poll(() => practiceIssueCommentCount(card)).toBe(initialCommentCount + 1)

    const close = card.getByRole("button", { name: "Close issue", exact: true })
    await close.focus()
    await expect(close).toBeFocused()
    await close.press("Enter")
    await expect(card).toContainText("Closed")
    await expect(card.getByRole("button", { name: "Reopen issue", exact: true })).toBeVisible()

    await page.reload({ waitUntil: "domcontentloaded" })
    await bootPracticeIssues(page, "all")
    await runSlash(page, `/issues.view 3 ${PRACTICE_REPO}`)
    card = page.getByTestId("card-practice-issues")
    await expect(card.locator('article[data-issue="3"]')).toBeVisible()
    await expect(card).toContainText(marker)
    await expect(card).toContainText("Closed")

    const reopen = card.getByRole("button", { name: "Reopen issue", exact: true })
    await reopen.focus()
    await expect(reopen).toBeFocused()
    await reopen.press("Enter")
    await expect(card).toContainText("Open")
    await page.reload({ waitUntil: "domcontentloaded" })
    await bootPracticeIssues(page)
    await runSlash(page, `/issues.view 3 ${PRACTICE_REPO}`)
    card = page.getByTestId("card-practice-issues")
    await expect(card.locator('article[data-issue="3"]')).toBeVisible()
    await runSlash(page, `/issues.list open ${PRACTICE_REPO}`)
    card = page.getByTestId("card-practice-issues")
    await expect(card.locator('[data-issue="3"]')).toContainText('GET /hello without a name replies "Hello, null!"')
    await expect(card.locator('[data-issue="3"]').getByRole("img", { name: "Open", exact: true })).toBeVisible()
    const finalCommentCount = initialCommentCount + 1
    await expect(card.locator('[data-issue="3"]').getByLabel(`${finalCommentCount} comments`, { exact: true })).toBeVisible()

    await attachJson(testInfo, "practice-issue-lifecycle", {
      repo: PRACTICE_REPO,
      issue: 3,
      marker,
      initialCommentCount,
      finalCommentCount,
      finalState: "open",
      reloads: 2,
      commentSubmit: "ControlOrMeta+Enter"
    })
  }
)

test(
  "anonymous issue creation parks behind sign-in without contacting the issue service",
  scenario("issues.anonymous-create-permission-boundary", {
    capabilities: ["identity", "cloud"],
    description: "Submit a concrete issue-create command while signed out, prove the UI durably parks it behind GitHub sign-in, and prove no issue write reached the deployed service.",
    coverage: [
      "action:issues.create", "action:auth.prompt", "host:production", "path:permission", "path:persistence",
      "door:slash", "dimension:signed-out", "dimension:no-server-mutation", "dimension:reload",
      "evidence:session-api-auth-card-and-request-observer"
    ]
  }),
  async ({ page, request }) => {
    await openApp(page)
    const session = await realApi(page, request, "GET", "/api/user")
    expect(session.status()).toBe(401)

    const issueWrites: string[] = []
    page.on("request", (outbound) => {
      const url = new URL(outbound.url())
      if (outbound.method() === "POST" && /\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname)) issueWrites.push(url.pathname)
    })
    const marker = `sol12-denied-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    await runSlash(page, `/issues.create ${marker} codeplanesmithers/canary-sandbox`)
    // The refusal includes the flow's current summary. Bind the sign-in door
    // to this command's message, so the permanent chrome cannot satisfy it.
    const refusal = page.locator(".smithers-chat-message").filter({
      has: page.getByText(/^Sign in(?: with GitHub)? to create an issue(?:[.,]|$)/)
    }).last()
    const signIn = refusal.locator('button[data-flow="auth.sign-in"]')
    await expect(refusal).toBeVisible()
    await expect(signIn).toBeVisible()
    expect(issueWrites).toEqual([])

    await reloadApp(page)
    await expect(refusal).toBeVisible()
    await expect(signIn).toBeVisible()
    expect(issueWrites).toEqual([])
    expect((await realApi(page, request, "GET", "/api/user")).status()).toBe(401)
  }
)

tutorialTest(
  "practice issue research runs a real reproduction and preserves its completed evidence",
  scenario("issues.practice-live-reproduction", {
    capabilities: [],
    description: "Launch the issue's live research service from its rendered button, verify the durable server run completed a reproduction, and compare it with the UI artifact.",
    coverage: [
      "action:issues.view", "action:issue.repro", "host:production", "path:success", "door:button",
      "dimension:practice-repository", "dimension:real-workflow", "dimension:reproduction", "dimension:server-readback",
      "evidence:live-run-api-and-ui-result"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const issue = await openPracticeIssue(page)
    const run = await runLiveOperation(page, request, "research", async () => {
      await issue.getByRole("button", { name: "Research / repro", exact: true }).click()
    })
    const card = page.getByTestId("card-live-tutorial-research")
    await expect(card).toBeVisible()
    await expect(card.locator('[aria-label="Run trace"] [data-status="completed"]')).not.toHaveCount(0)
    expectReproductionEvidence(run)
    // The card renders Markdown; compare its summary as visible text.
    await expect(card).toContainText(run.result!.split(/\n\s*\n/)[0]!.replace(/`/g, ""))
    await attachJson(testInfo, "live-issue-reproduction", run)
  }
)

tutorialTest(
  "practice issue proof of concept completes with independently verified files and tests",
  scenario("issues.practice-live-poc-artifacts", {
    capabilities: [],
    description: "Run the live proof-of-concept service from the issue card and require completed file, diff, and passing-test artifacts from the server and UI.",
    coverage: [
      "action:issues.view", "action:issue.poc", "host:production", "path:success", "door:button",
      "dimension:practice-repository", "dimension:real-workflow", "dimension:proof-of-concept", "dimension:artifact-verification",
      "evidence:live-run-files-diff-tests"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const issue = await openPracticeIssue(page)
    const run = await runLiveOperation(page, request, "poc", async () => {
      await issue.getByRole("button", { name: "Proof of concept", exact: true }).click()
    })
    expectVerifiedGreetingChange(run)
    const card = page.getByTestId("card-live-tutorial-poc")
    await expect(card).toContainText("Tests passed")
    await expect(card.locator('[aria-label="Run trace"] [data-status="completed"]')).not.toHaveCount(0)
    await attachJson(testInfo, "live-issue-poc", run)
  }
)

tutorialTest(
  "practice issue implementation completes the real plan and exposes verified change artifacts",
  scenario("issues.practice-live-implementation-artifacts", {
    capabilities: [],
    description: "Research issue 3, obtain a real plan, start its real implementation, and verify the completed commits, files, tests, and rendered diff.",
    coverage: [
      "action:issues.view", "action:issue.repro", "action:issue.implement", "action:agent.change.start",
      "host:production", "path:success", "door:button",
      "dimension:practice-repository", "dimension:real-workflow", "dimension:implementation", "dimension:artifact-verification",
      "evidence:live-plan-run-commits-files-diff-tests"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const issue = await openPracticeIssue(page)
    const research = await runLiveOperation(page, request, "research", async () => {
      await issue.getByRole("button", { name: "Research / repro", exact: true }).click()
    })
    expectReproductionEvidence(research)

    const plan = await runLiveOperation(page, request, "plan", async () => {
      await issue.getByRole("button", { name: "Implement", exact: true }).click()
    })
    expect(plan.plan?.id).toBe(plan.runId)
    expect(plan.plan?.baseCommitId).toBe(plan.baseCommitId)
    expect(plan.plan?.steps.length).toBeGreaterThan(0)
    expect(plan.plan?.files.length).toBeGreaterThan(0)
    const planCard = page.getByTestId("card-practice-plan")
    await expect(planCard.getByRole("button", { name: "Start implementation", exact: true })).toBeVisible()

    const implementation = await runLiveOperation(page, request, "implement", async () => {
      await planCard.getByRole("button", { name: "Start implementation", exact: true }).click()
    })
    expect(implementation.plan?.id).toBe(plan.runId)
    expect(implementation.baseCommitId).toBe(plan.plan?.baseCommitId)
    expectVerifiedGreetingChange(implementation)
    expect(implementation.commits).toHaveLength(1)
    const commit = implementation.commits![0]!
    expect(commit.commitId).toMatch(/^[a-f0-9]{40}$/)
    expect(commit.parentCommitId).toBe(plan.plan?.baseCommitId)
    expect(commit.files.slice().sort()).toEqual((implementation.diff ?? []).map((file) => file.path).sort())
    expect(commit.additions + commit.deletions).toBeGreaterThan(0)

    const runCard = page.locator('.smithers-card[data-kind="run-trace"]').filter({ hasText: "Implement the fix" }).last()
    await expect(runCard).toContainText("Tests passed")
    await runCard.getByRole("button", { name: "View diff", exact: true }).click()
    const diff = page.locator('.smithers-card[data-kind="diff"]').last()
    await expect(diff).toBeVisible()
    for (const file of implementation.diff ?? []) await expect(diff).toContainText(file.path)
    await attachJson(testInfo, "live-issue-implementation", { research, plan, implementation })
  }
)

test(
  "practice issue validation and issue-number isolation preserve neighboring state",
  scenario("issues.practice-invalid-and-number-isolation", {
    capabilities: [],
    description: "Reject a missing practice issue and a blank comment, then prove mutations on issue 3 do not alter issue 2 across list refreshes.",
    coverage: [
      "action:issues.list", "action:issues.view", "action:issues.comment", "action:issues.close",
      "host:local", "path:error", "path:persistence", "door:slash", "door:button",
      "dimension:practice-repository", "dimension:invalid-number", "dimension:blank-comment", "dimension:issue-isolation",
      "evidence:visible-validation-and-neighbor-readback"
    ]
  }),
  async ({ page }, testInfo) => {
    await bootPracticeIssues(page)
    await command(page, `/issues.view 999 ${PRACTICE_REPO}`)
    await expect(page.getByText("No issue #999 in hello-server.", { exact: true }).last()).toBeVisible()

    await runSlash(page, `/issues.view 3 ${PRACTICE_REPO}`)
    let card = page.getByTestId("card-practice-issues")
    const initiallyClosed = card.getByRole("button", { name: "Reopen issue", exact: true })
    if (await initiallyClosed.isVisible().catch(() => false)) {
      await initiallyClosed.click()
      await expect(card.getByRole("button", { name: "Close issue", exact: true })).toBeVisible()
    }
    const commentsBeforeBlank = await practiceIssueCommentCount(card)
    const comment = card.getByRole("textbox", { name: "Add a comment" })
    await comment.fill("   ")
    await expect(card.getByRole("button", { name: "Comment", exact: true })).toBeDisabled()
    await comment.press("ControlOrMeta+Enter")
    await expect.poll(() => practiceIssueCommentCount(card)).toBe(commentsBeforeBlank)
    await card.getByRole("button", { name: "Close issue", exact: true }).click()
    await expect(card).toContainText("Closed")

    await runSlash(page, `/issues.view 2 ${PRACTICE_REPO}`)
    card = page.getByTestId("card-practice-issues")
    await expect(card.locator('article[data-issue="2"]')).toContainText("Open")
    await expect(card.locator('article[data-issue="2"]')).toContainText("0 comments")

    await runSlash(page, `/issues.list all ${PRACTICE_REPO}`)
    card = page.getByTestId("card-practice-issues")
    await expect(card.locator('[data-issue="3"]').getByRole("img", { name: "Closed", exact: true })).toBeVisible()
    await expect(card.locator('[data-issue="2"]').getByRole("img", { name: "Open", exact: true })).toBeVisible()
    await runSlash(page, `/issues.reopen 3 ${PRACTICE_REPO}`)

    await attachJson(testInfo, "practice-issue-validation-isolation", {
      invalidIssue: 999,
      rejectedComment: "three spaces",
      commentsBeforeBlank,
      mutatedIssue: 3,
      neighboringIssue: { number: 2, state: "open", comments: 0 },
      cleanup: "issue 3 reopened"
    })
  }
)

authenticatedTest(
  "a private cloud issue survives comment, close, stale refresh, and reopen through the deployed service",
  scenario("issues.production-private-lifecycle-stale-refresh", {
    capabilities: ["identity", "cloud"],
    description: "Provision and import a uniquely owned private repository, drive its Smithers Cloud issue through the rendered UI, independently re-read each server mutation, and remove both the mirror and GitHub source.",
    coverage: [
      "action:issues.create", "action:issues.view", "action:issues.comment",
      "action:issues.close", "action:issues.reopen", "host:production", "path:success", "path:persistence",
      "door:slash", "door:button", "dimension:authenticated-private-repository", "dimension:reload",
      "dimension:stale-detail-refresh", "dimension:comment-readback", "evidence:ui-server-readback-and-terminal-cleanup"
    ]
  }),
  async ({ page, context, request }, testInfo) => {
    await withOwnedImportedRepository({ page, context, request }, testInfo, async (fixture) => {
      const title = `sol12 lifecycle ${Date.now()} ${Math.random().toString(36).slice(2, 9)}`
      const marker = fixtureCommentBody(`sol12-comment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
      const created = await createIssueThroughUi(fixture, title)
      expect(await readIssue(page, request, fixture.repo, created.number)).toMatchObject({
        number: created.number,
        title,
        state: "open"
      })

      const commentPath = repositoryApiPath(fixture.repo, `/issues/${created.number}/comments`)
      const commenting = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === commentPath)
      const comment = created.card.getByRole("textbox", { name: "Add a comment" })
      await comment.fill(marker)
      await comment.press("ControlOrMeta+Enter")
      expect((await commenting).status()).toBe(201)
      await expect(created.card).toContainText(marker)
      const comments = await readComments(page, request, fixture.repo, created.number)
      expect(comments.some((entry) => entry.body === marker)).toBe(true)

      const issuePath = repositoryApiPath(fixture.repo, `/issues/${created.number}`)
      const closing = page.waitForResponse((response) =>
        response.request().method() === "PATCH" && new URL(response.url()).pathname === issuePath)
      await created.card.getByRole("button", { name: "Close issue", exact: true }).click()
      expect((await closing).status()).toBe(200)
      expect(await readIssue(page, request, fixture.repo, created.number)).toMatchObject({ state: "closed" })

      await reloadApp(page)
      await runSlash(page, `/issues.view ${created.number} ${fixture.repo}`)
      let card = issueCard(page, fixture.repo, created.number)
      await expect(card).toContainText(title)
      await expect(card).toContainText(marker)
      await expect(card.getByRole("button", { name: "Reopen issue", exact: true })).toBeVisible()

      const reopening = page.waitForResponse((response) =>
        response.request().method() === "PATCH" && new URL(response.url()).pathname === issuePath)
      await card.getByRole("button", { name: "Reopen issue", exact: true }).click()
      expect((await reopening).status()).toBe(200)
      expect(await readIssue(page, request, fixture.repo, created.number)).toMatchObject({ state: "open" })

      // Change the authoritative state behind the currently open card. The
      // next UI mutation must re-fetch the detail instead of preserving its
      // stale Open label or losing the existing comment.
      const externalClose = await realApi(page, request, "PATCH", issuePath, { state: "closed" })
      expect(externalClose.status()).toBe(200)
      const staleMarker = `${marker}-after-stale-close`
      const staleCommenting = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === commentPath)
      await card.getByRole("textbox", { name: "Add a comment" }).fill(staleMarker)
      await card.getByRole("button", { name: "Comment", exact: true }).click()
      expect((await staleCommenting).status()).toBe(201)
      card = issueCard(page, fixture.repo, created.number)
      await expect(card).toContainText("Closed")
      await expect(card).toContainText(marker)
      await expect(card).toContainText(staleMarker)
      expect(await readIssue(page, request, fixture.repo, created.number)).toMatchObject({ state: "closed" })

      const finalReopen = page.waitForResponse((response) =>
        response.request().method() === "PATCH" && new URL(response.url()).pathname === issuePath)
      await card.getByRole("button", { name: "Reopen issue", exact: true }).click()
      expect((await finalReopen).status()).toBe(200)
      const finalIssue = await readIssue(page, request, fixture.repo, created.number)
      const finalComments = await readComments(page, request, fixture.repo, created.number)
      expect(finalIssue).toMatchObject({ title, state: "open" })
      expect(finalComments.filter((entry) => entry.body === marker || entry.body === staleMarker)).toHaveLength(2)
      await attachProductionJson(testInfo, "private-cloud-issue-lifecycle", {
        repo: fixture.repo,
        issue: created.number,
        title,
        comments: [marker, staleMarker],
        finalIssue,
        finalCommentCount: finalComments.length
      })
    })
  }
)

authenticatedTest(
  "same-number issues and comments remain isolated between two owned private cloud repositories",
  scenario("issues.production-private-repository-isolation", {
    capabilities: ["identity", "cloud"],
    description: "Import two uniquely owned private repositories, create same-number Smithers Cloud issues, mutate only the first, and prove both UI lists and direct service reads remain repository-scoped before complete cleanup.",
    coverage: [
      "action:issues.create", "action:issues.list", "action:issues.comment",
      "host:production", "path:success", "path:persistence", "door:slash", "door:button",
      "dimension:authenticated-private-repository", "dimension:repository-isolation", "dimension:same-issue-number",
      "evidence:two-repository-ui-and-server-readback-with-terminal-cleanup"
    ]
  }),
  async ({ page, context, request }, testInfo) => {
    await withOwnedImportedRepository({ page, context, request }, testInfo, async (first) => {
      // Issue isolation needs the repositories, not idle sandbox capacity.
      await drainOwnedCloudWorkspaces(page, request, first.repo)
      await withOwnedImportedRepository({ page, context, request }, testInfo, async (second) => {
        const marker = `sol12-isolation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const firstTitle = `${marker}-first`
        const secondTitle = `${marker}-second`
        const firstIssue = await createIssueThroughUi(first, firstTitle)
        const secondIssue = await createIssueThroughUi(second, secondTitle)
        expect(firstIssue.number).toBe(secondIssue.number)

        await runSlash(page, `/issues.list all ${first.repo}`)
        const firstList = page.locator('.smithers-card[data-kind="issue-list"]').filter({ hasText: first.repo }).last()
        await expect(firstList).toContainText(firstTitle)
        await expect(firstList).not.toContainText(secondTitle)
        await runSlash(page, `/issues.list all ${second.repo}`)
        const secondList = page.locator('.smithers-card[data-kind="issue-list"]').filter({ hasText: second.repo }).last()
        await expect(secondList).toContainText(secondTitle)
        await expect(secondList).not.toContainText(firstTitle)

        await runSlash(page, `/issues.view ${firstIssue.number} ${first.repo}`)
        const firstCard = issueCard(page, first.repo, firstIssue.number)
        const commentMarker = `${marker}-first-only-comment`
        await firstCard.getByRole("textbox", { name: "Add a comment" }).fill(commentMarker)
        await firstCard.getByRole("button", { name: "Comment", exact: true }).click()
        await expect(firstCard).toContainText(commentMarker)

        const firstServer = await readIssue(page, request, first.repo, firstIssue.number)
        const secondServer = await readIssue(page, request, second.repo, secondIssue.number)
        const firstComments = await readComments(page, request, first.repo, firstIssue.number)
        const secondComments = await readComments(page, request, second.repo, secondIssue.number)
        expect(firstServer.title).toBe(firstTitle)
        expect(secondServer.title).toBe(secondTitle)
        expect(firstComments.some((entry) => entry.body === commentMarker)).toBe(true)
        expect(secondComments.some((entry) => entry.body === commentMarker)).toBe(false)
        await attachProductionJson(testInfo, "private-cloud-issue-repository-isolation", {
          issueNumber: firstIssue.number,
          first: { repo: first.repo, title: firstServer.title, comments: firstComments.length },
          second: { repo: second.repo, title: secondServer.title, comments: secondComments.length },
          firstOnlyComment: commentMarker
        })
      })
    })
  }
)

authenticatedTest(
  "Add flow completes create-flow and exposes the new issue flow through the workspace registry",
  scenario("issues.production-private-add-flow-artifact", {
    capabilities: ["identity", "cloud"],
    description: "Create an issue in an owned private import, submit its Add flow form, wait for the real create-flow run, and verify the generated issue flow in both the UI catalog and workspace RPC before cleanup.",
    coverage: [
      "action:issues.create", "action:issue.add-flow", "action:flow.create",
      "action:flow.list", "host:production", "path:success", "path:persistence", "door:slash", "door:button",
      "dimension:authenticated-private-repository", "dimension:real-workflow", "dimension:issue-flow-artifact",
      "evidence:completed-run-ui-and-workspace-registry-readback"
    ]
  }),
  async ({ page, context, request }, testInfo) => {
    await withOwnedImportedRepository({ page, context, request }, testInfo, async (fixture) => {
      const marker = `sol12 issue flow ${Date.now()} ${Math.random().toString(36).slice(2, 9)}`
      const created = await createIssueThroughUi(fixture, `Issue that owns ${marker}`)
      await created.card.getByRole("button", { name: "Add flow", exact: true }).click()
      const form = page.getByTestId("card-form-issue.add-flow")
      await expect(form).toBeVisible()
      const description = `Add an issue triage flow whose description includes ${marker}`
      await form.getByRole("textbox", { name: "What should this issue flow do?", exact: true }).fill(description)

      let acceptedRequest: Request | undefined
      const observeAcceptedRun = (outbound: Request): void => {
        if (outbound.method() !== "POST" || new URL(outbound.url()).pathname !== "/api/workflow/rpc") return
        const body = outbound.postDataJSON() as { readonly procedure?: unknown } | null
        if (body?.procedure !== "Run") return
        acceptedRequest = outbound
        fixture.markWorkflowRunSubmitted()
      }
      page.on("request", observeAcceptedRun)
      const launched = page.waitForResponse((response) => {
        if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/workflow/rpc") return false
        const body = response.request().postDataJSON() as { readonly procedure?: unknown } | null
        return body?.procedure === "Run"
      })
      let launchResponse: Response
      try {
        await form.getByTestId("flow-form-submit").click()
        launchResponse = await launched
      } finally {
        page.off("request", observeAcceptedRun)
      }
      const launchBody = await launchResponse.json() as {
        readonly ok?: unknown
        readonly payload?: { readonly runId?: unknown }
      }
      if (acceptedRequest === undefined) throw new Error("The accepted create-flow response had no observed Run request to drain.")
      const runRequest = acceptedRequest.postDataJSON() as {
        readonly workspaceId?: unknown
      }
      const acceptedRunId = launchBody.payload?.runId
      // Every run names its box; a Run request without one is a defect this spec reports.
      expect(typeof runRequest.workspaceId, "the Run request must name its box").toBe("string")
      const workspaceId = runRequest.workspaceId as string
      if (launchBody.ok === true && typeof acceptedRunId === "string" && acceptedRunId !== "") {
        fixture.trackWorkflowRun({ runId: acceptedRunId, workspaceId })
      }
      expect(launchResponse.status()).toBe(200)
      expect(launchBody.ok).toBe(true)
      expect(launchBody.payload?.runId).toEqual(expect.any(String))
      expect((launchBody.payload?.runId as string).length).toBeGreaterThan(4)

      const runId = launchBody.payload!.runId as string
      const runCard = page.locator('.smithers-card[data-kind="run-trace"]').filter({ hasText: fixture.repo }).filter({ hasText: runId }).last()
      await expect(runCard).toBeVisible()
      await expect(runCard.locator('[data-status="done"]')).toBeVisible({ timeout: 600_000 })
      await expect(runCard.getByRole("alert")).toHaveCount(0)

      await runSlash(page, `/flow.list ${fixture.repo}`)
      const catalog = page.locator('.smithers-card[data-kind="workflow-list"]').filter({ hasText: fixture.repo }).last()
      await expect(catalog).toBeVisible()
      await expect(catalog).toContainText(marker)
      const issueFlowNames = (await catalog.locator(".workflow-list-text > strong, .workflow-list-text > span").allTextContents())
        .filter((name) => /^issue[./]/.test(name))
      expect(issueFlowNames.some((name) => /^issue[./]/.test(name))).toBe(true)

      const registry = await realApi(page, request, "POST", "/api/workflow/rpc", {
        repo: fixture.repo,
        procedure: "List",
        payload: { _tag: "flows" },
        workspaceId
      })
      expect(registry.status()).toBe(200)
      const registryBody = await registry.json() as {
        readonly ok?: unknown
        readonly payload?: { readonly items?: ReadonlyArray<Record<string, unknown>> }
      }
      expect(registryBody.ok).toBe(true)
      const items = registryBody.payload?.items ?? []
      expect(items.some((item) => typeof item.flowId === "string" && /^issue[./]/.test(item.flowId))).toBe(true)
      expect(JSON.stringify(items)).toContain(marker)
      await attachProductionJson(testInfo, "private-cloud-issue-add-flow", {
        repo: fixture.repo,
        issue: created.number,
        runId,
        issueFlowNames,
        registryIssueFlows: items.filter((item) => typeof item.flowId === "string" && /^issue[./]/.test(item.flowId))
      })
    })
  }
)