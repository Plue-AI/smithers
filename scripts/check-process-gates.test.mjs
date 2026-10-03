import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test, { after } from "node:test"

const repository = resolve(import.meta.dirname, "..")
const cli = join(repository, "packages/smithers/bin/smithers.mjs")
const commit = join(repository, "scripts/commit.mjs")
const receipts = []
const fixtureInputs = []
after(() => {
  const evidence = process.env.PRC01_EVIDENCE_DIR
  if (!evidence) return
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, "fixture-processes.json"), JSON.stringify({ fixtureInputs, receipts }, null, 2))
})
const run = (root, command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 60000 })
  receipts.push({ root, command, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message })
  return result
}
const ok = (root, command, args) => {
  const result = run(root, command, args)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout.trim()
}
const write = (root, path, text) => {
  fixtureInputs.push({ root, path, text })
  mkdirSync(resolve(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), text)
}
// C-PRC-01: literal fixture declarations and expected gate labels, not spec parsing.
const declarations = `import { Smithers as S } from "@smthrs/targets"
const source = S.file("//source.txt")
const targetIndex = S.TargetIndex({})
const driftCi = S.Generate({ script: S.file("//scripts/generate.mjs"), data: [source], changes: ["drift.txt"] })
const ci = S.Generate({ script: S.file("//scripts/generate-ci.mjs"), data: [source], changes: ["ci.txt"] })
export const Package = S.Package({ targets: { targetIndex, driftCi, ci } })
`
test("production landing refuses a machine selector", () => {
  const result = run(tmpdir(), process.execPath, [commit, "--machine", "fixture", "--push"])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unknown or incomplete argument: --machine/)
})

for (const vcs of ["git", "jj"]) {
  for (const defect of ["clean", "missing", "drift", "ci", "temporary", "conflict", "edited"]) {
    test(`${vcs}: production landing ${defect} ${defect === "clean" ? "reaches one push" : "refuses publication"}`, () => {
      const root = mkdtempSync(join(tmpdir(), "prc01-process-"))
      const remote = mkdtempSync(join(tmpdir(), "prc01-remote-"))
      try {
        write(root, "package.json", '{"name":"process-fixture","private":true}\n')
        write(root, "yarn.lock", "")
        write(root, ".gitignore", ".flows/\n")
        write(root, ".smithers/WORKSPACE.ts", `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
 repository: "git+https://example.invalid/fixture.git", cache: S.Cache({directory:".flows"}),
 runtime: S.Runtime.Node({version:"${process.versions.node}"}),
 packageManager: S.PackageManager.Yarn({manifest:packageJson,lockfile:S.file("//yarn.lock")}),
 nodeModules: S.Npm.NodeModules({packageJson})
})`)
        write(root, "PACKAGE.ts", declarations)
        write(root, "source.txt", "source\n")
        write(root, "scripts/generate.mjs", 'import {writeFileSync} from "node:fs"; writeFileSync("drift.txt", "generated\\n")\n')
        write(root, "scripts/generate-ci.mjs", 'import {writeFileSync} from "node:fs"; writeFileSync("ci.txt", "generated\\n")\n')
        write(root, "scripts/PACKAGE.ts", `import {Smithers as S} from "@smthrs/targets"
const data = [S.file("//scripts/check-tracked-hygiene.mjs"),S.file("//.gitignore")]
const trackedHygiene = S.Shell.Diff({shell:"node scripts/check-tracked-hygiene.mjs --projected-tree", sandbox:"none", data, changes:[]})
const conflictMarkers = S.Shell.Diff({shell:"node scripts/check-conflict-markers.mjs", sandbox:"none", data, changes:[]})
export const Package = S.Package({targets:{trackedHygiene,conflictMarkers}})`)
        for (const name of ["check-tracked-hygiene.mjs", "check-conflict-markers.mjs"]) cpSync(join(repository, "scripts", name), join(root, "scripts", name))
        // Production entry exists at its normal checkout-relative path.
        mkdirSync(join(root, "packages/smithers/bin"), { recursive: true })
        write(root, "packages/smithers/bin/smithers.mjs", `if ([process.env.NPM_TOKEN, process.env.OPENAI_API_KEY, process.env.npm_config__auth, process.env.npm_config_userconfig].includes("fixture-install-credential")) throw new Error("gate inherited install credentials")\nimport ${JSON.stringify(cli)}\n`)
        ok(root, "git", ["init", "-b", "main"])
        ok(root, "git", ["config", "user.name", "Process fixture"])
        ok(root, "git", ["config", "user.email", "fixture@example.invalid"])
        for (const label of ["//:driftCi", "//:ci", "//:targetIndex", "//:targetIndex"]) ok(root, process.execPath, [cli, "target", label, "--write"])
        ok(root, "git", ["add", "."])
        ok(root, "git", ["commit", "-m", "fixture"])
        ok(remote, "git", ["init", "--bare", "-b", "main"])
        ok(root, "git", ["remote", "add", "origin", remote])
        ok(root, "git", ["push", "origin", "main"])
        if (vcs === "jj") {
          ok(root, "jj", ["git", "init", "--colocate"])
          ok(root, "jj", ["bookmark", "track", "main", "--remote", "origin"])
          ok(root, "jj", ["config", "set", "--repo", "user.name", "Process fixture"])
          ok(root, "jj", ["config", "set", "--repo", "user.email", "fixture@example.invalid"])
        }
        if (defect === "clean") write(root, "source.txt", "changed source\n")
        if (defect === "missing") rmSync(join(root, "source.txt"))
        if (defect === "drift") write(root, "drift.txt", "stale\n")
        if (defect === "ci") write(root, "ci.txt", "stale\n")
        if (defect === "temporary") write(root, "leak.ts", `export const cache = "go-build-${"private"}"\n`)
        if (defect === "conflict") write(root, "source.txt", `${"<".repeat(7)} unresolved\n`)
        const gate = { missing: "//:targetIndex", drift: "//:driftCi", ci: "//:ci", temporary: "//scripts:trackedHygiene", conflict: "//scripts:conflictMarkers" }[defect]
        if (gate) {
          const refused = run(root, process.execPath, [cli, "lint", gate])
          assert.notEqual(refused.status, 0, refused.stdout + refused.stderr)
          if (defect === "temporary") assert.match(refused.stdout + refused.stderr, /lane scaffolding/)
        }
        if (defect === "edited") write(root, "packages/smithers/bin/smithers.mjs", `import {appendFileSync} from "node:fs";
if (process.argv.at(-1) === "//scripts:conflictMarkers") appendFileSync("source.txt", "edited during gates\\n");
import ${JSON.stringify(cli)}\n`)
        // Only the remote receiver is intercepted; local VCS binaries remain real.
        const attempts = join(root, ".git/push-attempts")
        writeFileSync(join(remote, "hooks/pre-receive"), `#!${process.execPath}
import {appendFileSync} from "node:fs";
appendFileSync(${JSON.stringify(attempts)},"push\\n");
console.error("publication intercepted");process.exit(1)
`, { mode: 0o755 })
        const env = { ...process.env, NPM_TOKEN: "fixture-install-credential", OPENAI_API_KEY: "fixture-install-credential", npm_config__auth: "fixture-install-credential", npm_config_userconfig: "fixture-install-credential" }
        const result = run(root, process.execPath, [commit, "--push", "--test", "true"], env)
        if (defect === "clean") {
          assert.notEqual(result.status, 0, "the remote receiver deliberately refuses publication")
          assert.match(result.stderr, /publication intercepted/)
          assert.equal(readFileSync(attempts, "utf8"), "push\n")
          const gateOrder = ["//:driftCi", "//:targetIndex", "//:ci", "//scripts:trackedHygiene", "//scripts:conflictMarkers"]
          let previous = -1
          for (const label of gateOrder) {
            const position = result.stdout.indexOf(`"${label}"`, previous + 1)
            assert.ok(position > previous, `missing or out-of-order gate ${label}: ${result.stdout}`)
            previous = position
          }
        } else {
          if (defect === "edited") assert.match(result.stderr, /Checkout changed during validation/)
          assert.notEqual(result.status, 0, result.stdout + result.stderr)
          assert.throws(() => readFileSync(attempts), { code: "ENOENT" })
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(remote, { recursive: true, force: true })
      }
    })
  }
}
