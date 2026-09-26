import { expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const { nativeHelper } = await import(
  resolve(import.meta.dir, "../../../packages/smithers/scripts/tui-native-helper.mjs")
)

it("refuses missing and wrong-platform helper payloads instead of publishing a broken cross-build", () => {
  const root = mkdtempSync(join(tmpdir(), "tui-native-helper-"))
  const target = { os: "linux", arch: "arm64" }
  expect(() => nativeHelper(target, root, root)).toThrow("Missing native helper for linux-arm64")
  const directory = join(root, "linux-arm64")
  mkdirSync(directory)
  const file = join(directory, "smithers-jj-export")
  writeFileSync(file, "not a native executable")
  expect(() => nativeHelper(target, root, root)).toThrow("does not match linux-arm64")
  const elf = Buffer.alloc(64)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  elf.writeUInt16LE(62, 18)
  writeFileSync(file, elf)
  expect(() => nativeHelper(target, root, root)).toThrow("does not match linux-arm64")
  elf.writeUInt16LE(183, 18)
  writeFileSync(file, elf)
  expect(nativeHelper(target, root, root)).toBe(file)
})

it("refuses a glibc helper for a musl TUI target", () => {
  const root = mkdtempSync(join(tmpdir(), "tui-native-libc-"))
  const directory = join(root, "linux-x64-musl")
  mkdirSync(directory)
  const elf = Buffer.alloc(128)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  elf.writeUInt16LE(62, 18)
  elf.write("/lib64/ld-linux-x86-64.so.2", 40)
  writeFileSync(join(directory, "smithers-jj-export"), elf)
  expect(() => nativeHelper({ os: "linux", arch: "x64", musl: true }, root, root)).toThrow("requires glibc")
})
