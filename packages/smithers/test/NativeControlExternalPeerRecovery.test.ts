import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const fixture = fileURLToPath(new URL("./fixtures/external-peer-scenario.ts", import.meta.url))
it(
  "public native flow keeps one external worker through concurrent peer registration and settles its parked parent",
  async () => {
    const { stdout } = await execute(process.execPath, ["--experimental-strip-types", fixture, "observe"], {
      timeout: 180_000,
      maxBuffer: 1024 * 1024
    })
    expect(stdout.trim().split("\n").findLast((line) => line.startsWith("{\"passed\":"))).toBe("{\"passed\":true}")
  },
  185_000
)
