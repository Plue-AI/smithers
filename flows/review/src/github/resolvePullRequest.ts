import { runGh as defaultRunGh } from "./runGh.ts"

export type PullRequestTarget = {
  owner: string
  repo: string
  number: number
  url: string
  baseRefName: string
  baseSha: string
  headRefName: string
  headSha: string
  title: string
  body: string
}

/** Resolve a PR (number or URL) to its coordinates via the gh CLI. */
export async function resolvePullRequest(
  repoDir: string,
  prRef: string,
  runGh: typeof defaultRunGh = defaultRunGh
): Promise<PullRequestTarget> {
  const raw = await runGh(repoDir, [
    "pr",
    "view",
    prRef,
    "--json",
    "number,url,baseRefName,headRefName,headRefOid,title,body"
  ])
  const data = JSON.parse(raw) as {
    number: number
    url: string
    baseRefName: string
    headRefName: string
    headRefOid: string
    title?: string
    body?: string
  }
  // Match on the URL path, not a hardcoded github.com host, so GitHub
  // Enterprise PR URLs resolve too.
  let path = ""
  try {
    path = new URL(data.url).pathname
  } catch {
    // Unparseable URL: fall through to the error below.
  }
  const match = /\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(path)
  if (!match) throw new Error(`cannot parse owner/repo from PR url: ${data.url}`)
  // baseRefOid on the PR can retain an older base even while the branch moves.
  // Resolve the live base branch once, then pin the comparison to its commit.
  const baseSha = (await runGh(repoDir, [
    "api",
    `repos/${match[1]!}/${match[2]!}/git/ref/heads/${encodeURIComponent(data.baseRefName)}`,
    "--jq",
    ".object.sha",
    "--hostname",
    new URL(data.url).hostname
  ])).trim()
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: data.number,
    url: data.url,
    baseRefName: data.baseRefName,
    baseSha,
    headRefName: data.headRefName,
    headSha: data.headRefOid,
    title: data.title ?? "",
    body: data.body ?? ""
  }
}
