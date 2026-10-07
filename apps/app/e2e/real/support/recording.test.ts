import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { retainReviewedRecording } from "./recording"

async function fixture(body: (f: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const f = await prepare()
  try { await body(f) } finally { await rm(f.dir, { recursive: true, force: true }) }
}
async function prepare() {
  const dir = await mkdtemp(join(process.cwd(), ".recording-test-"))
  const rawRecording = join(dir, "raw.mp4")
  const recording = join(dir, "sanitized.mp4")
  const reviewPath = join(dir, "review.json")
  const destination = join(dir, "retained.mp4")
  await writeFile(rawRecording, "credential canary: must never be retained")
  const bytes = Buffer.from("full-run sanitized recording fixture")
  await writeFile(recording, bytes)
  const review = {
    candidate: "a".repeat(40), operator: "outside operator", reviewedBy: "recording reviewer",
    reviewedAt: new Date().toISOString(), recording,
    sha256: createHash("sha256").update(bytes).digest("hex"), fullRun: true, credentialsRemoved: true
  }
  const save = () => writeFile(reviewPath, JSON.stringify(review))
  await save()
  const input = { rawRecording, candidate: review.candidate, operator: review.operator, reviewPath, destination }
  return { dir, input, review, save, bytes }
}

test("retains reviewed bytes with private permissions and leaves the raw capture untouched", () => fixture(async f => {
  expect(f.review).toEqual(await retainReviewedRecording(f.input))
  expect(await readFile(f.input.destination)).toEqual(f.bytes)
  expect((await stat(f.input.destination)).mode & 0o777).toBe(0o600)
  expect(await readFile(f.input.rawRecording, "utf8")).toContain("credential canary")
  expect((await readdir(f.dir)).some(name => name.startsWith(".recording-review-"))).toBe(false)
}))

for (const invalid of ["self-review", "self-review-case", "self-review-space", "blank-reviewer", "missing", "malformed", "candidate", "operator", "future", "partial", "unsafe", "digest", "changed", "empty", "raw", "raw-symlink", "raw-hardlink", "directory"] as const) {
  test(`refuses ${invalid} recording without publishing bytes`, () => fixture(async f => {
    if (invalid === "self-review") f.review.reviewedBy = f.review.operator
    if (invalid === "self-review-case") f.review.reviewedBy = f.review.operator.toUpperCase()
    if (invalid === "self-review-space") f.review.reviewedBy = `  ${f.review.operator}  `
    if (invalid === "blank-reviewer") f.review.reviewedBy = "   "
    if (invalid === "missing") f.input.reviewPath = join(f.dir, "missing.json")
    if (invalid === "candidate") f.review.candidate = "b".repeat(40)
    if (invalid === "operator") f.review.operator = "different operator"
    if (invalid === "future") f.review.reviewedAt = new Date(Date.now() + 60_000).toISOString()
    if (invalid === "partial") f.review.fullRun = false
    if (invalid === "unsafe") f.review.credentialsRemoved = false
    if (invalid === "digest") f.review.sha256 = "b".repeat(64)
    if (invalid === "changed") await writeFile(f.review.recording, "modified after review")
    if (invalid === "empty") {
      await writeFile(f.review.recording, "")
      f.review.sha256 = createHash("sha256").update("").digest("hex")
    }
    if (invalid === "raw") f.review.recording = f.input.rawRecording
    if (invalid === "raw-symlink") {
      const alias = join(f.dir, "raw-alias.mp4")
      await symlink(f.input.rawRecording, alias)
      f.review.recording = alias
    }
    if (invalid === "raw-hardlink") {
      const alias = join(f.dir, "raw-hardlink.mp4")
      await link(f.input.rawRecording, alias)
      f.review.recording = alias
    }
    if (invalid === "directory") f.review.recording = f.dir
    await f.save()
    if (invalid === "malformed") await writeFile(f.input.reviewPath, "credential canary malformed JSON")
    await expect(retainReviewedRecording(f.input)).rejects.toThrow("recording_review_required")
    expect(await stat(f.input.destination).catch(() => null)).toBeNull()
    expect((await readdir(f.dir)).some(name => name.startsWith(".recording-review-"))).toBe(false)
  }))
}

test("an absent review path fails closed", () => fixture(async f => {
  await expect(retainReviewedRecording({ ...f.input, reviewPath: undefined })).rejects.toThrow("recording_review_required")
  expect(await stat(f.input.destination).catch(() => null)).toBeNull()
}))

test("existing evidence is never overwritten, and a failed publication removes staging bytes", () => fixture(async f => {
  await writeFile(f.input.destination, "earlier evidence")
  await expect(retainReviewedRecording(f.input)).rejects.toThrow()
  expect(await readFile(f.input.destination, "utf8")).toBe("earlier evidence")
  expect((await readdir(f.dir)).some(name => name.startsWith(".recording-review-"))).toBe(false)
}))
