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
  "packages/smithers/flows/database/src/internal/ReleasePolicy.ts": "export const releaseVersion = \"0.1.0\"\n",
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

/** Every optional step on, as a tree that tracks all of their inputs and outputs gets. */
const everyStep = { bunLock: true, siteCliData: true, factoryProjection: true, targetIndex: true }

test("a cut writes both halves, refreshes both tracked lockfiles, regenerates the site CLI data, the factory projection and the target index, and then verifies all five", () => {
  assert.deepEqual(steps("1.0.0", everyStep).map((step) => [step.command, ...step.args]), [
    [process.execPath, "scripts/set-release-version.mjs", "1.0.0"],
    [process.execPath, "scripts/generate-changelog.mjs", "--version", "1.0.0"],
    ["pnpm", "install", "--lockfile-only", "--ignore-scripts"],
    ["bun", "install", "--lockfile-only", "--ignore-scripts"],
    [process.execPath, "apps/site/scripts/gen-cli-data.mjs"],
    ["pnpm", "exec", "smthrs", "target", "//:factoryProjection", "--write"],
    ["pnpm", "exec", "smthrs", "target", "//:targetIndex", "--write"],
    [process.execPath, "scripts/set-release-version.mjs", "--check", "1.0.0"],
    [process.execPath, "scripts/generate-changelog.mjs", "--check", "--version", "1.0.0"],
    [process.execPath, "apps/site/scripts/gen-cli-data.mjs", "--check"],
    ["pnpm", "exec", "smthrs", "lint", "//:factoryProjection"],
    ["pnpm", "exec", "smthrs", "lint", "//:targetIndex"]
  ])
  assert.equal(steps("1.0.0", { ...everyStep, bunLock: false }).some((step) => step.command === "bun"), false)
  assert.equal(
    steps("1.0.0", { ...everyStep, siteCliData: false }).some((step) => step.args[0] === "apps/site/scripts/gen-cli-data.mjs"),
    false
  )
  for (const [option, label] of [["factoryProjection", "//:factoryProjection"], ["targetIndex", "//:targetIndex"]]) {
    const without = steps("1.0.0", { ...everyStep, [option]: false })
    assert.equal(without.some((step) => step.args.includes(label)), false, `${option}: false drops ${label}`)
    assert.equal(without.some((step) => step.args.includes(option === "targetIndex" ? "//:factoryProjection" : "//:targetIndex")), true)
  }
})

test("the cut verifies the factory projection and the target index with the exact commands the release's drift gates run", () => {
  const release = readFileSync(join(scriptsDirectory, "../.github/workflows/release.yml"), "utf8")
  const lints = steps("1.0.0", everyStep).filter((step) => step.args.slice(0, 3).join(" ") === "exec smthrs lint")
  assert.deepEqual(lints.map((step) => step.args[3]), ["//:factoryProjection", "//:targetIndex"])
  for (const step of lints) {
    assert.ok(
      release.includes(`run: pnpm exec smthrs lint '${step.args[3]}' `),
      `release.yml gates ${step.args[3]} with the command the cut checks`
    )
  }
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

/**
 * A stand-in for the site's CLI data generator: it captures the CLI version
 * the cut just wrote, as the real one does through the CLI's help banner.
 */
const siteGenerator = `import { readFileSync, writeFileSync } from "node:fs"
const { version } = JSON.parse(readFileSync("packages/smithers/package.json", "utf8"))
const text = JSON.stringify({ cli: version }, null, 2) + "\\n"
const path = "apps/site/src/data/versions.json"
if (!process.argv.includes("--check")) writeFileSync(path, text)
else if (readFileSync(path, "utf8") !== text) { console.error("drift: " + path); process.exit(1) }
`

test("--commit regenerates the site CLI data from the bumped CLI, so the release's Site gate sees no drift", () => {
  withFixture((root) => {
    write(root, "apps/site/scripts/gen-cli-data.mjs", siteGenerator)
    write(root, "apps/site/src/data/versions.json", json({ cli: "0.1.0" }))
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "📝 docs(site): capture the CLI data"])

    cut(root, ["0.2.0", "--commit"])

    assert.deepEqual(JSON.parse(readFileSync(join(root, "apps/site/src/data/versions.json"), "utf8")), { cli: "0.2.0" })
    const committed = git(root, ["show", "--pretty=format:", "--name-only", "HEAD"]).split("\n")
    assert.ok(committed.includes("apps/site/src/data/versions.json"))
    assert.deepEqual(dirtyPaths(root), [], "the regenerated data is in the release commit")
  })
})

/**
 * A stand-in for `smthrs` with the two generators a cut drives. Each output is
 * the listing of the directory its real generator walks: the target index
 * rows follow the sources, the factory projection follows `flows/`. So a
 * landing that adds a file and does not regenerate leaves the checked-in
 * output stale, as it does in this repository. `target <label> --write`
 * rewrites a label in `writable`; `lint <label>` fails on drift.
 */
const smthrsStandIn = (writable) => `#!${process.execPath}
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs")
const [verb, label, flag] = process.argv.slice(2)
const outputs = { "//:factoryProjection": [".smithers/factory.json", "flows"], "//:targetIndex": [".smithers/target-index.json", "src"] }
const [path, walked] = outputs[label]
const text = JSON.stringify(readdirSync(walked).sort(), null, 2) + "\\n"
if (verb === "target" && flag === "--write") {
  if (${JSON.stringify(writable)}.includes(label)) { mkdirSync(".smithers", { recursive: true }); writeFileSync(path, text) }
} else if (verb === "lint" && flag === undefined) {
  if (readFileSync(path, "utf8") !== text) { console.error("drift: " + path); process.exit(1) }
} else { console.error("unexpected: " + process.argv.slice(2).join(" ")); process.exit(2) }
`

const smthrsIn = (root, args) => execFileSync("pnpm", ["exec", "smthrs", ...args], { cwd: root, encoding: "utf8", stdio: "pipe" })

/**
 * Commits generated outputs in step with the tree, then a landing that adds a
 * source file and a flow without regenerating either: the state every
 * "drift" red on the release gates started from.
 */
const seedDriftedOutputs = (root, writable) => {
  write(root, "node_modules/.bin/smthrs", smthrsStandIn(writable))
  chmodSync(join(root, "node_modules/.bin/smthrs"), 0o755)
  write(root, "src/a.ts", "export const a = 1\n")
  write(root, "flows/todo/flow.ts", "export default {}\n")
  write(root, ".smithers/target-index.json", json(["a.ts"]))
  write(root, ".smithers/factory.json", json(["todo"]))
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "🔧 build(index): regenerate the target index and the factory projection"])
  write(root, "src/b.ts", "export const b = 2\n")
  write(root, "flows/review/flow.ts", "export default {}\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "✨ feat(flows): add the review flow"])
  for (const label of ["//:factoryProjection", "//:targetIndex"]) {
    assert.throws(() => smthrsIn(root, ["lint", label]), (error) => error.status === 1, `${label} starts drifted`)
  }
}

test("--commit regenerates the factory projection and the target index a landing left stale, so the release's drift gates pass", () => {
  withFixture((root) => {
    seedDriftedOutputs(root, ["//:factoryProjection", "//:targetIndex"])

    const output = cut(root, ["0.2.0", "--commit"])

    assert.match(output, /=== regenerate the factory projection\n[\s\S]*=== regenerate the target index\n/)
    assert.match(output, /=== verify the factory projection\n[\s\S]*=== verify the target index\n/)
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".smithers/factory.json"), "utf8")), ["review", "todo"])
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".smithers/target-index.json"), "utf8")), ["a.ts", "b.ts"])
    const committed = git(root, ["show", "--pretty=format:", "--name-only", "HEAD"]).split("\n")
    assert.ok(committed.includes(".smithers/factory.json"), "the projection is in the release commit")
    assert.ok(committed.includes(".smithers/target-index.json"), "the index is in the release commit")
    assert.deepEqual(dirtyPaths(root), [])
    assert.equal(git(root, ["rev-parse", "v0.2.0^{}"]), git(root, ["rev-parse", "HEAD"]))
    for (const label of ["//:factoryProjection", "//:targetIndex"]) smthrsIn(root, ["lint", label])
  })
})

test("a cut whose regenerated target index still drifts stops at verification and tags nothing", () => {
  withFixture((root) => {
    seedDriftedOutputs(root, ["//:factoryProjection"])
    const head = git(root, ["rev-parse", "HEAD"])

    assert.throws(() => cut(root, ["0.2.0", "--commit"]), (error) => /drift: \.smithers\/target-index\.json/.test(String(error.stderr)))
    assert.equal(git(root, ["tag", "--list", "v0.2.0"]), "", "a drifted cut is never tagged")
    assert.equal(git(root, ["rev-parse", "HEAD"]), head, "nor committed")
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
