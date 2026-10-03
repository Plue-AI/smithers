import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const root = fileURLToPath(new URL("../../../", import.meta.url))

const referencedPaths = (markdown: string): Array<string> =>
  Array.from(markdown.matchAll(/`([^`\n]+)`/g), ([, value]) => value).filter(
    // Literal relative paths have a slash and an extension or trailing slash; exclude commands, packages, and templates.
    (value) => /^[\w.-]+\/(?:[\w./-]*\.[\w-]+|[\w./-]*\/)?$/.test(value)
  )

/** Every SKILL.md under a directory, as paths relative to it. */
const skillFiles = (directory: string, prefix = ""): Array<string> =>
  readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? skillFiles(directory, join(prefix, entry.name))
      : entry.name === "SKILL.md" ? [join(prefix, entry.name)] : []
  )

test("skill repository paths exist", () => {
  const missing: Array<string> = []
  let scanned = 0
  for (const directory of [".agents/skills", "packages/smithers/skills"]) {
    for (const file of skillFiles(resolve(root, directory))) {
      scanned++
      const skill = `${directory}/${file}`
      for (const path of referencedPaths(readFileSync(resolve(root, skill), "utf8"))) {
        if (!existsSync(resolve(root, path))) missing.push(`${skill}: ${path}`)
      }
    }
  }
  expect(scanned).toBeGreaterThan(0)
  expect(missing).toEqual([])
})

test("path matching includes stale files and directories and excludes nonliteral references", () => {
  expect(referencedPaths(
    "`apps/app/src/bun/Harnesses.ts` `docs/learn/` `packages/rpc/src/LocalApp.ts` " +
    "`@smthrs/flow` `flows/<name>/flow.ts` `node crates/flows-jj/build-wasm.mjs --verify` `--help`"
  )).toEqual(["apps/app/src/bun/Harnesses.ts", "docs/learn/", "packages/rpc/src/LocalApp.ts"])
})
