// J8's install until apps/app/e2e/proof/fixtures.ts lands (lane proof-harness). Run by bun as the
// proof config's webServer, like scripts/run-local-no-github.ts, whose exports it reuses. Two
// differences: real models (no stand-in and no proxy guard; the keys come from the 0600 file
// PROOF_KEYS and are never printed) and a bundle named by PROOF_BUNDLE whose revision is recorded,
// not required to equal HEAD. It writes test-results/proof/j8-run.json and stops on SIGTERM.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { verifyBundle } from "../../../../packages/smithers/src/internal/backend/HostService"
import { startNativeBackend, type NativeBackend } from "../../src/bun/NativeBackendProcess"
import { freePort, githubBases, layerSnapshots, setupLine, walkHome } from "../../scripts/run-local-no-github"
import { NODE_CANARY, README } from "../local/demo-repository"

/** main's webhook sender: T1's request makes it retry; T2 asks the same for Slack. Provider fixture data. */
export const J8_REPOSITORY: Readonly<Record<string, string>> = {
  "webhook.mjs": [
    "// Delivers one webhook. A failed delivery is lost.",
    "export async function deliver(send, event) {",
    "  return await send(event)",
    "}", ""
  ].join("\n"),
  "slack.mjs": [
    "// Posts one Slack notification. A failed post is lost.",
    "export async function notify(post, message) {",
    "  return await post(message)",
    "}", ""
  ].join("\n")
}

/** KEY=VALUE lines; the two keys setup's Model access needs. */
export const readKeys = (text: string): Record<string, string> => {
  const keys = Object.fromEntries(text.split("\n").filter(line => /^[A-Z_]+=\S/.test(line))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]))
  for (const name of ["AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY"]) if (!keys[name]) throw new Error(`The keys file needs ${name}`)
  return keys
}

const lines = (stream: ReadableStream<Uint8Array>, each: (line: string) => void) => void (async () => {
  const reader = stream.getReader()
  let rest = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    rest += new TextDecoder().decode(value)
    for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) { each(rest.slice(0, at)); rest = rest.slice(at + 1) }
  }
})()

async function main() {
  const app = resolve(import.meta.dir, "../.."), root = resolve(app, "../..")
  const { bundle, version: revision } = verifyBundle(process.env.PROOF_BUNDLE ?? join(app, ".native"))
  const keys = readKeys(readFileSync(process.env.PROOF_KEYS ?? join(homedir(), ".smithers-proof-keys.env"), "utf8"))
  await Promise.all([4000, 4001, 2222].map(freePort))
  const home = walkHome()
  const out = join(app, "test-results/proof"), receipt = join(out, "j8-run.json")
  mkdirSync(out, { recursive: true })
  const children: ReturnType<typeof Bun.spawn>[] = []
  let backend: NativeBackend | undefined, stopping: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    for (const child of children.reverse()) {
      child.kill("SIGTERM")
      if (!await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)])) child.kill("SIGKILL")
    }
    await backend?.stop()
    rmSync(receipt, { force: true })
    for (const name of layerSnapshots(join(home, "state/microvm/layers")))
      spawnSync(join(bundle, "bin/msb"), ["snapshot", "remove", "-q", name], { env: { HOME: homedir(), PATH: "/usr/bin:/bin", MSB_BACKEND: "local", NO_COLOR: "1" }, stdio: "inherit" })
    if (process.env.PROOF_KEEP) console.log(`Kept ${home}`)
    else rmSync(home, { recursive: true, force: true })
  })()
  const signal = () => { void stop().then(() => process.exit(0)) }
  process.on("SIGINT", signal); process.on("SIGTERM", signal)
  try {
    const executable = join(home, "githubfake")
    const build = Bun.spawn(["go", "build", "-o", executable, "./packages/backend/cmd/githubfake"], { cwd: root, stdout: "inherit", stderr: "inherit" })
    if (await build.exited !== 0) throw new Error("githubfake build failed")
    const gitRoot = join(home, "git"), seed = join(gitRoot, "seed")
    mkdirSync(join(gitRoot, "local-owner"), { recursive: true })
    const git = (args: string[]) => execFileSync(join(bundle, "bin/git"), args, { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_EXEC_PATH: join(bundle, "libexec/git-core"), GIT_TEMPLATE_DIR: join(bundle, "share/git-core/templates") }, stdio: "pipe" })
    git(["init", "-b", "main", seed])
    const files = { "JOURNEY.md": "Add a greeting to JOURNEY.md\n", "README.md": README, ...NODE_CANARY, ...J8_REPOSITORY }
    for (const [name, content] of Object.entries(files)) writeFileSync(join(seed, name), content, { mode: 0o600 })
    git(["-C", seed, "add", ...Object.keys(files)])
    git(["-C", seed, "-c", "user.name=Rehearsal", "-c", "user.email=owner@example.test", "commit", "-m", "Canary"])
    git(["clone", "--bare", seed, join(gitRoot, "local-owner/demo.git")])
    const fake = Bun.spawn([executable, "--addr", "127.0.0.1:0", "--git-root", gitRoot], { stdout: "pipe", stderr: "inherit" })
    children.push(fake)
    const fakeURL = await new Promise<string>((ok, fail) => {
      lines(fake.stdout as ReadableStream<Uint8Array>, line => { console.log(line); if (line.startsWith("ready ")) ok(line.slice(6)) })
      void fake.exited.then(code => fail(new Error(`githubfake exited ${code}`)))
      setTimeout(() => fail(new Error("githubfake startup timeout")), 30_000)
    })
    let handoff!: (url: string) => void
    const setup = new Promise<string>(ok => { handoff = ok })
    const started = startNativeBackend({
      stateDir: join(home, "state"), executablePath: join(bundle, "bin/smithers-server"),
      // Real models over the network: no model stand-in and no proxy guard. Only GitHub is the fake.
      env: { HOME: home, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: "en_US.UTF-8" },
      spawn: (argv, options) => {
        const child = Bun.spawn([...argv], { env: { ...options.env, ...githubBases(fakeURL) }, stdout: "pipe", stderr: "inherit" })
        lines(child.stdout, line => { const url = setupLine(line); if (url) handoff(url) })
        return child
      }
    })
    backend = await started
    const setupURL = await Promise.race([setup, Bun.sleep(30_000).then(() => { throw new Error("No setup_urls handoff") })])
    writeFileSync(receipt, JSON.stringify({ setupURL, fakeURL, home, revision, keys }), { mode: 0o600 })
    console.log(`J8 install ready at ${revision}`)
    const failure = await backend.failure
    if (failure) throw failure
  } finally { await stop() }
}
if (import.meta.main) main().catch(error => { console.error(String(error)); process.exit(1) })
