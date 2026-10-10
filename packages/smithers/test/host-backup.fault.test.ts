import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Explicit release-host suite: no fake command, provider or successful gate.
// The owner supplies a disposable canary install with concurrent work. Linux
// reports these cases skipped; it cannot qualify APFS/launchd/microVM faults.
const config = process.env.SMITHERS_HOST_BACKUP_FAULT_CONFIG
const eligible = process.platform === "darwin" && process.arch === "arm64" && process.getuid?.() !== 0 && !!config
const runner = fileURLToPath(new URL("../../../scripts/release/host-backup-fault.mjs", import.meta.url))

describe("C-REL-06 installed backup kill points", () => {
  for (const point of ["freeze", "drain", "capture", "pg_dump", "clone", "manifest"]) {
    it.skipIf(!eligible)(
      `killed during ${point} reopens the served TODO route without publishing a backup`,
      async () => {
        const child = spawn(process.execPath, [runner, resolve(config!), point], { stdio: ["ignore", "pipe", "pipe"] })
        let output = ""
        child.stdout.on("data", (bytes) => {
          output += bytes
        })
        child.stderr.on("data", (bytes) => {
          output += bytes
        })
        const status = await new Promise<number | null>((yes, no) => {
          child.once("error", no)
          child.once("close", yes)
        })
        expect(status, output).toBe(0)
      },
      180_000
    )
  }
})
