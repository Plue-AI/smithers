/*
 * Issue, File, Diff, Wiki page and PR (mvp.md Appendix A). MOCK: each
 * handler reads or writes the seeded design world (state/seams/DesignWorld/
 * subjects.ts) and opens the retained card for its subject; the Issue card's
 * Make TODO is `todo.new` and a finding's Please fix is `todo.steer`, both the
 * TODO lane's flows. The real seams replace the handlers one by one:
 * IssuesSeam, FilesSeam, ChangeSeam, the wiki collections, LandingsSeam.
 */
import { Schema } from "effect"
import { payloadFor } from "../SlashPayload"
import { flowArgs } from "../FlowArgs"
import { FILES_LIST_COMMAND } from "@smthrs/rpc/FileList"
import { FILES_READ_COMMAND } from "@smthrs/rpc/FileRead"
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
  const designRepo = () => design.world().repo.repo
  const open = async (card: Parameters<CommandActions["presentSubject"]>[0]): Promise<CommandResult> => ({ value: await actions.presentSubject(card) })
  /* An install's issues are its repository's GitHub issues, through IssuesSeam (GET /api/issues). */
  const install = () => actions.bootstrap?.capabilities.includes("install") === true
  const realFiles = () => install() || actions.branchFiles.available()
  const repositoryFile = (payload: Readonly<Record<string, unknown>>): boolean => payload.operation !== "workspace" && payload.operation !== "tree" && payload.branch === undefined && payload.revision === undefined &&
    (payload.operation === "repository" || payload.repo !== undefined || payload.ref !== undefined || /^\/[^/]+\/[^/]+(?:\/|$)/.test(String(payload.path ?? "")) ||
      actions.snapshot().repositorySelected === true || actions.snapshot().firstRunTargetPending === true || actions.snapshot().repositoryReadiness !== undefined || install() || actions.bootstrap?.host === "cloud")
  return [
    flow({ name: "issue",   slash: "/issue", cli: ["issue","show"], journey: ["J2"], group: "Issues", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/issues/{number}"}, summary: "Open an issue's card", args: "#n", discloseToAgent: true,
      grammar: numbered(), agent: "run", input: Schema.Struct({ number: Schema.Number }),
      handler: ({ number }) => {
        if (install()) return actions.viewIssue(number, undefined, "github")
        const issue = design.world().issues.find(each => each.number === number)
        return issue === undefined ? `No issue #${number}` : open(issueCard(designRepo(), number, issue.title))
      } }),
    flow({ name: "issues",   slash: "/issues", cli: ["issues"], journey: ["J2"], group: "Issues", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/issues"}, summary: "List the repository's issues", agent: "run", input: Schema.Struct({}),
      handler: () => install() ? actions.listIssues("open") : open(issueListCard(designRepo())) }),
    flow({ name: "issue.new",   slash: "/issue.new", cli: ["issue","new"], journey: [], group: "Issues", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/issues"}, summary: "Open a GitHub issue", args: "<title>", discloseToAgent: true,
      grammar: positional("title"), agent: "confirm", input: Schema.Struct({ title: Schema.NonEmptyString, body: Schema.String }),
      form: { submitLabel: "Open on GitHub", fields: { title: { label: "Title" }, body: { label: "Body" } }, args: json },
      handler: ({ title, body }) => ({ value: `Opened #${newIssue(design, title, body, design.viewer())} on GitHub` }) }),
    flow({ name: "issue.comment",   slash: "/issue.comment", cli: ["issue","comment"], journey: ["J2"], group: "Issues", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/issues/{number}/comments"}, summary: "Comment on an issue", args: "#n <text>", discloseToAgent: true,
      grammar: numbered("body"), agent: "confirm", input: Schema.Struct({ number: Schema.Number, body: Schema.NonEmptyString }),
      form: { submitLabel: "Comment", fields: { number: { label: "Issue" }, body: { label: "Comment" } }, args: json },
      handler: ({ number, body }) => commentIssue(design, number, body, design.viewer()) ? { value: `Commented on #${number}` } : `No issue #${number}` }),
    flow({ name: "file",   slash: "/file", cli: ["file"], journey: ["J3","J9"], group: "Files and code", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: { method: "GET", path: "/api/branches/{branch}/files/{path}", defaults: { branch: "main" }, query: { at: "revision" } }, summary: "Open and co-edit a file", args: FILES_READ_COMMAND.args, discloseToAgent: true,
      grammar: args => payloadFor("file", args), agent: "run",
      payloadRequires: payload => payload.operation === "workspace" ? ["signed-in"] : repositoryFile(payload) ? ["first-run-target", "repo-source"] : [],
      form: { fields: { branch: { hidden: true }, revision: { hidden: true }, workspaceId: { optionsFrom: "workspaces", hidden: true }, operation: { hidden: true }, path: { kind: "text" }, repo: { optionsFrom: "cloud-repos", kind: "text" } }, args: payload => flowArgs("file", payload as Parameters<typeof flowArgs<"file">>[1]) },
      input: Schema.Struct({ path: Schema.String, branch: Schema.optional(Schema.String), line: Schema.optional(Schema.Number), column: Schema.optional(Schema.Number), revision: Schema.optional(Schema.String), repo: Schema.optional(Schema.String), ref: Schema.optional(Schema.String), workspaceId: Schema.optional(Schema.String), operation: Schema.optional(Schema.Literals(["repository", "workspace"])) }),
      prepare: ({ path, repo, line, column, ref, branch, revision, operation }) => operation !== "workspace" && branch === undefined && revision === undefined ? actions.readFile.preload?.(path, repo, line === undefined ? undefined : { line, ...(column === undefined ? {} : { column }) }, ref) : undefined,
      handler: ({ path, branch, line, column, revision, repo, ref, operation, workspaceId }) => {
        if (operation === "workspace") return install() || actions.live ? "Branch unavailable" : actions.readWorkspaceFile(path, workspaceId)
        if (repositoryFile({ path, branch, revision, operation, repo, ref })) return actions.readFile(path, repo, line === undefined ? undefined : { line, ...(column === undefined ? {} : { column }) }, ref)

        if (install() && branch === "main") return actions.readFile(path, undefined, line === undefined ? undefined : { line, ...(column === undefined ? {} : { column }) }, "main")
        if (revision !== undefined) return actions.readFile(path, undefined, line === undefined ? undefined : { line }, revision)
        if (install() && !actions.branchFiles.available()) return actions.readFile(path, undefined, line === undefined ? undefined : { line }, branch)
        if (realFiles()) return actions.branchFiles.open(path, branch, line)
        const world = design.world()
        if (path === "") return open(fileListCard(designRepo(), findBranch(world, branch ?? "")?.id ?? "main"))
        const file = findFile(world, path, branch, design.viewer())
        return file === undefined ? `No file ${path}` : open(fileCard(designRepo(), file.branch, file.path, line))
      } }),
    flow({ name: "files", slash: "/files", cli: ["files"], journey: ["J3"], group: "Files and code", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: { method: "GET", path: "/api/branches/{branch}/files", defaults: { branch: "main" }, query: { path: "path" } }, summary: "Browse a branch's files", args: FILES_LIST_COMMAND.args, discloseToAgent: true,
      grammar: args => {
        const parsed = payloadFor("files", args)
        if (!("payload" in parsed) || args?.trim().startsWith("{")) return parsed
        const branch = (value: unknown): value is string => typeof value === "string" && /^(?:main|T[1-9]\d*|scratch\/[^/]+\/[^/]+)$/.test(value)
        if (branch(parsed.payload.repo)) return { payload: { path: parsed.payload.path, branch: parsed.payload.repo } }
        if (branch(parsed.payload.path) && parsed.payload.repo === undefined) return { payload: { branch: parsed.payload.path } }
        return parsed
      }, agent: "run",
      payloadRequires: payload => payload.operation === "workspace" || payload.operation === "tree" ? ["signed-in"] : repositoryFile(payload) ? ["first-run-target", "repo-source"] : [],
      preflight: (payload, actor) => payload.operation === "tree" && actor !== "user" ? "Only a person can change the file tree" : undefined,
      input: Schema.Struct({ path: Schema.optional(Schema.String), branch: Schema.optional(Schema.String), repo: Schema.optional(Schema.String), workspaceId: Schema.optional(Schema.String), copy: Schema.optional(Schema.String), operation: Schema.optional(Schema.Literals(["repository", "workspace", "tree"])) }),
      form: { requires: payload => payload.operation === "tree" ? ["copy"] : undefined, fields: { branch: { hidden: true }, operation: { hidden: true }, copy: { label: "Working copy", kind: "text", hidden: true }, path: { kind: "text" }, repo: { optionsFrom: "cloud-repos", kind: "text" }, workspaceId: { optionsFrom: "workspaces", hidden: true } }, args: payload => JSON.stringify(payload) },
      prepare: ({ path, repo, branch, operation }) => operation !== "workspace" && operation !== "tree" && branch === undefined ? actions.listFiles.preload?.(path ?? "", repo) : undefined,
      handler: ({ path, branch, repo, operation, workspaceId, copy }) => {
        if (operation === "tree") return copy ? actions.toggleRepoTree(copy, path) : "Choose a working copy"
        if (operation === "workspace") return install() || actions.live ? "Branch unavailable" : actions.listWorkspaceFiles(path, workspaceId)
        if (repositoryFile({ path, branch, repo, operation })) return actions.listFiles(path ?? "", repo)
        return install() ? actions.listFiles(path ?? "", branch) : realFiles() ? actions.branchFiles.list(branch) : open(fileListCard(designRepo(), findBranch(design.world(), branch ?? path ?? "")?.id ?? "main"))
      } }),
    flow({ name: "diff",   slash: "/diff", cli: ["diff"], journey: ["J2","J3"], group: "Files and code", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: null, summary: "Show a branch's changes", args: "[branch|path]", discloseToAgent: true,
      grammar: positional("subject"),
      form: {
        fields: { operation: { hidden: true }, cardId: { hidden: true } },
        requires: payload => payload.operation === "file" ? ["cardId", "path"] : payload.operation === "pins" ? ["changeId", "from", "to"] : payload.operation === "checks" ? ["changeId", "seq"] : payload.operation ? ["changeId"] : undefined,
        optionalFields: payload => payload.operation === "change-diff" ? ["from", "to", "path"] : payload.operation === "change" ? ["rev"] : [],
        args: payload => JSON.stringify(payload)
      },
      payloadRequires: payload => payload.operation && payload.operation !== "file" ? ["signed-in"] : [],
      agent: "run", input: Schema.Struct({ subject: Schema.optional(Schema.String), branch: Schema.optional(Schema.String), path: Schema.optional(Schema.String), entry: Schema.optional(Schema.String),
        operation: Schema.optional(Schema.Literals(["change", "change-diff", "pins", "checks", "file"])), changeId: Schema.optional(Schema.String), rev: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))), from: Schema.optional(Schema.String), to: Schema.optional(Schema.String), seq: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))), cardId: Schema.optional(Schema.String) }),
      handler: ({ subject, branch, path, entry, operation, changeId, rev, from, to, seq, cardId }) => {
        if (operation === "file") return cardId && path ? actions.openDiffFile(cardId, path) : "Select a diff and file"
        if (operation === "change") return changeId ? actions.viewChange(changeId, rev) : "Choose a change"
        if (operation === "change-diff") return changeId ? actions.diffChange(changeId, from, to, path) : "Choose a change"
        if (operation === "pins") return changeId && from && to ? actions.setChangePins(changeId, from, to) : "Choose revision pins"
        if (operation === "checks") return changeId && seq !== undefined ? actions.checksOfChangeAt(changeId, seq) : "Choose a revision"

        if (realFiles()) return entry !== undefined ? "Burst diff unavailable" : actions.branchDiff(branch ?? subject)
        const world = design.world()
        const wanted = path ?? subject ?? ""
        const file = wanted === "" ? undefined : findFile(world, wanted, branch, design.viewer())
        if (file !== undefined) return open(diffCard(designRepo(), file.id, file.path.split("/").at(-1) ?? file.path))
        /* A bare /diff shows the branch this person is on; on main, the first item in review. */
        const here = shellViewsOf(design).get(design.viewer())?.at
        const fallback = here !== undefined && here !== "main" ? findBranch(world, here) ?? findBranch(world, "T8") : findBranch(world, "T8")
        const target = findBranch(world, branch ?? wanted) ?? (wanted === "" && branch === undefined ? fallback : undefined)
        return target === undefined ? `Nothing to diff for ${wanted}` : open(diffCard(designRepo(), target.id, target.name))
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
          return open({ ...fileCard(designRepo(), file.branch, path), id: fileCard(designRepo(), file.branch, file.path).id })
        }
        if (name === "file.compare") return open(diffCard(designRepo(), file.id, file.path))
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
        return pr === undefined ? `No pull request #${number}` : open(prCard(designRepo(), number, pr.title))
      } })
  ]
}

export { issueNumberOf }
