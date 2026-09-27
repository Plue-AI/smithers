import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { readAuthenticatedSession } from "./auth-permissions/profile"
import { withOwnedImportedRepository } from "./issues/cloud"
import {
  attachProductionJson,
  repositoryApiPath
} from "./repositories-github/production"
import { createRepositoryThroughUi } from "./portable/owned-repository"
import { expect, realApi, reloadApp } from "./support/test"
import { scenarioOutcome, TEARDOWN_ANNOTATION, TeardownProblem } from "./support/teardown"

authenticatedTest.setTimeout(12 * 60_000)
authenticatedTest.use({ actionTimeout: 30_000 })

const productRepositoryName = (): string =>
  `smithers-e2e-product-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`

const repositoryText = (value: { readonly encoding?: unknown; readonly content?: unknown }): string => {
  if (typeof value.content !== "string") throw new Error("Repository content did not contain a string payload.")
  if (value.encoding === "utf-8") return value.content
  if (value.encoding === "base64") return Buffer.from(value.content, "base64").toString("utf8")
  throw new Error(`Repository content used an unsupported encoding: ${String(value.encoding)}`)
}

authenticatedTest(
  "an authenticated owner creates, reads, and removes a real product repository",
  scenario("repositories.product-create-readback", {
    capabilities: ["identity"],
    description: "Create an initialized private repository through repo.create, read its stored metadata and README, reload its creation card, then delete only that uniquely owned repository and prove it is gone.",
    coverage: [
      "action:repo.create", "host:local", "host:production", "host:native", "path:success", "path:persistence", "door:slash", "dimension:reload",
      "surface:repository-api", "dimension:repository-create", "dimension:initialized-repository",
      "dimension:owned-cleanup", "evidence:create-read-delete-readback"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const session = await readAuthenticatedSession(page)
    expect(session, "repository creation requires the fixture's verified owner session").toBeDefined()
    const name = productRepositoryName()
    expect(name).toMatch(/^smithers-e2e-product-[a-z0-9-]+$/)
    const repo = `${session!.login}/${name}`
    const path = repositoryApiPath(repo)
    let submitted = false
    let bodyError: unknown
    const teardownFailures: unknown[] = []

    try {
      submitted = true
      const createdResponse = await createRepositoryThroughUi(page, name)
      const created = await createdResponse.json().catch(() => undefined) as Record<string, unknown> | undefined
      expect(createdResponse.status(), `create ${repo}: ${JSON.stringify(created)}`).toBe(201)
      expect(created).toMatchObject({ name, full_name: repo, private: true, default_bookmark: "main" })

      const readResponse = await realApi(page, request, "GET", path)
      expect(readResponse.status()).toBe(200)
      const read = await readResponse.json() as Record<string, unknown>
      expect(read).toMatchObject({ name, full_name: repo, private: true, default_bookmark: "main" })

      const readmeResponse = await realApi(page, request, "GET", `${path}/contents/README.md?ref=main`)
      expect(readmeResponse.status()).toBe(200)
      const readme = await readmeResponse.json() as { readonly encoding?: unknown; readonly content?: unknown }
      expect(repositoryText(readme)).toContain(name)

      await reloadApp(page)
      await expect(page.getByTestId("repository-choice").getByText(`Created ${repo}`, { exact: true })).toBeVisible()

      await attachProductionJson(testInfo, "product-repository-create-readback", {
        repo,
        createStatus: createdResponse.status(),
        readStatus: readResponse.status(),
        readmeStatus: readmeResponse.status(),
        metadata: {
          fullName: read.full_name,
          private: read.private,
          defaultBookmark: read.default_bookmark
        }
      })
    } catch (error) {
      bodyError = error
    } finally {
      if (submitted) {
        try {
          const existing = await realApi(page, request, "GET", path)
          if (existing.status() === 200) {
            const deleted = await realApi(page, request, "DELETE", path)
            expect(deleted.status(), `delete ${repo}`).toBe(204)
          } else {
            expect(existing.status(), `probe possibly-created ${repo}`).toBe(404)
          }
          const missing = await realApi(page, request, "GET", path)
          expect(missing.status(), `verify deletion of ${repo}`).toBe(404)
          await attachProductionJson(testInfo, "product-repository-cleanup", { repo, finalStatus: missing.status() })
        } catch (error) {
          teardownFailures.push(new TeardownProblem(`Product repository cleanup for ${repo} failed.`, { cause: error }))
        }
      }
    }

    const outcome = scenarioOutcome({ repository: repo, bodyError, teardownFailures })
    for (const sentence of outcome.teardown) testInfo.annotations.push({ type: TEARDOWN_ANNOTATION, description: sentence })
    if (outcome.verdict !== undefined) throw outcome.verdict
  }
)

authenticatedTest(
  "a GitHub source imports through the product and reads back from the direct repository facade",
  scenario("repositories.github-import-direct-readback", {
    capabilities: ["identity", "github"],
    description: "Create one owned GitHub source, import it through repos.import, wait for the exact accepted job, then read its metadata, main bookmark, and README through the canonical repository API.",
    coverage: [
      "action:repos.import", "host:production", "path:success", "path:persistence", "door:slash",
      "surface:repository-api", "dimension:github-import", "dimension:exact-job-id",
      "dimension:direct-repository-readback", "dimension:owned-cleanup",
      "evidence:import-job-and-direct-readback"
    ]
  }),
  async ({ page, request, context }, testInfo) => {
    await withOwnedImportedRepository({ page, request, context }, testInfo, async ({ repo }) => {
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
    })
  }
)
