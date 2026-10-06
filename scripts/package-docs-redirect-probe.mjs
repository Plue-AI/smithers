import assert from "node:assert/strict"
import { redirectLocation } from "./package-docs.mjs"
let failures = 0
for (const url of ["https://flow.smithers.sh/", "https://engine.smithers.sh/concepts/retries/", "https://smithers-patterns.smithers.sh/", "https://smithers-sync.smithers.sh/", "https://unknown-docs-slug.smithers.sh/deep"]) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 301, `status ${response.status}`)
    assert.equal(response.headers.get("location"), redirectLocation(url), "location")
    console.log(`PASS ${url}`)
  } catch (error) {
    failures++
    console.error(`FAIL ${url}: ${error.message}`)
  }
}
console.log(`${5 - failures} pass; ${failures} fail`)
process.exitCode = failures ? 1 : 0
