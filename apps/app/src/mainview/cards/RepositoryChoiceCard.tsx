import { Button, Input } from "@smthrs/ui"
import { useState } from "react"
import { flowAction } from "../flows/FlowAction"
import type { RunCommand } from "./CardFamily"
import type { RepositoryChoicePayload } from "../state/controller/repositoryChoice"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import "./RepositoryChoiceCard.css"

/** The recently pushed repositories a person sees at once; the rest wait behind a disclosure. */
export const RECENT_REPOSITORIES = 8
/** The most rows the disclosure shows at once: a large account narrows by typing, never by scrolling hundreds of rows. */
export const SEARCH_LIMIT = 20
/** The one repository this card creates, a private auto-initialised GitHub repository (RepositoriesSeam.createRepository). */
const PLAYGROUND = "smithers-playground"

type Repository = RepositoryChoicePayload["repositories"][number]

/* The inventory read failed: one sentence; Retry reads the inventory again (repo.choose with no repository). */
const LIST_FAILED: UserFailureCopy = {
  fault: "infra",
  sentence: "Smithers could not list your GitHub repositories. Not your fault.",
  actions: ["retry"]
}
/* Signed out, nothing was read at all: the person signs in, and the list follows. */
const SIGNED_OUT: UserFailureCopy = { fault: "user", sentence: "Sign in to list your GitHub repositories.", actions: ["sign-in"] }
/* One repository's facts could not be read; the row itself still chooses it. */
const ROW_FAILED: UserFailureCopy = {
  fault: "infra",
  sentence: "Smithers could not read this repository's activity. Not your fault.",
  actions: []
}

/** Native buttons, disclosure and search keep Tab/Shift-Tab, Enter and Space; every act uses the shared flow dispatcher. */
export function RepositoryChoiceCard({ payload, onRunCommand, signedIn = true }: {
  readonly payload: RepositoryChoicePayload
  readonly onRunCommand: RunCommand
  /** False when the identity session is signed out; the list failure is then the person's to fix by signing in. */
  readonly signedIn?: boolean
}) {
  /* The search text is transient chrome no reader would miss after a reload (AGENTS: useState exempt), as WikiNavigation's. */
  const [query, setQuery] = useState("")
  const row = (repo: Repository) => <li key={repo.fullName}>
    <Button variant="ghost" className="repository-choice-row" aria-pressed={payload.selected === repo.fullName}
      {...flowAction(onRunCommand, "repo.choose", repo.fullName)}>
      <span className="repository-choice-name">{repo.fullName}</span>
      {repo.latest !== null && <time className="repository-choice-date" dateTime={repo.latest}>{repo.latest.slice(0, 10)}</time>}
    </Button>
    {repo.error ? <FailureNotice role="status" className="repository-choice-error" data-testid="repository-choice-row-failure"
      failure={describedFailure("RepositoryChoiceRowFailed", ROW_FAILED, repo.error)} /> : null}
  </li>
  const needle = query.trim().toLowerCase()
  /* Empty search: the next of the ranking. A search: every repository, recent ones included. */
  const matches = needle === "" ? payload.repositories.slice(RECENT_REPOSITORIES)
    : payload.repositories.filter(repo => repo.fullName.toLowerCase().includes(needle))
  const shown = matches.slice(0, SEARCH_LIMIT)
  return <div className="repository-choice" data-testid="repository-choice">
    {payload.created ? <p>Created {payload.created.fullName}</p> : <>
      {payload.error ? <FailureNotice className="repository-choice-error" data-testid="repository-choice-failure"
        failure={signedIn ? describedFailure("RepositoryChoiceFailed", LIST_FAILED, payload.error)
          : describedFailure("RepositoryChoiceSignedOut", SIGNED_OUT, "")}
        actions={{ retry: flowAction(onRunCommand, "repo.choose"), "sign-in": flowAction(onRunCommand, "sign-in") }} /> : null}
      <ol className="repository-choice-list">{payload.repositories.slice(0, RECENT_REPOSITORIES).map(row)}</ol>
      {/* The rest stay behind a native disclosure: the ranking already put the recently pushed ones first. */}
      {payload.repositories.length > RECENT_REPOSITORIES && <details className="repository-choice-all">
        <summary>All repositories ({payload.repositories.length})</summary>
        <Input type="search" aria-label="Search repositories" placeholder="Search" value={query}
          onChange={event => setQuery(event.currentTarget.value)} />
        {shown.length === 0 ? <p className="repository-choice-count">No matches</p>
          : <ol className="repository-choice-list">{shown.map(row)}</ol>}
        {matches.length > shown.length && <p className="repository-choice-count">{shown.length} of {matches.length}</p>}
      </details>}
      <Button variant="outline" className="repository-choice-create" {...flowAction(onRunCommand, "repo.create", PLAYGROUND)}>Create {PLAYGROUND}</Button>
    </>}
  </div>
}
