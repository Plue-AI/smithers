/**
 * `smthrs issue views` and `smthrs issue list --view`: saved issue views the
 * repository's factory declares, read and applied through the product API.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"
import { definitions } from "../src/internal/backend/Definitions.ts"
import { resources } from "../src/internal/backend/Resources.ts"

const dirs: Array<string> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const client = async () => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-issue-views-"))
  dirs.push(home)
  return new Client({
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_TOKEN: "session-secret",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
    },
    stderr: { write: () => {}, isTTY: false, columns: 80 }
  })
}

/** Serves `pages` in order and records every requested URL. */
const serve = (pages: ReadonlyArray<{ readonly body: unknown; readonly next?: string; readonly status?: number }>) => {
  const urls: Array<string> = []
  vi.stubGlobal("fetch", async (input: string) => {
    urls.push(input)
    const page = pages[urls.length - 1]
    if (page === undefined) throw new Error(`unexpected request ${input}`)
    const url = new URL(input)
    const headers = new Headers({ "content-type": "application/json" })
    if (page.next !== undefined) {
      url.searchParams.set("cursor", page.next)
      headers.set("link", `<${url}>; rel="next"`)
    }
    return new Response(JSON.stringify(page.body), { status: page.status ?? 200, headers })
  })
  return urls
}

const options = { repo: "owner/repo", limit: 2, state: "open" }

describe("issue views", () => {
  it("declares the views command and the list's view option", () => {
    expect(definitions["issue views"].options.parse({ repo: "a/b" })).toEqual({ repo: "a/b" })
    expect(definitions["issue list"].options.parse({ view: "bugs" })).toMatchObject({ view: "bugs", state: "open" })
    expect(definitions["issue list"].options.parse({})).not.toHaveProperty("view")
  })

  it("lists the declared views of the repository", async () => {
    const urls = serve([{ body: [{ id: "bugs", title: "Open bugs", state: "open", labels: ["bug"] }] }])
    expect(await resources["issue views"]!(await client(), {}, { repo: "owner/repo" })).toEqual([
      { id: "bugs", title: "Open bugs", state: "open", labels: ["bug"] }
    ])
    expect(urls).toEqual(["https://api.example.test/api/repos/owner/repo/issue-views"])
  })

  it("applies a view instead of the state and keeps it through every page", async () => {
    const urls = serve([
      { body: [{ number: 9 }, { number: 8 }], next: "c1" },
      { body: [{ number: 5 }] }
    ])
    const rows = await resources["issue list"]!(await client(), {}, { ...options, view: "bugs", all: true })
    expect(rows).toEqual([{ number: 9 }, { number: 8 }, { number: 5 }])
    expect(urls.map((url) => new URL(url).search)).toEqual([
      "?limit=2&view=bugs",
      "?limit=2&view=bugs&cursor=c1"
    ])
  })

  it("returns one page with its cursor without --all", async () => {
    serve([{ body: [{ number: 9 }, { number: 8 }], next: "c1" }])
    expect(await resources["issue list"]!(await client(), {}, { ...options, view: "bugs" })).toEqual({
      issues: [{ number: 9 }, { number: 8 }],
      next_cursor: "c1"
    })
  })

  it("keeps the state filter without a view", async () => {
    const urls = serve([{ body: [] }])
    await resources["issue list"]!(await client(), {}, options)
    expect(new URL(urls[0]!).search).toBe("?limit=2&state=open")
  })

  it("surfaces an undeclared view as the API's refusal", async () => {
    serve([{ body: { message: "issue view \"gone\" not found" }, status: 404 }])
    await expect(resources["issue list"]!(await client(), {}, { ...options, view: "gone" })).rejects.toThrow(
      /not found/
    )
  })
})
