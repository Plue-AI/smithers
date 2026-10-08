import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

/*
 * A removed component takes its CSS with it.
 *
 * `tsc` never reads a stylesheet, so a rule outlives the element it dressed in
 * silence: the 2026-09 sweep found a whole connectors design, a pre-table
 * targets list, an html card and `.message-author` still here long after the
 * markup that wore them was deleted, plus two wrappers (`.composer-flow-stamp`,
 * `.md-table-scroller`) left by workarounds their library fix had retired. This
 * pins the rule that found them.
 *
 * Scope is this directory: `onboarding/` and `@smthrs/ui` own their own
 * stylesheets and are read here only as references.
 */

const stylesDir = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url))

/** xyflow renders these itself, so no source of ours names them. */
// Classes a library renders at runtime, never named by our components: React Flow, and y-codemirror's
// remote selections (cm-ySelection*), which cards.css keeps readable on the selection background.
const VENDOR_PREFIXES = ["react-flow", "cm-y"]

/** Every production source under `cwd` matching `glob`, concatenated. A class
 * named only by a test is still a class no user can see. */
const read = async (glob: string, cwd: string): Promise<string> => {
  const sources: string[] = []
  for await (const path of new Bun.Glob(glob).scan({ cwd, absolute: true })) {
    if (path.includes(".test.")) continue
    sources.push(await readFile(path, "utf8"))
  }
  return sources.join("\n")
}

/** Every class selector the stylesheets define, and the files defining it. */
const definedClasses = async (): Promise<Map<string, Set<string>>> => {
  const defined = new Map<string, Set<string>>()
  for await (const path of new Bun.Glob("*.css").scan({ cwd: stylesDir, absolute: true })) {
    const text = (await readFile(path, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "")
    for (const match of text.matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
      const name = match[1]!
      defined.set(name, (defined.get(name) ?? new Set()).add(path.slice(stylesDir.length)))
    }
  }
  return defined
}

describe("styles/*.css carries no rule for markup that no longer exists", () => {
  test("every class a stylesheet defines is named by a component", async () => {
    const defined = await definedClasses()
    expect(defined.size).toBeGreaterThan(100)

    const host = await read("**/*.{ts,tsx,html}", fileURLToPath(new URL("..", import.meta.url)))
    const library = await read("**/*.{ts,tsx,css}", `${repoRoot}/packages/smithers/ui/src`)
    expect(library.length).toBeGreaterThan(0)

    const orphans = [...defined]
      .filter(([name]) => !VENDOR_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .filter(([name]) => !host.includes(name) && !library.includes(name))
      .map(([name, where]) => `${name} (${[...where].join(", ")})`)
      .sort()
    expect(orphans).toEqual([])
  }, 30_000)
})
