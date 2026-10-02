import { expect } from "@playwright/test"
import type { SetupHostInput, SetupOperationResponseSchema } from "@smthrs/rpc/RepositorySetup"
import type { z } from "zod"
import { SCOPED_TEST_USER } from "../../playwright/identity"
import { showcase } from "../showcase"

const REPO = "smithersai/smithers"
const WORKSPACE = "de29f26b-e593-4ec2-99fc-583d4711f20a"
type Response = z.infer<typeof SetupOperationResponseSchema>
type Start = Omit<SetupHostInput, "operation">

/* The setup host's answers, shaped like e2e/playwright/repository-setup.spec.ts: every operation completes. */
const answer = (body: Start, operation: SetupHostInput["operation"]): Response => ({
  requestId: body.requestId, revision: body.revision, digest: body.digest, workspaceId: WORKSPACE,
  receipt: {
    requestId: body.requestId, revision: body.revision, digest: body.digest, operation, phase: "completed",
    runId: `${operation}-run-${body.requestId}`, updatedAt: Date.now(),
    results: operation === "evaluate" ? body.draft.cases.map(item => ({ caseId: item.id, status: "passed", observed: "Linked #812 as a duplicate", evidence: ["issue:812"], executionId: `exec-${item.id}` })) : [],
    evidence: ["operation:completed"],
    ...(operation === "trial" ? { sourceRevision: "a41c9e2", trialIssue: { source: "smithers-cloud", number: 991 } } : {}),
    ...(operation === "apply" || operation === "pause" ? { registrationId: "registration-issues", sourceRevision: "a41c9e2" } : {}),
    ...(operation === "run" ? { jobRunId: `job-${body.requestId}` } : {})
  },
  ...(operation === "inspect" ? { inspection: { inspectedAt: Date.now(), suggestedDraft: { ...body.draft, cases: [{
    id: "duplicate-issues", name: "Similar issues", input: "A new issue repeats #812", expected: "Links #812 and labels duplicate", required: true
  }] }, sources: [{ path: ".github/ISSUE_TEMPLATE/bug.yml", status: "read", summary: "Bug report template" }] } } : {})
})

export default showcase({
  id: "job-setup",
  order: 90,
  title: "Set up a job",
  summary: "Handle issues: eval it, trial it on a test issue, enable it, then run it on a real one.",
  flows: ["issues.setup", "form.submit", "setup.view", "setup.run", "setup.work"],
  run: async ({ page, app, backend }) => {
    await backend.cloud()
    await backend.json("/api/public/repos", { repos: [{ name: REPO }] })
    await backend.json(`/api/repos/${REPO}/contents`, [])
    await backend.route(url => url.pathname === "/api/repository-setup/state", route => route.fulfill({ json: {
      owner: SCOPED_TEST_USER.login, repo: REPO, job: new URL(route.request().url()).searchParams.get("job"),
      registration: { state: "known" }, setup: { state: "none" }
    } }))
    await backend.route(url => url.pathname.startsWith("/api/repository-setup/") && url.pathname !== "/api/repository-setup/state", route => {
      const body = route.request().postDataJSON() as Start
      const operation = new URL(route.request().url()).pathname.split("/").at(-1)! as SetupHostInput["operation"]
      return route.fulfill({ json: answer(body, operation) })
    })

    await app.open("/")
    // A job tile reads its state after the name; nothing is registered yet.
    await app.click(page.getByRole("button", { name: "Handle issues · Off", exact: true }))
    const setup = page.getByTestId("setup-issues")
    await expect(setup.getByRole("button", { name: "Inspect repository" })).toBeEnabled()
    await app.show(setup)
    await app.beat(800)

    // After inspecting, the app asks its first setup question as a form card.
    const question = page.locator('.smithers-card[data-kind="flow-form"]').last()
    await expect(question).toBeVisible({ timeout: 15_000 })
    await app.show(question)
    await expect(question).toContainText("automatic?")
    await app.beat(900)
    await app.click(question.getByTestId("flow-form-choice"))
    await question.getByTestId("flow-form-choice").selectOption("approved")
    await app.beat(600)
    await app.click(question.getByTestId("flow-form-submit"))
    await app.show(setup)
    await app.beat(800)
    const enable = setup.getByRole("button", { name: "Enable issue handling", exact: true })
    await expect(enable).toBeDisabled()

    await app.click(setup.getByRole("button", { name: "Evals", exact: true }))
    await app.click(setup.getByRole("button", { name: "Run evals", exact: true }))
    await expect(setup.getByText("Similar issues · passed", { exact: true })).toBeVisible()
    await app.beat(1200)

    await app.click(setup.getByRole("button", { name: "Test", exact: true }))
    await app.click(setup.getByRole("button", { name: "Create test issue", exact: true }))
    await expect(setup.getByRole("button", { name: "Issue #991", exact: true })).toBeVisible()
    await app.beat(1000)

    await expect(enable).toBeEnabled()
    await app.click(enable)
    await expect(setup.locator(".setup-heading").first()).toContainText("Enabled")
    await app.beat(1200)

    await app.click(setup.getByRole("button", { name: "Flows", exact: true }))
    await app.click(setup.getByRole("button", { name: "Run Fix for real", exact: true }))
    await setup.getByRole("combobox", { name: "Source", exact: true }).selectOption("smithers-cloud")
    await app.type(setup.getByRole("spinbutton", { name: "Issue number", exact: true }), "42")
    await app.type(setup.getByRole("textbox", { name: "Instructions (optional)", exact: true }), "Keep the public API stable")
    await app.click(setup.getByRole("button", { name: "Fix for real", exact: true }))
    await expect(setup.getByRole("button", { name: "Job run", exact: true })).toBeVisible()
  }
})
