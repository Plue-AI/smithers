import { authenticatedTest as test } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, command, expect, realApi } from "./support/test"

// Run on the reference install after Source ready, with the machine image
// build held. The canary's committed main contains this literal file. This
// suite reads only; provisioning and the hold belong to T-INS-06's fixture.
const expiry = 'export function sendExpiryEmail() { return "expiry" }\n'

test("Source-ready file card answers before Machine ready", scenario("file.first-answer", {
  capabilities: ["install"],
  coverage: ["action:file", "path:success", "evidence:branch-file-http-readback", "door:slash", "dimension:keyboard", "host:local"]
}), async ({ page, request }, info) => {
  await page.goto("/")
  await awaitBoot(page)
  const install = await realApi(page, request, "GET", "/api/install")
  expect(install.status()).toBe(200)
  const before = await install.json() as { steps: Array<{ id: string; state: string }> }
  expect(before.steps.find(step => step.id === "source")?.state).toBe("done")
  expect(before.steps.find(step => step.id === "machine")?.state).not.toBe("done")
  const requests: string[] = []
  page.on("request", request => { if (request.url().includes("/workspace/sessions")) requests.push(request.url()) })
  const started = performance.now()
  await command(page, "where do we send the expiry email?")
  const editor = page.getByRole("textbox", { name: "src/mail/expiry.ts", exact: true }).last()
  await expect(editor).toContainText(expiry.trim())
  await expect(editor).toHaveAttribute("aria-readonly", "true")
  await info.attach("file-card-time", { body: JSON.stringify({ ms: performance.now() - started }), contentType: "application/json" })
  await editor.focus()
  await page.keyboard.press("Control+Space")
  await page.keyboard.press("F12")
  await expect(page.locator(".cm-tooltip")).toHaveCount(0)
  expect(requests).toEqual([])
  const file = await realApi(page, request, "GET", "/api/branches/main/files/src/mail/expiry.ts")
  expect(file.status()).toBe(200)
  expect((await file.json()).content).toEqual({ kind: "text", text: expiry })
  const after = await realApi(page, request, "GET", "/api/install")
  expect((await after.json()).steps.find((step: { id: string }) => step.id === "machine").state).not.toBe("done")
  await info.attach("install-before", { body: JSON.stringify(before), contentType: "application/json" })
})
