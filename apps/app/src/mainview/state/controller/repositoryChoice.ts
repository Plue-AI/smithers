import { rankTutorialRepositories, type RepositoryRanking } from "../seams/RepositoriesSeam"
import type { ControllerContext } from "./context"

export interface RepositoryChoicePayload extends RepositoryRanking {
  readonly selected: string | null
  readonly created: { readonly fullName: string } | null
}
export interface TutorialRepositoryActions {
  readonly chooseTutorialRepository: (repo?: string) => Promise<string | void>
  /** No host creates a repository on the reader's disk any more (docs/LOCAL-BACKEND-RETIREMENT.md): the handoff names what does. */
  readonly createTutorialRepository: (name: string) => Promise<string | void>
}
export interface TutorialRepositoryPorts {
  /** Root binds card.upsert to the repository-choice schema; the card draft is durable. */
  readonly publish: (payload: RepositoryChoicePayload) => Promise<void>
  readonly createRepository: (name: string) => Promise<{ readonly fullName: string } | string>
}

export function createTutorialRepositoryController(ctx: ControllerContext, ports: TutorialRepositoryPorts): TutorialRepositoryActions {
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const scope = () => ({ account: identity()?.login, epoch: ctx.accountEpoch })
  const current = (before: ReturnType<typeof scope>) => before.account === identity()?.login && before.epoch === ctx.accountEpoch
  return {
    chooseTutorialRepository: async (repo) => {
      const before = scope()
      const login = identity()?.state === "signed-in" ? identity()?.login : null
      const ranking = login ? await rankTutorialRepositories(ctx.boundedFetch, ctx.baseUrl) : {
        cutoff: new Date(Date.now() - 90 * 86400000).toISOString(), repositories: [], partial: true,
        error: "Sign in to list GitHub repositories."
      }
      if (!current(before)) return "The account changed; choose the repository again."
      if (repo === undefined) {
        await ports.publish({ ...ranking, selected: ranking.repositories[0]?.fullName ?? null, created: null })
        return
      }
      if (!ranking.repositories.some(row => row.fullName === repo)) return "That repository is not in the current GitHub inventory. Refresh the repository choice."
      const [org = "", name = ""] = repo.split("/")
      if (!ctx.store.collections.repositories.has(repo)) {
        await ctx.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
          ...ctx.store.collections.repositories.values(), { id: repo, org, name, ownerKind: "user", head: null }
        ] }).isPersisted.promise
      }
      await ctx.store.dispatch({ type: "repo.selected", actor: ctx.commandActor, id: repo }).isPersisted.promise
      await ports.publish({ ...ranking, selected: repo, created: null })
    },
    createTutorialRepository: async (name) => {
      const before = scope()
      const created = await ports.createRepository(name)
      if (typeof created === "string") return created
      if (!current(before)) return "The account changed; create the repository again."
      await ctx.store.dispatch({ type: "repo.selected", actor: ctx.commandActor, id: created.fullName }).isPersisted.promise
      await ports.publish({
        cutoff: new Date(Date.now() - 90 * 86400000).toISOString(),
        repositories: [],
        partial: false,
        error: null,
        selected: created.fullName,
        created
      })
    }
  }
}
