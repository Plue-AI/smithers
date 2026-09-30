/**
 * Cuts the immutable review release: a local annotated `review-v<version>` tag
 * on a commit whose reusable workflow runs the action at a full commit SHA.
 *
 * `.github/workflows/review.yml` on main calls the action at `@main`, so a tag
 * on main alone would still execute later main code. The release commit is a
 * child of the reviewed revision whose only difference is that one `uses:` line
 * pinned to the revision. The script verifies the difference is exactly that
 * file, so the tagged action tree is byte-identical to the tested one.
 *
 * Nothing is pushed and no working file is touched (a scratch index is used).
 * The tag name never starts with `v`: `release.yml` publishes npm on `v*`.
 *
 * usage:
 *   node apps/review/scripts/review-release.mjs <version> [<revision>]
 *
 *   <version>   x.y.z, without a prefix
 *   <revision>  the tested commit to pin (default: origin/main)
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const WORKFLOW_PATH = ".github/workflows/review.yml"
const FLOATING = "smithersai/smithers/apps/review/action@main"
const PIN = /^smithersai\/smithers\/apps\/review\/action@[0-9a-f]{40}$/

export const reviewTag = (version) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must be x.y.z, got ${JSON.stringify(version)}`)
  return `review-v${version}`
}

/** The workflow with its floating action reference replaced by `sha`. */
export const pinWorkflow = (yaml, sha) => {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`revision must be a full 40-hex commit SHA, got ${JSON.stringify(sha)}`)
  const count = yaml.split(FLOATING).length - 1
  if (count !== 1) throw new Error(`expected exactly one ${FLOATING} reference in ${WORKFLOW_PATH}, found ${count}`)
  return yaml.replace(FLOATING, FLOATING.replace("@main", `@${sha}`))
}

/** Every `uses:` reference to the review action in a workflow. */
export const actionReferences = (yaml) =>
  [...yaml.matchAll(/^\s*-?\s*uses:\s*(\S*apps\/review\/action@\S+)/gm)].map((match) => match[1])

export const isImmutablePin = (reference) => PIN.test(reference)

const git = (args, options = {}) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim()

/**
 * Build the tagged release commit for `revision` in `cwd`. Returns the tag, the
 * pinned revision and the release commit.
 */
export const cutReviewRelease = ({ version, revision = "origin/main", cwd = process.cwd() }) => {
  const tag = reviewTag(version)
  const run = (args, options) => git(["-C", cwd, ...args], options)
  const sha = run(["rev-parse", "--verify", `${revision}^{commit}`])
  if (run(["tag", "--list", tag]) !== "") throw new Error(`tag ${tag} already exists`)
  const pinned = pinWorkflow(run(["show", `${sha}:${WORKFLOW_PATH}`]), sha)
  const scratch = mkdtempSync(join(tmpdir(), "review-release-"))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") }
    run(["read-tree", sha], { env })
    const blob = run(["hash-object", "-w", "--stdin"], { env, input: pinned })
    run(["update-index", "--cacheinfo", `100644,${blob},${WORKFLOW_PATH}`], { env })
    const tree = run(["write-tree"], { env })
    const commit = run(["commit-tree", tree, "-p", sha, "-m", `🔖 release: ${tag} pins the review action at ${sha}`], {
      env: { ...env, GIT_AUTHOR_NAME: "review-release", GIT_AUTHOR_EMAIL: "review-release@localhost", GIT_COMMITTER_NAME: "review-release", GIT_COMMITTER_EMAIL: "review-release@localhost" },
    })
    const changed = run(["diff", "--name-only", sha, commit]).split("\n").filter(Boolean)
    if (changed.length !== 1 || changed[0] !== WORKFLOW_PATH) {
      throw new Error(`release commit must differ from ${sha} only in ${WORKFLOW_PATH}; changed: ${changed.join(", ")}`)
    }
    run(["tag", "-a", tag, commit, "-m", `review action release ${tag} (action pinned at ${sha})`])
    return { tag, sha, commit }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export const publishCommand = (tag) => `git push origin refs/tags/${tag}`

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const [version, revision] = process.argv.slice(2)
  if (version === undefined) {
    console.error("usage: node apps/review/scripts/review-release.mjs <version> [<revision>]")
    process.exit(2)
  }
  const { tag, sha, commit } = cutReviewRelease({ version, revision })
  console.log(`tagged ${tag} at ${commit} (action pinned at ${sha})`)
  console.log(`to publish, run: ${publishCommand(tag)}`)
  console.log(`then register the exact ref: smithersai/smithers/${WORKFLOW_PATH}@refs/tags/${tag}`)
}
