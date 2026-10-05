import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../../..", import.meta.url))

test("the deploy Shell.Run brokers the credential without exposing it to the child", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-credential-boundary-"))
  const token = crypto.randomUUID()
  const githubToken = crypto.randomUUID()
  const githubRequests: Array<string | null> = []
  const downloadRequests: Array<string | null> = []
  await mkdir(join(root, "archive/rollout"), { recursive: true })
  await writeFile(join(root, "archive/rollout/last-rollback.json"), '{"evidence":"restored"}')
  execFileSync("zip", ["-q", "-r", join(root, "receipt.zip"), "rollout"], { cwd: join(root, "archive") })
  const zip = await readFile(join(root, "receipt.zip"))
  const download = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    downloadRequests.push(request.headers.get("authorization"))
    return new Response(zip)
  } })
  const github = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    githubRequests.push(request.headers.get("authorization"))
    const path = new URL(request.url).pathname
    if (path.endsWith("/zip")) return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${download.port}/receipt.zip` } })
    return Response.json(path.endsWith("/artifacts")
      ? { artifacts: [{ id: 7, expired: false, workflow_run: { id: 8 } }] }
      : { path: ".github/workflows/apps-deploy.yml", event: "push", head_branch: "main", status: "completed" })
  } })
  const githubAudience = `http://127.0.0.1:${github.port}`
  const requests: Array<{ authorization: string | null; path: string }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ authorization: request.headers.get("authorization"), path: new URL(request.url).pathname })
      const path = new URL(request.url).pathname
      return Response.json({ success: true, result: path.endsWith("/verify") ? { status: "active" } : path.endsWith("/user") ? { email: "fixture@example.invalid" } : [] })
    }
  })
  const audience = `http://127.0.0.1:${upstream.port}`
  try {
    await symlink(join(repository, "node_modules"), join(root, "node_modules"))
    await mkdir(join(root, "apps/server/scripts"), { recursive: true })
    await writeFile(join(root, "package.json"), '{"name":"deploy-boundary","private":true,"type":"module"}\n')
    await writeFile(join(root, "yarn.lock"), "")
    await writeFile(join(root, "WORKSPACE.ts"), `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("deploy-boundary", {
  repository: "git+https://example.invalid/deploy-boundary.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`)
    await writeFile(join(root, "PACKAGE.ts"), `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  deploy: S.Shell.Run({
    shell: "cd apps/server && bun scripts/deploy.ts", manual: true, timeout: "55m",
    sandbox: "none",
    env: { CLOUDFLARE_API_BASE_URL: S.SecretOrigin(${JSON.stringify(audience)}) + "/client/v4",
      GITHUB_API_URL: S.SecretOrigin(${JSON.stringify(githubAudience)}), GITHUB_REPOSITORY: "smithersai/smithers" },
    secrets: [S.HttpSecret(S.Secret("CLOUDFLARE_API_TOKEN"), [${JSON.stringify(audience)}]),
      S.HttpSecret(S.Secret("GITHUB_TOKEN"), [${JSON.stringify(githubAudience)}])]
  })
} })
`)
    // This fixture performs only a GET against the loopback audience. It never
    // imports or executes the real deploy entry or contacts a real account.
    await writeFile(join(root, "apps/server/scripts/deploy.ts"), `import { writeFileSync } from "node:fs"
const child = Bun.spawn([process.execPath, "-e", 'const s = JSON.stringify({ env: process.env, argv: process.argv }); console.log(s); console.error(s)'], {
  env: process.env, stdout: "pipe", stderr: "pipe"
})
const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
if (exitCode !== 0) process.exit(exitCode)
const snapshot = JSON.stringify({ ...JSON.parse(stdout), stdout, stderr })
writeFileSync("receipt.json", snapshot)
console.log(snapshot)
console.error(snapshot)
const { api } = await import(${JSON.stringify(join(repository, "apps/server/scripts/cutover/cloudflare.ts"))})
await api("/workers/scripts/fixture/settings")
const { workerRolloutHost } = await import(${JSON.stringify(join(repository, "apps/server/scripts/rollout.ts"))})
const host = workerRolloutHost({ previous: { version: "fixture", revision: "fixture" }, serverDir: ".", accountId: "fixture", worker: "fixture",
  token: process.env.CLOUDFLARE_API_TOKEN, publish: async () => ({ version: "fixture", revision: "fixture" }), record: async () => {}, run: async () => ({ exitCode: 0, output: "" }) })
await host.check("CN-24", { version: "fixture", revision: "fixture" })
const adopt = Bun.spawn([process.execPath, ${JSON.stringify(join(repository, "apps/server/scripts/adopt-durable-objects.ts"))}], { env: process.env, stdout: "pipe", stderr: "pipe" })
await Promise.all([new Response(adopt.stdout).text(), new Response(adopt.stderr).text(), adopt.exited])
const { restoreRolloutReceipt } = await import(${JSON.stringify(join(repository, "apps/server/scripts/rollout-receipt.ts"))})
await restoreRolloutReceipt("smithersai/smithers", "restored")
const response = await fetch(process.env.CLOUDFLARE_API_BASE_URL + "/accounts", {
  headers: { authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN }, redirect: "error"
})
if (!response.ok) process.exit(1)
const wrangler = Bun.spawn(["node", ${JSON.stringify(join(repository, "apps/server/node_modules/wrangler/bin/wrangler.js"))}, "whoami"], {
  env: { ...process.env, CLOUDFLARE_API_BASE_URL: process.env.CLOUDFLARE_API_BASE_URL, WRANGLER_SEND_METRICS: "false" },
  stdout: "inherit", stderr: "inherit"
})
process.exit(await wrangler.exited)
`)
    execFileSync("git", ["init", "-q"], { cwd: root })
    execFileSync("git", ["add", "WORKSPACE.ts", "PACKAGE.ts", "package.json", "yarn.lock", "apps"], { cwd: root })
    execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root })
    const proc = Bun.spawn(["pnpm", "exec", "smthrs", "run", "//:deploy", "--workspace", root], {
      cwd: repository,
      // Do not let the fixture inherit the host's GitHub credentials.
      env: {
        PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), CLOUDFLARE_API_TOKEN: token, GITHUB_TOKEN: githubToken,
        COREPACK_HOME: process.env.COREPACK_HOME ?? join(process.env.HOME!, ".cache", "node", "corepack")
      },
      stdout: "pipe",
      stderr: "pipe"
    })
    const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
      ])
      expect(stdout).not.toContain(githubToken)
      expect(stderr).not.toContain(githubToken)
      expect(stdout).not.toContain(token)
      expect(stderr).not.toContain(token)
      expect(code, stdout + stderr).toBe(0)
      expect(requests).toContainEqual({ authorization: `Bearer ${token}`, path: "/client/v4/accounts" })
      expect(requests).toContainEqual({ authorization: `Bearer ${token}`, path: "/client/v4/user/tokens/verify" })
      expect(githubRequests).toEqual(Array(3).fill(`Bearer ${githubToken}`))
      expect(downloadRequests).toEqual([null])
      expect(JSON.parse(await readFile(join(root, "apps/server/restored/last-rollback.json"), "utf8"))).toEqual({ evidence: "restored" })
      expect(requests.some(request => request.path.endsWith("/versions/fixture"))).toBe(true)
      expect(requests.some(request => request.path.endsWith("/deployments"))).toBe(true)
      expect(requests.filter(request => request.path.endsWith("/settings"))).toHaveLength(2)
      expect(requests.every(request => request.authorization === `Bearer ${token}`)).toBe(true)
      const receipt = await readFile(join(root, "apps/server/receipt.json"), "utf8")
      expect(receipt).not.toContain(githubToken)
      expect(receipt).not.toContain(token)
      const snapshot = JSON.parse(receipt) as { env: Record<string, string>; argv: string[]; stdout: string; stderr: string }
      expect(snapshot.env.GITHUB_TOKEN).toMatch(/^smithers-build-secret-[a-f0-9]{64}$/)
      expect(snapshot.env.CLOUDFLARE_API_TOKEN).toMatch(/^smithers-build-secret-[a-f0-9]{64}$/)
      expect(snapshot.argv.join(" ")).not.toContain(token)
      expect(snapshot.stdout).toContain(snapshot.env.CLOUDFLARE_API_TOKEN!)
      expect(snapshot.stderr).toContain(snapshot.env.CLOUDFLARE_API_TOKEN!)
      expect(snapshot.env.CLOUDFLARE_API_BASE_URL).not.toBe(audience)
    } finally { clearTimeout(timer) }
  } finally {
    github.stop(true)
    download.stop(true)
    upstream.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 70_000)

test("the deploy guard's Cloudflare client uses the brokered base URL", async () => {
  const requests: Array<string> = []
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname)
    return Response.json({ success: true, result: [] })
  } })
  const origin = `http://127.0.0.1:${upstream.port}`
  try {
    const client = fileURLToPath(new URL("./cutover/cloudflare.ts", import.meta.url))
    const program = `const transport = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (new URL(String(url)).origin !== ${JSON.stringify(origin)}) throw new Error("Cloudflare client bypassed the broker");
  return transport(url, init);
};
const { api } = await import(${JSON.stringify(client)});
await api("/workers/scripts/fixture/settings");`
    const proc = Bun.spawn([process.execPath, "-e", program], {
      cwd: repository,
      env: { PATH: process.env.PATH, CLOUDFLARE_API_BASE_URL: origin + "/client/v4", CLOUDFLARE_API_TOKEN: `smithers-build-secret-${"0".repeat(64)}` },
      stdout: "pipe", stderr: "pipe"
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(code, stdout + stderr).toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatch(/^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/fixture\/settings$/)
  } finally { upstream.stop(true) }
})


test("failed receipt restore stops a real deploy before the interlock", async () => {
  let reads = 0
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { reads++; return new Response("refused", { status: 503 }) } })
  try {
    const proc = Bun.spawn([process.execPath, "scripts/deploy.ts"], {
      cwd: join(repository, "apps/server"),
      env: { PATH: process.env.PATH, GITHUB_API_URL: `http://127.0.0.1:${fake.port}`, GITHUB_REPOSITORY: "smithersai/smithers" },
      stdout: "pipe", stderr: "pipe"
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(code).toBe(1)
    expect(reads).toBe(1)
    expect(stderr).toContain("rollback receipt restore failed")
    expect(stdout + stderr).not.toContain("cutover interlock")
  } finally { fake.stop(true) }
})

test("the explicit deploy plans both brokered audiences and wildcard omits it", async () => {
  const plan = (label: string, flags: string[] = []) => execFileSync("pnpm", ["exec", "smthrs", "run", label, ...flags, "--plan"], {
    cwd: repository, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8"
  })
  const explicit = plan("//apps/server:deploy", ["--outward-only"])
  expect(explicit).toContain("none")
  // The CLI report currently omits env and timeout; inspect the same planner's inert work list.
  const buildCli = join(repository, "packages/smithers/build/build-cli")
  const program = `
import { openPackageIndex } from ${JSON.stringify(buildCli + "/src/Cli.ts")};
import { plan } from ${JSON.stringify(buildCli + "/src/PackageExec.ts")};
const index = await openPackageIndex({ workspace: ${JSON.stringify(repository)} });
const planned = await plan({ index, cacheDirectory: ".flows", verb: "run", patterns: ["//apps/server:deploy"], plan: true });
const node = planned.workList[0];
console.log(JSON.stringify({ cwd: node.cwd, argv: node.argv, timeoutMs: node.timeoutMs, env: node.env, secrets: node.secrets, cacheable: node.cacheable }));`
  const details = JSON.parse(execFileSync("node", ["--import", buildCli + "/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-e", program], {
    cwd: repository, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8"
  }))
  expect(details.cwd).toBe(".")
  expect(details.argv).toEqual(["/bin/sh", "-c", "cd apps/server && bun scripts/deploy.ts"])
  expect(details.timeoutMs).toBe(3_300_000)
  expect(details.cacheable).toBe(false)
  expect(JSON.stringify(details.env)).toContain("https://api.cloudflare.com")
  expect(JSON.stringify(details.env)).toContain("https://api.github.com")
  expect(details.secrets).toHaveLength(2)
  expect(explicit).not.toContain("unservable")
  expect(plan("//apps/server/...")).not.toContain("//apps/server:deploy")
}, 60_000)
