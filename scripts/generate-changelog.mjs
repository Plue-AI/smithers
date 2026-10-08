/**
 * Renders one release's commit-level `CHANGELOG.md` section from git history.
 *
 * The file is the complete, commit-level changelog, and until this script
 * existed every section of it was typed by hand. A hand-typed section is
 * missing the moment a release is cut in a hurry, and nothing in the release
 * pipeline noticed: `.github/workflows/release.yml` checked the tag, the
 * manifests, and the packed set, then published a version whose changelog said
 * nothing about it.
 *
 * ## What is generated, and what is not
 *
 * A release section has two halves. The narrative — what changed and why it
 * matters — is written by a person, and this script never touches it. The
 * commit list under it is mechanical, and this script owns exactly that,
 * delimited by a marker pair:
 *
 * ```md
 * ## 1.0.0-rc.0 (2026-08-31)
 *
 * The first release candidate of Smithers 1.0. …hand-written narrative…
 *
 * <!-- commits:1.0.0-rc.0 -->
 *
 * 1230 commits since [v0.35.0](…).
 *
 * ### 🐛 Bug fixes
 *
 * - **engine:** … ([369a03babf](…))
 *
 * <!-- /commits:1.0.0-rc.0 -->
 * ```
 *
 * Writing replaces only what sits between the markers, so regenerating a
 * section can never eat the prose above it. When the version has no section at
 * all, one is opened with a `## <version> (<date>)` heading above the newest
 * existing release, and the block goes inside it.
 *
 * ## Determinism
 *
 * Two runs over the same range produce identical bytes. The date in a new
 * heading is the `--to` commit's own committer date, never the clock, and an
 * existing heading is left exactly as it stands. Commits of type `release` are
 * skipped, so the release commit a cut adds between generating the section and
 * tagging it does not make that section stale.
 *
 * ## Why every mode has a no-repository half
 *
 * `//:changelog` drift-checks by running this script inside a scratch copy of
 * the tree and diffing `changes` against the real one, and that copy
 * deliberately carries no `.git` (`versionControl` in
 * `PackageTree.scratchCopy`,
 * `packages/smithers/build/build-cli/src/PackageTree.ts:1266`). A generator
 * that needed history there would fail every lint, and one that did nothing
 * there would pass every lint without checking anything. So both modes fall
 * back to the block itself:
 *
 * - With a repository, the range is re-read from git. Writing rewrites the
 *   block; `--check` compares byte for byte and is the gate `release.yml` runs
 *   at the tag, where a missing or stale section fails the release.
 * - Without one, the block is parsed back into commits and re-rendered from
 *   its own contents. That proves the grouping, the order, the labels, the
 *   links, and the count are the ones this script produces, which is the drift
 *   a hand edit introduces. It cannot prove the block still matches history,
 *   and `--check` says so rather than reporting a pass it did not earn. A
 *   version with no block at all fails either way.
 *
 * usage:
 *   node scripts/generate-changelog.mjs [options]
 *
 *   --version <v>  the release to render (default: packages/smithers version)
 *   --from <ref>   range start, exclusive (default: the nearest v* tag below --to, never v<version> itself)
 *   --to <ref>     range end, inclusive (default: HEAD)
 *   --check        report drift and exit 1 instead of writing
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMain, repoRoot } from "./workspace-packages.mjs"

/** The manifest whose version names the release when `--version` is absent. */
export const versionManifestPath = "packages/smithers/package.json"

/** Length of the commit hash rendered as an entry's link text. */
export const shortHashLength = 10

/**
 * Commit types that get a section of their own, in the order they are rendered.
 *
 * Everything else lands in {@link otherGroup}, where each entry keeps its type
 * in the label, so a `test:` or `revert:` commit is still readable as one.
 */
export const commitGroups = [
  { type: "feat", heading: "✨ Features" },
  { type: "fix", heading: "🐛 Bug fixes" },
  { type: "perf", heading: "⚡ Performance" },
  { type: "refactor", heading: "♻️ Refactors" },
  { type: "docs", heading: "📝 Documentation" },
  { type: "chore", heading: "🧹 Chores" }
]

/** The bucket every commit that is not one of {@link commitGroups} falls into. */
export const otherGroup = { type: undefined, heading: "📦 Other changes" }

/** Every rendered group, typed sections first. */
export const allGroups = [...commitGroups, otherGroup]

/**
 * Types omitted from every section.
 *
 * `release` is the commit a cut writes. Rendering it would mean the section a
 * cut generates goes stale the instant the operator commits it, and the
 * `--check` step in `release.yml` would then fail every real release.
 */
export const skippedTypes = new Set(["release"])

/**
 * Parses one conventional-commit subject.
 *
 * The repository writes `<emoji> <type>(<scope>): <subject>`, and the emoji is
 * optional here because the type is what decides the section. A subject that
 * does not conform is not an error: it comes back with no type and renders as a
 * bare line under {@link otherGroup}.
 */
export const parseSubject = (subject) => {
  const match = /^(?:\S+\s+)?([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(\S.*)$/u.exec(subject)
  if (match === null) return { type: undefined, scope: undefined, breaking: false, subject: subject.trim() }
  const [, type, scope, breaking, text] = match
  return {
    type,
    scope: scope === undefined || scope === "" ? undefined : scope,
    breaking: breaking === "!",
    subject: text.trim()
  }
}

/**
 * Splits parsed commits into the rendered groups, dropping {@link skippedTypes}.
 *
 * Order within a group is the order git reported, newest first, so a section
 * reads as the history it came from. Empty groups are omitted rather than
 * rendered as a heading with nothing under it.
 */
export const groupCommits = (commits) => {
  const buckets = new Map(allGroups.map((group) => [group.heading, []]))
  for (const commit of commits) {
    if (commit.type !== undefined && skippedTypes.has(commit.type)) continue
    const group = commitGroups.find((candidate) => candidate.type === commit.type) ?? otherGroup
    buckets.get(group.heading).push(commit)
  }
  return allGroups
    .map((group) => ({ ...group, commits: buckets.get(group.heading) }))
    .filter((group) => group.commits.length > 0)
}

/**
 * The bold label one entry carries, or `undefined` for a bare line.
 *
 * Inside a typed group the heading already names the type, so the label is the
 * scope alone. Under {@link otherGroup} the type is the information, so the
 * label is the whole `type(scope)` prefix.
 */
export const entryLabel = (commit, grouped) => {
  if (grouped) return commit.scope
  if (commit.type === undefined) return undefined
  return commit.scope === undefined ? commit.type : `${commit.type}(${commit.scope})`
}

/**
 * The commit URL prefix, read from the root manifest's `repository.url`.
 *
 * Deriving it means a fork's changelog links to the fork. The `git+` prefix and
 * the `.git` suffix are the shapes npm writes.
 */
export const commitBaseUrl = (root = repoRoot) => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const url = manifest.repository?.url ?? manifest.repository
  if (typeof url !== "string") throw new Error("package.json declares no repository.url")
  return `${url.replace(/^git\+/, "").replace(/\.git$/, "")}/commit`
}

/**
 * Renders one commit as its list entry.
 *
 * A breaking commit keeps its marker as a bold word inside the subject rather
 * than as punctuation in the label, so the round trip in {@link parseBlock}
 * reads it back as part of the subject and re-renders the same bytes.
 */
export const renderEntry = (commit, grouped, baseUrl) => {
  const label = entryLabel(commit, grouped)
  const subject = commit.breaking === true ? `**breaking** ${commit.subject}` : commit.subject
  const link = `([${commit.hash.slice(0, shortHashLength)}](${baseUrl}/${commit.hash}))`
  return label === undefined ? `- ${subject} ${link}` : `- **${label}:** ${subject} ${link}`
}

/** The opening marker of one version's generated block. */
export const beginMarker = (version) => `<!-- commits:${version} -->`

/** The closing marker of one version's generated block. */
export const endMarker = (version) => `<!-- /commits:${version} -->`

/** The line that names the range a block covers. */
export const renderSummary = ({ total, from, fromHash, baseUrl }) => {
  const noun = total === 1 ? "commit" : "commits"
  const since = from === undefined ? "from the first commit" : `since [${from}](${baseUrl}/${fromHash})`
  return `${total} ${noun} ${since}.`
}

/**
 * Renders the marker-delimited block for one version.
 *
 * `groups` is the already-grouped rendering order, so the same renderer serves
 * a fresh read of git history and a re-render of a block parsed back out of the
 * file.
 */
export const renderGroupedBlock = ({ version, from, fromHash, groups, baseUrl }) => {
  const total = groups.reduce((count, group) => count + group.commits.length, 0)
  const body = groups.flatMap((group) => [
    `### ${group.heading}`,
    "",
    ...group.commits.map((commit) => renderEntry(commit, group.type !== undefined, baseUrl)),
    ""
  ])
  return [
    beginMarker(version),
    "",
    renderSummary({ total, from, fromHash, baseUrl }),
    "",
    ...body,
    endMarker(version),
    ""
  ].join("\n")
}

/** Renders the block for one version from a flat list of commits. */
export const renderBlock = ({ version, from, fromHash, commits, baseUrl }) =>
  renderGroupedBlock({ version, from, fromHash, groups: groupCommits(commits), baseUrl })

/** The `[start, end)` character span one version's block occupies, or `undefined`. */
export const blockSpan = (text, version) => {
  const begin = text.indexOf(beginMarker(version))
  if (begin < 0) return undefined
  const end = text.indexOf(endMarker(version), begin)
  if (end < 0) return undefined
  return { begin, end: end + endMarker(version).length + 1 }
}

const summaryPattern = /^(\d+) commits? (?:since \[([^\]]+)\]\(([^)]+)\)|from the first commit)\.$/
const entryPattern = /^- (?:\*\*([^*]+):\*\* )?(.*) \(\[[0-9a-f]+\]\(([^)]+)\)\)$/
const labelPattern = /^([a-z]+)(?:\(([^)]*)\))?$/

/** The commit hash one rendered link points at: the last segment of its href. */
const hashOf = (href) => href.slice(href.lastIndexOf("/") + 1)

/**
 * Reads one generated block back into the range and groups it was rendered from.
 *
 * This is what makes the check meaningful where the tree has no `.git`: the
 * block is its own record, so re-rendering what it holds proves the grouping,
 * the order, the labels, and the links are the ones this script produces.
 */
export const parseBlock = (text, version) => {
  const span = blockSpan(text, version)
  if (span === undefined) return undefined
  const headings = new Map(allGroups.map((group) => [group.heading, group.type]))
  const groups = []
  let from
  let fromHash
  let current
  for (const line of text.slice(span.begin, span.end).split("\n")) {
    const summary = summaryPattern.exec(line)
    if (summary !== null) {
      from = summary[2]
      fromHash = summary[3] === undefined ? undefined : hashOf(summary[3])
      continue
    }
    if (line.startsWith("### ")) {
      const heading = line.slice(4)
      if (!headings.has(heading)) throw new Error(`unknown changelog group heading: ${heading}`)
      current = { type: headings.get(heading), heading, commits: [] }
      groups.push(current)
      continue
    }
    if (!line.startsWith("- ")) continue
    if (current === undefined) throw new Error(`changelog entry before any group heading: ${line}`)
    const entry = entryPattern.exec(line)
    if (entry === null) throw new Error(`unreadable changelog entry: ${line}`)
    const [, label, subject, href] = entry
    const hash = hashOf(href)
    const parsedLabel = label === undefined ? undefined : labelPattern.exec(label)
    if (label !== undefined && current.type === undefined && parsedLabel === null) {
      throw new Error(`unreadable changelog entry label: ${line}`)
    }
    current.commits.push({
      hash,
      type: current.type ?? parsedLabel?.[1],
      scope: current.type === undefined ? parsedLabel?.[2] : label,
      subject
    })
  }
  return { from, fromHash, groups }
}

/**
 * The most output one git command may return.
 *
 * Node stops a synchronous child at 1 MiB by default. The 1.0.0-rc.1 range
 * held about 11,000 subjects, 1.02 MiB of `git log`, so both the cut and the
 * release gate died with `ENOBUFS` before rendering a line. A range is bounded
 * by history, not by this script, so the limit is set far above any release.
 */
export const gitOutputLimit = 256 * 1024 * 1024

/** Runs one git command in `root` and returns its trimmed stdout. */
const git = (args, root = repoRoot) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: gitOutputLimit
  }).trim()

/** Whether `root` is inside a git work tree this script can read history from. */
export const hasRepository = (root = repoRoot) => {
  if (!existsSync(join(root, ".git"))) return false
  try {
    return git(["rev-parse", "--is-inside-work-tree"], root) === "true"
  } catch {
    return false
  }
}

/**
 * The nearest `v*` tag below `to`, or `undefined` when there is none.
 *
 * Tags that point at `to` itself are excluded: on a tag push HEAD is the tag,
 * and describing it would return an empty range.
 *
 * The release's own tag is excluded wherever it points. A pushed `v<version>`
 * tag whose publish never completed sits on an ancestor of every later main
 * commit, and describing past it would shrink the section for `version` to
 * the handful of commits since the withdrawn tag. The 1.0.0-rc.0 rehearsal
 * hit exactly that: the range collapsed from `v0.35.0..HEAD` (1547 commits)
 * to `v1.0.0-rc.0..HEAD` (56), and the gate failed a changelog that was
 * right. The section for a version always spans from the previous release.
 */
export const previousTag = (to, root = repoRoot, version = undefined) => {
  const here = git(["tag", "--points-at", to], root).split("\n").filter((line) => line !== "")
  const own = version === undefined ? [] : [`v${version}`]
  const excludes = [...new Set([...here, ...own])].map((tag) => `--exclude=${tag}`)
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match=v*", ...excludes, to], root)
  } catch {
    return undefined
  }
}

/**
 * Every commit in `from..to`, newest first, merges excluded.
 *
 * A merge carries no subject of its own worth listing: its content already
 * appears as the commits it merged.
 */
export const readCommits = ({ from, to = "HEAD", root = repoRoot }) => {
  const range = from === undefined ? to : `${from}..${to}`
  const output = git(["log", "--no-merges", "--format=%H %s", range], root)
  if (output === "") return []
  return output.split("\n").map((line) => {
    const space = line.indexOf(" ")
    return { hash: line.slice(0, space), ...parseSubject(line.slice(space + 1)) }
  })
}

/** The `--to` commit's own committer date as `YYYY-MM-DD`. */
export const commitDate = (to = "HEAD", root = repoRoot) => git(["log", "-1", "--format=%cI", to], root).slice(0, 10)

/** The release version the manifests carry. */
export const declaredVersion = (root = repoRoot) =>
  JSON.parse(readFileSync(join(root, versionManifestPath), "utf8")).version

/**
 * Splices one version's block into the changelog.
 *
 * Three placements, in order of precedence: replace the existing block, append
 * inside an existing `## <version>` section, or open a section above the newest
 * one. Nothing outside the block is ever rewritten.
 */
export const applyBlock = (text, { version, date, block }) => {
  const span = blockSpan(text, version)
  if (span !== undefined) return `${text.slice(0, span.begin)}${block}${text.slice(span.end)}`
  const lines = text.split("\n")
  const headingIndex = lines.findIndex((line) => line.startsWith(`## ${version} (`))
  if (headingIndex >= 0) {
    const nextIndex = lines.findIndex((line, index) => index > headingIndex && line.startsWith("## "))
    const cut = nextIndex < 0 ? lines.length : nextIndex
    const before = lines.slice(0, cut)
    while (before.at(-1) === "") before.pop()
    return [...before, "", block, ...lines.slice(cut)].join("\n")
  }
  const firstRelease = lines.findIndex((line) => line.startsWith("## "))
  const section = [`## ${version} (${date})`, "", block]
  if (firstRelease >= 0) return [...lines.slice(0, firstRelease), ...section, ...lines.slice(firstRelease)].join("\n")
  const before = [...lines]
  while (before.at(-1) === "") before.pop()
  return [...before, "", ...section].join("\n")
}

/** The changelog text this version and range should produce, read from git. */
export const generate = ({ version, from, to = "HEAD", root = repoRoot, text }) => {
  const baseUrl = commitBaseUrl(root)
  const start = from ?? previousTag(to, root, version)
  const block = renderBlock({
    version,
    from: start,
    fromHash: start === undefined ? undefined : git(["rev-parse", start], root).slice(0, shortHashLength),
    commits: readCommits({ from: start, to, root }),
    baseUrl
  })
  return { from: start, text: applyBlock(text, { version, date: commitDate(to, root), block }) }
}

/** The block one version's own contents re-render to, or `undefined` when absent. */
export const rerender = (text, version, baseUrl) => {
  const parsed = parseBlock(text, version)
  if (parsed === undefined) return undefined
  return renderGroupedBlock({ version, from: parsed.from, fromHash: parsed.fromHash, groups: parsed.groups, baseUrl })
}

const parseArguments = (argv) => {
  const options = { version: undefined, from: undefined, to: "HEAD", check: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (argv[index] === undefined) throw new Error(`${argument} needs a value`)
      return argv[index]
    }
    switch (argument) {
      case "--version":
        options.version = next()
        break
      case "--from":
        options.from = next()
        break
      case "--to":
        options.to = next()
        break
      case "--check":
        options.check = true
        break
      default:
        throw new Error(`unknown option ${argument}`)
    }
  }
  if (options.version !== undefined && options.version.startsWith("v")) {
    throw new Error(`pass the version, not the tag: ${options.version.slice(1)}`)
  }
  return options
}

/** The first line at which two renderings differ, for a drift report. */
export const firstDifference = (actual, expected) => {
  const left = actual.split("\n")
  const right = expected.split("\n")
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue
    return { line: index + 1, actual: left[index] ?? "(end of file)", expected: right[index] ?? "(end of file)" }
  }
  return undefined
}

const reportDrift = (heading, difference) => {
  console.error(heading)
  console.error(`  found:    ${difference.actual}`)
  console.error(`  expected: ${difference.expected}`)
  console.error("\nrun `node scripts/generate-changelog.mjs` to regenerate the section.")
}

export const main = (argv, root = repoRoot) => {
  const options = parseArguments(argv)
  const version = options.version ?? declaredVersion(root)
  const changelogPath = join(root, "CHANGELOG.md")
  const text = readFileSync(changelogPath, "utf8")

  if (!hasRepository(root)) {
    const rendered = rerender(text, version, commitBaseUrl(root))
    if (rendered === undefined) {
      const missing = `CHANGELOG.md carries no generated commit block for ${version}, and there is no repository to read one from.`
      if (!options.check) throw new Error(missing)
      console.error(missing)
      process.exitCode = 1
      return
    }
    const span = blockSpan(text, version)
    const current = text.slice(span.begin, span.end)
    const canonical = `${text.slice(0, span.begin)}${rendered}${text.slice(span.end)}`
    if (!options.check) {
      // Write mode with no history is not a refusal, because it is the shape
      // the build system's drift check takes: `//:changelog`'s `lint` verb runs
      // this script inside a scratch copy of the tree that carries no `.git`
      // and then diffs `changes` against the real one. Re-rendering the block
      // from its own contents makes that diff a real check — of the grouping,
      // the order, the labels, the links, and the count — rather than a check
      // of nothing.
      if (canonical !== text) writeFileSync(changelogPath, canonical)
      console.log(`no git repository: rewrote the ${version} block from its own contents.`)
      return
    }
    if (current !== rendered) {
      const difference = firstDifference(current, rendered)
      reportDrift(
        `the ${version} commit block is not the canonical rendering, at block line ${difference.line}.`,
        difference
      )
      process.exitCode = 1
      return
    }
    console.log(
      `no git repository: checked the ${version} block's own rendering, not that it still matches history.`
    )
    return
  }

  const { from, text: expected } = generate({ ...options, version, root, text })
  const range = `${from ?? "the first commit"}..${options.to}`
  if (!options.check) {
    if (expected !== text) writeFileSync(changelogPath, expected)
    console.log(`wrote the ${version} commit block from ${range}.`)
    return
  }
  if (expected !== text) {
    const difference = firstDifference(text, expected)
    reportDrift(`CHANGELOG.md line ${difference.line} disagrees with ${range} for ${version}.`, difference)
    process.exitCode = 1
    return
  }
  console.log(`the ${version} commit block matches ${range}.`)
}

if (isMain(import.meta)) {
  main(process.argv.slice(2))
}
