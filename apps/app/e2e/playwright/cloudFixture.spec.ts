import { expect, test, type Page } from "./browserTest"
import { AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import { CloudSessionSchema } from "@smthrs/rpc/CloudTunnel"
import { arrayOf, bookmarkPage, parseOrg, parseBookmark, parseRepo, parseWorkspace } from "../../src/mainview/state/seams/RepositoriesSeam"
import { installCloudFixture } from "./cloudFixture.ts"

const read = (page: Page, path: string) => page.evaluate(async (path) => {
  const response = await fetch(path)
  return { status: response.status, body: await response.json() }
}, path)

// Exercise Playwright's actual URL matching without booting application state.
test.beforeEach(async ({ page }) => {
  await page.route("**/fixture", (route) => route.fulfill({ contentType: "text/html", body: "<title>Fixture contract</title>" }))
  await page.goto("/fixture")
})

test("cloud fixture uses the shared local contracts and current cloud list envelopes", async ({ page }) => {
  await installCloudFixture(page)
  expect(AppBootstrapSchema.safeParse((await read(page, "/api/bootstrap")).body).success).toBe(true)
  expect(CloudSessionSchema.parse((await read(page, "/api/cloud-auth/session")).body).state).toBe("signed-in")
  expect((await read(page, "/api/user")).body).toMatchObject({ username: "codeplanesmithers", is_admin: false })
  for (const query of ["", "?limit=100&cursor=next"]) {
    expect(arrayOf((await read(page, `/api/user/repos${query}`)).body, "repos").map(parseRepo)).toEqual([
      expect.objectContaining({ id: "smithersai/smithers", ownerType: "org", defaultBookmark: "main" })
    ])
    expect(arrayOf((await read(page, `/api/user/orgs${query}`)).body, "orgs").map(parseOrg)).toEqual(["smithersai"])
    expect(arrayOf((await read(page, `/api/user/workspaces${query}`)).body, "workspaces").map(parseWorkspace)).toEqual([])
    const bookmarks = bookmarkPage((await read(page, `/api/repos/smithersai/smithers/bookmarks${query}`)).body)
    expect(bookmarks.next).toBeNull()
    expect(bookmarks.rows.map(parseBookmark)).toEqual([{ name: "main", changeId: "kxyzqrpv", commitId: "c0ffee123456" }])
  }
})

test("cloud fixture overrides stay isolated and match repository pathnames literally", async ({ page, context }) => {
  const workspace = {
    workspace_id: "ws-9", repository_id: 9, repository_owner: "visitor", repository_name: "demo.v2",
    workspace_title: "review", state: "running", last_accessed_at: null,
    last_activity_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", sort_timestamp: "2026-09-01T00:00:00Z"
  }
  await installCloudFixture(page, {
    capabilities: ["cloud"], degraded: true, orgs: [], workspaces: [workspace],
    repos: [{ owner: "visitor", name: "demo.v2", full_name: "visitor/demo.v2", default_bookmark: "review", owner_type: "User" }],
    bookmarks: { "visitor/demo.v2": [{ name: "review", target_change_id: "change-9", target_commit_id: "commit-9", is_tracking_remote: true }] }
  })
  expect((await read(page, "/api/bootstrap")).body.capabilities).toEqual(["cloud"])
  expect((await read(page, "/api/cloud-auth/session")).body.scopes).toBe("degraded")
  expect(arrayOf((await read(page, "/api/user/orgs")).body, "orgs").map(parseOrg)).toEqual([])
  expect(arrayOf((await read(page, "/api/user/workspaces?limit=100")).body, "workspaces").map(parseWorkspace)).toEqual([{ id: "ws-9", repoId: "visitor/demo.v2", label: "review", state: "running" }])
  const path = "/api/repos/visitor/demo.v2/bookmarks"
  expect(bookmarkPage((await read(page, `${path}?limit=1`)).body).rows.map(parseBookmark)).toEqual([
    { name: "review", changeId: "change-9", commitId: "commit-9" }
  ])
  expect((await read(page, path.replace("demo.v2", "demoXv2"))).status).toBe(404)
  await page.route((url) => url.pathname === path, (route) => route.fulfill({ json: { items: [], next_cursor: "" } }))
  expect(bookmarkPage((await read(page, path)).body)).toEqual({ rows: [], next: null })

  const other = await context.newPage()
  await installCloudFixture(other)
  await other.route("**/fixture", (route) => route.fulfill({ contentType: "text/html", body: "<title>Other fixture</title>" }))
  await other.goto("/fixture")
  expect((await read(other, "/api/cloud-auth/session")).body.scopes).toBeUndefined()
  expect(arrayOf((await read(other, "/api/user/workspaces")).body, "workspaces").map(parseWorkspace)).toEqual([])
  expect(arrayOf((await read(other, "/api/user/repos")).body, "repos").map(parseRepo)[0]?.id).toBe("smithersai/smithers")
})

test("the controller reads the cloud fixture's identity from /api/user", async ({ page }) => {
  await installCloudFixture(page)
  const reads: string[] = []
  page.on("request", (request) => { reads.push(new URL(request.url()).pathname) })
  const user = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/user")
  await page.goto("/")
  expect(await (await user).json()).toMatchObject({ username: "codeplanesmithers", is_admin: false })
  expect(reads).not.toContain("/api/auth/session")
})
