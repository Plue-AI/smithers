import type { FormsController } from "../controller/forms"
import { presentAppFailure } from "../controller/AppFailure"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage,readResult,RepositorySignInRequired } from "./SeamContext"

/** Stop an unauthorized list before it can publish rows. */
export async function readRepositoryListError(response: Response, fallback: string): Promise<string> {
  const message = await readErrorMessage(response, fallback)
  if (response.status === 401) throw new RepositorySignInRequired(message)
  return message
}

export type RepositoryForm = FormsController["renderFlowForm"]

/**
 * A repository issue/PR list read with its doors: an explicit or selected
 * target, a form for a missing target, and a sign-in prompt for a 401.
 */
export async function repositoryListRead(
  ctx: SeamContext,
  kind: "issues" | "prs",
  explicit: string | undefined,
  filter: "open" | "closed" | "all",
  renderForm: RepositoryForm | undefined,
  read: (repo: string) => Promise<string | void | { readonly value: string }>,
  /** The form's prefilled line when it carries more than the filter (issues.list --kind/--view). */
  formArgs?: string,
): Promise<string | void | { readonly value: string }> {
  const actor = ctx.actor()
  const target = resolveTargetRepo(ctx.store, explicit)
  if ("error" in target) {
    if (!explicit && renderForm) {
      renderForm({ name: `${kind}.list`, args: formArgs ?? (kind === "issues" ? filter : ""), via: actor === "smithers" ? "agent" : "user",
        hints: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text", required: true } } } })
      return readResult("Rendered a form for repo.")
    }
    return target.error
  }
  const { repo } = target
  try {
    return await read(repo)
  } catch (error) {
    if (!(error instanceof RepositorySignInRequired)) throw error
    /* No sign-in door on this host: the registry's sentence, never the 401's words. */
    if (ctx.promptSignIn === undefined) return presentAppFailure(error, () => {}).sentence
    ctx.promptSignIn(`read ${kind === "issues" ? "issues" : "pull requests"} on ${repo}`)
    return readResult("The sign-in step is rendered in the chat.")
  }
}
