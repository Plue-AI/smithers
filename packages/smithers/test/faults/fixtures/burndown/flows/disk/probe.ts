import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"

export interface Measurement {
  type: number
  bsize: number
  blocks: number
  bavail: number
  bytes: number
  capacity: number
}
export interface DiskConfig {
  owner: string
  path: string
  floor: number
  sdkEntry: string
  binary: string
  library: string
  wrapper: string
}
// This synchronous port reads real guest statfs; it never substitutes a byte reading.
export const diskCommand = <A = Measurement>(root: string, operation: string): A =>
  JSON.parse(execFileSync(process.execPath, [
    "--no-warnings",
    `${root}/disk-guest.mjs`,
    "__disk_guest",
    root,
    operation
  ], { timeout: operation === "create" || operation === "destroy" ? 30_000 : 10_000, encoding: "utf8" }))

// Cleanup ports yield while real guest execution is pending; only the byte probe must be synchronous.
export const diskCommandAsync = async <A = Measurement>(root: string, operation: string): Promise<A> => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--no-warnings",
    `${root}/disk-guest.mjs`,
    "__disk_guest",
    root,
    operation
  ], { timeout: 10_000, encoding: "utf8" })
  return JSON.parse(stdout)
}
