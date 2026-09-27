import { randomUUID } from "node:crypto"
import type { Request } from "@playwright/test"
import { authenticatedTest } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { closeComposer, command, expect, realApi, reloadApp } from "./support/test"
import { scenarioOutcome, TEARDOWN_ANNOTATION, TeardownProblem } from "./support/teardown"
import { fixtureInputText } from "./support/values"

// Requires self-host subscription_connections. The synthetic API key proves
// storage/revocation only; no provider is invoked.
authenticatedTest("self-host coding accounts connect through a write-only form and revoke durably", scenario("secrets.selfhost-connection-lifecycle", {
  capabilities: ["identity", "cloud"],
  description: "On an opted-in self-host backend, submit a synthetic Anthropic API key through the keyboard form, read actual metadata, reload, revoke through the row button, and verify durable revoked state. This does not prove vendor authentication or model execution.",
  coverage: ["action:secrets.connect", "action:secrets.connections", "action:secrets.revoke", "host:local", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:reload", "dimension:write-only-secret", "evidence:backend-connection-and-revocation-readback"]
}), async ({ page, request }, testInfo) => {
  const path = "/api/user/provider-connections"
  const value = fixtureInputText(`sk-ant-api03-${randomUUID()}${randomUUID()}`)
  type Connection = { id: string; label: string; state: string; provider: string; kind: string; has_refresh_token: boolean }
  const metadataOnly = (body: unknown) => {
    expect(JSON.stringify(body).includes(value)).toBe(false)
    for (const row of Array.isArray(body) ? body : [body]) {
      expect(row).not.toHaveProperty("access_token")
      expect(row).not.toHaveProperty("refresh_token")
      expect(row).not.toHaveProperty("access_token_encrypted")
    }
  }
  const read = async (): Promise<Connection[]> => {
    const response = await realApi(page, request, "GET", path)
    expect(response.status(), "self-host subscription_connections must be enabled").toBe(200)
    const rows = await response.json() as Connection[]
    metadataOnly(rows)
    return rows
  }
  const bootstrap = await realApi(page, request, "GET", "/api/bootstrap")
  expect(bootstrap.status()).toBe(200)
  expect((await bootstrap.json()).host).toBe("local")
  await read()
  let ownedLabel: string | undefined, ownedId: string | undefined, failure: unknown
  let posts = 0
  const cleanup: unknown[] = []
  const submitted = (sent: Request) => {
    if (sent.method() !== "POST" || new URL(sent.url()).pathname !== path) return
    const body = sent.postDataJSON() as { access_token?: string; label?: string }
    if (body.access_token !== value) return
    ownedLabel = body.label
    posts += 1
  }
  page.on("request", submitted)
  try {
    await command(page, "/secrets.connections")
    await closeComposer(page)
    const card = page.getByTestId("card-provider-accounts")
    await expect(card).toBeVisible()
    await card.getByRole("button", { name: "Add Claude", exact: true }).press("Enter")
    const form = page.getByTestId("card-form-secrets.connect")
    const field = form.getByLabel("Claude token", { exact: true })
    await expect(field).toHaveAttribute("type", "password")
    await field.fill(value)
    const connected = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === path)
    void connected.catch(() => undefined)
    await form.getByTestId("flow-form-submit").press("Enter")
    const response = await connected
    expect(response.status()).toBe(201)
    const connection = await response.json() as Connection
    metadataOnly(connection)
    ownedId = connection.id
    expect(connection).toMatchObject({ label: ownedLabel, provider: "claude", kind: "api_key", state: "active", has_refresh_token: false })
    expect(posts).toBe(1)
    const row = card.getByTestId(`account-${connection.id}`)
    await expect(row).toBeVisible()
    expect((await page.locator("body").innerText()).includes(value)).toBe(false)
    expect(await page.locator('input[type="password"]').evaluateAll(inputs => inputs.every(input => (input as HTMLInputElement).value === ""))).toBe(true)
    expect((await read()).find(item => item.id === ownedId)).toMatchObject(connection)
    await reloadApp(page)
    await expect(row).toBeVisible()
    await command(page, "/secrets.connections")
    await closeComposer(page)
    await expect(row).toContainText("active")
    expect((await read()).find(item => item.id === ownedId)).toMatchObject(connection)
    expect((await page.locator("body").innerText()).includes(value)).toBe(false)
    const revoked = page.waitForResponse(answer => answer.request().method() === "DELETE" && new URL(answer.url()).pathname === `${path}/${ownedId}`)
    void revoked.catch(() => undefined)
    await row.getByRole("button", { name: "Revoke", exact: true }).press("Enter")
    expect((await revoked).status()).toBe(204)
    await expect(row).toHaveCount(0)
    expect((await read()).find(item => item.id === ownedId)).toMatchObject({ state: "revoked" })
    await reloadApp(page)
    await expect(card).toBeVisible()
    await expect(row).toHaveCount(0)
    await command(page, "/secrets.connections")
    await closeComposer(page)
    await expect(row).toHaveCount(0)
    expect((await read()).find(item => item.id === ownedId)).toMatchObject({ state: "revoked" })
    expect(posts).toBe(1)
    await testInfo.attach("connection-lifecycle-readback", { contentType: "application/json", body: Buffer.from(JSON.stringify({ id: ownedId, provider: connection.provider, kind: connection.kind, state: "revoked", posts })) })
  } catch (error) { failure = error }
  finally {
    page.off("request", submitted)
    if (ownedLabel !== undefined) {
      try {
        const owned = (await read()).filter(row => row.label === ownedLabel)
        for (const row of owned) {
          expect((await realApi(page, request, "DELETE", `${path}/${row.id}`)).status()).toBe(204)
          const response = await realApi(page, request, "GET", `${path}/${row.id}`)
          expect(response.status()).toBe(200)
          const body = await response.json()
          metadataOnly(body)
          expect(body.state).toBe("revoked")
        }
        await testInfo.attach("owned-connection-cleanup", { contentType: "application/json", body: Buffer.from(JSON.stringify({ ids: owned.map(row => row.id), state: "revoked" })) })
      } catch (error) { cleanup.push(new TeardownProblem("Revoking the owned coding connection failed", { cause: error })) }
    }
  }
  const outcome = scenarioOutcome({ repository: ownedId ?? "coding connection", bodyError: failure, teardownFailures: cleanup })
  for (const description of outcome.teardown) testInfo.annotations.push({ type: TEARDOWN_ANNOTATION, description })
  if (outcome.verdict !== undefined) throw outcome.verdict
})
