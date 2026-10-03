import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { ASSET_HEADERS, checkAssetHeaders, checkBuiltSite, checkLandingActions, checkRepositoryPages, releaseReferences } from "./check-built-site.mjs"

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "smithers-built-site-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  return root
}

test("a canonical page alone does not satisfy the versioned URL emitted by the release", (t) => {
  const root = fixture(t, { "changelogs/100-rc0/index.html": "<h1>Release candidate</h1>" })
  const result = checkBuiltSite(root, ["https://smithers.sh/changelogs/1.0.0-rc.0"])
  assert.equal(result.pageCount, 1)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /missing https:\/\/smithers\.sh\/changelogs\/1\.0\.0-rc\.0/)
})

test("built HTTP aliases resolve release URLs and preserve migration anchors", (t) => {
  const root = fixture(t, {
    "changelogs/100-rc0/index.html": "<h1>Release candidate</h1>",
    "docs/migration/1.0/index.html": "<h2 id=\"rewind\">Rewind</h2>",
    "_redirects": "/changelogs/1.0.0-rc.0 /changelogs/100-rc0/ 301\n/migration/1.0 /docs/migration/1.0/ 301\n"
  })
  const references = ["https://smithers.sh/changelogs/1.0.0-rc.0", "https://smithers.sh/migration/1.0#rewind"]
  assert.deepEqual(checkBuiltSite(root, references).failures, [])
  const missingAnchor = checkBuiltSite(root, ["https://smithers.sh/migration/1.0#removed-heading"])
  assert.equal(missingAnchor.failures.length, 1)
  assert.match(missingAnchor.failures[0], /missing anchor.*\/docs\/migration\/1\.0\/#removed-heading/)
})

test("the first redirect overrides an existing asset and preserves explicit fragment replacements", (t) => {
  const root = fixture(t, {
    "old/index.html": "<h2 id=\"old\">Stale page</h2>",
    "new/index.html": "<h2 id=\"new\">Current page</h2>",
    "_redirects": "/old /new/#new 301\n/old /missing 301\n"
  })
  assert.deepEqual(checkBuiltSite(root, ["/old#old"]).failures, [])
})

test("splat redirects and literal exceptions resolve in file order", (t) => {
  const root = fixture(t, {
    "index.html": "<a href=\"/api/renamed#current\">Old link</a><a href=\"/api/other\">Other API</a>",
    "docs/current/index.html": "<h2 id=\"current\">Current API</h2>",
    "docs/api/other/index.html": "<h1>Other API</h1>",
    "_redirects": "/api/renamed /docs/current/ 301\n/api/* /docs/api/:splat/ 301\n"
  })
  assert.deepEqual(checkBuiltSite(root).failures, [])
})

test("more than 100 rules after the first splat rule fail, matching Cloudflare's dynamic-rule limit", (t) => {
  const literals = Array.from({ length: 101 }, (_, i) => `/old${i} /new/ 301`).join("\n")
  const pages = { "new/index.html": "<h1>New</h1>", "api/x/index.html": "<h1>x</h1>" }
  const late = fixture(t, { ...pages, "_redirects": `/api/* /api/:splat/ 301\n${literals}\n` })
  assert.throws(() => checkBuiltSite(late), /102 rules from the first splat rule onward count as dynamic/)
  const ordered = fixture(t, { ...pages, "_redirects": `${literals}\n/api/* /api/:splat/ 301\n` })
  assert.deepEqual(checkBuiltSite(ordered).failures, [])
})

test("missing redirect destinations and cycles fail even without a page linking them", (t) => {
  const root = fixture(t, {
    "index.html": "<h1>Home</h1>",
    "_redirects": "/old /missing 301\n/a /b 301\n/b /a 301\n"
  })
  const { failures } = checkBuiltSite(root)
  assert.ok(failures.some((failure) => /missing \/old/.test(failure)))
  assert.ok(failures.some((failure) => /redirect cycle/.test(failure)))
})

test("page links and assets retain their existing checks", (t) => {
  const root = fixture(t, {
    "index.html":
      "<a href=\"/guide#absent\">Guide</a><img src=\"/missing.png\"><a href=\"https://example.com\">External</a>",
    "guide/index.html": "<h2 id=\"present\">Guide</h2>"
  })
  const { failures } = checkBuiltSite(root)
  assert.equal(failures.length, 2)
  assert.ok(failures.some((failure) => /missing anchor \/guide#absent/.test(failure)))
  assert.ok(failures.some((failure) => /missing \/missing\.png/.test(failure)))
})

/*
 * A page reaches the same route by four spellings, and the browser resolves
 * all four against the page it read them from. The checker must too: a
 * document-relative href is as broken as the root-relative one it duplicates.
 */
test("every internal URL form resolves against the emitting page, so all four fail alike when the route is missing", (t) => {
  const root = fixture(t, {
    "index.html":
      "<a href=\"/guide/\">Root-relative</a><a href=\"https://smithers.sh/guide/\">Absolute</a>" +
      "<a href=\"./guide/\">Relative</a><a href=\"guide/index.html\">Bare</a>" +
      "<a href=\"/absent/\">Root-relative</a><a href=\"https://smithers.sh/absent/\">Absolute</a>" +
      "<a href=\"./absent/\">Relative</a><img src=\"absent.png\">",
    "guide/index.html": "<h2 id=\"present\">Guide</h2>"
  })
  assert.deepEqual(checkBuiltSite(root).failures, [
    "index.html: missing /absent/ (resolved to /absent/)",
    "index.html: missing https://smithers.sh/absent/ (resolved to /absent/)",
    "index.html: missing ./absent/ (resolved to /absent/)",
    "index.html: missing absent.png (resolved to /absent.png)"
  ])
})

test("a nested page resolves its own fragments and its sibling paths, and skips what this origin does not serve", (t) => {
  const root = fixture(t, {
    "docs/guide/index.html":
      "<h2 id=\"present\">Guide</h2><a href=\"#present\">This page</a><a href=\"#absent\">This page</a>" +
      "<a href=\"../reference/\">Sibling</a><a href=\"../missing/\">Sibling</a>" +
      "<a href=\"../reference/#present\">Sibling anchor</a><a href=\"../reference/#absent\">Sibling anchor</a>" +
      "<a href=\"mailto:hello@smithers.sh\">Mail</a><a href=\"\">This page</a>",
    "docs/reference/index.html": "<h2 id=\"present\">Reference</h2>"
  })
  assert.deepEqual(checkBuiltSite(root).failures, [
    "docs/guide/index.html: missing anchor #absent (resolved to /docs/guide/index.html#absent)",
    "docs/guide/index.html: missing ../missing/ (resolved to /docs/missing/)",
    "docs/guide/index.html: missing anchor ../reference/#absent (resolved to /docs/reference/#absent)"
  ])
})

test("app-served paths are exempt only when named, and only at that exact path", (t) => {
  const root = fixture(t, {
    "index.html":
      "<a href=\"https://smithers.sh/smithersai/smithers\">Open in Smithers</a><a href=\"/api/public/repos\">Catalog</a><a href=\"https://smithers.sh/smithersai/smithers/issues\">Issues</a>"
  })
  const unnamed = checkBuiltSite(root).failures
  assert.equal(unnamed.length, 3)
  assert.ok(unnamed.some((failure) => /missing https:\/\/smithers\.sh\/smithersai\/smithers /.test(failure)))
  assert.deepEqual(checkBuiltSite(root, [], ["/api/public/repos", "/smithersai/smithers"]).failures, [
    "index.html: missing https://smithers.sh/smithersai/smithers/issues (resolved to /smithersai/smithers/issues)"
  ])
})

test("release URLs use the emitted removal table and exclude canonical verbs and prose punctuation", async (t) => {
  const root = fixture(t, {
    "packages/smithers/src/Unsupported.ts": `
export const migrationUrl = "https://smithers.sh/migration/1.0"
export const removedVerbs = [{ name: "rewind" }, { name: "worktrees", subcommands: ["list"] }, { name: "graph" }, { name: "new-removal" }]
export const removedFlags = [{ anchor: "databases" }]
`,
    "packages/smithers/src/cli/Compatibility.ts":
      `export const legacyArguments = (args) => args[0] === "graph" ? undefined : args`,
    "apps/site/src/data/removed-commands.json": JSON.stringify({
      migrationUrl: "https://smithers.sh/migration/1.0",
      anchors: ["rewind", "worktrees", "databases", "flows", "run-data"]
    }),
    "CHANGELOG.md":
      "See https://smithers.sh/changelogs/1.0.0-rc.0. Older https://smithers.sh/changelogs/0.34.0, also [current](https://smithers.sh/changelogs/1.0.0-rc.0)."
  })
  const references = await releaseReferences(root)
  assert.ok(references.includes("https://smithers.sh/migration/1.0#rewind"))
  assert.ok(references.includes("https://smithers.sh/migration/1.0#worktrees"))
  assert.ok(references.includes("https://smithers.sh/migration/1.0#databases"))
  assert.ok(!references.includes("https://smithers.sh/migration/1.0#graph"))
  assert.ok(references.includes("https://smithers.sh/migration/1.0#new-removal"))
  assert.deepEqual(references.filter((url) => url.includes("/changelogs/")), [
    "https://smithers.sh/changelogs/1.0.0-rc.0",
    "https://smithers.sh/changelogs/0.34.0"
  ])
})

test("social card images are required references, whether emitted by path or by site URL", (t) => {
  const root = fixture(t, {
    "index.html":
      "<meta property=\"og:image\" content=\"https://smithers.sh/media/absent.png\"><meta name=\"twitter:image\" content=\"/media/og.png\">",
    "docs/index.html":
      "<meta property=\"og:image\" content=\"https://cdn.example.com/card.png\"><meta name=\"twitter:image\" content=\"https://smithers.sh/media/og.png\">",
    "media/og.png": "png"
  })
  const { failures } = checkBuiltSite(root)
  assert.deepEqual(failures, [
    "index.html: missing https://smithers.sh/media/absent.png (resolved to /media/absent.png)"
  ])
})

/*
 * The app page is cross-origin isolated (COEP require-corp), and its OPFS
 * SQLite persistence starts a dedicated module worker from a /_astro chunk.
 * The browser refuses a worker script whose response lacks a matching embedder
 * policy, so the headers file the build ships must give every chunk one. Live
 * regression after the site and the app became one build: /_astro/opfs-worker-*.js
 * answered net::ERR_BLOCKED_BY_RESPONSE and the app fell back to localStorage.
 */
test("the built _headers gives every /_astro chunk the embedder and resource policies the OPFS worker needs", (t) => {
  const root = fixture(t, {
    "_headers": [
      "# hashed chunks",
      "/_astro/*",
      "  Cache-Control: public, max-age=31536000, immutable",
      "  Cross-Origin-Embedder-Policy: require-corp",
      "  Cross-Origin-Resource-Policy: same-origin",
      ""
    ].join("\n")
  })
  assert.deepEqual(checkAssetHeaders(root), [])
})

test("a _headers that only caches the chunks fails, naming each missing header", (t) => {
  const root = fixture(t, { "_headers": "/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n" })
  assert.deepEqual(checkAssetHeaders(root), [
    "_headers: /_astro/* must set cross-origin-embedder-policy: require-corp (got nothing)",
    "_headers: /_astro/* must set cross-origin-resource-policy: same-origin (got nothing)"
  ])
  assert.deepEqual(checkAssetHeaders(fixture(t, {})), ["_headers: missing the /_astro/* rule"])
  const cors = fixture(t, {
    "_headers":
      "/_astro/*\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: cross-origin\n"
  })
  assert.deepEqual(checkAssetHeaders(cors), [
    "_headers: /_astro/* must set cross-origin-resource-policy: same-origin (got cross-origin)"
  ])
})

test("a chunk rule that sets COOP fails: the opener policy is the app Worker's, on the document", (t) => {
  const root = fixture(t, {
    "_headers": [
      "/_astro/*",
      "  Cross-Origin-Opener-Policy: same-origin",
      "  Cross-Origin-Embedder-Policy: require-corp",
      "  Cross-Origin-Resource-Policy: same-origin",
      ""
    ].join("\n")
  })
  assert.deepEqual(checkAssetHeaders(root), [
    "_headers: /_astro/* must not set cross-origin-opener-policy; the app Worker sets it on the document"
  ])
})

test("the source public/_headers the build copies into dist already passes, so the build check is not the first to see it", () => {
  const publicDir = resolve(import.meta.dirname, "../public")
  assert.deepEqual(checkAssetHeaders(publicDir), [])
  assert.deepEqual(Object.keys(ASSET_HEADERS), ["cross-origin-embedder-policy", "cross-origin-resource-policy"])
})

test("the landing page's Get started for free opens the tutorial, through Astro's scoped class names", (t) => {
  const actions = (href, attrs = ' data-app-document="/smithersai/smithers/"') =>
    `<div class="actions astro-lcdefpme"><script>document.documentElement.classList.add("js")</script>` +
    `<a id="start" class="start astro-lcdefpme" href="${href}" aria-keyshortcuts="s"${attrs}><span>Get started for free</span></a></div>`
  const app = "/smithersai/smithers/"
  assert.deepEqual(checkLandingActions(fixture(t, { "index.html": actions("/?tutorial") }), app), [])
  assert.deepEqual(checkLandingActions(fixture(t, { "index.html": actions(app) }), app), [
    "index.html: Get started for free must open the tutorial at /?tutorial, got /smithersai/smithers/"
  ])
  const intoDocs = checkLandingActions(fixture(t, { "index.html": actions("/docs/quickstart/") }), app)
  assert.deepEqual(intoDocs, ["index.html: Get started for free must open the tutorial at /?tutorial, got /docs/quickstart/"])
  assert.deepEqual(checkLandingActions(fixture(t, { "index.html": actions("/?tutorial", "") }), app), [
    "index.html: Get started for free must load the app document at /smithersai/smithers/, got no document"
  ])
  assert.deepEqual(checkLandingActions(fixture(t, { "index.html": actions("/?tutorial", ' data-app-document="/missing/repo/"') }), app), [
    "index.html: Get started for free must load the app document at /smithersai/smithers/, got /missing/repo/"
  ])
  const noStart = checkLandingActions(
    fixture(t, { "index.html": `<div class="actions"><a class="btn ghost" href="/docs/">Docs</a></div>` }),
    app
  )
  assert.deepEqual(noStart, ["index.html: the landing page has no Get started for free action"])
  const noActions = checkLandingActions(fixture(t, { "index.html": `<main><a id="start" href="${app}">x</a></main>` }), app)
  assert.deepEqual(noActions, ["index.html: the landing page has no actions"])
})


test("the build requires every coming-soon page with coming-soon copy and no app island", (t) => {
  const repos = [{ name: "Effect-TS/effect" }, { name: "withastro/starlight" }]
  const missing = fixture(t, { "effect-ts/effect/index.html": '<h1>Effect — Coming soon</h1><a href="/api/auth/github?return_to=%2Feffect-ts%2Feffect%2F">Sign in with GitHub</a>' })
  assert.deepEqual(checkRepositoryPages(missing, [], repos), ["withastro/starlight/index.html: missing from the build"])
  const app = fixture(t, { "effect-ts/effect/index.html": '<astro-island>Coming soon</astro-island>' })
  assert.deepEqual(checkRepositoryPages(app, [], [repos[0]]), ["effect-ts/effect/index.html: expected a coming-soon site page"])
  const healthy = fixture(t, Object.fromEntries(repos.map((repo) => [`${repo.name.toLowerCase()}/index.html`, `<h1>Coming soon</h1><a href="/api/auth/github?return_to=${encodeURIComponent(`/${repo.name.toLowerCase()}/`)}">Sign in with GitHub</a>`])))
  assert.deepEqual(checkRepositoryPages(healthy, [], repos), [])
})

test("built pages reject the retired GitHub App installation URL", (t) => {
  const page = (slug) => `<a href="https://github.com/apps/${slug}/installations/new">Install Smithers</a>`
  assert.deepEqual(checkBuiltSite(fixture(t, { "index.html": page("smithers") })).failures, [
    "index.html: retired GitHub App URL: https://github.com/apps/smithers/installations/new"
  ])
  assert.deepEqual(checkBuiltSite(fixture(t, { "index.html": page("team-install") })).failures, [])
})

test("coming-soon sign-in must start OAuth and return to that repository page", (t) => {
  const repo = { name: "wevm/incur" }
  for (const href of ["/api/auth/github/start?return_to=%2Fwevm%2Fincur%2F", "https://smithers.sh/", "/api/auth/github", "/api/auth/github?return_to=%2Fpricing%2F", "https://elsewhere.test/api/auth/github?return_to=%2Fwevm%2Fincur%2F"]) {
    const root = fixture(t, { "wevm/incur/index.html": `<h1>Coming soon</h1><a href="${href}">Sign in with GitHub</a>` })
    assert.match(checkRepositoryPages(root, [], [repo]).join("\n"), /sign-in.*return.*\/wevm\/incur\//i)
  }
})

test("registration prose opens the app or starts sign-in instead of the marketing page", () => {
  for (const path of ["docs/pricing.mdx"]) {
    const source = readFileSync(new URL(`../src/content/docs/${path}`, import.meta.url), "utf8")
    const registration = source.split("\n").find(line => /sign in (?:with GitHub on|to) \[/i.test(line))
    assert.ok(registration, path)
    const href = registration.match(/sign in (?:with GitHub on|to) \[[^\]]+\]\(([^)]+)\)/i)?.[1]
    const url = new URL(href, "https://smithers.sh")
    assert.equal(url.origin, "https://smithers.sh")
    assert.ok(["/api/auth/github", "/smithersai/smithers"].includes(url.pathname), `${path}: ${href}`)
  }
})

test("origin robots allows crawlers and advertises the sitemap", () => {
  const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8")
  assert.match(robots, /^User-agent: \*$/m)
  assert.match(robots, /^Allow: \/$/m)
  assert.match(robots, /^Sitemap: https:\/\/smithers\.sh\/sitemap-index\.xml$/m)
  assert.doesNotMatch(robots, /^Disallow: \/$/m)
})
