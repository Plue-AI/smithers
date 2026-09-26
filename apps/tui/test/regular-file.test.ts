import { expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Changes from "../src/changes.ts"

it("refuses a FIFO without waiting for a writer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-fifo-"))
  const file = join(dir, "pipe")
  Bun.spawnSync(["mkfifo", file])
  try {
    expect(await Promise.race([Changes.read(file), Bun.sleep(200).then(() => "blocked")])).toBeUndefined()
  } finally {
    const child = Bun.spawn(["sh", "-c", "echo release > \"$1\"", "sh", file])
    await Bun.sleep(20)
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
