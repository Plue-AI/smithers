/**
 * The native confinement over fake host facts: what it hands the host spawner
 * for each mechanism, how a shell request is made explicit, what happens when
 * the host has no mechanism, and what it leaves behind.
 */
import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import type * as KernelProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import { Effect, Exit, Scope } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const directories = new Set<string>()

const fixture = () => {
  const base = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "flows-confinement-")))
  directories.add(base)
  const workspace = NodePath.join(base, "workspace")
  const temporary = NodePath.join(base, "tmp")
  NodeFs.mkdirSync(NodePath.join(workspace, "src"), { recursive: true })
  NodeFs.mkdirSync(temporary)
  return { base, workspace, temporary }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories) {
    for (const entry of NodeFs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) NodeFs.chmodSync(NodePath.join(entry.parentPath, entry.name), 0o700)
    }
    NodeFs.rmSync(directory, { recursive: true, force: true })
  }
  directories.clear()
})

const facts = (platform: NodeJS.Platform, executables: Readonly<Record<string, string>>): ProcessSandbox.Host => ({
  ...ProcessSandbox.host(),
  platform,
  executable: (name) => executables[name]
})

const darwin = facts("darwin", { "/usr/bin/sandbox-exec": "/usr/bin/sandbox-exec" })
const linux = facts("linux", { bwrap: "/usr/bin/bwrap" })
const bare = facts("win32", {})

const profileFor = (
  workspaceRoot: string,
  override: Partial<KernelProcessConfinement.Profile> = {}
): KernelProcessConfinement.Profile => ({
  workspaceRoot,
  reads: ["src"],
  writes: ["out"],
  writeFiles: [],
  readOnly: [],
  network: "none",
  ...override
})

/** Runs one confinement inside a scope and reports what was left of the private tmp after it closed. */
const confine = (
  options: ProcessConfinement.Options,
  command: ChildProcess.StandardCommand,
  profile: KernelProcessConfinement.Profile
) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const service = ProcessConfinement.make(options)
    const exit = yield* Effect.exit(service.confine(command, profile).pipe(Scope.provide(scope)))
    const entries = NodeFs.readdirSync(options.temporaryDirectory!)
    yield* Scope.close(scope, Exit.void)
    return { exit, entries, after: NodeFs.readdirSync(options.temporaryDirectory!) }
  })

describe("ProcessConfinement", () => {
  it.effect("wraps an argv in the seatbelt mechanism and redirects the home into a private tmp", () =>
    Effect.gen(function*() {
      const { workspace, temporary } = fixture()
      const command = ChildProcess.make("tool", ["--run"], { cwd: workspace, env: { KEEP: "1", GONE: undefined } })
      const { after, entries, exit } = yield* confine(
        { host: darwin, temporaryDirectory: temporary },
        command,
        profileFor(workspace)
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return
      const confined = exit.value
      expect(confined.command).toBe("/usr/bin/sandbox-exec")
      expect(confined.args[0]).toBe("-p")
      expect(confined.args[1]).toContain("(deny network*)")
      expect(confined.args[1]).toContain(`(subpath "${NodePath.join(workspace, "out")}")`)
      expect(confined.args.slice(2)).toEqual(["tool", "--run"])
      expect(confined.options.cwd).toBe(workspace)
      expect(confined.options.shell).toBe(false)
      expect(confined.options.extendEnv).toBeUndefined()
      expect(confined.options.env).toMatchObject({ KEEP: "1", HOME: NodePath.join(temporary, entries[0]!, "home") })
      // The declared write directory was created for the mechanism to bind.
      expect(NodeFs.statSync(NodePath.join(workspace, "out")).isDirectory()).toBe(true)
      expect(entries).toHaveLength(1)
      expect(after).toEqual([])
    }))

  it.effect("spells a shell request out as the shell the mechanism confines", () =>
    Effect.gen(function*() {
      const { workspace, temporary } = fixture()
      const line = ChildProcess.make("printf x > ../outside", [], { shell: true })
      const custom = ChildProcess.make("echo", ["hi"], { shell: "/custom/sh", cwd: workspace })
      const { exit } = yield* confine({ host: linux, temporaryDirectory: temporary }, line, profileFor(workspace))
      const { exit: customExit } = yield* confine(
        { host: linux, temporaryDirectory: temporary },
        custom,
        profileFor(workspace, { network: "open" })
      )
      expect(Exit.isSuccess(exit) && Exit.isSuccess(customExit)).toBe(true)
      if (!Exit.isSuccess(exit) || !Exit.isSuccess(customExit)) return
      const argv = [exit.value.command, ...exit.value.args]
      expect(argv[0]).toBe("/usr/bin/bwrap")
      expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["/bin/sh", "-c", "printf x > ../outside"])
      expect(argv).toContain("--unshare-all")
      expect(argv).not.toContain("--share-net")
      // No cwd of its own: the stage runs in the workspace root.
      expect(argv[argv.indexOf("--chdir") + 1]).toBe(workspace)
      // No environment of its own: the wrapper's variables extend the inherited one.
      expect(exit.value.options.extendEnv).toBe(true)
      expect(exit.value.options.env).toMatchObject({ TMPDIR: "/tmp", HOME: "/tmp/home" })
      const customArgv = [customExit.value.command, ...customExit.value.args]
      expect(customArgv.slice(customArgv.indexOf("--") + 1)).toEqual(["/custom/sh", "-c", "echo hi"])
      expect(customArgv).toContain("--share-net")
    }))

  it.effect("runs unconfined by default when the host has no mechanism, and refuses when told to", () =>
    Effect.gen(function*() {
      const { workspace, temporary } = fixture()
      const command = ChildProcess.make("tool", [], { cwd: workspace })
      const lenient = yield* confine({ host: bare, temporaryDirectory: temporary }, command, profileFor(workspace))
      expect(Exit.isSuccess(lenient.exit) && lenient.exit.value).toBe(command)
      expect(lenient.entries).toEqual([])
      const strict = yield* confine(
        { host: bare, temporaryDirectory: temporary, unavailable: "refuse" },
        command,
        profileFor(workspace)
      )
      expect(Exit.isFailure(strict.exit)).toBe(true)
      if (!Exit.isFailure(strict.exit)) return
      expect(strict.exit.cause.toString()).toContain("refuses to spawn unconfined")
      expect(strict.exit.cause.toString()).toContain("no process sandbox of its own")
      const lenientOnLinux = yield* confine(
        { host: facts("linux", {}), temporaryDirectory: temporary, unavailable: "unconfined" },
        command,
        profileFor(workspace)
      )
      expect(Exit.isSuccess(lenientOnLinux.exit) && lenientOnLinux.exit.value).toBe(command)
    }))

  it.effect("refuses a write the mechanism cannot enforce safely, and leaves no tmp behind", () =>
    Effect.gen(function*() {
      const { base, workspace, temporary } = fixture()
      NodeFs.mkdirSync(NodePath.join(base, "elsewhere"))
      NodeFs.symlinkSync(NodePath.join(base, "elsewhere"), NodePath.join(workspace, "linked"))
      const command = ChildProcess.make("tool", [], { cwd: workspace })
      const { after, exit } = yield* confine(
        { host: darwin, temporaryDirectory: temporary },
        command,
        profileFor(workspace, { writes: ["linked"] })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(exit.cause.toString()).toContain("has a symbolic link")
      expect(after).toEqual([])
    }))

  it.effect("reports a preparation the host refuses, and still removes its tmp", () =>
    Effect.gen(function*() {
      const { workspace, temporary } = fixture()
      // A workspace its owner cannot write: the declared write directory
      // cannot be created for the mechanism to bind.
      NodeFs.chmodSync(workspace, 0o500)
      const command = ChildProcess.make("tool", [], { cwd: workspace })
      const { after, exit } = yield* confine(
        { host: darwin, temporaryDirectory: temporary },
        command,
        profileFor(workspace)
      )
      NodeFs.chmodSync(workspace, 0o700)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(exit.cause.toString()).toContain("could not prepare the confinement")
      expect(exit.cause.toString()).toContain("EACCES")
      expect(after).toEqual([])
      // A tmp root that cannot be created is the same failure.
      const blocked = NodePath.join(workspace, "blocked")
      NodeFs.writeFileSync(blocked, "not a directory")
      const rootless = yield* Effect.exit(
        Effect.scoped(
          ProcessConfinement.make({ host: darwin, temporaryDirectory: blocked }).confine(command, profileFor(workspace))
        )
      )
      expect(Exit.isFailure(rootless)).toBe(true)
      if (Exit.isFailure(rootless)) expect(rootless.cause.toString()).toContain("could not prepare the confinement")
    }))

  it.effect("reports a rendering the mechanism refuses, however it says so", () =>
    Effect.gen(function*() {
      const { workspace, temporary } = fixture()
      const command = ChildProcess.make("tool", [], { cwd: workspace })
      const refusal = ProcessSandbox.unenforceable("darwin", "seatbelt", "path", "changed since planning")
      vi.spyOn(ProcessSandbox, "wrap").mockImplementationOnce(() => {
        throw refusal
      })
      const structured = yield* confine({ host: darwin, temporaryDirectory: temporary }, command, profileFor(workspace))
      expect(Exit.isFailure(structured.exit)).toBe(true)
      if (Exit.isFailure(structured.exit)) {
        expect(structured.exit.cause.toString()).toContain("could not render the confinement")
        expect(structured.exit.cause.toString()).toContain("changed since planning")
      }
      vi.spyOn(ProcessSandbox, "wrap").mockImplementationOnce(() => {
        throw "plain text"
      })
      const plain = yield* confine({ host: darwin, temporaryDirectory: temporary }, command, profileFor(workspace))
      expect(Exit.isFailure(plain.exit)).toBe(true)
      if (Exit.isFailure(plain.exit)) expect(plain.exit.cause.toString()).toContain("plain text")
      expect(plain.after).toEqual([])
    }))

  it.effect("keeps going when the host refuses to remove the private tmp", () =>
    Effect.gen(function*() {
      const { workspace, temporary } = fixture()
      const command = ChildProcess.make("tool", [], { cwd: workspace })
      const scope = yield* Scope.make()
      const service = ProcessConfinement.make({ host: darwin, temporaryDirectory: temporary })
      yield* service.confine(command, profileFor(workspace)).pipe(Scope.provide(scope))
      const [tmp] = NodeFs.readdirSync(temporary)
      // Entries cannot be unlinked from a directory the owner cannot write.
      NodeFs.chmodSync(NodePath.join(temporary, tmp!), 0o500)
      yield* Scope.close(scope, Exit.void)
      expect(NodeFs.readdirSync(temporary)).toEqual([tmp])
    }))

  it("provides the service as a layer", () => {
    expect(ProcessConfinement.layer()).toBeDefined()
  })
})
