import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import fixture from "./CatalogCli.fixture.json" with { type: "json" }

it("skills add installs and refreshes the packaged authoring skill from an unrelated directory", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-skills-install-"))
  const home = join(root, "home")
  const cwd = join(root, "workspace")
  mkdirSync(join(home, ".claude"), { recursive: true })
  mkdirSync(cwd)
  const entry = new URL("../src/Cli.ts", import.meta.url).href
  const source = fileURLToPath(new URL("../skills/smithers/SKILL.md", import.meta.url))
  const installed = join(home, ".claude/skills/smithers/SKILL.md")
  const install = () =>
    spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "--eval", `import { makeCli } from ${JSON.stringify(entry)}; await makeCli().serve(["skills", "add"])`], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: join(home, ".config")
      },
      encoding: "utf8",
      timeout: 60_000
    })
  try {
    const first = install()
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(source, "utf8"))
    for (const group of fixture.excluded) {
      expect(readFileSync(installed, "utf8")).not.toContain(`smthrs ${group}`)
    }
    const section = readFileSync(installed, "utf8").split("## Commands\n")[1]!
    expect([...section.matchAll(/- `smthrs ([^`]+)` — (run|confirm|never)/g)].map(match => ({ path: match[1], agent: match[2] })).sort((a,b) => a.path!.localeCompare(b.path!)))
      .toEqual([...fixture.commands].sort((a,b) => a.path.localeCompare(b.path)))
    for (const word of fixture.banned) expect(section).not.toMatch(new RegExp(`\\b${word}s?\\b`, "i"))
    for (const row of fixture.commands.filter(row => row.agent === "confirm")) {
      expect(section).toContain(`smthrs ${row.path}\` — confirm; waits for the person's confirmation`)
    }
    const directories = readdirSync(join(home, ".claude/skills"), { withFileTypes: true }).filter(entry => (entry.isDirectory() || entry.isSymbolicLink())).map(entry => entry.name)
    expect(directories).toContain("smithers")
    const generated = directories.filter(name => name.startsWith("smthrs"))
    expect(generated.length).toBeGreaterThan(0)
    const installedCommands: string[] = []
    for (const directory of generated) {
      const text = readFileSync(join(home, ".claude/skills", directory, "SKILL.md"), "utf8")
      installedCommands.push(...[...text.matchAll(/^# smthrs (.+)$/gm)].map(match => match[1]!))
      for (const group of fixture.excluded) expect(text).not.toMatch(new RegExp(`^#+ smthrs ${group}(?: |$)`, "m"))
    }
    expect(installedCommands.sort()).toEqual([...fixture.commands.map(row => row.path), ...fixture.b6].sort())
    expect(directories.sort()).toEqual(["smithers", ...new Set(installedCommands.map(path => `smthrs-${path.split(" ")[0]}`))].sort())
    writeFileSync(installed, "stale installed content")
    const refreshed = install()
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0)
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(source, "utf8"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 150_000)
