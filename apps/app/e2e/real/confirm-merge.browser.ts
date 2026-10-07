/** Driven by TestConfirmationsBrowserPostgres; no browser API or live route is mocked. */
import { chromium, expect } from "@playwright/test"
import { createServer } from "vite"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const origin = process.env.SMITHERS_CONFIRMATION_ORIGIN!
const member = process.env.SMITHERS_CONFIRMATION_MEMBER!
const token = process.env.SMITHERS_CONFIRMATION_TOKEN!
const wikiToken = process.env.SMITHERS_CONFIRMATION_WIKI_TOKEN!
if (!origin || !member || !token) throw new Error("The owned PostgreSQL browser fixture is required")
const vite = await createServer({ configLoader: "runner", logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const address = vite.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Vite did not bind a port")
console.log(`CONFIRMATION_BROWSER_READY http://127.0.0.1:${address.port}`)
await Bun.stdin.text()

const cliHome = await mkdtemp(join(tmpdir(), "catalog-browser-"))
await mkdir(join(cliHome, ".claude"))
const cliEntry = new URL("../../../../packages/smithers/src/Cli.ts", import.meta.url).href
const cli = async (argv: string[]) => {
  const program = `import { makeCli } from ${JSON.stringify(cliEntry)};
let output = "", exitCode = 0;
await makeCli({ environment: process.env, exit: n => { exitCode = n } }).serve(JSON.parse(process.env.CATALOG_ARGV), {
 env: process.env, stdout: text => { output += text }, exit: n => { exitCode = n }
});
console.log("CATALOG_RESULT " + JSON.stringify({ exitCode, output }));`
  const command = Bun.spawn(["node", "--no-warnings", "--input-type=module", "--eval", program], {
    env: { PATH: process.env.PATH!, HOME: cliHome, XDG_CONFIG_HOME: cliHome, XDG_DATA_HOME: cliHome,
      CLAUDE_CONFIG_DIR: join(cliHome, ".claude"), CODEX_HOME: join(cliHome, ".codex"), CODEX_TEST: "1",
      SMITHERS_API_ORIGIN: origin, SMITHERS_TOKEN: token, CATALOG_ARGV: JSON.stringify(argv) },
    stdout: "pipe", stderr: "pipe"
  })
  const [status, stdout, stderr] = await Promise.all([command.exited, new Response(command.stdout).text(), new Response(command.stderr).text()])
  expect(status, stderr).toBe(0)
  const line = stdout.split("\n").find(line => line.startsWith("CATALOG_RESULT "))
  if (!line) throw new Error(`CLI result missing: ${stdout} ${stderr}`)
  const result = JSON.parse(line.slice("CATALOG_RESULT ".length)) as { exitCode: number; output: string }
  return { exitCode: result.exitCode, value: argv.includes("--json") ? JSON.parse(result.output) : result.output }
}
const browser = await chromium.launch({ headless: true })
try {
  const api = async (path: string, method = "GET", body?: unknown, agent: boolean | string = false, key = "fixture") => {
    const response = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key,
      ...(agent ? { Authorization: `Bearer ${typeof agent === "string" ? agent : token}`, "Smithers-Via": "codex", "Smithers-Actor": "person", "Smithers-Profile": "app_agent" } : { Cookie: "session=maya-browser-session; __csrf=csrf", "X-CSRF-Token": "csrf" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value = await response.json()
    return { status: response.status, value }
  }
  // C-CAT-03: install the actual generated skill in an isolated home, then
  // C-CAT-02: use its source CLI door across the composed install boundary.
  expect((await cli(["skills", "add"])).exitCode).toBe(0)
  const skill = await readFile(join(cliHome, ".claude/skills/smithers/SKILL.md"), "utf8")
  expect(skill).toContain("smthrs todo new` — confirm; waits for the person's confirmation")
  expect(skill).toContain("smthrs todo show` — run")
  expect(skill).not.toContain("smthrs-admin")
  const created = await cli(["todo", "new", "--title", "Browser confirmation sample", "--text", "Retain the exact private prompt.", "--json"])
  expect(created.exitCode, JSON.stringify(created.value)).toBe(3)
  expect(created.value.message).toBe("Waiting for Maya to confirm")
  expect(Object.keys(created.value).sort()).toEqual(["confirmation", "cta", "message", "state"])
  expect(created.value.state).toBe("pending")
  expect((await api("/api/todos")).value).toEqual([])

  const owner = await browser.newContext()
  await owner.addCookies([{ name: "session", value: "maya-browser-session", url: origin, httpOnly: true }, { name: "__csrf", value: "csrf", url: origin }])
  const page = await owner.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${origin}/maya/demo`)
  const commit = page.locator('[data-kind="confirm"] [data-flow="approval.approve"]').filter({ hasText: "Commit" })
  await expect(commit).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("transcript")).toContainText("Retain the exact private prompt.")

  const stranger = await browser.newContext()
  await stranger.addCookies([{ name: "session", value: "ben-browser-session", url: origin, httpOnly: true }, { name: "__csrf", value: "csrf", url: origin }])
  const other = await stranger.newPage()
  await other.goto(`${origin}/maya/demo`)
  await expect(other.getByTestId("transcript")).toBeVisible({ timeout: 90_000 })
  expect(await other.evaluate(async () => (await fetch("/api/confirmations")).json())).toEqual([])
  const forbidden = await other.evaluate(async topic => await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/live`, "smithers.live.v1")
    const timer = setTimeout(() => { socket.close(); reject(new Error("Private topic did not answer")) }, 10_000)
    socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: 99, topic }))
    socket.onmessage = event => {
      const frame = JSON.parse(String(event.data))
      if (frame.id !== 99) return
      clearTimeout(timer); socket.close(); resolve(frame.code ?? frame.t)
    }
  }), `confirmations:${member}`)
  expect(forbidden).toBe("forbidden")
  await expect(other.locator('[data-kind="confirm"]')).toHaveCount(0)

  await commit.focus(); await page.keyboard.press("Enter")
  await expect.poll(async () => (await api("/api/todos")).value.length).toBe(1)
  await expect(page.locator('[data-kind="confirm"]')).toContainText("Approved")
  // The admission committed, but the TODO is still queued. HTTP success alone
  // must not finish its progress notice, and Chat remains usable.
  const creationNotice = page.locator(`[data-notice="toast-todo.request.confirmation:${created.value.confirmation}"]`)
  await expect(creationNotice).toHaveAttribute("data-tone", "live", { timeout: 10_000 })
  await page.reload()
  await expect(creationNotice).toHaveAttribute("data-tone", "live", { timeout: 30_000 })

  const todos = (await api("/api/todos")).value
  const n = todos[0].n
  const read = await cli(["todo", "show", `T${n}`, "--json"])
  expect(read.exitCode).toBe(0)
  expect(read.value.n).toBe(n)
  const dropped = await cli(["todo", "drop", `T${n}`, "--json"])
  expect(dropped.exitCode).toBe(3)
  expect(dropped.value.message).toBe("Waiting for Maya to confirm")
  expect(Object.keys(dropped.value).sort()).toEqual(["confirmation", "cta", "message", "state"])
  expect((await api(`/api/todos/${n}`)).value.state).not.toBe("dropped")
  const drop = page.locator('[data-kind="confirm"] [data-flow="approval.approve"]').filter({ hasText: "Drop" })
  await expect(drop).toBeVisible({ timeout: 10_000 })
  const wrong = await other.evaluate(async id => {
    const response = await fetch(`/api/confirmations/${id}/approve`, { method: "POST", headers: { "X-CSRF-Token": "csrf", "Idempotency-Key": "other-press" } })
    return response.status
  }, dropped.value.confirmation)
  expect(wrong).toBe(403)
  await drop.focus(); await page.keyboard.press("Enter")
  await expect.poll(async () => (await api(`/api/todos/${n}`)).value.state).toBe("dropped")
  await expect(page.locator('[data-kind="confirm"] [data-flow="approval.approve"]')).toHaveCount(0)
  const wikiPath = "/api/repos/maya/demo/wiki/confirm-delete"
  const deletion = await api(wikiPath, "DELETE", {}, wikiToken, "browser-wiki-delete")
  expect(deletion.status).toBe(202)
  expect(Object.keys(deletion.value).sort()).toEqual(["confirmation", "state"])
  expect((await api(wikiPath)).status).toBe(200)
  const remove = page.locator('[data-kind="confirm"] [data-flow="approval.approve"]').filter({ hasText: "Delete" })
  await expect(remove).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("transcript")).toContainText("The exact page to delete")
  await expect(other.locator('[data-kind="confirm"]')).toHaveCount(0)
  await remove.focus(); await page.keyboard.press("Enter")
  await expect.poll(async () => (await api(wikiPath)).status).toBe(404)
  await expect(page.locator('[data-kind="confirm"] [data-flow="approval.approve"]')).toHaveCount(0)
  const beforeEdit = (await api("/api/todos")).value.length
  const edited = await cli(["flow", "edit", "todo", "--request", "Run tests before review", "--diff", "+pnpm test", "--json"])
  expect(edited.exitCode).toBe(3)
  expect(edited.value.state).toBe("pending")
  expect((await api("/api/todos")).value).toHaveLength(beforeEdit)
  await expect(commit).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("transcript")).toContainText("Proposed diff (untrusted context):")
  await commit.focus(); await page.keyboard.press("Enter")
  await expect.poll(async () => (await api("/api/todos")).value.length).toBe(beforeEdit + 1)
  const beforeAgentEdit = (await api("/api/todos")).value.length
  const instruction = await cli(["agent", "edit", "app", "--request", "Keep answers brief", "--diff", "+Be brief", "--json"])
  expect(instruction.exitCode).toBe(3)
  expect(instruction.value.state).toBe("pending")
  expect((await api("/api/todos")).value).toHaveLength(beforeAgentEdit)
  await expect(commit).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("transcript")).toContainText("Change instructions for the App agent in .smithers/instructions/app.md")
  await commit.focus(); await page.keyboard.press("Enter")
  await expect.poll(async () => (await api("/api/todos")).value.length).toBe(beforeAgentEdit + 1)
  const agentRows = (await api("/api/confirmations", "GET", undefined, true)).value
  expect(agentRows).toHaveLength(5)
  for (const row of agentRows) expect(Object.keys(row).sort()).toEqual(["id", "state"])
  expect(errors).toEqual([])
  console.log("CONFIRMATION_BROWSER_PASS installed skill, source CLI, named pending result, private delivery, keyboard approval, admission progress, reload, other-member refusal, Drop, Wiki Delete, Flow edit, Agent instruction edit, delegated redaction")
} finally {
  await browser.close()
  await vite.close()
  await rm(cliHome, { recursive: true, force: true })
}
