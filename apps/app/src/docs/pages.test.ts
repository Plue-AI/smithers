import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { createCommandRegistry } from "../mainview/flows/Commands"
import type { CommandActions } from "../mainview/flows/entries/Declare"
import { slashTree, unmetRequirements, visible, type CommandState } from "../mainview/flows/registry"

const directory = new URL("./pages/", import.meta.url)
const pages = new Map(readdirSync(directory).filter(name => name.endsWith(".md"))
  .map(name => [name, readFileSync(new URL(name, directory), "utf8")]))
const body = (markdown: string) => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
const withoutFences = (markdown: string) => markdown.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "")
const anchors = (markdown: string) => {
  const counts = new Map<string, number>()
  return new Set([...withoutFences(body(markdown)).matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => {
    const slug = match[1]!.toLowerCase().replace(/[`*_]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-")
    const count = counts.get(slug) ?? 0
    counts.set(slug, count + 1)
    return count === 0 ? slug : `${slug}-${count}`
  }))
}

test("pages have title and summary frontmatter only", () => {
  expect(pages.size).toBeGreaterThan(0)
  for (const markdown of pages.values()) {
    const fields = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]?.split(/\r?\n/)
    expect(fields?.map(field => field.split(":")[0]).sort()).toEqual(["summary", "title"])
    for (const field of fields!) expect(field).toMatch(/^(?:title|summary): "[^"\r\n]+"$/)
  }
})

test("relative links and anchors resolve", () => {
  for (const [name, markdown] of pages) {
    for (const match of withoutFences(body(markdown)).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1]!
      if (/^https?:\/\//.test(href)) continue
      const target = new URL(href, new URL(name, directory))
      const destination = readFileSync(target, "utf8")
      if (target.hash) expect(anchors(destination).has(decodeURIComponent(target.hash.slice(1)))).toBe(true)
    }
  }
})

test("page prose uses product words", () => {
  // C-UI-02 terms, from spec.md §14.6b.
  const terms = ["workflow", "thread", "task", "lane", "box", "workspace", "mythical", "sandbox", "VM", "seat", "profile", "Jev", "forge"]
  const banned = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${terms.join("|")})(?:s|es)?(?=$|[^\\p{L}\\p{N}])`, "iu")
  for (const markdown of pages.values()) expect(withoutFences(markdown).replace(/(`+)[^`\n]*\1/g, "")).not.toMatch(banned)
})

const member: CommandState = {
  surface: "chat", typing: false, hasConnectors: false, admin: false, signedOut: false
}
const discovery = {
  debugApi: { available: () => false },
  bootstrap: { apiVersion: 1, host: "local", version: "docs-test", buildSha: "docs-test",
    capabilities: [], authFlow: "none", sandbox: null },
  snapshot: () => member,
  repositoryFlows: () => undefined
}
const actions = new Proxy(discovery, {
  get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : () => undefined
}) as unknown as CommandActions
const registry = createCommandRegistry(actions)
const commands = visible(registry.all()).filter(command => unmetRequirements(command, member).length === 0)
const names = new Set(registry.all().map(command => command.name))

const resolvesSlash = (query: string): boolean => {
  if (names.has(query)) return true
  if (query.includes(".") && !query.endsWith(".")) return false
  // Bare fragments and trailing dots are menu queries, not flow invocations.
  return slashTree(member, query, commands).some(row => row.kind === "flow" || row.kind === "namespace")
}

test("slash references resolve against the generated MVP catalog and source registry", () => {
  const catalog = JSON.parse(readFileSync(new URL("../../../../catalog.mvp.json", import.meta.url), "utf8"))
  const slashes = new Set(catalog.operations.map((operation: { slash: string | null }) => operation.slash))
  const references = [...pages.values()].flatMap(markdown => {
    const spans = [...markdown.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm)].map(match => match[2]!)
    spans.push(...[...withoutFences(markdown).matchAll(/(`+)([^`\n]+)\1/g)].map(match => match[2]!))
    return spans.flatMap(span => [...span.matchAll(/(?:^|\s)\/([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|)(?=$|[^a-z0-9_./-])/g)].map(match => match[1]!))
  })
  expect(references.length).toBeGreaterThan(0)
  for (const query of references) {
    expect({ query, resolves: resolvesSlash(query) }).toEqual({ query, resolves: true })
    if (query) expect(slashes.has(`/${query}`)).toBe(true)
  }
})


test("the docs index and release links are exact", () => {
  expect([...pages.keys()].sort()).toEqual(["flows.md", "quickstart.md"])
  expect(pages.get("quickstart.md")).toMatch(/^---\ntitle: "Quickstart"/ )
  expect(pages.get("flows.md")).toMatch(/^---\ntitle: "Flows reference"/ )
  const quickstart = pages.get("quickstart.md")!
  const https = quickstart.split("## Put HTTPS in front\n")[1]!.split("\n## ")[0]!
  expect(https).toContain("Tailscale")
  expect(https).toContain("Caddy")
  expect(quickstart.replace(https, "")).not.toMatch(/tailscale|caddy/i)
  for (const markdown of pages.values()) {
    for (const match of markdown.matchAll(/\]\((https:\/\/smithers\.sh\/docs\/[^)]+)\)/g)) {
      const path = new URL(match[1]!).pathname
      expect(path === "/docs/installation/" || path === "/docs/reference/http-api/" || path.startsWith("/docs/reference/api/")).toBe(true)
    }
  }
  expect(quickstart).toContain("https://smithers.sh/docs/reference/http-api/")
  expect(anchors(quickstart).has("put-https-in-front")).toBe(true)
  expect(quickstart).toContain("tailscale serve --bg --https=443 http://127.0.0.1:4000")
  expect(quickstart).toContain("--tcp=2222")
  expect(quickstart).toContain("header_up Host {http.request.host}")
  expect(quickstart).toContain("proxy on another host must pass the original `Host`")
  expect(quickstart).toContain("Hypervisor.framework")
  expect(quickstart).toContain("automatic login")
  expect(quickstart).toContain("stop the original install first")
  expect(pages.get("flows.md")).not.toMatch(/tailscale|caddy/i)
})


test("quickstart includes shipped LAN commands without duplicate sections", () => {
  const quickstart = pages.get("quickstart.md")!
  for (const command of ["brew install smithersai/tap/smithers", "smthrs host start --bind 0.0.0.0 --origin http://studio-mini.local:4000"]) expect(quickstart).toContain(command)
  const headings = [...quickstart.matchAll(/^## (.+)$/gm)].map(match => match[1])
  expect(new Set(headings).size).toBe(headings.length)
})
