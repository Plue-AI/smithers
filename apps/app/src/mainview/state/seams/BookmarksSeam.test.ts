import { expect, test } from "bun:test"
import { fetchAllBookmarks } from "./BookmarksSeam"
import type { SeamContext } from "./SeamContext"

test("bookmark source choices retain pagination and discard malformed rows", async () => {
  const calls: string[] = []
  const ctx = { baseUrl: "", http: async (path: string) => {
    calls.push(path)
    return Response.json(path.includes("cursor=next")
      ? { items: [{ name: "main", target_change_id: "m1", target_commit_id: "" }], next_cursor: "" }
      : { items: [{ name: "feature", target_change_id: "f1", target_commit_id: "abc", is_tracking_remote: true }, {}], next_cursor: "next" })
  } } as SeamContext
  expect(await fetchAllBookmarks(ctx, "will/flows")).toEqual({ rows: [
    { name: "feature", targetChangeId: "f1", targetCommitId: "abc", isTrackingRemote: true },
    { name: "main", targetChangeId: "m1", targetCommitId: null, isTrackingRemote: false }
  ] })
  expect(calls).toEqual(["/api/repos/will/flows/bookmarks?limit=100", "/api/repos/will/flows/bookmarks?limit=100&cursor=next"])
})

for (const failure of ["network", "server", "malformed", "cursor"] as const) test(`bookmark source ${failure} failure remains explicit`, async () => {
  const ctx = { baseUrl: "", http: async () => {
    if (failure === "network") throw new Error("network")
    if (failure === "server") return new Response("failed", { status: 500 })
    return Response.json(failure === "malformed" ? [] : { items: [], next_cursor: "repeated" })
  } } as unknown as SeamContext
  expect(await fetchAllBookmarks(ctx, "will/flows")).toHaveProperty("error")
})
