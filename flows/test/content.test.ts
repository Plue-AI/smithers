import assert from "node:assert/strict"
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { changelogNarrative, checkContent, renderCard } from "../release-support/content.ts"
import { contentInput, releaseInput } from "../release-support/input.ts"
import { commandRunner, inside } from "../release-support/io.ts"
import { operations } from "../release-support/operations.ts"
import { analysis, brief, draft, evidence, repository, review } from "./fixtures.ts"

test("inputs default to previews, reject typoed publication flags and bound revision plans", () => {
  assert.equal(contentInput({}, evidence.version).dryRun, true)
  assert.equal(releaseInput({}, evidence.version).dryRun, true)
  assert.throws(() => contentInput({ dryrun: false }, evidence.version), /Unknown input/)
  assert.throws(() => contentInput({ maxRevisions: 20 }, evidence.version), (error: unknown) => {
    const message = (error as Error).message
    return message.split("maxRevisions must be an integer from 0 to 3").length === 2 &&
      !message.includes("Expected a value")
  })
  assert.throws(() => contentInput({ minScore: 2 }, evidence.version), /minScore must be between 0 and 1/)
  assert.throws(() => contentInput({ maxTweets: 0 }, evidence.version), /maxTweets must be an integer from 1 to 12/)
  assert.throws(
    () => contentInput({ maxTweetChars: 281 }, evidence.version),
    /maxTweetChars must be an integer from 1 to 280/
  )
  assert.throws(() => releaseInput({ version: "1.0.0-rc.01" }, evidence.version), /leading zeros/)
  assert.throws(() => releaseInput({ version: "v1.0.0" }, evidence.version), /semver without a v prefix/)
  assert.throws(() => contentInput({ postX: true }, evidence.version), /requires/)
  assert.throws(() => releaseInput({ version: "../../escape" }, evidence.version), /RegExp|semver/)
  assert.equal(releaseInput({ bump: "patch" }, "0.35.0").version, "0.35.1")
  assert.equal(releaseInput({ bump: "minor" }, "0.35.0").version, "0.36.0")
  assert.equal(releaseInput({ bump: "major" }, "0.35.0").version, "1.0.0")
  assert.equal(releaseInput({ bump: "patch" }, "1.0.0-rc.0").version, "1.0.0")
  assert.throws(() => releaseInput({ version: "1.0.0", bump: "patch" }, "0.35.0"), /not both/)
})

test("quality checks independently reject invented evidence, missing channels and overlong tweets", () => {
  const input = contentInput({}, evidence.version)
  assert.equal(checkContent(input, evidence, analysis, draft, review).passed, true)
  const bad = { ...analysis, claims: [{ ...analysis.claims[0]!, sources: ["invented.ts"] }] }
  assert.equal(checkContent(input, evidence, bad, draft, review).passed, false)
  assert.equal(
    checkContent(input, evidence, analysis, { ...draft, changelog: { text: "", claimIds: [] } }, review).passed,
    false
  )
  assert.equal(
    checkContent(input, evidence, analysis, {
      ...draft,
      thread: { tweets: [{ ...draft.changelog, text: "漢".repeat(141) }] }
    }, review).passed,
    false
  )
  assert.match(renderCard("1.0.0", { ...analysis, title: "<script>&" }), /&lt;script&gt;&amp;/)
})

test("approval binds preview bytes and each destination; retries preserve user edits", async (test) => {
  const fixture = await repository(test)
  const ops = operations({ root: fixture.root })
  const input = contentInput({ dryRun: false, publish: true }, fixture.evidence.version)
  const artifact = await ops.preview({ input, evidence: fixture.evidence, analysis, brief, draft, review })
  await assert.rejects(ops.publishFiles(artifact), /ENOENT|approval/)
  await ops.recordApproval(artifact)
  const files = await ops.publishFiles(artifact)
  assert.equal(files.length, 5)
  assert.deepEqual(await ops.publishFiles(artifact), files)
  await writeFile(join(fixture.root, files[0]!), "User edited the changelog\n")
  await assert.rejects(ops.publishFiles(artifact), /Destination changed/)
  assert.equal(await readFile(join(fixture.root, files[0]!), "utf8"), "User edited the changelog\n")
  await writeFile(join(fixture.root, artifact.directory, "thread.md"), "tampered")
  await assert.rejects(ops.verifyArtifact(artifact, true), /artifact changed/)
})

test("dry-run content cannot be promoted using an approval marker", async (test) => {
  const fixture = await repository(test)
  const ops = operations({ root: fixture.root })
  const input = contentInput({ publish: true }, fixture.evidence.version)
  const artifact = await ops.preview({ input, evidence: fixture.evidence, analysis, brief, draft, review })
  await ops.recordApproval(artifact)
  await assert.rejects(ops.publishFiles(artifact), /matching human approval/)
  await assert.rejects(access(join(fixture.root, `apps/site/src/content/docs/changelogs/${input.version}.mdx`)))
})

test("an uncertain X acknowledgement is never retried automatically", async (test) => {
  const fixture = await repository(test)
  let posts = 0
  const ops = operations({
    root: fixture.root,
    tweet: async () => {
      posts++
      throw new Error("lost acknowledgement")
    }
  })
  const input = contentInput({ dryRun: false, publish: true, postX: true }, fixture.evidence.version)
  const artifact = await ops.preview({ input, evidence: fixture.evidence, analysis, brief, draft, review })
  await ops.recordApproval(artifact)
  await assert.rejects(ops.postThread(artifact), /lost acknowledgement/)
  await assert.rejects(ops.postThread(artifact), /uncertain outcome/)
  assert.equal(posts, 1)
})

test("artifact writes reject traversal and symlink escape", async (test) => {
  const fixture = await repository(test)
  await assert.rejects(inside(fixture.root, "../outside"), /Unsafe/)
  await mkdir(join(fixture.root, ".flows"))
  await symlink("/tmp", join(fixture.root, ".flows/escape"))
  await assert.rejects(inside(fixture.root, ".flows/escape/should-not-write"), /Symlink escapes/)
})

test("the narrative update retains generated commit history and older releases", () => {
  const text =
    "# Changelog\n\n## 1.0.0 (2026-09-06)\n\nOld narrative\n\n<!-- commits:1.0.0 -->\n- a commit\n<!-- /commits:1.0.0 -->\n\n## 0.35.0 (2026-08-01)\n\nEarlier release\n"
  const updated = changelogNarrative(text, "1.0.0", "2026-09-07", "New narrative")
  assert.ok(updated.includes("New narrative"))
  assert.ok(!updated.includes("Old narrative"))
  assert.ok(updated.endsWith(text.slice(text.indexOf("<!-- commits:1.0.0 -->"))))
})

test("optional content commit includes only approved files and survives a repeated call", async (test) => {
  const fixture = await repository(test)
  const ops = operations({ root: fixture.root })
  const input = contentInput({ dryRun: false, publish: true, autoCommit: true }, fixture.evidence.version)
  const artifact = await ops.preview({ input, evidence: fixture.evidence, analysis, brief, draft, review })
  await ops.recordApproval(artifact)
  const files = await ops.publishFiles(artifact)
  await writeFile(join(fixture.root, "README.md"), "Unrelated work\n")
  await ops.commitFiles(artifact, files)
  assert.deepEqual(
    fixture.git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").sort(),
    [...files].sort()
  )
  assert.equal(fixture.git("diff", "--name-only"), "README.md")
  const sha = fixture.git("rev-parse", "HEAD")
  await ops.commitFiles(artifact, files)
  assert.equal(fixture.git("rev-parse", "HEAD"), sha)
})

test("content commit refuses an existing staged change", async (test) => {
  const fixture = await repository(test)
  const ops = operations({ root: fixture.root })
  const input = contentInput({ dryRun: false, publish: true, autoCommit: true }, fixture.evidence.version)
  const artifact = await ops.preview({ input, evidence: fixture.evidence, analysis, brief, draft, review })
  await ops.recordApproval(artifact)
  const files = await ops.publishFiles(artifact)
  await writeFile(join(fixture.root, "README.md"), "Already staged work\n")
  fixture.git("add", "README.md")
  await assert.rejects(ops.commitFiles(artifact, files), /Index contains staged/)
  assert.equal(fixture.git("diff", "--cached", "--name-only"), "README.md")
})

test("direct publication cannot bypass the feature documentation gate", async (test) => {
  const fixture = await repository(test)
  const ops = operations({
    root: fixture.root,
    run: async () => {
      throw new Error("must stop before commands")
    }
  })
  const input = releaseInput({ phase: "publish", requireContentApproval: false }, fixture.evidence.version)
  await assert.rejects(
    ops.validate({
      input,
      evidence: fixture.evidence,
      audit: { passed: false, missing: ["migration guide"], explanation: "Missing docs" }
    }),
    /Feature documentation gate failed/
  )
})

test("command failures retain stdout registry codes and redact credentials from both streams", async (test) => {
  const fixture = await repository(test)
  await assert.rejects(
    commandRunner(fixture.root)(process.execPath, [
      "-e",
      "process.stdout.write(\"ERR_PNPM_FETCH_404 \" + process.env.RELEASE_TEST_SECRET); process.stderr.write(\"diagnostic \" + process.env.RELEASE_TEST_SECRET); process.exitCode = 1"
    ], {
      env: { RELEASE_TEST_SECRET: "fake-secret-for-redaction-test" }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /ERR_PNPM_FETCH_404/)
      assert.match(error.message, /diagnostic <redacted>/)
      assert.ok(!error.message.includes("fake-secret-for-redaction-test"))
      return true
    }
  )
})
