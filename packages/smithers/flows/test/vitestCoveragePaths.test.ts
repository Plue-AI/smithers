import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const packagesDir = resolve(import.meta.dirname, "../../..")
const vitest = join(dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))), "vitest.mjs")

it.each(["smithers", "smithers/agent", "smithers/build", "smithers/flows"])(
  "%s measures source and fails an uncovered fixture beneath package-named checkout directories",
  (name) => {
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), "coverage-anchor-")))
    const root = join(checkout, "review-harness/sec-gateway/sandbox/build-cli/package")
    try {
      mkdirSync(root, { recursive: true })
      symlinkSync(join(packagesDir, name, "node_modules"), join(root, "node_modules"), "dir")
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
      writeFileSync(
        join(root, "vitest.config.ts"),
        readFileSync(join(packagesDir, name, "vitest.config.ts"), "utf8")
      )
      for (const file of ["src/covered.ts", "src/uncovered.ts", "harness/src/foreign.ts"]) {
        mkdirSync(dirname(join(root, file)), { recursive: true })
        writeFileSync(join(root, file), "export const value = () => 42\n")
      }
      mkdirSync(join(root, "test"))
      // The copied config runs the package's setup file before every test file.
      const setup = join(packagesDir, name, "test/setup.ts")
      if (existsSync(setup)) copyFileSync(setup, join(root, "test/setup.ts"))
      writeFileSync(
        join(root, "test/fixture.test.ts"),
        "import { expect, it } from \"vitest\"\n"
          + "import { value } from \"../src/covered\"\n"
          + "import { value as foreign } from \"../harness/src/foreign\"\n"
          + "it(\"executes local and nested source\", () => { expect(value()).toBe(42); expect(foreign()).toBe(42) })\n"
      )
      // Keep the package's real thresholds: an untested module must make this
      // run fail, even when a checkout's name matches a coverage exclusion.
      const result = spawnSync(process.execPath, [
        vitest,
        "run",
        "--coverage.reporter=json-summary",
        `--coverage.reportsDirectory=${join(root, "coverage")}`,
        "--maxWorkers=1"
      ], { cwd: root, encoding: "utf8", timeout: 60_000 })
      expect(result.error).toBeUndefined()
      const report = JSON.parse(readFileSync(join(root, "coverage/coverage-summary.json"), "utf8")) as Record<
        string,
        { statements: { total: number; pct: number } }
      >
      expect(report.total?.statements.total, result.stdout + result.stderr).toBeGreaterThan(0)
      expect(
        Object.keys(report).filter((key) => key !== "total").map((key) => relative(root, key).split(sep).join("/"))
      )
        .toEqual(["src/covered.ts", "src/uncovered.ts"])
      expect(report.total?.statements.pct).toBeLessThan(100)
      expect(result.status, result.stdout + result.stderr).toBe(1)
    } finally {
      rmSync(checkout, { recursive: true, force: true })
    }
  },
  90_000
)
