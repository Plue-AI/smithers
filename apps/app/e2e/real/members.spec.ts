import { readFileSync } from "node:fs"
import { test, expect, type Page } from "../playwright/browserTest"
import { command } from "./support/test"
import { scenario } from "./coverage/types"

// Reference-host inputs are owned scratch accounts and saved browser profiles.
// This test never changes GitHub permissions or writes to a GitHub repository.
// The operator stops the backend for ten seconds during the annotated outage step.
interface MembersRun {
  ownerOrigin: string
  publicOrigin: string
  repository: string
  commit: string
  ownerState: string
  memberState: string
  refusedState: string
  maintainer: string
  member: string
  refused: string
}
const card = (page: Page) => page.getByRole("region", { name: "Members", exact: true }).last()

test("C-J1-05 Members on the install and LAN", scenario("journey.members", {
  capabilities: ["identity", "install"],
  coverage: ["host:local", "host:production", "action:members", "action:members.add", "action:members.role", "action:members.remove", "door:button", "door:slash", "dimension:keyboard", "path:success", "path:permission", "path:error", "evidence:members"]
}), async ({ browser }, info) => {
  info.setTimeout(240_000)
  const path = process.env.SMITHERS_MEMBERS_RUN
  if (!path) throw new Error("SMITHERS_MEMBERS_RUN must name the reference-host Members inputs JSON")
  const input = JSON.parse(readFileSync(path, "utf8")) as MembersRun
  for (const field of ["ownerOrigin", "publicOrigin", "repository", "commit", "ownerState", "memberState", "refusedState", "maintainer", "member", "refused"] as const) {
    if (!input[field]) throw new Error(`Members inputs missing ${field}`)
  }
  expect(new URL(input.publicOrigin).protocol).toBe("http:")
  expect(new URL(input.publicOrigin).hostname).not.toMatch(/^(localhost|127\.0\.0\.1)$/)
  const ownerContext = await browser.newContext({ storageState: input.ownerState,
    recordVideo: { dir: info.outputPath("owner-video") }, recordHar: { path: info.outputPath("owner.har") } })
  const memberContext = await browser.newContext({ storageState: input.memberState,
    recordVideo: { dir: info.outputPath("member-video") }, recordHar: { path: info.outputPath("member.har") } })
  const refusedContext = await browser.newContext({ storageState: input.refusedState,
    recordVideo: { dir: info.outputPath("refused-video") }, recordHar: { path: info.outputPath("refused.har") } })
  await ownerContext.tracing.start({ screenshots: true, snapshots: true })
  await memberContext.tracing.start({ screenshots: true, snapshots: true })
  await refusedContext.tracing.start({ screenshots: true, snapshots: true })
  try {
    const owner = await ownerContext.newPage()
    await owner.goto(input.ownerOrigin)
    const bootstrap = await owner.request.get(`${input.ownerOrigin}/api/bootstrap`)
    expect(bootstrap.status()).toBe(200)
    const host = await bootstrap.json()
    expect(host.buildSha).toBe(input.commit)
    await info.attach("members-host", { body: JSON.stringify(host), contentType: "application/json" })
    await command(owner, "/members")
    const roster = card(owner)
    for (const login of [input.maintainer, input.member]) {
      await roster.getByLabel("GitHub username", { exact: true }).fill(login)
      const committed = owner.waitForResponse(r => new URL(r.url()).pathname === "/api/members" && r.request().method() === "POST")
      await owner.keyboard.press("Tab")
      await owner.keyboard.press("Enter")
      expect((await committed).status()).toBe(204)
      await expect(roster.locator(`li[data-login="${login}"]`)).toBeVisible({ timeout: 1000 })
    }
    await expect(roster.locator(`li[data-login="${input.maintainer}"] select`)).toHaveValue("maintainer")
    await expect(roster.locator(`li[data-login="${input.member}"] select`)).toHaveValue("member")
    await roster.getByLabel("GitHub username").fill(input.refused)
    await roster.getByRole("button", { name: "Add", exact: true }).press("Enter")
    await expect(roster.getByRole("link", { name: /needs access on GitHub/ })).toHaveAttribute("href", `https://github.com/${input.repository}/settings/access`)
    await expect(roster.locator(`li[data-login="${input.refused}"]`)).toHaveCount(0)

    const teammate = await memberContext.newPage()
    await teammate.goto(`${input.publicOrigin}/api/auth/github`)
    // A saved GitHub profile or the reference operator completes GitHub's own door.
    await teammate.waitForURL(url => url.origin === input.publicOrigin && !url.pathname.startsWith("/api/"))
    const identity = await teammate.request.get(`${input.publicOrigin}/api/user`)
    expect(identity.status()).toBe(200)
    expect((await identity.json()).username).toBe(input.member)
    await command(teammate, "/members")
    await expect(card(teammate).getByRole("button", { name: /^(Add|Role|Remove)$/ })).toHaveCount(0)
    const denied = await refusedContext.newPage()
    const refusal = denied.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/github/callback")
    await denied.goto(`${input.publicOrigin}/api/auth/github`)
    expect((await refusal).status()).toBe(403)
    expect((await refusedContext.cookies(input.publicOrigin)).filter(cookie => cookie.name === "session")).toEqual([])

    const row = roster.locator(`li[data-login="${input.member}"]`)
    for (const role of ["maintainer", "member"]) {
      await row.getByRole("combobox").selectOption(role)
      await row.getByRole("button", { name: "Role", exact: true }).press("Enter")
      await expect(row.getByRole("combobox")).toHaveValue(role)
      const other = card(teammate).locator(`li[data-login="${input.member}"]`)
      if (role === "maintainer") await expect(other.getByRole("combobox")).toHaveValue(role)
      else { await expect(other).toContainText("Member"); await expect(card(teammate).getByRole("button", { name: "Add", exact: true })).toHaveCount(0) }
    }
    console.log("C-J1-05 reference operator: stop the backend now for ten seconds, then restart it.")
    info.annotations.push({ type: "reference-operator", description: "Stop the backend now for ten seconds, then restart it." })
    await expect.poll(async () => {
      try { return (await owner.request.get(`${input.ownerOrigin}/api/members`, { timeout: 1000 })).status() >= 500 }
      catch { return true }
    }, { timeout: 60_000 }).toBe(true)
    const outageAt = Date.now()
    await command(owner, "/members")
    await expect(owner.getByRole("alert").filter({ hasText: /Not your fault/ }).last()).toBeVisible()
    await expect(row).toBeVisible()
    await expect.poll(async () => {
      try { return (await owner.request.get(`${input.ownerOrigin}/api/members`, { timeout: 1000 })).status() }
      catch { return 0 }
    }, { timeout: 60_000 }).toBe(200)
    expect(Date.now() - outageAt).toBeGreaterThanOrEqual(10_000)
    await expect(owner.getByRole("alert").filter({ hasText: "Members unavailable" })).toHaveCount(0)
    owner.once("dialog", dialog => { void dialog.dismiss() })
    await row.getByRole("button", { name: "Remove", exact: true }).press("Enter")
    await expect(row).toBeVisible()
    owner.once("dialog", dialog => { void dialog.accept() })
    await row.getByRole("button", { name: "Remove", exact: true }).press("Enter")
    await expect(row).toHaveCount(0)
    const committed = await owner.request.get(`${input.ownerOrigin}/api/members`)
    expect(committed.status()).toBe(200)
    await info.attach("members-committed-roster", { body: await committed.body(), contentType: "application/json" })
    await info.attach("members-owner", { body: await owner.screenshot(), contentType: "image/png" })
  } finally {
    await ownerContext.tracing.stop({ path: info.outputPath("owner-trace.zip") })
    await memberContext.tracing.stop({ path: info.outputPath("member-trace.zip") })
    await refusedContext.tracing.stop({ path: info.outputPath("refused-trace.zip") })
    await ownerContext.close(); await memberContext.close(); await refusedContext.close()
  }
})
