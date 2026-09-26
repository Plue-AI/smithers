import { expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Tui } from "../e2e/zmux.ts"

it("waits for the PTY socket to accept connections after its path appears", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-socket-"))
  const binary = join(root, "daemon")
  writeFileSync(
    binary,
    `#!/usr/bin/env bun
import { writeFileSync, unlinkSync } from "node:fs"
import { createServer } from "node:net"
const path = process.argv[process.argv.indexOf("--socket") + 1]
writeFileSync(path, "")
const server = createServer((socket) => socket.on("data", (data) => {
  for (const line of String(data).trim().split("\\n")) {
    const request = JSON.parse(line)
    socket.write(JSON.stringify({ id: request.id, result: { paneId: "tui" } }) + "\\n")
  }
}))
setTimeout(() => { unlinkSync(path); server.listen(path) }, 400)
setTimeout(() => process.exit(0), 3000)
`,
    { mode: 0o755 }
  )
  const before = process.env.ZMUXD
  process.env.ZMUXD = binary
  let tui: Tui | undefined
  try {
    tui = await Tui.start({ cwd: root, command: "unused" })
    expect(tui).toBeDefined()
  } finally {
    process.env.ZMUXD = before
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
