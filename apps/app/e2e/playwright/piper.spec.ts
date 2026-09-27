import { fillComposer } from "./composer"
import { expect, test } from "./browserTest"
import type { Page } from "./browserTest"
import type { Repo } from "@smthrs/rpc/LocalApp"
import { installCloudFixture } from "./cloudFixture.ts"

/*
 * Lane piper T1 (docs/workbench-lanes/piper.md "Exit", ADR 0001): the app
 * opens ~/smithers with its remote parsing into the cloud inventory, and
 * /files.read README.md renders the card whose header carries the global
 * address and the position the read was taken at. (The sidebar tree that
 * once showed the nesting is removed; the one address space lives on in the
 * card headers and the composer's repository menu.)
 *
 * The server is a double: the shared cloud fixture (cloudFixture.ts) answers
 * the bootstrap, the cloud session and the Smithers Cloud inventory behind
 * /api/cloud/*, this spec adds the local checkout and the repo-files read.
 */

const SMITHERS_REPO = {
  id: "smithers",
  path: "/Users/williamcory/smithers",
  name: "smithers",
  git: { branch: "main", remote: "git@github.com:smithersai/smithers.git" },
  jj: { changeId: "kxyzqrpv", commitId: "c0ffee123456", ahead: 3, bookmark: "main" },
  warnings: [],
  smithers: {
    detected: true,
    workspaceFile: "WORKSPACE.ts",
    declarationFiles: ["WORKSPACE.ts"],
    reason: "ok",
    workspaces: [{ path: ".", title: "smithers" }]
  }
} satisfies Repo

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: ~/smithers open locally, signed in to a cloud that inventories smithersai/smithers. */
const serve = async (page: Page): Promise<void> => {
  await installCloudFixture(page, { localRepos: [SMITHERS_REPO] })
  await page.route("**/api/repo/files", (route) =>
    route.fulfill(json({ kind: "file", path: "README.md", size: 10, content: "# Smithers\n", truncated: false, binary: false })))
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("T1: ~/smithers joins the one address space; /files.read's card header shows the address and readAt", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  // /files.read renders the file card; its header carries the global address
  // and the change id the read was taken at.
  await fillComposer(page, "/files.read README.md")
  await page.getByTestId("composer-send").click()
  // The card is keyed by the local checkout's name; its header carries the global address.
  const card = page.getByTestId("card-file-smithers-README.md")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator(".world-card-path")).toContainText("/smithersai/smithers/README.md")
  await expect(card.locator(".world-card-path")).toContainText("kxyzqrpv")
  // Markdown renders through the read-only editor: the heading text, not the raw fence.
  await expect(card).toContainText("Smithers")
})
