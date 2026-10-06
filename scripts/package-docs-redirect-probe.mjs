/**
 * Live acceptance probe for the retired docs-site redirect (T-DOC-04, #3510):
 * five sampled `<slug>.smithers.sh` URLs, including a deep path, both legacy
 * aliases and an unknown slug, must answer 301 with the Location that
 * scripts/package-docs.mjs computes. Network only; it changes nothing.
 *
 *   node scripts/package-docs-redirect-probe.mjs
 */
import assert from "node:assert/strict"
import { redirectLocation } from "./package-docs.mjs"

const urls = [
  "https://flow.smithers.sh/",
  "https://engine.smithers.sh/concepts/retries/",
  "https://smithers-patterns.smithers.sh/",
  "https://smithers-sync.smithers.sh/",
  "https://unknown-docs-slug.smithers.sh/deep"
]
let failures = 0
for (const url of urls) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 301, `status ${response.status}`)
    assert.equal(response.headers.get("location"), redirectLocation(url), "location")
    console.log(`PASS ${url}`)
  } catch (error) {
    failures++
    console.error(`FAIL ${url}: ${error.cause?.code ?? error.message}`)
  }
}
console.log(`${urls.length - failures} pass; ${failures} fail`)
process.exitCode = failures ? 1 : 0
