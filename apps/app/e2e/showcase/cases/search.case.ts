import { expect } from "@playwright/test"
import { showcase } from "../showcase"

export default showcase({
  id: "search",
  order: 25,
  title: "Search",
  summary: "? lists the search prefixes; a search answers with a card whose rows run.",
  flows: ["search.flows", "search.open", "agent.list"],
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
    await expect(results.last()).toContainText("history.show")
    await app.closeComposer()
    await app.show(results.last())
    await app.beat(1200)
    await app.slash("/search.open agents")
    await expect(results.last()).toContainText("agent.list")
    await app.closeComposer()
    await app.show(results.last())
    await app.click(results.last().getByRole("button", { name: "Show the agents and their runs" }))
    const agents = page.getByTestId("transcript").locator('.smithers-card[data-kind="agents"]')
    await expect(agents).toBeVisible()
    await app.show(agents)
  }
})
