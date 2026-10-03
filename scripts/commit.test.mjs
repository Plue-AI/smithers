import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

const script = resolve(import.meta.dirname, "commit.mjs")
const copyHygiene = (directory) => {
  mkdirSync(join(directory, "scripts"))
  copyFileSync(resolve(import.meta.dirname, "check-tracked-hygiene.mjs"), join(directory, "scripts/check-tracked-hygiene.mjs"))
}
const command = (cwd, bin, args) => spawnSync(bin, args, { cwd, encoding: "utf8" })
const ok = (cwd, bin, args) => {
  const result = command(cwd, bin, args)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
// These landing fixtures run the production CLI and real typed targets;
// only their existing remote hooks alter publication behavior.
const prepareDriftGates = (directory) => {
  mkdirSync(join(directory, ".smithers"), { recursive: true })
  mkdirSync(join(directory, "packages/smithers/bin"), { recursive: true })
  const cli = resolve(import.meta.dirname, "../packages/smithers/bin/smithers.mjs")
  writeFileSync(join(directory, "packages/smithers/bin/smithers.mjs"), `import ${JSON.stringify(cli)}\n`)
  writeFileSync(join(directory, "package.json"), '{"name":"landing-fixture","private":true}\n')
  writeFileSync(join(directory, "yarn.lock"), "")
  writeFileSync(join(directory, ".gitignore"), ".flows/\n")
  writeFileSync(join(directory, ".smithers/WORKSPACE.ts"), `import {Smithers as S} from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("landing", {repository:"git+https://example.invalid/landing.git", cache:S.Cache({directory:".flows"}), runtime:S.Runtime.Node({version:"${process.versions.node}"}), packageManager:S.PackageManager.Yarn({manifest:packageJson,lockfile:S.file("//yarn.lock")}), nodeModules:S.Npm.NodeModules({packageJson})})`)
  writeFileSync(join(directory, "PACKAGE.ts"), `import {Smithers as S} from "@smthrs/targets"
const targetIndex=S.TargetIndex({})
const driftCi=S.Generate({script:S.file("//scripts/drift.mjs"),changes:["drift.txt"]})
const ci=S.Generate({script:S.file("//scripts/ci.mjs"),changes:["ci.txt"]})
export const Package=S.Package({targets:{targetIndex,driftCi,ci}})`)
  writeFileSync(join(directory, "scripts/PACKAGE.ts"), `import {Smithers as S} from "@smthrs/targets"
const data=[S.file("//scripts/check-tracked-hygiene.mjs"),S.file("//scripts/check-conflict-markers.mjs"),S.file("//.gitignore")]
const trackedHygiene=S.Shell.Diff({shell:"node scripts/check-tracked-hygiene.mjs --projected-tree",sandbox:"none",data,changes:[]})
const conflictMarkers=S.Shell.Diff({shell:"node scripts/check-conflict-markers.mjs",sandbox:"none",data,changes:[]})
export const Package=S.Package({targets:{trackedHygiene,conflictMarkers}})`)
  copyFileSync(resolve(import.meta.dirname, "check-conflict-markers.mjs"), join(directory, "scripts/check-conflict-markers.mjs"))
  for (const [script, output] of [["drift", "drift"], ["ci", "ci"]]) {
    writeFileSync(join(directory, `scripts/${script}.mjs`), `import {writeFileSync} from "node:fs";writeFileSync("${output}.txt","generated\\n")\n`)
    writeFileSync(join(directory, `${output}.txt`), "generated\n")
  }
  ok(directory, process.execPath, [cli, "target", "//:targetIndex", "--write"])
}
for (const vcs of ["git", "jj"]) {
  test(`${vcs}: commits all contributors, preserves main, ignores secrets without publication`, () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-commit-test-"))
    const remote = mkdtempSync(join(tmpdir(), "smithers-commit-remote-"))
    try {
      copyHygiene(directory)
      ok(directory, "git", ["init", "-b", "main"])
      ok(directory, "git", ["config", "user.name", "Commit test"])
      ok(directory, "git", ["config", "user.email", "test@example.com"])
      writeFileSync(join(directory, ".gitignore"), ".env\n")
      ok(directory, "git", ["add", ".gitignore", "scripts/check-tracked-hygiene.mjs"])
      ok(directory, "git", ["commit", "-m", "initial"])
      ok(remote, "git", ["init", "--bare", "-b", "main"])
      ok(directory, "git", ["remote", "add", "origin", remote])
      if (vcs === "jj") {
        ok(directory, "jj", ["git", "init", "--colocate"])
        ok(directory, "jj", ["config", "set", "--repo", "user.name", "Commit test"])
        ok(directory, "jj", ["config", "set", "--repo", "user.email", "test@example.com"])
      }
      writeFileSync(join(directory, "first.txt"), "first contributor\n")
      writeFileSync(join(directory, "second.txt"), "second contributor\n")
      writeFileSync(join(directory, ".env"), "ignored test data\n")
      ok(directory, "node", [script, "--message", "test: both contributors"])
      assert.equal(ok(directory, "git", ["log", "main", "-1", "--format=%s"]), "test: both contributors")
      assert.match(ok(directory, "git", ["show", "main:first.txt"]), /first contributor/)
      assert.match(ok(directory, "git", ["show", "main:second.txt"]), /second contributor/)
      assert.equal(ok(directory, "git", ["ls-tree", "--name-only", "main", ".env"]), "")
      assert.equal(ok(remote, "git", ["for-each-ref", "refs/heads/main"]), "")
      const before = ok(directory, "git", ["rev-parse", "main"])
      ok(directory, "node", [script])
      assert.equal(ok(remote, "git", ["for-each-ref", "refs/heads/main"]), "")
      assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
      assert.equal(readFileSync(join(directory, ".env"), "utf8"), "ignored test data\n")
      if (vcs === "jj") {
        ok(directory, "jj", ["new"])
        writeFileSync(join(directory, "third.txt"), "unlanded lineage\n")
        const refused = command(directory, "node", [script])
        assert.notEqual(refused.status, 0)
        assert.match(refused.stderr, /must be on main/)
        assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })
  for (const finding of ["scaffold", "dangling", "untracked", "deleted"]) {
    test(`${vcs}: ${finding} hygiene failure prevents commit and requested push`, () => {
      const directory = mkdtempSync(join(tmpdir(), "smithers-commit-hygiene-test-"))
      const remote = mkdtempSync(join(tmpdir(), "smithers-commit-hygiene-remote-"))
      try {
        copyHygiene(directory)
        ok(directory, "git", ["init", "-b", "main"])
        ok(directory, "git", ["config", "user.name", "Commit test"])
        ok(directory, "git", ["config", "user.email", "test@example.com"])
        writeFileSync(join(directory, "PACKAGE.ts"), "const target = { paths: ['source.ts'] }\n")
        writeFileSync(join(directory, "source.ts"), "export const value = 1\n")
        ok(directory, "git", ["add", "."])
        ok(directory, "git", ["commit", "-m", "initial"])
        ok(remote, "git", ["init", "--bare", "-b", "main"])
        ok(directory, "git", ["remote", "add", "origin", remote])
        ok(directory, "git", ["push", "origin", "main"])
        if (vcs === "jj") {
          ok(directory, "jj", ["git", "init", "--colocate"])
          ok(directory, "jj", ["config", "set", "--repo", "user.name", "Commit test"])
          ok(directory, "jj", ["config", "set", "--repo", "user.email", "test@example.com"])
        }
        if (finding === "deleted") {
          rmSync(join(directory, "source.ts"))
        } else if (finding === "untracked") {
          writeFileSync(join(directory, "fresh.ts"), `export const path = 'scratchpad/${"lanes"}/a'\n`)
        } else if (finding === "scaffold") {
          writeFileSync(join(directory, "source.ts"), `export const path = 'scratchpad/${"lanes"}/a'\n`)
        } else {
          writeFileSync(join(directory, "PACKAGE.ts"), "const target = { paths: ['deleted.ts'] }\n")
        }
        const before = ok(directory, "git", ["rev-parse", "main"])
        const stagedBefore = ok(directory, "git", ["diff", "--cached"])
        const parentBefore = vcs === "jj" ? ok(directory, "jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]) : null
        const refused = command(directory, process.execPath, [script, "--message", "must not commit", "--push", "--test", "true"])
        assert.notEqual(refused.status, 0)
        assert.match(refused.stderr, finding === "deleted"
          ? /PACKAGE\.ts:1: dangling: paths names "source\.ts", which no tracked file matches/
          : finding === "dangling"
          ? /PACKAGE\.ts:1: dangling: paths names "deleted\.ts", which no tracked file matches/
          : finding === "untracked" ? /fresh\.ts:1: scaffold: lane scaffolding/ : /source\.ts:1: scaffold: lane scaffolding/)
        assert.match(refused.stderr, /tracked hygiene: 1 finding\(s\)/)
        assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
        assert.equal(ok(remote, "git", ["rev-parse", "main"]), before)
        assert.equal(ok(directory, "git", ["diff", "--cached"]), stagedBefore)
        if (vcs === "jj") {
          assert.equal(ok(directory, "jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), parentBefore)
        }
        // A subsequent clean invocation proves the failed preflight released its lock.
        writeFileSync(join(directory, "PACKAGE.ts"), "const target = { paths: ['source.ts'] }\n")
        writeFileSync(join(directory, "source.ts"), "export const value = 1\n")
        if (finding === "untracked") rmSync(join(directory, "fresh.ts"))
        ok(directory, process.execPath, [script])
        assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
      } finally {
        rmSync(directory, { recursive: true, force: true })
        rmSync(remote, { recursive: true, force: true })
      }
    })
  }
}

for (const vcs of ["git", "jj"]) {
  for (const scenario of ["failure", "pipeline", "missing", "success", "waiver", "rejected", "moved", "repeat", "credential"]) {
    test(`${vcs}: landing gate ${scenario}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "smithers-landgate-"))
      const remote = mkdtempSync(join(tmpdir(), "smithers-landgate-remote-"))
      try {
        copyHygiene(directory)
        ok(directory, "git", ["init", "-b", "main"])
        ok(directory, "git", ["config", "user.name", "Commit test"])
        ok(directory, "git", ["config", "user.email", "test@example.com"])
        if (["success", "waiver", "rejected", "moved"].includes(scenario)) prepareDriftGates(directory)
        ok(directory, "git", ["add", "."])
        ok(directory, "git", ["commit", "-m", "initial"])
        ok(remote, "git", ["init", "--bare", "-b", "main"])
        ok(directory, "git", ["remote", "add", "origin", remote])
        ok(directory, "git", ["push", "origin", "main"])
        const before = ok(remote, "git", ["rev-parse", "main"])
        if (vcs === "jj") {
          ok(directory, "jj", ["git", "init", "--colocate"])
          ok(directory, "jj", ["config", "set", "--repo", "user.name", "Commit test"])
          ok(directory, "jj", ["config", "set", "--repo", "user.email", "test@example.com"])
        }
        if (vcs === "jj") ok(directory, "jj", ["bookmark", "track", "main", "--remote", "origin"])
        writeFileSync(join(directory, "change.txt"), "candidate\n")
        if (scenario === "credential") writeFileSync(join(directory, ".npmrc"), "_auth=fixture-install-credential\n")
        // Advance the actual remote from receive hooks, without a competing checkout.
        // pre-receive rejects the stale candidate; post-receive removes a pushed
        // candidate while returning success, exercising the fetched-main check.
        if (scenario === "rejected" || scenario === "moved") {
          const hook = scenario === "rejected" ? "pre-receive" : "post-receive"
          const tree = ok(remote, "git", ["rev-parse", `${before}^{tree}`])
          writeFileSync(join(remote, "hooks", hook), `#!/bin/sh
export GIT_AUTHOR_NAME=Remote GIT_AUTHOR_EMAIL=remote@example.com
export GIT_COMMITTER_NAME=Remote GIT_COMMITTER_EMAIL=remote@example.com
unset GIT_QUARANTINE_PATH
other=$(echo moved | git commit-tree ${tree} -p ${before})
git update-ref refs/heads/main "$other"
${scenario === "rejected" ? "exit 1" : ""}
`, { mode: 0o755 })
        }
        const testArgs = scenario === "missing" ? [] :
          scenario === "waiver" ? ["--no-test", "manual recovery"] :
          scenario === "failure" ? ["--test", "exit 7"] :
          scenario === "pipeline" ? ["--test", "false | cat"] :
          scenario === "repeat" ? ["--test", "true", "--test", "exit 8"] :
          ["--test", "true", "--test", "printf passed"]
        const result = command(directory, process.execPath, [script, "--push", ...testArgs])
        if (["success", "waiver"].includes(scenario)) {
          assert.equal(result.status, 0, result.stderr)
          const sha = ok(remote, "git", ["rev-parse", "main"])
          assert.match(result.stdout, new RegExp(`LANDED ${sha}(?:\\n|$)`))
          assert.equal(ok(directory, "git", ["rev-parse", "refs/remotes/origin/main"]), sha)
          assert.match(ok(remote, "git", ["log", "-1", "--format=%B"]), scenario === "waiver"
            ? /Landing-Tests: none \(manual recovery\)/
            : /Landing-Tests: true; printf passed/)
        } else {
          assert.notEqual(result.status, 0)
          assert.match(result.stderr, /NOT LANDED/)
          assert.doesNotMatch(result.stdout, /^LANDED /m)
          if (["failure", "pipeline", "repeat"].includes(scenario)) {
            assert.match(result.stderr, /Test command failed:/)
            assert.match(result.stderr, scenario === "pipeline" ? /false \| cat/ : scenario === "repeat" ? /exit 8/ : /exit 7/)
          }
          if (scenario === "missing") assert.match(result.stderr, /--test/)
          if (scenario === "credential") assert.match(result.stderr, /Gate checkout contains install credentials in .npmrc/)
          if (["rejected", "moved"].includes(scenario)) {
            assert.notEqual(ok(remote, "git", ["rev-parse", "main"]), before)
            if (scenario === "moved") assert.equal(ok(directory, "git", ["rev-parse", "refs/remotes/origin/main"]), ok(remote, "git", ["rev-parse", "main"]))
          } else {
            assert.equal(ok(remote, "git", ["rev-parse", "main"]), before)
            assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
            assert.equal(ok(directory, "git", ["diff", "--cached"]), "")
            if (vcs === "jj") assert.equal(ok(directory, "jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), before)
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
        rmSync(remote, { recursive: true, force: true })
      }
    })
  }
}
