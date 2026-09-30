import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  installedPackageRoot,
  outsideWorkspace,
  resolveConfiguredExecutable,
  resolveDefaultExecutable,
  resolvePackageRoot,
  stagePackaged
} from "../src/internal/AtomicFileSystemExecutable.ts"

const roots: Array<string> = []
const helperName = process.platform === "win32" ? "smithers-jj-export.exe" : "smithers-jj-export"
// Windows has no POSIX modes: Node reports every writable directory as 0o666,
// and the staging directory's privacy is the per-user profile ACL instead.
const privateDirectoryMode = process.platform === "win32" ? 0o666 : 0o700
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atomic-executable-")))
  const stageBase = await realpath(await mkdtemp(join(tmpdir(), "atomic-stage-")))
  roots.push(root, stageBase)
  for (const name of ["TMPDIR", "TMP", "TEMP"] as const) vi.stubEnv(name, stageBase)
  const packageRoot = join(root, "packages/smithers/flows/platform-node")
  await mkdir(packageRoot, { recursive: true })
  return { root, stageBase, packageRoot }
}
const helper = async (path: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, "#!/bin/sh\nexit 0\n")
  await chmod(path, 0o755)
}

/**
 * Leaves `base` writable but unlistable by this user, and returns the undo:
 * POSIX drops the read bit; Windows denies the list-directory right (RD) to
 * this user's SID on the directory alone, so new children inherit nothing.
 */
const refuseListing = async (base: string): Promise<() => Promise<void>> => {
  if (process.platform !== "win32") {
    await chmod(base, 0o300)
    return () => chmod(base, 0o700)
  }
  const sid = /S-1-[\d-]+/.exec(execFileSync("whoami", ["/user"], { encoding: "utf8" }))?.[0]
  if (sid === undefined) throw new Error("whoami reported no user SID")
  execFileSync("icacls", [base, "/deny", `*${sid}:(RD)`])
  return async () => {
    execFileSync("icacls", [base, "/remove:d", `*${sid}`])
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("default atomic helper resolution", () => {
  it("resolves the installed platform package from a relocated host bundle", async () => {
    const { root } = await fixture()
    const installed = join(root, "node_modules/@smthrs/platform-node")
    await mkdir(installed, { recursive: true })
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({ name: "@smthrs/platform-node", exports: { "./package.json": "./package.json" } })
    )
    expect(installedPackageRoot(join(root, "dist/tui/main.js"), "fallback")).toBe(installed)
    expect(installedPackageRoot("unresolvable-module", "fallback")).toBe("fallback")
  })

  it("pins a registered embedded asset through the same private staging path", async () => {
    vi.resetModules()
    const embedded = await import("../src/internal/AtomicFileSystemExecutable.ts")
    const { root, stageBase } = await fixture()
    const asset = join(root, "embedded-helper")
    await helper(asset)
    embedded.registerEmbeddedHelper(asset)
    embedded.stagePackaged(join(root, "missing-package"))
    await writeFile(asset, "changed after host construction")
    const executable = embedded.resolveDefaultExecutable(join(root, "missing-package"), root)
    expect(executable.startsWith(`${stageBase}${sep}`)).toBe(true)
    expect(await readFile(executable, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it.each(["src/internal", "dist/esm/internal", "dist/cjs/internal"])(
    "finds the package root from %s",
    async (directory) => {
      const { packageRoot } = await fixture()
      await writeFile(join(packageRoot, "package.json"), "{}")
      expect(resolvePackageRoot(join(packageRoot, directory))).toBe(packageRoot)
    }
  )

  it("stages one content-addressed copy across fresh module instances", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const base = join(root, "stage")
    await helper(source)
    await mkdir(base)
    const previous = new Set(process.rawListeners("exit"))
    const selected = new Set<string>()
    for (let run = 0; run < 5; run += 1) {
      vi.resetModules()
      const fresh = await import("../src/internal/AtomicFileSystemExecutable.ts")
      selected.add(fresh.outsideWorkspace(source, undefined, [base]))
    }
    const digest = createHash("sha256").update(await readFile(source)).digest("hex")
    expect(await readdir(base)).toEqual([`.smthrs-atomic-helper-${digest}`])
    expect(await readdir(join(base, `.smthrs-atomic-helper-${digest}`))).toEqual([helperName])
    expect([...selected]).toEqual([join(base, `.smthrs-atomic-helper-${digest}`, helperName)])
    expect((await stat(join(base, `.smthrs-atomic-helper-${digest}`))).mode & 0o777).toBe(privateDirectoryMode)
    expect(process.rawListeners("exit").filter((listener) => !previous.has(listener))).toEqual([])
  })

  it("replaces a staged copy whose bytes no longer match its hash", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const base = join(root, "stage")
    await helper(source)
    await mkdir(base)
    const digest = createHash("sha256").update(await readFile(source)).digest("hex")
    const directory = join(base, `.smthrs-atomic-helper-${digest}`)
    await mkdir(directory, { mode: 0o755 })
    await writeFile(join(directory, helperName), "tampered", { mode: 0o755 })
    const selected = outsideWorkspace(source, undefined, [base])
    expect(selected).toBe(join(directory, helperName))
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
    expect(await readdir(directory)).toEqual([helperName])
    expect((await stat(directory)).mode & 0o777).toBe(privateDirectoryMode)
  })

  it("refuses a planted link in place of the staging directory", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const base = join(root, "stage")
    const elsewhere = join(root, "elsewhere")
    await helper(source)
    await mkdir(base)
    await mkdir(elsewhere)
    const digest = createHash("sha256").update(await readFile(source)).digest("hex")
    await symlink(elsewhere, join(base, `.smthrs-atomic-helper-${digest}`))
    expect(() => outsideWorkspace(source, undefined, [base])).toThrow(/staging directory/)
    expect(await readdir(elsewhere)).toEqual([])
  })

  it.each(["symlink", "hard link"] as const)(
    "replaces a planted %s with the right bytes by its own copy",
    async (kind) => {
      const { root } = await fixture()
      const source = join(root, "helper")
      const base = join(root, "stage")
      const planted = join(root, "workspace-helper")
      await helper(source)
      await helper(planted)
      await mkdir(base)
      const digest = createHash("sha256").update(await readFile(source)).digest("hex")
      const directory = join(base, `.smthrs-atomic-helper-${digest}`)
      await mkdir(directory, { mode: 0o700 })
      await (kind === "symlink" ? symlink : link)(planted, join(directory, helperName))
      const selected = outsideWorkspace(source, undefined, [base])
      const info = await lstat(selected)
      expect(info.isFile() && info.nlink === 1).toBe(true)
      // The planted target is untouched: rename replaced the entry, not the linked file.
      expect((await lstat(planted)).nlink).toBe(1)
      expect(await readFile(planted, "utf8")).toBe("#!/bin/sh\nexit 0\n")
    }
  )

  it("removes this user's staging directories no process used for a week, and keeps recent ones", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const base = join(root, "stage")
    await helper(source)
    await mkdir(base)
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    const legacy = join(base, ".smthrs-atomic-helper-Ab3xYz")
    const previous = join(base, `.smthrs-atomic-helper-${"0".repeat(64)}`)
    const recent = join(base, ".smthrs-atomic-helper-Qr7uVw")
    const unrelated = join(base, "keep-me")
    // Only directories are staging copies; a file of that name is not this code's to remove.
    const notDirectory = join(base, ".smthrs-atomic-helper-file")
    for (const directory of [legacy, previous, recent, unrelated]) await mkdir(directory)
    await writeFile(notDirectory, "")
    for (const entry of [legacy, previous, unrelated, notDirectory]) await utimes(entry, old, old)
    const selected = outsideWorkspace(source, undefined, [base])
    expect((await readdir(base)).sort()).toEqual(
      [basename(dirname(selected)), basename(recent), basename(notDirectory), "keep-me"].sort()
    )
  })

  it("removes stale helper temporary files and keeps recent or unrelated files", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const base = join(root, "stage")
    await helper(source)
    await mkdir(base)
    const digest = createHash("sha256").update(await readFile(source)).digest("hex")
    const directory = join(base, `.smthrs-atomic-helper-${digest}`)
    const otherDirectory = join(base, `.smthrs-atomic-helper-${"0".repeat(64)}`)
    await mkdir(directory)
    await mkdir(otherDirectory)
    const stale = join(directory, `.${helperName}.12345.a1b2c3d4e5f6`)
    const otherStale = join(otherDirectory, `.${helperName}.67890.a1b2c3d4e5f6`)
    const recent = join(directory, `.${helperName}.12345.abcdef123456`)
    const unrelated = join(directory, `.${helperName}.invalid.a1b2c3d4e5f6`)
    for (const path of [stale, otherStale, recent, unrelated]) await writeFile(path, "temporary")
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await utimes(stale, old, old)
    await utimes(otherStale, old, old)
    await utimes(unrelated, old, old)

    const selected = outsideWorkspace(source, undefined, [base])
    expect(selected).toBe(join(directory, helperName))
    expect((await readdir(directory)).sort()).toEqual([helperName, basename(recent), basename(unrelated)].sort())
    expect(await readdir(otherDirectory)).toEqual([])
  })

  // Root reads any POSIX directory; Windows denies the list-directory right
  // even to an elevated runner, so only root is skipped.
  it.skipIf(process.getuid?.() === 0)(
    "stages in a base it may write but not list, leaving pruning for a later process",
    async () => {
      const { root } = await fixture()
      const source = join(root, "helper")
      const later = join(root, "later-helper")
      const base = join(root, "stage")
      await helper(source)
      await writeFile(later, "#!/bin/sh\nexit 1\n")
      await chmod(later, 0o755)
      await mkdir(base)
      const stale = join(base, ".smthrs-atomic-helper-stale")
      await mkdir(stale)
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      await utimes(stale, old, old)
      const allowListing = await refuseListing(base)
      try {
        await expect(readdir(base)).rejects.toThrow()
        const selected = outsideWorkspace(source, undefined, [base])
        expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
      } finally {
        await allowListing()
      }
      expect(await readdir(base)).toContain(basename(stale))
      outsideWorkspace(later, undefined, [base])
      expect(await readdir(base)).not.toContain(basename(stale))
    }
  )

  it("stages again when another process pruned the copy it had cached", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const base = join(root, "stage")
    await helper(source)
    await mkdir(base)
    const selected = outsideWorkspace(source, undefined, [base])
    await rm(dirname(selected), { recursive: true, force: true })
    expect(outsideWorkspace(source, undefined, [base])).toBe(selected)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it("keeps a copy it goes on using fresh, at most hourly, so no other process prunes it", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const base = join(root, "stage")
    await helper(source)
    await mkdir(base)
    const directory = dirname(outsideWorkspace(source, undefined, [base]))
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await utimes(directory, old, old)
    outsideWorkspace(source, undefined, [base])
    await new Promise((settle) => setTimeout(settle, 50))
    expect((await stat(directory)).mtimeMs).toBe(old.getTime())
    const later = Date.now() + 2 * 60 * 60 * 1000
    const clock = vi.spyOn(Date, "now").mockReturnValue(later)
    try {
      outsideWorkspace(source, undefined, [base])
    } finally {
      clock.mockRestore()
    }
    await vi.waitFor(async () => expect((await stat(directory)).mtimeMs).toBeGreaterThan(old.getTime()))
  })

  it("tries the next location when the staged path cannot be replaced", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const blocked = join(root, "blocked")
    const available = join(root, "available")
    await helper(source)
    await mkdir(available)
    const digest = createHash("sha256").update(await readFile(source)).digest("hex")
    await mkdir(join(blocked, `.smthrs-atomic-helper-${digest}`, helperName, "occupied"), { recursive: true })
    const selected = outsideWorkspace(source, undefined, [blocked, available])
    expect(selected.startsWith(`${available}${sep}`)).toBe(true)
    expect(await readdir(join(blocked, `.smthrs-atomic-helper-${digest}`))).toEqual([helperName])
  })

  it("tries a second staging location when the first is confined", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const confined = join(root, "confined")
    const outside = await realpath(await mkdtemp(join(tmpdir(), "atomic-stage-")))
    roots.push(outside)
    await mkdir(confined)
    await helper(source)
    const selected = outsideWorkspace(source, root, [confined, outside])
    expect(selected.startsWith(`${outside}${sep}`)).toBe(true)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
    expect(outsideWorkspace(source, root, [confined])).toBe(selected)
  })

  it.each(["missing", "file"])("tries the next staging location when the first is a %s", async (kind) => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const unavailable = join(root, kind)
    const available = join(root, "available")
    await helper(source)
    await mkdir(available)
    if (kind === "file") await writeFile(unavailable, "not a directory")
    const selected = outsideWorkspace(source, undefined, [unavailable, available])
    expect(selected.startsWith(`${available}${sep}`)).toBe(true)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it("reports the final creation failure when no staging directory is usable", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    await helper(source)
    expect(() => outsideWorkspace(source, undefined, [join(root, "missing")])).toThrow(/ENOENT/)
  })

  it("fails when every staging location is confined or none is available", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    const confined = join(root, "confined")
    await mkdir(confined)
    await helper(source)
    expect(() => outsideWorkspace(source, root, [confined])).toThrow(/confined workspace/)
    expect(() => outsideWorkspace(source, root, [])).toThrow(/no staging location/)
  })

  it("uses the helper shipped in the installed platform package", async () => {
    const { packageRoot, root } = await fixture()
    const binary = join(packageRoot, "bin", `${process.platform}-${process.arch}`, helperName)
    await mkdir(dirname(binary), { recursive: true })
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o644 })
    const selected = resolveDefaultExecutable(packageRoot, join(root, "workspace"), join(root, "absent"))
    expect(selected).not.toBe(binary)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it("stages the correct executable name on the other operating-system family", async () => {
    const { packageRoot, root } = await fixture()
    const originalProcess = process
    const platform = process.platform === "win32" ? "linux" : "win32"
    const filename = platform === "win32" ? "smithers-jj-export.exe" : "smithers-jj-export"
    await helper(join(packageRoot, "bin", `${platform}-${process.arch}`, filename))
    vi.stubGlobal(
      "process",
      new Proxy(originalProcess, {
        get: (target, key, receiver) => key === "platform" ? platform : Reflect.get(target, key, receiver)
      })
    )
    vi.resetModules()
    try {
      const host = await import("../src/internal/AtomicFileSystemExecutable.ts")
      host.stagePackaged(packageRoot)
      const selected = host.resolveDefaultExecutable(packageRoot, root, join(root, "absent"))
      expect(basename(selected)).toBe(filename)
      expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it("executes the helper staged at layer build, not bytes written after it", async () => {
    const { packageRoot, root } = await fixture()
    const binary = join(packageRoot, "bin", `${process.platform}-${process.arch}`, helperName)
    await helper(binary)
    stagePackaged(packageRoot)
    await writeFile(binary, "#!/bin/sh\necho planted\n")
    const selected = resolveDefaultExecutable(packageRoot, join(root, "workspace"), join(root, "absent"))
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it("stages nothing and throws nothing when no helper is packaged", async () => {
    const { packageRoot } = await fixture()
    expect(() => stagePackaged(packageRoot)).not.toThrow()
  })

  it("names the variable and the install hint when the configured helper is unusable", async () => {
    const { root } = await fixture()
    const absent = join(root, "absent")
    // A Windows path's backslashes are regex escapes; match the path literally.
    const literal = absent.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
    expect(() => resolveConfiguredExecutable(absent, undefined)).toThrow(
      new RegExp(
        `^smithers-jj-export is unusable at SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=${literal}: .*ENOENT.*` +
          "cargo build --locked --release -p smithers-ffi --bin smithers-jj-export"
      )
    )
    const binary = join(root, "bin", helperName)
    await helper(binary)
    expect(resolveConfiguredExecutable(binary, undefined)).toBe(binary)
  })

  it("rejects a packaged helper that is a directory", async () => {
    const { packageRoot, root } = await fixture()
    const binary = join(packageRoot, "bin", `${process.platform}-${process.arch}`, helperName)
    await mkdir(binary, { recursive: true })
    expect(() => resolveDefaultExecutable(packageRoot, root, join(root, "absent")))
      .toThrow(/not a regular file/)
  })

  it("pins an installed helper outside a confined project", async () => {
    const { packageRoot, root } = await fixture()
    const binary = join(packageRoot, "bin", `${process.platform}-${process.arch}`, helperName)
    await helper(binary)
    stagePackaged(packageRoot)
    const selected = resolveDefaultExecutable(packageRoot, root, join(root, "absent"))
    expect(selected.startsWith(`${root}${sep}`)).toBe(false)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it("uses a release build from a source checkout", async () => {
    const { packageRoot, root } = await fixture()
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
    const binary = join(root, "target/release", helperName)
    await helper(binary)
    expect(resolveDefaultExecutable(packageRoot, join(root, "flows"), join(root, "absent"))).toBe(binary)
  })

  it("pins a checkout helper outside a confined project", async () => {
    const { packageRoot, root } = await fixture()
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
    const binary = join(root, "target/release", helperName)
    await helper(binary)
    stagePackaged(packageRoot)
    const selected = resolveDefaultExecutable(packageRoot, root, join(root, "absent"))
    expect(selected.startsWith(`${root}${sep}`)).toBe(false)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it("executes the checkout build staged at layer build, not bytes a flow wrote after it", async () => {
    const { packageRoot, root } = await fixture()
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
    const binary = join(root, "target/release", helperName)
    await helper(binary)
    stagePackaged(packageRoot)
    await writeFile(binary, "#!/bin/sh\necho planted\n")
    const selected = resolveDefaultExecutable(packageRoot, root, join(root, "absent"))
    expect(selected.startsWith(`${root}${sep}`)).toBe(false)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it.each(["target/release", "target/debug"])(
    "refuses a %s helper that appeared inside the workspace after the host was built",
    async (directory) => {
      const { packageRoot, root } = await fixture()
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
      stagePackaged(packageRoot)
      // A flow confined to `root` plants a build before the first atomic call.
      await helper(join(root, directory, helperName))
      expect(() => resolveDefaultExecutable(packageRoot, root, join(root, "absent")))
        .toThrow(/outside the confined workspace.*not present when the host was built/)
    }
  )

  it("refuses a packaged helper that appeared inside the workspace after the host was built", async () => {
    const { packageRoot, root } = await fixture()
    stagePackaged(packageRoot)
    await helper(join(packageRoot, "bin", `${process.platform}-${process.arch}`, helperName))
    expect(() => resolveDefaultExecutable(packageRoot, root, join(root, "absent")))
      .toThrow(/not present when the host was built/)
  })

  it("stages once per process, so a helper planted before a later layer build stays refused", async () => {
    const { packageRoot, root } = await fixture()
    // The first host layer finds no packaged helper.
    stagePackaged(packageRoot)
    // A flow plants one, then a second host layer is built in this process.
    await helper(join(packageRoot, "bin", `${process.platform}-${process.arch}`, helperName))
    stagePackaged(packageRoot)
    expect(() => resolveDefaultExecutable(packageRoot, root, join(root, "absent")))
      .toThrow(/not present when the host was built/)
  })

  it("stages a checkout build once per process the same way", async () => {
    const { packageRoot, root } = await fixture()
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
    stagePackaged(packageRoot)
    await helper(join(root, "target/release", helperName))
    stagePackaged(packageRoot)
    expect(() => resolveDefaultExecutable(packageRoot, root, join(root, "absent")))
      .toThrow(/not present when the host was built/)
  })

  it.each(["packaged", "checkout"])(
    "refuses a %s helper path a flow made a link to a binary outside the workspace",
    async (kind) => {
      const { packageRoot, root } = await fixture()
      const outside = await realpath(await mkdtemp(join(tmpdir(), "atomic-outside-")))
      roots.push(outside)
      const hostBinary = join(outside, "host-binary")
      await helper(hostBinary)
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
      const planted = kind === "packaged"
        ? join(packageRoot, "bin", `${process.platform}-${process.arch}`, helperName)
        : join(root, "target/release", helperName)
      stagePackaged(packageRoot)
      await mkdir(dirname(planted), { recursive: true })
      await symlink(hostBinary, planted)
      expect(() => resolveDefaultExecutable(packageRoot, root, join(root, "absent")))
        .toThrow(/not present when the host was built/)
    }
  )

  it("names the build and configuration fix when no helper exists", async () => {
    const { packageRoot, root } = await fixture()
    expect(() => resolveDefaultExecutable(packageRoot, join(root, "workspace"), join(root, "absent")))
      .toThrow(/cargo build --locked.*SMITHERS_WORKSPACE_JJ_EXPORT_BINARY/)
  })

  it("rejects a fallback helper inside the confined project", async () => {
    const { packageRoot, root } = await fixture()
    const fallback = join(root, "fallback")
    await helper(fallback)
    expect(() => resolveDefaultExecutable(packageRoot, root, fallback)).toThrow(/confined workspace/)
  })
})
