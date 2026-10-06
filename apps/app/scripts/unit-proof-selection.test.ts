import { expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("the unit target collects proof tests without collecting Playwright's sibling proof directory", () => {
  const argv: string[] = JSON.parse(execFileSync("node", ["--input-type=module", "-e", `
    import { Package } from "./PACKAGE.ts"
    import { metadata } from "@smthrs/targets/Target"
    import { runArgv } from "@smthrs/targets/NodeTest"
    console.log(JSON.stringify(runArgv(metadata(Package.unitTests).attrs)))
  `], { cwd: join(import.meta.dir, ".."), encoding: "utf8", timeout: 120_000 }))
  const proofPath = argv.find(path => path.replace(/^\.\//, "") === "proof")!
  const root = mkdtempSync(join(tmpdir(), "unit-proof-selection-"))
  try {
    mkdirSync(join(root, "proof"))
    mkdirSync(join(root, "e2e/proof"), { recursive: true })
    writeFileSync(join(root, "proof/page.test.ts"), 'import { test, expect } from "bun:test"; test("proof unit collected", () => expect(1).toBe(1))')
    writeFileSync(join(root, "e2e/proof/j8.spec.ts"), 'throw new Error("Playwright proof must not run under Bun")')
    const result = spawnSync(process.execPath, ["test", "--isolate", proofPath], { cwd: root, encoding: "utf8", timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain("proof unit collected")
    expect(result.stderr).toContain("1 pass")
    expect(result.stderr).not.toContain("Playwright proof must not run under Bun")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
