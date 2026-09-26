/**
 * References in what the host posts: wiki pages, receipts, issues, pull
 * requests, commits and branches, rendered as Slack links (`<url|label>`) or,
 * for the wiki's own pages, as Obsidian wikilinks (`[[path|label]]`).
 *
 * A flow that knows what it points at passes a typed {@link Ref}; its raw
 * token in the text (a path or a page's name, `#12`, a branch) becomes the
 * link, and a reference the text does not name is appended as ` · <link>`. Free text,
 * a model's included, is linked conservatively: only a path that exists in
 * the wiki, `#n` and `owner/repo#n` of a configured repository, a GitHub
 * issue or pull request URL, and a commit or branch a configured repository
 * holds. Nothing inside a code span is linked, and every label replaces the
 * raw token rather than sitting beside it.
 *
 * A page link must not 404: before a Slack post names a page its upstream
 * does not hold as it is here, the host commits and pushes the wiki
 * (`wiki.ts`) once, when the organization page asks it to sync. A page the
 * upstream still lacks afterwards is named, unlinked; one whose push failed
 * is linked anyway. A commit or branch the remote does not hold is shown in
 * code format.
 */
import { spawnSync } from "node:child_process"
import { existsSync, realpathSync, statSync } from "node:fs"
import { basename, extname, relative, resolve, sep } from "node:path"
import { Schema } from "effect"
import * as Wiki from "./wiki.ts"

/** One reference a post makes. */
export const Ref = Schema.Union([
  /** A wiki page or receipt, relative to the organization root. */
  Schema.Struct({ kind: Schema.Literal("page"), path: Schema.NonEmptyString }),
  /** An issue (or a pull request by its number) of a GitHub repository, `owner/name`. */
  Schema.Struct({ kind: Schema.Literal("issue"), github: Schema.NonEmptyString, number: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("pull"), github: Schema.NonEmptyString, number: Schema.Int, url: Schema.NonEmptyString }),
  /** A commit of a configured repository, by its configured name. */
  Schema.Struct({ kind: Schema.Literal("commit"), repository: Schema.NonEmptyString, sha: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("branch"), repository: Schema.NonEmptyString, branch: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.NonEmptyString })
])
export type Ref = typeof Ref.Type

/** A configured repository: its checkout, its GitHub repository, and the remote pushed to. */
export interface Repository {
  readonly path: string
  readonly github?: string | undefined
  readonly remote?: string | undefined
}

/** What a linker needs from the host. */
export interface Options {
  /** The organization root: the directory holding `Org/`. */
  readonly root: string
  readonly stateDir: string
  /** Receipts live under it; one is labelled `receipt`. */
  readonly generatedDir: string
  /** The organization page's `wiki.webUrl`; derived from a GitHub upstream when absent. */
  readonly webUrl?: string | undefined
  /** The host's wiki paths, committed and pushed before a post names a page the upstream lacks; absent: never. */
  readonly publish?: ReadonlyArray<string> | undefined
  readonly repositories: Readonly<Record<string, Repository>>
  /** Bounds each git call, in milliseconds. Default 60 seconds. */
  readonly timeoutMs?: number | undefined
}

/** Renders text and references for Slack and for the wiki. */
export interface Linker {
  /** Slack mrkdwn: links, and `&`, `<`, `>` escaped everywhere else. */
  readonly slack: (text: string, refs?: ReadonlyArray<Ref>) => string
  /** Markdown for a wiki page: pages as wikilinks, everything else as it was. */
  readonly wiki: (text: string, refs?: ReadonlyArray<Ref>) => string
}

/** A linker that links nothing: the text, then each reference's raw token. */
export const none: Linker = {
  slack: (text, refs = []) => `${text}${refs.map((ref) => ` · ${rawOf(ref)}`).join("")}`,
  wiki: (text, refs = []) => `${text}${refs.map((ref) => ` · ${rawOf(ref)}`).join("")}`
}

/** A link-like reference the host was handed as a string: a URL, else a wiki path. */
export const refOf = (link: string): Ref => /^https?:\/\//.test(link) ? { kind: "url", url: link } : { kind: "page", path: link }

/** Slack's three escapes. */
export const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** `owner/name` of a GitHub remote URL, or `undefined`. */
export const githubOfRemote = (url: string): string | undefined =>
  /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/\s]+@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/")

/** The wiki's web address for a remote URL and branch: GitHub's blob view, or `undefined`. */
export const webUrlOf = (remoteUrl: string, branch: string): string | undefined => {
  const github = githubOfRemote(remoteUrl)
  return github === undefined ? undefined : `https://github.com/${github}/blob/${encodePath(branch)}`
}

const rawOf = (ref: Ref): string => {
  switch (ref.kind) {
    case "page":
      return ref.path
    case "issue":
      return `#${ref.number}`
    case "pull":
      return ref.url
    case "commit":
      return ref.sha.slice(0, 12)
    case "branch":
      return ref.branch
    case "url":
      return ref.url
  }
}

/** The label a page link shows: the page name, or `receipt` for a receipt. */
export const labelOf = (path: string, generatedDir: string): string => {
  const inside = path.startsWith(`${generatedDir.replace(/\/+$/, "")}/`)
  if (inside && extname(path) === ".json") return "receipt"
  return basename(path, ".md")
}

/** A GitHub issue or pull request URL: its repository and number. */
const githubUrl = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#][^\s<>|]*)?$/

/** Text split into prose and code (fenced blocks and inline spans), which is never linked. */
const pieces = (text: string): ReadonlyArray<{ readonly code: boolean; readonly text: string }> => {
  const out: Array<{ code: boolean; text: string }> = []
  let at = 0
  for (const match of text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)) {
    if (match.index > at) out.push({ code: false, text: text.slice(at, match.index) })
    out.push({ code: true, text: match[0] })
    at = match.index + match[0].length
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) })
  return out
}

/** Candidate tokens in prose: URLs, `owner/repo#n`, `#n`, path-like tokens, hex ids. */
const tokens =
  /https?:\/\/[^\s<>|]+|(?<![\w/.-])[\w.-]+\/[\w.-]+#\d{1,7}\b|(?<![\w#&/])#\d{1,7}\b|(?<![\w/.:@-])[\w@][\w.@-]*(?:\/[\w.@-]+)+|(?<![\w/])[0-9a-f]{7,40}(?![\w/])/g

const trailing = /[.,;:!?)\]]+$/

interface Span {
  readonly start: number
  readonly end: number
  readonly ref: Ref
  /** The text the span covers, shown as it is when the ref cannot be linked. */
  readonly raw: string
}

/** Makes a linker over the host's wiki and repositories. */
export const make = (options: Options): Linker => {
  const timeout = options.timeoutMs ?? 60_000
  // Real paths, so the root compares with the work tree git reports.
  const root = existsSync(options.root) ? realpathSync(options.root) : resolve(options.root)
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] })
  const githubs = Object.values(options.repositories).flatMap((repository) =>
    repository.github === undefined ? [] : [repository.github]
  )
  const defaultGithub = githubs.length === 1 ? githubs[0] : undefined

  // The wiki's work tree, upstream, and web address, found once.
  let wiki: { readonly top: string; readonly base: string | undefined } | undefined | null = null
  const wikiOf = () => {
    if (wiki !== null) return wiki
    const top = git(root, ["rev-parse", "--show-toplevel"])
    if (top.status !== 0) {
      wiki = undefined
      return wiki
    }
    const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).stdout.trim()
    const slash = upstream.indexOf("/")
    const remote = slash > 0 ? upstream.slice(0, slash) : "origin"
    const branch = slash > 0 ? upstream.slice(slash + 1) : "main"
    const url = git(root, ["remote", "get-url", remote]).stdout.trim()
    wiki = { top: realpathSync(top.stdout.trim()), base: options.webUrl ?? webUrlOf(url, branch) }
    return wiki
  }

  /** A wiki page's path relative to the root, when `token` names one that exists: as written, or with `.md`. */
  const pageOf = (token: string): string | undefined => {
    if (token.split("/").some((segment) => segment === "" || segment.startsWith(".")) || token.includes("\\")) return undefined
    for (const candidate of [token, `${token}.md`]) {
      const target = resolve(root, candidate)
      if (!target.startsWith(root + sep)) continue
      try {
        if (statSync(target).isFile()) return relative(root, target).split(sep).join("/")
      } catch {
        continue
      }
    }
    return undefined
  }

  const inUpstream = (top: string, path: string) =>
    git(root, ["cat-file", "-e", `@{u}:${relative(top, resolve(root, path)).split(sep).join("/")}`]).status === 0
  const current = (path: string) =>
    git(root, ["status", "--porcelain", "--", path]).stdout.trim() === "" &&
    git(root, ["diff", "--quiet", "@{u}", "HEAD", "--", path]).status === 0

  /**
   * The web address of each page, after one commit and push when the upstream
   * lacks any as it is here and the host syncs; a page left out is not linked.
   */
  const publish = (named: ReadonlyArray<string>): ReadonlyMap<string, string> => {
    const paths = named.filter((path) => pageOf(path) === path)
    const found = wikiOf()
    const links = new Map<string, string>()
    if (found === undefined || found.base === undefined || paths.length === 0) return links
    const { base, top } = found
    const url = (path: string) => `${base}/${encodePath(relative(top, resolve(root, path)).split(sep).join("/"))}`
    const stale = paths.filter((path) => !(inUpstream(top, path) && current(path)))
    let failed = false
    if (stale.length > 0 && options.publish !== undefined) {
      try {
        Wiki.commit(root, options.publish)
      } catch {
        failed = true
      }
      const synced = Wiki.sync(root, options.stateDir, Date.now(), timeout)
      failed = failed || synced.status === "failed" || synced.status === "conflict"
    }
    for (const path of paths) if (failed || inUpstream(top, path)) links.set(path, url(path))
    return links
  }

  const commitOf = (repository: Repository | undefined, sha: string) => {
    if (repository?.github === undefined || !existsSync(repository.path)) return undefined
    const full = git(repository.path, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`])
    if (full.status !== 0) return undefined
    const pushed = git(repository.path, ["branch", "-r", "--contains", full.stdout.trim()]).stdout.trim() !== ""
    return { github: repository.github, full: full.stdout.trim(), pushed }
  }

  const branchOf = (repository: Repository | undefined, branch: string) => {
    if (repository === undefined || !existsSync(repository.path)) return undefined
    if (git(repository.path, ["check-ref-format", "--branch", branch]).status !== 0) return undefined
    if (git(repository.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status !== 0) return undefined
    const pushed = git(repository.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/${repository.remote ?? "origin"}/${branch}`]).status === 0
    return { pushed }
  }

  const issueLabel = (github: string, number: number) => github === defaultGithub ? `#${number}` : `${github}#${number}`

  /** The ref a free-text token names, when it names one this host can vouch for. */
  const resolveToken = (token: string, pagesOnly: boolean): Ref | undefined => {
    if (pagesOnly) {
      const page = token.includes("/") && !/^https?:\/\//.test(token) ? pageOf(token) : undefined
      return page === undefined ? undefined : { kind: "page", path: page }
    }
    const url = githubUrl.exec(token)
    if (url !== null) {
      const number = Number(url[3])
      return url[2] === "pull" ? { kind: "pull", github: url[1]!, number, url: token } : { kind: "issue", github: url[1]!, number }
    }
    if (/^https?:\/\//.test(token)) return undefined
    const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(token)
    if (qualified !== null) {
      return githubs.includes(qualified[1]!) ? { kind: "issue", github: qualified[1]!, number: Number(qualified[2]) } : undefined
    }
    const bare = /^#(\d+)$/.exec(token)
    if (bare !== null) return defaultGithub === undefined ? undefined : { kind: "issue", github: defaultGithub, number: Number(bare[1]) }
    if (token.includes("/")) {
      const page = pageOf(token)
      if (page !== undefined) return { kind: "page", path: page }
      for (const [name, repository] of Object.entries(options.repositories)) {
        if (branchOf(repository, token) !== undefined) return { kind: "branch", repository: name, branch: token }
      }
      return undefined
    }
    if (/^[0-9a-f]{7,40}$/.test(token) && /[a-f]/.test(token)) {
      for (const [name, repository] of Object.entries(options.repositories)) {
        if (commitOf(repository, token) !== undefined) return { kind: "commit", repository: name, sha: token }
      }
    }
    return undefined
  }

  /**
   * The spans `refs` and the free text's tokens take in `prose`, and the refs
   * it does not name. A page is found by its name only when `nameable` says it
   * will be linked; otherwise only its path stands for it.
   */
  const spansOf = (
    prose: ReadonlyArray<{ readonly code: boolean; readonly text: string }>,
    refs: ReadonlyArray<Ref>,
    pagesOnly: boolean,
    nameable: (path: string) => boolean
  ) => {
    const spans: Array<Array<Span>> = prose.map(() => [])
    const overlaps = (index: number, start: number, end: number) =>
      spans[index]!.some((span) => start < span.end && span.start < end)
    const bounded = (text: string, start: number, end: number) =>
      !/[\w/#@-]/.test(text[start - 1] ?? " ") && !/[\w/-]/.test(text[end] ?? " ")
    const unnamed: Array<Ref> = []
    for (const ref of refs) {
      const candidates = ref.kind === "issue"
        ? [`${ref.github}#${ref.number}`, `#${ref.number}`]
        : ref.kind === "pull"
        ? [ref.url, `${ref.github}#${ref.number}`, `#${ref.number}`]
        : ref.kind === "commit"
        ? [ref.sha, ref.sha.slice(0, 12), ref.sha.slice(0, 7)]
        : ref.kind === "page"
        ? nameable(ref.path) ? [ref.path, labelOf(ref.path, options.generatedDir)] : [ref.path]
        : [rawOf(ref)]
      let named = false
      for (const [index, piece] of prose.entries()) {
        if (piece.code || named) continue
        for (const candidate of candidates) {
          let start = piece.text.indexOf(candidate)
          while (start >= 0 && (!bounded(piece.text, start, start + candidate.length) || overlaps(index, start, start + candidate.length))) {
            start = piece.text.indexOf(candidate, start + 1)
          }
          if (start < 0) continue
          spans[index]!.push({ start, end: start + candidate.length, ref, raw: candidate })
          named = true
          break
        }
      }
      if (!named) unnamed.push(ref)
    }
    for (const [index, piece] of prose.entries()) {
      if (piece.code) continue
      for (const match of piece.text.matchAll(tokens)) {
        let token = match[0]
        let ref = resolveToken(token, pagesOnly)
        if (ref === undefined && trailing.test(token)) {
          token = token.replace(trailing, "")
          ref = token === "" ? undefined : resolveToken(token, pagesOnly)
        }
        const start = match.index
        if (ref === undefined || overlaps(index, start, start + token.length)) continue
        spans[index]!.push({ start, end: start + token.length, ref, raw: token })
      }
    }
    return { spans: spans.map((each) => each.sort((left, right) => left.start - right.start)), unnamed }
  }

  /** A ref as Slack shows it; `raw` is the text it stood for, kept when a page cannot be linked. */
  const slackOf = (ref: Ref, pages: ReadonlyMap<string, string>, raw?: string): string => {
    const label = raw
    switch (ref.kind) {
      case "page": {
        const url = pages.get(ref.path)
        return url === undefined ? escape(raw ?? ref.path) : `<${url}|${escape(labelOf(ref.path, options.generatedDir))}>`
      }
      case "issue":
        return `<https://github.com/${ref.github}/issues/${ref.number}|${escape(issueLabel(ref.github, ref.number))}>`
      case "pull":
        return `<${escape(ref.url)}|${escape(issueLabel(ref.github, ref.number))}>`
      case "commit": {
        const shown = label ?? ref.sha.slice(0, 12)
        const found = commitOf(options.repositories[ref.repository], ref.sha)
        return found !== undefined && found.pushed
          ? `<https://github.com/${found.github}/commit/${found.full}|${escape(shown)}>`
          : `\`${escape(shown)}\``
      }
      case "branch": {
        const repository = options.repositories[ref.repository]
        const found = branchOf(repository, ref.branch)
        return found !== undefined && found.pushed && repository?.github !== undefined
          ? `<https://github.com/${repository.github}/tree/${encodePath(ref.branch)}|${escape(label ?? ref.branch)}>`
          : `\`${escape(label ?? ref.branch)}\``
      }
      case "url": {
        const known = githubUrl.exec(ref.url)
        return known === null ? escape(ref.url) : `<${escape(ref.url)}|${escape(issueLabel(known[1]!, Number(known[3])))}>`
      }
    }
  }

  const wikiLink = (ref: Ref): string => {
    if (ref.kind !== "page" || pageOf(ref.path) === undefined) return rawOf(ref)
    const target = extname(ref.path) === ".md" ? ref.path.slice(0, -3) : ref.path
    return `[[${target}|${labelOf(ref.path, options.generatedDir)}]]`
  }

  return {
    slack: (text, refs = []) => {
      const prose = pieces(text)
      // The pages named, found first so one push covers them all.
      const found = spansOf(prose, refs, true, () => false)
      const pages = publish([
        ...new Set([...found.spans.flat(), ...found.unnamed.map((ref) => ({ ref }))].flatMap(({ ref }) => ref.kind === "page" ? [ref.path] : []))
      ])
      const { spans, unnamed } = spansOf(prose, refs, false, (path) => pages.has(path))
      const body = prose.map((piece, index) => {
        if (piece.code) return escape(piece.text)
        let out = ""
        let at = 0
        for (const span of spans[index]!) {
          out += escape(piece.text.slice(at, span.start)) + slackOf(span.ref, pages, span.raw)
          at = span.end
        }
        return out + escape(piece.text.slice(at))
      }).join("")
      return `${body}${unnamed.map((ref) => ` · ${slackOf(ref, pages)}`).join("")}`
    },
    wiki: (text, refs = []) => {
      const prose = pieces(text)
      const { spans, unnamed } = spansOf(prose, refs, true, (path) => pageOf(path) !== undefined)
      const body = prose.map((piece, index) => {
        if (piece.code) return piece.text
        let out = ""
        let at = 0
        for (const span of spans[index]!) {
          out += piece.text.slice(at, span.start) + (span.ref.kind === "page" && pageOf(span.ref.path) !== undefined ? wikiLink(span.ref) : span.raw)
          at = span.end
        }
        return out + piece.text.slice(at)
      }).join("")
      return `${body}${unnamed.map((ref) => ` · ${wikiLink(ref)}`).join("")}`
    }
  }
}
