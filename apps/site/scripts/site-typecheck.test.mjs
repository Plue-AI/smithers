import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(join(site, "package.json"))
const tsc = require.resolve("typescript/bin/tsc")

test("site tsc includes native bridge", () => {
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "--listFiles", "--pretty", "false"], {
    cwd: site,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
  assert.equal(result.status, 0,
    `site tsc --noEmit failed${result.error ? `: ${result.error.message}` : ""}\n${result.stdout.slice(0, 16000)}\n${result.stderr.slice(0, 16000)}`)
  const files = result.stdout.replaceAll("\\", "/").split(/\r?\n/)
  assert.ok(files.some((file) => file.endsWith("/apps/app/src/mainview/native/NativeBridge.ts")),
    "site tsc did not include apps/app/src/mainview/native/NativeBridge.ts")
})
