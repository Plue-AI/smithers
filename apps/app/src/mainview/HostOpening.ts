import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { LocalRepositoryConnector, Message, CloudRepository } from "./state/AppState"

/*
 * The host opening entry: "Smithers initialized successfully", derived
 * (never stored) from what the host actually registered — the bootstrap
 * contract, the flow registry, the repositories — and
 * the one next step, selecting a repository. Same discipline as the derived
 * auth message in App.tsx: a projection of live collections, gone the moment
 * the state it reads changes. Cloud repository pages use their Welcome actions
 * instead; App.tsx suppresses this diagnostic entry from the selected repo onward.
 */

export const INIT_MESSAGE_ID = "init-state"
/** The one-word name, pinned: a live model once introduced itself as "Smith Smithers". */
export const SMITHERS_NAME = "Smithers"
/** The greeting for the host diagnostic entry, when that entry is shown. */
export const INIT_GREETING = `${SMITHERS_NAME} here.`
export const INIT_TITLE = "Smithers initialized successfully"

export interface InitFacts {
  readonly bootstrap: AppBootstrap | undefined
  readonly flowCount: number
  readonly connectors: ReadonlyArray<Pick<LocalRepositoryConnector, "name" | "branch">>
  readonly repositories: ReadonlyArray<Pick<CloudRepository, "id">>
}

/** Structured fields used only by the derived opening-message projection. */
export interface InitMessage extends Message {
  readonly details: string
}

export const initMessage = (facts: InitFacts): InitMessage => {
  const { bootstrap } = facts
  const hostLine = bootstrap === undefined
    ? "Host: unknown"
    : `Host: ${bootstrap.host} (${bootstrap.version} ${bootstrap.buildSha.slice(0, 7)})${
      bootstrap.sandbox === null ? "" : `, sandbox ${bootstrap.sandbox.mode} on ${bootstrap.sandbox.platform}`
    }`
  const capabilities = bootstrap === undefined || bootstrap.capabilities.length === 0
    ? "none"
    : bootstrap.capabilities.join(", ")
  const repositories = [
    ...facts.repositories.map((repo) => repo.id),
    ...facts.connectors.map((connector) => `${connector.name}${connector.branch === null ? "" : ` @ ${connector.branch}`}`)
  ]
  const detailLines = [
    `- ${hostLine}`,
    `- Capabilities: ${capabilities}`,
    `- Flows registered: ${facts.flowCount}`,
    `- Repositories: ${repositories.length === 0 ? "none open" : repositories.join(", ")}`
  ]
  const lines = [`**${INIT_GREETING}**`, `**${INIT_TITLE}**`, "", ...detailLines]
  return {
    id: INIT_MESSAGE_ID,
    role: "smithers",
    text: lines.join("\n"),
    details: detailLines.join("\n"),
    status: "complete",
    /* Before every stored row and the derived auth message (createdAt 0). */
    createdAt: -1,
    ordinal: 0
  }
}

/** The hosted web app: a cloud host outside the desktop shell. */
export const cloudWebHost = (bootstrap: AppBootstrap | undefined): boolean =>
  bootstrap?.host === "cloud"
