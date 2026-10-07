import { issueTodoDraftRequest, readIssueTodoDraft } from "../../../../../../packages/smithers/src/IssueTodoDraft.ts"
import type { IssueDraftSource } from "./TodoSeam"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"

/** The packaged app drafts from one quoted snapshot; this call has no tools. */
export const draftIssueTodo = async (ctx: Pick<SeamContext, "http" | "baseUrl">, source: IssueDraftSource, signal: AbortSignal) => {
  const response = await ctx.http(`${ctx.baseUrl}/api/model/stream`, {
    method: "POST", credentials: "include", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify(issueTodoDraftRequest(source))
  })
  if (!response.ok) throw new Error(await readErrorMessage(response, "Could not draft this issue."))
  return readIssueTodoDraft(await response.text())
}
