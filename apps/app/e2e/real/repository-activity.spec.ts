import { scenario } from "./coverage/types"
import { awaitBoot, closeComposer, command, expect, realApi, reloadApp, test } from "./support/test"

test("signed-out repository activity keeps actual source refusals visible without claiming nothing new", scenario("repository-activity.public-partial-read", {
  capabilities: ["identity", "cloud"],
  description: "Read actual public repository activity while signed out, verify the notification source refuses access and the card reports a partial read without an empty-success claim, then reload and refresh through the keyboard. No account data or workflow is written.",
  coverage: ["action:repo.overview", "host:production", "path:permission", "path:persistence", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:reload", "dimension:signed-out", "evidence:actual-source-refusal-and-card-readback"]
}), async ({ page, request }, testInfo) => {
  const repo = "smithersai/smithers"
  const started = performance.now()
  await page.goto(`/${repo}`, { waitUntil: "domcontentloaded" })
  await awaitBoot(page, "navigate", started)
  expect(await (await realApi(page, request, "GET", "/api/auth/session")).json()).toMatchObject({ status: "signed-out" })
  const refusal = () => page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/notifications/list")
  const observed = refusal()
  void observed.catch(() => undefined)
  await command(page, `/repo.overview ${repo}`)
  await closeComposer(page)
  const response = await observed
  expect([401, 403]).toContain(response.status())
  const activity = page.locator(".repo-update")
  await expect(activity).toBeVisible()
  await testInfo.attach("partial-activity-readback", { contentType: "application/json", body: Buffer.from(JSON.stringify({ repo, notificationStatus: response.status(), text: await activity.innerText() })) })
  const assertPartial = async () => {
    await expect(activity.getByRole("status")).toContainText("Partial update:")
    await expect(activity.getByText("Nothing new since the last check.", { exact: true })).toHaveCount(0)
  }
  await assertPartial()
  await reloadApp(page)
  await assertPartial()
  const refreshed = refusal()
  void refreshed.catch(() => undefined)
  await activity.getByRole("button", { name: "Refresh", exact: true }).press("Enter")
  expect([401, 403]).toContain((await refreshed).status())
  await assertPartial()
})
