import { randomUUID } from "node:crypto"
import { authenticatedTest } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, closeComposer, command, expect, realApi, reloadApp } from "./support/test"
import { finishFirstVisit } from "./support/first-visit"
import { scenarioOutcome, TEARDOWN_ANNOTATION, TeardownProblem } from "./support/teardown"
import { fixtureInputText, fixtureProtocolId } from "./support/values"

// The fixture value is generated for this owned repository. No real provider
// credential, import, workflow, or outbound provider request is involved.
authenticatedTest("repository secret metadata survives reload and follows actual backend deletion", scenario("secrets.repository-metadata-readback", {
  capabilities: ["identity", "cloud"],
  description: "Create a uniquely owned private repository and synthetic secret through the real API, read only its metadata through the keyboard flow, reload, then delete it and verify the refreshed card and backend agree without revealing the value.",
  coverage: ["action:secrets.list", "host:local", "host:production", "path:success", "path:persistence", "path:keyboard", "door:slash", "dimension:keyboard", "dimension:reload", "dimension:write-only-secret", "evidence:backend-metadata-and-deletion-readback"]
}), async ({ page, request }, testInfo) => {
  const user = await realApi(page, request, "GET", "/api/user")
  expect(user.status()).toBe(200)
  const { username } = await user.json() as { username: string }
  const name = fixtureProtocolId(`smithers-e2e-secrets-${randomUUID()}`)
  const repo = `${username}/${name}`
  const repoPath = `/api/repos/${encodeURIComponent(username)}/${name}`
  const environmentPath = `${repoPath}/agent-environment`
  const secretName = "ACCEPTANCE_TOKEN"
  const secretPath = `${environmentPath}/secrets/${secretName}`
  const value = fixtureInputText(`owned-secret-${randomUUID()}`)
  const host = fixtureInputText("api.example.test")
  const binding = { name: secretName, hosts: [host], match_headers: ["authorization"] }
  let submitted = false, failure: unknown
  const cleanup: unknown[] = []
  try {
    submitted = true
    const created = await realApi(page, request, "POST", "/api/user/repos", { name, private: true, auto_init: false })
    expect(created.status()).toBe(201)
    const repository = await created.json() as { full_name: string; private: boolean }
    expect(repository).toMatchObject({ full_name: repo, private: true })
    const written = await realApi(page, request, "PUT", secretPath, { value, hosts: binding.hosts, match_headers: binding.match_headers })
    expect(written.status()).toBe(201)
    const metadata = await written.json()
    expect(metadata).toMatchObject(binding)
    expect(metadata).not.toHaveProperty("value")
    expect(JSON.stringify(metadata).includes(value)).toBe(false)
    const read = async () => {
      const response = await realApi(page, request, "GET", environmentPath)
      expect(response.status()).toBe(200)
      const body = await response.json() as { secrets: Array<Record<string, unknown>> }
      expect(JSON.stringify(body).includes(value)).toBe(false)
      for (const secret of body.secrets) expect(secret).not.toHaveProperty("value")
      return body.secrets
    }
    expect(await read()).toEqual([metadata])
    const started = performance.now()
    await page.goto(`/${repo}`, { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", started)
    await finishFirstVisit(page)
    const list = async () => {
      const observed = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === environmentPath)
      void observed.catch(() => undefined)
      await command(page, `/secrets.list ${repo}`)
      await closeComposer(page)
      const response = await observed
      expect(response.status()).toBe(200)
      const body = await response.json() as { secrets: Array<Record<string, unknown>> }
      expect(JSON.stringify(body).includes(value)).toBe(false)
      for (const secret of body.secrets) expect(secret).not.toHaveProperty("value")
    }
    const card = page.locator('.smithers-card[data-kind="secrets"]')
    const row = card.getByTestId(`secret-${secretName}`)
    await list()
    await expect(card).toBeVisible()
    await expect(row).toContainText(secretName)
    await expect(row).toContainText(binding.hosts[0]!)
    await expect(row).toContainText(binding.match_headers[0]!)
    expect((await page.locator("body").innerText()).includes(value)).toBe(false)
    await reloadApp(page)
    await expect(row).toBeVisible()
    await list()
    await expect(row).toBeVisible()
    expect(await read()).toEqual([metadata])
    expect((await page.locator("body").innerText()).includes(value)).toBe(false)

    expect((await realApi(page, request, "DELETE", secretPath)).status()).toBe(204)
    expect(await read()).toEqual([])
    await list()
    await expect(card).toBeVisible()
    await expect(row).toHaveCount(0)
    await expect(card.getByRole("table")).toHaveCount(0)
    await reloadApp(page)
    await expect(card).toBeVisible()
    await expect(row).toHaveCount(0)
    await testInfo.attach("secret-metadata-readback", { contentType: "application/json", body: Buffer.from(JSON.stringify({ repo, metadata, afterDeletion: [] })) })
  } catch (error) { failure = error }
  finally {
    if (submitted) {
      try {
        const deleted = await realApi(page, request, "DELETE", repoPath)
        expect([204, 404]).toContain(deleted.status())
        expect((await realApi(page, request, "GET", repoPath)).status()).toBe(404)
        await testInfo.attach("owned-secret-repository-cleanup", { contentType: "application/json", body: Buffer.from(JSON.stringify({ repo, status: 404 })) })
      } catch (error) { cleanup.push(new TeardownProblem(`Removing owned secret repository ${repo} failed`, { cause: error })) }
    }
  }
  const outcome = scenarioOutcome({ repository: repo, bodyError: failure, teardownFailures: cleanup })
  for (const description of outcome.teardown) testInfo.annotations.push({ type: TEARDOWN_ANNOTATION, description })
  if (outcome.verdict !== undefined) throw outcome.verdict
})
