import { Smithers as S } from "@smthrs/targets"
import type * as Target from "@smthrs/targets/Target"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"
import * as MemoryBackend from "../src/MemoryBackend.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const forceSpec = NodePath.resolve(import.meta.dirname, "fixtures/force-spec")

const openIndex = async (): Promise<PackageIndex> => {
  const discovery = await PackageDiscovery.discover(forceSpec)
  const loaded = await PackageLoader.load(discovery)
  return PackageIndex.make(loaded)
}

const temporaryRoot = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-memory-"))))

const retainTarget = (): Target.AnyTarget => S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["commit", "unit"] })

const memory = S.Memory.SmithersCloud({ bank: ["repo"] })

const noCli: MemoryBackend.CliLocator = { find: async () => undefined }

const recordingCli = (): {
  readonly cli: MemoryBackend.MemoryCli
  readonly calls: Array<{ binary: string; args: ReadonlyArray<string>; cwd: string }>
} => {
  const calls: Array<{ binary: string; args: ReadonlyArray<string>; cwd: string }> = []
  return {
    calls,
    cli: {
      run: async (binary, args, cwd) => {
        calls.push({ binary, args, cwd })
        return { exitCode: 0, stdout: "retained\n", stderr: "" }
      }
    }
  }
}

describe("unavailable backend", () => {
  it("is a typed notice when the workspace declares no backend", async () => {
    await expect(MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory: undefined,
      locator: noCli
    })).rejects.toMatchObject({
      _tag: "smithers-build/MemoryBackendUnavailable",
      code: "no_backend_declared"
    })
  })

  it("is a typed notice when the smithers CLI is not on PATH", async () => {
    const attempt = MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory,
      locator: noCli
    })
    await expect(attempt).rejects.toMatchObject({
      _tag: "smithers-build/MemoryBackendUnavailable",
      code: "cli_not_found"
    })
    const error = await attempt.catch((cause) => cause)
    expect(MemoryBackend.isMemoryBackendUnavailable(error)).toBe(true)
    expect((error as Error).message).toContain("memory backend unavailable")
  })

  it("never spawns anything on either unavailable path", async () => {
    const { calls, cli } = recordingCli()
    await MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory: undefined,
      locator: noCli,
      cli
    }).catch(() => undefined)
    await MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory,
      locator: noCli,
      cli
    }).catch(() => undefined)
    expect(calls).toEqual([])
  })
})

describe("pathLocator", () => {
  it("finds an executable smithers on the configured PATH", async () => {
    const root = await temporaryRoot()
    const bin = NodePath.join(root, "bin")
    await Fs.mkdir(bin)
    const binary = NodePath.join(bin, "smithers")
    await Fs.writeFile(binary, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 })
    const locator = MemoryBackend.pathLocator({ PATH: `${NodePath.join(root, "empty")}${NodePath.delimiter}${bin}` })
    expect(await locator.find()).toBe(binary)
  })

  it("returns undefined when no directory on PATH carries one", async () => {
    const root = await temporaryRoot()
    const locator = MemoryBackend.pathLocator({ PATH: root })
    expect(await locator.find()).toBeUndefined()
  })

  it("returns undefined for an empty PATH", async () => {
    const locator = MemoryBackend.pathLocator({})
    expect(await locator.find()).toBeUndefined()
  })
})

const sha = "1234567890abcdef1234567890abcdef12345678"
const resolveSource = async (): Promise<string> => sha

describe("resolved backend", () => {
  it("writes one memory set per declared bank, keyed from the resolved source ref", async () => {
    const index = await openIndex()
    const [row] = index.resolve("//:retainCommit")
    const workspaceMemory = index.workspace.memory
    expect(workspaceMemory).toBeDefined()
    const { calls, cli } = recordingCli()
    const result = await MemoryBackend.retain({
      root: forceSpec,
      target: row!.target,
      memory: workspaceMemory,
      locator: { find: async () => "/opt/fake/smithers" },
      cli,
      resolveSource
    })
    const record = JSON.stringify({ source: "HEAD", commit: sha, tags: ["commit"] })
    expect(calls).toEqual([{
      binary: "/opt/fake/smithers",
      args: ["memory", "set", "repo", `commit:${sha}`, record],
      cwd: forceSpec
    }])
    expect(result).toEqual({
      binary: "/opt/fake/smithers",
      facts: [{
        namespace: "repo",
        key: `commit:${sha}`,
        args: ["memory", "set", "repo", `commit:${sha}`, record],
        stdout: "retained\n"
      }]
    })
  })

  it("only ever invokes subcommands the installed CLI ships (captured help fixture)", async () => {
    const help = await Fs.readFile(
      NodePath.resolve(import.meta.dirname, "fixtures/smithers-memory-help.txt"),
      "utf8"
    )
    const shipped = MemoryBackend.parseMemoryHelpCommands(help)
    expect(shipped).toEqual(["get", "list", "rm", "set"])
    // Every subcommand the backend believes in must be in the captured help.
    for (const command of MemoryBackend.memoryCliCommands) {
      expect(shipped).toContain(command)
    }
    // And the argv retain actually builds must name a shipped subcommand:
    // this is the test that fails if retain reverts to `memory retain`.
    const { calls, cli } = recordingCli()
    await MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory,
      locator: { find: async () => "/opt/fake/smithers" },
      cli,
      resolveSource
    })
    for (const call of calls) {
      expect(call.args[0]).toBe("memory")
      expect(shipped).toContain(call.args[1])
    }
  })

  it("refuses a subcommand outside the CLI contract as a typed missing capability", () => {
    expect(() => MemoryBackend.assertMemoryCliCommand("retain")).toThrow(MemoryBackend.MemoryCapabilityMissing)
    try {
      MemoryBackend.assertMemoryCliCommand("retain")
    } catch (cause) {
      expect(MemoryBackend.isMemoryCapabilityMissing(cause)).toBe(true)
      expect((cause as Error).message).toContain("retain")
      expect((cause as Error).message).toContain("get, list, rm, set")
    }
  })

  it("surfaces a nonzero backend exit as a typed command failure naming the argv", async () => {
    const attempt = MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory,
      locator: { find: async () => "/opt/fake/smithers" },
      cli: {
        run: async () => ({ exitCode: 3, stdout: "", stderr: "bank not found\n" })
      },
      resolveSource
    })
    await expect(attempt).rejects.toMatchObject({
      _tag: "smithers-build/MemoryCommandFailed",
      exitCode: 3,
      stderr: "bank not found\n"
    })
    const error = await attempt.catch((cause) => cause)
    expect(MemoryBackend.isMemoryCommandFailed(error)).toBe(true)
    expect((error as Error).message).toContain("memory set repo")
    expect((error as Error).message).toContain("bank not found")
  })

  it("includes the argv and stdout in the failure text when stderr is empty", async () => {
    const attempt = MemoryBackend.retain({
      root: forceSpec,
      target: retainTarget(),
      memory,
      locator: { find: async () => "/opt/fake/smithers" },
      cli: {
        run: async () => ({ exitCode: 4, stdout: "Unknown command: retain\n", stderr: "" })
      },
      resolveSource
    })
    const error = await attempt.catch((cause) => cause)
    expect(MemoryBackend.isMemoryCommandFailed(error)).toBe(true)
    expect((error as Error).message).toContain("exited 4")
    expect((error as Error).message).toContain(`smithers memory set repo commit:${sha}`)
    expect((error as Error).message).toContain("Unknown command: retain")
  })

  it("succeeds against a fake CLI that mirrors the real subcommand names", async () => {
    const root = await temporaryRoot()
    const binary = NodePath.join(root, "smithers")
    // The fake accepts exactly the shipped surface (get|list|rm|set) and
    // answers anything else the way smithers 0.33 does: exit 4, no stderr.
    await Fs.writeFile(
      binary,
      `#!/bin/sh
if [ "$1" != "memory" ]; then exit 4; fi
case "$2" in
  get|list|rm|set) printf 'ok %s %s' "$3" "$4"; exit 0 ;;
  *) exit 4 ;;
esac
`,
      { encoding: "utf8", mode: 0o755 }
    )
    const cli = MemoryBackend.spawnCli()
    const good = await cli.run(binary, ["memory", "set", "repo", "commit:abc", "{}"], root)
    expect(good).toEqual({ exitCode: 0, stdout: "ok repo commit:abc", stderr: "" })
    const absent = await cli.run(binary, ["memory", "retain", "--source", "HEAD"], root)
    expect(absent).toEqual({ exitCode: 4, stdout: "", stderr: "" })
  })

  it("refuses a non-Memory.Retain target before resolving anything", async () => {
    const commit = S.Git.Commit({ gates: [], message: "chore: wrong flavor" })
    await expect(MemoryBackend.retain({
      root: forceSpec,
      target: commit,
      memory,
      locator: noCli
    })).rejects.toThrow("expected a Memory.Retain target")
  })

  it("resolves the declared ref through git in the workspace root by default", async () => {
    const root = await temporaryRoot()
    const write = async (relative: string, text: string): Promise<void> => {
      await Fs.writeFile(NodePath.join(root, relative), text, "utf8")
    }
    await write("file.txt", "hello\n")
    const git = (args: ReadonlyArray<string>): void => {
      NodeChildProcess.execFileSync("git", ["-C", root, ...args])
    }
    git(["init", "-q"])
    git(["add", "-A"])
    git(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"])
    const head = NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    const { calls, cli } = recordingCli()
    await MemoryBackend.retain({
      root,
      target: retainTarget(),
      memory,
      locator: { find: async () => "/opt/fake/smithers" },
      cli
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[3]).toBe(`commit:${head}`)
  })

  it("fails readably when the declared ref does not resolve", async () => {
    const root = await temporaryRoot()
    // Not a git repository: the default resolver's git call fails.
    await expect(MemoryBackend.retain({
      root,
      target: retainTarget(),
      memory,
      locator: { find: async () => "/opt/fake/smithers" },
      cli: recordingCli().cli
    })).rejects.toThrow(/cannot resolve HEAD/)
  })
})

vi.mock("../src/internal/ContainedProcess.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ContainedProcess>()
  return { ...actual, run: vi.fn(actual.run) }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("subprocess boundaries", () => {
  it("strips default and workspace cache credentials without restoring ambient values", async () => {
    for (const name of ["SMITHERS_CACHE_URL", "SMITHERS_CACHE_TOKEN", "TEST_WORKSPACE_CACHE_CREDENTIAL"]) {
      vi.stubEnv(name, "invented-test-marker")
    }
    const output = await MemoryBackend.spawnCli({
      environment: { ...process.env, TEST_ALLOWED: "kept" },
      sensitiveNames: ["TEST_WORKSPACE_CACHE_CREDENTIAL"]
    }).run(process.execPath, [
      "-e",
      `process.stdout.write(JSON.stringify({
      url: process.env.SMITHERS_CACHE_URL, token: process.env.SMITHERS_CACHE_TOKEN,
      custom: process.env.TEST_WORKSPACE_CACHE_CREDENTIAL, allowed: process.env.TEST_ALLOWED
    }))`
    ], Os.tmpdir())
    expect(output.exitCode).toBe(0)
    expect(JSON.parse(output.stdout)).toEqual({ allowed: "kept" })
  })

  it.each(["git", "cli"] as const)("aborts a hung memory %s subprocess", async (kind) => {
    const controller = new AbortController()
    const actual = await vi.importActual<typeof ContainedProcess>("../src/internal/ContainedProcess.ts")
    vi.mocked(ContainedProcess.run).mockImplementationOnce((options) => {
      const pending = actual.run({
        ...options,
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(9), 1500)"]
      })
      setTimeout(() => controller.abort(), 20)
      return pending
    })
    await expect(MemoryBackend.retain({
      root: Os.tmpdir(),
      target: retainTarget(),
      memory,
      locator: { find: async () => process.execPath },
      ...(kind === "cli" ? { resolveSource } : {}),
      signal: controller.signal,
      timeoutMs: 10_000
    })).rejects.toThrow(/abort/i)
  })

  it.each(["git", "cli"] as const)("bounds a hung memory %s subprocess with a timeout", async (kind) => {
    const actual = await vi.importActual<typeof ContainedProcess>("../src/internal/ContainedProcess.ts")
    vi.mocked(ContainedProcess.run).mockImplementationOnce((options) =>
      actual.run({
        ...options,
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(9), 1500)"]
      })
    )
    await expect(MemoryBackend.retain({
      root: Os.tmpdir(),
      target: retainTarget(),
      memory,
      locator: { find: async () => process.execPath },
      ...(kind === "cli" ? { resolveSource } : {}),
      timeoutMs: 30
    })).rejects.toThrow(/timed out after 30ms/)
  })
})
