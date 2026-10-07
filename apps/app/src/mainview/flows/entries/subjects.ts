/*
 * Issue, File, Diff, Wiki page and PR (mvp.md Appendix A). MOCK: each
 * handler reads or writes the seeded design world (state/seams/DesignWorld/
 * subjects.ts) and opens the retained card for its subject; the Issue card's
 * Make TODO is `todo.new` and a finding's Please fix is `todo.steer`, both the
 * TODO lane's flows. The real seams replace the handlers one by one:
 * IssuesSeam, FilesSeam, ChangeSeam, the wiki collections, LandingsSeam.
 */
import { Schema } from "effect"
import { shellViewsOf } from "../../state/seams/DesignWorld/shell"
import { flow, type CommandActions, type CommandResult } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"
import {
  commentIssue, diffCard, fileCard, fileListCard, findBranch, findFile, findWikiPage, issueCard, issueListCard, issueNumberOf,
  newIssue, newWikiPage, prCard, wikiCard
} from "../../state/seams/DesignWorld/subjects"

/** A JSON object from a button or form, or one positional word for `field` from the slash line. */
const positional = (field: string, coerce: (text: string) => unknown = text => text): Grammar => args => {
  const text = args?.trim() ?? ""
  if (text === "") return { payload: {} }
  if (text.startsWith("{")) {
    try {
      const payload: unknown = JSON.parse(text)
      if (payload && typeof payload === "object" && !Array.isArray(payload)) return { payload: payload as Record<string, unknown> }
    } catch { /* falls through to the refusal */ }
    return { error: "Enter a JSON object" }
  }
  return { payload: { [field]: coerce(text) } }
}

/** `#231 the comment`: the number, then the rest of the line as `field`. */
export const numbered = (field?: string): Grammar => args => {
  const text = args?.trim() ?? ""
  if (text.startsWith("{")) return positional("number")(text)
  const match = /^#?([1-9]\d*)(?:\s+([\s\S]*))?$/.exec(text)
  if (match === null) return { payload: {} }
  return { payload: { number: Number(match[1]), ...(field !== undefined && match[2] ? { [field]: match[2] } : {}) } }
}

const json = (payload: Record<string, unknown>) => JSON.stringify(payload)

export const subjectFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const design = actions.design
  const repo = () => design.world().repo.repo
  const open = async (card: Parameters<CommandActions["presentSubject"]>[0]): Promise<CommandResult> => ({ value: await actions.presentSubject(card) })
  /* An install's issues are its repository's GitHub issues, through IssuesSeam (GET /api/issues). */
  const install = () => actions.bootstrap?.capabilities.includes("install") === true
  const realFiles = () => install() || actions.branchFiles.available()
  return [
    flow({ name: "issue",   slash: "/issue", cli: ["issue","show"], journey: ["J2"], group: "Issues", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/issues/{number}"}, summary: "Open an issue's card", args: "#n", discloseToAgent: true,
      grammar: numbered(), agent: "run", input: Schema.Struct({ number: Schema.Number }),
      handler: ({ number }) => {
        if (install()) return actions.viewIssue(number, undefined, "github")
        const issue = design.world().issues.find(each => each.number === number)
        return issue === undefined ? `No issue #${number}` : open(issueCard(repo(), number, issue.title))
      } }),
    flow({ name: "issues",   slash: "/issues", cli: ["issues"], journey: ["J2"], group: "Issues", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/issues"}, summary: "List the repository's issues", agent: "run", input: Schema.Struct({}),
      handler: () => install() ? actions.listIssues("open") : open(issueListCard(repo())) }),
    flow({ name: "issue.new",   slash: "/issue.new", cli: ["issue","new"], journey: [], group: "Issues", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/issues"}, summary: "Open a GitHub issue", args: "<title>", discloseToAgent: true,
      grammar: positional("title"), agent: "confirm", input: Schema.Struct({ title: Schema.NonEmptyString, body: Schema.String }),
      form: { submitLabel: "Open on GitHub", fields: { title: { label: "Title" }, body: { label: "Body" } }, args: json },
      handler: ({ title, body }) => ({ value: `Opened #${newIssue(design, title, body, design.viewer())} on GitHub` }) }),
    flow({ name: "issue.comment",   slash: "/issue.comment", cli: ["issue","comment"], journey: ["J2"], group: "Issues", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/issues/{number}/comments"}, summary: "Comment on an issue", args: "#n <text>", discloseToAgent: true,
      grammar: numbered("body"), agent: "confirm", input: Schema.Struct({ number: Schema.Number, body: Schema.NonEmptyString }),
      form: { submitLabel: "Comment", fields: { number: { label: "Issue" }, body: { label: "Comment" } }, args: json },
      handler: ({ number, body }) => commentIssue(design, number, body, design.viewer()) ? { value: `Commented on #${number}` } : `No issue #${number}` }),
    flow({ name: "file",   slash: "/file", cli: ["file"], journey: ["J3","J9"], group: "Files and code", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: null, summary: "Open and co-edit a file", args: "<path>", discloseToAgent: true,
      grammar: positional("path"), agent: "run", input: Schema.Struct({ path: Schema.String, branch: Schema.optional(Schema.String), line: Schema.optional(Schema.Number), revision: Schema.optional(Schema.String) }),
      handler: ({ path, branch, line, revision }) => {
        if (revision !== undefined) return actions.readFile(path, undefined, line === undefined ? undefined : { line }, revision)
        if (install() && !actions.branchFiles.available()) return actions.readFile(path, undefined, line === undefined ? undefined : { line }, branch)
        if (realFiles()) return actions.branchFiles.open(path, branch, line)
        const world = design.world()
        if (path === "") return open(fileListCard(repo(), findBranch(world, branch ?? "")?.id ?? "main"))
        const file = findFile(world, path, branch, design.viewer())
        return file === undefined ? `No file ${path}` : open(fileCard(repo(), file.branch, file.path, line))
      } }),
    flow({ name: "files",   slash: "/files", cli: ["files"], journey: ["J3"], group: "Files and code", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: null, summary: "Browse a branch's files", args: "[branch]", discloseToAgent: true,
      grammar: positional("branch"), agent: "run", input: Schema.Struct({ branch: Schema.optional(Schema.String) }),
      handler: ({ branch }) => install() ? actions.listFiles("", branch) : realFiles() ? actions.branchFiles.list(branch) : open(fileListCard(repo(), findBranch(design.world(), branch ?? "")?.id ?? "main")) }),
    flow({ name: "diff",   slash: "/diff", cli: ["diff"], journey: ["J2","J3"], group: "Files and code", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: null, summary: "Show a branch's changes", args: "[branch|path]", discloseToAgent: true,
      grammar: positional("subject"),
      agent: "run", input: Schema.Struct({ subject: Schema.optional(Schema.String), branch: Schema.optional(Schema.String), path: Schema.optional(Schema.String), entry: Schema.optional(Schema.String) }),
      handler: ({ subject, branch, path, entry }) => {
        if (realFiles()) return entry !== undefined ? "Burst diff unavailable" : actions.branchDiff(branch ?? subject)
        const world = design.world()
        const wanted = path ?? subject ?? ""
        const file = wanted === "" ? undefined : findFile(world, wanted, branch, design.viewer())
        if (file !== undefined) return open(diffCard(repo(), file.id, file.path.split("/").at(-1) ?? file.path))
        /* A bare /diff shows the branch this person is on; on main, the first item in review. */
        const here = shellViewsOf(design).get(design.viewer())?.at
        const fallback = here !== undefined && here !== "main" ? findBranch(world, here) ?? findBranch(world, "T8") : findBranch(world, "T8")
        const target = findBranch(world, branch ?? wanted) ?? (wanted === "" && branch === undefined ? fallback : undefined)
        return target === undefined ? `Nothing to diff for ${wanted}` : open(diffCard(repo(), target.id, target.name))
      } }),
    flow({ name: "file.restore", agent: "run", actors: ["person","app_agent"], minimumRole: "member", visibility: "in-card", summary: "Restore this file", args: "<path>", hidden: true, discloseToAgent: true,
      grammar: positional("path"), input: Schema.Struct({ path: Schema.String, branch: Schema.optional(Schema.String), revision: Schema.optional(Schema.String), post_digest: Schema.optional(Schema.String) }),
      handler: ({ path, branch, revision, post_digest }) => {
        if (realFiles()) return revision && post_digest ? actions.branchFiles.restoreVersion(path, branch, revision, post_digest) : actions.branchFiles.action("file.restore", path, branch)
        const file = findFile(design.world(), path, branch, design.viewer())
        if (file === undefined) return `No file ${path}`
        const result = design.restoreFile(file.id)
        return result.ok ? { value: result.ack } : result.refusal
      } }),
    ...(["file.compare", "file.restore-deleted", "file.follow-rename"] as const).map(name => flow({
      name, visibility: "in-card", agent: "run", actors: ["person","app_agent"], minimumRole: "member", summary: name === "file.compare" ? "Compare" : name === "file.restore-deleted" ? "Restore" : "Follow", hidden: true, discloseToAgent: true,
      grammar: positional("path"), input: Schema.Struct({ path: Schema.String, branch: Schema.optional(Schema.String) }),
      handler: async ({ path, branch }) => {
        const document = await actions.recoverFile(name, path, branch)
        if (document !== undefined) return document
        if (realFiles()) return actions.branchFiles.action(name, path, branch)
        const file = findFile(design.world(), path, branch, design.viewer())
        if (!file) return `No file ${path}`
        if (name === "file.follow-rename" && file.gone?.kind === "renamed") {
          const path = file.gone.to ?? file.path
          design.patch("files", file.id, current => ({ ...current, path, gone: undefined }))
          return open({ ...fileCard(repo(), file.branch, path), id: fileCard(repo(), file.branch, file.path).id })
        }
        if (name === "file.compare") return open(diffCard(repo(), file.id, file.path))
        const result = design.restoreFile(file.id)
        return result.ok ? { value: result.ack } : result.refusal
      }
    })),
    flow({ name: "wiki.page",   slash: "/wiki.page", cli: ["wiki","page"], journey: ["J8"], group: "Wiki", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: null, summary: "Open or create a page", args: "<name>", discloseToAgent: true,
      grammar: positional("name"), agent: "run", input: Schema.Struct({ name: Schema.NonEmptyString, revision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))) }),
      handler: ({ name, revision }) => {
        if (revision !== undefined || install()) return actions.openWikiPage(name, revision)
        const page = findWikiPage(design.world(), name)
        if (page !== undefined) return open(wikiCard(page.id, page.title))
        const id = newWikiPage(design, name, design.viewer())
        return open(wikiCard(id, name.trim()))
      } }),
    flow({ name: "pr",   slash: "/pr", cli: ["pr"], journey: ["J2"], group: "Review", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: null, summary: "Open a pull request's card", args: "#n", discloseToAgent: true,
      grammar: numbered(), agent: "run", input: Schema.Struct({ number: Schema.Number }),
      handler: ({ number }) => {
        const pr = design.world().prs.find(each => each.number === number)
        return pr === undefined ? `No pull request #${number}` : open(prCard(repo(), number, pr.title))
      } })
  ]
}

export { issueNumberOf }
