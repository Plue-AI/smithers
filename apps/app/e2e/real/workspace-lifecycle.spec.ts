import { scenario } from "./coverage/types"
import { appReady, closeComposer, command, expect, realApi, reloadApp } from "./support/test"
import { expectFlowOutcome } from "./repositories-github/local"
import { attachProductionJson, bootProductionRepository, cloudRepoPath } from "./repositories-github/production"
import { configuredGatewayTest, workflowTest } from "./flow-execution/fixture"

/*
 * Read/terminal cases use the explicitly configured canary workspace; their
 * only mutation is an independently verified terminal session with cleanup.
 * Suspend/delete and missing-model cases own a fresh imported repository.
 * No route interception or fabricated provider rows are used.
 */
workflowTest.setTimeout(600_000)
workflowTest.use({ actionTimeout: 45_000, provisionCodingGateway: false })
configuredGatewayTest.setTimeout(300_000)
configuredGatewayTest.use({ actionTimeout: 45_000 })

type WorkspaceWire = {
  readonly id?: unknown
  readonly repository_id?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly target_bookmark?: unknown
}

const workspacePath = (repo: string, id: string): string => cloudRepoPath(repo, `/workspaces/${encodeURIComponent(id)}`)

const expectWorkspaceRow = (row: WorkspaceWire, repositoryId: number, id: string): void => {
  expect(row.id, "provider workspace id").toBe(id)
  expect(row.repository_id, "workspace repository scope").toBe(repositoryId)
  expect(typeof row.name, "provider workspace name").toBe("string")
  expect(row.name, "provider workspace name").not.toBe("")
  expect(typeof row.status, "provider workspace status").toBe("string")
}

configuredGatewayTest(
  "a real workspace card reads every provider facet and preserves repository scope",
  scenario("workspaces.cloud-facets-provider-readback", {
    capabilities: ["identity", "cloud"],
    description: "Open the configured canary workspace through the rendered UI, read files, services, snapshots, and egress from the provider, and verify every response remains bound to the exact repository and workspace id.",
    coverage: [
      "action:branch", "action:box.facet", "action:files", "action:file",
      "action:box.services", "action:box.egress",
      "host:production", "path:success", "door:slash", "door:button", "dimension:provider-readback",
      "dimension:workspace-scope", "dimension:facet-readback", "evidence:ui-cards-and-independent-provider-responses"
    ]
  }),
  async ({ page, request, workflowRepo }, testInfo) => {
    const id = workflowRepo.workspaceId
    expect(id, "the real provisioner must return an exact workspace id").toMatch(/^[a-f0-9-]{36}$/i)
    const workspaceId = id
    await bootProductionRepository(page, workflowRepo.repo)

    const current = await realApi(page, request, "GET", workspacePath(workflowRepo.repo, workspaceId))
    expect(current.status()).toBe(200)
    const row = await current.json() as WorkspaceWire
    expectWorkspaceRow(row, workflowRepo.repositoryId, workspaceId)

    await command(page, `/box.view ${workspaceId}`)
    await expectFlowOutcome(page, "box.view", workspaceId, "executed")
    await closeComposer(page)
    const card = page.getByTestId(`card-branch:${workspaceId}`)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card).toContainText(workflowRepo.repo)
    await expect(card).toContainText(String(row.name))

    const observed: Record<string, unknown> = { workspace: row, id: workspaceId }
    for (const [flow, suffix, bodyText] of [
      ["box.files", `/workspaces/${workspaceId}/files?path=`, "Files"],
      ["box.services", `/workspaces/${workspaceId}/services`, "Services"],
      ["box.egress", `/workspaces/${workspaceId}/egress?limit=30`, "Egress"]
    ] as const) {
      const path = cloudRepoPath(workflowRepo.repo, suffix)
      const requestSeen = page.waitForResponse((response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname + new URL(response.url()).search === path)
      const args = flow === "box.files" ? `/ ${workspaceId}` : workspaceId
      await command(page, `/${flow} ${args}`)
      await expectFlowOutcome(page, flow, args, "executed")
      await closeComposer(page)
      const response = await requestSeen
      expect(response.status(), `${bodyText} UI provider read`).toBe(200)
      const readback = await realApi(page, request, "GET", path)
      expect(readback.status(), `${bodyText} independent provider read`).toBe(200)
      const body = await readback.json()
      observed[bodyText.toLowerCase()] = body
      expect(JSON.stringify(body), `${bodyText} response must remain workspace-scoped`).not.toContain("other-repository")
    }

    // The file read is a second, independently observed path. The root list
    // determines the path; a guessed fixture filename would weaken this test.
    const listing = observed.files as ReadonlyArray<{ readonly path?: unknown; readonly type?: unknown }>
    expect(Array.isArray(listing), "provider file listing").toBe(true)
    const candidate = listing.find((entry) => typeof entry.path === "string" && entry.type === "file")
    expect(candidate, "the workspace must expose a readable repository file").toBeDefined()
    if (candidate?.path !== undefined) {
      const path = String(candidate.path)
      const readPath = cloudRepoPath(workflowRepo.repo, `/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`)
      const readSeen = page.waitForResponse((response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname + new URL(response.url()).search === readPath)
      await command(page, `/box.file ${path} ${workspaceId}`)
      await expectFlowOutcome(page, "box.file", `${path} ${workspaceId}`, "executed")
      await closeComposer(page)
      expect((await readSeen).status()).toBe(200)
    }
    await attachProductionJson(testInfo, "workspace-provider-facets", observed)
  }
)


workflowTest(
  "a real workspace suspends, resumes, and deletes only after exact readback",
  scenario("workspaces.cloud-lifecycle-suspend-resume-delete", {
    capabilities: ["identity", "cloud"],
    description: "Drive suspend and resume through the UI's real commands, independently poll each provider state transition, then type the exact workspace name and verify the provider and UI both report deletion.",
    coverage: [
      "action:box.suspend", "action:box.resume", "action:box.delete", "action:branch",
      "host:production", "path:success", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:state-transitions",
      "dimension:typed-delete-confirmation", "dimension:post-delete-readback", "evidence:provider-status-polls-and-404"
    ]
  }),
  async ({ page, request, workflowRepo }, testInfo) => {
    const id = workflowRepo.workspaceId
    expect(id, "the real provisioner must return an exact workspace id").toMatch(/^[a-f0-9-]{36}$/i)
    const workspaceId = id
    await bootProductionRepository(page, workflowRepo.repo)
    const path = workspacePath(workflowRepo.repo, workspaceId)
    const beforeResponse = await realApi(page, request, "GET", path)
    expect(beforeResponse.status()).toBe(200)
    const before = await beforeResponse.json() as WorkspaceWire
    expectWorkspaceRow(before, workflowRepo.repositoryId, workspaceId)
    const name = String(before.name)
    await command(page, `/box.view ${workspaceId}`)
    await expectFlowOutcome(page, "box.view", workspaceId, "executed")
    await closeComposer(page)
    const card = page.getByTestId(`card-branch:${workspaceId}`)
    await expect(card).toBeVisible({ timeout: 60_000 })

    const transition = async (verb: "suspend" | "resume", expected: RegExp): Promise<WorkspaceWire> => {
      const mutation = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/${verb}`)
      await command(page, `/box.${verb} ${workspaceId}`)
      await expectFlowOutcome(page, `box.${verb}`, workspaceId, "executed")
      await closeComposer(page)
      expect((await mutation).status()).toBe(200)
      let settled: WorkspaceWire | undefined
      await expect.poll(async () => {
        const response = await realApi(page, request, "GET", path)
        if (response.status() !== 200) return `http-${response.status()}`
        settled = await response.json() as WorkspaceWire
        expectWorkspaceRow(settled, workflowRepo.repositoryId, workspaceId)
        return settled.status
      }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toMatch(expected)
      expect(settled).toBeDefined()
      return settled!
    }

    const suspended = await transition("suspend", /^suspended$/)
    await expect(card).toContainText(/Suspended/i)
    const resumed = await transition("resume", /^running$/)
    await expect(card).toContainText(/Running/i)

    // Exercise the card's own typed-name gate before the destructive request.
    await card.getByRole("button", { name: "Delete", exact: true }).click()
    const confirmation = card.getByRole("textbox", { name: `Type ${name} to confirm the delete` })
    await expect(confirmation).toBeVisible()
    const deleteButton = card.getByRole("button", { name: "Delete permanently", exact: true })
    await expect(deleteButton).toBeDisabled()
    await confirmation.focus()
    await confirmation.fill(name)
    await expect(deleteButton).toBeEnabled()
    const deletion = page.waitForResponse((response) =>
      response.request().method() === "DELETE" && new URL(response.url()).pathname === path)
    await deleteButton.press("Enter")
    expect((await deletion).status()).toBe(204)
    await expectFlowOutcome(page, "box.delete", `${workspaceId} ${name}`, "executed")
    await expect.poll(async () => (await realApi(page, request, "GET", path)).status(), { timeout: 60_000 }).toBe(404)
    await expect(card).toHaveCount(0)
    await reloadApp(page)
    await appReady(page)
    await expect(card).toHaveCount(0)
    await attachProductionJson(testInfo, "workspace-lifecycle", {
      repo: workflowRepo.repo, workspaceId, name, before, suspended, resumed,
      deleteStatus: (await deletion).status(), finalStatus: 404
    })
  }
)

workflowTest(
  "an unconfigured coding workspace names the missing model instead of resuming forever",
  scenario("workspaces.cloud-missing-model-refusal", {
    capabilities: ["identity", "cloud"],
    description: "Select a freshly imported running workspace with no model configured and require the real coding gateway to name the missing configuration in the UI.",
    coverage: ["action:branch", "action:repo.select", "action:flows", "host:production", "path:error", "door:slash", "dimension:missing-model", "dimension:bounded-refusal", "evidence:real-provision-response-and-visible-error"]
  }),
  async ({ page, request, workflowRepo }, testInfo) => {
    const id = workflowRepo.workspaceId
    await bootProductionRepository(page, workflowRepo.repo)
    await command(page, `/box.view ${id}`)
    await expect(page.getByTestId(`card-branch:${id}`)).toBeVisible()
    await closeComposer(page)
    await command(page, `/repo.select ${workflowRepo.repo}#workspace:${id}`)
    await closeComposer(page)
    const response = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/workflow/provision" && r.status() >= 400, { timeout: 60_000 })
    await command(page, `/flow.list ${workflowRepo.repo}`)
    const refused = await response
    expect(await refused.text()).toContain("SMITHERS_CODING_IMPLEMENT_MODEL")
    await expect(page.getByText(/Configure SMITHERS_CODING_IMPLEMENT_MODEL/).first()).toBeVisible({ timeout: 30_000 })
    const current = await realApi(page, request, "GET", workspacePath(workflowRepo.repo, id))
    expect(current.status()).toBe(200)
    expect(await current.json()).toMatchObject({ id, status: "running" })
    await attachProductionJson(testInfo, "missing-model-refusal", { repo: workflowRepo.repo, workspaceId: id, status: refused.status(), workspaceRetained: true })
  }
)
