import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runCoverage } from "./run.mjs"

const bun = execFileSync("bun", ["-p", "process.execPath"], { encoding: "utf8" }).trim()
const readReceipts = (run, kind) => readdirSync(join(run, kind)).map((file) =>
  JSON.parse(readFileSync(join(run, kind, file), "utf8")))

for (const mode of ["run", "test"]) {
  for (const boundary of ["node", "bun"]) {
    test(`collects real Bun ${mode} root and its direct ${boundary} child`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-bun-coverage-run-")))
      const run = join(root, "receipts")
      try {
        const entry = mode === "test" ? "main.test.ts" : "main.ts"
        const launch = boundary === "node"
          ? `const child = spawn(process.execPath, ["run", childPath, "argument marker"], { stdio: "inherit", env: { ...process.env, COVERAGE_CHILD_MARKER: "child value" } });
             const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });`
          : `const child = Bun.spawn([process.execPath, "run", childPath, "argument marker"], { stdout: "inherit", stderr: "inherit", env: { ...process.env, COVERAGE_CHILD_MARKER: "child value" } });
             const code = await child.exited;`
        const body = `async function launch() {
          if (process.env.COVERAGE_ROOT_MARKER !== "root value") throw new Error("root env changed");
          const childPath = new URL("./child.ts", import.meta.url).pathname;
          ${launch}
          if (code !== 0) throw new Error("child failed: " + code);
        }`
        writeFileSync(join(root, entry), `import { spawn } from "node:child_process";\n${body}\n${
          mode === "test" ? 'const { test } = await import("bun:test"); test("real child", launch);' : "await launch();"
        }\n`)
        writeFileSync(join(root, "child.ts"), `function value(input?: string): string { return input ?? "fallback"; }
          if (process.argv.at(-1) !== "argument marker" || process.env.COVERAGE_CHILD_MARKER !== "child value") throw new Error("child args/env changed");
          if (value() !== "fallback" || value("ok") !== "ok") throw new Error("wrong child output");\n`)
        const sources = [entry, "child.ts"].sort()
        const result = await runCoverage({ root, sources, run, command: bun, args: [mode, join(root, entry)], timeout: 15_000, env: { ...process.env, COVERAGE_ROOT_MARKER: "root value" } })
        assert.equal(result.status.code, 0)
        assert.equal(result.status.signal, null)
        assert.deepEqual(result.coverage.files().sort(), sources)
        assert.ok(result.coverage.fileCoverageFor("child.ts").toSummary().functions.covered > 0)
        const receipts = Object.fromEntries(["expected", "started", "coverage", "exits"].map((kind) => [kind, readReceipts(run, kind)]))
        for (const rows of Object.values(receipts)) {
          assert.equal(rows.length, 2)
          assert.ok(rows.every((row) => row.runId === result.runId))
          assert.deepEqual(rows.map((row) => row.id).sort(), receipts.expected.map((row) => row.id).sort())
        }
        const parent = receipts.started.find((row) => row.parent === null)
        assert.ok(parent)
        assert.equal(parent.mode, mode)
        const child = receipts.started.find((row) => row.id !== parent.id)
        assert.equal(child.parent, parent.id)
        assert.equal(child.mode, "run")
        assert.ok(receipts.exits.every((row) => row.code === 0 && row.signal === null))
        assert.equal(readReceipts(run, "errors").length, 0)
        const report = JSON.parse(readFileSync(join(run, "report", "receipt.json"), "utf8"))
        assert.deepEqual(report.summary, result.summary)
        assert.deepEqual(report.exits, result.exits)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
}
