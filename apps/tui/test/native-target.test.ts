/** The shipped platform map selects verified files without loading foreign code. */
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"

const vendor = new URL("../../../packages/smithers/vendor/opentui-native/", import.meta.url)
const { nativeTarget } = await import(new URL("target.mjs", vendor).href) as {
  nativeTarget: (platform: string, arch: string, libc?: string) => string
}
const manifest = JSON.parse(readFileSync(new URL("manifest.json", vendor), "utf8")) as {
  targets: Record<string, { file: string; sha256: string }>
}
const selections = [
  ["darwin", "arm64", "", "darwin-arm64"],
  ["darwin", "x64", "", "darwin-x64"],
  ["linux", "arm64", "glibc", "linux-arm64"],
  ["linux", "x64", "glibc", "linux-x64"],
  ["linux", "arm64", "musl", "linux-arm64-musl"],
  ["linux", "x64", "musl", "linux-x64-musl"],
  ["win32", "arm64", "", "win32-arm64"],
  ["win32", "x64", "", "win32-x64"]
] as const

test("the eight supported selections exactly cover the shipped manifest", () => {
  expect(Object.keys(manifest.targets).sort()).toEqual(selections.map((selection) => selection[3]).sort())
})

for (const [platform, arch, libc, expected] of selections) {
  test(`${platform}/${arch}/${libc || "default"} selects the existing verified ${expected} artifact`, () => {
    const selected = nativeTarget(platform, arch, libc)
    expect(selected).toBe(expected)
    const artifact = manifest.targets[selected]!
    const path = fileURLToPath(new URL(`${selected}/${artifact.file}`, vendor))
    expect(statSync(path).isFile()).toBe(true)
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(artifact.sha256)
  })
}

for (const arch of ["arm64", "x64"]) {
  for (const libc of [undefined, "", "glibc"]) {
    test(`Linux ${arch} ${libc === undefined ? "unset" : JSON.stringify(libc)} selects glibc`, () => {
      const previous = process.env.OPENTUI_LIBC
      try {
        delete process.env.OPENTUI_LIBC
        expect(nativeTarget("linux", arch, libc)).toBe(`linux-${arch}`)
      } finally {
        if (previous === undefined) delete process.env.OPENTUI_LIBC
        else process.env.OPENTUI_LIBC = previous
      }
    })
  }
}

for (const arch of ["arm64", "x64"]) {
  for (const platform of ["", "freebsd", "android", "Darwin", "linux-musl", "../linux"]) {
    test(`unsupported platform ${JSON.stringify(platform)} with ${arch} refuses selection`, () => {
      expect(() => nativeTarget(platform, arch, "")).toThrow("Unsupported OpenTUI native target")
    })
  }
  for (const libc of ["bionic", "uclibc", "MUSL", "GLIBC", " ", "musl ", "../musl"]) {
    test(`unsupported Linux libc ${JSON.stringify(libc)} with ${arch} refuses selection`, () => {
      expect(() => nativeTarget("linux", arch, libc)).toThrow("Unsupported OpenTUI libc")
    })
  }
}

for (const platform of ["darwin", "linux", "win32"]) {
  for (const arch of ["", "ia32", "arm", "riscv64", "ARM64", "../x64"]) {
    test(`unsupported architecture ${JSON.stringify(arch)} on ${platform} refuses selection`, () => {
      expect(() => nativeTarget(platform, arch, "")).toThrow("Unsupported OpenTUI native target")
    })
  }
}
