import assert from "node:assert/strict"
import { readFile, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { test } from "node:test"
import { consumeInstallProject } from "../coding/install-project.ts"

test("the agent consumes a private exclusive snapshot and discards the transport variable", async (t) => {
  const environment = {
    SMITHERS_CODING_PROJECT_JSON: "{\"checks\":[{\"id\":\"test\"}]}",
    SMITHERS_CODING_PROJECT: "/hostile/destination"
  }
  const filename = consumeInstallProject(environment, 1500)!
  t.after(() => rm(dirname(filename), { recursive: true, force: true }))
  assert.equal(await readFile(filename, "utf8"), "{\"checks\":[{\"id\":\"test\"}]}")
  assert.equal((await stat(filename)).mode & 0o777, 0o600)
  assert.equal(environment.SMITHERS_CODING_PROJECT, filename)
  assert.equal(environment.SMITHERS_CODING_PROJECT_JSON, undefined)
  assert.equal(consumeInstallProject({}, 1500), undefined)
})

test("root refuses before consuming config bytes; oversized snapshots refuse without selecting a destination", () => {
  let reads = 0
  const environment = Object.defineProperty({}, "SMITHERS_CODING_PROJECT_JSON", {
    get: () => {
      reads++
      throw new Error("root canary")
    }
  })
  assert.throws(() => consumeInstallProject(environment, 0), /unprivileged guest/)
  assert.equal(reads, 0)
  assert.throws(() => consumeInstallProject({ SMITHERS_CODING_PROJECT_JSON: " ".repeat(262145) }, 1500), /256 KiB/)
})
