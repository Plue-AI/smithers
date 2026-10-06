import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"
import { installCloudFixture } from "./cloudFixture"

// Browser contract proof. The PostgreSQL/SSH/lease journey remains reference-host evidence.
for (const optionalStreams of ["served", "unsupported"] as const) test(`install /branch T2 renders captured facts with ${optionalStreams} streams and forks without waking`, async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const posts: unknown[] = []
  const presence: unknown[] = []
  await page.route("**/api/todos/2", route => route.fulfill({ json: { branch: { name: "smithers/retry-webhooks" } } }))
  await page.route("**/api/branches/smithers%2Fretry-webhooks", route => route.fulfill({ json: { name: "smithers/retry-webhooks", machine: { id: "b-live" } } }))
  await page.route("**/api/branches", route => {
    posts.push(route.request().postDataJSON())
    return route.fulfill({ status: 201, json: { name: "scratch/ben/try-retry", kind: "scratch" } })
  })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t === "presence") { presence.push(frame.where); return }
    if (frame.t !== "sub") return
    const data = frame.topic === "branch:b-live" ? {
      id: "b-live", name: "smithers/retry-webhooks", machine: { state: "asleep" },
      item: { n: 2, title: "Retry webhooks", state: "working", place: 2 },
      presence: [{ actor: { kind: "person", login: "maya", name: "Maya", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 1, via: "ssh" }, where: { kind: "file", path: "retry.ts", line: 12 } }],
      terminals: [], ssh_line: "ssh -p 2222 retry-webhooks@localhost"
    } : (frame.topic === "branch:b-live:activity" || frame.topic === "branch:b-live:files") && optionalStreams === "served" ? [] : undefined
    socket.send(JSON.stringify(data === undefined ? { t: "err", id: frame.id, code: "unsupported" } : { t: "snap", id: frame.id, cursor: 1, data }))
  }))
  await page.goto("/")
  await fillComposer(page, "/branch T2")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("card-branch:b-live")
  await expect(card).toContainText("smithers/retry-webhooks")
  await expect(card).toContainText("Asleep")
  await expect(card).toContainText("Maya via SSH")
  await expect(card).toContainText("retry.ts:12")
  await expect(card).toContainText("ssh -p 2222 retry-webhooks@localhost")
  await expect(card.locator('[data-flow="box.resume"]')).toHaveCount(0)
  await expect.poll(() => presence[0]).toEqual({ branch: "b-live" })
  await card.getByRole("button", { name: "Fork", exact: true }).press("Enter")
  await expect.poll(() => posts).toEqual([{ from: "T2" }])
  await expect(page.getByTestId("composer-input")).toBeEnabled()
})
