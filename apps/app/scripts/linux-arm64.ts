import { readFileSync } from "node:fs"

/** Reject wrong-architecture and dynamically linked machine broker artifacts. */
export const requireLinuxArm64 = (path: string, label: string, staticBinary = false): void => {
  const bytes = readFileSync(path)
  const invalid = () => new Error(`The ${label} build did not produce a ${staticBinary ? "static " : ""}Linux arm64 ELF executable: ${path}`)
  if (bytes.length < 64 || bytes.subarray(0, 7).toString("hex") !== "7f454c46020101" ||
    bytes.readUInt16LE(18) !== 183 || ![2, 3].includes(bytes.readUInt16LE(16))) throw invalid()
  const offset = Number(bytes.readBigUInt64LE(32))
  const size = bytes.readUInt16LE(54)
  const count = bytes.readUInt16LE(56)
  if (!Number.isSafeInteger(offset) || offset < 64 || size !== 56 || count === 0 ||
    offset + size * count > bytes.length) throw invalid()
  let load = false
  for (let i = 0; i < count; i++) {
    const type = bytes.readUInt32LE(offset + i * size)
    if (type === 1) load = true
    if (staticBinary && (type === 2 || type === 3)) throw invalid()
  }
  if (!load) throw invalid()
}
