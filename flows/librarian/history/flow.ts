import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
// The flow below is this module's own default export. Discovery reads the
// literal `export default Flow.make(` without importing the file, so the flow
// cannot also be a named const; the registration beside it reads the value
// back through this self-import, which resolves after this module evaluates.
import { commitEnvironment, git, GitError, sourceRevision } from "../tutorial2-background_flows-git.ts"
import History from "./flow.ts"

export const Input = Schema.Struct({ repo: Schema.NonEmptyString })
export const HistoryReceipt = Schema.Struct({
  repo: Schema.String,
  sourceHead: Schema.String,
  sourceTree: Schema.String,
  mythicalHead: Schema.String,
  notesHead: Schema.String,
  treeEqual: Schema.Boolean
})
export type HistoryReceipt = typeof HistoryReceipt.Type
export class MissingSourceBookmark
  extends Schema.TaggedError<MissingSourceBookmark>()("librarian/MissingSourceBookmark", {
    bookmark: Schema.String,
    message: Schema.String
  })
{}
const HistoryError = Schema.Union([Schema.String, MissingSourceBookmark])
const symbolicRef = async (root: string, name: string): Promise<string | null> => {
  try {
    return await git(root, ["symbolic-ref", "-q", name])
  } catch (cause) {
    // Exit 1 without stderr means this ref is not symbolic (including detached HEAD).
    if (cause instanceof GitError && cause.code === 1 && !cause.stderr.trim()) return null
    throw cause
  }
}
const ref = async (root: string, name: string) => {
  // Missing refs are absent; every other Git error is a failure.
  const result = await git(root, ["for-each-ref", "--format=%(objectname)", name])
  return result || null
}
/** Bootstrap is create-only. Deterministic objects + atomic CAS make crash replay safe. */
export const generateHistory = async (root: string, repo: string): Promise<HistoryReceipt> => {
  let sourceRef = await symbolicRef(root, "HEAD")
  if (
    sourceRef && !(await git(root, ["for-each-ref", "--format=%(refname)", sourceRef])).split("\n").includes(sourceRef)
  ) {
    const bookmark = sourceRef.replace(/^refs\/heads\//, "")
    throw new MissingSourceBookmark({
      bookmark,
      message: `Cannot create Mythical history: bookmark "${bookmark}" has no commit (HEAD is unborn).`
    })
  }
  const { head, tree, date } = await sourceRevision(root)
  if (!sourceRef) {
    const branches = (await git(root, ["for-each-ref", "--points-at", "HEAD", "--format=%(refname)", "refs/heads/"]))
      .split("\n").filter(Boolean)
    // A clone records the repository's default bookmark in origin/HEAD when available.
    const originHead = await symbolicRef(root, "refs/remotes/origin/HEAD")
    const defaultRef = originHead?.replace(/^refs\/remotes\/origin\//, "refs/heads/")
    sourceRef = branches.find((branch) => branch === defaultRef) ?? branches[0] ?? null
  }
  const environment = commitEnvironment(date)
  const mythicalHead = await git(
    root,
    ["commit-tree", tree],
    `Create Mythical history\n\nSource: ${head}\n`,
    environment
  )
  const note =
    `---\nversion: 1\nsourceHead: ${head}\nsourceTree: ${tree}\nconfidence: 1\nactor: smithers\n---\n\n## Tried\nCreated a repository snapshot at the captured source revision.\n\n## Evidence\nSource commit: ${head}\nSource and mythical tree: ${tree}\n\n## Folded\nNo outside merges were folded.\n\n## Superseded\nNo existing mythical history was replaced.\n`
  const blob = await git(root, ["hash-object", "-w", "--stdin"], note)
  const notesTree = await git(root, ["mktree"], `100644 blob ${blob}\t${mythicalHead}\n`)
  const notesHead = await git(
    root,
    ["commit-tree", notesTree],
    `Mythical history provenance for ${head}\n`,
    environment
  )
  const existing = await ref(root, "refs/heads/mythical")
  const existingNotes = await ref(root, "refs/notes/mythical")
  if (existing === mythicalHead && existingNotes === notesHead) {
    return { repo, sourceHead: head, sourceTree: tree, mythicalHead, notesHead, treeEqual: true }
  }
  if (existing || existingNotes) throw new Error("Mythical history already exists. Bootstrap will not replace it.")
  if (sourceRef === "refs/heads/mythical") throw new Error("Select the source branch before creating mythical history.")
  // Detached HEAD needs no branch. Recheck it immediately before the atomic create;
  // when a source branch exists, also verify that branch in the transaction.
  const verify = sourceRef ? `verify ${sourceRef} ${head}\n` : ""
  if (await git(root, ["rev-parse", "HEAD"]) !== head) {
    throw new Error("HEAD moved. Retry against the new source revision.")
  }
  await git(
    root,
    ["update-ref", "--stdin"],
    `start\n${verify}create refs/heads/mythical ${mythicalHead}\ncreate refs/notes/mythical ${notesHead}\nprepare\ncommit\n`
  )
  const actual = await git(root, ["rev-parse", `${mythicalHead}^{tree}`])
  if (actual !== tree) throw new Error("The mythical history tree differs from the captured source tree.")
  return { repo, sourceHead: head, sourceTree: tree, mythicalHead, notesHead, treeEqual: true }
}
export const CreateHistory = Action.make("librarian/create-history", {
  payload: Input,
  success: HistoryReceipt,
  error: HistoryError
})

/**
 * `modelInvocable: false` because `librarian/create-history` is implemented by
 * the product host alone. This file sits in a repository any host may scan, and
 * a catalog elsewhere would otherwise teach an agent a call with no
 * implementation to reach.
 */
export default Flow.make("librarian/CreateHistory", {
  description: "Create Mythical history and provenance notes atomically, preserving the source branch and tree.",
  capabilities: ["fs:read:**", "fs:write:.git/**"],
  effects: {
    reads: ["**"],
    writes: [".git/refs/heads/mythical", ".git/refs/notes/mythical", ".git/objects/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "sealed"
  },
  modelInvocable: false,
  payload: Input,
  success: HistoryReceipt,
  error: HistoryError,
  body: (input) => CreateHistory.call(input)
})

export const registration = (root: string, owningRepo?: string) =>
  Layer.mergeAll(
    CreateHistory.toLayer(({ repo }) =>
      Effect.tryPromise({
        try: async () => {
          if (owningRepo !== undefined && repo !== owningRepo) {
            throw new Error("The requested repository does not own this workspace.")
          }
          return generateHistory(root, repo)
        },
        catch: (cause) => cause instanceof MissingSourceBookmark ? cause : String(cause)
      })
    ),
    Interpreter.layer(History)
  ).pipe(Layer.provideMerge(Action.layerImplementations))
