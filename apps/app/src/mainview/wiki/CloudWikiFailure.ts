import type { UserFailure, UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure } from "../FailureNotice"
import type { WikiIndexRow } from "../state/AppState"
import type { CloudWikiState } from "./CloudWikiState"

/*
 * The words a Wiki page and a Wiki space show when a read or sync fails. The
 * page's phase survives to the surface, so it keys the copy; the stored error
 * (a server body or a refusal) is only the Details.
 */
export const CLOUD_WIKI_PAGE_FAILURES: Readonly<Record<CloudWikiState["phase"], UserFailureCopy>> = {
  offline: { fault: "infra", sentence: "Smithers could not sync this page. Not your fault.", actions: [] },
  deleted: { fault: "dependency", sentence: "This page is no longer in the Wiki. Your edits are kept here.", actions: [] },
  cached: { fault: "infra", sentence: "Smithers could not sync this page. Not your fault.", actions: [] },
  live: { fault: "infra", sentence: "Smithers could not sync this page. Not your fault.", actions: [] }
}

/** The failure a page's stored error stands for, or null when it has none. */
export const cloudWikiPageFailure = (cloud: Pick<CloudWikiState, "phase" | "error">): UserFailure | null =>
  cloud.error === null ? null : describedFailure(`CloudWikiPage.${cloud.phase}`, CLOUD_WIKI_PAGE_FAILURES[cloud.phase], cloud.error)

export const WIKI_INDEX_FAILURE: UserFailureCopy = {
  fault: "infra",
  sentence: "Smithers could not load this Wiki's pages. Not your fault.",
  actions: ["retry"]
}

/** The failure a space's stored index refusal stands for, or null when the read succeeded. */
export const wikiIndexFailure = (index: Pick<WikiIndexRow, "error">): UserFailure | null =>
  index.error === undefined ? null : describedFailure("WikiIndexFailed", WIKI_INDEX_FAILURE, index.error)
