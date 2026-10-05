import { test, expect, type Browser, type Page } from "@playwright/test"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"

// Run with playwright.background.config.ts: setup uses the real bundle, GitHub
// fake and model stand-in. This test never intercepts an app route or seeds a
// product row. An outside actor's git push supplies the broken repository flow.
const app = "http://localhost:4000"
const run = () => JSON.parse(readFileSync("test-results/local-no-github/run.json", "utf8")) as { home: string; fakeURL: string }
const say = async (page: Page, text: string) => { const input = page.getByTestId("composer-input"); if (!await input.isVisible()) await page.keyboard.press("Control+k"); await input.fill(text); await input.press("Enter") }
const signIn = async (browser: Browser, who: "owner" | "ben" | "alice") => {
 const context = await browser.newContext(), page = await context.newPage()
 await page.goto(`${app}/api/auth/github`)
 await page.getByRole("link", { name: who === "owner" ? "Authorize" : `Authorize as ${who}`, exact: true }).click()
 await page.waitForURL(url => url.origin === app && !url.pathname.startsWith("/api/"))
 await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 20_000 })
 return { context, page }
}
const homeRows = (page: Page) => page.getByRole("list", { name: "Background runs", exact: true }).last().locator("li")
const runs = async (page: Page) => { const response = await page.request.get(`${app}/api/runs`); expect(response.status()).toBe(200); return response.json() as Promise<{ id: string; title: string; state: string }[]> }

test("J4 background runs: real failed import, one Retry, Dismiss shared after reload, member refusal", async ({ browser }) => {
 test.setTimeout(12 * 60_000)
 const fixture = run(), owner = await signIn(browser, "owner")
 let ben: Awaited<ReturnType<typeof signIn>> | undefined, alice: Awaited<ReturnType<typeof signIn>> | undefined
 try {
  for (const [login, id, permission] of [["ben", 201, "maintain"], ["alice", 202, "write"]] as const) {
   const response = await owner.context.request.post(`${fixture.fakeURL}/_fake/collaborators`, { data: { login, id, permission } }); expect(response.ok()).toBe(true)
  }
  await say(owner.page, "/members")
  const members = owner.page.getByRole("region", { name: "Members", exact: true }).last()
  for (const login of ["ben", "alice"]) { await members.getByLabel("GitHub username", { exact: true }).fill(login); await members.getByRole("button", { name: "Add", exact: true }).click(); await expect(members.locator(`li[data-login="${login}"]`)).toBeVisible() }
  ben = await signIn(browser, "ben"); alice = await signIn(browser, "alice")
  // The outside contributor changes GitHub's main, not the install's mirror.
  const work = mkdtempSync(join(tmpdir(), "background-github-"))
  try {
   const git = (args: string[]) => execFileSync("/usr/bin/git", args, { cwd: work, env: { ...process.env, GIT_AUTHOR_NAME: "Outside contributor", GIT_AUTHOR_EMAIL: "outside@example.test", GIT_COMMITTER_NAME: "Outside contributor", GIT_COMMITTER_EMAIL: "outside@example.test" } })
   git(["clone", "-q", "--branch", "main", join(fixture.home, "git/local-owner/demo.git"), "."])
   mkdirSync(join(work, "flows/todo"), { recursive: true }); writeFileSync(join(work, "flows/todo/flow.ts"), "export default (\n")
   git(["add", "flows/todo/flow.ts"]); git(["commit", "-qm", "💥 test: broken repository flow"]); git(["push", "-q", "origin", "HEAD:refs/heads/main"])
  } finally { rmSync(work, { recursive: true, force: true }) }
  await say(owner.page, "/github.retry")
  await say(owner.page, "/stack")
  await expect(homeRows(owner.page).filter({ hasText: "flow-load" })).toBeVisible({ timeout: 5 * 60_000 })
  const first = (await runs(owner.page)).find(row => row.title === "flow-load")!; expect(first.state).toBe("failed")
  const row = homeRows(owner.page).filter({ hasText: "flow-load" })
  await expect(row).toContainText("flows/todo/flow.ts")
  await test.info().attach("failed-background-home", { body: await owner.page.screenshot(), contentType: "image/png" })
  const posts: string[] = []
  owner.page.on("request", request => { if (request.method() === "POST" && request.url().includes("/api/runs/")) posts.push(request.url()) })
  await row.getByRole("button", { name: "Retry", exact: true }).focus()
  await owner.page.keyboard.press("Enter"); await owner.page.keyboard.press("Enter")
  await expect.poll(async () => (await runs(owner.page)).find(row => row.title === "flow-load")?.id, { timeout: 5 * 60_000 }).not.toBe(first.id)
  expect(posts.filter(url => url.endsWith(encodeURIComponent(first.id)))).toHaveLength(1)
  const retried = (await runs(owner.page)).find(row => row.title === "flow-load")!; expect(retried.state).toBe("failed")
  await say(alice.page, "/stack"); await expect(homeRows(alice.page)).toBeVisible()
  await expect(homeRows(alice.page).getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
  for (const op of ["retry", "dismiss"]) { const response = await alice.page.request.post(`${app}/api/runs/${encodeURIComponent(retried.id)}`, { data: { op } }); expect(response.status()).toBe(403) }
  await say(ben.page, "/stack")
  await homeRows(ben.page).filter({ hasText: "flow-load" }).getByRole("button", { name: "Dismiss", exact: true }).focus(); await ben.page.keyboard.press("Enter")
  await expect(homeRows(ben.page)).toHaveCount(0)
  for (const page of [owner.page, alice.page]) { await page.reload(); await say(page, "/stack"); await expect(homeRows(page)).toHaveCount(0); expect(await runs(page)).toEqual([]) }
  await test.info().attach("dismissed-background-home", { body: await ben.page.screenshot(), contentType: "image/png" })
 } finally { await owner.context.close(); await ben?.context.close(); await alice?.context.close() }
})
