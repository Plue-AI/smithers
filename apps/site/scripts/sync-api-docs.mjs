#!/usr/bin/env node
/**
 * sync-api-docs.mjs
 *
 * Stitches each published package's colocated docs/api.md into a Starlight
 * reference page at src/content/docs/docs/reference/api/<short-name>.mdx.
 *
 * The colocated api.md stays the source of truth; this script rewrites the
 * links that targeted the old vocs routes, strips the stale generator
 * sentence, and prepends frontmatter. `--check` reports drift instead of
 * writing, so CI can fail when a package's docs change without a re-sync.
 *
 * Usage: node apps/site/scripts/sync-api-docs.mjs [--check]
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs"
import { join, relative, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { sites } from "../../docs/shared/manifest.mjs"
import { outputRelFor, routeFor } from "../../docs/shared/sync-content.mjs"

/**
 * npm name to docs-site slug, read from the docs fleet's manifest rather than
 * derived from the package name. The two differ where a subdomain is already
 * taken: `@smthrs/build` documents at smithers-build.smithers.sh, because
 * build.smithers.sh is the build remote cache.
 */
const siteSlugByName = new Map(sites.map((site) => [site.name, site.slug]))
const apiShortBySiteSlug = new Map(
  sites.map((site) => [site.slug, site.name.replace("@smthrs/", "")])
)

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(siteRoot, "..", "..")
const outDir = join(siteRoot, "src/content/docs/docs/reference/api")
const checkMode = process.argv.includes("--check")

/**
 * reference/api/ is shared with scripts/ingest-reference.mjs, which owns the
 * pages for packages that carry agent-written docs/reference/*.md (wired into
 * //apps/site:referenceIngest). Those slugs are skipped here so a re-run can
 * never clobber their pages. As their coverage grows, add the slugs below.
 */
const foreignOwned = new Set(["flow", "engine", "targets"])

/** Discover published packages carrying a colocated docs/api.md. */
function discover() {
  const roots = [join(repoRoot, "packages")]
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    if (dir.includes("node_modules") || dir.includes("/dist")) return
    const pkgPath = join(dir, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
        const apiPath = join(dir, "docs", "api.md")
        if (pkg.publishConfig?.access === "public" && pkg.name?.startsWith("@smthrs/") && existsSync(apiPath)) {
          found.push({ name: pkg.name, description: pkg.description ?? "", dir, apiPath, manifest: pkg })
        }
      } catch {
        /* not a parseable package.json; keep walking */
      }
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
        walk(join(dir, entry.name), depth + 1)
      }
    }
  }
  for (const root of roots) walk(root, 0)
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

const yamlQuote = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\s+/g, " ").trim()}"`

/** Rewrite old vocs-era links to Starlight routes. Returns [text, warnings]. */
function rewriteLinks(text, pkg) {
  const warnings = []
  let out = text
  // /api/<pkg> and https://smithers.sh/api/<pkg> -> /docs/reference/api/<pkg>/
  out = out.replace(
    /\]\((?:https:\/\/smithers\.sh)?\/api\/([a-z0-9-]+)(#[^)]+)?\)/gi,
    (_m, seg, frag) => {
      const short = apiShortBySiteSlug.get(seg.toLowerCase()) ?? seg.toLowerCase()
      return `](/docs/reference/api/${short}/${frag ?? ""})`
    }
  )
  // Bare /api -> the API overview
  out = out.replace(/\]\((?:https:\/\/smithers\.sh)?\/api\)/gi, "](/docs/reference/api/)")
  // /pkg/<slug>/<path> -> the page on that package's own site. Only the API
  // page of a package is mirrored onto smithers.sh, so every other page of the
  // fleet is reachable from here only at its own hostname.
  out = out.replace(
    /\]\(\/pkg\/([a-z0-9-]+)((?:\/[^#)]*)?)(#[^)]+)?\)/gi,
    (_m, seg, rest, frag) => {
      const path = (rest ?? "").replace(/^\/+|\/+$/g, "")
      return `](https://${seg.toLowerCase()}.smithers.sh${path === "" ? "/" : `/${path}/`}${frag ?? ""})`
    }
  )
  // /cli and /cli/<verb> -> /docs/reference/cli/...
  out = out.replace(/\]\((?:https:\/\/smithers\.sh)?\/cli\/([a-z0-9-]+)(#[^)]+)?\)/gi, (_m, seg, frag) => `](/docs/reference/cli/${seg.toLowerCase()}/${frag ?? ""})`)
  out = out.replace(/\]\((?:https:\/\/smithers\.sh)?\/cli\)/gi, "](/docs/reference/cli/)")
  // A package README is read on npmjs.com, where a site-relative href is a
  // 404, so it spells the published route in full. The same sentence reaches
  // this site through api.md, where the route is already local.
  out = out.replace(
    /\]\(https:\/\/smithers\.sh(\/docs\/reference\/cli\/(?:[a-z0-9-]+\/)?)(#[^)]+)?\)/gi,
    (_m, path, frag) => `](${path}${frag ?? ""})`
  )
  // smithers.sh/migration/1.0 -> site-relative
  out = out.replace(/\]\(https:\/\/smithers\.sh\/migration\/1\.0(#[^)]+)?\)/gi, (_m, frag) => `](/docs/migration/1.0/${frag ?? ""})`)
  // A relative .md link in api.md names a sibling page of the package's own
  // docs tree (./testing.md, ./concepts/engine-port.md). That page exists, but
  // on the package's site rather than here, so the link resolves to
  // <slug>.smithers.sh through the same source-path-to-route mapping
  // sync-content.mjs applies when it stitches that site. Sending these to
  // GitHub instead, as this script did before the per-package sites existed,
  // dropped a reader out of the docs and into a raw file.
  //
  // A package with no site (nothing in the docs manifest) keeps the old
  // GitHub behaviour: the file is the only target that exists for it.
  const repoRel = relative(repoRoot, pkg.apiPath).split("\\").join("/")
  const docsDirUrl = `https://github.com/smithersai/smithers/blob/main/${dirname(repoRel)}`
  const slug = siteSlugByName.get(pkg.name)
  const relTarget = (file, frag) => {
    const clean = file.replace(/^\.\//, "")
    if (slug === undefined) return `${docsDirUrl}/${clean}${frag ?? ""}`
    return `https://${slug}.smithers.sh${routeFor(outputRelFor(clean))}${frag ?? ""}`
  }
  out = out.replace(/\]\((\.\/)?((?:[a-z0-9-]+\/)*[a-z0-9-]+\.md)(#[^)]+)?\)/gi, (_m, _dot, f, frag) => `](${relTarget(f, frag)})`)
  // Anything still pointing at smithers.sh is suspect: report it.
  for (const m of out.matchAll(/\]\(https:\/\/smithers\.sh([^)]*)\)/g)) {
    warnings.push(`unrewritten smithers.sh link: ${m[1]}`)
  }
  return [out, warnings]
}

function transform(pkg) {
  const warnings = []
  let body = readFileSync(pkg.apiPath, "utf8").trimStart()
  // A source may carry its own frontmatter (the per-package sites require
  // it); this page keeps exactly the script's block, so the source's goes.
  body = body.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "").trimStart()
  // Strip a leading H1: frontmatter title owns the page heading.
  body = body.replace(/^#\s+[^\n]+\n+/, "")
  // The old generator appended export tables; the line is stale here.
  const stale = /The export tables at the end of the page are generated[^\n]*\n?/g
  if (stale.test(body)) {
    body = body.replace(stale, "")
  }
  const [rewritten, linkWarnings] = rewriteLinks(body, pkg)
  warnings.push(...linkWarnings)
  // Em/en dash scan outside fences: warn so the gate owner can fix upstream.
  const prose = rewritten.replace(/```[\s\S]*?```/g, "")
  const dashes = (prose.match(/[—–]/g) ?? []).length
  if (dashes > 0) warnings.push(`${dashes} em/en dash(es) outside code fences`)
  const short = pkg.name.replace("@smthrs/", "")
  if (foreignOwned.has(short)) return { short, page: null, warnings: [] }
  const packagePath = relative(repoRoot, pkg.dir).split("\\").join("/")
  // This page is the aggregate reference; the package's own site is the whole
  // documentation set for it (quickstart, concepts, guides). Link out to it so
  // a reader who arrives here through search can reach the rest.
  const siteSlug = siteSlugByName.get(pkg.name)
  const siteLink = siteSlug === undefined ? "" : ` · [package docs](https://${siteSlug}.smithers.sh)`
  const sourceLinks = `> **Source:** [implementation](https://github.com/smithersai/smithers/tree/main/${packagePath}/src) · [reference source](https://github.com/smithersai/smithers/blob/main/${packagePath}/docs/api.md)${siteLink}`
  // `private: true` is what keeps a package off npm; publishConfig.access
  // alone does not. Say so on the page, so the roster label and the reference
  // page cannot disagree about what a reader can install.
  const privateNote = pkg.manifest.private === true
    ? `\n\n> **workspace-private:** \`${pkg.name}\` is documented for contributors and is not installable from npm.`
    : ""
  const relatedPackages = [...new Set([
    ...Object.keys(pkg.manifest.dependencies ?? {}),
    ...Object.keys(pkg.manifest.peerDependencies ?? {})
  ])].filter((name) => apiPackageNames.has(name)).sort()
  const relatedLinks = relatedPackages.length === 0 ? "" : `\n\n> **Related APIs:** ${relatedPackages.map((name) => `[\`${name}\`](/docs/reference/api/${name.replace("@smthrs/", "")}/)`).join(" · ")}`
  // MDX has no HTML comments; the colocated READMEs mark generated regions with them.
  const mdxBody = rewritten.trim().replace(/<!--([\s\S]*?)-->/g, "{/*$1*/}")
  const page = `---
title: ${yamlQuote(pkg.name)}
description: ${yamlQuote(pkg.description)}
editUrl: ${yamlQuote(`https://github.com/smithersai/smithers/edit/main/${packagePath}/docs/api.md`)}
---

{/* Generated by apps/site/scripts/sync-api-docs.mjs from ${relative(repoRoot, pkg.apiPath).split("\\").join("/")}. Edit the source file, then re-run the script. */}

${sourceLinks}${privateNote}${relatedLinks}

${mdxBody}
`
  return { short, page, warnings }
}

const packages = discover()
const apiPackageNames = new Set(packages.map((pkg) => pkg.name))
if (packages.length === 0) {
  throw new Error("sync-api-docs: no published packages with docs/api.md found")
}

let drift = 0
let written = 0
const allWarnings = []
const expectedPaths = new Set()
for (const pkg of packages) {
  const { short, page, warnings } = transform(pkg)
  if (page === null) continue
  written++
  const outPath = join(outDir, `${short}.mdx`)
  expectedPaths.add(outPath)
  for (const w of warnings) allWarnings.push(`${pkg.name}: ${w}`)
  if (checkMode) {
    if (!existsSync(outPath) || readFileSync(outPath, "utf8") !== page) {
      console.error(`drift: ${relative(siteRoot, outPath)}`)
      drift++
    }
  } else {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(outPath, page)
  }
}

// Prune only this generator's pages; ingest-reference owns other files here.
for (const name of readdirSync(outDir)) {
  const path = join(outDir, name)
  if (!name.endsWith(".mdx") || expectedPaths.has(path)) continue
  if (!readFileSync(path, "utf8").includes("Generated by apps/site/scripts/sync-api-docs.mjs from ")) continue
  if (checkMode) { console.error(`retired: ${relative(siteRoot, path)}`); drift++ }
  else unlinkSync(path)
}

console.log(`${checkMode ? "checked" : "wrote"} ${written} API pages (${packages.length - written} skipped, owned by ingest-reference.mjs):`)
for (const p of packages) console.log(`  ${p.name}`)
if (allWarnings.length > 0) {
  console.log("warnings:")
  for (const w of allWarnings) console.log(`  ${w}`)
}
if (checkMode && drift > 0) {
  console.error(`sync-api-docs: ${drift} page(s) out of date; run node apps/site/scripts/sync-api-docs.mjs`)
  // exitCode rather than an exit call: exiting can drop queued output on a macOS
  // pipe, which reads as a failure with no reason.
  process.exitCode = 1
}
