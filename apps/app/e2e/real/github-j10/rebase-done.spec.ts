import { readFileSync } from "node:fs"
import { realApi, awaitBoot, expect, test } from "../support"
import { scenario } from "../coverage/types"
import { runSlash } from "../issues/local"

test("TODO Done validates the retained conflict through the composed install", scenario("journey-rebase-done", {
  capabilities: [],
  coverage: ["host:local", "action:todo.answer", "path:error", "path:success", "surface:todo", "door:button", "door:slash"],
  description: "After restart, unresolved Done refuses; a person writes the resolution and Done resumes the same attempt."
}), async ({ browser }) => {
  test.setTimeout(120_000)
  const host = JSON.parse(readFileSync(process.env.SMITHERS_JOURNEY_COMPOSED_HOST!, "utf8")) as {
    origin: string; repository: string; todo: number;
    cookies: { name: string; value: string }[]
  }
  const context = await browser.newContext({ baseURL: host.origin })
  try {
    await context.addCookies(host.cookies.map(cookie => ({ ...cookie, url: host.origin, httpOnly: cookie.name !== "__csrf" })))
    const page = await context.newPage()
    await page.goto(`${host.origin}/${host.repository}`)
    await awaitBoot(page)
    await runSlash(page, `/todo T${host.todo}`)
    await expect(page.getByText("JOURNEY.md", { exact: true }).last()).toBeVisible()
    const done = page.getByRole("button", { name: "Done", exact: true }).last()
    await expect(done).toBeVisible()
    const answer = () => page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/todos/${host.todo}/answer`)
    let response = answer()
    await done.press("Enter")
    expect((await response).status()).toBe(409)
    const cardResponse = await realApi(page, context.request, "GET", `/api/todos/${host.todo}`)
    expect(cardResponse.status()).toBe(200)
    const card = await cardResponse.json() as { branch: { id: string } }
    const path = `/api/repos/${host.repository}/workspaces/${card.branch.id}/files/content?path=JOURNEY.md`
    const fileResponse = await realApi(page, context.request, "GET", path)
    expect(fileResponse.status()).toBe(200)
    const file = await fileResponse.json() as { digest: string }
    const write = await realApi(page, context.request, "PUT", path, {
      base_digest: file.digest, content: "Greeting from new main\nHello from Smithers!\n"
    })
    expect(write.status()).toBe(200)
    response = answer()
    await done.press("Enter")
    expect((await response).status()).toBe(202)
    await runSlash(page, "/stack")
    await expect(page.getByTestId("composer-input")).toBeEnabled()
  } finally {
    await context.close()
  }
})
