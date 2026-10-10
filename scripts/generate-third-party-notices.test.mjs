import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { repoRoot } from "./workspace-packages.mjs"

test("notices follow Cargo's wasm normal/build closure and --check detects drift without writing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "notices-")))
  try {
    mkdirSync(join(root, "scripts"))
    mkdirSync(join(root, "packages/smithers/flows/jj"), { recursive: true })
    cpSync(join(repoRoot, "scripts/generate-third-party-notices.mjs"), join(root, "scripts/generate-third-party-notices.mjs"))
    cpSync(join(repoRoot, "scripts/workspace-packages.mjs"), join(root, "scripts/workspace-packages.mjs"))
    cpSync(join(repoRoot, "scripts/third-party-notices.template.md"), join(root, "scripts/third-party-notices.template.md"))
    const crates = ["flows-jj", "normal", "build", "dev", "native"]
    writeFileSync(join(root, "Cargo.toml"), `[workspace]\nresolver = "3"\nmembers = ${JSON.stringify(crates)}\n`)
    for (const name of crates) {
      mkdirSync(join(root, name, "src"), { recursive: true })
      writeFileSync(join(root, name, "src/lib.rs"), "")
      writeFileSync(join(root, name, "Cargo.toml"), [
        "[package]", `name = "${name}"`, 'version = "1.0.0"', 'edition = "2021"',
        'license = "MIT"', 'authors = ["A | B <a@example.com>"]', 'repository = "https://example.com/crate"',
        ...(name === "flows-jj" ? [
          '[dependencies]', 'normal = { path = "../normal" }',
          '[build-dependencies]', 'build = { path = "../build" }',
          '[dev-dependencies]', 'dev = { path = "../dev" }',
          "[target.'cfg(not(target_arch = \"wasm32\"))'.dependencies]", 'native = { path = "../native" }'
        ] : [])
      ].join("\n"))
    }
    const lock = spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: root, encoding: "utf8", timeout: 30_000 })
    assert.equal(lock.status, 0, lock.stderr)
    const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/generate-third-party-notices.mjs"), ...args], {
      cwd: root, encoding: "utf8", timeout: 30_000
    })
    const generated = run()
    assert.equal(generated.status, 0, generated.stderr)
    const output = join(root, "packages/smithers/flows/jj/THIRD_PARTY_NOTICES.md")
    const notices = readFileSync(output, "utf8")
    assert.match(notices, /`normal`/)
    assert.match(notices, /`build`/)
    assert.doesNotMatch(notices, /^\| `(dev|native|flows-jj)`/m)
    assert.match(notices, /A &#124; B/)
    assert.match(notices, /Apache License\n/)
    assert.equal(run("--check").status, 0)
    writeFileSync(output, `${notices}\nstale\n`)
    const drift = run("--check")
    assert.equal(drift.status, 1)
    assert.match(drift.stderr, /out of date/)
    assert.equal(readFileSync(output, "utf8"), `${notices}\nstale\n`)
    assert.equal(run().status, 0)
    assert.equal(readFileSync(output, "utf8"), notices)
    const manifest = join(root, "normal/Cargo.toml")
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace('license = "MIT"', 'license = "Unreviewed-License"'))
    assert.equal(run("--check").status, 1, "new license groups require attribution review")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the Rust CI job checks the shipped notices", async () => {
  const { parseWorkflow } = await import("./release-rehearsal.mjs")
  const ci = parseWorkflow(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"))
  assert.ok(ci.jobs.rust.steps.some((step) =>
    typeof step.run === "string" && /^pnpm exec smthrs test '\/\/scripts:thirdPartyNotices'(?: --known-red '\.github\/ci-known-red\.json')?(?: --results-file "\$RUNNER_TEMP\/smthrs-results\/\$GITHUB_ACTION\.json")?(?: --verbose)?$/.test(step.run)))
})
