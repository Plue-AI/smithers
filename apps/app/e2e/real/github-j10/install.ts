import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test"
import { awaitBoot } from "../support"
import { attachJson, expect, JourneyUnavailable, required, withReference } from "../todo/reference"

/**
 * The install a C-J10 GitHub journey runs on: the reference install against
 * github.com, or the composed install the backend's TestJ10*Browser drivers
 * serve against the GitHub fake (SMITHERS_J10_COMPOSED_HOST). Either way the
 * app, its API, the stack and the packaged TODO flow are the product's. What
 * differs is how a person acts on GitHub and how GitHub is read back: the
 * fake's own person controls and its Git, or the people's tokens on the API.
 */
export type J10Actor = "Owner" | "Ben"

export type GitHubPull = {
  number: number; title: string; body: string; state: string; draft: boolean; merged: boolean; html_url: string
  head: { ref: string; sha: string }; base: { ref: string }
  user?: { login: string; type: string } | null
  merged_by?: { login: string } | null
}
export type GitHubIssue = { state: string; stateReason: string; comments: { body: string; viaApp: boolean }[] }
export type GitHubCommit = { parents: string[]; paths: string[] }

export type J10Install = {
  readonly kind: "reference" | "composed"
  readonly repo: string
  readonly origin: string
  readonly info: TestInfo
  readonly members: Record<J10Actor, { readonly page: Page; readonly context: BrowserContext; readonly login: string }>
  /** A TODO prompt: the composed install's scripted model reads its markers; the reference host's model reads prose. */
  readonly prompt: (file: string, text: string) => string
  /** One production API request from the actor's browser session. */
  readonly api: (actor: J10Actor, method: string, path: string, data?: unknown, key?: string) => Promise<{ status: number; body: any }>
  /** GET path as actor; 200 required. */
  readonly read: (actor: J10Actor, path: string) => Promise<any>
  /** One read-only query against the install's PostgreSQL. */
  readonly sql: (query: string) => any[]
  readonly github: {
    readonly pull: (number: number) => Promise<GitHubPull>
    /** Every pull request, in any state, whose head is branch. */
    readonly pulls: (branch: string) => Promise<number[]>
    readonly commit: (sha: string) => Promise<GitHubCommit>
    /** Exact file bytes at a published commit. */
    readonly file: (sha: string, path: string) => Promise<string>
    readonly main: () => Promise<string>
    /** Paths that differ between two commits. */
    readonly changed: (base: string, head: string) => Promise<string[]>
    /** Whether ancestor is head or one of its ancestors. */
    readonly contains: (ancestor: string, head: string) => Promise<boolean>
    readonly issue: (number: number) => Promise<GitHubIssue>
    readonly openIssue: (actor: J10Actor, title: string, body: string) => Promise<number>
    /** The owner squash-merges on GitHub as a person; answers the merge commit. */
    readonly merge: (number: number, sha: string) => Promise<string>
    /** The App's own merge calls for pull request number, from its outbound write log. */
    readonly appMerges: (number: number) => Promise<number>
    /** Whether the App, not a person, opened the pull request. */
    readonly appOpened: (pull: GitHubPull) => Promise<boolean>
  }
}

type ComposedHost = {
  readonly origin: string
  readonly repository: string
  readonly database: string
  readonly commit: string
  readonly github: { readonly url: string; readonly git: string }
  readonly members: Record<J10Actor, { readonly login: string; readonly cookies: ReadonlyArray<{ readonly name: string; readonly value: string }> }>
}

const git = existsSync("/usr/bin/git") ? "/usr/bin/git" : "git"
const json = (text: string): any => { try { return JSON.parse(text) } catch { return text } }

/** The request the app itself sends: session cookies, the double-submit CSRF pair and an Idempotency-Key. */
const sessionApi = (origin: string, members: Record<J10Actor, { page: Page }>) =>
  async (actor: J10Actor, method: string, path: string, data?: unknown, key?: string) => {
    const page = members[actor].page
    const mutation = !["GET", "HEAD"].includes(method.toUpperCase())
    const csrf = mutation ? (await page.context().cookies(origin)).find(cookie => cookie.name === "__csrf")?.value : undefined
    const local = await page.evaluate(() => document.querySelector('meta[name="smithers-local-session"]')?.getAttribute("content") ?? null)
    const response = await page.context().request.fetch(new URL(path, origin).toString(), {
      method, headers: {
        ...(csrf ? { Origin: origin, "X-CSRF-Token": csrf } : {}),
        ...(local ? { "x-smithers-local-session": local } : {}),
        ...(key ? { "Idempotency-Key": key } : {})
      }, ...(data === undefined ? {} : { data })
    })
    return { status: response.status(), body: json(await response.text()) }
  }

export const withJ10Install = async (browser: Browser, info: TestInfo, body: (install: J10Install) => Promise<void>): Promise<void> => {
  const composed = process.env.SMITHERS_J10_COMPOSED_HOST
  if (!composed) return withReferenceJ10(browser, info, body)
  const host = JSON.parse(readFileSync(composed, "utf8")) as ComposedHost
  if (!/^https?:\/\//.test(host.origin) || process.env.SMITHERS_REAL_BASE_URL !== host.origin) {
    throw new JourneyUnavailable("The composed install's origin must be the real-tier base URL")
  }
  await attachJson(info, "install-version-commit", { install: "composed", commit: host.commit, origin: host.origin })
  const contexts: BrowserContext[] = []
  const members = {} as J10Install["members"]
  const fake = async (method: string, path: string, data?: unknown): Promise<any> => {
    const response = await fetch(host.github.url + path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { "Content-Type": "application/json" } }) })
    const text = await response.text()
    expect(response.ok, `GitHub fake ${method} ${path}: ${response.status} ${text}`).toBe(true)
    return json(text)
  }
  const gitHub = (...args: string[]) => execFileSync(git, ["--git-dir", host.github.git, ...args], { encoding: "utf8" }).trim()
  try {
    for (const actor of ["Owner", "Ben"] as const) {
      const context = await browser.newContext({ baseURL: host.origin, recordVideo: { dir: info.outputPath(`video-${actor}`) } })
      contexts.push(context)
      await context.addCookies(host.members[actor].cookies.map(cookie => ({ ...cookie, url: host.origin, httpOnly: cookie.name !== "__csrf" })))
      const page = await context.newPage()
      await page.goto(`${host.origin}/${host.repository}`)
      await awaitBoot(page)
      members[actor] = { context, page, login: host.members[actor].login }
    }
    const api = sessionApi(host.origin, members)
    const writes = async (): Promise<{ method: string; path: string; status: number }[]> => fake("GET", "/_fake/writes")
    await body({
      kind: "composed", repo: host.repository, origin: host.origin, info, members, api,
      prompt: (file, text) => `[PR] [FILE ${file}] ${text}`,
      read: async (actor, path) => {
        const response = await api(actor, "GET", path)
        expect(response.status, `GET ${path}: ${JSON.stringify(response.body)}`).toBe(200)
        return response.body
      },
      sql: query => JSON.parse(execFileSync("psql", [host.database, "-XAt", "-v", "ON_ERROR_STOP=1", "-c",
        `BEGIN READ ONLY; SELECT coalesce(json_agg(observation), '[]'::json) FROM (${query}) observation; COMMIT;`
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").find(line => line.startsWith("[")) ?? "null"),
      github: {
        pull: async number => (await fake("GET", `/_fake/pull?repo=${encodeURIComponent(host.repository)}&number=${number}`)).pull,
        pulls: async branch => (await fake("GET", `/_fake/pulls?repo=${encodeURIComponent(host.repository)}`) as GitHubPull[])
          .filter(pull => pull.head.ref === branch).map(pull => pull.number),
        commit: async sha => ({
          parents: gitHub("rev-list", "--parents", "-n", "1", sha).split(/\s+/).slice(1),
          paths: gitHub("ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean)
        }),
        file: async (sha, path) => execFileSync(git, ["--git-dir", host.github.git, "show", `${sha}:${path}`], { encoding: "utf8" }),
        main: async () => gitHub("rev-parse", "refs/heads/main"),
        changed: async (base, head) => gitHub("diff", "--no-ext-diff", "--no-textconv", "--name-only", base, head).split("\n").filter(Boolean),
        contains: async (ancestor, head) => {
          try { gitHub("merge-base", "--is-ancestor", ancestor, head); return true } catch { return false }
        },
        issue: async number => {
          const view = await fake("GET", `/_fake/issue?repo=${encodeURIComponent(host.repository)}&number=${number}`)
          return { state: view.State, stateReason: view.StateReason, comments: (view.Comments ?? []).map((comment: any) => ({ body: comment.body, viaApp: comment.via_app })) }
        },
        openIssue: async (actor, title, text) => (await fake("POST", "/_fake/issues", { repo: host.repository, login: members[actor].login, title, body: text })).number,
        merge: async number => (await fake("POST", "/_fake/merge", { repo: host.repository, number })).sha,
        appMerges: async number => (await writes()).filter(write => write.method === "PUT" && write.path === `/repos/${host.repository}/pulls/${number}/merge`).length,
        // Only the App writes pull requests on the fake; people act through its controls.
        appOpened: async pull => (await writes()).some(write => write.method === "POST" && write.path === `/repos/${host.repository}/pulls` && write.status === 201) &&
          (await fake("GET", `/_fake/pulls?repo=${encodeURIComponent(host.repository)}`) as GitHubPull[]).some(each => each.number === pull.number)
      }
    })
  } finally {
    // The runner's trace option already records these contexts.
    for (const context of contexts) await context.close()
  }
}

/** github.com as the owner (Will) and Ben, with the install's outbound write log for the App's calls. */
const withReferenceJ10 = (browser: Browser, info: TestInfo, body: (install: J10Install) => Promise<void>): Promise<void> =>
  withReference(browser, info, async f => {
    const audit = (): { method: string; path: string; body?: any }[] => readFileSync(required("SMITHERS_JOURNEY_GITHUB_AUDIT_LOG"), "utf8")
      .split("\n").filter(Boolean).map(line => JSON.parse(line))
    audit()
    const user = async (actor: "Will" | "Ben"): Promise<string> => {
      const response = await f.members[actor].context.request.get("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${required(`SMITHERS_JOURNEY_${actor.toUpperCase()}_GITHUB_TOKEN`)}`, Accept: "application/vnd.github+json" }
      })
      expect(response.ok(), `GitHub /user as ${actor}`).toBe(true)
      return (await response.json()).login
    }
    const members: J10Install["members"] = {
      Owner: { ...f.members.Will, login: await user("Will") },
      Ben: { ...f.members.Ben, login: await user("Ben") }
    }
    const as = (actor: J10Actor) => actor === "Owner" ? "Will" : "Ben"
    const origin = new URL(f.members.Will.page.url()).origin
    const api = sessionApi(origin, members)
    await body({
      kind: "reference", repo: f.repo, origin, info, members, api,
      prompt: (_file, text) => text,
      read: async (actor, path) => f.read(as(actor), path),
      sql: f.sql,
      github: {
        pull: async number => await f.github("Will", "GET", `/pulls/${number}`) as GitHubPull,
        pulls: async branch => (await f.github("Will", "GET", `/pulls?state=all&per_page=100&head=${f.repo.split("/")[0]}:${branch}`) as GitHubPull[]).map(pull => pull.number),
        commit: async sha => {
          const commit = await f.github("Will", "GET", `/git/commits/${sha}`) as { parents: { sha: string }[]; tree: { sha: string } }
          const tree = await f.github("Will", "GET", `/git/trees/${commit.tree.sha}?recursive=1`) as { tree: { path: string; type: string }[] }
          return { parents: commit.parents.map(parent => parent.sha), paths: tree.tree.filter(entry => entry.type === "blob").map(entry => entry.path) }
        },
        file: async (sha, path) => {
          const file = await f.github("Will", "GET", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`) as { encoding: string; content: string }
          expect(file.encoding).toBe("base64")
          return Buffer.from(file.content, "base64").toString("utf8")
        },
        main: async () => (await f.github("Will", "GET", "/git/ref/heads/main") as { object: { sha: string } }).object.sha,
        changed: async (base, head) => (await f.github("Will", "GET", `/compare/${base}...${head}`) as { files: { filename: string }[] }).files.map(file => file.filename),
        contains: async (ancestor, head) => ["identical", "ahead"].includes((await f.github("Will", "GET", `/compare/${ancestor}...${head}`) as { status: string }).status),
        issue: async number => {
          const issue = await f.github("Will", "GET", `/issues/${number}`) as { state: string; state_reason: string | null }
          const comments = await f.github("Will", "GET", `/issues/${number}/comments?per_page=100`) as { body: string; performed_via_github_app: unknown }[]
          return { state: issue.state, stateReason: issue.state_reason ?? "", comments: comments.map(comment => ({ body: comment.body, viaApp: comment.performed_via_github_app != null })) }
        },
        openIssue: async (actor, title, text) => (await f.github(as(actor), "POST", "/issues", { title, body: text }) as { number: number }).number,
        merge: async (number, sha) => (await f.github("Will", "PUT", `/pulls/${number}/merge`, { merge_method: "squash", sha }) as { sha: string }).sha,
        appMerges: async number => audit().filter(record => record.method === "PUT" && record.path === `/repos/${f.repo}/pulls/${number}/merge`).length,
        appOpened: async pull => pull.user?.type === "Bot"
      }
    })
  })

/** What the C-J10 specs read of GET /api/todos/{n}. */
export type TodoCard = { n: number; state: string; pr: { number: number; head: string; draft: boolean }; merge: { state: string; reason?: string } }
export const todoCard = (f: J10Install, n: number): Promise<TodoCard> => f.read("Ben", `/api/todos/${n}`)

/**
 * Polls TODO n until it is in state and also holds. The stack's own record
 * says why it did not move: an attempt that failed, stopped, blocked or is
 * retrying stops the wait with its reason instead of running out the clock.
 */
export const waitTodo = async (f: J10Install, n: number, state: string, also: (card: TodoCard) => boolean | Promise<boolean> = () => true,
  timeout = 600_000): Promise<TodoCard> => {
  for (const deadline = Date.now() + timeout; ;) {
    const last = await todoCard(f, n)
    if (last.state === state && await also(last)) return last
    const [item] = f.sql(`SELECT state, reason FROM mythical_items WHERE number = ${n}`) as { state: string; reason: string | null }[]
    const why = `T${n} is ${last.state} (item ${item?.state}: ${JSON.stringify(item?.reason)}), expected ${state}: ${JSON.stringify(last)}`
    if (item && ["retrying", "failed", "stopped", "blocked"].includes(item.state) || ["failed", "dropped"].includes(last.state)) throw new Error(why)
    if (Date.now() > deadline) throw new Error(`timed out: ${why}`)
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
}
