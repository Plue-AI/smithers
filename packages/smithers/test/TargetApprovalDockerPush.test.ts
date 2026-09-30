/**
 * `S.Docker.Push` through the real `smthrs` executable against a local
 * registry container: refused until `smthrs approvals grant`, then every
 * declared tag pushed in order, and a failed tag stops the rest.
 *
 * `Docker.Build` writes an OCI archive and does not load it into the daemon,
 * so the pushed references are tagged here first (#3153).
 */
import { execFile, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const base = "alpine:3"
const registryImage = "registry:2"

const docker = (args: ReadonlyArray<string>, timeout = 600_000) =>
  spawnSync("docker", args, { encoding: "utf8", timeout })

/** Why this host cannot run the case, or undefined when it can. */
const unavailable = ((): string | undefined => {
  const info = docker(["info", "--format", "{{.ServerVersion}}"], 60_000)
  if (info.error !== undefined || info.status !== 0) return "Docker daemon unavailable"
  for (const image of [base, registryImage]) {
    if (docker(["image", "inspect", image]).status === 0) continue
    if (docker(["pull", "-q", image], 300_000).status !== 0) return `cannot pull ${image}`
  }
  return undefined
})()

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => typeof address === "object" && address !== null ? resolve(address.port) : reject())
    })
  })

const smthrs = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<{ readonly status: number; readonly output: string }>((resolve) => {
    execFile(process.execPath, ["--no-warnings", executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 480_000,
      env: { ...process.env, SMITHERS_REMOTE: "" }
    }, (error, stdout, stderr) => {
      const code = (error as { readonly code?: unknown } | null)?.code
      resolve({ status: error === null ? 0 : typeof code === "number" ? code : 1, output: `${stdout}${stderr}` })
    })
  })

let root = ""
let registry = ""
let container = ""
const name = `approval-${process.pid}-${Date.now()}`
const pushed = new Set<string>()

const tags = async (): Promise<ReadonlyArray<string>> => {
  const response = await fetch(`http://${registry}/v2/${name}/tags/list`)
  if (response.status === 404) return []
  return ((await response.json()) as { readonly tags?: ReadonlyArray<string> | null }).tags ?? []
}

const declare = (declared: ReadonlyArray<string>) =>
  writeFileSync(
    join(root, "PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"

const image = S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: ".", data: [S.file("hello.txt")] })
const push = S.Docker.Push({
  image,
  registry: ${JSON.stringify(registry)},
  name: ${JSON.stringify(name)},
  tags: ${JSON.stringify(declared)},
  sandbox: "none",
  approval: "required"
})

export const Package = S.Package({ targets: { image, push } })
`
  )

const tagLocally = (tag: string) => {
  const reference = `${registry}/${name}:${tag}`
  expect(docker(["tag", base, reference]).status).toBe(0)
  pushed.add(reference)
}

beforeAll(async () => {
  if (unavailable !== undefined) return
  root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-docker-push-")))
  registry = `127.0.0.1:${await freePort()}`
  const started = docker(["run", "-d", "--rm", "-p", `${registry}:5000`, registryImage])
  expect(started.status, started.stderr).toBe(0)
  container = started.stdout.trim()
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await fetch(`http://${registry}/v2/`).catch(() => undefined))?.ok === true) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  mkdirSync(join(root, ".smithers"))
  writeFileSync(
    join(root, ".smithers", "WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"

export const Workspace = S.Workspace("docker-push-approval", {
  repository: "git+https://example.invalid/docker-push-approval.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  host: S.Host({ bins: ["docker"] })
})
`
  )
  writeFileSync(
    join(root, "package.json"),
    "{ \"name\": \"docker-push-approval\", \"private\": true, \"packageManager\": \"pnpm@11.25.0\" }\n"
  )
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\nCOPY hello.txt /hello.txt\n")
  writeFileSync(join(root, "hello.txt"), "hello\n")
}, 1_200_000)

afterAll(() => {
  if (container !== "") docker(["rm", "-f", container])
  if (pushed.size > 0) docker(["rmi", ...pushed])
  if (root !== "") rmSync(root, { recursive: true, force: true })
}, 300_000)

describe("Docker.Push through the public CLI", () => {
  it.skipIf(unavailable !== undefined)(
    `waits for approval, then pushes every tag in order and stops at a failed one${
      unavailable === undefined ? "" : ` [skipped: ${unavailable}]`
    }`,
    { timeout: 1_800_000 },
    async () => {
      declare(["one", "two", "three"])
      for (const tag of ["one", "two", "three"]) tagLocally(tag)

      const refused = await smthrs(root, ["target", "//:push"])
      expect(refused.status).toBe(1)
      expect(refused.output).toContain("smthrs approvals grant //:push")
      expect(await tags()).toEqual([])

      const granted = await smthrs(root, ["approvals", "grant", "//:push", "--json"])
      expect(granted.status, granted.output).toBe(0)
      expect(JSON.parse(granted.output)).toMatchObject({ label: "//:push", receipt: "Accepted" })

      const ran = await smthrs(root, ["target", "//:push"])
      expect(ran.status, ran.output).toBe(0)
      expect([...await tags()].sort()).toEqual(["one", "three", "two"])

      // `five` is never tagged locally, so its push fails and `six` never starts.
      declare(["four", "five", "six"])
      tagLocally("four")
      tagLocally("six")
      expect((await smthrs(root, ["target", "//:push"])).status).toBe(1)
      expect((await smthrs(root, ["approvals", "grant", "//:push"])).status).toBe(0)
      const failed = await smthrs(root, ["target", "//:push"])
      expect(failed.status).toBe(1)
      expect([...await tags()].sort()).toEqual(["four", "one", "three", "two"])
    }
  )
})
