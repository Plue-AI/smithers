import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"
import { applicationTarget } from "../../../../site/src/lib/applicationTarget"
import { APPLICATION_TARGET_META, loadApplicationTarget } from "./ApplicationTargetRuntime"
import { createApplicationClient } from "./ApplicationClient"

test("both hosted document entrypoints select session-auth web-Plue and the canonical user route", async () => {
  for (const layout of ["Base", "AppShell"]) {
    const source = readFileSync(new URL(`../../../../site/src/layouts/${layout}.astro`, import.meta.url), "utf8")
    expect(source).toContain('name="smithers-application-target" content={JSON.stringify(applicationTarget)}')
  }
  const target = await loadApplicationTarget({
    document: { querySelector: ((selector: string) => selector === `meta[name="${APPLICATION_TARGET_META}"]`
      ? { content: JSON.stringify(applicationTarget) } : null) as Document["querySelector"] }, pageOrigin: "https://canary.smithers.sh"
  })
  const calls: Array<{ path: string; credentials: RequestCredentials | undefined }> = []
  const client = createApplicationClient(target, { pageOrigin: "https://canary.smithers.sh", fetchImpl: async (input, init) => {
    calls.push({ path: String(input), credentials: init?.credentials })
    return Response.json({ id: 42, username: "verified-user", is_admin: false })
  } })
  expect(target.mode).toBe("web-plue")
  expect(target.ownership).toBe("plue")
  expect(await client.identity.current()).toEqual({ username: "verified-user", admin: false, scopes: null })
  expect(calls).toEqual([{ path: "/api/user", credentials: "include" }])
})
