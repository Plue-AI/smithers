import type { Page } from "@playwright/test"
import type { AppBootstrap, RuntimeCapability } from "@smthrs/rpc/AppBootstrap"
import { ReposResponseSchema, type Repo } from "@smthrs/rpc/LocalApp"
import { type CloudSession } from "@smthrs/rpc/CloudTunnel"
import { SCOPED_TEST_USER, SCOPED_TEST_USER_CLOUD_SESSION } from "./identity.ts"

// Cloud proxy DTO fields used by these specs. The upstream contracts live in
// plue internal/services/{user,workspace}.go and internal/routes/jj_vcs.go;
// @smthrs/rpc owns the local responses, but does not export these proxy DTOs.
interface CloudRepo {
  readonly owner: string
  readonly name: string
  readonly full_name: string
  readonly default_bookmark: string
  readonly owner_type: "User" | "Organization"
  readonly default_bookmark_head?: { readonly change_id: string; readonly commit_id: string }
}

interface CloudBookmark {
  readonly name: string
  readonly target_change_id: string
  readonly target_commit_id: string
  readonly is_tracking_remote: boolean
}

interface CloudWorkspace {
  readonly workspace_id: string
  readonly repository_id: number
  readonly repository_owner: string
  readonly repository_name: string
  readonly workspace_title: string
  readonly state: string
  readonly last_accessed_at: string | null
  readonly last_activity_at: string
  readonly created_at: string
  readonly sort_timestamp: string
}

/** The one box a flow spec's repository holds: every flow call names a box. */
export const FIXTURE_BOX = "0b0c0d0e-0000-4000-8000-0000000000f1"

/** A running box of `fullName`, as the per-user switcher lists it. */
export const runningBox = (fullName: string, workspaceId: string = FIXTURE_BOX): CloudWorkspace => {
  const [owner = "", name = ""] = fullName.split("/")
  return {
    workspace_id: workspaceId, repository_id: 1, repository_owner: owner, repository_name: name, workspace_title: "Box",
    state: "running", last_accessed_at: null, last_activity_at: "2026-09-26T00:00:00Z", created_at: "2026-09-26T00:00:00Z",
    sort_timestamp: "2026-09-26T00:00:00Z"
  }
}

/** The card id a run on `workspaceId` gets (RunReference `runCardIdFor`): repository, box and run, each URI-encoded. */
export const boxRunCardId = (fullName: string, runId: string, workspaceId: string = FIXTURE_BOX): string =>
  `flow-run@${[fullName, workspaceId, runId].map(encodeURIComponent).join("@")}`

interface CloudFixtureOptions {
  readonly capabilities?: ReadonlyArray<RuntimeCapability>
  readonly localRepos?: ReadonlyArray<Repo>
  readonly repos?: ReadonlyArray<CloudRepo>
  readonly orgs?: ReadonlyArray<{ readonly name: string }>
  readonly bookmarks?: Readonly<Record<string, ReadonlyArray<CloudBookmark>>>
  readonly workspaces?: ReadonlyArray<CloudWorkspace>
  readonly degraded?: boolean
}

/** Install common routes first; later page.route registrations override scenario responses. */
export const installCloudFixture = async (page: Page, options: CloudFixtureOptions = {}): Promise<void> => {
  const capabilities = [...options.capabilities ?? ["agent", "identity", "cloud"]]
  const bootstrap = {
    apiVersion: 1,
    host: "local",
    version: "test",
    buildSha: "test",
    capabilities,
    authFlow: capabilities.includes("identity") ? "credentials" : "none",
    sandbox: { platform: "darwin", mode: "trusted-only" }
  } satisfies AppBootstrap
  const session = {
    ...SCOPED_TEST_USER_CLOUD_SESSION,
    ...(options.degraded === true ? { scopes: "degraded" as const } : {})
  } satisfies CloudSession
  const localRepos = ReposResponseSchema.parse({ repos: options.localRepos ?? [] })
  const repos = options.repos ?? [{
    owner: "smithersai", name: "smithers", full_name: "smithersai/smithers",
    default_bookmark: "main", owner_type: "Organization"
  }] satisfies ReadonlyArray<CloudRepo>
  const bookmarks = [{
    name: "main", target_change_id: "kxyzqrpv", target_commit_id: "c0ffee123456", is_tracking_remote: false
  }] satisfies ReadonlyArray<CloudBookmark>

  // Match exact pathnames so queries work and repository names are never regex patterns.
  const respond = (pathname: string, json: unknown) =>
    page.route((url) => url.pathname === pathname, (route) => route.fulfill({ json }))
  await page.route("**/api/**", (route) => route.fulfill({
    status: 404, json: { error: { code: "absent", message: "no seam" } }
  }))
  await respond("/api/bootstrap", bootstrap)
  await respond("/api/repos", localRepos)
  await respond("/api/user", { id: 1, username: SCOPED_TEST_USER.login, is_admin: false,
    ...(options.degraded === true ? { token_scopes: ["read:repository"] } : {}) })
  await respond("/api/billing/balance", {
    state: "ok", allowedToStartWork: true,
    balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 }
  })
  await respond("/api/cloud-auth/session", session)
  await respond("/api/user/repos", repos)
  await respond("/api/user/orgs", options.orgs ?? [{ name: "smithersai" }])
  await respond("/api/user/workspaces", options.workspaces ?? [])
  for (const repo of repos) {
    await respond(`/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/bookmarks`, {
      items: options.bookmarks?.[repo.full_name] ?? bookmarks,
      next_cursor: ""
    } satisfies { readonly items: ReadonlyArray<CloudBookmark>; readonly next_cursor: string })
  }
}
