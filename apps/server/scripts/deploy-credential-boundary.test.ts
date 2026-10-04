import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../../..", import.meta.url))

for (const shape of ["requested", "current"] as const) test(`the ${shape} deploy Shell.Run brokers the credential without exposing it to the child`, async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-credential-boundary-"))
  const token = crypto.randomUUID()
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
    await mkdir(join(root, "scripts"))
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
    ${shape === "requested" ? 'command: "bun scripts/deploy.ts", manual: true,' : 'shell: "bun scripts/deploy.ts",'}
    sandbox: "none",
    env: { CLOUDFLARE_API_BASE_URL: S.SecretOrigin(${JSON.stringify(audience)}) },
    secrets: [S.HttpSecret(S.Secret("CLOUDFLARE_API_TOKEN"), [${JSON.stringify(audience)}])]
  })
} })
`)
    // This fixture performs only a GET against the loopback audience. It never
    // imports or executes the real deploy entry or contacts a real account.
    await writeFile(join(root, "scripts/deploy.ts"), `import { writeFileSync } from "node:fs"
const child = Bun.spawn([process.execPath, "-e", 'const s = JSON.stringify({ env: process.env, argv: process.argv }); console.log(s); console.error(s)'], {
  env: process.env, stdout: "pipe", stderr: "pipe"
})
const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
if (exitCode !== 0) process.exit(exitCode)
const snapshot = JSON.stringify({ ...JSON.parse(stdout), stdout, stderr })
writeFileSync("receipt.json", snapshot)
console.log(snapshot)
console.error(snapshot)
const response = await fetch(process.env.CLOUDFLARE_API_BASE_URL + "/client/v4/accounts", {
  headers: { authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN }, redirect: "error"
})
if (!response.ok) process.exit(1)
const wrangler = Bun.spawn(["node", ${JSON.stringify(join(repository, "apps/server/node_modules/wrangler/bin/wrangler.js"))}, "whoami"], {
  env: { ...process.env, CLOUDFLARE_API_BASE_URL: process.env.CLOUDFLARE_API_BASE_URL + "/client/v4", WRANGLER_SEND_METRICS: "false" },
  stdout: "inherit", stderr: "inherit"
})
process.exit(await wrangler.exited)
`)
    execFileSync("git", ["init", "-q"], { cwd: root })
    execFileSync("git", ["add", "WORKSPACE.ts", "PACKAGE.ts", "package.json", "yarn.lock", "scripts"], { cwd: root })
    execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root })
    const proc = Bun.spawn(["pnpm", "exec", "smthrs", "run", "//:deploy", "--workspace", root], {
      cwd: repository,
      // Do not let the fixture inherit the host's GitHub credentials.
      env: {
        PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), CLOUDFLARE_API_TOKEN: token,
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
      expect(stdout).not.toContain(token)
      expect(stderr).not.toContain(token)
      expect(code, stdout + stderr).toBe(0)
      expect(requests).toContainEqual({ authorization: `Bearer ${token}`, path: "/client/v4/accounts" })
      expect(requests).toContainEqual({ authorization: `Bearer ${token}`, path: "/client/v4/user/tokens/verify" })
      expect(requests.every(request => request.authorization === `Bearer ${token}`)).toBe(true)
      const receipt = await readFile(join(root, "receipt.json"), "utf8")
      expect(receipt).not.toContain(token)
      const snapshot = JSON.parse(receipt) as { env: Record<string, string>; argv: string[]; stdout: string; stderr: string }
      expect(snapshot.env.CLOUDFLARE_API_TOKEN).toMatch(/^smithers-build-secret-[a-f0-9]{64}$/)
      expect(snapshot.argv.join(" ")).not.toContain(token)
      expect(snapshot.stdout).toContain(snapshot.env.CLOUDFLARE_API_TOKEN!)
      expect(snapshot.stderr).toContain(snapshot.env.CLOUDFLARE_API_TOKEN!)
      expect(snapshot.env.CLOUDFLARE_API_BASE_URL).not.toBe(audience)
    } finally { clearTimeout(timer) }
  } finally {
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
      env: { PATH: process.env.PATH, CLOUDFLARE_API_BASE_URL: origin, CLOUDFLARE_API_TOKEN: `smithers-build-secret-${"0".repeat(64)}` },
      stdout: "pipe", stderr: "pipe"
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(code, stdout + stderr).toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatch(/^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/fixture\/settings$/)
  } finally { upstream.stop(true) }
})
