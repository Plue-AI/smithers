import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import type { WorkflowLaunch } from "../state/WorkflowLaunch"
import { FACET_FAILURES, LAUNCH_FAILURES, LAUNCH_FLOW_MISSING, OBSERVATION_FAILURES, WorkflowRunCardBody } from "./RunTraceCard"

/*
 * The run card never shows a gateway's, reader's or observer's raw words as
 * its sentence: the payload's stage, facet or phase picks the copy, and the
 * raw text sits only inside the collapsed Details.
 */

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type RunCard = Extract<Card, { kind: "run-trace" }>

const mount = (card: RunCard, onRetryRun: (id: string) => void = () => {}): HTMLElement => {
  const host = document.createElement("div")
  host.innerHTML = renderToStaticMarkup(<WorkflowRunCardBody card={card} onStopRun={() => {}} onRetryRun={onRetryRun} onRunCommand={() => {}} />)
  return host
}

const noticeOf = (host: HTMLElement, testId: string) => {
  const notice = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  expect(notice).not.toBeNull()
  const details = notice!.querySelector("details")
  return {
    notice: notice!,
    sentence: notice!.querySelector(":scope > p")?.textContent,
    open: details?.hasAttribute("open"),
    detail: details?.querySelector("pre")?.textContent
  }
}

const runCard = (payload: Partial<RunCard["payload"]> = {}): RunCard => ({
  id: "run-one", kind: "run-trace", title: "Build", status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "owner/repo", workflow: "build", runId: "one", phase: "running", steps: [], result: null, lastSeq: 0, ...payload }
})

const launchCard = (error: WorkflowLaunch["error"]): RunCard => {
  const request: WorkflowLaunch = { version: 1, id: "request", owner: "owner", repo: "owner/repo", workflow: "review", input: {}, ...(error ? { error } : {}) }
  return { ...runCard({ runId: "pending-request", phase: "launching", input: { _workflowLaunch: request } }), id: "flow-request-request" }
}

describe("a launch refusal", () => {
  for (const stage of ["preparation", "launch", "persistence"] as const) {
    test(`at ${stage} says the stage's sentence and keeps the gateway's words behind Details`, () => {
      const raw = "HTTP 502 upstream_reset: connection reset by peer"
      const shown = noticeOf(mount(launchCard({ stage, code: "launch_unavailable", message: raw })), "flow-run-launch-failure")
      expect(shown.sentence).toBe(LAUNCH_FAILURES[stage].sentence)
      expect(shown.sentence).not.toContain("502")
      expect(shown.open).toBe(false)
      expect(shown.detail).toBe(`launch_unavailable — ${raw}`)
      expect(shown.notice.dataset.failure).toBe(`run.launch.${stage}`)
      expect(shown.notice.dataset.fault).toBe(LAUNCH_FAILURES[stage].fault)
      expect(shown.notice.dataset.stage).toBe(stage)
    })
  }

  test("each stage has its own sentence and blames Smithers", () => {
    const sentences = Object.values(LAUNCH_FAILURES).map(copy => copy.sentence)
    expect(new Set(sentences).size).toBe(3)
    for (const copy of Object.values(LAUNCH_FAILURES)) {
      expect(copy.fault).not.toBe("user")
      expect(copy.sentence).toContain("Not your fault.")
    }
  })

  test("a missing flow is the person's to fix, so it does not claim otherwise", () => {
    const shown = noticeOf(mount(launchCard({ stage: "launch", code: "flow_not_found", message: "There's no flow called review on owner/repo." })), "flow-run-launch-failure")
    expect(shown.sentence).toBe(LAUNCH_FLOW_MISSING.sentence)
    expect(shown.sentence).not.toContain("Not your fault")
    expect(shown.notice.dataset.fault).toBe("user")
    expect(shown.notice.dataset.failure).toBe("run.launch.flow-missing")
    expect(shown.detail).toContain("There's no flow called review")
    // Retrying a flow that does not exist fails the same way, so no Retry is offered.
    expect(shown.notice.querySelector("button")).toBeNull()
  })

  test("the notice's Retry is the existing flow.run.retry act", () => {
    const retried: string[] = []
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    flushSync(() => root.render(<WorkflowRunCardBody card={launchCard({ stage: "preparation", code: "box_gone", message: "gone" })}
      onStopRun={() => {}} onRetryRun={id => { retried.push(id) }} onRunCommand={() => {}} />))
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="flow-run-launch-failure"] button[data-flow="flow.run.retry"]')!
    expect(retry.textContent).toBe("Retry")
    retry.click()
    expect(retried).toEqual(["flow-request-request"])
    flushSync(() => root.unmount())
    host.remove()
  })
})

describe("a failed facet read", () => {
  for (const facet of ["transcript", "events"] as const) {
    test(`of ${facet} names the view and keeps the reader's error behind Details`, () => {
      const raw = "TypeError: Failed to fetch"
      const shown = noticeOf(mount(runCard({ facet, facetRequest: { id: "f", owner: "owner", repo: "owner/repo", runId: "one", facet, state: "failed", error: raw } })), "flow-run-facet-failure-one")
      expect(shown.sentence).toBe(FACET_FAILURES[facet].sentence)
      expect(shown.sentence).not.toContain("Failed to fetch")
      expect(shown.detail).toBe(raw)
      expect(shown.open).toBe(false)
      expect(shown.notice.dataset.failure).toBe(`run.facet.${facet}`)
      expect(shown.notice.dataset.fault).toBe("infra")
    })
  }
})

describe("an observation error", () => {
  const cases = [
    ["running", "Smithers lost track of this run. Not your fault."],
    ["stopped", "Smithers stopped watching this run. Not your fault."],
    ["completed", "This run finished, but Smithers could not read all of its record. Not your fault."]
  ] as const
  for (const [phase, sentence] of cases) {
    test(`in phase ${phase} reads as the phase's sentence`, () => {
      const raw = "gateway 500: projection cursor mismatch"
      const shown = noticeOf(mount(runCard({ phase, observationError: raw })), "flow-run-observation-failure-one")
      expect(shown.sentence).toBe(sentence)
      expect(OBSERVATION_FAILURES[phase].sentence).toBe(sentence)
      expect(shown.sentence).not.toContain("500")
      expect(shown.detail).toBe(raw)
      expect(shown.notice.dataset.failure).toBe(`run.observe.${phase}`)
      expect(shown.notice.dataset.fault).toBe("infra")
    })
  }

  test("every phase is answered and none blames the person", () => {
    for (const copy of Object.values(OBSERVATION_FAILURES)) {
      expect(copy.fault).toBe("infra")
      expect(copy.sentence).toContain("Not your fault.")
    }
  })
})

test("a settled run's failure renders the presenter's sentence with the raw verdict behind Details", () => {
  const raw = "failed — Error: Error: git exited 1"
  const shown = noticeOf(mount(runCard({ phase: "failed", error: raw })), "flow-run-failure-one")
  expect(shown.sentence).toContain("Not your fault")
  expect(shown.sentence).not.toContain("git exited")
  expect(shown.detail).toBe(raw)
  expect(shown.open).toBe(false)
  expect(shown.notice.dataset.fault).toBe("infra")
  expect(shown.notice.dataset.failure).toBeUndefined()
})
