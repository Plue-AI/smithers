/**
 * GitHub through the machine's GitHub proxy (`scripts/github-proxy.mjs`).
 *
 * Every GitHub call the sweep makes, listing issues and reading claim
 * comments as much as claiming and releasing, spends the one budget per
 * principal the proxy enforces, so 32 agents and the flow host never trip
 * GitHub's limits on one another. `gh api` given an absolute proxy URL sends
 * no token: the proxy injects the operator's.
 */
import { Effect, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { HostFailed, output } from "./host.ts"

// The copy beside this flow, like the claim tool.
export const proxyTool = fileURLToPath(new URL("../../scripts/github-proxy.mjs", import.meta.url))

const Ensured = Schema.fromJsonString(Schema.Struct({ proxy: Schema.String }))

/** The proxy's base URL, starting the proxy first when it is not running. */
export const proxy = output("node", [proxyTool, "--ensure"]).pipe(
  Effect.flatMap(Schema.decodeEffect(Ensured)),
  Effect.map((ensured) => ensured.proxy),
  Effect.mapError((cause) => cause instanceof HostFailed ? cause : new HostFailed({ message: String(cause) }))
)

/** `gh api` for a REST `path` such as `repos/o/r/issues`, through the proxy. */
export const api = (path: string, flags: ReadonlyArray<string> = []) =>
  Effect.flatMap(proxy, (base) => output("gh", ["api", ...flags, `${base}/${path}`]))

// One page of `GET /repos/{owner}/{repo}/issues`; pull requests carry `pull_request`.
const IssuePages = Schema.fromJsonString(Schema.Array(Schema.Array(Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  pull_request: Schema.optional(Schema.Unknown)
}))))

/** Every open issue of `repo`, without pull requests. */
export const openIssues = (repo: string) =>
  api(`repos/${repo}/issues?state=open&per_page=100`, ["--paginate", "--slurp"]).pipe(
    Effect.flatMap(Schema.decodeEffect(IssuePages)),
    Effect.map((pages) =>
      pages.flat().filter((issue) => issue.pull_request === undefined).map((issue) => ({
        number: issue.number,
        title: issue.title,
        labels: issue.labels.map((label) => label.name)
      }))
    )
  )

const Issue = Schema.fromJsonString(Schema.Struct({
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.String
}))
const CommentPages = Schema.fromJsonString(Schema.Array(Schema.Array(Schema.Struct({
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  body: Schema.String
}))))

/** One issue's title, body, state, and comments, oldest first. */
export const issue = (repo: string, number: number) =>
  Effect.all([
    Effect.flatMap(api(`repos/${repo}/issues/${number}`), Schema.decodeEffect(Issue)),
    Effect.flatMap(
      api(`repos/${repo}/issues/${number}/comments?per_page=100`, ["--paginate", "--slurp"]),
      Schema.decodeEffect(CommentPages)
    )
  ]).pipe(Effect.map(([found, pages]) => ({
    title: found.title,
    body: found.body ?? "",
    state: found.state,
    comments: pages.flat().map((comment) => ({ author: { login: comment.user?.login ?? "ghost" }, body: comment.body }))
  })))
