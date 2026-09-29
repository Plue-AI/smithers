import { expect, test } from "bun:test"
import { PLATFORM_PROXY_RULES, platformProxyRuleCovers } from "smithers-server/index"
import { rankTutorialRepositories } from "./RepositoriesSeam"
const now = Date.parse("2026-09-09T00:00:00Z")
/** plue serves the inventory at exactly /user/github-repos and no per-repo commits route: anything else is a 404. */
const plue = (rows: unknown[], headers?: Record<string, string>) => async (url: string) => {
  const u = new URL(url)
  if (u.pathname !== "/api/user/github-repos") return new Response("", { status: 404 })
  return u.searchParams.get("page") === "1" ? Response.json(rows, { headers }) : Response.json([])
}
test("ranks the inventory by pushed_at through the allowlisted path only", async () => {
  const urls: string[] = []
  const result = await rankTutorialRepositories(async url => { urls.push(url); return plue([
    { full_name: "org/old", pushed_at: "2020-01-01T00:00:00Z" }, { full_name: "org/recent", pushed_at: "2026-09-08T00:00:00Z" },
    { full_name: "org/recent", pushed_at: "2026-09-08T00:00:00Z" }, { full_name: "bad name", pushed_at: "2026-09-08T00:00:00Z" }, { full_name: "org/unknown" }
  ])(url) }, "https://local.test", now)
  expect(result.error).toBeNull()
  expect(result.repositories.map(r => [r.fullName, r.latest])).toEqual([["org/recent", "2026-09-08T00:00:00.000Z"], ["org/old", "2020-01-01T00:00:00.000Z"], ["org/unknown", null]])
  expect(urls.every(url => url.startsWith("https://local.test/api/user/github-repos?"))).toBe(true)
  for (const url of urls) expect(PLATFORM_PROXY_RULES.some(rule => rule.prefix !== undefined && platformProxyRuleCovers(rule, new URL(url).pathname) && rule.methods.includes("GET"))).toBe(true)
})
test("paginates with the link header and reports a refused inventory", async () => {
  const paged = await rankTutorialRepositories(async url => new URL(url).searchParams.get("page") === "1"
    ? Response.json([{ full_name: "org/a" }], { headers: { link: '<https://api.github.com/ignored>; rel="next"' } })
    : Response.json([{ full_name: "org/b", pushed_at: "2026-09-01T00:00:00Z" }]), "https://local.test", now)
  expect(paged.repositories.map(r => r.fullName)).toEqual(["org/b", "org/a"])
  const refused = await rankTutorialRepositories(async () => new Response("", { status: 403 }), "", now)
  expect(refused.repositories).toEqual([])
  expect(refused.error).toBe("GitHub read unavailable (403).")
})
test("a thrown inventory read reports a product sentence, never the thrown text", async () => {
  const dropped = await rankTutorialRepositories(async () => { throw new TypeError("ECONNRESET secret-socket-detail") }, "", now)
  expect(dropped).toMatchObject({ repositories: [], partial: true, error: "Could not read your GitHub repositories." })
  const garbled = await rankTutorialRepositories(async () => new Response("<html>secret-body", { status: 200 }), "", now)
  expect(garbled.error).toBe("Could not read your GitHub repositories.")
})
