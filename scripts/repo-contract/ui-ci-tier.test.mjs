/**
 * The apps/app required CI tier selects, and actually executes, what it claims.
 *
 * Three claims: the required PR workflow runs the UI typecheck, units and
 * Playwright once each in their own Ubuntu job; the browser target's wrapper
 * installs its browser, runs Playwright and propagates its failure; and the
 * real scheduler runs the browser typecheck and propagates compiler failures.
 *
 * Run it with `node --test scripts/repo-contract/ui-ci-tier.test.mjs`.
 */
import { execFileSync, spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { chmodSync, copyFileSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, delimiter, join } from "node:path"
import { describe, it } from "node:test"

import { parseWorkflow } from "../release-rehearsal.mjs"
import { libraryPackages, repoRoot as root } from "../workspace-packages.mjs"

const readManifest = (path) => JSON.parse(readFileSync(path, "utf8"))

const rootManifest = readManifest(join(root, "package.json"))

describe("required PR selection", () => {
  const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))
  const runs = (job) => workflow.jobs[job].steps.flatMap((step) => step.run ? [step.run] : [])
  it("keeps server CI required while selecting the UI tiers once in their earlier Ubuntu job", () => {
    const main = [...runs("test"), ...runs("repository")].join("\n")
    assert.doesNotMatch(main, /\/\/apps\/app:(?:check|unitTests)/)
    assert.match(runs("repository").join("\n"), /(?:smthrs|smithers-build) ci '\/\/apps\/server\/\.\.\.'/)
    assert.notEqual(workflow.jobs.test["continue-on-error"], true)
    assert.notEqual(workflow.jobs.repository["continue-on-error"], true)
    const ui = workflow.jobs["apps-e2e"]
    assert.equal(ui["runs-on"], "ubuntu-latest")
    assert.equal(ui.needs, undefined, "UI diagnostics must not wait behind the workspace graph")
    const targets = ui.steps.filter((step) => /(?:smthrs|smithers-build) (?:build|test) /.test(step.run ?? ""))
    assert.deepEqual(targets.map((step) => step.run), [
      "pnpm exec smthrs build '//apps/app:check' --known-red '.github/ci-known-red.json' --verbose",
      "pnpm exec smthrs test '//apps/app:unitTests' --known-red '.github/ci-known-red.json' --verbose",
      "pnpm exec smthrs test '//apps/app:conformance' --known-red '.github/ci-known-red.json' --verbose",
      "pnpm exec smthrs test '//apps/app:browserE2e' --known-red '.github/ci-known-red.json' --verbose",
      // Exclusive, so the job's `ci '//apps/tui/...'` step omits it.
      "pnpm exec smthrs test '//apps/tui:e2eTests' --known-red '.github/ci-known-red.json' --verbose"
    ])
    for (const step of targets) {
      assert.equal(step.if, "${{ !cancelled() && steps.setup.conclusion == 'success' }}")
      assert.equal(step["continue-on-error"], undefined)
      const occurrences = Object.values(workflow.jobs).flatMap((job) => job.steps)
        .filter((entry) => entry.run === step.run)
      assert.equal(occurrences.length, 1, `${step.name} must run once in required CI`)
    }
    for (const tool of ["jj-cli@0.39.0", "ripgrep@14.1.1"])
      assert.ok(ui.steps.some((step) => step.with?.tool === tool), `preserve ${tool}`)
    assert.ok(runs("apps-e2e").some((run) => run.includes("'bubblewrap'")))
  })
  it("the browser job selects the target that executes actual Playwright", () => {
    assert.match(runs("apps-e2e").join("\n"), /(?:smthrs|smithers-build) test '\/\/apps\/app:browserE2e'/)
    assert.notEqual(workflow.jobs["apps-e2e"]["continue-on-error"], true)
    const declaration = readFileSync(join(root, "apps/app/PACKAGE.ts"), "utf8")
    assert.match(declaration, /browserE2e = Smithers\.NodeTest/)
    assert.match(declaration, /entrypoint\(Smithers\.file\("scripts\/run-pr-e2e\.mjs"\)/)
    const executable = readFileSync(join(root, "apps/app/scripts/run-pr-e2e.mjs"), "utf8")
    assert.match(executable, /\["exec", "playwright", "test"\]/)
    assert.match(executable, /SMITHERS_CHAT_STUB: "1"/)
  })
})

it("the selected browser executable installs its matching browser, runs every tier past a failure and propagates it", () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-pr-browser-"))
  // A pnpm that records its argv, exits 23 when the argv contains BROWSER_TEST_FAIL
  // and 7 when it contains BROWSER_TEST_LATER_FAIL.
  const run = (fail, laterFail = "no step matches this") => {
    const calls = join(temporary, `calls-${fail}-${laterFail}`)
    const result = spawnSync(process.execPath, [join(root, "apps/app/scripts/run-pr-e2e.mjs")], {
      cwd: join(root, "apps/app"), env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, BROWSER_TEST_CALLS: calls, BROWSER_TEST_FAIL: fail, BROWSER_TEST_LATER_FAIL: laterFail }, stdio: "pipe"
    })
    return { status: result.status, calls: readFileSync(calls, "utf8").trim().split("\n") }
  }
  try {
    const fake = join(temporary, "pnpm")
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BROWSER_TEST_CALLS"\ncase "$*" in *"$BROWSER_TEST_FAIL"*) exit 23;; *"$BROWSER_TEST_LATER_FAIL"*) exit 7;; esac\n')
    chmodSync(fake, 0o755)
    const tiers = ["exec playwright install --with-deps chromium", "run test:e2e:auth", "run test:e2e:probes", "run test:e2e:graph-lifecycle", "exec playwright test",
      "exec playwright test --config playwright.showcase.config.ts", "exec playwright test --config playwright.site.config.ts", "exec playwright test --config playwright.graph.config.ts"]
    assert.deepEqual(run("test:e2e:auth"), { status: 23, calls: tiers }, "a red tier must not hide the later tiers")
    assert.deepEqual(run("test:e2e:auth", "playwright.site.config.ts"), { status: 23, calls: tiers }, "the first red's code wins")
    assert.deepEqual(run("install"), { status: 23, calls: tiers.slice(0, 1) }, "no tier runs without its browser")
    assert.deepEqual(run("no step matches this"), { status: 0, calls: tiers })
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

it("browser typecheck executes after security validation and propagates compiler failure in a clean projection", () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-ui-typecheck-refusal-"))
  const write = (path, contents) => {
    const destination = join(temporary, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
    return destination
  }
  try {
    symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"), "dir")
    write("package.json", JSON.stringify({
      name: "ui-typecheck-refusal", private: true, type: "module", packageManager: rootManifest.packageManager
    }))
    copyFileSync(join(root, "pnpm-lock.yaml"), join(temporary, "pnpm-lock.yaml"))
    // Every host binary a projected declaration names must be declared by the
    // workspace, so read them from the same declarations the fixture copies.
    const hostBins = [...new Set(
      [...libraryPackages().map((entry) => `${entry.dir}/PACKAGE.ts`), "apps/app/PACKAGE.ts", "PACKAGE.ts", "flows/PACKAGE.ts"]
        .filter((path) => existsSync(join(root, path)))
        .flatMap((path) => [...readFileSync(join(root, path), "utf8").matchAll(/\bHost\.bin\(\s*"([^"]+)"/g)].map(([, name]) => name))
    )].sort()
    assert.ok(hostBins.includes("bun"), "the projected declarations name S.Host.bin(\"bun\")")
    write("WORKSPACE.ts", `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("ui-typecheck-refusal", {
  repository: "git+https://example.invalid/ui-typecheck-refusal.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ${JSON.stringify(hostBins)} }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`)
    // Copy the real retained browser declaration and compiler configuration.
    for (const path of ["PACKAGE.ts", "package.json", "tsconfig.json"]) {
      const destination = write(`apps/app/${path}`, "")
      copyFileSync(join(root, "apps/app", path), destination)
    }
    // The app declaration imports package targets. Project their real declarations
    // as well, so graph discovery and its security checks precede compilation.
    const libraryDeclarations = libraryPackages().map((entry) => `${entry.dir}/PACKAGE.ts`).filter((path) => existsSync(join(root, path)))
    for (const path of libraryDeclarations) {
      const destination = write(path, "")
      copyFileSync(join(root, path), destination)
    }
    for (const path of ["PACKAGE.ts", "apps/site/src/data/project.json", "flows/PACKAGE.ts", ".smithers/coding-project.json"]) {
      const destination = write(path, "")
      copyFileSync(join(root, path), destination)
    }
    // The compiler is the only test double: the real scheduler must invoke it
    // after graph discovery validates the retained production security paths.
    for (const path of ["vite.config.ts", "tailwind.config.js", "postcss.config.js", "playwright.config.ts", "playwright.showcase.config.ts"])
      write(`apps/app/${path}`, "export {}\n")
    const tscMarker = join(temporary, "tsc-called")
    const pnpm = write("bin/pnpm", `#!/usr/bin/env node
import { writeFileSync } from "node:fs"
if (process.argv[2] === "--version") console.log(${JSON.stringify(rootManifest.packageManager.split("@").at(-1))})
else { writeFileSync(${JSON.stringify(tscMarker)}, JSON.stringify(process.argv.slice(2))); process.exit(91) }
`)
    chmodSync(pnpm, 0o755)
    // Evaluating a SecurityReview checks that each check path and each trust
    // boundary's caller, authorization, service and storage/egress path names
    // a file, so copy each file the projected declarations name. A `//` path
    // is anchored at the repository root and any other at the declaring
    // directory, as the review anchors them. A declaration file is left out,
    // so the projection's own WORKSPACE.ts and PACKAGE.ts files stay the only
    // ones discovered.
    for (const declaration of [...libraryDeclarations, "apps/app/PACKAGE.ts", "PACKAGE.ts", "flows/PACKAGE.ts"]) {
      const directory = dirname(declaration)
      const source = readFileSync(join(root, declaration), "utf8")
      const patterns = [...source.matchAll(/\b(?:paths|caller|authorization|service|storageOrEgress): \[([^\]]*)\]/g)]
        .flatMap(([, list]) => [...list.matchAll(/"([^"]+)"/g)].map(([, pattern]) => pattern))
      for (const pattern of patterns) {
        const [base, relative] = pattern.startsWith("//") ? [".", pattern.slice(2)] : [directory, pattern]
        for (const match of globSync(relative, { cwd: join(root, base), exclude: (name) => name === "node_modules" })) {
          const path = join(base, match)
          if (/(?:^|\/)(?:WORKSPACE|PACKAGE)\.ts$/.test(path) || !statSync(join(root, path)).isFile()) continue
          if (!existsSync(join(temporary, path))) copyFileSync(join(root, path), write(path, ""))
        }
      }
    }
    const selectedCheck = () => {
      try {
        execFileSync(process.execPath, [join(root, "packages/smithers/src/bin.ts"), "build", "//apps/app:check", "--workspace", temporary, "--no-cache", "--verbose"], {
          cwd: temporary, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
          env: { ...process.env, PATH: `${join(temporary, "bin")}${delimiter}${process.env.PATH}`, SMITHERS_CACHE_URL: "", SMITHERS_CACHE_TOKEN: "" },
          stdio: "pipe"
        })
      } catch (error) { return error }
    }
    const failure = selectedCheck()
    assert.ok(failure, "a compiler failure must fail the selected build")
    const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`
    assert.equal(failure.status, 1, output)
    assert.ok(existsSync(tscMarker), output)
    assert.deepEqual(readManifest(tscMarker), ["exec", "tsc", "-p", "tsconfig.json", "--noEmit"])
    assert.match(output, /\/\/apps\/app:check  failed/)
    assert.doesNotMatch(output, /module_import_failed|devkit|electrobun|hutch/i)
    assert.equal(existsSync(join(temporary, "apps/app/.hutch")), false)
    // SecurityReview validates production trust-boundary paths before the
    // compiler may start. A missing authorization input must fail closed.
    rmSync(tscMarker)
    rmSync(join(temporary, "apps/app/src/bun/CloudAuth.ts"))
    const refused = selectedCheck()
    assert.ok(refused, "a missing security input must refuse the selected build")
    const refusalOutput = `${refused.stdout ?? ""}\n${refused.stderr ?? ""}`
    assert.equal(refused.status, 1, refusalOutput)
    assert.match(refusalOutput, /security check loopback-origin-gate.*CloudAuth\.ts.*matches no file/)
    assert.equal(existsSync(tscMarker), false, "security validation must precede compiler execution")
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
