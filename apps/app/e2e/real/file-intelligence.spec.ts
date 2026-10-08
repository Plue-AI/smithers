import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { authenticatedTest as test } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, command, expect, realApi } from "./support/test"

const execute = promisify(execFile)
const probeSSH = async (hostVariable: string, portVariable: string, operation: string) => {
  const host = process.env[hostVariable]
  const port = process.env[portVariable]
  if (!host || host.startsWith("-") || !port || !/^\d+$/.test(port)) throw new Error(`Provision ${hostVariable} and ${portVariable} for the read-only confinement probe`)
  return (await execute("ssh", ["-o", "BatchMode=yes", "-p", port, host, operation], { timeout: 30_000 })).stdout
}

// Reference-host prerequisite: committed src/a.ts has add on line 3;
// src/b.ts calls add(1, "2") on line 5. T1 is awake with an isolated,
// validated TypeScript language server, with fixtures/file-intelligence's
// canary plugin installed as a dependency in that branch. This test never creates a fixture in
// a real GitHub repository or starts a language server on the test host.
test("File card keyboard intelligence on the branch machine", scenario("file.intelligence", {
  capabilities: ["install", "code.intelligence"],
  coverage: ["action:file", "action:code.hover", "action:code.definition", "action:code.diagnostics", "dimension:keyboard", "path:success", "evidence:branch-file-http-readback", "door:slash", "host:local"]
}), async ({ page, request }, info) => {
  const branch = process.env.SMITHERS_INTELLIGENCE_BRANCH
  if (!branch) throw new Error("Set SMITHERS_INTELLIGENCE_BRANCH to the awake T1 branch id")
  await page.goto("/")
  await awaitBoot(page)
  const frames: string[] = []
  const sessions: { url: string; body: unknown }[] = []
  page.on("response", response => {
    if (response.request().method() === "POST" && /\/api\/branches\/[^/]+\/lsp$/.test(new URL(response.url()).pathname)) {
      sessions.push({ url: response.url(), body: response.status() })
    }
  })
  page.on("websocket", socket => {
    socket.on("framesent", frame => frames.push(String(frame.payload)))
  })
  const openCaller = () => command(page, `/file ${JSON.stringify({ branch, path: "src/b.ts", line: 5, column: 1 })}`)
  await openCaller()
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
  await openCaller()
  await command(page, `/code.diagnostics ${JSON.stringify({ path: "src/b.ts", repo: branch })}`)
  await expect(editor.locator(".cm-lintRange-error")).toHaveCount(1)
  await editor.focus()
  await page.keyboard.press("Control+Shift+m")
  await expect(page.locator(".cm-diagnosticText")).toHaveText("Argument of type 'string' is not assignable to parameter of type 'number'.")
  const diagnostic = editor.locator(".cm-lintRange-error").first()
  await expect(diagnostic.locator("xpath=..")).toContainText('add(1, "2")')
  await expect.poll(() => frames.some(frame => frame.includes('"method":"textDocument/hover"'))).toBe(true)
  await expect.poll(() => frames.some(frame => frame.includes('"method":"textDocument/definition"'))).toBe(true)
  // Literal HTTP content proves the card's mirror door independently of LSP.
  const file = await realApi(page, request, "GET", `/api/branches/${encodeURIComponent(branch)}/files/src/b.ts`)
  expect(file.status()).toBe(200)
  expect((await file.json()).content).toEqual({ kind: "text", text: 'import { add } from "./a"\n\n// Exactly one TypeScript diagnostic, on line five.\n\nadd(1, "2")\n' })
  // Repeated hover/definition/diagnostics reuse Ben's one daemon exec session.
  expect(sessions).toHaveLength(1)
  expect(sessions[0]!.body).toBe(201)
  const memberUid = Number((await probeSSH("SMITHERS_INTELLIGENCE_SSH_HOST", "SMITHERS_INTELLIGENCE_SSH_PORT", "id -u")).trim())
  const plugin = JSON.parse(await probeSSH("SMITHERS_INTELLIGENCE_SSH_HOST", "SMITHERS_INTELLIGENCE_SSH_PORT", "cat /tmp/smithers-lsp-plugin-canary.json")) as { uid: number; gid: number; groups: number[]; marker: string; cwd: string }
  expect(memberUid).toBeGreaterThan(0)
  expect(plugin.uid).toBe(memberUid)
  expect(plugin.gid).toBeGreaterThan(0)
  expect(plugin.groups).not.toContain(0)
  expect(plugin.marker).toBe("branch-plugin-only")
  expect(plugin.cwd).toBe("/workspace")
  // Probe the install host itself, independently of the guest namespace.
  const hostProcesses = await probeSSH("SMITHERS_INTELLIGENCE_INSTALL_SSH_HOST", "SMITHERS_INTELLIGENCE_INSTALL_SSH_PORT", "test ! -e /tmp/smithers-lsp-plugin-canary.json && ps -axo command")
  expect(/typescript-language-server|tsserver\.js/.test(hostProcesses)).toBe(false)
  await info.attach("plugin-confinement", { body: JSON.stringify({ memberUid, plugin, sessions }), contentType: "application/json" })
  await info.attach("lsp-tunnel-requests", { body: JSON.stringify(frames), contentType: "application/json" })
})

test("C-UI-11: webpage reader preserves the literal canary after reload", scenario("file.intelligence-reader", {
  capabilities: ["install", "browser.read"],
  coverage: ["action:browser.open", "door:slash", "path:success", "path:persistence", "evidence:reader-canary-http", "host:local"]
}), async ({ page }, info) => {
  const origin = process.env.SMITHERS_READER_CANARY_URL
  if (!origin || !/^https?:$/.test(new URL(origin).protocol)) throw new Error("Set SMITHERS_READER_CANARY_URL to the publicly reachable static page.html fixture")
  await page.goto("/"); await awaitBoot(page)
  const fetching = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tools/browser-fetch")
  await command(page, `/browser.open ${origin}`)
  const response = await fetching
  expect(response.status()).toBe(200)
  const result = await response.json()
  expect(result.text).toContain("Reader canary body")
  const reader = page.locator('[data-kind="browser"]').last()
  await expect(reader).toBeVisible()
  const frame = reader.frameLocator(".browser-card-frame")
  await expect(frame.locator("title")).toHaveText("Reader canary")
  await expect(frame.getByText("Reader canary body", { exact: true })).toBeVisible()
  await page.reload(); await awaitBoot(page)
  await expect(frame.getByText("Reader canary body", { exact: true })).toBeVisible()
  await info.attach("reader-canary", { body: JSON.stringify(result), contentType: "application/json" })
})
