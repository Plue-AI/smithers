import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("skills add installs and refreshes the packaged authoring skill from an unrelated directory", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-skills-install-"))
  const home = join(root, "home")
  const cwd = join(root, "workspace")
  mkdirSync(join(home, ".claude"), { recursive: true })
  mkdirSync(cwd)
  const entry = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
  const source = fileURLToPath(new URL("../skills/smithers/SKILL.md", import.meta.url))
  const installed = join(home, ".claude/skills/smithers/SKILL.md")
  const install = () =>
    spawnSync(process.execPath, ["--no-warnings", entry, "skills", "add"], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: join(home, ".config")
      },
      encoding: "utf8",
      timeout: 30_000
    })
  try {
    const first = install()
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(source, "utf8"))
    for (const group of ["tui", "triggers", "org"]) {
      expect(readFileSync(installed, "utf8")).not.toContain(`smthrs ${group}`)
    }
    writeFileSync(installed, "stale installed content")
    const refreshed = install()
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0)
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(source, "utf8"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
