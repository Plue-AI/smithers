import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { withGitHubInstall } from "./github-install-fixture"

// Served merge, background engine and transactional wiki receipt, observed
// through the mounted TODO and its ordinary wiki.page action. MicroVM/root
// qualification remains separate from this trusted-process install proof.
test.use({ trace: "on", video: "on" })

test("C-J8-01: a merged TODO opens its source-linked learning page after reload", { tag: "@install" }, async ({ page }) => {
  test.setTimeout(600_000)
  await withGitHubInstall(page, "TestJ8Rehearsal", "SMITHERS_J8_REHEARSAL", async fixture => {
    const learned = await fixture.phase("learned") as Awaited<ReturnType<typeof fixture.phase>> & { slug: string; squash: string; learningRun: string }
    await fixture.open(learned)
    for (let visit = 0; visit < 2; visit++) {
      if (visit) await fixture.open(learned)
      await say(page, `/todo T${learned.number}`)
      const todo = page.getByRole("article", { name: `TODO T${learned.number}`, exact: true }).last()
      await expect(todo.locator("header .state")).toContainText("Merged")
      const receipt = page.getByRole("region", { name: `Lessons from T${learned.number}`, exact: true }).last()
      await expect(receipt).toContainText("1 lesson")
      const lesson = receipt.locator('button[data-flow="wiki.page"]')
      await expect(lesson).toHaveCount(1)
      await lesson.press("Enter")
      const decision = page.locator(".world-card-doc").last()
      await expect(decision).toContainText("because it already backs off")
      await expect(decision).toContainText(learned.squash)
      await expect(decision).toContainText(learned.learningRun)
      const response = await page.request.get(`${learned.origin}/api/repos/rehearsal-owner/app/wiki/${learned.slug}`)
      expect(response.status()).toBe(200)
      const body = await response.text()
      expect(body).toContain(learned.squash)
      expect(body).toContain(learned.learningRun)
      expect(body).toContain("because it already backs off")
      await expect(page.getByTestId("composer-input")).toBeEditable()
    }
    await fixture.acknowledge("learned")
  }, "learned", 480_000)
})
