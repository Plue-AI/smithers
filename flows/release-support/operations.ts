import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { readWorkspaceManifests } from "../../scripts/pack-release.mjs"
import {
  candidateIntegrity,
  preflight,
  publishCandidate,
  verifyLocalCandidate
} from "../../scripts/publish-release.mjs"
import { releaseGateArgs, releaseGateSetForHost } from "../../scripts/release-gates.mjs"
import {
  readVersionedManifests,
  retarget,
  retargetSource,
  versionedSources
} from "../../scripts/set-release-version.mjs"
import { chooseTemplate } from "../release-content/jev-template.ts"
import * as Content from "../release-content/workflow.ts"
import * as Release from "../release/workflow.ts"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import { changelogNarrative, checkContent, digest, renderCard } from "./content.ts"
import { atomicWrite, commandRunner, inside, json, maybeRead, postTweet, type RunCommand } from "./io.ts"
import { recordUi } from "./recording.ts"
import {
  type Analysis,
  Artifact,
  type Brief,
  type Candidate,
  type ContentInput,
  type DocumentationAudit,
  type Draft,
  type Evidence,
  GateEvidence,
  ReleaseError,
  type ReleaseInput,
  type Review
} from "./schema.ts"

interface Write {
  readonly path: string
  readonly text: string
  readonly before: string | null
  readonly encoding?: "base64"
}
const bytesOf = (entry: Write) =>
  entry.encoding === "base64" ? Buffer.from(entry.text, "base64") : Buffer.from(entry.text)
interface Bundle {
  readonly input: ContentInput
  readonly evidence: Evidence
  readonly analysis: Analysis
  readonly brief: typeof Brief.Type
  readonly draft: Draft
  readonly review: Review
  readonly writes: ReadonlyArray<Write>
}
type Manifest = Parameters<typeof candidateIntegrity>[0]

/**
 * The release inventory the checks step runs and the exceptions it reports.
 * Defaults to `scripts/release-gates.mjs`; tests inject a mutated copy to
 * prove the receipt without running the real gates.
 */
export type ReleaseGateSet = ReturnType<typeof releaseGateSetForHost>

export interface Options {
  readonly root: string
  readonly run?: RunCommand
  readonly tweet?: typeof postTweet
  readonly reviewDirectory?: string
  readonly gates?: ReleaseGateSet
}

/** Copy the receipt as gate-evidence.json spells it so later mutations cannot change it. */
const gateReceipt = (gates: ReleaseGateSet): GateEvidence => ({
  ran: gates.inventory.map((gate) => gate.name),
  exceptions: gates.exceptions.map(({ name, command, reason }) => ({ name, command, reason }))
})

/** Run gates serially; a failed command produces no receipt and stops the inventory. */
export const runReleaseGates = async (
  run: RunCommand,
  gates: ReleaseGateSet = releaseGateSetForHost(),
  signal?: AbortSignal
): Promise<GateEvidence> => {
  for (const gate of gates.inventory) {
    await run("pnpm", ["exec", "smthrs", ...releaseGateArgs(gate)], signal ? { signal } : {})
  }
  return gateReceipt(gates)
}

/** All I/O lives in registered action implementations, never in flow planning. */
export const operations = (
  { root, run = commandRunner(root), tweet = postTweet, reviewDirectory, gates = releaseGateSetForHost() }: Options
) => {
  const git = (args: ReadonlyArray<string>, signal?: AbortSignal) => run("git", args, signal ? { signal } : {})
  const head = async (signal?: AbortSignal) => (await git(["rev-parse", "HEAD"], signal)).trim()
  const assertHead = async (expected: string, signal?: AbortSignal) => {
    if (await head(signal) !== expected) throw new Error("Source HEAD changed; start a new release run")
  }
  const assertCleanMain = async (signal?: AbortSignal) => {
    if ((await git(["branch", "--show-current"], signal)).trim() !== "main") {
      throw new Error("Release operations require main")
    }
    if ((await git(["status", "--porcelain", "--untracked-files=all"], signal)).trim()) {
      throw new Error("Release operations require a clean working tree, including untracked files")
    }
  }
  const writeJson = (path: string, value: unknown) => atomicWrite(root, path, JSON.stringify(value, null, 2) + "\n")
  const readJson = async <A>(path: string): Promise<A> => json<A>(await readFile(await inside(root, path), "utf8"))
  const showReview = async (prompt: string) => {
    if (reviewDirectory) await writeJson(`${reviewDirectory}/review.json`, { prompt })
  }

  const collect = async (
    { version, from }: { version: string; from: string },
    signal?: AbortSignal
  ): Promise<Evidence> => {
    const sourceSha = await head(signal)
    let anchor = from
    if (anchor === "auto") {
      // The published CLI is the old workflow's source of truth. Fail closed
      // when the registry cannot answer; do not silently switch to a local tag.
      const published = json<unknown>(
        await run("pnpm", ["view", "smthrs", "version", "--json"], signal ? { signal } : {})
      )
      if (typeof published !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(published)) {
        throw new Error("npm did not return the last published smthrs version")
      }
      anchor = `v${published}`
    }
    const fromSha = (await git(["rev-parse", "--verify", "--end-of-options", `${anchor}^{commit}`], signal)).trim()
    await git(["merge-base", "--is-ancestor", fromSha, sourceSha], signal)
    const commits = await git(["log", "--format=%H %s", `${fromSha}..${sourceSha}`], signal)
    const changes = await git(["diff", "--stat", fromSha, sourceSha, "--"], signal)
    const changed = (await git(["diff", "--name-only", fromSha, sourceSha, "--"], signal)).trim().split("\n").filter(
      Boolean
    )
    const files = (await git(["ls-tree", "-r", "--name-only", sourceSha], signal)).trim().split("\n")
    const candidates = [
      ...new Set([
        "README.md",
        `apps/site/docs/changelogs/${version}.mdx`,
        ...changed.filter((path) => /(?:\/docs\/.*\.(?:md|mdx)|\/src\/.*\.ts)$/.test(path)),
        ...files.filter((path) => /^(?:packages\/.*\/docs\/|apps\/site\/docs\/)/.test(path) && /\.(md|mdx)$/.test(path))
      ])
    ].filter((path) => files.includes(path))
    const documents: Array<string> = []
    const sources = commits.split("\n").filter(Boolean).map((line) => line.split(" ")[0]!)
    let remaining = 220_000
    for (const path of candidates) {
      if (remaining <= 0) break
      const text = await git(["show", `${sourceSha}:${path}`], signal)
      const excerpt = text.slice(0, Math.min(12_000, remaining))
      documents.push(
        `\n--- ${path} ---\n${excerpt}${
          excerpt.length < text.length ? "\n[excerpt ends; remaining file not supplied]" : ""
        }`
      )
      sources.push(path)
      remaining -= excerpt.length
    }
    const manifest = json<{ version: string }>(
      await git(["show", `${sourceSha}:packages/smithers/package.json`], signal)
    )
    return {
      version,
      currentVersion: manifest.version,
      sourceSha,
      from: fromSha,
      date: (await git(["show", "-s", "--format=%cs", sourceSha], signal)).trim(),
      commits,
      changes,
      documents: documents.join("\n"),
      sources,
      recordings: []
    }
  }

  const verifyArtifact = async (artifact: Artifact, approved = false): Promise<Bundle> => {
    if (!artifact.directory.startsWith(".flows/releases/content/")) {
      throw new Error("Content artifact must be under .flows/releases/content")
    }
    const descriptor = Schema.decodeUnknownSync(Artifact)(await readJson(`${artifact.directory}/artifact.json`))
    if (JSON.stringify(descriptor) !== JSON.stringify(artifact)) throw new Error("Content artifact descriptor changed")
    for (const file of artifact.files) {
      if (file.path.includes("/") || file.path.includes("\\")) throw new Error("Invalid artifact filename")
      if (digest(await readFile(await inside(root, `${artifact.directory}/${file.path}`))) !== file.digest) {
        throw new Error(`Content artifact changed: ${file.path}`)
      }
    }
    const bundle = await readJson<Bundle>(`${artifact.directory}/bundle.json`)
    if (
      digest(JSON.stringify(bundle)) !== artifact.digest || bundle.evidence.sourceSha !== artifact.sourceSha ||
      bundle.input.version !== artifact.version
    ) throw new Error("Content approval does not match this bundle")
    const checked = checkContent(bundle.input, bundle.evidence, bundle.analysis, bundle.draft, bundle.review)
    if (!checked.passed) throw new Error(`Content quality failed: ${checked.feedback.join("; ")}`)
    if (approved) {
      const approval = await readJson<{ approved: boolean; digest: string; artifactDigest: string }>(
        `${artifact.directory}/approval.json`
      )
      if (
        approval.approved !== true || approval.digest !== artifact.digest ||
        approval.artifactDigest !== digest(JSON.stringify(artifact)) || bundle.input.dryRun
      ) throw new Error("Content has no matching human approval")
    }
    return bundle
  }

  const preview = async (value: Omit<Bundle, "writes">): Promise<Artifact> => {
    const { input, evidence, analysis, draft } = value
    const writes: Array<Write> = []
    const add = async (path: string, value: string | Buffer) => {
      let before: Buffer | undefined
      try {
        before = await readFile(await inside(root, path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      writes.push({
        path,
        text: typeof value === "string" ? value : value.toString("base64"),
        before: before === undefined ? null : digest(before),
        ...(typeof value === "string" ? {} : { encoding: "base64" as const })
      })
    }
    if (input.channels.changelog) {
      const previous = await maybeRead(await inside(root, "CHANGELOG.md")) ?? "# Changelog\n"
      await add("CHANGELOG.md", changelogNarrative(previous, input.version, evidence.date, draft.changelog.text))
      const source = `apps/site/docs/changelogs/${input.version}.mdx`
      const destination = `apps/site/src/content/docs/changelogs/${input.version}.mdx`
      const body = `---\ntitle: ${JSON.stringify(input.version)}\ndescription: ${
        JSON.stringify(analysis.summary)
      }\n---\n\n${draft.changelog.text.trim()}\n`
      // The RC has a canonical support-docs source. Respect its projection
      // instead of editing only the generated page and creating drift.
      if (await maybeRead(await inside(root, source)) !== undefined) {
        await add(source, body)
        await add(
          destination,
          body.replace(
            /^---\n/,
            `---\n# GENERATED by apps/site/scripts/sync-support-docs.mjs. Edit ${source}.\neditUrl: https://github.com/smithersai/smithers/edit/main/${source}\n`
          )
        )
      } else await add(destination, body)
    }
    if (input.channels.blog) {
      await add(
        `apps/site/src/content/docs/releases/${input.version}.md`,
        `---\ntitle: ${JSON.stringify(analysis.title)}\ndescription: ${
          JSON.stringify(analysis.summary)
        }\n---\n\n${draft.blog.text.trim()}\n`
      )
    }
    if (input.channels.thread) {
      await add(
        `marketing/${input.version}/thread.md`,
        draft.thread.tweets.map((entry, index) => `${index + 1}. ${entry.text}`).join("\n\n") + "\n"
      )
    }
    if (input.channels.media) {
      await add(
        `apps/site/public/media/releases/${input.version}/release-card.svg`,
        renderCard(input.version, analysis)
      )
    }
    const recordingFiles: Record<string, Buffer> = {}
    for (const [index, asset] of evidence.recordings.entries()) {
      const bytes = await readFile(await inside(root, asset.path))
      if (digest(bytes) !== asset.digest) throw new Error(`Recording changed: ${asset.path}`)
      const name = `recording-${index}.${asset.path.endsWith(".webm") ? "webm" : "png"}`
      recordingFiles[name] = bytes
      await add(`apps/site/public/media/releases/${input.version}/${name}`, bytes)
    }
    const bundle: Bundle = { ...value, writes }
    const hash = digest(JSON.stringify(bundle))
    const directory = `.flows/releases/content/${input.version}/${hash}`
    const contents: Record<string, string | Buffer> = {
      "bundle.json": JSON.stringify(bundle, null, 2) + "\n",
      "changelog.md": draft.changelog.text + "\n",
      "blog.md": draft.blog.text + "\n",
      "thread.md": draft.thread.tweets.map((entry, index) => `${index + 1}. ${entry.text}`).join("\n\n") + "\n",
      ...recordingFiles
    }
    if (input.channels.media) contents["release-card.svg"] = renderCard(input.version, analysis)
    const files: Array<Artifact["files"][number]> = []
    for (const [path, text] of Object.entries(contents)) {
      await atomicWrite(root, `${directory}/${path}`, text)
      files.push({ path, digest: digest(text) })
    }
    const artifact: Artifact = {
      directory,
      digest: hash,
      version: input.version,
      sourceSha: evidence.sourceSha,
      files,
      approvalPrompt:
        `Approve release content ${input.version} from ${evidence.sourceSha}?\nReview ${directory}/bundle.json, changelog.md, blog.md, thread.md, any SVG card, and recording frames/video.\nBundle SHA-256: ${hash}\nScore: ${value.review.score}\n${
          input.publish
            ? `Write these exact files: ${writes.map((entry) => entry.path).join(", ")}.`
            : "Record content approval only."
        }\n${input.autoCommit ? "Commit only these files on main." : "Leave written files uncommitted."}\n${
          input.publish && input.postX
            ? `Post ${draft.thread.tweets.length} tweets to X with the configured account.`
            : "X publication is disabled."
        }`
    }
    await writeJson(`${directory}/artifact.json`, artifact)
    if (!input.dryRun) await showReview(artifact.approvalPrompt)
    return artifact
  }

  const recordApproval = async (artifact: Artifact, signal?: AbortSignal): Promise<Artifact> => {
    await verifyArtifact(artifact)
    await assertHead(artifact.sourceSha, signal)
    await writeJson(`${artifact.directory}/approval.json`, {
      approved: true,
      digest: artifact.digest,
      artifactDigest: digest(JSON.stringify(artifact)),
      sourceSha: artifact.sourceSha
    })
    return artifact
  }

  const publishFiles = async (artifact: Artifact, signal?: AbortSignal): Promise<ReadonlyArray<string>> => {
    const bundle = await verifyArtifact(artifact, true)
    if (!bundle.input.publish) throw new Error("Content publication was not requested")
    await assertHead(artifact.sourceSha, signal)
    // Preflight every destination before writing any. A retry accepts its own
    // exact previous write, but cannot overwrite an intervening user edit.
    for (const entry of bundle.writes) {
      let current: Buffer | undefined
      try {
        current = await readFile(await inside(root, entry.path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const actual = current === undefined ? null : digest(current)
      if (actual !== entry.before && actual !== digest(bytesOf(entry))) {
        throw new Error(`Destination changed after preview: ${entry.path}`)
      }
    }
    for (const entry of bundle.writes) await atomicWrite(root, entry.path, bytesOf(entry))
    return bundle.writes.map((entry) => entry.path)
  }

  const commitFiles = async (
    artifact: Artifact,
    files: ReadonlyArray<string>,
    signal?: AbortSignal
  ): Promise<ReadonlyArray<string>> => {
    const bundle = await verifyArtifact(artifact, true)
    if (!bundle.input.publish || !bundle.input.autoCommit) throw new Error("Content commit was not requested")
    if (JSON.stringify(files) !== JSON.stringify(bundle.writes.map((entry) => entry.path))) {
      throw new Error("Commit file set differs from the approved write set")
    }
    if ((await git(["branch", "--show-current"], signal)).trim() !== "main") {
      throw new Error("Content commits require main")
    }
    const message = `docs: release content ${artifact.version}\n\nRelease-Content-Digest: ${artifact.digest}`
    const currentHead = await head(signal)
    if (currentHead !== artifact.sourceSha) {
      const subject = (await git(["log", "-1", "--format=%B"], signal)).trim()
      const parent = (await git(["rev-parse", "HEAD^"], signal)).trim()
      if (subject === message && parent === artifact.sourceSha) {
        await writeJson(`${artifact.directory}/commit.json`, { digest: artifact.digest, sha: currentHead, files })
        return files
      }
      throw new Error("Source changed before content commit")
    }
    if ((await git(["diff", "--cached", "--name-only"], signal)).trim()) {
      throw new Error("Index contains staged changes; refusing to include them in the content commit")
    }
    for (const entry of bundle.writes) {
      if (digest(await readFile(await inside(root, entry.path))) !== digest(bytesOf(entry))) {
        throw new Error(`Content changed before commit: ${entry.path}`)
      }
    }
    if (!files.length) return files
    await git(["add", "--", ...files], signal)
    await git(["commit", "--only", "-m", message, "--", ...files], signal)
    await writeJson(`${artifact.directory}/commit.json`, { digest: artifact.digest, sha: await head(signal), files })
    return files
  }

  const assertContentHead = async (artifact: Artifact, signal?: AbortSignal) => {
    const current = await head(signal)
    if (current === artifact.sourceSha) return
    const receipt = await readJson<{ digest: string; sha: string }>(`${artifact.directory}/commit.json`)
    if (receipt.digest !== artifact.digest || receipt.sha !== current) {
      throw new Error("Source changed after content approval")
    }
  }

  const postThread = async (artifact: Artifact, signal?: AbortSignal): Promise<ReadonlyArray<string>> => {
    const bundle = await verifyArtifact(artifact, true)
    if (!bundle.input.publish || !bundle.input.postX || !bundle.input.channels.thread) {
      throw new Error("X publication was not requested")
    }
    await assertContentHead(artifact, signal)
    const receiptPath = `${artifact.directory}/x-receipt.json`
    const stored = await maybeRead(await inside(root, receiptPath))
    const receipt = stored
      ? json<{ digest: string; ids: Array<string>; pending: number | null }>(stored)
      : { digest: artifact.digest, ids: [], pending: null }
    if (receipt.digest !== artifact.digest) throw new Error("X receipt belongs to different content")
    // X does not supply a publish idempotency key. An uncertain acknowledgement
    // must be reconciled by the operator; retrying it could duplicate a post.
    if (receipt.pending !== null) {
      throw new Error(
        `Tweet ${
          receipt.pending + 1
        } has an uncertain outcome. Reconcile x-receipt.json before resuming; no tweet was retried.`
      )
    }
    for (let index = receipt.ids.length; index < bundle.draft.thread.tweets.length; index++) {
      receipt.pending = index
      await writeJson(receiptPath, receipt)
      const id = await tweet(bundle.draft.thread.tweets[index]!.text, receipt.ids.at(-1), signal)
      receipt.ids.push(id)
      receipt.pending = null
      await writeJson(receiptPath, receipt)
      if (index + 1 < bundle.draft.thread.tweets.length) await delay(3000, undefined, signal ? { signal } : {})
    }
    return receipt.ids
  }

  const approvedContent = async (input: ReleaseInput, signal?: AbortSignal) => {
    if (!input.contentArtifact) {
      if (input.requireContentApproval) throw new Error("Pass contentArtifact from an approved release-content run")
      return
    }
    const artifact = Schema.decodeUnknownSync(Artifact)(await readJson(`${input.contentArtifact}/artifact.json`))
    const bundle = await verifyArtifact(artifact, true)
    if (artifact.version !== input.version) throw new Error("Approved content is for a different version")
    await git(["merge-base", "--is-ancestor", artifact.sourceSha, "HEAD"], signal)
    const changed = (await git(["diff", "--name-only", artifact.sourceSha, "HEAD", "--"], signal)).trim().split("\n")
      .filter(Boolean)
    const allowed = new Set([
      ...bundle.writes.map((entry) => entry.path),
      "CHANGELOG.md",
      "pnpm-lock.yaml",
      "bun.lock",
      "apps/site/public/llms.txt",
      "apps/site/public/llms-full.txt"
    ])
    const manifests = readVersionedManifests(root)
    const names = new Set(manifests.map((entry) => entry.manifest.name))
    for (const path of changed) {
      if (allowed.has(path)) continue
      const manifest = manifests.find((entry) => entry.path === join(root, path))
      const source = versionedSources.find((entry) => entry.path === path)
      if (manifest) {
        const before = json<Record<string, unknown>>(await git(["show", `${artifact.sourceSha}:${path}`], signal))
        const expected = retarget(before, input.version, names, {
          registryDependencies: "registryDependencies" in manifest && manifest.registryDependencies === true
        })
        if (JSON.stringify(manifest.manifest) === JSON.stringify(expected)) continue
      } else if (source) {
        const before = await git(["show", `${artifact.sourceSha}:${path}`], signal)
        if (await readFile(await inside(root, path), "utf8") === retargetSource(before, input.version, source)) continue
      }
      throw new Error(`Source changed since content approval: ${path}`)
    }
    return artifact
  }

  const preparePlan = async (
    { input, evidence, audit }: { input: ReleaseInput; evidence: Evidence; audit: typeof DocumentationAudit.Type },
    signal?: AbortSignal
  ) => {
    await assertHead(evidence.sourceSha, signal)
    if (!audit.passed || audit.missing.length) {
      throw new Error(`Feature documentation gate failed: ${[...audit.missing, audit.explanation].join("\n")}`)
    }
    await approvedContent(input, signal)
    const directory = `.flows/releases/preparation/${input.version}/${evidence.sourceSha}`
    const plan = { input, evidence, audit }
    await writeJson(`${directory}/plan.json`, plan)
    const result = {
      directory,
      approvalPrompt:
        `Prepare Smithers ${input.version} from ${evidence.currentVersion} at ${evidence.sourceSha}?\nReview ${directory}/plan.json.\nThis updates workspace versions, version constants, pnpm-lock.yaml, bun.lock and the generated CHANGELOG.md commit section.\n${
          input.version.split(".")[0] !== evidence.currentVersion.split(".")[0]
            ? "This is a major-version change.\n"
            : ""
        }The resulting changes stay in the working tree for review and commit.`
    }
    if (!input.dryRun) await showReview(result.approvalPrompt)
    return result
  }

  const writePreparation = async (
    { input, evidence, directory }: { input: ReleaseInput; evidence: Evidence; directory: string },
    signal?: AbortSignal
  ) => {
    if (input.dryRun || input.phase !== "prepare") throw new Error("Release preparation was not requested")
    await assertHead(evidence.sourceSha, signal)
    await assertCleanMain(signal)
    const stored = await readJson<{ input: ReleaseInput; evidence: Evidence }>(`${directory}/plan.json`)
    if (JSON.stringify(stored.input) !== JSON.stringify(input) || stored.evidence.sourceSha !== evidence.sourceSha) {
      throw new Error("Release preparation plan changed after approval")
    }
    const opts = signal ? { signal } : {}
    await run(process.execPath, ["scripts/set-release-version.mjs", input.version], opts)
    await run(
      process.execPath,
      ["scripts/generate-changelog.mjs", "--version", input.version, "--from", evidence.from],
      opts
    )
    await run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], opts)
    const lock = await inside(root, "bun.lock")
    const previous = await maybeRead(lock)
    if (previous !== undefined) {
      await unlink(lock)
      try {
        await run("bun", ["install", "--lockfile-only", "--ignore-scripts"], opts)
      } catch (error) {
        await atomicWrite(root, "bun.lock", previous)
        throw error
      }
    }
    await run(process.execPath, ["scripts/set-release-version.mjs", "--check", input.version], opts)
    await run(process.execPath, [
      "scripts/generate-changelog.mjs",
      "--check",
      "--version",
      input.version,
      "--from",
      evidence.from
    ], opts)
    return { status: "prepared" as const, version: input.version, artifact: directory, published: [] }
  }

  const validate = async (
    { input, evidence, audit }: { input: ReleaseInput; evidence: Evidence; audit: typeof DocumentationAudit.Type },
    signal?: AbortSignal
  ): Promise<Evidence> => {
    if (!audit.passed || audit.missing.length) {
      throw new Error(`Feature documentation gate failed: ${[...audit.missing, audit.explanation].join("\n")}`)
    }
    await assertHead(evidence.sourceSha, signal)
    await assertCleanMain(signal)
    await approvedContent(input, signal)
    if (evidence.currentVersion !== input.version) {
      throw new Error("Prepare and commit the requested version before building its release candidate")
    }
    const opts = signal ? { signal } : {}
    await run(process.execPath, ["scripts/set-release-version.mjs", "--check", input.version], opts)
    await run(process.execPath, [
      "scripts/generate-changelog.mjs",
      "--check",
      "--version",
      input.version,
      "--from",
      evidence.from
    ], opts)
    return evidence
  }

  const checks = async (evidence: Evidence, signal?: AbortSignal): Promise<Evidence> => {
    await assertHead(evidence.sourceSha, signal)
    // Smithers targets are the gate. No GitHub YAML is parsed or dispatched.
    // The inventory is release.yml's publish job, proved in both directions by
    // release-gates.test.mjs. The host partition runs every portable gate.
    // A declared platform exception is never run or counted: it goes into
    // the receipt, which pack files with the candidate and the approval prompt
    // repeats, so the operator sees what this run did not prove.
    const receipt = await runReleaseGates(run, gates, signal)
    await assertCleanMain(signal)
    return { ...evidence, gates: receipt }
  }

  const build = async (evidence: Evidence, signal?: AbortSignal): Promise<Evidence> => {
    await assertHead(evidence.sourceSha, signal)
    await run(process.execPath, ["scripts/build-release.mjs"], signal ? { signal } : {})
    await run(process.execPath, ["scripts/check-api-baseline.mjs"], signal ? { signal } : {})
    return evidence
  }

  const pack = async (evidence: Evidence, signal?: AbortSignal): Promise<Candidate> => {
    if (evidence.gates === undefined) {
      throw new Error("Release checks did not run; evidence carries no gate receipt to pack")
    }
    await assertHead(evidence.sourceSha, signal)
    await assertCleanMain(signal)
    const directory = `.flows/releases/npm/${evidence.version}/${evidence.sourceSha}/${randomUUID()}`
    await mkdir(await inside(root, directory), { recursive: true })
    await run(process.execPath, ["scripts/pack-release.mjs", directory], {
      env: { RELEASE_TAG: `v${evidence.version}` },
      ...(signal ? { signal } : {})
    })
    const manifest = await readJson<Manifest>(`${directory}/release-manifest.json`)
    await verifyLocalCandidate(await inside(root, directory), manifest)
    await writeJson(`${directory}/gate-evidence.json`, evidence.gates)
    return {
      directory,
      digest: candidateIntegrity(manifest),
      version: evidence.version,
      sourceSha: evidence.sourceSha,
      packageCount: manifest.packages.length,
      approvalPrompt: ""
    }
  }

  const manifestFor = async (candidate: Candidate): Promise<Manifest> => {
    if (!candidate.directory.startsWith(".flows/releases/npm/")) {
      throw new Error("Candidate must be under .flows/releases/npm")
    }
    const manifest = await readJson<Manifest>(`${candidate.directory}/release-manifest.json`)
    if (candidateIntegrity(manifest) !== candidate.digest || manifest.source.sha !== candidate.sourceSha) {
      throw new Error("Candidate changed after it was tested")
    }
    if (
      candidate.packageCount !== manifest.packages.length ||
      manifest.packages.some((entry: { version: string }) => entry.version !== candidate.version)
    ) throw new Error("Candidate version/count does not match its manifest")
    await verifyLocalCandidate(await inside(root, candidate.directory), manifest)
    const expected = [...readWorkspaceManifests(root).values()].map((pkg) => pkg.name).sort()
    if (
      JSON.stringify(manifest.packages.map((pkg: { name: string }) => pkg.name).sort()) !== JSON.stringify(expected)
    ) throw new Error("Candidate does not contain the complete release roster")
    return manifest
  }

  /**
   * The candidate's gate receipt, and that it is this inventory's: a candidate
   * checked against fewer gates, or with other exceptions, is not this
   * release's candidate, the same way a smoke receipt for another integrity is
   * not this candidate's smoke.
   */
  const gateEvidenceFor = async (candidate: Candidate): Promise<GateEvidence> => {
    const text = await maybeRead(await inside(root, `${candidate.directory}/gate-evidence.json`))
    if (text === undefined) {
      throw new Error("Missing gate evidence; the checks step did not produce a receipt for this candidate")
    }
    const receipt = Schema.decodeUnknownSync(GateEvidence)(json<unknown>(text))
    const expected = gateReceipt(gates)
    if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
      throw new Error("Gate evidence does not match the release inventory; run the checks step again")
    }
    return receipt
  }

  const smoke = async (candidate: Candidate, runtime: "26.4.0", signal?: AbortSignal): Promise<Candidate> => {
    await manifestFor(candidate)
    await run("pnpm", [
      "--package",
      `node@${runtime}`,
      "--package",
      "npm@11.16.0",
      "dlx",
      "node",
      "scripts/smoke-release.mjs",
      candidate.directory
    ], signal ? { signal } : {})
    const evidence = await readJson<{ status: string; candidateIntegrity: string; toolchain: { node: string } }>(
      `${candidate.directory}/smoke-evidence.json`
    )
    if (
      evidence.status !== "passed" || evidence.candidateIntegrity !== candidate.digest ||
      evidence.toolchain.node !== `v${runtime}`
    ) throw new Error(`No matching smoke evidence for Node ${runtime}`)
    await writeJson(`${candidate.directory}/smoke-node-${runtime}.json`, evidence)
    return candidate
  }

  const registry = (input: ReleaseInput, signal?: AbortSignal) => {
    const readRegistry = async (spec: string): Promise<string | undefined> => {
      try {
        const value = json<unknown>(
          await run("pnpm", ["view", spec, "dist.integrity", "--json"], signal ? { signal } : {})
        )
        if (typeof value !== "string" || !value.startsWith("sha512-")) {
          throw new Error(`Registry returned no integrity for ${spec}`)
        }
        return value
      } catch (error) {
        if (/\b(?:E404|ERR_PNPM_FETCH_404)\b/.test(String(error))) return undefined
        throw error
      }
    }
    return {
      sourceSha: "",
      releaseTag: `v${input.version}`,
      readRegistry,
      publish: async (path: string, entry: { name: string; version: string; integrity: string }) => {
        try {
          await run("pnpm", [
            "publish",
            path,
            `--provenance=${input.provenance}`,
            "--access",
            "public",
            "--tag",
            input.version.includes("-") ? "next" : "latest",
            "--no-git-checks"
          ], signal ? { signal } : {})
        } catch (error) {
          if (await readRegistry(`${entry.name}@${entry.version}`) !== entry.integrity) throw error
        }
      },
      pause: (seconds: number) => delay(seconds * 1000, undefined, signal ? { signal } : {})
    }
  }

  const verifyCandidate = async (
    { input, candidate }: { input: ReleaseInput; candidate: Candidate },
    signal?: AbortSignal
  ): Promise<Candidate> => {
    await assertHead(candidate.sourceSha, signal)
    await assertCleanMain(signal)
    await approvedContent(input, signal)
    if (candidate.version !== input.version) throw new Error("Candidate version does not match the release input")
    const manifest = await manifestFor(candidate)
    for (const runtime of ["26.4.0"]) {
      const smoke = await readJson<{ status: string; candidateIntegrity: string; toolchain: { node: string } }>(
        `${candidate.directory}/smoke-node-${runtime}.json`
      )
      if (
        smoke.status !== "passed" || smoke.candidateIntegrity !== candidate.digest ||
        smoke.toolchain.node !== `v${runtime}`
      ) throw new Error(`Missing verified Node ${runtime} smoke result`)
    }
    const pending = await preflight(await inside(root, candidate.directory), manifest, {
      ...registry(input, signal),
      sourceSha: candidate.sourceSha
    })
    const receipt = await gateEvidenceFor(candidate)
    const exceptions = receipt.exceptions.length === 0
      ? "Every release.yml gate ran on this host."
      : `${receipt.exceptions.length} release.yml gate(s) did NOT run on this host and are not proved by this candidate:\n${
        receipt.exceptions.map((exception) => `  ${exception.name}: ${exception.reason}`).join("\n")
      }`
    const verified = {
      ...candidate,
      approvalPrompt: `Publish Smithers ${input.version} to npm (${
        input.version.includes("-") ? "next" : "latest"
      })?\n${pending.length} pending of ${candidate.packageCount} packages.\nSource: ${candidate.sourceSha}\nCandidate integrity: ${candidate.digest}\nGates: ${receipt.ran.length} passed. ${exceptions}\nReview ${candidate.directory}/release-manifest.json, gate-evidence.json and smoke-node-26.4.0.json.\nProvenance: ${
        input.provenance ? "required" : "explicitly disabled"
      }.\nOnly these exact tested tarballs will be published.`
    }
    if (!input.dryRun) await showReview(verified.approvalPrompt)
    return verified
  }

  const publish = async (value: { input: ReleaseInput; candidate: Candidate }, signal?: AbortSignal) => {
    if (value.input.dryRun || value.input.phase !== "publish") throw new Error("npm publication was not requested")
    await verifyCandidate(value, signal)
    const manifest = await manifestFor(value.candidate)
    const published = await publishCandidate(await inside(root, value.candidate.directory), manifest, {
      ...registry(value.input, signal),
      sourceSha: value.candidate.sourceSha
    })
    return {
      status: "published" as const,
      version: value.input.version,
      artifact: value.candidate.directory,
      published
    }
  }

  return {
    collect,
    preview,
    verifyArtifact,
    recordApproval,
    publishFiles,
    postThread,
    commitFiles,
    preparePlan,
    writePreparation,
    validate,
    checks,
    build,
    pack,
    smoke,
    verifyCandidate,
    publish
  }
}

const attempt = <A>(step: string, work: (signal: AbortSignal) => Promise<A>) =>
  Effect.gen(function*() {
    yield* Effect.logInfo(`Release step: ${step}`)
    const result = yield* Effect.tryPromise({
      try: work,
      catch: (error) =>
        error instanceof ReleaseError
          ? error
          : new ReleaseError({ step, message: error instanceof Error ? error.message : String(error) })
    })
    yield* Effect.logInfo(`Release step complete: ${step}`)
    return result
  })

/**
 * Select the release narrative's judge while assembling the host. A missing
 * gateway key refuses startup; an offline test deliberately scripts this
 * classifier and the completion brake through the same evaluator.
 */
export const actionLayers = (
  options: Options & {
    readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  }
) => {
  const ops = operations(options)
  return Layer.mergeAll(
    Content.Outcome.toLayer(Effect.succeed),
    Content.PickTemplate.toLayer(({ input, evidence, analysis }) => chooseTemplate(input, evidence, analysis))
      .pipe(Layer.provide(options.evaluator ?? evaluatorLayer(process.env, "smithers release-support"))),
    Release.Outcome.toLayer(Effect.succeed),
    Content.Collect.toLayer((value) => attempt("collect", (signal) => ops.collect(value, signal))),
    Content.RecordUi.toLayer(({ input, evidence }) =>
      input.recording === null
        ? Effect.succeed(evidence)
        : attempt("record-ui", (signal) => recordUi(options.root, input.recording!, evidence, signal))
    ),
    Content.Check.toLayer(({ input, evidence, analysis, draft, review }) =>
      Effect.succeed(checkContent(input, evidence, analysis, draft, review))
    ),
    Content.QualityGate.toLayer(({ review, draft }) =>
      review.passed
        ? Effect.succeed(draft)
        : Effect.fail(new ReleaseError({ step: "quality-gate", message: review.feedback.join("\n") }))
    ),
    Content.Preview.toLayer((value) => attempt("preview", () => ops.preview(value))),
    Content.RecordApproval.toLayer(({ artifact }) =>
      attempt("record-approval", (signal) => ops.recordApproval(artifact, signal))
    ),
    Content.PublishFiles.toLayer(({ artifact }) =>
      attempt("publish-files", (signal) => ops.publishFiles(artifact, signal))
    ),
    Content.PostThread.toLayer(({ artifact }) => attempt("post-thread", (signal) => ops.postThread(artifact, signal))),
    Content.CommitFiles.toLayer(({ artifact, files }) =>
      attempt("commit-files", (signal) => ops.commitFiles(artifact, files, signal))
    ),
    Release.PreparePlan.toLayer((value) => attempt("prepare-plan", (signal) => ops.preparePlan(value, signal))),
    Release.WritePreparation.toLayer((value) =>
      attempt("write-preparation", (signal) => ops.writePreparation(value, signal))
    ),
    Release.Validate.toLayer((value) => attempt("validate", (signal) => ops.validate(value, signal))),
    Release.Checks.toLayer(({ evidence }) => attempt("checks", (signal) => ops.checks(evidence, signal))),
    Release.Build.toLayer(({ evidence }) => attempt("build", (signal) => ops.build(evidence, signal))),
    Release.Pack.toLayer(({ evidence }) => attempt("pack", (signal) => ops.pack(evidence, signal))),
    Release.Smoke.toLayer(({ candidate, runtime }) =>
      attempt("smoke", (signal) => ops.smoke(candidate, runtime, signal))
    ),
    Release.VerifyCandidate.toLayer((value) =>
      attempt("verify-candidate", (signal) => ops.verifyCandidate(value, signal))
    ),
    Release.Publish.toLayer((value) => attempt("publish", (signal) => ops.publish(value, signal)))
  )
}
