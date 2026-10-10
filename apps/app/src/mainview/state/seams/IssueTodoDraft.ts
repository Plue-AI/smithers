import { issueTodoDraftRequest, readIssueTodoDraft } from "@smthrs/cli/IssueTodoDraft"
import type { IssueDraftSource } from "./TodoSeam"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"
import { Data } from "effect"

/** The model refused to draft the issue; `sentence` is the server's failure line (readErrorMessage). */
export class IssueDraftRefused extends Data.TaggedError("IssueDraftRefused")<{ readonly sentence: string }> {
  override get message() { return this.sentence }
}

/** The packaged app drafts from one quoted snapshot; this call has no tools. */
export const draftIssueTodo = async (ctx: Pick<SeamContext, "http" | "baseUrl">, source: IssueDraftSource, signal: AbortSignal) => {
  const response = await ctx.http(`${ctx.baseUrl}/api/model/stream`, {
    method: "POST", credentials: "include", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify(issueTodoDraftRequest(source))
  })
  if (!response.ok) throw new IssueDraftRefused({ sentence: await readErrorMessage(response, "Could not draft this issue.") })
  return readIssueTodoDraft(await response.text())
}
