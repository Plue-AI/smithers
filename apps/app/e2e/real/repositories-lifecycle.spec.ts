import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { withOwnedImportedRepository } from "./issues/cloud"
import { withRetainedGitHubImport } from "./repositories-github/reusable-import"
import { isPlueImportMode } from "./repositories-github/reusable-source"
import {
  attachProductionJson,
  repositoryApiPath
} from "./repositories-github/production"
import { expect, realApi } from "./support/test"

authenticatedTest.setTimeout(12 * 60_000)
authenticatedTest.use({ actionTimeout: 30_000 })

const repositoryText = (value: { readonly encoding?: unknown; readonly content?: unknown }): string => {
  if (typeof value.content !== "string") throw new Error("Repository content did not contain a string payload.")
  if (value.encoding === "utf-8") return value.content
  if (value.encoding === "base64") return Buffer.from(value.content, "base64").toString("utf8")
  throw new Error(`Repository content used an unsupported encoding: ${String(value.encoding)}`)
}

authenticatedTest(
  "a GitHub source imports through the product and reads back from the direct repository facade",
  scenario("repositories.github-import-direct-readback", {
    capabilities: ["identity", "github"],
    description: "Import the registered retained GitHub source in Plue modes (an owned disposable source elsewhere), wait for the exact accepted job, then read its metadata, main bookmark, and README through the canonical repository API.",
    coverage: [
      "action:repos.import", "host:production", "path:success", "path:persistence", "door:slash",
      "surface:repository-api", "dimension:github-import", "dimension:exact-job-id",
      "dimension:direct-repository-readback", "dimension:owned-cleanup",
      "evidence:import-job-and-direct-readback"
    ]
  }),
  async ({ page, request, context }, testInfo) => {
    const readback = async (repo: string): Promise<void> => {
      const metadataResponse = await realApi(page, request, "GET", repositoryApiPath(repo))
      expect(metadataResponse.status()).toBe(200)
      const metadata = await metadataResponse.json() as Record<string, unknown>
      expect(metadata).toMatchObject({ full_name: repo, private: true, default_bookmark: "main" })

      const bookmarksResponse = await realApi(page, request, "GET", repositoryApiPath(repo, "/bookmarks"))
      expect(bookmarksResponse.status()).toBe(200)
      const bookmarks = await bookmarksResponse.json() as { readonly items?: ReadonlyArray<{ readonly name?: unknown }> }
      expect(bookmarks.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "main" })]))

      const readmeResponse = await realApi(page, request, "GET", repositoryApiPath(repo, "/contents/README.md?ref=main"))
      expect(readmeResponse.status()).toBe(200)
      const readme = await readmeResponse.json() as { readonly encoding?: unknown; readonly content?: unknown }
      expect(repositoryText(readme)).toContain(repo.split("/")[1]!)

      await attachProductionJson(testInfo, "github-import-direct-readback", {
        repo,
        metadataStatus: metadataResponse.status(),
        bookmarksStatus: bookmarksResponse.status(),
        bookmarkNames: bookmarks.items?.map(({ name }) => name),
        readmeStatus: readmeResponse.status()
      })
    }
    if (isPlueImportMode(process.env.SMITHERS_REAL_E2E_MODE)) {
      await withRetainedGitHubImport({ page, request, context }, testInfo, readback)
    } else {
      await withOwnedImportedRepository({ page, request, context }, testInfo, async ({ repo }) => readback(repo))
    }
  }
)
