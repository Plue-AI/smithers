import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { test } from "node:test"
import { digest } from "../release-support/content.ts"
import { recordUi } from "../release-support/recording.ts"
import { repository } from "./fixtures.ts"

test(
  "recording captures real browser frames/video and verifies the declared local scenario",
  { timeout: 60_000 },
  async (test) => {
    const fixture = await repository(test)
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html")
      response.end(
        "<!doctype html><html><body><h1>Release recording fixture</h1><button onclick=\"document.querySelector('output').textContent='Completed'\">Run</button><output>Ready</output></body></html>"
      )
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    test.after(() => new Promise<void>((done) => server.close(() => done())))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const result = await recordUi(fixture.root, {
      url: `http://127.0.0.1:${address.port}/`,
      readySelector: "button",
      steps: [{ kind: "click", selector: "button", value: "" }, {
        kind: "wait-text",
        selector: "output",
        value: "Completed"
      }]
    }, fixture.evidence)
    assert.equal(result.recordings.filter((asset) => asset.path.endsWith(".png")).length, 3)
    assert.equal(result.recordings.filter((asset) => asset.path.endsWith(".webm")).length, 1)
    for (const asset of result.recordings) {
      assert.equal(
        digest(await readFile(join(fixture.root, asset.path))),
        asset.digest
      )
    }
  }
)

test("recording rejects a remote origin before launching a browser", async (test) => {
  const fixture = await repository(test)
  await assert.rejects(
    recordUi(fixture.root, { url: "https://example.com/", readySelector: "body", steps: [] }, fixture.evidence),
    /local URL/
  )
})
