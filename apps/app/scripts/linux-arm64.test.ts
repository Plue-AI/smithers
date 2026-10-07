import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { requireLinuxArm64 } from "./linux-arm64"

const elf = (segments: number[]) => {
  const bytes = Buffer.alloc(64 + 56 * segments.length)
  Buffer.from("7f454c46020101", "hex").copy(bytes)
  bytes.writeUInt16LE(2, 16)
  bytes.writeUInt16LE(183, 18)
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(segments.length, 56)
  segments.forEach((type, i) => bytes.writeUInt32LE(type, 64 + i * 56))
  return bytes
}
test("bundle accepts static ARM64 and refuses interpreter/dynamic sections for the broker", () => {
  const root = mkdtempSync(join(tmpdir(), "machined-elf-"))
  const binary = join(root, "smithers-machined")
  try {
    writeFileSync(binary, elf([1]))
    expect(() => requireLinuxArm64(binary, "machine broker", true)).not.toThrow()
    for (const segments of [[1, 3], [1, 2]]) {
      writeFileSync(binary, elf(segments))
      expect(() => requireLinuxArm64(binary, "machine broker", true)).toThrow("static Linux arm64")
      expect(() => requireLinuxArm64(binary, "guest helper")).not.toThrow()
    }
    const wrongMachine = elf([1]); wrongMachine.writeUInt16LE(62, 18)
    const bigOffset = elf([1]); bigOffset.writeBigUInt64LE(2n ** 63n, 32)
    const wrongEndian = elf([1]); wrongEndian[5] = 2
    const wrongType = elf([1]); wrongType.writeUInt16LE(1, 16)
    for (const bytes of [Buffer.alloc(0), elf([]), elf([1]).subarray(0, 70), elf([4]), wrongMachine, bigOffset, wrongEndian, wrongType]) {
      writeFileSync(binary, bytes)
      expect(() => requireLinuxArm64(binary, "machine broker", true)).toThrow("Linux arm64")
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
