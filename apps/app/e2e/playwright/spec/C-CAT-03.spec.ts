import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// The real delegated request and private browser approval are exercised by
// TestConfirmationsBrowserPostgres / e2e/real/confirm-merge.browser.ts. This
// projection checks that an installed skill and the visible Commands agree.
test("C-CAT-03: Installed external-agent skill and Commands share the catalog", async ({ page }) => {
  const home = await mkdtemp(join(tmpdir(), "cat03-skills-"))
  try {
    await mkdir(join(home, ".claude"))
    const entry = pathToFileURL(resolve(__dirname, "../../../../../packages/smithers/src/Cli.ts")).href
    await promisify(execFile)("node", ["--no-warnings", "--input-type=module", "--eval",
      `import { makeCli } from ${JSON.stringify(entry)}; await makeCli().serve(["skills", "add"]);`], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config") },
      timeout: 30_000
    })
    const skill = await readFile(join(home, ".claude/skills/smithers/SKILL.md"), "utf8")
    for (const line of [
      "`smthrs todo show` — run. Open a TODO",
      "`smthrs todo new` — confirm; waits for the person's confirmation. Write and place a TODO",
      "`smthrs merge` — confirm; waits for the person's confirmation. Review and merge the next item"
    ]) expect(skill).toContain(line)
    for (const group of ["admin", "org", "tui", "secrets set", "members add"]) expect(skill).not.toContain(`smthrs ${group}`)

    await owner(page)
    await page.goto("/")
    await say(page, "/help")
    const commands = page.getByRole("article", { name: "Commands", exact: true }).last()
    for (const summary of ["Open a TODO", "Write and place a TODO", "Review and merge the next item"]) {
      await expect(commands).toContainText(summary)
    }
    await expect(commands).not.toContainText("smthrs-admin")
    await expect(commands).not.toContainText("smthrs-org")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
