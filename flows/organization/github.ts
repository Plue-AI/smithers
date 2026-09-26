/**
 * The host's GitHub access: the REST client the organization's issue intake,
 * claims, and pull requests go through, and the `git push` a pull request's
 * branch needs.
 *
 * The token is `SMITHERS_GITHUB_TOKEN` (or `GITHUB_TOKEN`) when set, else the
 * owner's `gh auth token`, read when the host needs it and never logged.
 * `SMITHERS_GITHUB_API_BASE_URL` points the client at another API (a fixture).
 *
 * Every write here is safe to repeat or is reconciled before it is repeated:
 * labels are added by name (a second add changes nothing), a comment or a pull
 * request is looked for by its marker or its head branch before one is
 * created, and a push never forces: an existing remote branch at the same
 * commit is kept, one at another commit is refused.
 *
 * Claims. Smithers Cloud's coding factory claims an issue in its own
 * database and shows it on GitHub only as a `smithers/issue-<n>` branch or a
 * pull request that closes the issue; people claim issues by assigning
 * them. The organization claims an issue with the label `org:<role>` and one
 * comment carrying {@link claimMarker}, and it never takes an issue that has
 * an assignee, an `org:` label, a factory branch, or an open pull request
 * that closes it.
 */
import { Effect, Schema } from "effect"
import { spawnSync } from "node:child_process"
import { IntegrationError } from "../../packages/smithers/agent/integrations/src/core/IntegrationError.ts"
import * as GitHubClient from "../../packages/smithers/agent/integrations/src/github/GitHubClient.ts"
import { fullNamePath } from "../../packages/smithers/agent/integrations/src/github/Repository.ts"

/** The label prefix of an organization claim: `org:<role>`. */
export const claimLabelPrefix = "org:"

/** The label claiming an issue for `role`. */
export const claimLabel = (role: string) => `${claimLabelPrefix}${role}`.slice(0, 50)

/** The marker of the organization's claim comment on an issue. */
export const claimMarker = (key: string) => `<!-- smithers-org:claim ${key} -->`

/** The marker of the comment linking an issue to its pull request. */
export const pullMarker = (key: string) => `<!-- smithers-org:pr ${key} -->`

/** The branch Smithers Cloud's coding factory works an issue on. */
export const factoryBranch = (issue: number) => `smithers/issue-${issue}`

const tokenCacheMs = 5 * 60_000
let cached: { readonly token: string | undefined; readonly at: number } | undefined

/** The owner's `gh` login token, or `undefined` without one. Never logged. */
export const ghToken = (): string | undefined => {
  if (cached !== undefined && Date.now() - cached.at < tokenCacheMs) return cached.token
  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"]
  })
  const token = result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined
  cached = { token, at: Date.now() }
  return token
}

/** The token the host calls GitHub with: the environment's, else the `gh` login's. */
export const tokenOf = (environment: Readonly<Record<string, string | undefined>>): string | undefined => {
  for (const name of ["SMITHERS_GITHUB_TOKEN", "GITHUB_TOKEN"]) {
    const value = environment[name]?.trim()
    if (value !== undefined && value !== "") return value
  }
  return environment.SMITHERS_ORG_GITHUB_GH === "off" ? undefined : ghToken()
}

/** A REST client over the host's token and API base. */
export const client = (environment: Readonly<Record<string, string | undefined>>): GitHubClient.GitHubClient =>
  GitHubClient.make({
    token: tokenOf(environment),
    apiBaseUrl: environment.SMITHERS_GITHUB_API_BASE_URL
  }, {})

const Label = Schema.Struct({ name: Schema.String })
const User = Schema.Struct({ login: Schema.String })

/** An issue as the intake and the claim read it. */
export const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  html_url: Schema.String,
  updated_at: Schema.String,
  labels: Schema.Array(Schema.Union([Label, Schema.String])),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(User))),
  pull_request: Schema.optional(Schema.Unknown)
})
export type Issue = typeof Issue.Type

/** The label names on an issue. */
export const labelsOf = (issue: Pick<Issue, "labels">): ReadonlyArray<string> =>
  issue.labels.map((label) => typeof label === "string" ? label : label.name)

const Comment = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String
})
const Pull = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  state: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  head: Schema.Struct({ ref: Schema.String })
})
export type Pull = typeof Pull.Type

const RepositoryInfo = Schema.Struct({
  id: Schema.Number,
  private: Schema.Boolean,
  default_branch: Schema.String,
  permissions: Schema.optional(Schema.Struct({ push: Schema.Boolean }))
})

const statusOf = (error: IntegrationError): unknown => error.details?.["status"]

const decoded = <A>(schema: Schema.Schema<A>) => (items: ReadonlyArray<unknown>) =>
  Effect.forEach(items, (item) =>
    Schema.decodeUnknownEffect(schema)(item).pipe(
      Effect.mapError((cause) =>
        new IntegrationError("decode-failed", "GitHub returned an item this host cannot read.", {}, { cause })
      )
    ))

/** The repository's id, visibility, default branch, and whether the token may push. */
export const repository = (github: GitHubClient.GitHubClient, full: string) =>
  github.request("GET", `/repos/${fullNamePath(full)}`, undefined, { schema: RepositoryInfo })

/** One issue, as GitHub has it now. */
export const issue = (github: GitHubClient.GitHubClient, full: string, number: number) =>
  github.request("GET", `/repos/${fullNamePath(full)}/issues/${number}`, undefined, { schema: Issue })

/** The open pull requests (the first hundred), for claims a pull request shows. */
export const openPulls = (github: GitHubClient.GitHubClient, full: string) =>
  github.paginate(`/repos/${fullNamePath(full)}/pulls?state=open`, { perPage: 100, maxPages: 1 }).pipe(
    Effect.flatMap((page) => decoded(Pull)(page.items))
  )

/** Whether a branch exists on GitHub. */
export const branchExists = (github: GitHubClient.GitHubClient, full: string, branch: string) =>
  github.request("GET", `/repos/${fullNamePath(full)}/branches/${encodeURIComponent(branch)}`).pipe(
    Effect.as(true),
    Effect.catchIf((error) => statusOf(error) === 404, () => Effect.succeed(false))
  )

const closing = (number: number) => new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${number}\\b`, "i")

/**
 * Who else holds `issue`, or `undefined` when nobody does: an assignee, an
 * organization label, a factory branch, or an open pull request that closes
 * it. `ours` is the claim label this delivery holds, which is not a claim
 * against it.
 */
export const heldBy = (
  found: Issue,
  pulls: ReadonlyArray<Pull>,
  factory: boolean,
  ours?: string
): string | undefined => {
  if (found.state !== "open") return "the issue is closed"
  if (found.pull_request !== undefined) return "it is a pull request"
  const assignees = found.assignees ?? []
  if (assignees.length > 0) return `assigned to ${assignees.map((user) => user.login).join(", ")}`
  const label = labelsOf(found).find((name) => name.startsWith(claimLabelPrefix) && name !== ours)
  if (label !== undefined) return `claimed by ${label}`
  if (factory) return `the coding factory works it on ${factoryBranch(found.number)}`
  const pull = pulls.find((candidate) =>
    candidate.head.ref === factoryBranch(found.number) || closing(found.number).test(candidate.body ?? "")
  )
  return pull === undefined ? undefined : `pull request #${pull.number} closes it`
}

/** Adds labels by name; GitHub creates a missing label. Repeating it changes nothing. */
export const addLabels = (
  github: GitHubClient.GitHubClient,
  full: string,
  number: number,
  labels: ReadonlyArray<string>
) =>
  github.request("POST", `/repos/${fullNamePath(full)}/issues/${number}/labels`, { labels }, {
    retryUnsafeWrites: true
  }).pipe(
    Effect.asVoid
  )

/** Removes a label; one already gone is not an error. */
export const removeLabel = (github: GitHubClient.GitHubClient, full: string, number: number, label: string) =>
  github.request(
    "DELETE",
    `/repos/${fullNamePath(full)}/issues/${number}/labels/${encodeURIComponent(label)}`,
    undefined,
    {
      retryUnsafeWrites: true
    }
  ).pipe(
    Effect.asVoid,
    Effect.catchIf((error) => statusOf(error) === 404, () => Effect.void)
  )

/** The issue's comments (the first thousand). */
export const comments = (github: GitHubClient.GitHubClient, full: string, number: number) =>
  github.paginate(`/repos/${fullNamePath(full)}/issues/${number}/comments`, { perPage: 100, maxPages: 10 }).pipe(
    Effect.flatMap((page) => decoded(Comment)(page.items))
  )

/**
 * The comment carrying `marker`, posted once: an existing one is reused (and
 * its body updated when it differs), so a repeat after an unknown outcome
 * finds the first one instead of posting a second.
 */
export const commentOnce = (
  github: GitHubClient.GitHubClient,
  full: string,
  number: number,
  marker: string,
  body: string
) =>
  Effect.gen(function*() {
    const text = `${body}\n\n${marker}`
    const existing = (yield* comments(github, full, number)).find((comment) => (comment.body ?? "").includes(marker))
    if (existing !== undefined) {
      if (existing.body !== text) {
        yield* github.request("PATCH", `/repos/${fullNamePath(full)}/issues/comments/${existing.id}`, { body: text }, {
          retryUnsafeWrites: true
        })
      }
      return { id: existing.id, url: existing.html_url, created: false }
    }
    const created = yield* github.request("POST", `/repos/${fullNamePath(full)}/issues/${number}/comments`, {
      body: text
    }, {
      schema: Comment
    })
    return { id: created.id, url: created.html_url, created: true }
  })

/**
 * The pull request from `head` into `base`, opened once: an existing one for
 * the head branch (open or closed) is reused, and a create whose outcome is
 * unknown is looked for again before it is repeated.
 */
export const pullOnce = (
  github: GitHubClient.GitHubClient,
  full: string,
  request: { readonly head: string; readonly base: string; readonly title: string; readonly body: string }
) =>
  Effect.gen(function*() {
    const owner = full.split("/")[0]!
    const find = github.paginate(
      `/repos/${fullNamePath(full)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${request.head}`)}`,
      { perPage: 30, maxPages: 1 }
    ).pipe(
      Effect.flatMap((page) => decoded(Pull)(page.items)),
      Effect.map((pulls) => pulls.find((pull) => pull.head.ref === request.head))
    )
    const existing = yield* find
    if (existing !== undefined) return { number: existing.number, url: existing.html_url, created: false }
    const opened = yield* github.request("POST", `/repos/${fullNamePath(full)}/pulls`, {
      title: request.title,
      head: request.head,
      base: request.base,
      body: request.body,
      draft: false
    }, { schema: Pull }).pipe(
      Effect.map((pull) => ({ number: pull.number, url: pull.html_url, created: true })),
      // An unknown outcome may have opened it: look before failing, so the next attempt reuses it.
      Effect.catchIf(
        (error) => error.details?.["outcomeUnknown"] === true || statusOf(error) === 422,
        (error) =>
          Effect.flatMap(find, (again) =>
            again === undefined
              ? Effect.fail(error)
              : Effect.succeed({ number: again.number, url: again.html_url, created: false }))
      )
    )
    return opened
  })

/** A git command's environment: the host's, without anything that redirects git or asks a person. */
const gitEnvironment = () => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|COMMON_DIR)$/.test(name)
    ) continue
    env[name] = value
  }
  env.GIT_TERMINAL_PROMPT = "0"
  return env
}

const git = (repo: string, args: ReadonlyArray<string>, timeoutMs = 120_000) => {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"]
  })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    message: (result.stderr || result.error?.message || `git exited ${result.status}`).trim().split("\n").slice(-3)
      .join(" ")
  }
}

/** The commit a remote holds for `branch`, `null` when it has none, or why the remote could not be read. */
export const remoteHead = (
  repo: string,
  remote: string,
  branch: string
): { readonly commit: string | null } | { readonly error: string } => {
  const listed = git(repo, ["ls-remote", "--heads", remote, `refs/heads/${branch}`])
  if (!listed.ok) return { error: `git ls-remote ${remote}: ${listed.message}` }
  const line = listed.stdout.split("\n").find((entry) => entry.endsWith(`\trefs/heads/${branch}`))
  return { commit: line === undefined ? null : line.split("\t")[0]! }
}

/**
 * Pushes `branch` at `commit` to `remote`, never forcing. A remote branch at
 * that commit already is kept; one at another commit is refused. What the
 * remote holds is read first, so a push whose outcome was lost is not
 * repeated blindly.
 */
export const push = (
  repo: string,
  remote: string,
  branch: string,
  commit: string
): { readonly pushed: boolean } | { readonly error: string } => {
  const before = remoteHead(repo, remote, branch)
  if ("error" in before) return before
  if (before.commit === commit) return { pushed: false }
  if (before.commit !== null) {
    return {
      error: `${remote} already has ${branch} at ${before.commit.slice(0, 12)}, not ${
        commit.slice(0, 12)
      }; it is never force-pushed`
    }
  }
  const pushed = git(repo, ["push", "--porcelain", remote, `${commit}:refs/heads/${branch}`])
  if (pushed.ok) return { pushed: true }
  const after = remoteHead(repo, remote, branch)
  if (!("error" in after) && after.commit === commit) return { pushed: true }
  return { error: `git push ${remote} ${branch}: ${pushed.message}` }
}

/** Whether the remote accepts a push, without changing it: a dry run of a new branch. */
export const canPush = (repo: string, remote: string): { readonly ok: true } | { readonly error: string } => {
  const probe = git(
    repo,
    ["push", "--dry-run", "--porcelain", remote, "HEAD:refs/heads/organization/doctor-probe"],
    60_000
  )
  return probe.ok ? { ok: true } : { error: probe.message }
}
