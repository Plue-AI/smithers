import { identityMessage } from "../../Onboarding"
import { activeRepositoryId } from "../RepoContext"
import type { ControllerContext } from "./context"

export interface AppShellController {
  /**
   * The `smithers.who` handler: the identity line (Onboarding.ts
   * identityMessage) rendered as a Smithers message and handed back as the
   * value, so the human's slash, a button and the agent's tool call all read
   * the same sentence.
   */
  readonly introduce: () => { readonly value: string }
}

export const createAppShellController = (ctx: ControllerContext): AppShellController => {
  const introduce = (): { readonly value: string } => {
    const { collections } = ctx.store
    const value = identityMessage({
      bootstrap: ctx.services.bootstrap,
      connectors: [...collections.connectors.values()],
      repositories: [...collections.repositories.values()],
      // The same selection the agent runtime context reports (controller/turns.ts activeRepository).
      activeRepository: activeRepositoryId(ctx.store),
      registered: (flow) => ctx.commands.find(flow) !== undefined
    })
    ctx.store.dispatch({ type: "message.appended", actor: "smithers", text: value })
    return { value }
  }

  return { introduce }
}
