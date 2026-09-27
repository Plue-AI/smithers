import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { nativeShell } from "@smthrs/rpc/AppBootstrap"
import type { LocalRepositoryConnector, Message, Repo } from "./state/AppState"

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
  readonly repos: ReadonlyArray<Pick<Repo, "name">>
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
    ...facts.repos.map((repo) => repo.name),
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

/*
 * The identity answer (/smithers.who). Every sentence is a constant or a
 * fact the opening message already reads; nothing here is composed by a model.
 */

/** The helpers Smithers hands work to, each named only while its flow is registered on this host. */
export const SMITHERS_HELPERS: ReadonlyArray<{ readonly flow: string; readonly line: string }> = [
  { flow: "librarian.ask", line: "the Librarian (/librarian.ask) answers wiki and repository questions" },
  { flow: "flow.ask", line: "the Flows agent (/flow.ask) picks which flow to run" }
]

export interface IdentityFacts extends Pick<InitFacts, "bootstrap" | "connectors" | "repos"> {
  /**
   * The `owner/name` the selection names (RepoContext.ts activeRepositoryId),
   * the same row the agent runtime context reads: a signed-out visitor at
   * /owner/name has a repository selected before any checkout is open.
   */
  readonly activeRepository: string | null
  /** Whether a flow is registered on this host right now; unregistered helpers are never named. */
  readonly registered: (flow: string) => boolean
}

/** Which app this is: the desktop shell's row decides, never the host name (a self-hosted origin is the web app). */
const hostLabel = (bootstrap: AppBootstrap | undefined): string =>
  bootstrap === undefined ? "an unknown host" : nativeShell(bootstrap) ? "the native Smithers app" : "the Smithers web app"

/**
 * The text /smithers.who renders: the name, the host, the repositories in
 * reach, and the helpers that exist here. Honest about absence: no harness,
 * no repository and no helper each read as such rather than as an invention.
 */
export const identityMessage = (facts: IdentityFacts): string => {
  /*
   * The selected repository leads: the visitor at /smithersai/smithers heard
   * "no repository is open yet" while the composer already named that head.
   * Open checkouts and connectors follow; a name appears once.
   */
  const inReach = [
    ...facts.repos.map((repo) => repo.name),
    ...facts.connectors.map((connector) => connector.name)
  ]
  const repositories = facts.activeRepository === null
    ? inReach
    : [facts.activeRepository, ...inReach.filter((name) => name !== facts.activeRepository)]
  const where = repositories.length === 0
    ? `I am ${SMITHERS_NAME}, the concierge of ${hostLabel(facts.bootstrap)}; no repository is open yet.`
    : `I am ${SMITHERS_NAME}, the concierge for ${repositories.join(", ")} in ${hostLabel(facts.bootstrap)}.`
  const helpers = SMITHERS_HELPERS.filter((helper) => facts.registered(helper.flow)).map((helper) => helper.line)
  const handoff = helpers.length === 0
    ? "I answer this chat myself; type / to see every flow I can run."
    : `I hand work to helpers: ${helpers.join("; ")}.`
  return [where, handoff].join(" ")
}
