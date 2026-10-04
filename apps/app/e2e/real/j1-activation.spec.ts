import { copyFile, readFile, writeFile } from "node:fs/promises"
import { z } from "zod"
import { test as realTest, expect, command, realApi } from "./support/test"
import { realHost } from "./support/host"
import { scenario } from "./coverage/types"
import { J1PreconditionError, requireJ1Preconditions } from "./support/j1-preconditions"

// Setup is intentionally unsigned-in. The normal real lifecycle requires an already
// authenticated host and would consume the fresh-install precondition before setup.
const test = realTest.extend({
  _realLifecycle: async ({}, use) => { requireJ1Preconditions(); await use() }
})

// Request the overridden lifecycle explicitly before every test.
test.beforeEach(async ({ _realLifecycle }) => { void _realLifecycle })

const finalEvidence = z.object({
  operator: z.string().min(1),
  noAssistance: z.literal(true),
  noConfigurationEdits: z.literal(true),
  onlyDocumentedCommands: z.literal(true),
  noPnpmDev: z.literal(true),
  recordingComplete: z.literal(true),
  t0: z.string().datetime(),
  clockOffsetEndMs: z.number().finite(),
  completedAt: z.string().datetime()
})

test("C-J1-04 first TODO activation", scenario("journey.j1-activation", {
  capabilities: [], coverage: ["action:sign-in", "dimension:activation", "host:local", "host:production", "path:success", "door:button", "evidence:activation"]
}), async ({ page, request }, info) => {
  const input = requireJ1Preconditions()
  const publicInput = { ...input, setupURL: new URL(input.setupURL).origin + new URL(input.setupURL).pathname }
  const end = Date.parse(input.t0) - input.clockOffsetStartMs + 3_600_000
  const remaining = () => {
    const ms = end - Date.now()
    if (ms <= 0) throw new J1PreconditionError("activation_deadline", "60 minutes since corrected recording T0 elapsed")
    return ms
  }
  // This is the oracle's end-to-end budget, rather than an inflated locator timeout.
  info.setTimeout(remaining())
  const timestamps: Array<{ event: string; at: string; source: string }> = [
    { event: "T0", at: input.t0, source: "operator screen recording UTC" }
  ]
  const record = async (event: string, at?: string, source = "production host HTTP Date at browser observation") => {
    if (at === undefined) {
      const response = await realApi(page, request, "GET", "/api/bootstrap")
      expect(response.status()).toBe(200)
      const date = response.headers().date
      if (!date || !Number.isFinite(Date.parse(date))) throw new J1PreconditionError("host_timestamp_missing", "production host response must carry an HTTP Date timestamp")
      at = new Date(Date.parse(date)).toISOString()
    }
    timestamps.push({ event, at, source })
    await writeFile(info.outputPath("timestamps.json"), JSON.stringify(timestamps, null, 2))
  }
  await info.attach("preconditions", { body: JSON.stringify(publicInput), contentType: "application/json" })
  await page.goto(input.setupURL)
  await record("setup session opened")
  const setup = page.getByRole("region", { name: "Set up Smithers", exact: true })
  await expect(setup).toBeVisible()
  // The independent operator completes the real manifest, OAuth and key entry in
  // this headed browser, using only their README/quickstart. No API mutation seeds setup.
  for (const step of ["address", "app_manifest", "sign_in", "repository", "models", "source"]) {
    await expect(setup.locator(`[data-step="${step}"]`)).toHaveAttribute("data-state", "done", { timeout: remaining() })
    await record(`setup.${step}`)
  }
  await expect(setup.getByText("Source ready", { exact: true })).toBeVisible()
  await record("Source ready")
  // Machine readiness is a distinct row, not an alias for source readiness.
  await expect(setup.locator('[data-step="machine"]')).toHaveCount(1)
  await expect(setup.locator('[data-step="source"]')).toHaveCount(1)

  const bootstrapResponse = await realApi(page, request, "GET", "/api/bootstrap")
  expect(bootstrapResponse.status()).toBe(200)
  const bootstrap = await bootstrapResponse.json()
  const observedHost = realHost(bootstrap)
  expect(observedHost).toBe(process.env.SMITHERS_REAL_E2E_HOST)
  info.annotations.push({ type: "real-host-verified", description: observedHost })
  if (observedHost === "production") {
    expect(bootstrap.buildSha).toBe(input.install.commit)
    info.annotations.push({ type: "real-build-sha", description: bootstrap.buildSha })
  }

  // JOURNEY.md is read from the real scratch repository on GitHub, never from specs
  // or a production implementation's constants. Its complete text is the fixed TODO.
  const github = async (path: string) => {
    const response = await request.get(`https://api.github.com/repos/${input.repository}${path}`, {
      headers: { Accept: "application/vnd.github+json" }
    })
    expect(response.status(), `GitHub GET ${path}`).toBe(200)
    return response.json()
  }
  const repo = await github("")
  expect(repo.allow_squash_merge).toBe(true)
  expect(repo.default_branch).toBe("main")
  const initialMain = (await github("/git/ref/heads/main")).object.sha as string
  const journey = await github("/contents/JOURNEY.md?ref=main")
  expect(journey.encoding).toBe("base64")
  const prompt = Buffer.from(journey.content, "base64").toString("utf8").trim()
  expect(prompt.length).toBeGreaterThan(0)
  await command(page, "What does this repository do? Show the relevant files.")
  await expect(page.locator('[data-kind="file-list"]').last()).toBeVisible({ timeout: remaining() })
  await record("first answer")
  await expect(setup.locator('[data-step="machine"]')).toHaveAttribute("data-state", "done", { timeout: remaining() })
  await expect(setup.getByText("Machine ready", { exact: true })).toBeVisible()
  await record("setup.machine")

  await command(page, "/todo.new")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await expect(draft).toBeVisible()
  await draft.getByLabel("Title", { exact: true }).fill("First TODO")
  await draft.getByLabel("Prompt", { exact: true }).fill(prompt)
  await draft.getByLabel("Place", { exact: true }).selectOption({ label: "Append" })
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  await record("TODO placed")
  const todo = page.getByRole("article", { name: "TODO T1", exact: true })
  for (const state of ["Queued", "Starting", "Working", "In review"]) {
    await expect(todo.getByText(state, { exact: true })).toBeVisible({ timeout: remaining() })
    await record(`TODO ${state}`)
  }
  await todo.getByText("Evidence", { exact: true }).click()
  const link = todo.locator('a[href^="https://github.com/"][href*="/pull/"]').first()
  await expect(link).toBeVisible()
  const prURL = await link.getAttribute("href")
  expect(prURL).toMatch(new RegExp(`^https://github.com/${input.repository}/pull/[1-9][0-9]*$`))
  const number = Number(prURL!.split("/").at(-1))
  const prPage = await page.context().newPage()
  await prPage.goto(prURL!)
  await record("PR opened")
  await prPage.close()
  const before = await github(`/pulls/${number}`)
  expect(before.head.ref).toMatch(/^smithers\/[a-z0-9][a-z0-9-]*$/)
  expect(before.base.ref).toBe("main")
  expect(before.merged_at).toBeNull()
  expect(before.head.repo.full_name).toBe(input.repository)

  // A person reviews before the test presses the app's Merge button. Missing
  // human review is a refusal, never an automatic approval by the QA agent.
  const reviewEvidence = z.object({ operator: z.string().min(1), reviewedHead: z.string().regex(/^[a-f0-9]{40}$/), reviewedInApp: z.literal(true) })
  let reviewed: z.infer<typeof reviewEvidence> | undefined
  await expect.poll(async () => {
    try { reviewed = reviewEvidence.parse(JSON.parse(await readFile(process.env.SMITHERS_J1_REVIEW!, "utf8"))); return true }
    catch { return false }
  }, { timeout: remaining(), message: "C-J1-04 precondition/operator_review_missing: operator review observations and reviewed head required" }).toBe(true)
  expect(reviewed!.operator).toBe(input.operator.name)
  expect(reviewed!.reviewedHead).toBe(before.head.sha)
  const mergeRequest = page.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/api/todos/1/merge")
  await todo.getByRole("button", { name: "Merge", exact: true }).click()
  const sent = await mergeRequest
  expect(sent.postDataJSON()).toEqual({ reviewed_head_sha: before.head.sha })
  const headers = await sent.allHeaders()
  expect(headers.authorization).toBeUndefined()
  expect(headers.cookie).toBeTruthy() // session-only endpoint; never supply a delegated bearer
  const mergeResponse = await sent.response()
  expect(mergeResponse?.status()).toBe(202)
  await record("Smithers Merge pressed")

  let merged: typeof before | undefined
  await expect.poll(async () => {
    merged = await github(`/pulls/${number}`)
    if (await todo.getByText("Merged", { exact: true }).isVisible()) expect(merged.merged_at).not.toBeNull()
    return merged.merged_at !== null
  }, { timeout: remaining(), intervals: [500, 1000, 2000] }).toBe(true)
  await record("merged", merged!.merged_at, "GitHub merged_at")
  const correctedT0 = Date.parse(input.t0) - input.clockOffsetStartMs
  expect(Date.parse(merged!.merged_at) - correctedT0).toBeGreaterThanOrEqual(0)
  expect(Date.parse(merged!.merged_at) - correctedT0).toBeLessThanOrEqual(3_600_000)
  const compare = await github(`/compare/${initialMain}...${merged!.merge_commit_sha}`)
  expect(compare.total_commits).toBe(1)
  expect(compare.commits[0].sha).toBe(merged!.merge_commit_sha)
  expect(compare.commits[0].parents).toHaveLength(1)
  expect(compare.commits[0].parents[0].sha).toBe(initialMain)
  const main = (await github("/git/ref/heads/main")).object.sha
  expect(main).toBe(merged!.merge_commit_sha)
  await expect(todo.getByText("Merged", { exact: true })).toBeVisible({ timeout: remaining() })
  await record("TODO Merged")


  const itemResponse = await realApi(page, request, "GET", "/api/todos/1")
  expect(itemResponse.status()).toBe(200)
  const item = await itemResponse.json()
  // Keep the original host value. Absence of attribution must never be treated as proof.
  const land = item.checks?.land
  if (!land) throw new J1PreconditionError("land_evidence_missing", "host must expose the item's checks.Land approval")
  expect(land.head).toBe(before.head.sha)
  expect(land.by).toBe("canary-owner")
  expect(Number.isInteger(land.generation)).toBe(true)
  expect(land.generation).toBeGreaterThan(0)
  expect(land.generation).toBe(item.generation)

  let attestation: z.infer<typeof finalEvidence> | undefined
  await expect.poll(async () => {
    try { attestation = finalEvidence.parse(JSON.parse(await readFile(process.env.SMITHERS_J1_FINAL_EVIDENCE!, "utf8"))); return true }
    catch { return false }
  }, { message: "C-J1-04 precondition/final_observations_missing: completed recording and operator observations required" }).toBe(true)
  expect(attestation!.operator).toBe(input.operator.name)
  expect(attestation!.t0).toBe(input.t0)
  expect(Date.parse(attestation!.completedAt)).toBeGreaterThanOrEqual(Date.parse(merged!.merged_at))
  await writeFile(info.outputPath("activation.json"), JSON.stringify({
    preconditions: publicInput, operator: attestation, timestamps, prURL,
    mergeCommit: merged!.merge_commit_sha, github: merged, checks: { Land: land }
  }, null, 2))
  await info.attach("activation", { path: info.outputPath("activation.json"), contentType: "application/json" })
})

// Preserve the external recording even when a feature assertion fails. Browser
// video alone cannot prove the install keystroke or the absence of assistance.
test.afterEach(async ({}, info) => {
  const path = process.env.SMITHERS_J1_PRECONDITIONS
  if (!path) return
  const input = JSON.parse(await readFile(path, "utf8")) as { recording: string }
  await copyFile(input.recording, info.outputPath("screen-recording"))
  await info.attach("screen-recording", { path: info.outputPath("screen-recording"), contentType: "video/mp4" })
})
