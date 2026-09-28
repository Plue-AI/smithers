/** The home page imports app chunks and stylesheets only from its own origin. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { sameOriginUrl } from "../src/lib/sameOriginUrl.ts"

const origin = "https://smithers.sh"
const base = "https://smithers.sh/smithersai/smithers/?tutorial"

test("relative and same-origin chunk URLs resolve against the app page", () => {
  assert.equal(sameOriginUrl("/_astro/AppIsland.abc.js", base, origin), "https://smithers.sh/_astro/AppIsland.abc.js")
  assert.equal(sameOriginUrl("../_astro/app.css", base, origin), "https://smithers.sh/smithersai/_astro/app.css")
  assert.equal(sameOriginUrl("https://smithers.sh/_astro/x.js", base, origin), "https://smithers.sh/_astro/x.js")
})

test("cross-origin, protocol-relative, data and blob URLs are refused", () => {
  for (const raw of [
    "https://evil.example/x.js",
    "//evil.example/x.js",
    "http://smithers.sh/_astro/x.js",
    "https://smithers.sh.evil.example/x.js",
    "data:text/javascript,alert(1)",
    "blob:https://evil.example/1",
    "javascript:alert(1)"
  ]) {
    assert.throws(() => sameOriginUrl(raw, base, origin), /cross-origin/, raw)
  }
})

test("the home page resolves every fetched chunk and stylesheet through sameOriginUrl", async () => {
  const { readFileSync } = await import("node:fs")
  const source = readFileSync(new URL("../src/pages/index.astro", import.meta.url), "utf8")
  const body = source.slice(source.indexOf("const importApp"), source.indexOf("let app: Promise<AppMount>"))
  assert.match(source, /import \{ sameOriginUrl \} from "\.\.\/lib\/sameOriginUrl"/)
  assert.doesNotMatch(body, /new URL\(/)
  assert.equal(body.match(/sameOriginUrl\(/g)?.length, 4)
})
