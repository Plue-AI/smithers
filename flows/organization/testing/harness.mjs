/**
 * What the organization host's end-to-end suites share: a copy of the
 * example organization, a fixture repository, a restartable scripted host
 * process over its own state directory, the CLI, and the sweep that removes
 * exactly the microVMs those hosts booted.
 */
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import * as MicrosandboxSandbox from "../../../packages/smithers/flows/sandbox/src/MicrosandboxSandbox/index.ts"
import { operations, readCredential, rpc } from "../client.ts"
import * as Setup from "../setup/microsandbox.ts"

const flowsRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const checkout = dirname(flowsRoot)
const example = join(checkout, "packages/smithers/agent/organization/example/Org")
const scriptedHost = join(flowsRoot, "organization/testing/scripted-host.ts")
const cli = join(flowsRoot, "organization/cli.ts")
export const line = "hello from the organization"
const logs = process.env.SMITHERS_ORGANIZATION_E2E_LOGS

export const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Why this host cannot boot a microVM, or `undefined` when it can. */
export const unbootable = () => {
  if (Setup.locate() === undefined) return "the microsandbox SDK is not installed"
  if (process.platform === "darwin") {
    const sysctl = (name) => spawnSync("sysctl", ["-n", name], { encoding: "utf8" }).stdout.trim()
    if (sysctl("kern.hv_support") !== "1") return "this macOS host reports no Hypervisor.framework support"
    if (sysctl("kern.hv_vmm_present") === "1") return "this macOS host is itself a guest without nested virtualization"
    return undefined
  }
  if (process.platform === "linux") {
    return spawnSync("test", ["-r", "/dev/kvm", "-a", "-w", "/dev/kvm"]).status === 0 ? undefined : "this Linux host exposes no usable /dev/kvm"
  }
  return `microsandbox reaches no hypervisor on ${process.platform}`
}

const freePort = () => new Promise((resolve) => {
  const server = createServer()
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

/** The environment every child runs with: no model keys, no Slack, nothing ambient to reach. */
const childEnvironment = () => {
  const env = {}
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) if (process.env[name] !== undefined) env[name] = process.env[name]
  return env
}

const scratch = []
const installations = []
const hosts = []

/** A copy of the example organization, with `edit` applied to its files. */
export const organization = (edit = () => {}) => {
  const root = mkdtempSync(join(tmpdir(), "organization-e2e-root-"))
  scratch.push(root)
  cpSync(example, join(root, "Org"), { recursive: true })
  edit(join(root, "Org"))
  return root
}

/**
 * Makes the organization root a git checkout whose `main` tracks a local bare
 * remote, with `wiki.commit`, `wiki.sync: push`, and `wiki.webUrl`, so the
 * host pushes a page before it posts a link to it. Returns the bare remote.
 */
export const wikiRemote = (root, webUrl = "https://github.com/example/wiki/blob/main") => {
  const page = join(root, "Org/Organization.md")
  writeFileSync(page, readFileSync(page, "utf8").replace(
    "  commit: false\n  push: false\n",
    `  commit: true\n  push: false\n  sync: push\n  webUrl: ${webUrl}\n`
  ))
  const bare = mkdtempSync(join(tmpdir(), "organization-e2e-wiki-"))
  scratch.push(bare)
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.name", "Fixture")
  git(root, "config", "user.email", "fixture@example.invalid")
  git(root, "add", ".")
  git(root, "commit", "-qm", "Organization")
  git(root, "remote", "add", "origin", bare)
  git(root, "push", "-q", "-u", "origin", "main")
  return bare
}

/** Whether the bare remote's `main` holds `path`. */
export const pushed = (bare, path) => spawnSync("git", ["--git-dir", bare, "cat-file", "-e", `main:${path}`]).status === 0

/** A fixture repository named `example/demo` in the example roster's grants. */
export const repository = () => {
  const repo = mkdtempSync(join(tmpdir(), "organization-e2e-repo-"))
  scratch.push(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Fixture")
  git(repo, "config", "user.email", "fixture@example.invalid")
  writeFileSync(join(repo, "README.md"), "# Demo\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "Fixture")
  return repo
}

/**
 * One organization host process over a state directory, restartable. The
 * fixture repository is configured under `repository`, the name the roster's
 * grants give it.
 */
export const host = async (root, repo, environment = {}, repository = "example/demo") => {
  const stateDir = mkdtempSync(join(tmpdir(), "organization-e2e-state-"))
  scratch.push(stateDir)
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let child
  let output = ""
  // The host writes its credential at its first start; each call reads the current one.
  const credential = () => readCredential(stateDir)
  const handle = {
    base,
    port,
    stateDir,
    credential,
    output: () => output,
    ops: operations({ call: (tag, payload) => rpc(base, credential()).call(tag, payload) }),
    start: async () => {
      child = spawn(process.execPath, [scriptedHost, "serve", "--standalone", "--root", root, "--state-dir", stateDir,
        "--repo", `${repository}=${repo}`, "--port", String(port), "--check", `readme=grep -qx '${line}' README.md`], {
        cwd: checkout,
        env: { ...childEnvironment(), ...environment },
        stdio: ["ignore", "pipe", "pipe"]
      })
      child.stdout.on("data", (data) => { output += data })
      child.stderr.on("data", (data) => { output += data })
      for (let i = 0; i < 600; i++) {
        if (child.exitCode !== null) throw new Error(`the host exited: ${output}`)
        if (await fetch(`${base}/health`).then((response) => response.ok, () => false)) {
          const installation = readFileSync(join(stateDir, "installation"), "utf8").trim()
          if (!installations.includes(installation)) installations.push(installation)
          return
        }
        await pause(100)
      }
      throw new Error(`the host did not listen: ${output}`)
    },
    stop: async (signal = "SIGTERM") => {
      if (child === undefined || child.exitCode !== null) return
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill(signal)
      await exited
    }
  }
  hosts.push(handle)
  return handle
}

/** Runs the CLI against a host, with its state directory's credential, and returns its exit status and output. */
export const invoke = (handle, ...args) =>
  spawnSync(process.execPath, [cli, ...args, "--port", String(handle.port), ...(args.includes("--state-dir") ? [] : ["--state-dir", handle.stateDir])], {
    cwd: checkout,
    env: childEnvironment(),
    encoding: "utf8",
    timeout: 240_000
  })

/** Runs the CLI against a host and returns its output; a non-zero exit fails. */
export const run = (handle, ...args) => {
  const result = invoke(handle, ...args)
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`)
  return result.stdout.trim()
}

/** Waits until a run reaches one of `statuses`. */
export const settled = async (handle, runId, statuses = ["completed", "failed", "cancelled"], timeoutMs = 240_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [view] = await handle.ops.runs({ runId })
    if (view !== undefined && statuses.includes(view.status)) return view
    await pause(500)
  }
  throw new Error(`${runId} never reached ${statuses.join("/")}: ${handle.output()}`)
}

export const receipt = (root, key) => JSON.parse(readFileSync(join(root, "Org/Runs", key.replaceAll(/[^A-Za-z0-9._-]/g, "-"), "deliver.json"), "utf8"))
export const branches = (repo) => git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/organization/").split("\n").filter(Boolean)

/** Stops every host, keeps their logs when asked, removes their machines and scratch directories. */
export const cleanup = async () => {
  for (const handle of hosts) await handle.stop()
  if (logs !== undefined) {
    mkdirSync(logs, { recursive: true })
    hosts.forEach((handle, index) => writeFileSync(join(logs, `${process.pid}-host-${index}.log`), handle.output()))
  }
  if (installations.length > 0 && Setup.locate() !== undefined) {
    const sdk = await Setup.sdkOf(Setup.locate())
    sdk.setDefaultBackend("local")
    for (const owner of installations) {
      await Effect.runPromise(MicrosandboxSandbox.reap({ sdk, owner, isAlive: () => Effect.succeed(false) }))
    }
  }
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
}
