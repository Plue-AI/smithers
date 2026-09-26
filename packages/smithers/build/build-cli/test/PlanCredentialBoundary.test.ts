import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, expect, it } from "vitest"
import * as DockerExec from "../src/DockerExec.ts"
import * as GoExec from "../src/GoExec.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import type * as Workspace from "../src/Workspace.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const fixture = async (prefix: string): Promise<{
  readonly root: string
  readonly write: (relative: string, contents: string) => Promise<void>
}> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), prefix)))
  roots.push(root)
  const write = async (relative: string, contents: string): Promise<void> => {
    const path = Path.join(root, relative)
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    await Fs.writeFile(path, contents, "utf8")
  }
  return { root, write }
}

/** A workspace whose remote cache is authenticated by one declared name. */
const remoteCache: Workspace.RemoteCacheAccess = {
  endpoint: "https://cache.example.invalid",
  credentials: { _tag: "split", readTokenEnv: "MY_CACHE_READ_TOKEN", writeTokenEnv: "MY_CACHE_WRITE_TOKEN" },
  readToken: () => "read-token-must-not-cross",
  writeToken: () => "write-token-must-not-cross",
  publishNamespace: undefined
}

const credentialEnvironment = (path: string): Record<string, string> => ({
  PATH: path,
  HOME: Path.dirname(path),
  MY_CACHE_READ_TOKEN: "read-token-must-not-cross",
  MY_CACHE_WRITE_TOKEN: "write-token-must-not-cross",
  SMITHERS_CACHE_URL: "https://cache.example.invalid",
  SMITHERS_CACHE_TOKEN: "default-token-must-not-cross"
})

/** The names a plan-time tool must never observe, whatever the host holds. */
const withheld = [
  "MY_CACHE_READ_TOKEN",
  "MY_CACHE_WRITE_TOKEN",
  "SMITHERS_CACHE_URL",
  "SMITHERS_CACHE_TOKEN"
] as const

/**
 * `docs/cli.md` promises that every name a workspace marks sensitive is
 * stripped from the environment of every spawned tool. Planning spawns host
 * tools too: `forge config` evaluates `foundry.toml` and its profile, which is
 * workspace-controlled input running under the CLI's own environment. The
 * strip therefore has to happen before the plan captures the host environment,
 * not only before a target executes.
 */
it.skipIf(process.platform === "win32")(
  "withholds workspace-declared cache credentials from a plan-time forge subprocess",
  async () => {
    const { root, write } = await fixture("smithers-plan-credential-forge-")
    const observed = Path.join(root, "observed.json")
    const binDir = Path.join(root, "bin")
    await write(
      "bin/forge",
      `#!/bin/sh\n` +
        `if [ "$1" = "--version" ]; then printf 'forge Version: 1.0.0-fixture\\n'; exit 0; fi\n` +
        `if [ "$1" = "config" ]; then\n` +
        `  node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' ${
          JSON.stringify(observed)
        }\n` +
        `  printf '{"out":"out","cache_path":"cache","cache":true}\\n'\n` +
        `  exit 0\n` +
        `fi\n` +
        `exit 1\n`
    )
    await Fs.chmod(Path.join(binDir, "forge"), 0o755)
    await write("package.json", "{\"name\":\"plan-credential-forge\",\"private\":true,\"type\":\"module\"}\n")
    await write(
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const Workspace = S.Workspace("plan-credential-forge", {
  repository: "git+https://example.invalid/plan-credential-forge.git",
  cache: S.Cache({ directory: ".flows" }), runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`
    )
    await write(
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const config = S.file("foundry.toml")
const srcs = S.Filegroup({ srcs: S.glob(["src/**", "foundry.toml"]) })
const artifacts = S.Foundry.Build({ config, data: [srcs], outDirs: ["out"], sandbox: { network: true } })
export const Package = S.Package({ targets: { artifacts, srcs } })
`
    )
    await write("foundry.toml", "[profile.default]\nsrc = \"src\"\nout = \"out\"\n")
    await write("src/Counter.sol", "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Counter {}\n")

    const environment = credentialEnvironment(
      [binDir, Path.dirname(process.execPath)].join(Path.delimiter)
    )
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const plan = await PackageExec.plan({
      index: PackageIndex.make(loaded),
      patterns: ["//:artifacts"],
      cacheDirectory: ".flows",
      verb: "build",
      plan: true,
      environment,
      remoteCache
    })
    expect(plan.nodes.get("//:artifacts")?.refusal).toBeUndefined()

    const seen = JSON.parse(await Fs.readFile(observed, "utf8")) as Record<string, string>
    for (const name of withheld) expect(seen[name]).toBeUndefined()
    // The probe still runs with the lookup capabilities the plan needs.
    expect(seen["PATH"]).toContain(binDir)
  },
  60_000
)

/**
 * `go version`, `go env` and `go list` all honour `GOFLAGS` and `GOTOOLCHAIN`
 * from workspace-controlled files, and `nix develop` runs the flake's
 * `shellHook`. Both spawned with `process.env` underneath the environment the
 * plan supplies, which put every withheld name back. A supplied environment is
 * now the whole environment.
 */
it.skipIf(process.platform === "win32")(
  "runs plan-time go probes under the supplied environment alone",
  async () => {
    const { root, write } = await fixture("smithers-plan-credential-go-")
    const observed = Path.join(root, "observed.json")
    const binDir = Path.join(root, "bin")
    await write(
      "bin/go",
      `#!/bin/sh\n` +
        `if [ "$1" = "version" ]; then printf 'go version go1.26.0 test/amd64\\n'; exit 0; fi\n` +
        `if [ "$1" = "env" ]; then\n` +
        `  node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' ${
          JSON.stringify(observed)
        }\n` +
        `  printf '{"GOROOT":"%s","GOTOOLDIR":"%s"}\\n' ${JSON.stringify(root)} ${JSON.stringify(binDir)}\n` +
        `  exit 0\n` +
        `fi\n` +
        `exit 1\n`
    )
    await Fs.chmod(Path.join(binDir, "go"), 0o755)
    await Fs.mkdir(Path.join(root, "bin2"), { recursive: true })

    process.env["SMITHERS_PLAN_AMBIENT_CANARY"] = "ambient-must-not-cross"
    try {
      const resolved = await GoExec.resolveGo({
        root,
        packagePath: "",
        workspace: { toolchains: [] } as never,
        environment: { PATH: [binDir, Path.dirname(process.execPath)].join(Path.delimiter), HOME: root }
      })
      expect(resolved.ok, "ok" in resolved ? "" : (resolved as { refusal: string }).refusal).toBe(true)
      const seen = JSON.parse(await Fs.readFile(observed, "utf8")) as Record<string, string>
      expect(seen["SMITHERS_PLAN_AMBIENT_CANARY"]).toBeUndefined()
      expect(seen["PATH"]).toContain(binDir)
    } finally {
      delete process.env["SMITHERS_PLAN_AMBIENT_CANARY"]
    }
  },
  60_000
)

it.skipIf(process.platform === "win32")(
  "runs `nix develop` under the supplied environment alone",
  async () => {
    const { root, write } = await fixture("smithers-plan-credential-nix-")
    const observed = Path.join(root, "observed.json")
    const binDir = Path.join(root, "bin")
    await write(
      "bin/nix",
      `#!/bin/sh\n` +
        `node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' ${
          JSON.stringify(observed)
        }\n` +
        `printf '%s\\n' ${JSON.stringify(Path.join(binDir, "declared-tool"))}\n`
    )
    await Fs.chmod(Path.join(binDir, "nix"), 0o755)

    process.env["SMITHERS_PLAN_AMBIENT_CANARY"] = "ambient-must-not-cross"
    try {
      const resolved = await GoExec.resolveNix("declared-tool", {
        root,
        packagePath: "",
        workspace: { toolchains: [] } as never,
        environment: { PATH: [binDir, Path.dirname(process.execPath)].join(Path.delimiter), HOME: root }
      })
      expect(resolved.ok, "ok" in resolved ? "" : (resolved as { refusal: string }).refusal).toBe(true)
      const seen = JSON.parse(await Fs.readFile(observed, "utf8")) as Record<string, string>
      expect(seen["SMITHERS_PLAN_AMBIENT_CANARY"]).toBeUndefined()
      expect(seen["PATH"]).toContain(binDir)
    } finally {
      delete process.env["SMITHERS_PLAN_AMBIENT_CANARY"]
    }
  },
  60_000
)

/**
 * `docker --version`, `docker info` and `docker buildx ls` took no environment
 * at all, so they inherited the CLI's whole process environment.
 */
it.skipIf(process.platform === "win32")(
  "probes docker under the supplied environment alone",
  async () => {
    const { root, write } = await fixture("smithers-plan-credential-docker-")
    const observed = Path.join(root, "observed.json")
    const binDir = Path.join(root, "bin")
    await write(
      "bin/docker",
      `#!/bin/sh\n` +
        `node -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(process.env) + "\\n")' ${
          JSON.stringify(observed)
        }\n` +
        `if [ "$1" = "info" ]; then printf '27.0.0\\n'; exit 0; fi\n` +
        `printf 'Docker version 27.0.0\\n'\n`
    )
    await Fs.chmod(Path.join(binDir, "docker"), 0o755)

    process.env["SMITHERS_PLAN_AMBIENT_CANARY"] = "ambient-must-not-cross"
    try {
      const resolved = await DockerExec.resolveDocker({
        PATH: [binDir, Path.dirname(process.execPath)].join(Path.delimiter),
        HOME: root
      })
      expect(resolved.ok, resolved.ok ? "" : resolved.refusal).toBe(true)
      const rows = (await Fs.readFile(observed, "utf8")).trim().split("\n").map((line) =>
        JSON.parse(line) as Record<string, string>
      )
      expect(rows.length).toBeGreaterThanOrEqual(2)
      for (const seen of rows) {
        expect(seen["SMITHERS_PLAN_AMBIENT_CANARY"]).toBeUndefined()
        expect(seen["PATH"]).toContain(binDir)
      }
    } finally {
      delete process.env["SMITHERS_PLAN_AMBIENT_CANARY"]
    }
  },
  60_000
)
