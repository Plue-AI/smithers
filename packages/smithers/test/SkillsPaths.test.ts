import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../../", import.meta.url))

const referencedPaths = (markdown: string): Array<string> =>
  Array.from(markdown.matchAll(/`([^`\n]+)`/g), ([, value]) => value).filter(
    // Literal relative paths have a slash and an extension or trailing slash; exclude commands, packages, and templates.
    (value) => /^[\w.-]+\/(?:[\w./-]*\.[\w-]+|[\w./-]*\/)?$/.test(value)
  )

test("skill repository paths exist", async () => {
  const missing: Array<string> = []
  let scanned = 0
  for (const directory of [".agents/skills", "packages/smithers/skills"]) {
    for await (const file of new Bun.Glob("**/SKILL.md").scan({ cwd: resolve(root, directory) })) {
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
