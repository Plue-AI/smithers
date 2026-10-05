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
  return [
    flow({ name: "issue", summary: "Open an issue's card", args: "#n", discloseToAgent: true,
      grammar: numbered(), input: Schema.Struct({ number: Schema.Number }),
      handler: ({ number }) => {
        if (install()) return actions.viewIssue(number, undefined, "github")
        const issue = design.world().issues.find(each => each.number === number)
        return issue === undefined ? `No issue #${number}` : open(issueCard(repo(), number, issue.title))
      } }),
    flow({ name: "issues", summary: "List the repository's issues", input: Schema.Struct({}),
      handler: () => install() ? actions.listIssues("open") : open(issueListCard(repo())) }),
    flow({ name: "issue.new", summary: "Open a GitHub issue", args: "<title>", discloseToAgent: true,
      grammar: positional("title"), input: Schema.Struct({ title: Schema.NonEmptyString, body: Schema.String }),
      form: { submitLabel: "Open on GitHub", fields: { title: { label: "Title" }, body: { label: "Body" } }, args: json },
      handler: ({ title, body }) => ({ value: `Opened #${newIssue(design, title, body, design.viewer())} on GitHub` }) }),
    flow({ name: "issue.comment", summary: "Comment on an issue", args: "#n <text>", discloseToAgent: true,
      grammar: numbered("body"), input: Schema.Struct({ number: Schema.Number, body: Schema.NonEmptyString }),
      form: { submitLabel: "Comment", fields: { number: { label: "Issue" }, body: { label: "Comment" } }, args: json },
      handler: ({ number, body }) => commentIssue(design, number, body, design.viewer()) ? { value: `Commented on #${number}` } : `No issue #${number}` }),
    flow({ name: "file", summary: "Open and co-edit a file", args: "<path>", discloseToAgent: true,
      grammar: positional("path"), input: Schema.Struct({ path: Schema.String, branch: Schema.optional(Schema.String), line: Schema.optional(Schema.Number) }),
      handler: ({ path, branch, line }) => {
        const world = design.world()
        if (path === "") return open(fileListCard(repo(), findBranch(world, branch ?? "")?.id ?? "main"))
        const file = findFile(world, path, branch, design.viewer())
        return file === undefined ? `No file ${path}` : open(fileCard(repo(), file.branch, file.path, line))
      } }),
    flow({ name: "files", summary: "Browse a branch's files", args: "[branch]", discloseToAgent: true,
      grammar: positional("branch"), input: Schema.Struct({ branch: Schema.optional(Schema.String) }),
      handler: ({ branch }) => open(fileListCard(repo(), findBranch(design.world(), branch ?? "")?.id ?? "main")) }),
    flow({ name: "diff", summary: "Show a branch's changes", args: "[branch|path]", discloseToAgent: true,
      grammar: positional("subject"),
      input: Schema.Struct({ subject: Schema.optional(Schema.String), branch: Schema.optional(Schema.String), path: Schema.optional(Schema.String), entry: Schema.optional(Schema.String) }),
      handler: ({ subject, branch, path }) => {
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
    flow({ name: "file.restore", summary: "Restore this file", args: "<path>", hidden: true,
      grammar: positional("path"), input: Schema.Struct({ path: Schema.String, branch: Schema.optional(Schema.String), revision: Schema.optional(Schema.String) }),
      handler: ({ path, branch }) => {
        const file = findFile(design.world(), path, branch, design.viewer())
        if (file === undefined) return `No file ${path}`
        const result = design.restoreFile(file.id)
        return result.ok ? { value: result.ack } : result.refusal
      } }),
    flow({ name: "wiki.page", summary: "Open or create a page", args: "<name>", discloseToAgent: true,
      grammar: positional("name"), input: Schema.Struct({ name: Schema.NonEmptyString }),
      handler: ({ name }) => {
        const page = findWikiPage(design.world(), name)
        if (page !== undefined) return open(wikiCard(page.id, page.title))
        const id = newWikiPage(design, name, design.viewer())
        return open(wikiCard(id, name.trim()))
      } }),
    flow({ name: "pr", summary: "Open a pull request's card", args: "#n", discloseToAgent: true,
      grammar: numbered(), input: Schema.Struct({ number: Schema.Number }),
      handler: ({ number }) => {
        const pr = design.world().prs.find(each => each.number === number)
        return pr === undefined ? `No pull request #${number}` : open(prCard(repo(), number, pr.title))
      } })
  ]
}

export { issueNumberOf }
