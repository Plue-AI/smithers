import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFlowHostManifest } from "./flow-host-manifest.mjs"

test("native Flow host bundle names and checksums its Linux arm64 helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-flow-hosts-"))
  try {
    const coding = join(root, "smithers-coding-host")
    const helper = join(root, "linux-arm64", "smithers-jj-export")
    await mkdir(join(root, "linux-arm64"))
    await writeFile(coding, "coding")
    await writeFile(helper, "linux helper")
    const manifest = await writeFlowHostManifest({
      output: join(root, "flow-hosts.json"), coding, jjExport: helper
    })
    const digest = createHash("sha256").update("linux helper").digest("hex")
    assert.deepEqual(manifest.hosts.jjExport, {
      executable: "linux-arm64/smithers-jj-export", sha256: digest, flows: []
    })
    assert.equal(await readFile(join(root, "linux-arm64", "smithers-jj-export.sha256"), "utf8"),
      `${digest}  smithers-jj-export\n`)
    assert.deepEqual(JSON.parse(await readFile(join(root, "flow-hosts.json"), "utf8")), manifest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
