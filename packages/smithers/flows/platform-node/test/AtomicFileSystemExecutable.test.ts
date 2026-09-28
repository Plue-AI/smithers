import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
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
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atomic-executable-")))
  roots.push(root)
  const packageRoot = join(root, "packages/smithers/flows/platform-node")
  await mkdir(packageRoot, { recursive: true })
  return { root, packageRoot }
}
const helper = async (path: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, "#!/bin/sh\nexit 0\n")
  await chmod(path, 0o755)
}

afterEach(async () => {
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
    const { root } = await fixture()
    const asset = join(root, "embedded-helper")
    await helper(asset)
    embedded.registerEmbeddedHelper(asset)
    embedded.stagePackaged(join(root, "missing-package"))
    await writeFile(asset, "changed after host construction")
    const executable = embedded.resolveDefaultExecutable(join(root, "missing-package"), root)
    expect(executable.startsWith(`${root}${sep}`)).toBe(false)
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

  it("removes its staged helper when its own process-exit hook runs", async () => {
    const { root } = await fixture()
    const source = join(root, "helper")
    await helper(source)
    const previous = new Set(process.rawListeners("exit"))
    const selected = outsideWorkspace(source, undefined, [root])
    const owned = process.rawListeners("exit").filter((listener) => !previous.has(listener))
    expect(owned).toHaveLength(1)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
    owned[0]!.call(process, 0)
    await expect(access(dirname(selected))).rejects.toMatchObject({ code: "ENOENT" })
    expect(process.rawListeners("exit")).not.toContain(owned[0])
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
    expect(() => resolveConfiguredExecutable(absent, undefined)).toThrow(
      new RegExp(
        `^smithers-jj-export is unusable at SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=${absent}: .*ENOENT.*` +
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
