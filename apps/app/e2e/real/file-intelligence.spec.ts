import { authenticatedTest as test } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, command, expect, realApi } from "./support/test"

// Reference-host prerequisite: committed src/a.ts has add on line 3;
// src/b.ts calls add(1, "2") on line 5. T1 is awake with an isolated,
// validated TypeScript language server. This test never creates a fixture in
// a real GitHub repository or starts a language server on the test host.
test("File card keyboard intelligence on the branch machine", scenario("file.intelligence", {
  capabilities: ["install", "cloud.terminal"],
  coverage: ["action:files.read", "action:code.hover", "action:code.definition", "action:code.diagnostics", "dimension:keyboard", "path:success", "door:slash", "host:local"]
}), async ({ page, request }, info) => {
  await page.goto("/")
  await awaitBoot(page)
  const frames: string[] = []
  page.on("websocket", socket => {
    socket.on("framesent", frame => frames.push(String(frame.payload)))
  })
  await command(page, "/branch T1")
  await command(page, "/files.read src/b.ts:5:1 --ref T1")
  const editor = page.getByRole("textbox", { name: "src/b.ts", exact: true }).last()
  await expect(editor).toContainText('add(1, "2")')
  await expect(editor).toHaveAttribute("aria-readonly", "true")
  await editor.focus()
  const started = performance.now()
  await page.keyboard.press("Control+Space")
  await expect(page.locator(".cm-tooltip").last()).toContainText("add(x: number, y: number): number", { timeout: 3000 })
  await info.attach("first-language-server-request", { body: JSON.stringify({ ms: performance.now() - started }), contentType: "application/json" })
  await page.keyboard.press("Escape")
  await page.keyboard.press("F12")
  const definition = page.getByRole("textbox", { name: "src/a.ts", exact: true }).last()
  await expect(definition).toBeVisible()
  await expect(definition.locator("xpath=ancestor::*[@data-line][1]")).toHaveAttribute("data-line", "3")
  await expect(definition.locator(".cm-line").nth(2)).toContainText("export function add(x: number, y: number): number")
  await command(page, "/files.read src/b.ts:5:1 --ref T1")
  await command(page, "/code.diagnostics src/b.ts")
  await expect(editor.locator(".cm-lintRange-error")).toHaveCount(1)
  await editor.focus()
  await page.keyboard.press("Control+Shift+m")
  await expect(page.locator(".cm-diagnosticText")).toHaveText("Argument of type 'string' is not assignable to parameter of type 'number'.")
  const diagnostic = editor.locator(".cm-lintRange-error").first()
  await expect(diagnostic.locator("xpath=..")).toContainText('add(1, "2")')
  await expect.poll(() => frames.some(frame => frame.includes('"method":"textDocument/hover"'))).toBe(true)
  await expect.poll(() => frames.some(frame => frame.includes('"method":"textDocument/definition"'))).toBe(true)
  // Literal HTTP content proves the card's mirror door independently of LSP.
  const file = await realApi(page, request, "GET", "/api/branches/T1/files/src/b.ts")
  expect(file.status()).toBe(200)
  await info.attach("lsp-tunnel-requests", { body: JSON.stringify(frames), contentType: "application/json" })
})
