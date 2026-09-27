import { scenario } from "./coverage/types"
import { closeComposer, command, expect, realApi, reloadApp } from "./support/test"
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
    description: "Open the configured canary workspace through the rendered UI, read files, services, sessions, snapshots, and egress from the provider, and verify every response remains bound to the exact repository and workspace id.",
    coverage: [
      "action:box.view", "action:box.facet", "action:box.files", "action:box.file",
      "action:box.services", "action:box.sessions", "action:box.egress",
      "host:production", "path:success", "door:slash", "door:button", "dimension:provider-readback",
      "dimension:workspace-scope", "dimension:facet-readback", "evidence:ui-cards-and-independent-provider-responses"
    ]
  }),
  async ({ page, request, workflowRepo }, testInfo) => {
    const id = workflowRepo.workspaceId
    expect(id, "the real provisioner must return an exact workspace id").toMatch(/^[a-f0-9-]{36}$/i)
    const workspaceId = id!
    await bootProductionRepository(page, workflowRepo.repo)

    const current = await realApi(page, request, "GET", workspacePath(workflowRepo.repo, workspaceId))
    expect(current.status()).toBe(200)
    const row = await current.json() as WorkspaceWire
    expectWorkspaceRow(row, workflowRepo.repositoryId, workspaceId)

    await command(page, `/box.view ${workspaceId}`)
    await expectFlowOutcome(page, "box.view", workspaceId, "executed")
    await closeComposer(page)
    const card = page.getByTestId(`card-workspace-${workspaceId}`)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card).toContainText(workflowRepo.repo)
    await expect(card).toContainText(String(row.name))

    const observed: Record<string, unknown> = { workspace: row, id: workspaceId }
    for (const [flow, suffix, bodyText] of [
      ["box.files", `/workspaces/${workspaceId}/files?path=`, "Files"],
      ["box.services", `/workspaces/${workspaceId}/services`, "Services"],
      ["box.sessions", "/workspace/sessions", "Sessions"],
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
      "action:box.suspend", "action:box.resume", "action:box.delete", "action:box.view",
      "host:production", "path:success", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:state-transitions",
      "dimension:typed-delete-confirmation", "dimension:post-delete-readback", "evidence:provider-status-polls-and-404"
    ]
  }),
  async ({ page, request, workflowRepo }, testInfo) => {
    const id = workflowRepo.workspaceId
    expect(id, "the real provisioner must return an exact workspace id").toMatch(/^[a-f0-9-]{36}$/i)
    const workspaceId = id!
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
    const card = page.getByTestId(`card-workspace-${workspaceId}`)
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
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await expect(card).toHaveCount(0)
    await attachProductionJson(testInfo, "workspace-lifecycle", {
      repo: workflowRepo.repo, workspaceId, name, before, suspended, resumed,
      deleteStatus: (await deletion).status(), finalStatus: 404
    })
  }
)

configuredGatewayTest(
  "a cloud terminal accepts keyboard input and returns real shell output",
  scenario("workspaces.cloud-terminal-keyboard-output", {
    capabilities: ["identity", "cloud"],
    description: "Open a new terminal session on the configured canary workspace through the UI, type a split marker, verify the shell's combined output, and destroy exactly the created session.",
    coverage: ["action:box.view", "action:box.terminal", "host:production", "path:success", "path:keyboard", "door:slash", "dimension:keyboard", "dimension:real-pty", "dimension:websocket", "evidence:rendered-shell-output-and-session-cleanup"]
  }),
  async ({ page, request, workflowRepo }, testInfo) => {
    const id = workflowRepo.workspaceId!
    await bootProductionRepository(page, workflowRepo.repo)
    await command(page, `/box.view ${id}`)
    await expect(page.getByTestId(`card-workspace-${id}`)).toBeVisible()
    await closeComposer(page)
    const path = cloudRepoPath(workflowRepo.repo, "/workspace/sessions")
    const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === path && response.ok(), { timeout: 90_000 })
    let sessionId: string | undefined
    try {
      await command(page, `/box.terminal ${id}`)
      expect((await created).status()).toBe(201)
      await closeComposer(page)
      const terminal = page.getByTestId(`card-workspace-${id}`).locator('[data-testid^="terminal-"]')
      await expect(terminal).toBeVisible({ timeout: 60_000 })
      sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length)
      expect(sessionId).not.toBe("")
      const readback = await realApi(page, request, "GET", `${path}/${encodeURIComponent(sessionId)}`)
      expect(readback.status()).toBe(200)
      expect(await readback.json()).toMatchObject({ id: sessionId, workspace_id: id, status: "running" })
      await expect(page.getByRole("log", { name: "Conversation", exact: true })).toBeVisible()
      await expect(terminal).not.toContainText('{"type":"replay-complete"}')
      await terminal.locator(".xterm-helper-textarea").focus()
      const suffix = String(Date.now())
      await page.keyboard.type(`printf '%s%s\\n' 'CLOUD_TERMINAL_' '${suffix}'`)
      await page.keyboard.press("Enter")
      const marker = `CLOUD_TERMINAL_${suffix}`
      await expect(terminal.locator(".xterm-rows")).toContainText(marker, { timeout: 30_000 })
      await attachProductionJson(testInfo, "cloud-terminal-output", { repo: workflowRepo.repo, workspaceId: id, sessionId, marker })
    } finally {
      if (sessionId !== undefined) {
        const cleanupStarted = Date.now()
        const deleted = await realApi(page, request, "POST", `${path}/${encodeURIComponent(sessionId)}/destroy`)
        const cleanupMs = Date.now() - cleanupStarted
        expect(deleted.status()).toBe(204)
        const stopped = await realApi(page, request, "GET", `${path}/${encodeURIComponent(sessionId)}`)
        expect(stopped.status()).toBe(200)
        expect(await stopped.json()).toMatchObject({ id: sessionId, workspace_id: id, status: "stopped" })
        await attachProductionJson(testInfo, "cloud-terminal-cleanup", { sessionId, status: deleted.status(), cleanupMs, durableStatus: "stopped" })
      }
    }
  }
)

workflowTest(
  "an unconfigured coding workspace names the missing model instead of resuming forever",
  scenario("workspaces.cloud-missing-model-refusal", {
    capabilities: ["identity", "cloud"],
    description: "Select a freshly imported running workspace with no model configured and require the real coding gateway to name the missing configuration in the UI.",
    coverage: ["action:box.view", "action:repo.select", "action:flow.list", "host:production", "path:error", "door:slash", "dimension:missing-model", "dimension:bounded-refusal", "evidence:real-provision-response-and-visible-error"]
  }),
  async ({ page, request, workflowRepo }, testInfo) => {
    const id = workflowRepo.workspaceId!
    await bootProductionRepository(page, workflowRepo.repo)
    await command(page, `/box.view ${id}`)
    await expect(page.getByTestId(`card-workspace-${id}`)).toBeVisible()
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
