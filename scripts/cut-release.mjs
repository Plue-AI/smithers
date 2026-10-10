/**
 * Cuts one release in the working copy: the version bump, the changelog
 * section, the site's CLI data, and the verifications that prove each landed.
 *
 * Before this script the bump and the changelog were separate operator moves
 * with nothing sequencing them, and only one of them was checked. The version
 * setter has had a `--check` mode since it was written, `release.yml` runs it,
 * and a tag whose manifests disagreed with it failed loudly. The changelog had
 * no such gate at all, so the release that shipped with a missing section
 * shipped green.
 *
 * The site's CLI data (apps/site/src/data) captures the CLI's help banner and
 * version pins, so a bump drifts it, and the release's Site gate checks that
 * drift.
 *
 * The script writes and then re-reads. Writing and verifying are separate
 * passes on purpose: the check is the same one `release.yml` runs, so a cut
 * that passes here is a cut whose release job reaches the pack step.
 *
 * Nothing here pushes. `--commit` records the cut and tags it locally; the tag
 * push is the irreversible half and stays an operator's own keystroke, because
 * pushing a `v*` tag is what starts the publish.
 *
 * usage:
 *   node scripts/cut-release.mjs <version> [--commit] [--allow-branch]
 *
 *   <version>   the release version, without the leading `v`
 *   --commit    also commit the cut and create an annotated `v<version>` tag
 *   --allow-branch  permit `--commit` on a named branch other than `main`
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMain, repoRoot } from "./workspace-packages.mjs"

/**
 * The commit message a cut records, in the repository's emoji convention.
 *
 * @since 1.0.0
 * @category utilities
 */
export const releaseMessage = (version) => `🔖 release: ${version}`

/**
 * The tag one version is released under.
 *
 * @since 1.0.0
 * @category utilities
 */
export const releaseTag = (version) => `v${version}`

/**
 * The three commands the operator runs after a cut, in order.
 *
 * The first is spelled for jj because this tree is jj-colocated and that is
 * what a maintainer types; `git commit -am` is what `--commit` runs, and both
 * record the same commit. The last is the irreversible one: pushing the tag
 * is what triggers `.github/workflows/release.yml`.
 *
 * @since 1.0.0
 * @category utilities
 */
export const nextCommands = (version) => [
  `jj commit -m ${JSON.stringify(releaseMessage(version))}`,
  `node scripts/generate-changelog.mjs --check --version ${version}`,
  `git tag -a ${releaseTag(version)} -m ${JSON.stringify(releaseMessage(version))} && git push origin main ${
    releaseTag(version)
  }`
]

/** The generator behind `//apps/site:cliData`, which the Site gate checks. */
const siteCliDataScript = "apps/site/scripts/gen-cli-data.mjs"

/**
 * Every child invocation a cut makes, in order.
 *
 * Declared as data so the suite can assert the order and the flags without
 * running a release, and so the verifications are visibly the same commands
 * `release.yml` runs rather than a paraphrase of them. Lockfiles sit between
 * the writes and checks because the frozen install in the release job
 * consumes the bumped manifest ranges. The site's CLI data is captured after
 * the bump because its generator reads the version the bump wrote.
 *
 * @since 1.0.0
 * @category utilities
 */
export const steps = (version, options = { bunLock: true, siteCliData: true }) => [
  {
    name: "set the workspace version",
    command: process.execPath,
    args: ["scripts/set-release-version.mjs", version]
  },
  {
    name: "write the changelog section",
    command: process.execPath,
    args: ["scripts/generate-changelog.mjs", "--version", version]
  },
  {
    name: "refresh pnpm-lock.yaml",
    command: "pnpm",
    args: ["install", "--lockfile-only", "--ignore-scripts"]
  },
  ...(options.bunLock
    ? [{
      name: "refresh bun.lock",
      command: "bun",
      args: ["install", "--lockfile-only", "--ignore-scripts"]
    }]
    : []),
  ...(options.siteCliData
    ? [{
      name: "regenerate the site CLI data",
      command: process.execPath,
      args: [siteCliDataScript]
    }]
    : []),
  {
    name: "verify the workspace version",
    command: process.execPath,
    args: ["scripts/set-release-version.mjs", "--check", version]
  },
  {
    name: "verify the changelog section",
    command: process.execPath,
    args: ["scripts/generate-changelog.mjs", "--check", "--version", version]
  },
  ...(options.siteCliData
    ? [{
      name: "verify the site CLI data",
      command: process.execPath,
      args: [siteCliDataScript, "--check"]
    }]
    : [])
]

const run = (root, command, args) => execFileSync(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] })

/**
 * The tracked paths git reports as modified, staged, or deleted.
 *
 * Untracked files are deliberately absent: they are not what `git commit -am`
 * would sweep in, so they are not what makes a cut unsafe.
 *
 * @since 1.0.0
 * @category utilities
 */
export const dirtyPaths = (root = repoRoot) =>
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3))

/**
 * Parses one cut invocation without reading or changing the repository.
 *
 * @since 1.0.0
 * @category utilities
 */
export const parseArguments = (argv) => {
  const options = { version: undefined, commit: false, allowBranch: false }
  for (const argument of argv) {
    if (argument === "--commit") {
      options.commit = true
      continue
    }
    if (argument === "--allow-branch") {
      options.allowBranch = true
      continue
    }
    if (argument.startsWith("-")) throw new Error(`unknown option ${argument}`)
    if (options.version !== undefined) {
      throw new Error(`cut one version at a time, not ${options.version} and ${argument}`)
    }
    options.version = argument
  }
  if (options.version === undefined) {
    throw new Error("usage: node scripts/cut-release.mjs <version> [--commit] [--allow-branch]")
  }
  if (options.version.startsWith("v")) throw new Error(`pass the version, not the tag: ${options.version.slice(1)}`)
  if (options.allowBranch && !options.commit) throw new Error("--allow-branch requires --commit")
  return options
}

const trackedPath = (root, path) => {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: root, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const tagExists = (root, tag) => {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { cwd: root, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const currentBranch = (root) =>
  execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim()

/**
 * Cuts one version in `root`, optionally committing and tagging it locally.
 *
 * @since 1.0.0
 * @category utilities
 */
export const main = (argv, root = repoRoot) => {
  const options = parseArguments(argv)
  const tag = releaseTag(options.version)
  if (tagExists(root, tag)) throw new Error(`tag ${tag} already exists; refusing to rewrite or retag the release`)
  // The guard is before the first write, not after it. `git commit -am` stages
  // every tracked modification, so a cut run over someone else's half-finished
  // edit would publish it under a release message. Refusing here also leaves
  // the tree untouched, so the operator's next move is `jj st`, not a revert.
  if (options.commit) {
    const branch = currentBranch(root)
    if (branch === "") throw new Error("--commit refuses a detached HEAD; check out main before cutting a release")
    if (branch !== "main" && !options.allowBranch) {
      throw new Error(`--commit requires main, not ${branch}; pass --allow-branch only for an intentional branch cut`)
    }
    const dirty = dirtyPaths(root)
    if (dirty.length > 0) {
      throw new Error(
        `--commit stages every tracked modification and the working copy carries ${dirty.length}: ${dirty.join(", ")}`
      )
    }
  }
  process.stdout.write(
    "\nThe generated changelog must be regenerated for the exact release commit and checked before tagging.\n"
  )
  const present = { bunLock: trackedPath(root, "bun.lock"), siteCliData: trackedPath(root, siteCliDataScript) }
  for (const step of steps(options.version, present)) {
    process.stdout.write(`\n=== ${step.name}\n`)
    if (step.command !== "bun") {
      run(root, step.command, step.args)
      continue
    }
    // Bun 1.4 can trust the workspace table in an existing text lock after a
    // same-process manifest rewrite. Regenerate from the manifests, restoring
    // the old lock on failure so a failed cut never leaves it deleted.
    const lockPath = join(root, "bun.lock")
    const previous = readFileSync(lockPath)
    unlinkSync(lockPath)
    try {
      run(root, step.command, step.args)
      if (!existsSync(lockPath)) throw new Error("bun install did not recreate the tracked bun.lock")
    } catch (error) {
      writeFileSync(lockPath, previous)
      throw error
    }
  }
  if (options.commit) {
    process.stdout.write("\n=== record the cut\n")
    run(root, "git", ["commit", "-am", releaseMessage(options.version)])
    process.stdout.write("\n=== verify the changelog on the exact release commit\n")
    run(root, process.execPath, ["scripts/generate-changelog.mjs", "--check", "--version", options.version])
    run(root, "git", ["tag", "-a", tag, "-m", releaseMessage(options.version)])
    process.stdout.write(
      `\nCut ${options.version} and tagged ${tag}. Nothing was pushed.\n`
    )
    process.stdout.write(`Push the tag to publish:\n  git push origin main ${tag}\n`)
    return
  }
  process.stdout.write(
    `\n${options.version} is cut in the working copy. The changelog must be checked again on the exact release commit before tagging. Run these three next:\n`
  )
  for (const command of nextCommands(options.version)) process.stdout.write(`  ${command}\n`)
}

if (isMain(import.meta)) {
  main(process.argv.slice(2))
}
