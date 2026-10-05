import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deployedVerdict,
  parseDeployedVersions,
  parseReceipt,
  parseVersionList,
  receiptVerdict,
  rollbackVerdict
} from "./rollback-verdict.ts"

/**
 * CN-24. The probe is exercised as a real subprocess against a loopback
 * stand-in for the Cloudflare API, with real receipt files on disk. The fake's
 * response shapes are the ones wrangler 4.123.0's own client reads:
 * `{ success, result: { items } }` for versions and
 * `{ success, result: { deployments: [{ versions: [{ version_id, percentage }] }] } }`
 * for deployments. No Cloudflare credential is involved.
 */

const SCRIPT = new URL("./rollback-probe.ts", import.meta.url).pathname

const VERSION_A = "11111111-1111-4111-8111-111111111111"
const VERSION_B = "22222222-2222-4222-8222-222222222222"

interface FakeOptions {
  readonly versions?: ReadonlyArray<{ id: string; created_on?: string }>
  readonly deployed?: ReadonlyArray<{ version_id: string; percentage: number }>
  readonly status?: number
  readonly rawBody?: string
}

const cloudflareDouble = (options: FakeOptions = {}) => {
  const paths: Array<string> = []
  const authorizations: Array<string | null> = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      paths.push(url.pathname)
      authorizations.push(request.headers.get("authorization"))
      if (options.status !== undefined) return new Response(options.rawBody ?? "", { status: options.status })
      if (options.rawBody !== undefined) return new Response(options.rawBody, { status: 200 })
      if (url.pathname.endsWith("/deployments")) {
        return Response.json({
          success: true,
          result: {
            deployments: [{ versions: options.deployed ?? [{ version_id: VERSION_B, percentage: 100 }] }]
          }
        })
      }
      return Response.json({
        success: true,
        result: {
          items: (options.versions ?? [{ id: VERSION_B, created_on: "2026-08-18T00:00:00Z" }, { id: VERSION_A }]).map(
            (version) => ({
              id: version.id,
              metadata: { created_on: version.created_on },
              annotations: { "workers/message": "deploy" }
            })
          )
        }
      })
    }
  })
  return { server, paths, authorizations, base: `http://localhost:${server.port}` }
}

let live: ReturnType<typeof cloudflareDouble> | undefined
let workdir: string | undefined

afterEach(() => {
  live?.server.stop(true)
  live = undefined
  if (workdir !== undefined) rmSync(workdir, { recursive: true, force: true })
  workdir = undefined
})

const receiptFile = (receipt: Record<string, unknown> | string): string => {
  workdir = mkdtempSync(join(tmpdir(), "cn24-"))
  const path = join(workdir, "latest.json")
  writeFileSync(path, typeof receipt === "string" ? receipt : JSON.stringify(receipt, null, "\t"))
  return path
}

const realReceipt = (versionId: string | null): Record<string, unknown> => ({
  worker: "smithers-mvp-web",
  dryRun: false,
  gitSha: "a6cab068a6cab068a6cab068a6cab068a6cab068",
  timestamp: "2026-08-18T12:00:00.000Z",
  wranglerVersionId: versionId
})

const runProbe = async (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string }> => {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { exitCode, stdout: `${stdout}${stderr}` }
}

describe("rollback-verdict", () => {
  test("a dry-run receipt is refused with the reason, not read as a deployed version", () => {
    const parsed = parseReceipt(JSON.stringify({ ...realReceipt(null), dryRun: true }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const verdict = receiptVerdict(parsed.value)
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain("--dry-run")
  })

  test("a real receipt with no version id is the CN-24 gap, stated in full", () => {
    const parsed = parseReceipt(JSON.stringify(realReceipt(null)))
    if (!parsed.ok) throw new Error(parsed.detail)
    expect(receiptVerdict(parsed.value)).toEqual({
      ok: false,
      detail:
        "the deploy receipt names no wranglerVersionId, so no version can be confirmed deployed or rolled back to."
    })
  })

  test("a real receipt naming a version passes and quotes the sha", () => {
    const parsed = parseReceipt(JSON.stringify(realReceipt(VERSION_B)))
    if (!parsed.ok) throw new Error(parsed.detail)
    const verdict = receiptVerdict(parsed.value)
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain(VERSION_B)
    expect(verdict.detail).toContain("a6cab068a6ca")
  })

  test("malformed receipts fail with a reason instead of throwing", () => {
    expect(parseReceipt("not json")).toEqual({ ok: false, detail: "the receipt is not JSON: not json" })
    expect(parseReceipt("[]").ok).toBe(false)
    expect(parseReceipt(JSON.stringify({ worker: "w" })).ok).toBe(false)
    expect(parseReceipt(JSON.stringify({ ...realReceipt(null), wranglerVersionId: 7 })).ok).toBe(false)
  })

  test("the version list is read out of result.items, newest first", () => {
    const parsed = parseVersionList({
      success: true,
      result: {
        items: [
          { id: VERSION_B, metadata: { created_on: "2026-08-18T00:00:00Z" }, annotations: { "workers/message": "m" } },
          { id: VERSION_A }
        ]
      }
    })
    expect(parsed).toEqual({
      ok: true,
      value: [
        { id: VERSION_B, createdOn: "2026-08-18T00:00:00Z", message: "m" },
        { id: VERSION_A, createdOn: undefined, message: undefined }
      ]
    })
  })

  test("an unexpected versions shape is a failure detail, never a throw", () => {
    expect(parseVersionList(null).ok).toBe(false)
    expect(parseVersionList({ success: false, errors: [{ message: "bad token" }] }).ok).toBe(false)
    expect(parseVersionList({ success: true, result: {} }).ok).toBe(false)
    expect(parseVersionList({ success: true, result: { items: [{ noId: true }] } }).ok).toBe(false)
  })

  test("the deployed set is read out of the newest deployment", () => {
    expect(
      parseDeployedVersions({
        success: true,
        result: { deployments: [{ versions: [{ version_id: VERSION_B, percentage: 100 }] }] }
      })
    ).toEqual({ ok: true, value: [{ id: VERSION_B, percentage: 100 }] })
    expect(parseDeployedVersions({ success: true, result: { deployments: [] } }).ok).toBe(false)
    expect(parseDeployedVersions({ success: true, result: { deployments: [{}] } }).ok).toBe(false)
    expect(parseDeployedVersions({ success: true, result: { deployments: [{ versions: [{}] }] } }).ok).toBe(false)
  })

  test("a deployment that drifted from the receipt fails and names both sides", () => {
    const verdict = deployedVerdict([{ id: VERSION_A, percentage: 100 }], VERSION_B)
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain(VERSION_A)
    expect(verdict.detail).toContain(VERSION_B)
  })

  test("rollback eligibility needs at least two versions, one of them the deployed one", () => {
    const versions = [
      { id: VERSION_B, createdOn: "2026-08-18T00:00:00Z", message: undefined },
      { id: VERSION_A, createdOn: "2026-08-01T00:00:00Z", message: undefined }
    ]
    const pass = rollbackVerdict(versions, VERSION_B)
    expect(pass.ok).toBe(true)
    expect(pass.detail).toContain(`rollback ${VERSION_A}`)

    expect(rollbackVerdict(versions.slice(0, 1), VERSION_B)).toEqual({
      ok: false,
      detail: "only 1 version(s) exist for this Worker: there is nothing to roll back to."
    })
    expect(rollbackVerdict(versions, null).ok).toBe(false)
    const unknown = rollbackVerdict(versions, "33333333-3333-4333-8333-333333333333")
    expect(unknown.ok).toBe(false)
    expect(unknown.detail).toContain("not in Cloudflare's version list")
  })

  test("the prior version is the next-OLDER entry, never a newer one", () => {
    // Newest first, exactly as Cloudflare returns them. A receipt naming the
    // middle version must not be told to roll "back" to the newest.
    const versions = [
      { id: "c", createdOn: undefined, message: undefined },
      { id: "b", createdOn: undefined, message: undefined },
      { id: "a", createdOn: undefined, message: undefined }
    ]
    expect(rollbackVerdict(versions, "b").detail).toContain("rollback a")
    expect(rollbackVerdict(versions, "b").detail).not.toContain("rollback c")
    const oldest = rollbackVerdict(versions, "a")
    expect(oldest.ok).toBe(false)
    expect(oldest.detail).toContain("oldest version Cloudflare still lists")
  })
})

describe("rollback-probe.ts against a Cloudflare API double", () => {
  /*
   * Exit 2, never 1: an empty flag is a mistake in the invocation, and a 1
   * would read as a verdict about the deployment. Nothing is fetched.
   */
  test("a flag with no value is refused before Cloudflare is called", async () => {
    live = cloudflareDouble()
    const result = await runProbe(["--receipt", receiptFile(realReceipt(VERSION_B)), "--api-base"], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain("--api-base needs a value")
    expect(live.paths).toEqual([])
  })

  test("a real deploy receipt whose version is live and has a predecessor passes", async () => {
    live = cloudflareDouble()
    const result = await runProbe(["--receipt", receiptFile(realReceipt(VERSION_B))], {
      CLOUDFLARE_API_BASE_URL: live.base,
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok: the deploy receipt names a version")
    expect(result.stdout).toContain("ok: the receipt names the version serving traffic")
    expect(result.stdout).toContain(`ok: a previous version is still rollback-eligible`)
    expect(result.stdout).toContain(`bun x wrangler@4.123.0 rollback ${VERSION_A}`)
    expect(result.stdout).toContain("CN-24 ROLLBACK PROBE PASS")
    expect(live.authorizations.every((value) => value === "Bearer cf-token-123")).toBe(true)
    expect(live.paths).toEqual([
      "/accounts/dd3525a4132493566aeb38de533c8827/workers/scripts/smithers-mvp-web/deployments",
      "/accounts/dd3525a4132493566aeb38de533c8827/workers/scripts/smithers-mvp-web/versions"
    ])
  })

  test("today's state — a dry-run receipt with a null version id — fails without calling Cloudflare", async () => {
    live = cloudflareDouble()
    const dryRun = { ...realReceipt(null), dryRun: true }
    const result = await runProbe(["--receipt", receiptFile(dryRun), "--api-base", live.base], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL: the deploy receipt names a version")
    expect(result.stdout).toContain("it published nothing")
  })

  test("a real deploy that recorded no version id fails on all three checks", async () => {
    live = cloudflareDouble()
    const result = await runProbe(["--receipt", receiptFile(realReceipt(null)), "--api-base", live.base], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("names no wranglerVersionId")
    expect(result.stdout).toContain("FAIL: the receipt names the version serving traffic")
    expect(result.stdout).toContain("FAIL: a previous version is still rollback-eligible")
  })

  test("a Worker with only one version has nothing to roll back to", async () => {
    live = cloudflareDouble({ versions: [{ id: VERSION_B }] })
    const result = await runProbe(["--receipt", receiptFile(realReceipt(VERSION_B)), "--api-base", live.base], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("only 1 version(s) exist")
  })

  test("a live deployment that drifted from the receipt fails", async () => {
    live = cloudflareDouble({ deployed: [{ version_id: VERSION_A, percentage: 100 }] })
    const result = await runProbe(["--receipt", receiptFile(realReceipt(VERSION_B)), "--api-base", live.base], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("the deployment drifted from the receipt")
  })

  test("a refused Cloudflare token fails with the status, naming the credential", async () => {
    live = cloudflareDouble({ status: 403, rawBody: "forbidden" })
    const result = await runProbe(["--receipt", receiptFile(realReceipt(VERSION_B)), "--api-base", live.base], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("HTTP 403 — CLOUDFLARE_API_TOKEN cannot read smithers-mvp-web's versions")
  })

  test("an unrecognized API body is one legible FAIL line, not a stack trace", async () => {
    live = cloudflareDouble({ rawBody: "{\"success\":true,\"result\":{}}" })
    const result = await runProbe(["--receipt", receiptFile(realReceipt(VERSION_B)), "--api-base", live.base], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("carries no result.deployments array")
    expect(result.stdout).toContain("carries no result.items array")
    expect(result.stdout).not.toContain("at <anonymous>")
  })

  test("HTML from a proxy is reported as such, not parsed", async () => {
    live = cloudflareDouble({ rawBody: "<html>gateway</html>" })
    const result = await runProbe(["--receipt", receiptFile(realReceipt(VERSION_B)), "--api-base", live.base], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("the body is not JSON")
  })

  test("an unreachable API is reported with the target, never a stack trace", async () => {
    const result = await runProbe([
      "--receipt",
      receiptFile(realReceipt(VERSION_B)),
      "--api-base",
      "http://127.0.0.1:1"
    ], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("http://127.0.0.1:1/accounts/")
    expect(result.stdout).toContain("is unreachable")
  })

  test("no Cloudflare token skips the live checks and exits 0", async () => {
    live = cloudflareDouble()
    const result = await runProbe(["--receipt", receiptFile(realReceipt(VERSION_B)), "--api-base", live.base])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok: the deploy receipt names a version")
    expect(result.stdout).toContain(
      "skip: the receipt names the version serving traffic — CLOUDFLARE_API_TOKEN is unset"
    )
    expect(result.stdout).toContain(
      "skip: a previous version is still rollback-eligible — CLOUDFLARE_API_TOKEN is unset"
    )
    expect(live.paths).toEqual([])
  })

  test("a missing receipt skips with the path named, because receipts are gitignored", async () => {
    live = cloudflareDouble()
    const result = await runProbe(["--receipt", "/nonexistent/latest.json", "--api-base", live.base], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("no receipt at /nonexistent/latest.json")
    expect(result.stdout).toContain("CANARY_RECEIPT_PATH")
    expect(live.paths).toEqual([])
  })

  test("a run that verified nothing reports INCONCLUSIVE, never PASS", async () => {
    live = cloudflareDouble()
    const result = await runProbe(["--receipt", "/nonexistent/latest.json", "--api-base", live.base])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("CN-24 ROLLBACK PROBE INCONCLUSIVE: nothing was verified, 3 skipped.")
    expect(result.stdout).not.toContain("PROBE PASS")
  })

  test("a corrupt receipt fails instead of skipping", async () => {
    live = cloudflareDouble()
    const result = await runProbe(["--receipt", receiptFile("{ not json"), "--api-base", live.base], {
      CLOUDFLARE_API_TOKEN: "cf-token-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("the receipt is not JSON")
  })
})
