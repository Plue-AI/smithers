/**
 * The standard tools, placed inside a real sandbox and run there.
 *
 * `Write`, `Read`, `Edit`, and `Bash` are `@smthrs/std` tools that a sandbox
 * has to host: the file a tool writes must land inside the sandbox and not on
 * the host, and a hermetic `Bash` must see the same tree the other three wrote.
 * The suite proves that against both backends — `DirectorySandbox` on the host
 * filesystem and `ContainerSandbox` inside a real Alpine machine — because a
 * placement that works on one and not the other is exactly the defect a
 * conformance suite over a single backend cannot see.
 *
 * It injects no fault, so it is an ordinary integration suite rather than a
 * member of the `faults` tier, and it skips without a container engine the way
 * `RealContainerSandbox.integration.test.ts` beside it does.
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import { CommandSandbox, ContainerSandbox, DirectorySandbox, Sandbox } from "@smthrs/sandbox"
import { Bash, Edit, Read, Write } from "@smthrs/std"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { platform } from "./helpers/containedPlatform.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-sandbox-tool-placement-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const original = ["alpha=one", "payload=written unchanged", "omega=three"].join("\n")
const oldString = "payload=written unchanged"
const newString = "payload=edited unchanged"
const edited = original.replace(oldString, newString)

interface ToolPlacementOptions {
  readonly session: string
  readonly input: string
  readonly output: string
  readonly probeAlpine?: boolean
}

const placeTools = (provider: Sandbox.Provider, options: ToolPlacementOptions) =>
  Effect.scoped(
    Effect.gen(function*() {
      const services = yield* Layer.build(Sandbox.layerHost(provider, { session: options.session }))

      const write = yield* Write.run({ path: options.input, content: original }).pipe(
        Effect.provide(services)
      )
      const hostInputExistsAfterWrite = existsSync(options.input)
      const read = yield* Read.run({ path: options.input }).pipe(Effect.provide(services))
      const edit = yield* Edit.run({
        path: options.input,
        oldString,
        newString
      }).pipe(Effect.provide(services))
      const bash = yield* Bash.run({
        mode: "hermetic",
        command: `cat ${CommandLine.quote(options.input)} | tee ${CommandLine.quote(options.output)}`,
        reads: [options.input],
        writes: [options.output]
      }).pipe(Effect.provide(services))
      const product = yield* Read.run({ path: options.output }).pipe(Effect.provide(services))
      // Script mode is the tool's stdin path: the program text reaches the
      // interpreter on standard input, which every sandbox must deliver.
      const scripted = yield* Bash.run({
        mode: "hermetic",
        interpreter: "sh",
        script: `wc -c < ${CommandLine.quote(options.output)} | tr -d " "`,
        reads: [options.output],
        writes: []
      }).pipe(Effect.provide(services))

      let osRelease: Bash.Output | undefined
      if (options.probeAlpine === true) {
        osRelease = yield* Bash.run({
          mode: "hermetic",
          command: "cat /etc/os-release",
          reads: ["/etc/os-release"],
          writes: []
        }).pipe(Effect.provide(services))
      }

      return { write, read, edit, bash, product, scripted, hostInputExistsAfterWrite, osRelease }
    })
  )

type ToolPlacement = Effect.Success<ReturnType<typeof placeTools>>

const expectRoundTrip = (result: ToolPlacement, input: string, output: string) => {
  expect(result.write).toEqual({
    path: input,
    bytesWritten: new TextEncoder().encode(original).byteLength,
    created: true
  })
  expect(result.read).toEqual({
    content: original,
    startLine: 1,
    endLine: 3,
    totalLines: 3,
    truncated: false
  })
  expect(result.edit).toEqual({
    path: input,
    replacements: 1,
    startLine: 1,
    endLine: 3,
    hunk: edited
  })
  expect(result.bash).toEqual({
    exitCode: 0,
    stdout: edited,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0
  })
  expect(result.product).toEqual({
    content: edited,
    startLine: 1,
    endLine: 3,
    totalLines: 3,
    truncated: false
  })
  expect(result.scripted).toMatchObject({ exitCode: 0, stderr: "" })
  expect(result.scripted.stdout.trim()).toBe(String(new TextEncoder().encode(edited).byteLength))
  expect(result.write.path).toBe(input)
  expect(result.product.content).toBe(edited)
  expect(output).not.toBe(input)
}

const identity = `${process.pid}-${Date.now()}`

describe("standard tool placement on DirectorySandbox", () => {
  it("runs the unchanged std handlers against real files and processes", async () => {
    const input = join(root, `tool-input-${identity}.txt`)
    const output = join(root, `tool-output-${identity}.txt`)
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner
        const provider = DirectorySandbox.make({ fs, spawner, root })
        return yield* placeTools(provider, {
          session: `directory-tool-placement-${identity}`,
          input,
          output
        })
      }).pipe(Effect.provide(platform))
    )

    expectRoundTrip(result, input, output)
    expect(result.hostInputExistsAfterWrite).toBe(true)
  }, 30_000)
})

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0
const missingEngine = dockerAvailable
  ? undefined
  : "no container engine answers `docker info` on this host"

// The skip has to be visible, and it has to name what is missing: a case that
// silently disappears is indistinguishable from one that never existed, and one
// that disappears without a reason is indistinguishable from a suite quietly
// switched off.
describe.skipIf(dockerAvailable)("standard tool placement on ContainerSandbox", () => {
  it(`is skipped because ${missingEngine ?? "this host runs a container engine"}`, () => {
    expect(missingEngine).toEqual(expect.any(String))
  })
})

describe.skipIf(!dockerAvailable)("standard tool placement on ContainerSandbox", () => {
  it("runs the unchanged std handlers inside a real Alpine machine", async () => {
    const input = `/workspace/tool-input-${identity}.txt`
    const output = `/workspace/tool-output-${identity}.txt`
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const provider = ContainerSandbox.make({ spawner, image: "alpine:3.20" })
        return yield* placeTools(provider, {
          session: `container-tool-placement-${identity}`,
          input,
          output,
          probeAlpine: true
        })
      }).pipe(Effect.provide(platform))
    )

    expectRoundTrip(result, input, output)
    expect(result.hostInputExistsAfterWrite).toBe(false)
    expect(result.osRelease).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.osRelease?.stdout).toContain("Alpine Linux")
  }, 180_000)
})

// `Write` creates its temporary file exclusively, which the provider serves
// with GNU or BusyBox `ln -T`; a Cloud box is Linux, and so is CI.
const linuxHost = process.platform === "linux"
describe.skipIf(linuxHost)("standard tool placement on CommandSandbox", () => {
  it("is skipped because this host is not Linux, so `ln -T` is unavailable to the empty prefix", () => {
    expect(linuxHost).toBe(false)
  })
})
describe.skipIf(!linuxHost)("standard tool placement on CommandSandbox", () => {
  it("runs the unchanged std handlers through an argv prefix, in the provider's workdir", async () => {
    const workdir = join(root, "command-machine")
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        return yield* placeTools(CommandSandbox.make({ spawner, prefix: [], workdir }), {
          session: `command-tool-placement-${identity}`,
          input: "tool-input.txt",
          output: "tool-output.txt"
        })
      }).pipe(Effect.provide(platform))
    )

    expectRoundTrip(result, "tool-input.txt", "tool-output.txt")
    // Relative to the workdir, never to this process's cwd.
    expect(result.hostInputExistsAfterWrite).toBe(false)
    expect(existsSync(join(workdir, "tool-input.txt"))).toBe(true)
  }, 60_000)
})

// `ssh localhost` stands in for a Cloud workspace: the prefix joins the guest
// argv into one remote command line, which is the quoting a real box needs.
const sshReachable = linuxHost &&
  spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "localhost", "true"], { stdio: "ignore" })
      .status === 0
describe.skipIf(sshReachable)("standard tool placement on CommandSandbox over ssh", () => {
  it("is skipped because this host is not Linux or `ssh -o BatchMode=yes localhost true` fails", () => {
    expect(sshReachable).toBe(false)
  })
})
describe.skipIf(!sshReachable)("standard tool placement on CommandSandbox over ssh", () => {
  it("runs the unchanged std handlers over ssh", async () => {
    const workdir = join(root, "ssh-machine")
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        return yield* placeTools(
          CommandSandbox.make({ spawner, prefix: ["ssh", "-o", "BatchMode=yes", "localhost"], workdir }),
          { session: `ssh-tool-placement-${identity}`, input: "tool-input.txt", output: "tool-output.txt" }
        )
      }).pipe(Effect.provide(platform))
    )
    expectRoundTrip(result, "tool-input.txt", "tool-output.txt")
    expect(existsSync(join(workdir, "tool-input.txt"))).toBe(true)
  }, 60_000)
})
