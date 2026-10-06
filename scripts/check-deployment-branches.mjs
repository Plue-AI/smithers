#!/usr/bin/env node
/** Hosting P1: freeze deployment forks until the shared composition replaces them. */
import { readFileSync, readdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

const allowedGo = new Set([
  "compose/bootstrap.go", "compose/chat_composition.go", "compose/chat_routes.go",
  "compose/delegated_issuer.go", "compose/flow_composition.go", "compose/github_sync.go",
  "compose/install_scorecard.go", "compose/main.go", "compose/router.go",
  "config/auth_mode.go", "config/validation.go", "middleware/auth.go", "routes/auth.go",
  "services/auth.go", "services/delegated_credential.go"
].map((p) => `packages/backend/internal/${p}`))
const walk = (root, path) => readdirSync(join(root, path), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(root, `${path}/${e.name}`) : [`${path}/${e.name}`])
// Preserve literals (imports and deployment strings), but remove comments.
const uncomment = (text) => text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
  (token) => token.startsWith("//") || token.startsWith("/*") ? " " : token)
export const compositionRows = (document) => {
  const rows = []
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (path.startsWith("/api/admin/") || path.startsWith("/admin/")) continue
    if (item["x-composition"] !== undefined) rows.push(`${path}#path`)
    for (const method of ["get", "put", "post", "delete", "patch", "head", "options", "trace"])
      if (item[method]?.["x-composition"] !== undefined) rows.push(`${path}#${method}`)
  }
  return rows
}
export const checkDeploymentBranches = (root) => {
  const errors = []
  let go = 0, imports = 0, app = 0
  for (const path of walk(root, "packages/backend").filter((p) => p.endsWith(".go") && !p.endsWith("_test.go"))) {
    const text = uncomment(readFileSync(join(root, path), "utf8"))
    const code = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g, (literal) => " ".repeat(literal.length))
    const count = [...code.matchAll(/\b(?:IsSingleOwner|IsMultitenant)\s*\(|\.hosted\s*\(|\bswitch[^\n{]*\b(?:Auth|auth)\.Mode\b|\b(?:Auth|auth)\.Mode\s*(?:==|!=)/g)]
      .filter((m) => !/func\s*$/.test(code.slice(Math.max(0, m.index - 10), m.index))).length
    go += count
    if (count && !allowedGo.has(path)) errors.push(`${path}: mode checks outside the 15-file allowlist`)
    if (path.startsWith("packages/backend/internal/services/") && /"[^"\n]*\/microsandbox"/.test(text)) imports++
  }
  for (const path of walk(root, "apps/app/src").filter((p) => /\.[cm]?[jt]sx?$/.test(p) && !/\.(test|spec)\./.test(p))) {
    const text = uncomment(readFileSync(join(root, path), "utf8"))
    app += [...text.matchAll(/\bhost\s*===\s*["']cloud["']|\bcapabilities\s*(?:\?\.)?\.?\s*includes\s*\(\s*["']install["']/g)].length
  }
  for (const [label, count, max] of [["Go mode checks", go, 135], ["services microsandbox imports", imports, 8], ["app deployment checks", app, 16]])
    if (count > max) errors.push(`${label}: ${count} exceeds ${max}`)
  const baseline = new Set(JSON.parse(readFileSync(new URL("./deployment-composition-baseline.json", import.meta.url), "utf8")))
  for (const path of [...walk(root, "docs/api/openapi").filter((p) => p.endsWith(".yaml")), "docs/api/openapi.yaml"])
    for (const row of compositionRows(parse(readFileSync(join(root, path), "utf8")) ?? {}))
      if (!baseline.has(row)) errors.push(`${path}: product row ${row} gains x-composition`)
  return { errors, go, imports, app }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkDeploymentBranches(resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname))
    console.log(JSON.stringify(result))
    process.exitCode = result.errors.length ? 1 : 0
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
