/**
 * `approval: "required"` through the public CLI: the planner asks the host's
 * durable approval store for the exact revision before anything spawns, and a
 * granted revision runs every declared push in order. Docker is a recording
 * fake on PATH; the store is the `RuntimeConfig.approvals` seam the unified
 * CLI fills with its control database.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { approvalRevision } from "../src/Cli.ts"
import type * as PackageExec from "../src/PackageExec.ts"
import { serve } from "./helpers/ServeCli.ts"

const directories: Array<string> = []
afterAll(async () => {
  await Promise.all(directories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

interface Fixture {
  readonly root: string
  readonly calls: () => Promise<ReadonlyArray<string>>
  readonly environment: Record<string, string | undefined>
  readonly setTags: (tags: ReadonlyArray<string>) => Promise<void>
}

const packageSource = (tags: ReadonlyArray<string>, secrets = "[]") =>
  `import { Smithers as S } from "@smthrs/targets"

const image = S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: ".", data: [S.file("hello.txt")] })
const push = S.Docker.Push({
  image,
  registry: "127.0.0.1:5999",
  name: "fixture",
  tags: ${JSON.stringify(tags)},
  secrets: ${secrets},
  sandbox: "none",
  approval: "required"
})

export const Package = S.Package({ targets: { image, push } })
`

/** A workspace whose fake Docker records every call and fails `push` for the tags in `failing`. */
const fixture = async (
  tags: ReadonlyArray<string>,
  options: { readonly failing?: ReadonlyArray<string>; readonly secrets?: string } = {}
): Promise<Fixture> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-target-approval-")))
  directories.push(root)
  await Fs.mkdir(Path.join(root, ".smithers"))
  await Fs.writeFile(
    Path.join(root, ".smithers", "WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"

export const Workspace = S.Workspace("approval-fixture", {
  repository: "git+https://example.invalid/approval-fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  host: S.Host({ bins: ["docker"] })
})
`
  )
  await Fs.writeFile(
    Path.join(root, "package.json"),
    "{ \"name\": \"approval-fixture\", \"private\": true, \"packageManager\": \"pnpm@11.25.0\" }\n"
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await Fs.writeFile(Path.join(root, "Dockerfile"), "FROM scratch\nCOPY hello.txt /hello.txt\n")
  await Fs.writeFile(Path.join(root, "hello.txt"), "hello\n")
  await Fs.writeFile(Path.join(root, "PACKAGE.ts"), packageSource(tags, options.secrets))
  const bin = Path.join(root, ".fake-bin")
  await Fs.mkdir(bin)
  const log = Path.join(bin, "calls.txt")
  const failing = (options.failing ?? []).map((tag) => `*:${tag}) exit 23;;`).join("\n  ")
  await Fs.writeFile(
    Path.join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
--version|info) echo 'fixture engine';;
buildx)
  if [ "$2" = "build" ]; then
    for arg in "$@"; do
      case "$arg" in type=oci,dest=*) dest="\${arg#type=oci,dest=}"; mkdir -p "$(dirname "$dest")"; echo image > "$dest";; esac
    done
  fi
  echo 'fixture engine';;
push)
  case "$2" in
  ${failing}
  *) ;;
  esac;;
*) exit 97;;
esac
`,
    { mode: 0o755 }
  )
  return {
    root,
    environment: { ...process.env, PATH: `${bin}${Path.delimiter}${process.env["PATH"] ?? ""}` },
    calls: async () =>
      (await Fs.readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })).split("\n").filter((line) => line !== ""),
    setTags: (next) => Fs.writeFile(Path.join(root, "PACKAGE.ts"), packageSource(next, options.secrets))
  }
}

/** An in-memory store granting exactly the revisions in `approved`, recording every question. */
const memoryStore = (approved: Set<string> = new Set()) => {
  const asked: Array<PackageExec.TargetApprovalRequest> = []
  const store: PackageExec.TargetApprovals = {
    granted: async (request) => {
      asked.push(request)
      return approved.has(`${request.label}@${request.digest}`)
    }
  }
  return { store, asked, approve: (label: string, digest: string) => approved.add(`${label}@${digest}`) }
}

const pushes = (calls: ReadonlyArray<string>) => calls.filter((line) => line.startsWith("push "))

describe("approval: \"required\" through the public CLI", { timeout: 60_000 }, () => {
  it("refuses without an approval store and pushes nothing", async () => {
    const workspace = await fixture(["one", "two"])
    const result = await serve(workspace.root, ["//:push"], { environment: workspace.environment })

    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("this host has no approval store")
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("asks the store for the planned revision and refuses an unapproved one before any effect", async () => {
    const workspace = await fixture(["one", "two"])
    const memory = memoryStore()
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    const planned = await serve(workspace.root, ["//:push", "--plan"], {
      environment: workspace.environment,
      approvals: memory.store
    })
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })

    expect(revision).toEqual({
      root: workspace.root,
      label: "//:push",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(planned.output).toContain(revision.digest)
    expect(memory.asked).toEqual([revision, revision])
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain(
      `revision ${revision.digest.slice(0, 12)} is not approved; approve it with: smthrs approvals grant //:push`
    )
    expect(await workspace.calls()).not.toContainEqual(expect.stringMatching(/^(push|buildx build)/))
  })

  it("pushes every declared tag in order once the revision is approved", async () => {
    const workspace = await fixture(["one", "two", "three"])
    const memory = memoryStore()
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    memory.approve(revision.label, revision.digest)
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })

    expect(result.exitCode, `${result.output}${result.logs}`).toBe(0)
    expect(pushes(await workspace.calls())).toEqual([
      "push 127.0.0.1:5999/fixture:one",
      "push 127.0.0.1:5999/fixture:two",
      "push 127.0.0.1:5999/fixture:three"
    ])
  })

  it("stops at the first failed push under the run verb and reports failure", async () => {
    const workspace = await fixture(["one", "two", "three"], { failing: ["two"] })
    const memory = memoryStore()
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    memory.approve(revision.label, revision.digest)
    const result = await serve(workspace.root, ["run", "//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })

    expect(result.exitCode).toBe(1)
    expect(pushes(await workspace.calls())).toEqual([
      "push 127.0.0.1:5999/fixture:one",
      "push 127.0.0.1:5999/fixture:two"
    ])
  })

  it("does not carry an approval over to an edited declaration or input", async () => {
    const workspace = await fixture(["one"])
    const memory = memoryStore()
    const first = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    memory.approve(first.label, first.digest)
    await workspace.setTags(["one", "two"])
    const retagged = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    await Fs.writeFile(Path.join(workspace.root, "hello.txt"), "edited\n")
    const rebuilt = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })

    expect(new Set([first.digest, retagged.digest, rebuilt.digest]).size).toBe(3)
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("is not approved")
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("fails closed when the store cannot answer", async () => {
    const workspace = await fixture(["one"])
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: { granted: () => Promise.reject(new Error("approval store unreadable")) }
    })

    expect(result.exitCode).toBe(1)
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("keeps the secret boundary after approval: a declared secret with no value pushes nothing", async () => {
    const workspace = await fixture(["one", "two"], {
      secrets: "[S.HttpSecret(S.Secret(\"FIXTURE_REGISTRY_TOKEN\"), [\"https://127.0.0.1:5999\"])]"
    })
    const memory = memoryStore()
    const environment = { ...workspace.environment, FIXTURE_REGISTRY_TOKEN: undefined }
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, { environment })
    memory.approve(revision.label, revision.digest)
    const result = await serve(workspace.root, ["//:push"], { environment, approvals: memory.store })

    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("FIXTURE_REGISTRY_TOKEN")
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("refuses to name a revision for a target that needs no approval", async () => {
    const workspace = await fixture(["one"])
    await expect(approvalRevision("//:image", { workspace: workspace.root }, { environment: workspace.environment }))
      .rejects.toThrow("//:image does not declare approval: \"required\"")
  })
})
