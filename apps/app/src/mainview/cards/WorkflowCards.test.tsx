import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { WorkflowListCardBody, WorkflowRunCardBody } from "./WorkflowCards"
import type { Card } from "../state/AppState"
import type { WorkflowLaunch } from "../state/WorkflowLaunch"

test("a pending launch states only Requested and a refusal offers the existing Retry flow", () => {
  const request: WorkflowLaunch = { version: 1, id: "request", owner: "owner", repo: "owner/repo", workflow: "review", input: { args: "inspect" } }
  const card: Extract<Card, { kind: "run-trace" }> = { id: "flow-request-request", kind: "run-trace", title: "review", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: request.repo, workflow: request.workflow, runId: "pending-request", phase: "launching", steps: [], result: null, lastSeq: 0, input: { _workflowLaunch: request } } }
  const render = () => renderToStaticMarkup(<WorkflowRunCardBody card={card} onStopRun={() => {}} onRetryRun={() => {}} onRunCommand={() => {}} />)
  expect(render()).toContain('role="status">Requested</p>')
  expect(render()).not.toContain("<button")
  request.error = { stage: "launch", code: "provider_unavailable", message: "Provider unavailable" }
  const refused = render()
  expect(refused).toContain('<p>Smithers could not start this run. Not your fault.</p>')
  expect(refused).not.toContain("<p>Provider unavailable")
  expect(refused).toContain('<details><summary>Details</summary><pre tabindex="0" role="region" aria-label="Failure details">provider_unavailable — Provider unavailable</pre></details>')
  expect(refused).toContain('data-fault="infra" data-failure="run.launch.launch"')
  expect(render()).toContain('data-flow="flow.run.retry"')
  expect(render()).toContain(">Retry</button>")
})

test("the run card's transcript facet lists its rows", () => {
  const card: Extract<Card, { kind: "run-trace" }> = {
    id: "run-one", kind: "run-trace", title: "Build", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "owner/repo", workflow: "build", runId: "one", phase: "completed", steps: [], result: null,
      lastSeq: 1, facet: "transcript", transcriptRows: [{ sequence: 1, at: 2, kind: "answer", text: "row in the card" }] }
  }
  expect(renderToStaticMarkup(<WorkflowRunCardBody card={card}
    onStopRun={() => {}} onRetryRun={() => {}} onRunCommand={() => {}} />)).toContain("row in the card")
})

test("flow rows lead with their human description and retain an identifier fallback", () => {
  const card: Extract<Card, { kind: "workflow-list" }> = {
    id: "flows", kind: "workflow-list", title: "Flows", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "practice:smithersai/hello-server", workflows: [
      { key: "issue/repro", description: "Research and reproduce before implementation" },
      { key: "lint", description: null },
    ] },
  }
  const html = renderToStaticMarkup(<WorkflowListCardBody card={card} onRunCommand={() => {}} />)
  expect(html).toContain("<strong>Research and reproduce before implementation</strong>")
  expect(html).toContain("<span>issue.repro</span>")
  expect(html).toContain("<strong>lint</strong>")
})

test("a pending catalog offers no launch and a failed catalog offers a source-bound Retry", () => {
  const card: Extract<Card, { kind: "workflow-list" }> = {
    id: "workflow-list-owner/repo", kind: "workflow-list", title: "Flows", status: "active", loading: true, createdAt: 1, ordinal: 1,
    payload: { repo: "owner/repo", gatewayBindingVersion: 1, workflows: [{ key: "check", description: null }],
      catalogRequest: { id: "catalog-request", owner: "owner", state: "pending" } }
  }
  const render = () => renderToStaticMarkup(<WorkflowListCardBody card={card} onRunCommand={() => {}} />)
  expect(render()).not.toContain('data-flow="flow.run"')
  card.loading = false
  card.status = "error"
  card.body = "Upstream unavailable"
  card.payload.catalogRequest!.state = "failed"
  const failed = render()
  expect(failed).toContain('role="alert"')
  expect(failed).toContain("Upstream unavailable")
  expect(failed).toContain('data-flow="flow.list"')
  expect(failed).toContain(">Retry</button>")
  expect(failed).not.toContain('data-flow="flow.run"')
})

test("a pending facet does not claim an empty result; refusal keeps the existing retry door", () => {
  const card: Extract<Card, { kind: "run-trace" }> = { id: "facet-card", kind: "run-trace", title: "Run", status: "acted", createdAt: 1, ordinal: 1,
    payload: { repo: "owner/repo", workflow: "review", runId: "run-1", phase: "completed", steps: [], result: null, lastSeq: 0,
      facet: "transcript", facetRequest: { id: "request", owner: "owner", repo: "owner/repo", runId: "run-1", facet: "transcript", state: "pending" } } }
  const render = () => renderToStaticMarkup(<WorkflowRunCardBody card={card} onStopRun={() => {}} onRetryRun={() => {}} onRunCommand={() => {}} />)
  expect(render()).not.toContain("The transcript is empty so far.")
  card.payload.facetRequest = { ...card.payload.facetRequest!, state: "failed", error: "Transcript unavailable" }
  const failed = render()
  expect(failed).toContain('role="alert"')
  expect(failed).toContain("Transcript unavailable")
  expect(failed).not.toContain("The transcript is empty so far.")
  expect(failed).toContain('data-flow="runs.logs"')
  expect(failed).toContain('data-flow-args="run-1"')
})
