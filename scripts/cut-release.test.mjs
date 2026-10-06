/**
 * The release cut, driven end to end against a temporary repository.
 *
 * The fixture is a real git repository carrying the shapes a cut touches: a
 * `pnpm-workspace.yaml`, two members that depend on each other by exact
 * version, the sources that repeat the release version as a literal, a
 * `CHANGELOG.md`, and a `v*` tag with commits after it. The scripts under test
 * resolve their repository root from their own location, so the fixture holds
 * copies of them and a run inside it cannot reach this checkout.
 *
 * Run it with `node --test scripts/cut-release.test.mjs`.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { dirtyPaths, nextCommands, parseArguments, releaseMessage, releaseTag, steps } from "./cut-release.mjs"
import { versionedSources, versionedTemplates } from "./set-release-version.mjs"

const scriptsDirectory = resolve(import.meta.dirname)

/** The scripts a cut spawns, plus the membership reader they share. */
const copiedScripts = [
  "cut-release.mjs",
  "generate-changelog.mjs",
  "set-release-version.mjs",
  "workspace-packages.mjs"
]

const git = (root, args, env) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: env === undefined ? process.env : { ...process.env, ...env }
  })
    .trim()

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const write = (root, path, contents) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}

/**
 * Each versioned source's fixture text at 0.1.0: the exact declaration
 * `set-release-version.mjs` rewrites, among lines it must leave alone. Keyed by
 * path, not by position in `versionedSources`, so a new row cannot shift another
 * row's text under the wrong file.
 */
const seededSources = {
  "packages/smithers/flows/observability/src/Otlp.ts": "export const defaultServiceVersion = \"0.1.0\"\n",
  "packages/smithers/migrate/src/flow/Cli.ts": "export const version = \"0.1.0\"\n",
  "packages/smithers/migrate/src/Report.ts":
    "export const tool = { name: \"@smthrs/migrate\", version: \"0.1.0\" } as const\n",
  "packages/smithers/mcp/src/McpClient.ts": "export const clientInfo = { name: \"smithers\", version: \"0.1.0\" }\n"
}

/**
 * A repository a cut can run in, at version 0.1.0 with two commits past its tag.
 *
 * Every versioned source is written from {@link seededSources}, so the cut's
 * `--check` pass proves the whole write, not just the manifests.
 */
const seed = () => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-cut-release-"))
  mkdirSync(join(root, "scripts"), { recursive: true })
  for (const script of copiedScripts) copyFileSync(join(scriptsDirectory, script), join(root, "scripts", script))
  // Membership is a dependency-backed operation even in this isolated release.
  mkdirSync(join(root, "node_modules"))
  for (const dependency of ["tinyglobby", "yaml"]) {
    symlinkSync(realpathSync(join(scriptsDirectory, "../node_modules", dependency)), join(root, "node_modules", dependency), "junction")
  }
  write(root, ".gitignore", "node_modules/\n")
  write(root, "pnpm-workspace.yaml", "packages:\n  - \"packages/*\"\nlinkWorkspacePackages: true\n")
  write(
    root,
    "package.json",
    json({
      name: "fixture",
      private: true,
      packageManager: "pnpm@11.25.0",
      workspaces: ["packages/*"],
      repository: { type: "git", url: "git+https://github.com/smithersai/smithers.git" }
    })
  )
  write(
    root,
    "packages/smithers/package.json",
    json({ name: "@smthrs/cli", version: "0.1.0", dependencies: { "@smthrs/kernel": "0.1.0", effect: "4.0.0-rc.115" } })
  )
  write(root, "packages/kernel/package.json", json({ name: "@smthrs/kernel", version: "0.1.0" }))
  write(root, "packages/private/package.json", json({ name: "@smthrs/tooling", private: true, version: "0.0.0" }))
  for (const path of versionedTemplates) {
    write(root, path, json({ name: "__APP_NAME__", private: true, version: "0.0.0",
      dependencies: { "@smthrs/kernel": "0.1.0", effect: "4.0.0-rc.115" },
      devDependencies: { "@smthrs/cli": "workspace:*" } }))
  }
  for (const [path, text] of Object.entries(seededSources)) write(root, path, text)
  write(root, "CHANGELOG.md", "# smthrs\n\nPreamble.\n\n## 0.1.0 (2020-01-01)\n\nThe first release.\n")
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root, stdio: "ignore" })
  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root, stdio: "ignore" })
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "release@smithers.sh"])
  git(root, ["config", "user.name", "Release"])
  const commitAll = (message, date) => {
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  }
  commitAll("🎉 chore: initial", "2026-01-01T00:00:00+00:00")
  git(root, ["tag", "v0.1.0"])
  write(root, "a.txt", "a")
  commitAll("✨ feat(cli): add the doctor verb", "2026-02-02T00:00:00+00:00")
  write(root, "b.txt", "b")
  commitAll("🐛 fix(engine): stop the leak", "2026-02-03T00:00:00+00:00")
  return root
}

const withFixture = (body) => {
  const root = seed()
  try {
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const cut = (root, args) =>
  execFileSync(process.execPath, ["scripts/cut-release.mjs", ...args], { cwd: root, encoding: "utf8" })

const manifest = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"))

test("the fixture seeds every versioned source, and only those, at the version its pattern reads", () => {
  assert.deepEqual(Object.keys(seededSources).sort(), [...new Set(versionedSources.map(({ path }) => path))].sort())
  for (const { declaration, path, pattern } of versionedSources) {
    assert.equal(pattern.exec(seededSources[path])?.[2], "0.1.0", `${path} seeds ${declaration}`)
  }
})

test("parseArguments takes one version and refuses a tag", () => {
  assert.deepEqual(parseArguments(["1.0.0"]), { version: "1.0.0", commit: false, allowBranch: false })
  assert.deepEqual(parseArguments(["1.0.0", "--commit"]), { version: "1.0.0", commit: true, allowBranch: false })
  assert.deepEqual(parseArguments(["1.0.0", "--commit", "--allow-branch"]), {
    version: "1.0.0",
    commit: true,
    allowBranch: true
  })
  assert.throws(() => parseArguments([]), /usage: node scripts\/cut-release\.mjs/)
  assert.throws(() => parseArguments(["v1.0.0"]), /pass the version, not the tag: 1\.0\.0/)
  assert.throws(() => parseArguments(["1.0.0", "2.0.0"]), /cut one version at a time/)
  assert.throws(() => parseArguments(["1.0.0", "--push"]), /unknown option --push/)
  assert.throws(() => parseArguments(["1.0.0", "--allow-branch"]), /--allow-branch requires --commit/)
})

test("a cut writes both halves, refreshes both tracked lockfiles, and then verifies both", () => {
  assert.deepEqual(steps("1.0.0", { bunLock: true }).map((step) => [step.command, ...step.args]), [
    [process.execPath, "scripts/set-release-version.mjs", "1.0.0"],
    [process.execPath, "scripts/generate-changelog.mjs", "--version", "1.0.0"],
    ["pnpm", "install", "--lockfile-only", "--ignore-scripts"],
    ["bun", "install", "--lockfile-only", "--ignore-scripts"],
    [process.execPath, "scripts/set-release-version.mjs", "--check", "1.0.0"],
    [process.execPath, "scripts/generate-changelog.mjs", "--check", "--version", "1.0.0"]
  ])
  assert.equal(steps("1.0.0", { bunLock: false }).some((step) => step.command === "bun"), false)
})

test("the printed follow-up commits with the repository's message and pushes the tag", () => {
  assert.equal(releaseMessage("1.0.0"), "🔖 release: 1.0.0")
  assert.equal(releaseTag("1.0.0"), "v1.0.0")
  assert.deepEqual(nextCommands("1.0.0"), [
    "jj commit -m \"🔖 release: 1.0.0\"",
    "node scripts/generate-changelog.mjs --check --version 1.0.0",
    "git tag -a v1.0.0 -m \"🔖 release: 1.0.0\" && git push origin main v1.0.0"
  ])
})

test("a cut bumps every manifest, retargets internal ranges, and writes the section", () => {
  withFixture((root) => {
    const output = cut(root, ["0.2.0"])

    assert.match(output, /changelog must be regenerated for the exact release commit/)

    assert.equal(manifest(root, "packages/smithers/package.json").version, "0.2.0")
    assert.equal(manifest(root, "packages/smithers/package.json").dependencies["@smthrs/kernel"], "0.2.0")
    assert.equal(manifest(root, "packages/smithers/package.json").dependencies.effect, "4.0.0-rc.115")
    assert.equal(manifest(root, "packages/kernel/package.json").version, "0.2.0")
    assert.equal(manifest(root, "packages/private/package.json").version, "0.0.0", "a private manifest is not bumped")
    for (const path of versionedTemplates) {
      assert.deepEqual(manifest(root, path), { name: "__APP_NAME__", private: true, version: "0.0.0",
        dependencies: { "@smthrs/kernel": "0.2.0", effect: "4.0.0-rc.115" },
        devDependencies: { "@smthrs/cli": "0.2.0" } })
    }
    for (const [path, text] of Object.entries(seededSources)) {
      assert.equal(readFileSync(join(root, path), "utf8"), text.replace("0.1.0", "0.2.0"), `${path} changes only its version`)
    }

    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8")
    assert.match(changelog, /^## 0\.2\.0 \(2026-02-03\)$/m)
    assert.match(changelog, /^- \*\*cli:\*\* add the doctor verb \(\[[0-9a-f]{10}\]/m)
    assert.match(changelog, /^- \*\*engine:\*\* stop the leak \(\[[0-9a-f]{10}\]/m)
    assert.match(changelog, /## 0\.1\.0 \(2020-01-01\)\n\nThe first release\./, "the older section is untouched")

    assert.match(output, /jj commit -m "🔖 release: 0\.2\.0"/)
    assert.match(output, /generate-changelog\.mjs --check --version 0\.2\.0/)
    assert.match(output, /git tag -a v0\.2\.0 -m "🔖 release: 0\.2\.0" && git push origin main v0\.2\.0/)
    assert.match(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), /0\.2\.0/)
    assert.match(readFileSync(join(root, "bun.lock"), "utf8"), /0\.2\.0/)
    assert.deepEqual(git(root, ["tag"]), "v0.1.0", "a cut without --commit tags nothing")
    const templatePath = "packages/smithers/package.json"
    const staleTemplate = manifest(root, templatePath)
    staleTemplate.dependencies["@smthrs/kernel"] = "0.1.0"
    write(root, templatePath, json(staleTemplate))
    assert.throws(() => execFileSync(process.execPath, ["scripts/set-release-version.mjs", "--check", "0.2.0"],
      { cwd: root, stdio: "pipe" }), (error) => error.status === 1 && /packages\/smithers\/package\.json/.test(String(error.stderr)))
  })
})

test("a cut is a no-op the second time, so a re-run after a fix is safe", () => {
  withFixture((root) => {
    cut(root, ["0.2.0"])
    const first = readFileSync(join(root, "CHANGELOG.md"), "utf8")
    const dirty = dirtyPaths(root)

    cut(root, ["0.2.0"])

    assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), first)
    assert.deepEqual(dirtyPaths(root), dirty)
  })
})

test("--commit records the cut, tags it, and pushes nothing", () => {
  withFixture((root) => {
    const output = cut(root, ["0.2.0", "--commit"])

    assert.equal(git(root, ["log", "-1", "--format=%s"]), "🔖 release: 0.2.0")
    assert.deepEqual(git(root, ["tag"]).split("\n").sort(), ["v0.1.0", "v0.2.0"])
    assert.equal(git(root, ["cat-file", "-t", "v0.2.0"]), "tag")
    assert.equal(git(root, ["rev-parse", "v0.2.0^{}"]), git(root, ["rev-parse", "HEAD"]))
    const committed = git(root, ["show", "--pretty=format:", "--name-only", "HEAD"]).split("\n")
    assert.ok(committed.includes("pnpm-lock.yaml"))
    assert.ok(committed.includes("bun.lock"))
    assert.deepEqual(dirtyPaths(root), [], "the cut is entirely in the commit")
    assert.match(output, /Nothing was pushed\./)
    assert.equal(output.includes("git push origin main v0.2.0\n"), true)
  })
})

test("the section a cut writes still checks green once the release commit exists", () => {
  withFixture((root) => {
    cut(root, ["0.2.0", "--commit"])

    // This is the check `release.yml` runs at the tag. It reads
    // `v0.1.0..HEAD`, and HEAD is now the release commit the cut just made, so
    // a generator that listed release commits would report its own work as
    // drift and fail every real release.
    const checked = execFileSync(
      process.execPath,
      ["scripts/generate-changelog.mjs", "--check", "--version", "0.2.0"],
      { cwd: root, encoding: "utf8" }
    )
    assert.match(checked, /matches v0\.1\.0\.\.HEAD/)
  })
})

test("--commit refuses a dirty working copy rather than sweeping it into the release", () => {
  withFixture((root) => {
    writeFileSync(join(root, "a.txt"), "someone else's edit")

    assert.throws(() => cut(root, ["0.2.0", "--commit"]), /--commit stages every tracked modification/)
    assert.equal(
      manifest(root, "packages/kernel/package.json").version,
      "0.1.0",
      "the refusal is before the first write"
    )
  })
})

test("a cut refuses an existing release tag before its first write", () => {
  withFixture((root) => {
    assert.throws(() => cut(root, ["0.1.0"]), /tag v0\.1\.0 already exists/)
    assert.equal(manifest(root, "packages/kernel/package.json").version, "0.1.0")
  })
})

test("--commit refuses a detached HEAD and a non-main branch without the explicit override", () => {
  withFixture((root) => {
    git(root, ["checkout", "--detach", "-q"])
    assert.throws(() => cut(root, ["0.2.0", "--commit"]), /detached HEAD/)
    assert.equal(manifest(root, "packages/kernel/package.json").version, "0.1.0")
  })
  withFixture((root) => {
    git(root, ["switch", "-q", "-c", "release-preparation"])
    assert.throws(() => cut(root, ["0.2.0", "--commit"]), /requires main.*--allow-branch/)
    assert.equal(manifest(root, "packages/kernel/package.json").version, "0.1.0")
  })
})

test("--allow-branch permits an intentional release commit on a named branch", () => {
  withFixture((root) => {
    git(root, ["switch", "-q", "-c", "release-preparation"])
    cut(root, ["0.2.0", "--commit", "--allow-branch"])

    assert.equal(git(root, ["branch", "--show-current"]), "release-preparation")
    assert.equal(git(root, ["cat-file", "-t", "v0.2.0"]), "tag")
  })
})

test("--commit checks the generated block on the exact release commit before tagging", () => {
  withFixture((root) => {
    const hook = join(root, ".git", "hooks", "post-commit")
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        `${
          JSON.stringify(process.execPath)
        } -e 'const fs=require(\"node:fs\"); const path=\"CHANGELOG.md\"; const text=fs.readFileSync(path,\"utf8\"); fs.writeFileSync(path,text.replace(\"2 commits since\",\"999 commits since\"))'`,
        ""
      ].join("\n")
    )
    chmodSync(hook, 0o755)

    assert.throws(() => cut(root, ["0.2.0", "--commit"]), /disagrees/)
    assert.equal(git(root, ["tag", "--list", "v0.2.0"]), "", "a stale exact-commit block is never tagged")
  })
})
