import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

test("the shipping-links gate depends on the site build even when selected alone", () => {
  // Query the evaluated declarations: an earlier workflow step cannot supply
  // the route oracle when this target runs on its own or through //scripts/....
  const graph = JSON.parse(execFileSync(process.execPath, [
    "packages/smithers/build/build-cli/src/main.js",
    "query",
    "deps(//scripts/repo-contract:smithersLinks)",
    "--json"
  ], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 300_000
  }))

  assert.ok(graph.dependencies.includes("//apps/site:build"), "shipping links require the built site routes")
})

test("the cached site build measures every external release URL input", () => {
  const explain = (label) => JSON.parse(execFileSync(process.execPath, [
    "packages/smithers/build/build-cli/src/main.js",
    "explain", label, "--json"
  ], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }))
  const site = explain("//apps/site:build")
  assert.ok(site.cache.cacheable, "this checks the production cached build")
  assert.ok(site.dependencies.includes("//packages/smithers:docsSources"), "the CLI removal table must affect the site key")
  const cli = explain("//packages/smithers:docsSources")
  const files = new Map([site, cli].flatMap((target) => target.inputs.flatMap((input) => input.files))
    .map((file) => [file.path, file.digest]))
  for (const path of [
    "CHANGELOG.md",
    "packages/smithers/src/Unsupported.ts",
    "packages/smithers/src/CliError.ts",
    "packages/smithers/src/cli/Compatibility.ts",
    "apps/site/public/_redirects",
    "apps/site/src/data/removed-commands.json",
    "apps/site/public/llms.txt",
    "apps/site/public/llms-full.txt",
    "apps/site/scripts/check-built-site.mjs"
  ]) {
    assert.ok(files.get(path), `${path} must contribute content to the site build key`)
  }
})

test("the ordinary PR CLI entrypoint plans both executable examples checks and the suite", () => {
  const cliRoot = new URL("../packages/smithers/", import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL("package.json", cliRoot), "utf8"))
  // CI invokes the public smthrs bin, which must compose the graph commands.
  // Read the manifest so a stale checkout .bin alias cannot satisfy this gate.
  const entry = fileURLToPath(new URL(manifest.bin.smthrs, cliRoot))
  const plan = JSON.parse(execFileSync(process.execPath, [
    entry, "ci", "//examples/...", "--plan", "--json"
  ], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 300_000 }))
  assert.ok(plan.roots.includes("//examples:check"), "examples CI must typecheck the executable tutorials")
  assert.ok(plan.roots.includes("//examples:suite"), "examples CI must execute the Vitest suite")
})

test("site CI selects the native bridge typecheck regression", () => {
  const plan = JSON.parse(execFileSync(process.execPath, [
    "packages/smithers/build/build-cli/src/main.js",
    "ci", "//apps/site/...", "--plan", "--json"
  ], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }))

  const label = "//apps/site:siteTypecheckTest"
  assert.ok(plan.roots.includes(label), "site CI must select the typecheck regression")
  const target = plan.targets.find((entry) => entry.label === label)
  assert.equal(target?.target, "Shell.Test")
  assert.match(target.attrs.shell, /\bnode\s+--test\b/)
  assert.ok(target.attrs.shell.includes("apps/site/scripts/site-typecheck.test.mjs"),
    "the selected test must execute the native bridge regression")
  assert.ok(target.declaredInputs.some((input) => input.files.some((file) =>
    file.path === "apps/site/scripts/site-typecheck.test.mjs")),
    "the regression script must key the test target")
})
