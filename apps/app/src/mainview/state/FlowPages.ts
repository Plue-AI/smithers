/*
 * Every flow a workspace has discovered, read page by page.
 *
 * The workspace answers 100 flows at a time (ControlSchema.defaultPageSize),
 * so any reader of the catalog walks `nextCursor`. This is the one walker:
 * the gateway seam's `listFlows` and the dispatcher's registrar gate both
 * read through it, each over its own transport.
 */

/** The most flow pages one walk reads: 50 pages of 100 flows. */
export const FLOW_PAGE_CAP = 50
export const TOO_MANY_FLOWS = "The workspace lists more flows than Smithers reads."

/** One page as a transport answered it: the `List` payload, or the transport's own refusal. */
export type FlowPageAnswer<R> =
  | { readonly ok: true; readonly page: unknown }
  | { readonly ok: false; readonly refusal: R }

export type FlowPagesResult<R> =
  | { readonly ok: true; readonly items: ReadonlyArray<Record<string, unknown>> }
  | { readonly ok: false; readonly refusal: R }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The `List` payload for one page: the first asks without a cursor. */
export const flowPageRequest = (cursor: string | undefined): { readonly _tag: "flows"; readonly cursor?: string } =>
  cursor === undefined ? { _tag: "flows" } : { _tag: "flows", cursor }

/**
 * Walk `nextCursor` until the workspace names none, repeats one, or answers
 * an empty page; past FLOW_PAGE_CAP pages the walk refuses with `tooMany`.
 * The walk also stops early once `live` turns false; a caller that passes it
 * re-checks the same predicate and discards the partial list.
 */
export const walkFlowPages = async <R>(
  read: (cursor: string | undefined) => Promise<FlowPageAnswer<R>>,
  tooMany: R,
  live: () => boolean = () => true
): Promise<FlowPagesResult<R>> => {
  const items: Array<Record<string, unknown>> = []
  const walked = new Set<string>()
  let cursor: string | undefined
  for (let pages = 0; ; pages++) {
    if (pages === FLOW_PAGE_CAP) return { ok: false, refusal: tooMany }
    const answered = await read(cursor)
    if (!answered.ok) return answered
    const body = isRecord(answered.page) ? answered.page : {}
    const page = (Array.isArray(body.items) ? body.items : []).filter(isRecord)
    items.push(...page)
    const next = body.nextCursor
    if (page.length === 0 || typeof next !== "string" || next === "" || walked.has(next) || !live()) return { ok: true, items }
    walked.add(next)
    cursor = next
  }
}
