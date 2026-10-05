// Test orchestration only: reuse the bundle launcher instead of a second env builder.
import { randomBytes } from "node:crypto"
import { NODE_CANARY, README } from "../e2e/local/demo-repository"
import { launchModelProvider, type ModelProvider } from "../e2e/real/support/model-provider-process"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { resolve, join } from "node:path"
import { verifyBundle } from "../../../packages/smithers/src/internal/backend/HostService"
import { startNativeBackend, type NativeBackend } from "../src/bun/NativeBackendProcess"

export const githubBases = (url: string) => ({
  SMITHERS_GITHUB_APP_API_BASE_URL: url,
  SMITHERS_AUTH_GITHUB_API_BASE_URL: url,
  SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL: url
})
/** Every built-in model provider's origin: the install sends Model access tests and chat turns to the stand-in. */
export const modelBase = (origin: string) => ({ SMITHERS_MODEL_PROVIDER_ORIGIN: origin })
export const proxyGuard ={ HTTP_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost,::1" }
export const setupLine = (line: string): string | undefined => {
  if (!line.startsWith('{"setup_urls"')) return undefined
  if (/[\r\n]/.test(line)) throw new Error("Invalid setup handoff")
  const value = JSON.parse(line)
  if (Object.keys(value).join() !== "setup_urls" || !Array.isArray(value.setup_urls) || !value.setup_urls.length ||
    value.setup_urls.some((u: unknown) => typeof u !== "string" || !/^https?:\/\//.test(u))) throw new Error("Invalid setup handoff")
  return value.setup_urls[0]
}
// The installed backend refuses a data root below a group- or world-writable
// directory such as /tmp (spec 17.3), so each run gets a fresh private
// directory in the account's caches.
export const walkHome = (account = homedir()): string => {
  const caches = join(account, "Library/Caches")
  mkdirSync(caches, { recursive: true, mode: 0o700 })
  return mkdtempSync(join(caches, "smithers-local-"))
}
// Layer snapshots live in the account's Microsandbox home, outside the run's
// data root; the run's layer records name the ones this install built.
export const layerSnapshots = (records: string): string[] => {
  let files: string[]
  try { files = readdirSync(records).filter(name => name.endsWith(".json")) } catch { return [] }
  return files.flatMap(file => {
    try {
      const name: unknown = JSON.parse(readFileSync(join(records, file), "utf8")).name
      return typeof name === "string" && /^smthrs-(tc|dp)-[0-9a-f]{8}-[0-9a-f]{20}$/.test(name) ? [name] : []
    } catch { return [] }
  })
}
export const freePort = (port: number): Promise<void> => new Promise((ok, fail) => {
  const server = createServer()
  server.once("error", () => fail(new Error(`Port ${port} must be free`)))
  server.listen(port, () => server.close(err => err ? fail(err) : ok()))
})

export async function main() {
  if (process.getuid?.() === 0) throw new Error("Run as your logged-in user, never root")
  if (process.argv.slice(2).some(arg => arg !== "--no-browser" && arg !== "--keep")) throw new Error("Usage: local:no-github [--no-browser] [--keep]")
  const keep = process.argv.includes("--keep")
  const app = resolve(import.meta.dir, ".."), root = resolve(app, "../..")
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  let bundle: string
  try {
    const verified = verifyBundle(join(app, ".native"))
    if (verified.version !== revision) throw new Error("revision differs from HEAD")
    bundle = verified.bundle
  } catch (error) { throw new Error(`${error}\nBuild: pnpm exec smthrs build //apps/app:serverBundle`) }
  await Promise.all([4000, 4001, 2222].map(freePort))
  const home = walkHome()
  const out = join(app, "test-results/local-no-github")
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, "steps.tsv"), "step\tactual\texpected\towner\n", { mode: 0o600 })
  const receipt = join(out, "run.json")
  let backend: NativeBackend | undefined, fake: ReturnType<typeof Bun.spawn> | undefined, browser: ReturnType<typeof Bun.spawn> | undefined
  let backendChild: ReturnType<typeof Bun.spawn> | undefined, buildChild: ReturnType<typeof Bun.spawn> | undefined
  let modelProvider: ModelProvider | undefined
  let stopping: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    for (const child of [browser, fake, buildChild, ...(backend ? [] : [backendChild])]) {
      if (!child) continue
      child.kill("SIGTERM")
      if (!await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)])) child.kill("SIGKILL")
      await child.exited
    }
    try { await backend?.stop() } finally { await modelProvider?.close() }
    rmSync(receipt, { force: true })
    if (keep) console.log(`Kept ${home}`)
    else {
      for (const name of layerSnapshots(join(home, "state/microvm/layers")))
        spawnSync(join(bundle, "bin/msb"), ["snapshot", "remove", "-q", name], { env: { HOME: homedir(), PATH: "/usr/bin:/bin", MSB_BACKEND: "local", NO_COLOR: "1" }, stdio: "inherit" })
      rmSync(home, { recursive: true, force: true })
    }
  })()
  const signal = () => { void stop().then(() => process.exit(0)) }
  process.on("SIGINT", signal); process.on("SIGTERM", signal)
  try {
    const modelKey = randomBytes(24).toString("hex")
    modelProvider = await launchModelProvider({ key: modelKey })
    const executable = join(home, "githubfake")
    const build = buildChild = Bun.spawn(["go", "build", "-o", executable, "./packages/backend/cmd/githubfake"], { cwd: root, stdout: "inherit", stderr: "inherit" })
    if (await build.exited !== 0) throw new Error("githubfake build failed")
    // Seed real Git objects for the fake's existing smart-HTTP transport.
    // These are provider fixture data, never product setup state.
    const gitRoot = join(home, "git"), seed = join(gitRoot, "seed")
    mkdirSync(join(gitRoot, "local-owner"), { recursive: true })
    const git = (args: string[]) => execFileSync(join(bundle, "bin/git"), args, { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_EXEC_PATH: join(bundle, "libexec/git-core"), GIT_TEMPLATE_DIR: join(bundle, "share/git-core/templates") }, stdio: "pipe" })
    git(["init", "-b", "main", seed])
    writeFileSync(join(seed, "JOURNEY.md"), "Add a greeting to JOURNEY.md\n", { mode: 0o600 })
    writeFileSync(join(seed, "README.md"), README, { mode: 0o600 })
    for (const [name, content] of Object.entries(NODE_CANARY)) writeFileSync(join(seed, name), content, { mode: 0o600 })
    git(["-C", seed, "add", "JOURNEY.md", "README.md", ...Object.keys(NODE_CANARY)])
    git(["-C", seed, "-c", "user.name=Rehearsal", "-c", "user.email=owner@example.test", "commit", "-m", "Canary"])
    git(["clone", "--bare", seed, join(gitRoot, "local-owner/demo.git")])
    fake = Bun.spawn([executable, "--addr", "127.0.0.1:0", "--git-root", gitRoot], { stdout: "pipe", stderr: "inherit" })
    let ready!: (url: string) => void
    const fakeReady = new Promise<string>(resolve => { ready = resolve })
    void (async () => {
      const reader = fake!.stdout as ReadableStream<Uint8Array>
      let rest = ""
      const stream = reader.getReader()
      while (true) {
        const { done, value: chunk } = await stream.read()
        if (done) break
        rest += new TextDecoder().decode(chunk)
        let at: number
        while ((at = rest.indexOf("\n")) >= 0) {
          const line = rest.slice(0, at); rest = rest.slice(at + 1)
          console.log(line)
          if (line.startsWith("ready ")) ready(line.slice(6))
        }
      }
    })()
    const fakeURL = await Promise.race([fakeReady, fake.exited.then(code => { throw new Error(`githubfake exited ${code}`) }), Bun.sleep(30_000).then(() => { throw new Error("githubfake startup timeout") })])
    let handoff!: (url: string) => void
    const setup = new Promise<string>(resolve => { handoff = resolve })
    backend = await startNativeBackend({
      stateDir: join(home, "state"), executablePath: join(bundle, "bin/smithers-server"),
      env: { HOME: home, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: "en_US.UTF-8", ...proxyGuard },
      spawn: (argv, options) => {
        const child = backendChild = Bun.spawn([...argv], { env: { ...options.env, ...githubBases(fakeURL), ...modelBase(modelProvider!.origin) }, stdout: "pipe", stderr: "inherit" })
        void (async () => {
          let rest = ""
          const stream = child.stdout.getReader()
          while (true) {
            const { done, value: chunk } = await stream.read()
            if (done) break
            rest += new TextDecoder().decode(chunk)
            let at: number
            while ((at = rest.indexOf("\n")) >= 0) {
              const line = rest.slice(0, at); rest = rest.slice(at + 1)
              const url = setupLine(line)
              if (url) handoff(url)
            }
          }
        })().catch(error => { console.error(error); void stop().then(() => process.exit(1)) })
        return child
      }
    })
    const setupURL = await Promise.race([setup, Bun.sleep(30_000).then(() => { throw new Error("No setup_urls handoff") })])
    const run = { setupURL, fakeURL, revision, home, modelOrigin: modelProvider.origin, modelKey }
    writeFileSync(join(home, "run.json"), JSON.stringify(run), { mode: 0o600 })
    writeFileSync(receipt, JSON.stringify(run), { mode: 0o600 })
    chmodSync(receipt, 0o600)
    console.log(`SETUP_URL=${setupURL}\nType owner: local-owner. Ctrl-C stops everything${keep ? ` and keeps ${home}` : " and deletes this run's data"}.`)
    if (!process.argv.includes("--no-browser")) {
      browser = Bun.spawn(["node", "--experimental-strip-types", join(app, "e2e/local/open.ts"), receipt], { cwd: app, stdout: "inherit", stderr: "inherit" })
      void browser.exited.then(() => signal())
    }
    const failure = await Promise.race([backend.failure, fake.exited.then(code => stopping ? undefined : new Error(`githubfake exited unexpectedly ${code}`))])
    if (failure) throw failure
  } finally { await stop() }
}
if (import.meta.main) main().catch(error => { console.error(String(error)); process.exit(1) })
