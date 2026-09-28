import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

/** Run the actual generator against a one-site manifest under a temp dir. */
const fixture = (t, row = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-gen-sites-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const shared = join(root, "sites/shared")
  mkdirSync(shared, { recursive: true })
  copyFileSync(new URL("./gen-sites.mjs", import.meta.url), join(shared, "gen-sites.mjs"))
  copyFileSync(new URL("./starlight.css", import.meta.url), join(shared, "starlight.css"))
  cpSync(new URL("./assets", import.meta.url), join(shared, "assets"), { recursive: true })
  writeFileSync(join(shared, "manifest.mjs"), `
    export const repoRoot = ${JSON.stringify(root)}
    export const docsRoot = repoRoot + "/sites"
    export const sites = [{ slug: "fixture-site", name: "fixture", title: "Fixture", description: "Fixture docs",
      dir: "packages/fixture", siteDir: docsRoot + "/fixture-site", domain: "fixture.example", ...${JSON.stringify(row)} }]
    export const bySlug = new Map(sites.map((site) => [site.slug, site]))
  `)
  mkdirSync(join(root, "sites/fixture-site"), { recursive: true })
  writeFileSync(join(root, "sites/fixture-site/security.ts"), "export const security = { include: [], checks: [] }\n")
  const run = (...args) =>
    execFileSync(process.execPath, [join(shared, "gen-sites.mjs"), ...args], { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 30_000 })
  const read = (rel) => readFileSync(join(root, "sites/fixture-site", rel), "utf8")
  return { run, read }
}

test("a projected site's check and build depend on the shared kit and key its tsconfig and public tree", (t) => {
  const { run, read } = fixture(t)
  run()
  const packageTs = read("PACKAGE.ts")
  assert.match(packageTs, /import \{ Package as docsSharedPackage \} from "\.\.\/shared\/PACKAGE\.ts"/)
  assert.match(packageTs, /const kit = docsSharedPackage\.sources/)
  assert.equal(packageTs.match(/deps: \[kit\]/g)?.length, 2, "both check and build name the kit edge")
  assert.doesNotMatch(packageTs, /deps: \[\]/)
  assert.match(packageTs, /Smithers\.file\("\/\/apps\/docs\/fixture-site\/tsconfig\.json"\)/)
  assert.match(packageTs, /Smithers\.glob\("\/\/apps\/docs\/fixture-site\/public\/\*\*\/\*"\)/)
  assert.match(packageTs, /Smithers\.glob\("\/\/apps\/docs\/fixture-site\/src\/\*\*\/\*"\)/)
  assert.match(packageTs, /Smithers\.file\("\/\/apps\/docs\/fixture-site\/astro\.config\.mjs"\)/)
  assert.match(packageTs, /Smithers\.file\("\/\/apps\/docs\/fixture-site\/package\.json"\)/)
})

test("a second run reports the generated site clean", (t) => {
  const { run } = fixture(t)
  run()
  assert.match(run("--check"), /1 sites clean/)
})

test("a site name with quotes stays inside the generated summary string", (t) => {
  const { run, read } = fixture(t, { name: "fix\"ture\\\" + globalThis.pwned + \"" })
  run()
  const summary = read("PACKAGE.ts").match(/^  summary: (.*),$/m)?.[1]
  assert.equal(JSON.parse(summary), "Sync fix\"ture\\\" + globalThis.pwned + \"'s colocated docs into the site content tree; check drift under lint.")
})

test("the manifest refuses rows that would inject into generated files or escape the repo", async () => {
  const { siteRowProblems, sites } = await import("./manifest.mjs")
  for (const site of sites) assert.deepEqual(siteRowProblems([site.slug, site.name, site.dir]), [])
  assert.deepEqual(siteRowProblems(["flow", "@smthrs/flow", "packages/smithers/flows/flow"]), [])
  assert.deepEqual(siteRowProblems(["Flow\"", "@smthrs/flow", "packages/x"]), ["slug \"Flow\\\"\""])
  assert.deepEqual(siteRowProblems(["flow", "x */ evil", "packages/x"]), ["name \"x */ evil\""])
  assert.deepEqual(siteRowProblems(["flow", "@smthrs/flow", "../../etc"]), ["dir \"../../etc\""])
  assert.deepEqual(siteRowProblems(["flow", "@smthrs/flow", "packages/x\"; import \"y"]).length, 1)
})

test("a regenerated PACKAGE.ts keeps the site's security and securityAudit targets", (t) => {
  const { run, read } = fixture(t)
  run()
  const packageTs = read("PACKAGE.ts")
  assert.match(packageTs, /import \{ security \} from "\.\/security\.ts"/)
  assert.match(packageTs, /const securityReview = Smithers\.SecurityReview\(\{ cwd, \.\.\.security \}\)/)
  assert.match(packageTs, /targets: \{ check, build, contentSync, \.\.\.securityReview \}/)
})
