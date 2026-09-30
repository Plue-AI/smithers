import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WORKER_IDENTITY } from "../../src/workerIdentity"
import { FakeCloudflare } from "./install-fake"

/*
 * The sealed-inventory operator CLI (deploy.ts) run as real Bun child
 * processes against the repository's Cloudflare fixture over loopback. A lost
 * upload response is the fixture committing the upload and then closing the
 * connection without answering.
 */
setDefaultTimeout(60_000)
const parents: string[] = []
afterAll(() => { for (const parent of parents) rmSync(parent, { recursive: true, force: true }) })
const WORKER = WORKER_IDENTITY.name
const REVISION = "c".repeat(40)
const utf8 = (text: string) => new TextEncoder().encode(text)

/** The web Worker as prepare expects it: its six frozen Durable Objects and an immutable source annotation. */
const world = async () => {
  const fake = new FakeCloudflare(), w = fake.workers.get(WORKER)!, live = fake.live(WORKER)
  live.bindings = [{ type: "plain_text", name: "SMITHERS_BACKEND_ORIGIN", text: "https://api.jjhub.tech" },
    ...WORKER_IDENTITY.durableObjects.map((d, i) => ({ type: "durable_object_namespace", name: d.binding, class_name: d.className, namespace_id: (i + 1).toString(16).padStart(32, "0") }))]
  live.modules = [{ name: "index.js", type: "text/javascript", bytes: utf8(`${WORKER_IDENTITY.durableObjects.map(d => `export class ${d.className} {}`).join("\n")}\nexport default { fetch() { return new Response("web") } }`) }]
  live.message = `${REVISION} deploy`
  ;(w.deployments[0] as { annotations?: Record<string, string> }).annotations = { "workers/message": live.message }
  const parent = mkdtempSync(join(tmpdir(), "sealed-deploy-")); parents.push(parent)
  const dir = join(parent, "private")
  expect(Bun.spawnSync(["bun", join(import.meta.dir, "keys.ts"), dir]).exitCode).toBe(0)
  const originalId = live.id, originalBytes = live.modules[0]!.bytes
  /** One CLI command; `trap` names the request whose response the fixture drops after committing it. */
  const cli = async (mode: "prepare" | "apply" | "restore", drop?: (method: string, path: string) => boolean) => {
    const loopback = fake.serve(parent, (method, path) => drop?.(method, path) ? "drop-after" : undefined)
    try {
      const child = Bun.spawn(["bun", "--preload", loopback.preload, join(import.meta.dir, "deploy.ts"), mode, dir], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env, CLOUDFLARE_API_TOKEN: "fake-control-plane-token", SMITHERS_EXPORT_TARGET: "web" }
      })
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exitCode: await child.exited, stdout, stderr }
    } finally { loopback.stop() }
  }
  const puts = () => fake.mutations.filter(m => m === `put ${WORKER}`).length
  const prepared = (file: string) => join(dir, "prepared", file)
  const isPut = (method: string, path: string) => method === "PUT" && path.startsWith(`/workers/scripts/${WORKER}?`)
  expect((await cli("prepare")).exitCode).toBe(0)
  return { fake, cli, puts, prepared, isPut, originalId, originalBytes }
}

test("ordinary prepare, apply and restore round-trip the exact original entry", async () => {
  const { fake, cli, puts, prepared } = await world()
  expect((await cli("apply")).exitCode).toBe(0)
  expect(fake.live(WORKER).entry).toBe("sealed-export-entry.js")
  expect(existsSync(prepared("apply-intent.json"))).toBe(true)
  expect((await cli("restore")).exitCode).toBe(0)
  expect(fake.live(WORKER).entry).toBe("index.js")
  expect(puts()).toBe(2)
  // A finished apply or restore is never repeated.
  for (const mode of ["apply", "restore"] as const) {
    const again = await cli(mode)
    expect(again.exitCode).not.toBe(0)
    expect(again.stderr).toContain("already exists")
  }
  expect(puts()).toBe(2)
})

test("an accepted apply upload whose response is lost is reconciled by apply, then restored", async () => {
  const { fake, cli, puts, prepared, isPut, originalBytes } = await world()
  const lost = await cli("apply", isPut)
  expect(lost.exitCode).not.toBe(0)
  expect(existsSync(prepared("apply-intent.json"))).toBe(true)
  expect(existsSync(prepared("applied.json"))).toBe(false)
  expect(fake.live(WORKER).entry).toBe("sealed-export-entry.js")
  const uploads = puts()
  expect(uploads).toBeGreaterThanOrEqual(1)

  const again = await cli("apply")
  expect(again.stderr).toBe("")
  expect(again.exitCode).toBe(0)
  expect(puts()).toBe(uploads) // reconciled, never uploaded again
  const applied = JSON.parse(readFileSync(prepared("applied.json"), "utf8")) as { version: string; reconciled?: boolean }
  expect(applied).toMatchObject({ version: fake.live(WORKER).id, reconciled: true })
  expect(existsSync(prepared("verified.json"))).toBe(true)

  expect((await cli("restore")).exitCode).toBe(0)
  expect(fake.live(WORKER).entry).toBe("index.js")
  expect(fake.live(WORKER).modules[0]!.bytes).toEqual(originalBytes)
})

test("restore alone recovers an apply whose response was lost", async () => {
  const { fake, cli, puts, prepared, isPut } = await world()
  expect((await cli("apply", isPut)).exitCode).not.toBe(0)
  const uploads = puts()
  const restored = await cli("restore")
  expect(restored.exitCode).toBe(0)
  expect(puts()).toBe(uploads + 1)
  expect(JSON.parse(readFileSync(prepared("applied.json"), "utf8"))).toMatchObject({ reconciled: true })
  expect(fake.live(WORKER).entry).toBe("index.js")
})

test("a restore upload whose response is lost is reconciled without another upload", async () => {
  const { fake, cli, puts, prepared, isPut } = await world()
  expect((await cli("apply")).exitCode).toBe(0)
  expect((await cli("restore", isPut)).exitCode).not.toBe(0)
  expect(existsSync(prepared("restored.json"))).toBe(false)
  expect(fake.live(WORKER).entry).toBe("index.js")
  const uploads = puts()
  expect((await cli("restore")).exitCode).toBe(0)
  expect(puts()).toBe(uploads)
  expect(JSON.parse(readFileSync(prepared("restored.json"), "utf8"))).toMatchObject({ version: fake.live(WORKER).id, reconciled: true })
  expect(existsSync(prepared("restore-verified.json"))).toBe(true)
})

test("an unrelated deployment after a lost response is refused, never adopted or overwritten", async () => {
  const { fake, cli, puts, prepared, isPut } = await world()
  expect((await cli("apply", isPut)).exitCode).not.toBe(0)
  const foreign = fake.foreignDeploy(WORKER), uploads = puts()
  for (const mode of ["apply", "restore"] as const) {
    const refused = await cli(mode)
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr).toContain("reconciliation refused")
  }
  expect(fake.live(WORKER).id).toBe(foreign)
  expect(puts()).toBe(uploads)
  expect(existsSync(prepared("applied.json"))).toBe(false)
  // A version deployed from an older upload is not the newest upload either.
  fake.uploadOnly(WORKER)
  expect((await cli("apply")).stderr).toContain("not the newest upload")
})

test("restore without any apply is refused", async () => {
  const { cli, puts } = await world()
  const refused = await cli("restore")
  expect(refused.exitCode).not.toBe(0)
  expect(refused.stderr).toContain("Nothing was applied")
  expect(puts()).toBe(0)
})
