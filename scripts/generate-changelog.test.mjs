/**
 * The changelog generator's four claims: it parses the repository's commit
 * subjects, it groups them, it renders one canonical block, and a second run
 * over the same range writes the same bytes.
 *
 * The end-to-end cases drive a real temporary git repository rather than a
 * recorded log. The generator's whole input is `git log`, `git describe`, and
 * `git tag --points-at`, so a fake would only prove that the fake agrees with
 * itself.
 *
 * Run it with `node --test scripts/generate-changelog.test.mjs`.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import {
  applyBlock,
  beginMarker,
  commitBaseUrl,
  commitDate,
  endMarker,
  entryLabel,
  groupCommits,
  hasRepository,
  main,
  parseBlock,
  parseSubject,
  previousTag,
  readCommits,
  renderBlock,
  renderEntry,
  rerender
} from "./generate-changelog.mjs"

const baseUrl = "https://github.com/smithersai/smithers/commit"

const hash = (seed) => seed.repeat(40).slice(0, 40)

const commit = (seed, subject) => ({ hash: hash(seed), ...parseSubject(subject) })

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseSubject reads the repository's emoji conventional-commit shape", () => {
  assert.deepEqual(parseSubject("🐛 fix(plan,sandbox): walk a payload"), {
    type: "fix",
    scope: "plan,sandbox",
    breaking: false,
    subject: "walk a payload"
  })
  assert.deepEqual(parseSubject("📝 docs: replace the vocs site"), {
    type: "docs",
    scope: undefined,
    breaking: false,
    subject: "replace the vocs site"
  })
  assert.deepEqual(parseSubject("feat(cli)!: drop the 0.x verbs"), {
    type: "feat",
    scope: "cli",
    breaking: true,
    subject: "drop the 0.x verbs"
  })
})

test("parseSubject reports a non-conforming subject rather than failing", () => {
  assert.deepEqual(parseSubject("Merge commit '4c2d3d3b' into lane/integrate"), {
    type: undefined,
    scope: undefined,
    breaking: false,
    subject: "Merge commit '4c2d3d3b' into lane/integrate"
  })
  assert.equal(parseSubject("0.35.0").type, undefined)
})

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test("groupCommits orders the typed sections and sweeps the rest into one", () => {
  const grouped = groupCommits([
    commit("a", "🧹 chore(repo): sweep"),
    commit("b", "✨ feat(cli): add a verb"),
    commit("c", "♻️ test(build): widen the matrix"),
    commit("d", "🐛 fix(engine): stop the leak"),
    commit("e", "Merge branch 'x'")
  ])

  assert.deepEqual(grouped.map((group) => group.heading), [
    "✨ Features",
    "🐛 Bug fixes",
    "🧹 Chores",
    "📦 Other changes"
  ])
  assert.deepEqual(grouped.at(-1).commits.map((entry) => entry.subject), [
    "widen the matrix",
    "Merge branch 'x'"
  ])
})

test("groupCommits keeps the release commit out of every section", () => {
  const grouped = groupCommits([
    commit("a", "🔖 release: 1.0.0"),
    commit("b", "🐛 fix(cli): stop the leak")
  ])

  assert.deepEqual(grouped.map((group) => group.commits.length), [1])
})

test("entryLabel names the scope inside a typed group and the type outside one", () => {
  const typed = commit("a", "🐛 fix(engine): stop the leak")
  assert.equal(entryLabel(typed, true), "engine")
  assert.equal(entryLabel(typed, false), "fix(engine)")
  assert.equal(entryLabel(commit("b", "📝 docs: rewrite"), true), undefined)
  assert.equal(entryLabel(commit("c", "📝 docs: rewrite"), false), "docs")
  assert.equal(entryLabel(commit("d", "Merge branch 'x'"), false), undefined)
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("renderEntry links the commit and marks a breaking change inside the subject", () => {
  assert.equal(
    renderEntry(commit("a", "🐛 fix(engine): stop the leak"), true, baseUrl),
    `- **engine:** stop the leak ([aaaaaaaaaa](${baseUrl}/${hash("a")}))`
  )
  assert.equal(
    renderEntry(commit("b", "feat!: drop the 0.x verbs"), true, baseUrl),
    `- **breaking** drop the 0.x verbs ([bbbbbbbbbb](${baseUrl}/${hash("b")}))`
  )
})

test("renderBlock writes one marker-delimited block naming its range", () => {
  const block = renderBlock({
    version: "1.0.0",
    from: "v0.9.0",
    fromHash: "0123456789",
    commits: [commit("a", "✨ feat(cli): add a verb"), commit("b", "Merge branch 'x'")],
    baseUrl
  })

  assert.equal(
    block,
    [
      beginMarker("1.0.0"),
      "",
      `2 commits since [v0.9.0](${baseUrl}/0123456789).`,
      "",
      "### ✨ Features",
      "",
      `- **cli:** add a verb ([aaaaaaaaaa](${baseUrl}/${hash("a")}))`,
      "",
      "### 📦 Other changes",
      "",
      `- Merge branch 'x' ([bbbbbbbbbb](${baseUrl}/${hash("b")}))`,
      "",
      endMarker("1.0.0"),
      ""
    ].join("\n")
  )
})

test("renderBlock says so when the range reaches the first commit", () => {
  const block = renderBlock({ version: "0.1.0", commits: [commit("a", "✨ feat: start")], baseUrl })
  assert.match(block, /^1 commit from the first commit\.$/m)
})

// ---------------------------------------------------------------------------
// The round trip the no-repository check depends on
// ---------------------------------------------------------------------------

test("parseBlock reads a rendered block back into its groups and range", () => {
  const commits = [
    commit("a", "✨ feat(cli): add a verb"),
    commit("b", "📝 docs: rewrite the guide"),
    commit("c", "♻️ test(build): widen the matrix"),
    commit("d", "Merge branch 'x'")
  ]
  const block = renderBlock({ version: "1.0.0", from: "v0.9.0", fromHash: "0123456789", commits, baseUrl })

  const parsed = parseBlock(block, "1.0.0")

  assert.equal(parsed.from, "v0.9.0")
  assert.equal(parsed.fromHash, "0123456789")
  assert.deepEqual(
    parsed.groups.flatMap((group) => group.commits.map((entry) => [entry.type, entry.scope])),
    [["feat", "cli"], ["docs", undefined], ["test", "build"], [undefined, undefined]]
  )
})

test("rerender reproduces a block byte for byte from the block alone", () => {
  const block = renderBlock({
    version: "1.0.0",
    from: "v0.9.0",
    fromHash: "0123456789",
    commits: [
      commit("a", "✨ feat(cli): add a verb"),
      commit("b", "📝 docs: rewrite the guide"),
      commit("c", "♻️ test(build): widen the matrix"),
      commit("d", "Merge branch 'x'")
    ],
    baseUrl
  })

  assert.equal(rerender(block, "1.0.0", baseUrl), block)
})

test("rerender reports a heading and an entry it cannot read", () => {
  const block = renderBlock({ version: "1.0.0", commits: [commit("a", "✨ feat: start")], baseUrl })

  assert.throws(
    () => rerender(block.replace("### ✨ Features", "### Features"), "1.0.0", baseUrl),
    /unknown changelog group heading: Features/
  )
  assert.throws(
    () => rerender(block.replace(/\(\[aaaaaaaaaa\].*\)\)$/m, "no link"), "1.0.0", baseUrl),
    /unreadable changelog entry/
  )
})

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const changelog = ["# smthrs", "", "Preamble.", "", "## 0.9.0 (2020-01-01)", "", "Old release.", ""].join("\n")

const block = (version) => [beginMarker(version), "", "0 commits from the first commit.", "", endMarker(version), ""].join("\n")

test("applyBlock opens a section above the newest release when the version has none", () => {
  const applied = applyBlock(changelog, { version: "1.0.0", date: "2026-09-03", block: block("1.0.0") })

  assert.equal(
    applied,
    [
      "# smthrs",
      "",
      "Preamble.",
      "",
      "## 1.0.0 (2026-09-03)",
      "",
      beginMarker("1.0.0"),
      "",
      "0 commits from the first commit.",
      "",
      endMarker("1.0.0"),
      "",
      "## 0.9.0 (2020-01-01)",
      "",
      "Old release.",
      ""
    ].join("\n")
  )
})

test("applyBlock appends inside an existing section and never rewrites its prose", () => {
  const withSection = changelog.replace(
    "## 0.9.0 (2020-01-01)",
    "## 1.0.0 (2026-09-03)\n\nHand-written narrative.\n\n## 0.9.0 (2020-01-01)"
  )

  const applied = applyBlock(withSection, { version: "1.0.0", date: "2026-09-09", block: block("1.0.0") })

  assert.match(applied, /## 1\.0\.0 \(2026-09-03\)\n\nHand-written narrative\.\n\n<!-- commits:1\.0\.0 -->/)
  assert.equal(applied.includes("2026-09-09"), false)
})

test("applyBlock replaces an existing block and is idempotent", () => {
  const once = applyBlock(changelog, { version: "1.0.0", date: "2026-09-03", block: block("1.0.0") })
  const twice = applyBlock(once, { version: "1.0.0", date: "2026-09-09", block: block("1.0.0") })

  assert.equal(twice, once)
})

// ---------------------------------------------------------------------------
// End to end, against a real repository
// ---------------------------------------------------------------------------

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()

/**
 * A repository carrying a tag, one commit per rendered group, and a merge.
 *
 * `--date` is pinned on every commit so the heading date this writes is a fact
 * about the fixture rather than about the day the suite runs.
 */
const fixture = ({ history = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-changelog-"))
  mkdirSync(join(root, "packages", "smithers"), { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, repository: { url: "git+https://github.com/smithersai/smithers.git" } }, null, 2)}\n`
  )
  writeFileSync(join(root, "packages", "smithers", "package.json"), `${JSON.stringify({ name: "@smthrs/cli", version: "0.2.0" }, null, 2)}\n`)
  writeFileSync(join(root, "CHANGELOG.md"), changelog)
  if (!history) return root
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "release@smithers.sh"])
  git(root, ["config", "user.name", "Release"])
  const commitAll = (message, date) => {
    git(root, ["add", "-A"])
    execFileSync("git", ["commit", "-q", "-m", message], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    })
  }
  commitAll("🎉 chore: initial", "2026-01-01T00:00:00+00:00")
  git(root, ["tag", "v0.1.0"])
  for (const [index, message] of [
    "✨ feat(cli): add the doctor verb",
    "🐛 fix(engine): stop the leak",
    "🔖 release: 0.1.5"
  ].entries()) {
    writeFileSync(join(root, `f${index}.txt`), message)
    commitAll(message, "2026-02-02T00:00:00+00:00")
  }
  git(root, ["checkout", "-q", "-b", "side", "HEAD~1"])
  writeFileSync(join(root, "side.txt"), "side")
  commitAll("♻️ refactor(core): rework the seam", "2026-02-03T00:00:00+00:00")
  git(root, ["checkout", "-q", "main"])
  execFileSync("git", ["merge", "-q", "--no-ff", "-m", "🔀 merge(side): fold the seam", "side"], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-02-04T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-02-04T00:00:00+00:00" }
  })
  return root
}

const withFixture = (body, options) => {
  const root = fixture(options)
  try {
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// A source export carries rendered bytes into a directory that has never
// held Git metadata. Do not simulate it by deleting an active repository.
const withGeneratedExport = (body) => {
  withFixture((source) => {
    main([], source)
    const rendered = readFileSync(join(source, "CHANGELOG.md"), "utf8")
    withFixture((root) => {
      writeFileSync(join(root, "CHANGELOG.md"), rendered)
      assert.equal(hasRepository(root), false)
      body(root)
    }, { history: false })
  })
}

test("readCommits skips merges and previousTag skips a tag on the range end", () => {
  withFixture((root) => {
    assert.equal(previousTag("HEAD", root), "v0.1.0")
    assert.equal(previousTag("v0.1.0", root), undefined)
    assert.deepEqual(
      readCommits({ from: "v0.1.0", to: "HEAD", root }).map((entry) => entry.subject),
      ["rework the seam", "0.1.5", "stop the leak", "add the doctor verb"]
    )
    assert.equal(commitDate("HEAD", root), "2026-02-04")
    assert.equal(commitBaseUrl(root), baseUrl)
  })
})

test("previousTag skips the release's own tag on an ancestor, so a withdrawn tag cannot shrink the range", () => {
  withFixture((root) => {
    // A pushed v0.2.0 whose publish never completed: it sits two commits below
    // HEAD, and a plain describe would stop there.
    git(root, ["tag", "-a", "v0.2.0", "-m", "withdrawn", "HEAD~2"])
    assert.equal(previousTag("HEAD", root), "v0.2.0")
    assert.equal(previousTag("HEAD", root, "0.2.0"), "v0.1.0")
    assert.equal(previousTag("v0.2.0", root, "0.2.0"), "v0.1.0")

    main([], root)
    const written = readFileSync(join(root, "CHANGELOG.md"), "utf8")
    assert.match(written, /^3 commits since \[v0\.1\.0\]/m, "the section still spans from the previous release")
    assert.doesNotMatch(written, /since \[v0\.2\.0\]/m)
    main(["--check"], root)
    assert.equal(process.exitCode, undefined)
  })
})

test("a write followed by a check is green, and a second write changes nothing", () => {
  withFixture((root) => {
    const changelogPath = join(root, "CHANGELOG.md")
    main([], root)
    const written = readFileSync(changelogPath, "utf8")

    assert.match(written, /^## 0\.2\.0 \(2026-02-04\)$/m)
    assert.match(written, /^3 commits since \[v0\.1\.0\]/m)
    assert.equal(written.includes("0.1.5"), false, "the release commit is not a change")
    assert.equal(written.includes("fold the seam"), false, "a merge is not a change")

    main([], root)
    assert.equal(readFileSync(changelogPath, "utf8"), written)

    main(["--check"], root)
    assert.equal(process.exitCode, undefined)
  })
})

test("a range whose log is larger than Node's default child buffer is read whole", () => {
  // The 1.0.0-rc.1 range produced 1.02 MiB of `git log`. execFileSync stops a
  // child at 1 MiB unless told otherwise, so the cut and the release gate
  // both died with ENOBUFS. Eighteen 64 KiB subjects cross that line without
  // eleven thousand commits.
  withFixture((root) => {
    const subject = `🐛 fix(big): ${"x".repeat(64 * 1024)}`
    const date = "2026-02-05T00:00:00+00:00"
    for (let index = 0; index < 18; index += 1) {
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", subject], {
        cwd: root,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      })
    }

    const commits = readCommits({ from: "v0.1.0", to: "HEAD", root })
    assert.equal(commits.length, 22)
    assert.ok(
      commits.reduce((bytes, entry) => bytes + entry.subject.length, 0) > 1024 * 1024,
      "the fixture must exceed the default buffer to prove anything"
    )

    main([], root)
    assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"), /^21 commits since \[v0\.1\.0\]/m)
    main(["--check"], root)
    assert.equal(process.exitCode, undefined)
  })
})

test("a check fails on a stale section and on a missing one", () => {
  withFixture((root) => {
    const changelogPath = join(root, "CHANGELOG.md")
    main([], root)
    writeFileSync(
      changelogPath,
      readFileSync(changelogPath, "utf8").replace("stop the leak", "stop the other leak")
    )

    main(["--check"], root)
    assert.equal(process.exitCode, 1)
    process.exitCode = undefined

    main(["--check", "--version", "9.9.9"], root)
    assert.equal(process.exitCode, 1)
    process.exitCode = undefined
  })
})

test("a check with no repository still rejects a hand-edited block", () => {
  withGeneratedExport((root) => {
    const changelogPath = join(root, "CHANGELOG.md")

    main(["--check"], root)
    assert.equal(process.exitCode, undefined, "the block this script wrote is its own canonical rendering")

    writeFileSync(
      changelogPath,
      readFileSync(changelogPath, "utf8").replace(/^- \*\*cli:\*\* .*\n/m, "")
    )
    main(["--check"], root)
    assert.equal(process.exitCode, 1)
    process.exitCode = undefined
  })
})

test("a write with no repository re-renders the block, which is how the lint verb checks it", () => {
  withGeneratedExport((root) => {
    const changelogPath = join(root, "CHANGELOG.md")
    const written = readFileSync(changelogPath, "utf8")

    // This is exactly what `smithers-build lint '//:changelog'` runs inside its
    // scratch copy: no history, write mode, and then a diff of CHANGELOG.md
    // against the real tree. A canonical block must come out unchanged.
    main([], root)
    assert.equal(readFileSync(changelogPath, "utf8"), written)

    // And a hand edit must come out changed, or the lint proves nothing.
    writeFileSync(changelogPath, written.replace(/^- \*\*cli:\*\* .*\n/m, ""))
    main([], root)
    assert.notEqual(readFileSync(changelogPath, "utf8"), written)
    assert.match(readFileSync(changelogPath, "utf8"), /^2 commits since/m)
  })
})

test("a write with no repository and no block refuses rather than inventing one", () => {
  withFixture((root) => {
    assert.equal(hasRepository(root), false)
    assert.throws(() => main([], root), /carries no generated commit block for 0\.2\.0/)
  }, { history: false })
})

test("the tag form of a version is refused, the way the version setter refuses it", () => {
  assert.throws(() => main(["--version", "v1.0.0"], resolve(import.meta.dirname, "..")), /pass the version, not the tag: 1\.0\.0/)
})
