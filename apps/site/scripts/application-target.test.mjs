/** Both hosted document entrypoints publish the site's session-auth web-Plue target. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { applicationTarget } from "../src/lib/applicationTarget.ts"

test("both layouts emit the application target meta from the site's applicationTarget", () => {
  for (const layout of ["Base", "AppShell"]) {
    const source = readFileSync(new URL(`../src/layouts/${layout}.astro`, import.meta.url), "utf8")
    assert.ok(source.includes('name="smithers-application-target" content={JSON.stringify(applicationTarget)}'), layout)
  }
})

test("the site's application target is session-auth web-plue on the same origin", () => {
  assert.equal(applicationTarget.mode, "web-plue")
  assert.deepEqual(applicationTarget.auth, { kind: "session" })
  assert.equal(applicationTarget.apiOrigin, "")
  assert.equal(applicationTarget.cors, "same-origin")
})
