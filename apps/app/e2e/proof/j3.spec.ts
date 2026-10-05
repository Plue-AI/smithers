import { APP, expect, say, setUp, test, type Install } from "./fixtures"
import type { Locator, Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/*
 * J3 Join a branch (mvp.md J3; mock steps j3#1 to j3#15) on the real bundle, the GitHub fake and real models.
 * Ben and Alice each drive their own recorded browser; Maya owns the install, sets it up and works from her laptop
 * over SSH, as the mock's outside editor. The journey's starting state is the "start" step, done through the UI:
 * setup, Ben and Alice as members, and T1, whose prompt leaves a decision open so the real coding agent asks a
 * person. Then one proofStep per feature in mock-step order; each screenshots Ben's screen (the step's page) and
 * Alice's (attached as "<id>: alice"). A failing step records its error and the walk goes on; a step that needs a
 * failed one records "blocked by <id>".
 */
type Served = { n: number; state: string; title: string; branch?: { name?: string }; failure?: unknown }
/** The server's TODO, read as the person's browser reads it (never written through the API). */
const served = async (page: Page, n: number): Promise<Served> => {
  const response = await page.request.get(`${APP}/api/todos/${n}`)
  expect(response.status()).toBe(200)
  return response.json()
}
const waitState = async (page: Page, n: number, states: RegExp, timeout: number) => {
  const began = Date.now()
  for (let todo = await served(page, n); !states.test(todo.state); todo = await served(page, n)) {
    if (/^(failed|dropped)$/.test(todo.state) || Date.now() - began > timeout)
      throw new Error(`T${n} ${JSON.stringify({ state: todo.state, failure: todo.failure })} after ${Math.round((Date.now() - began) / 1000)} s; expected ${states}`)
    await page.waitForTimeout(2_000)
  }
}
const todoCard = (page: Page, n: number) => page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
const branchCard = (page: Page) => page.locator('[data-kind="branch"]').last()
const terminalCard = (page: Page) => page.locator('[data-kind="terminal"]').last()
const fileCard = (page: Page) => page.locator('[data-kind="file"]').last()
const editor = (page: Page) => fileCard(page).locator(".cm-content")
const presence = (page: Page) => branchCard(page).getByRole("list", { name: "On this branch", exact: true })
const activity = (page: Page) => branchCard(page).locator(".branch-activity")
const row = (list: Locator, who: string) => list.locator("li").filter({ hasText: who })
const short = { timeout: 15_000 }

/** retry.ts as the mock's branch has it: Alice works at line 10 and the coding agent at line 14. */
const RETRY_TS = [
  "// Retries a webhook delivery with backoff.",
  "export type Delivery = () => Promise<number>",
  "",
  "export async function retryWithBackoff(send: Delivery, attempts = 3): Promise<number> {",
  "  let status = 0",
  "  for (let attempt = 0; attempt < attempts; attempt++) {",
  "    status = await send()",
  "    if (status < 500) return status",
  "    // Wait before the next attempt.",
  "    await new Promise(done => setTimeout(done, 100 * 2 ** attempt))",
  "  }",
  "  return status",
  "}",
  "",
  "export const DEFAULT_ATTEMPTS = 3",
  ""
].join("\n")
/** The failing test Ben runs (j3#4): it expects three attempts on 503 and fails until the delay policy lands. */
const RETRY_TEST = [
  "import { test } from \"node:test\"",
  "import assert from \"node:assert/strict\"",
  "import { readFileSync } from \"node:fs\"",
  "test(\"retry.ts caps the delay at 5 s\", () => assert.match(readFileSync(new URL(\"./retry.ts\", import.meta.url), \"utf8\"), /5_?000/))",
  ""
].join("\n")
/** Twelve files a formatter rewrites at once: Maya's format over SSH changes each (j3#6). */
const FORMAT_FILES = Object.fromEntries(Array.from({ length: 12 }, (_, i) =>
  [`src/hook${String(i + 1).padStart(2, "0")}.mjs`, `export const hook${i + 1} = {name:"hook${i + 1}",retries:${i % 3}}\n`]))
const T1 = {
  title: "Retry webhooks with the chosen delay",
  prompt: "Change retryWithBackoff in retry.ts to the delay policy I choose: exponential backoff capped at 5 s, or a fixed 2 s delay. " +
    "I have not decided yet: ask me which one before you plan, and do not guess. Make retry.test.mjs pass."
}
const QUESTION = "Why does retryWithBackoff wait before the next attempt in retry.ts?"
const ANSWER = "Use exponential backoff capped at 5 s, the existing retry helper's shape."
const BEN_EDIT = "// ben: attempts start at zero", ALICE_EDIT = "// alice: 5xx retries only"

/**
 * Maya pushes retry.ts, its test and twelve unformatted files from her laptop to maya/demo on GitHub (the fake's
 * smart-HTTP repository) before the install mirrors it: the repository the journey's branch works on.
 */
const pushStartingCode = (install: Install, dir: string) => {
  const bare = join(install.home, "git", `${install.repo}.git`), work = join(dir, "maya-laptop")
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Maya", "-c", "user.email=maya@example.test", ...args], { stdio: "pipe" })
  git("clone", "-q", bare, work)
  for (const [path, content] of Object.entries({ "retry.ts": RETRY_TS, "retry.test.mjs": RETRY_TEST, ...FORMAT_FILES })) {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), content)
  }
  git("-C", work, "add", "-A")
  git("-C", work, "commit", "-q", "-m", "Webhook retries")
  git("-C", work, "push", "-q", "origin", "HEAD:main")
}

test("J3 Join a branch", async ({ install, person, proofStep }) => {
  test.setTimeout(150 * 60_000)
  const dir = mkdtempSync(join(tmpdir(), "proof-j3-"))
  const maya = await person("maya")
  let ben!: Page, alice!: Page

  /** proofStep with both screens: Ben's as the step's screenshot, Alice's attached beside it. */
  const step = (id: string, fn: () => Promise<void>, needs: string[] = []) => proofStep(id, async () => {
    try { await fn() } finally {
      if (alice && !alice.isClosed()) {
        const path = test.info().outputPath("proof", `${id}-alice.png`)
        await alice.screenshot({ path, fullPage: true }).then(() => test.info().attach(`${id}: alice`, { path, contentType: "image/png" })).catch(() => undefined)
      }
    }
  }, { page: ben ?? maya, needs })

  const ready = await proofStep("start", async () => {
    pushStartingCode(install, dir)
    await setUp(maya, install)
    await say(maya, "/members")
    const members = maya.getByRole("region", { name: "Members", exact: true }).last()
    for (const login of ["ben", "alice"]) {
      await members.getByLabel("GitHub username", { exact: true }).fill(login)
      await members.getByRole("button", { name: "Add", exact: true }).click()
      await expect(members.locator(`li[data-login="${login}"]`)).toBeVisible(short)
    }
    // T1, committed through the Draft (J1, not a J3 feature).
    await say(maya, "/todo.new")
    const draft = maya.getByRole("region", { name: "Draft", exact: true }).last()
    await draft.getByLabel("Title", { exact: true }).fill(T1.title)
    await draft.getByLabel("Prompt", { exact: true }).fill(T1.prompt)
    await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption({ label: "Append" })
    await draft.getByRole("button", { name: "Commit", exact: true }).click()
    await expect(todoCard(maya, 1)).toBeVisible(short)
    ben = await person("ben")
    alice = await person("alice")
    // Alice is already on the branch, in retry.ts at line 10, through her own composer.
    await say(alice, "/branch T1")
    await say(alice, "/file retry.ts:10")
  }, { page: maya })
  const start = ready ? [] : ["start"]

  // j3#1: Ben sees T1 waiting on a person and opens its branch from the stack row.
  await step("open-todo-branch", async () => {
    // The real coding agent reads the open decision and asks: T1 waits on a person.
    await waitState(ben, 1, /^needs_you$/, 30 * 60_000)
    await say(ben, "/stack")
    const stackRow = ben.locator('li.mvp-stack-row[data-state="needs_you"]').filter({ hasText: T1.title }).last()
    await expect(stackRow).toBeVisible(short)
    await stackRow.locator("button.mvp-branch-chip").click(short)
    await expect(branchCard(ben)).toBeVisible(short)
    await expect(branchCard(ben)).toContainText(T1.title, short)
  }, start)

  // j3#2: Maya adds her laptop key with the CLI's route (smthrs ssh-key add) and connects to T1's branch.
  const key = join(dir, "maya_ed25519")
  let login = ""
  const ssh = (command: string) => execFileSync("ssh", ["-i", key, "-p", "2222", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=10", `${login}@127.0.0.1`, command], { encoding: "utf8", stdio: "pipe", timeout: 60_000 })
  const sshed = await step("ssh-into-branch", async () => {
    if (!existsSync(key)) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "maya@laptop", "-f", key])
    const added = await maya.request.post(`${APP}/api/user/keys`, { data: { title: "maya laptop", key: readFileSync(`${key}.pub`, "utf8").trim() } })
    expect(added.status(), `POST /api/user/keys: ${(await added.text()).slice(0, 200)}`).toBeLessThan(300)
    // The Branch card's SSH line names the login; /ssh T1 copies it.
    await say(maya, "/ssh T1")
    const line = maya.getByText(/ssh .*-p 2222 \S+@/).last()
    await expect(line, "/ssh T1 shows the branch's SSH line").toBeVisible(short)
    login = /(\S+)@/.exec(await line.innerText())?.[1] ?? ""
    expect(ssh("pwd").trim(), "SSH lands in the branch's working copy").toMatch(/\S/)
    expect(ssh("cat retry.ts")).toContain("retryWithBackoff")
  }, start)

  // j3#2: the Branch card shows everyone and where: Alice in retry.ts at line 10, Maya via SSH, the coding agent, Ben.
  await step("branch-presence", async () => {
    const list = presence(ben)
    await expect(list).toBeVisible(short)
    await expect(row(list, "alice")).toContainText("retry.ts:10", short)
    if (sshed) await expect(list).toContainText("Maya via SSH", short)
    await expect(list).toContainText(/coding agent/i, short)
    await expect(list).toContainText("ben", short)
  }, ["open-todo-branch"])

  // j3#3, #4: Ben's own terminal on the branch's machine runs as Ben; he runs the failing test; Alice stays on her file.
  await step("own-terminal", async () => {
    await branchCard(ben).getByRole("button", { name: "New terminal", exact: true }).click(short)
    await expect(terminalCard(ben)).toBeVisible(short)
    await terminalCard(ben).click()
    await ben.keyboard.type("whoami\n")
    await expect(terminalCard(ben)).toContainText(/\bben\b/, short)
    await ben.keyboard.type("node --test retry.test.mjs\n")
    await expect(terminalCard(ben)).toContainText(/# fail 1/, { timeout: 60_000 })
    await expect(fileCard(alice)).toContainText("retry.ts", short)
  }, ["open-todo-branch"])

  // j3#5: Alice opens Ben's session from his row and watches it read-only; Ben sees her watching.
  await step("watch-terminal", async () => {
    await row(presence(alice), "ben").getByRole("button", { name: /terminal/i }).click(short)
    await expect(terminalCard(alice)).toContainText(/# fail 1/, short)
    await expect(row(presence(ben), "alice")).toContainText(/watching/i, short)
  }, ["own-terminal"])

  // j3#6: Maya formats twelve files over SSH: one grouped, attributed entry, and an open file updates in place.
  await step("outside-changes", async () => {
    ssh("for f in src/hook*.mjs; do sed -i.bak 's/{name:/{ name: /; s/}$/ }/' \"$f\" && rm \"$f.bak\"; done")
    await expect(activity(ben)).toContainText(/Maya via SSH changed 12 files/, short)
  }, ["ssh-into-branch", "open-todo-branch"])

  // j3#7, #8: Ben opens retry.ts from Alice's row, where she is with her name on line 10; they type at once and each
  // sees the other's characters arrive live.
  const coedited = await step("coedit-file", async () => {
    await row(presence(ben), "alice").getByRole("button", { name: "retry.ts:10", exact: true }).click(short)
    await expect(fileCard(ben)).toContainText("retryWithBackoff", short)
    await expect(fileCard(ben).getByText("alice").first()).toBeVisible(short)
    await editor(ben).click(short)
    await ben.keyboard.press("Control+Home")
    await ben.keyboard.type(`${BEN_EDIT}\n`)
    await editor(alice).click(short)
    await alice.keyboard.press("Control+End")
    await alice.keyboard.type(`\n${ALICE_EDIT}`)
    await expect(editor(alice)).toContainText(BEN_EDIT, short)
    await expect(editor(ben)).toContainText(ALICE_EDIT, short)
  }, ["branch-presence"])

  // j3#9: no Save button; both edits are already on the machine, so Ben's terminal sees them.
  await step("edits-reach-machine", async () => {
    await expect(fileCard(ben).getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
    await terminalCard(ben).click()
    await ben.keyboard.type("grep -c -e 'ben: attempts' -e 'alice: 5xx' retry.ts\n")
    await expect(terminalCard(ben)).toContainText(/^2$/m, short)
  }, ["coedit-file", "own-terminal"])

  // j3#10: Alice asks Smithers on the branch; it joins like a teammate (Ben sees its flag in retry.ts) and answers her.
  await step("app-agent-acts-as-person", async () => {
    await say(alice, QUESTION)
    await expect(presence(ben)).toContainText(/Smithers/, { timeout: 60_000 })
    await expect(alice.locator('[data-role="assistant"]').last()).toContainText(/retry/i, { timeout: 2 * 60_000 })
  }, ["branch-presence"])

  // j3#11: the coding agent is asking, so the branch's input answers it; the answer shows with Ben's name and the
  // agent continues.
  const answered = await step("answer-from-branch", async () => {
    const card = branchCard(ben)
    await card.getByLabel("Answer the coding agent", { exact: true }).fill(ANSWER, short)
    await expect(card.getByRole("button", { name: "Steer", exact: true })).toBeVisible(short)
    await card.getByRole("button", { name: "Answer", exact: true }).click(short)
    await expect(activity(ben).locator('li[data-kind="answer"]')).toContainText("ben", short)
    await waitState(ben, 1, /^(?!needs_you$)/, 60_000)
  }, ["open-todo-branch"])
  if (!answered && ready && (await served(ben, 1)).state === "needs_you") {
    // Not a J3 feature: the walk answers on the TODO card so the agent continues and j3#12 to #14 can be measured.
    test.info().annotations.push({ type: "substitute", description: "T1 answered on its TODO card: the branch input did not answer" })
    await say(ben, "/todo T1")
    await todoCard(ben, 1).getByLabel("Answer", { exact: true }).fill(ANSWER).catch(() => undefined)
    await todoCard(ben, 1).locator('button[data-flow="todo.answer"]').first().click(short).catch(() => undefined)
    await waitState(ben, 1, /^(?!needs_you$)/, 2 * 60_000).catch(() => undefined)
  }

  // j3#12: the coding agent edits retry.ts the way a teammate does: its flag in the open File card.
  await step("coding-agent-edits-live", async () => {
    await expect(fileCard(ben).locator("[data-actor-kind='agent']").first()).toBeVisible({ timeout: 15 * 60_000 })
  }, coedited ? start : ["coedit-file"])

  // j3#13: the checks rerun on the shared working copy, in a terminal anyone on the branch can watch.
  await step("agent-commands-in-terminal", async () => {
    await expect(row(presence(ben), "coding agent").getByRole("button", { name: /terminal/i })).toBeVisible({ timeout: 15 * 60_000 })
    await row(presence(ben), "coding agent").getByRole("button", { name: /terminal/i }).click(short)
    await expect(terminalCard(ben)).toContainText(/retry\.test|node --test|pnpm test/, { timeout: 15 * 60_000 })
  }, ["branch-presence"])

  // j3#14: nobody merged on the branch; the TODO moves on to Review on its own.
  await step("todo-runs-to-pr", async () => {
    await waitState(ben, 1, /^in_review$/, 40 * 60_000)
    await say(ben, "/todo T1")
    await expect(todoCard(ben, 1).locator("header .mvp-state")).toHaveAttribute("data-state", "in_review", short)
    const writes = await install.fake.writes()
    expect(writes.filter(write => write.method === "PUT" && /\/merge$/.test(write.path)), "nobody merged").toEqual([])
  }, start)

  // j3#15: Ben goes back up the tree to main, the team's conversation; Alice stays on the branch.
  await step("branch-tree", async () => {
    await ben.locator('nav.mvp-crumb-path[aria-label="Branch"] button.mvp-crumb[data-branch="main"]').click(short)
    await expect(branchCard(ben)).toHaveCount(0, short)
    await expect(presence(alice)).toContainText("alice", short)
  }, ["open-todo-branch"])
})
