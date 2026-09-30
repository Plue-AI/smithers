import { expect, test } from "bun:test"
import type { ApplicationTargetDocument } from "@smthrs/rpc/ApplicationTarget"
import { createApplicationClient } from "./ApplicationClient"
import { APPLICATION_TARGET_META, loadApplicationTarget } from "./ApplicationTargetRuntime"

// The hosted site's document; the site's own test pins that both layouts emit it.
const hosted = {
  apiVersion: 1,
  mode: "web-plue",
  apiOrigin: "",
  auth: { kind: "session" },
  cors: "same-origin",
  developerExternal: false
} satisfies ApplicationTargetDocument

test("a hosted document selects session-auth web-Plue and the canonical user route", async () => {
  const target = await loadApplicationTarget({
    document: { querySelector: ((selector: string) => selector === `meta[name="${APPLICATION_TARGET_META}"]`
      ? { content: JSON.stringify(hosted) } : null) as Document["querySelector"] }, pageOrigin: "https://canary.smithers.sh"
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
