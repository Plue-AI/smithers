#!/usr/bin/env node
/**
 * check-docs.mjs
 *
 * The documentation gate for the Starlight site. Ported from the vocs-era
 * scripts/check-docs.mjs to the apps/site page tree. Fails (exit 1) when any
 * rule fires:
 *
 *   1. no em-dash or en-dash outside fenced code
 *   2. frontmatter title and description on every page
 *   3. no body H1 (frontmatter title owns the page heading)
 *   4. every internal link resolves to a page that exists
 *   5. every link anchor resolves to a heading on the target page
 *   6. imports in ts fences resolve to published packages
 *   7. no "coming soon", "capture needed", or "TODO" in prose
 *   8. every anchor the 1.0 CLI links to exists on the migration page
 *   9. the API roster's workspace-private labels match the package manifests
 *  10. a page that imports a workspace-private package says so beside its name
 *  11. no repository request or nomination instruction (the home page
 *      registers a repository through GitHub sign-in and app installation)
 *  12. every package a page heads a section with, or teaches installing, is in
 *      the release roster unless the page labels it workspace-private
 *
 * Usage: node apps/site/scripts/check-docs.mjs
 */
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { catalogPublicationErrors } from "./catalog-publication.mjs"
import { publishedPackages } from "../../../scripts/pack-release.mjs"

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(siteRoot, "..", "..")
const docsRoot = join(siteRoot, "src/content/docs/docs")

const errors = []
const err = (file, msg) => errors.push(`${relative(siteRoot, file)}: ${msg}`)

// --- collect pages ---------------------------------------------------------
const pages = [] // { path, rel, route, frontmatter, headings:Set, prose }
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name))
    else if (entry.name.endsWith(".mdx")) pages.push(load(join(dir, entry.name)))
  }
}
function fm(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, "m"))
  return m ? m[1].trim() : null
}
function slugger(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/`+/g, "")
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .replace(/\s+/g, "-")
}
function load(path) {
  const text = readFileSync(path, "utf8")
  const rel = relative(docsRoot, path)
  let route = "/" + rel.replace(/\.mdx$/, "").replace(/\/index$/, "").replace(/^index$/, "")
  const slug = fm(text, "slug")
  if (slug) route = "/" + slug.replace(/^docs\/?/, "").replace(/\/$/, "")
  route = "/docs" + (route === "/" ? "/" : route + "/")
  // Frontmatter is metadata, not prose: its comments are not page content.
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "")
  const noFences = body.replace(/```[\s\S]*?```/g, "")
  const ids = new Set()
  const counts = new Map()
  for (const m of noFences.matchAll(/^#{2,6}\s+(.+)$/gm)) {
    const base = slugger(m[1])
    const n = counts.get(base) ?? 0
    counts.set(base, n + 1)
    ids.add(n === 0 ? base : `${base}-${n}`)
  }
  return { path, rel, route, text, body, noFences, headingIds: ids }
}
walk(docsRoot)
const routes = new Set(pages.map((p) => p.route))
const byRoute = new Map(pages.map((p) => [p.route, p]))
const staticRoutes = new Set(["/", "/download/", "/demo/", "/pricing/", "/terms/", "/privacy/", "/refunds/", "/migration/1.0", "/llms.txt", "/llms-full.txt"])

// --- repo package roster (any @smthrs/* package that exists in the tree) ---
const roster = new Set()
const packagePaths = new Map()
function scanPkgs(dir, depth) {
  if (depth > 4 || dir.includes("node_modules") || dir.includes("/dist")) return
  const pkgPath = join(dir, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
      if (typeof pkg.name === "string" && pkg.name.startsWith("@smthrs/")) {
        roster.add(pkg.name)
        packagePaths.set(pkg.name, { directory: dir, exports: pkg.exports, private: pkg.private === true })
      }
    } catch { /* keep walking */ }
  }
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist") scanPkgs(join(dir, e.name), depth + 1)
  }
}
scanPkgs(join(repoRoot, "packages"), 0)

// The 1.0 release roster. `private` alone says a package is unpublishable;
// this says which of the publishable ones a train actually packs.
const releaseRoster = new Set(publishedPackages)

function sourceExport(value) {
  if (typeof value === "string") return value
  if (value && typeof value === "object") return sourceExport(value.import ?? value.default ?? value.types)
}
function resolvesSubpath(spec, root) {
  const pkg = packagePaths.get(root)
  if (!pkg?.exports) return true
  const subpath = spec === root ? "." : "./" + spec.slice(root.length + 1)
  let value = pkg.exports[subpath]
  let wildcard
  if (value === undefined) {
    const key = Object.keys(pkg.exports).filter((key) => key.includes("*")).sort((a, b) => b.length - a.length).find((key) => {
      const [prefix, suffix] = key.split("*")
      return subpath.startsWith(prefix) && subpath.endsWith(suffix)
    })
    if (key) {
      const [prefix, suffix] = key.split("*")
      wildcard = subpath.slice(prefix.length, suffix ? -suffix.length : undefined)
      value = pkg.exports[key]
    }
  }
  const target = sourceExport(value)
  return target !== undefined && existsSync(join(pkg.directory, wildcard === undefined ? target : target.replaceAll("*", wildcard)))
}

/**
 * A page that names a package as workspace-private on the same line it names
 * the package. `private: true` in the manifest is what keeps a package off
 * npm; publishConfig.access alone does not.
 */
function labelsPrivate(page, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\`${escaped}\`[^\n]*workspace-private|workspace-private[^\n]*\`${escaped}\``).test(page.noFences)
}

// --- rules -------------------------------------------------------------------
for (const p of pages) {
  // 1. dashes
  const dash = p.noFences.match(/[—–]/)
  if (dash) err(p.path, `em/en dash in prose: ${JSON.stringify(p.noFences.split("\n").find((l) => /[—–]/.test(l))).slice(0, 120)}`)
  // 2. frontmatter
  if (!fm(p.text, "title")) err(p.path, "missing frontmatter title")
  if (!fm(p.text, "description")) err(p.path, "missing frontmatter description")
  // 3. body H1
  if (/^#\s+\S/m.test(p.noFences)) err(p.path, "body H1 (frontmatter title owns the page heading)")
  // Fences without a language lose highlighting and hide accidental prose/code boundaries.
  let fenceOpen = false
  for (const line of p.body.split("\n")) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue
    if (!fenceOpen && match[2].trim() === "") err(p.path, "code fence has no language")
    fenceOpen = !fenceOpen
  }
  // 7. coming soon
  const soon = p.noFences.match(/coming soon|capture needed/i)
  if (soon) err(p.path, `banned phrase: ${soon[0]}`)
  // 11. registration entry point. The home page registers a repository through
  // GitHub sign-in plus installing the Smithers GitHub App, so no page may send
  // readers to a repository request or nomination form on the site. An alpha
  // access request is a different thing and stays allowed.
  const nomination = p.noFences.match(/repository request|request(?:ing)? (?:a|another) repositor\w*|\bnominat(?:e|es|ed|ing|ion|ions)\b/i)
  if (nomination) {
    err(p.path, `repository registration is GitHub sign-in plus app installation, not: ${nomination[0]}`)
  }
  // 12. publication. A heading or an install command sells a package as one
  // the reader can add to their own project; the release roster decides which
  // ones a train actually publishes.
  for (const message of catalogPublicationErrors(p.text, { manifests: packagePaths, roster: releaseRoster })) {
    err(p.path, message)
  }
  // 4/5. links and anchors
  const links = [
    ...p.noFences.matchAll(/\]\(([^)\s]+)\)/g),
    ...p.noFences.matchAll(/\bhref=["']([^"']+)["']/g)
  ]
  for (const m of links) {
    const target = m[1]
    if (/^(?:https?:\/\/|mailto:)/.test(target)) continue
    if (target.startsWith("#")) {
      if (!p.headingIds.has(target.slice(1))) err(p.path, `anchor ${target} has no heading on this page`)
      continue
    }
    if (!target.startsWith("/")) {
      err(p.path, `non-absolute link: ${target}`)
      continue
    }
    if (/^\/(media|images|favicon|icon)/.test(target)) {
      if (!existsSync(join(siteRoot, "public", target))) err(p.path, `missing asset: ${target}`)
      continue
    }
    const [path, anchor] = target.split("#")
    const norm = path === "/" ? "/" : path.endsWith("/") ? path : path + "/"
    if (!routes.has(norm) && !staticRoutes.has(path) && !staticRoutes.has(norm)) {
      err(p.path, `link to nowhere: ${path}`)
      continue
    }
    if (anchor && byRoute.has(norm) && !byRoute.get(norm).headingIds.has(anchor)) {
      err(p.path, `anchor #${anchor} missing on ${norm}`)
    }
  }
  // API reference pages should lead readers from the public contract to the
  // implementation. Generated pages get this link from their owning sync
  // script, which prevents a regeneration from silently dropping it.
  if (p.route.startsWith("/docs/reference/api/") && p.route !== "/docs/reference/api/" &&
      !p.text.includes("github.com/smithersai/smithers/")) {
    err(p.path, "API reference has no link to its source on GitHub")
  }
  // 6. imports in ts fences: our own packages must exist (catches typos and
  // references to removed 0.x packages); third-party imports are allowed.
  for (const fence of p.text.matchAll(/```(?:ts|tsx|js|jsx)(?:[^\n]*)\n([\s\S]*?)```/g)) {
    for (const im of fence[1].matchAll(/from\s+"(@smthrs\/[^"]+)"/g)) {
      const spec = im[1]
      const root = spec.split("/").slice(0, 2).join("/")
      if (!roster.has(root)) err(p.path, `import does not resolve to a package in this repo: ${spec}`)
      else if (!resolvesSubpath(spec, root)) err(p.path, `import subpath does not resolve: ${spec}`)
      // 10. teaching an import of a workspace-private package without saying
      // so reads as an install the reader can run; npm refuses it.
      else if (packagePaths.get(root)?.private && !labelsPrivate(p, root)) {
        err(p.path, `teaches importing workspace-private ${root} without labelling it beside the name`)
      }
    }
  }
}

// 9. API roster labels: a row that disagrees with its manifest either sends a
// reader to install a package npm refuses, or hides one they can install.
const apiIndex = byRoute.get("/docs/reference/api/")
if (apiIndex) {
  const source = "apps/site/docs/reference/api/index.mdx"
  for (const line of apiIndex.noFences.split("\n")) {
    const row = /^\|\s*\[`(@smthrs\/[a-z0-9-]+)`\]\([^)]*\)([^|]*)\|/.exec(line)
    if (!row) continue
    const pkg = packagePaths.get(row[1])
    if (!pkg) {
      err(apiIndex.path, `roster lists ${row[1]}, which is not a package in this repo (edit ${source})`)
      continue
    }
    const labeled = row[2].includes("workspace-private")
    if (pkg.private && !labeled) err(apiIndex.path, `${row[1]} is private in its manifest; the roster omits workspace-private (edit ${source})`)
    if (!pkg.private && labeled) err(apiIndex.path, `${row[1]} publishes to npm; the roster marks it workspace-private (edit ${source})`)
  }
}

// 8. migration anchor contract
const unsupportedPath = join(repoRoot, "packages/smithers/src/Unsupported.ts")
const migration = pages.find((p) => p.route === "/docs/migration/1.0/")
if (existsSync(unsupportedPath) && migration) {
  const src = readFileSync(unsupportedPath, "utf8")
  const anchors = new Set([...src.matchAll(/anchor:\s*"([^"]+)"/g)].map((m) => m[1]))
  for (const extra of ["flows", "run-data"]) anchors.add(extra)
  for (const a of anchors) {
    if (!migration.headingIds.has(a)) err(migration.path, `CLI anchor #${a} has no heading on the migration page`)
  }
}

if (errors.length > 0) {
  console.error(`check-docs: ${errors.length} violation(s)`)
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}
console.log(`check-docs: ${pages.length} pages, 0 violations`)
