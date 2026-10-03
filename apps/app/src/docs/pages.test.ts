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
const names = new Set(commands.map(command => command.name))

const resolvesSlash = (query: string): boolean => {
  if (query.includes(".") && !query.endsWith(".")) return names.has(query)
  // Bare fragments and trailing dots are menu queries, not flow invocations.
  return slashTree(member, query, commands).some(row => row.kind === "flow" || row.kind === "namespace")
}

test("slash references resolve against visible member-reachable flows", () => {
  const references = [...pages.values()].flatMap(markdown => {
    const spans = [...markdown.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm)].map(match => match[2]!)
    spans.push(...[...withoutFences(markdown).matchAll(/(`+)([^`\n]+)\1/g)].map(match => match[2]!))
    return spans.flatMap(span => [...span.matchAll(/(?:^|[^\w/])\/([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|)(?=$|[^a-z0-9_./-])/g)].map(match => match[1]!))
  })
  expect(references.length).toBeGreaterThan(0)
  for (const query of references) expect(resolvesSlash(query)).toBe(true)
})
