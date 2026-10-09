import { expect } from "@playwright/test"
import { showcase } from "../showcase"

export default showcase({
  id: "search",
  order: 25,
  title: "Search",
  summary: "? lists the search prefixes; a search answers with a card whose rows run.",
  flows: ["search.flows", "search", "agents"],
  run: async ({ page, app, backend }) => {
    await backend.cloud()
    await app.open("/")
    await app.press("ControlOrMeta+k")
    const input = page.getByTestId("composer-input")
    await app.type(input, "?")
    await expect(page.getByTestId("palette")).toContainText("history:")
    await app.beat(1600)
    await app.slash("/search.flows history")
    const results = page.getByTestId("transcript").locator('.smithers-card[data-kind="search-results"]')
    await expect(results.last()).toContainText("search.history")
    await app.closeComposer()
    await app.show(results.last())
    await app.beat(1200)
    await app.slash("/search agents")
    await expect(results.last()).toContainText("agents")
    await app.closeComposer()
    await app.show(results.last())
    await app.click(results.last().getByRole("button", { name: "The factory's agents" }))
    const agents = page.getByTestId("transcript").locator('.smithers-card[data-kind="agents"]')
    await expect(agents).toBeVisible()
    await app.show(agents)
  }
})
