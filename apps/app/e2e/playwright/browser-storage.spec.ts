import { expect, test } from "./browserTest"

// The same origin and filename in consecutive tests catches storage leaking
// between profiles. Reload still has to read real browser-persisted bytes.
for (const attempt of [1, 2]) {
  test(`OPFS is isolated between tests and survives reload (${attempt})`, async ({ page }) => {
    const url = "https://smithers-browser-storage.invalid/probe"
    await page.route(url, route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><title>Storage probe</title>"
    }))
    await page.goto(url)
    expect(await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      return root.getFileHandle("marker").then(() => "exists", error => error.name)
    })).toBe("NotFoundError")
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const file = await root.getFileHandle("marker", { create: true })
      const writer = await file.createWritable()
      await writer.write("saved")
      await writer.close()
    })
    await page.reload()
    expect(await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      return (await (await root.getFileHandle("marker")).getFile()).text()
    })).toBe("saved")
  })
}
